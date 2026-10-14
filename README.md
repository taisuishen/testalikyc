# docscan-h5 — 证件检测 · 自动截取

浏览器端（H5）的证件取景与自动截取：**摄像头取流 → 每帧检测证件四边形 → 多道门控 → 稳定计时 → 自动截取 → 透视校正**。

纯前端实现，无模型、无 WASM、无第三方依赖（`Opencv.js`/`TF.js`/`ONNX Runtime` 都不需要）。

---

## 快速开始

### 本地局域网调试（需要 HTTPS）

```bash
node server.mjs                 # 默认 0.0.0.0:8443
node server.mjs --port 9000     # 换端口
```

首次运行会用 `openssl` 生成自签证书，**自动把本机所有 IPv4 写进 SAN**，然后打印可访问地址：

```
  local   https://localhost:8443
  LAN     https://172.18.80.72:8443
```

`PORT+1`（默认 8444）会起一个 HTTP 监听，只做 302 跳转到 HTTPS，方便直接输入 `ip:port`。

> **为什么必须 HTTPS**：浏览器只在**安全上下文**（`https://` 或 `localhost`）暴露 `getUserMedia`。用 `http://192.168.x.x:8443` 访问时，摄像头会被**直接拒绝**，不是权限问题，是策略问题。
>
> 自签证书浏览器会警告，手机端选择「继续访问」即可。

### 部署到 Vercel

```bash
vercel --prod
```

Vercel 自带 HTTPS，**安全上下文问题自动解决**，不需要自签证书。目录结构已经是 Vercel 约定：

- 根目录的 `index.html` / `*.js` / `*.css` → 静态资源
- `api/capture.js` → Serverless Function（`POST /api/capture`）
- `vercel.json` → 声明 `Permissions-Policy: camera=(self)` 与缓存头

服务端函数**故意不落盘**（serverless 文件系统是临时的，而且证件影像不该散落在部署里），只返回 `sha256` 和字节数的回执。要接 OCR 就在那里转发。

### 跑测试

```bash
npm test
```

**26 个用例**，用合成图像验证检测器：透视四边形、带内容干扰的证件、出框证件、过小证件、空场景、一帧里两个四边形、方形的长宽比拒绝、取景框相对面积、取景框外的大块干扰、证件在框外时的报错区分。

```
case 1: flat card, perspective quad
  PASS  quad within 10px  err=4.1px
case 9: large background blob outside the guide is not chosen
  PASS  chose the in-guide card  err(card)=4.5 err(clutter)=162.8
...
26 passed, 0 failed
```

检测单帧耗时约 **2.0 ms**（320×240，Node/V8；浏览器同引擎，实测 2.7 ms）。

### 端到端验证（真实 Chrome + 合成视频）

单元测试只覆盖几何流水线。整条链路可以用 Chrome 的假摄像头跑通——注入一段 Y4M 视频，实际走完「取流 → 检测 → 门控 → 稳定计时 → 截取 → 透视校正 → 上传」：

```bash
# 1. 生成一段证件视频（Y4M 4:2:0，注意是 limited range）
# 2. 启动 Chrome 注入视频
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9335 \
  --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream \
  --use-file-for-fake-video-capture=/tmp/fake-card.y4m \
  --window-size=500,773
# 3. 通过 CDP 打开页面、点击开始，然后读 window.__docscan 观察状态
```

实测结果：

```
56fps · det 2.7ms · fill 0.68 · ar 1.57 · ang 1° · sharp 1241 · lum 178
已截取 819×523 · 22KB
上传: areaRatio 0.679 / maxAngleDev 1.32° / sharpness 1241 / glare 0
```

页面暴露 `window.__docscan`（`{ state, CONFIG, GUIDE, layout }`）用于调试：可以直接读出解算后的取景框、平滑后的四边形和各道门的判定，不必靠肉眼猜。

> **踩过的坑**：Y4M 是 **limited range**（16–235）。Y=232 渲染出来接近 252，会被反光门正确地判为过曝——那不是 bug，是夹具太亮。写合成视频时用 Y≈200 才接近真实证件。

