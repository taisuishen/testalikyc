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

15 个用例，用**合成图像**验证检测器：透视四边形、带内容干扰的证件、出框证件、过小证件、空场景、一张画面里两个四边形。

```
case 1: flat card, perspective quad
  PASS  quad within 10px  err=4.1px
...
15 passed, 0 failed
```

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
     → 3x3 膨胀 x2 → 最大连通域 → 凸包 → RDP 简化到 4 点 → 校验
```

几个关键点：

- **Otsu 阈值夹紧**：梯度图上的 Otsu 容易取到过低的值，把纹理噪声也吃进来，所以钳到 `>= 38`。
- **膨胀两次**：把证件的断边连成一个闭合环，才能成为「最大连通域」。
- **阈值下限很松**（0.5%）：小证件也要能产出四边形，好让面积门去回答「靠近一点」，而不是含糊地报「没检测到」。
- **RDP 扫描 epsilon**：从周长的 0.5% 扫到 15%，命中 4 点即返回；若跳过了 4 点，则从小到大暴力挑**面积最大的凸四边形**兜底。

### 3. 门控条件

| 门 | 参数 | 含义 |
|---|---|---|
| 面积 | `minAreaRatio` | 证件占画面比例，`calculateQuadArea` 的等价物 |
| 角度 | `maxAngleDeg` | 四个内角偏离 90° 的最大值（倾斜 / 透视） |
| 四角可见 | — | 连通域**是否触碰画面边界**。贴边即出框 |
| 质量 | `blurMin` / `brightnessMin` / `brightnessMax` / `glareMax` | 拉普拉斯方差 / 平均亮度 / 近白像素占比 |

「四角可见」用**连通域是否触及图像边界**来判定，这比逐角点判内外更鲁棒：证件出框时，边缘图必然被图像边界切断。

### 4. 自动截取状态机（`app.js`）

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

### 5. 透视校正

截取时用 `solveHomography` 解出 `dst → src` 的单应矩阵，按测得的长宽比生成正视矩形，`warpPerspective` 双线性采样输出。矩阵退化时**回退到未校正的原图**，而不是产出空白图。

---

## 调参

所有参数集中在 `app.js` 顶部的 `CONFIG`：

```js
const CONFIG = {
  minAreaRatio: 0.28,   // 证件至少占画面 28%
  maxAngleDeg: 10,      // 内角偏离 90° 不超过 10°
  stackTime: 900,       // 连续合格 900ms 后自动截取
  hysteresis: { enter: 1.0, exit: 0.8 },
  blurMin: 22,          // 针对 600px 归一化裁切标定
  brightnessMin: 50,
  brightnessMax: 220,
  glareMax: 0.05,
};
```

界面左上角的调试行会实时显示 `fps · 检测耗时 · 面积 · 角度 · 清晰度 · 亮度`，**用它标定 `blurMin`**：让用户在正常持机距离下 `sharp` 稳定高于阈值，然后把阈值定在略低于该值的位置。

`blurMin` 等质量阈值与归一化宽度（`NORM_W = 600`）绑定。改 `NORM_W` 就必须重新标定。

---

## 换成你自己的模型

检测器是可插拔的。`detectDocument()` 只要求返回 `{ quad, areaRatio, maxAngleDev, touchesBorder }`，其余门控与状态机完全复用。

用 ONNX Runtime Web 替换 `app.js` 里那一次 `detectDocument(frame, CONFIG)` 调用即可：

```js
// 你的模型输出 [1, 4, 2] 归一化角点，或热图 → 你自己解成 quad
const quad = await myOnnxDetector.run(frame, DET_W, dh);
const det  = {
  quad,
  areaRatio: polygonArea(quad) / (DET_W * dh),
  maxAngleDev: maxAngleDeviation(quad),
  touchesBorder: false,
};
```

**注意**：`CardDetection.mnn` 不在此项目中，也不应被引入——它是阿里云身份认证 SDK 的模型权重，属于第三方受版权保护的资产。模型格式（ARM 版 MNN）也无法在浏览器中运行。若你需要模型路线，请使用你自己训练的权重。

---

## 浏览器兼容

| 能力 | 要求 |
|---|---|
| `getUserMedia` | 安全上下文（HTTPS / localhost）+ 用户授权 |
| `ImageData` / `canvas` | 全绿 |
| ES Modules | 全绿（现代浏览器） |
| iOS Safari | 需要用户手势触发；`playsinline` 已设置 |

iOS 上摄像头的 `facingMode: environment` 与分辨率约束是**建议值**，实际以系统返回为准。检测用的缩放比例取自 `video.videoWidth/Height`，因此不依赖约束是否被满足。

---

## 已知限制

- **未标定真实证件数据**。合成图像测试只验证几何流水线的正确性，真实场景的 `blurMin` / `glareMax` 需要用实际帧标定。
- **未做屏幕翻拍检测**（摩尔纹 / 反光频域特征）。如果这是防翻拍需求，需要另加一层——本项目的定位是取景辅助，不是反欺诈。
- **单证件假设**。画面里同时出现多个证件时取最大者，不做多实例。
- **`getUserMedia` 需要用户手势**。部分浏览器（尤其 iOS）必须在点击事件内调用，所以首屏有一个「开始采集」按钮。