---

## 目录结构

```
├── index.html          取景界面
├── style.css           取景框 / HUD 样式
├── app.js              摄像头、主循环、门控、自动截取状态机、取景框绘制
├── detect.js           经典 CV 检测流水线 + 质量评估（纯函数，可在 Node 里跑）
├── geometry.js         四边形几何、单应矩阵、透视变换
├── api/capture.js      Vercel Serverless Function
├── server.mjs          本地 LAN 调试服务器（HTTPS + 自签证书）
└── test/
    └── detect.test.mjs 合成图像测试
```

`detect.js` / `geometry.js` **不碰 DOM**，所以同一份代码既跑在浏览器里，也跑在 Node 测试里。

---

## 检测流程

### 1. 三级分辨率

| 阶段 | 分辨率 | 频率 | 用途 |
|---|---|---|---|
| 检测 | 320px 宽 | ~12 Hz | 几何门控 |
| 质量 | 证件裁切后归一化到 **600px 宽** | ~6 Hz，且仅在几何通过时 | 清晰度 / 亮度 / 反光 |
| 截取 | 摄像头原生 | 一次 | 透视校正输出 |

质量阶段**只在几何门控通过后才测量**——既省算力，又天然形成节流。裁切后归一化到固定宽度，是为了让**模糊阈值不随设备分辨率漂移**。

### 2. 检测流水线（`detect.js`）

```
灰度 → 5x5 高斯 → Sobel 梯度 → Otsu 阈值化（带下限夹紧）
     → 3x3 膨胀 x2 → 连通域筛选（质心须在取景框内）
     → 凸包 → 轻度 RDP 去噪 → 最大面积四边形
```

几个关键点：

- **Otsu 阈值夹紧**：梯度图上的 Otsu 容易取到过低的值，把纹理噪声也吃进来，所以钳到 `>= 38`。
- **膨胀两次**：把证件的断边连成一个闭合环，才能成为「最大连通域」。
- **连通域按外接矩形面积选**，不是按像素数。证件轮廓是一个**细环**，像素数远低于它围出的面积；按像素数选会让背景里密集的纹理赢过证件边框。
- **质心必须在取景框内**（硬过滤，不是加分项）。背景里的桌沿、显示器边框常常比证件还大，不设这道过滤就会被它们赢走。
- **阈值下限很松**（0.5%）：小证件也要能产出四边形，好让面积门去回答「靠近一点」，而不是含糊地报「没检测到」。
- **选角用最大面积，RDP 只负责去噪**——原因见下面第 5 节，那是本项目最隐蔽的一个坑。

### 3. 取景框：居中的横向长方形

取景框**不是满屏内缩**，而是一个**居中的横向长方形**，长宽比取证件标准 **ID-1 = 1.585**（85.60 × 53.98 mm，菲律宾 PhilSys 等多数身份证）。护照是 TD3（125 × 88 mm，比例 1.42），换证件类型时改 `guideAspect`。

这个取景框不只是画给人看的，它是**几何判定的基准**：

- 面积比值是 **卡片面积 ÷ 取景框面积**，不是 ÷ 整幅画面。这正是 SDK 里 `checkCardAreaRatio(cardQuad, frameQuad, min)` 那个 17 参数签名的语义（8 卡片 + 8 取景框 + 1 阈值）。
- 只有**质心落在取景框内**的连通域才有资格参与选优。背景里的桌沿、显示器边框往往比证件还大，不设这个硬过滤就会被它们赢走。
- 取景框在**屏幕坐标**里定义（保证视觉正确），再反算回图像坐标参与判定——因为视频用 `object-fit: cover`，屏幕和图像之间有一次裁剪缩放。

### 4. 门控条件

| 门 | 参数 | 含义 |
|---|---|---|
| 面积下限 | `minAreaRatio` | 卡片面积 / **取景框**面积，低于此值提示「靠近」 |
| 面积上限 | `maxAreaRatio` | 超出说明证件溢出了框，提示「离远点」 |
| **长宽比** | `guideAspect` / `aspectTolerance` | **最关键的一道门**，见下 |
| 角度 | `maxAngleDeg` | 四个内角偏离 90° 的最大值（倾斜 / 透视） |
| 四角可见 | — | 连通域**是否触碰图像边界**。贴边即出框 |
| 质量 | `blurMin` / `brightnessMin` / `brightnessMax` / `glareMax` | 拉普拉斯方差 / 平均亮度 / 近白像素占比 |

**长宽比是拒绝「非证件」的那道门。** 没有它，任何面积够大、四角接近直角的凸四边形都能通过——桌沿、显示器黑边、门框全都算。证件有固定规格，把它约束住就能滤掉绝大多数误检：

```js
aspectOk = |aspect - guideAspect| / guideAspect <= aspectTolerance
```

「四角可见」用**连通域是否触及图像边界**来判定，这比逐角点判内外更鲁棒：证件出框时，边缘图必然被图像边界切断。

### 5. 四边形拟合：为什么必须用「最大面积」而不是「RDP 恰好剩 4 个点」

这是整个项目里最隐蔽的一个坑，值一个独立小节。

**症状**：检出四边形塌边，比如

```
[[101,133],[228,77],[222,152],[101,142]]
                  ↑ 两个角点相距仅 9px，左边塌成一条线
```

这种四边形**是凸的、面积也不小**，能骗过大多数合理性检查，但它报告的面积是 5139（真值 8320）、长宽比 1.84（真值 1.585）。结果是门控时通时不通、进度条反复归零、**永远锁不住**——也就是「检测效果很差」。

**根因**（我一开始判断错了，实际比想的更深）：

`convexHull` 用的是 Andrew monotone chain，它从**字典序最小的点**开始。而在真实帧里，那个点常常**位于某条边的中间，不是角点**：

```
hull: [[90,123],[91,74],[92,67],[93,66],[138,66],...,[93,148],[90,145]]
       ↑ 起点 (90,123) 是左边中段的一个点，真正的左下角是 (90,145)
```

如果你把闭合的凸包当成**开放折线**丢给 RDP，首尾两个点会被强制保留——而它们是相邻的。于是这个「边中段」的起点被当成了顶点，RDP 的顶点分布被带偏。实测：

```
eps=1.5% -> 5 pts  [[90,123],[93,66],[227,71],[223,150],[93,148]]
eps=6.5% -> 4 pts  [[90,123],[93,66],[227,71],[223,150]]   ← 左下角没了
```

要让那个伪顶点消失，epsilon 得大到 **28px（检测尺度）≈ 92px（1024 原图）**——大到足以把真正的角点一起吞掉。

**修法**：不要依赖「RDP 恰好剩 4 个点」。

1. **闭合多边形的 RDP 要正确切分**（`rdpClosed`）：以距起点最远的顶点为界拆成两半，各自简化再拼接。这是必要的修正，但**不够**——因为切分点本身可能就是那个伪顶点。
2. **用「最大内接面积」作为选角目标**（`maxAreaQuad`）。这才是关键：**边中段的点永远不可能增大四边形面积**，所以真实角点天然获胜，不需要 RDP 数对顶点。
3. RDP 只用来**去亚像素噪声**（epsilon 取周长的 0.4%–6%，逐步放宽到候选池 ≤20 点），不承担选角职责。
4. 外加 `wellFormed()` 兜底：任一边短于最长边的 28%（ID-1 短边约为长边的 63%，透视下也不该低于 28%），或对边比值超过 2.5，判为退化形丢弃。

修复前后（同一真实帧）：

| | 长宽比 | 角度偏差 | 检出四边形 |
|---|---|---|---|
| 修复前 | 1.72 → 1.80 | 8.6° → 15.6° | 左下角被切掉 |
| 修复后 | **1.57** | **1.3°** | 四角完整 |

ID-1 的理论长宽比是 1.585，修复后基本重合。

### 6. 质量测量不能放大

`measureQuality` 把证件裁切归一化到固定宽度（`NORM_W = 600`），让模糊阈值不随设备分辨率漂移。但**只能降采样，不能升采样**：把一个 120px 宽的裁切拉大到 600px，插值会把细节抹平，一张清晰的证件会被测成模糊，模糊门就永久关死。

所以取 `min(NORM_W, cropWidth)`。另外单独设 `qualityMinCropWidth`（默认 320）：低于这个宽度的裁切，无论看起来多清晰，对后续 OCR 都没有价值，直接判 `low-resolution`。

### 7. 自动截取状态机（`app.js`）

```js
if (全部门控通过) {
  if (stableSince == null) stableSince = now;
  progress = (now - stableSince) / stackTime;   // 0 → 1，喂进度条
  if (progress >= 1) capture();
} else {
  stableSince = null;    // 任何一帧失败都归零 —— 「稳定」的真正来源
  progress = 0;
}
```

配套两个抗抖手段：

- **四角点 EMA 平滑**（`alpha = 0.45`）：只用于显示与截取，门控仍用原始检测值，避免平滑掩盖真实的抖动。
- **迟滞**：计时过程中面积阈值放宽到 `minAreaRatio × hysteresis.exit`（默认 0.8），防止手轻微移动就让进度条归零。

### 8. 透视校正

截取时用 `solveHomography` 解出 `dst → src` 的单应矩阵，按测得的长宽比生成正视矩形，`warpPerspective` 双线性采样输出。矩阵退化时**回退到未校正的原图**，而不是产出空白图。

---

## 调参

所有参数集中在 `app.js` 顶部的 `CONFIG`：

```js
const CONFIG = {
  // 面积与取景框比，不是与整幅画面比
  minAreaRatio: 0.55,        // 卡片 / 取景框面积下限
  maxAreaRatio: 1.35,        // 超出说明证件溢出取景框

  guideAspect: 1.585,        // ID-1 横向；护照改 1.42
  aspectTolerance: 0.30,     // 长宽比允许的相对偏差

  maxAngleDeg: 10,           // 内角偏离 90° 不超过 10°
  stackTime: 900,            // 连续合格 900ms 后自动截取
  hysteresis: { enter: 1.0, exit: 0.8 },

  blurMin: 22,               // 针对 600px 归一化裁切标定
  brightnessMin: 50,
  brightnessMax: 220,
  glareMax: 0.05,
};
```

取景框本身的形状在 `GUIDE` 里：

```js
const GUIDE = {
  widthFrac: 0.88,     // 占可用屏宽的比例
  centerYFrac: 0.45,   // 略高于正中，给底部 HUD 留位置
  marginPx: 14,
};
```

界面左上角的调试行实时显示 `fps · 检测耗时 · 填充率 · 长宽比 · 角度 · 清晰度 · 亮度`：

- **`fill`** 是卡片占取景框的比例。正常持机应该在 0.7–1.0；低于 `minAreaRatio` 就会提示靠近。
- **`ar`** 是检出四边形的长宽比。它应该稳定在 `guideAspect` 附近（ID-1 约 1.59）。**如果它跳来跳去，说明检测不稳**，先解决那个再调别的门。
- **`sharp`** 用来标定 `blurMin`：让用户在正常持机距离下稳定高于阈值，然后把阈值定在略低的位置。

`blurMin` 等质量阈值与归一化宽度（`NORM_W = 600`）绑定。改 `NORM_W` 就必须重新标定。

### 调参顺序

1. **先保证 `ar` 稳**。它在跳，说明四边形拟合或背景干扰有问题，调其他门没意义。
2. **再定 `minAreaRatio`**。把 `fill` 打到 0.7 左右时的值作为基准，阈值定在它的 ~0.75 倍，留出手抖余量。
3. **然后定 `aspectTolerance`**。如果你的证件不是 ID-1，先改 `guideAspect`；`aspectTolerance` 只用来容纳透视带来的形变，不要用它来放宽到「什么都算」。
4. **最后定质量门**（`blurMin` 等）。

### 常见现象对照

| 现象 | 大概率原因 |
|---|---|
| 框里明明有证件，就是不认 | `guideAspect` 和你的证件不符（比如在扫护照） |
| `ar` 在 1.0–2.5 之间乱跳 | 检测到的是背景杂物，或四边形退化。看 `fill` 是否也很小 |
| 一直提示「靠近」 | 取景框太大或持机太远；也可能 `minAreaRatio` 定高了 |
| 进度条反复归零 | 某一帧掉出阈值。先看是 `ar` 还是 `sharp` 在抖 |
| 锁得住但不截取 | `stackTime` 太长，或质量门一直不过（看 `sharp`/`lum`） |

---

## 换成你自己的模型

检测器是可插拔的。`detectDocument()` 只要求返回 `{ quad, areaRatio, aspect, maxAngleDev, touchesBorder }`，其余门控与状态机完全复用。

用 ONNX Runtime Web 替换 `app.js` 里那一次 `detectDocument(frame, CONFIG, guideDet)` 调用即可：

```js
// 你的模型输出 [1, 4, 2] 归一化角点，或热图 → 你自己解成 quad
const quad = await myOnnxDetector.run(frame, DET_W, dh);
const det  = {
  quad,
  areaRatio: polygonArea(quad) / (guideDet.width * guideDet.height), // 对取景框
  aspect: quadAspect(quad),          // 门控需要，别漏
  maxAngleDev: maxAngleDeviation(quad),
  touchesBorder: false,
};
```

注意三点：

- `areaRatio` 要对**取景框**算，不是对整幅图。`guideDet` 由 `layout()` 给出并已换算到检测分辨率。
- **`aspect` 必须提供**，否则长宽比门会被跳过（`evaluateFrame` 里 `aspect === undefined` 时视为通过），退化成「什么都认」。
- 模型路线同样受 `wellFormed` 的启发：如果模型输出可能给出塌边的四边形，加一道边长合理性检查。

**注意**：`CardDetection.mnn` 不在此项目中，也不应被引入——它是阿里云身份认证 SDK 的模型权重，属于第三方受版权保护的资产。模型格式（ARM 版 MNN）也无法在浏览器中运行。若你需要模型路线，请使用你自己训练的权重。

---

## 浏览器兼容

| 能力 | 要求 |
|---|---|
| `getUserMedia` | 安全上下文（HTTPS / localhost）+ 用户授权 |
| `ImageData` / `canvas` | 全绿 |
| `roundRect` | Chrome 99+ / Safari 16.4+ / Firefox 112+ |
| ES Modules | 全绿（现代浏览器） |
| iOS Safari | 需要用户手势触发；`playsinline` 已设置 |

`CanvasRenderingContext2D.roundRect` 用于画圆角取景框。若需支持更老的浏览器，把它换成 `rect()` 或自行描圆角路径。

iOS 上摄像头的 `facingMode: environment` 与分辨率约束是**建议值**，实际以系统返回为准。检测用的缩放比例取自 `video.videoWidth/Height`，因此不依赖约束是否被满足。

---

## 已知限制

- **未标定真实证件数据**。合成图像测试只验证几何流水线的正确性，真实场景的 `blurMin` / `glareMax` / `aspectTolerance` 需要用实际帧标定。
- **单一证件规格**。`guideAspect` 是全局常量，一次只能对准一种证件比例。若要同时支持身份证与护照，需要在进入扫描前选择证件类型并切换 `guideAspect`。
- **未做屏幕翻拍检测**（摩尔纹 / 反光频域特征）。如果这是防翻拍需求，需要另加一层——本项目的定位是取景辅助，不是反欺诈。
- **单证件假设**。取景框内同时出现多个证件时取最大者，不做多实例。
- **`getUserMedia` 需要用户手势**。部分浏览器（尤其 iOS）必须在点击事件内调用，所以首屏有一个「开始采集」按钮。
- **检测性能未在低端机标定**。Node/V8 上 320×240 单帧约 1.9ms，但低端 Android WebView 会更慢，必要时把 `DET_W` 降到 256 或把 `DET_INTERVAL_MS` 放宽。
