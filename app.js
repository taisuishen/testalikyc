// app.js — camera pipeline, gating, auto-capture state machine, viewfinder.
//
// Architecture (mirrors the SDK's split, see docs):
//   video -> detCanvas(320px)  -> geometry gates  (cheap, every tick)
//         -> qualityCanvas(600px, card crop, resolution-normalised) -> quality gates
//         -> stability timer (stackTime) -> capture -> warp at native res -> upload
//
// Only the geometry stage runs every tick. Quality is measured only once the
// card is roughly in place, and always normalised to a fixed 600px width so the
// blur threshold does not drift between devices.

import {
  detectDocument, assessQuality, evaluateFrame, toGray, DEFAULT_CONFIG,
} from "./detect.js";
import { solveHomography, warpPerspective, boundingRect } from "./geometry.js";

const DET_W = 320;            // detection resolution (width)
const NORM_W = 600;           // quality normalisation width
const DET_INTERVAL_MS = 80;   // ~12 Hz detection
const QUALITY_INTERVAL_MS = 160;

const CONFIG = {
  ...DEFAULT_CONFIG,
  minAreaRatio: 0.28,
  maxAngleDeg: 10,
  stackTime: 900,
  hysteresis: { enter: 1.0, exit: 0.8 },
  blurMin: 22,          // calibrated for the 600px-normalised crop
  brightnessMin: 50,
  brightnessMax: 220,
  glareMax: 0.05,
};

const TIPS = {
  "no-detection": "把证件放进框内",
  "no-component": "把证件放进框内",
  "component-too-small": "靠近一点",
  "no-quad": "对准证件四角",
  "not-convex": "换个背景，避免杂物干扰",
  "move-closer": "靠近一点，让证件占满框",
  "tilt-invalid": "手机端平，减少倾斜",
  "corners-clipped": "证件四个角都要在画面内",
  "crop-too-small": "靠近一点",
  blurry: "拿稳，保持清晰",
  "too-dark": "光线不足，换个位置",
  "too-bright": "光线太强，避开直射",
  glare: "有反光，换个角度",
  "quality-pending": "检测中…",
};

const el = (id) => document.getElementById(id);
const video = el("video");
const overlay = el("overlay");
const tip = el("tip");
const meterFill = el("meterFill");
const resultPane = el("result");
const shotImg = el("shot");
const resultInfo = el("resultInfo");
const retakeBtn = el("retake");
const debugEl = el("debug");
const startBtn = el("start");

const detCanvas = document.createElement("canvas");
const detCtx = detCanvas.getContext("2d", { willReadFrequently: true });
const qualCanvas = document.createElement("canvas");
const qualCtx = qualCanvas.getContext("2d", { willReadFrequently: true });
const capCanvas = document.createElement("canvas");
const capCtx = capCanvas.getContext("2d", { willReadFrequently: true });
const octx = overlay.getContext("2d");

const state = {
  running: false,
  captured: false,
  stableSince: null,
  progress: 0,
  quadSmooth: null,      // detection-scale, temporally smoothed
  quadNative: null,      // native-scale, for display + capture
  verdict: null,
  quality: null,
  lastQualityAt: 0,
  lastDetAt: 0,
  detMs: 0,
  fps: 0,
  frameTimes: [],
};

/* ------------------------------------------------------------------ */
/* camera                                                              */
/* ------------------------------------------------------------------ */

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  video.srcObject = stream;
  await video.play();
  state.running = true;
  resultPane.hidden = true;
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ */
/* detection tick                                                      */
/* ------------------------------------------------------------------ */

function smoothQuad(prev, next, alpha = 0.45) {
  if (!prev) return next.map((p) => [p[0], p[1]]);
  return next.map((p, i) => [
    prev[i][0] + alpha * (p[0] - prev[i][0]),
    prev[i][1] + alpha * (p[1] - prev[i][1]),
  ]);
}

function measureQuality(vw, vh) {
  const r = boundingRect(state.quadNative);
  const cx = Math.max(0, Math.floor(r.x));
  const cy = Math.max(0, Math.floor(r.y));
  const cw = Math.min(vw - cx, Math.ceil(r.width));
  const ch = Math.min(vh - cy, Math.ceil(r.height));
  if (cw < 24 || ch < 16) return { ok: false, reasons: ["crop-too-small"] };

  const nh = Math.max(8, Math.round((NORM_W * ch) / cw));
  qualCanvas.width = NORM_W;
  qualCanvas.height = nh;
  // Draw the card crop scaled to a fixed width: makes the blur floor
  // independent of camera resolution.
  qualCtx.drawImage(video, cx, cy, cw, ch, 0, 0, NORM_W, nh);
  const img = qualCtx.getImageData(0, 0, NORM_W, nh);
  const gray = toGray(img.data, NORM_W, nh);
  const full = [[0, 0], [NORM_W - 1, 0], [NORM_W - 1, nh - 1], [0, nh - 1]];
  return assessQuality(gray, NORM_W, nh, full, CONFIG);
}

function loop(t) {
  if (!state.running) return;
  requestAnimationFrame(loop);
  if (video.readyState < 2 || !video.videoWidth) return;

  // fps meter
  state.frameTimes.push(t);
  while (state.frameTimes.length && t - state.frameTimes[0] > 1000) state.frameTimes.shift();
  state.fps = state.frameTimes.length;

  if (t - state.lastDetAt < DET_INTERVAL_MS) return;
  state.lastDetAt = t;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const dh = Math.max(1, Math.round((DET_W * vh) / vw));
  if (detCanvas.width !== DET_W || detCanvas.height !== dh) {
    detCanvas.width = DET_W;
    detCanvas.height = dh;
  }
  detCtx.drawImage(video, 0, 0, DET_W, dh);
  const frame = detCtx.getImageData(0, 0, DET_W, dh);

  const t0 = performance.now();
  const det = detectDocument(frame, CONFIG);
  state.detMs = performance.now() - t0;

  const scale = vw / DET_W;

  if (!det || det.failed) {
    state.quadSmooth = null;
    state.quadNative = null;
    state.quality = null;
    state.verdict = evaluateFrame(det, null, CONFIG, null);
  } else {
    state.quadSmooth = smoothQuad(state.quadSmooth, det.quad);
    state.quadNative = state.quadSmooth.map(([x, y]) => [x * scale, y * scale]);

    // Hysteresis: once timing, tolerate a slightly smaller card so the
    // progress bar does not reset on tiny hand movements.
    const relaxed = state.stableSince != null;
    const areaMin = relaxed
      ? CONFIG.minAreaRatio * CONFIG.hysteresis.exit
      : CONFIG.minAreaRatio * CONFIG.hysteresis.enter;

    const geometryOk =
      det.areaRatio >= areaMin &&
      det.maxAngleDev <= CONFIG.maxAngleDeg &&
      !det.touchesBorder;

    if (geometryOk) {
      if (t - state.lastQualityAt > QUALITY_INTERVAL_MS || !state.quality) {
        state.quality = measureQuality(vw, vh);
        state.lastQualityAt = t;
      }
    } else {
      state.quality = null;
    }

    state.verdict = evaluateFrame(det, geometryOk ? state.quality : null, CONFIG, null);
  }

  const pass = !!state.verdict?.allGatesPass;

  // ---- auto-capture timer: any failing frame resets it ----
  if (pass) {
    if (state.stableSince == null) state.stableSince = t;
    state.progress = Math.min(1, (t - state.stableSince) / CONFIG.stackTime);
    if (state.progress >= 1 && !state.captured) capture();
  } else {
    state.stableSince = null;
    state.progress = 0;
  }

  render();
}

/* ------------------------------------------------------------------ */
/* viewfinder                                                          */
/* ------------------------------------------------------------------ */

function render() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const dw = overlay.clientWidth;
  const dh = overlay.clientHeight;
  if (overlay.width !== Math.round(dw * dpr) || overlay.height !== Math.round(dh * dpr)) {
    overlay.width = Math.round(dw * dpr);
    overlay.height = Math.round(dh * dpr);
  }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, dw, dh);

  // video -> display mapping for object-fit: cover
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const s = Math.max(dw / vw, dh / vh);
  const ox = (dw - vw * s) / 2;
  const oy = (dh - vh * s) / 2;
  const toDisplay = ([x, y]) => [x * s + ox, y * s + oy];

  const v = state.verdict;
  const pass = !!v?.allGatesPass;

  // guide frame
  const inset = Math.min(dw, dh) * 0.08;
  const gx = inset, gy = inset;
  const gw = dw - inset * 2, gh = dh - inset * 2;
  const arm = Math.min(gw, gh) * 0.12;
  octx.lineWidth = 3;
  octx.strokeStyle = pass ? "rgba(60,220,140,0.95)" : "rgba(255,255,255,0.55)";
  octx.beginPath();
  const corners = [
    [gx, gy, 1, 1], [gx + gw, gy, -1, 1],
    [gx + gw, gy + gh, -1, -1], [gx, gy + gh, 1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    octx.moveTo(cx + sx * arm, cy);
    octx.lineTo(cx, cy);
    octx.lineTo(cx, cy + sy * arm);
  }
  octx.stroke();

  // detected quad
  if (state.quadNative) {
    octx.beginPath();
    state.quadNative.forEach((p, i) => {
      const [x, y] = toDisplay(p);
      if (i === 0) octx.moveTo(x, y); else octx.lineTo(x, y);
    });
    octx.closePath();
    octx.lineWidth = 3;
    octx.strokeStyle = pass ? "rgba(60,220,140,1)" : "rgba(255,196,0,0.95)";
    octx.stroke();
    octx.fillStyle = pass ? "rgba(60,220,140,0.12)" : "rgba(255,196,0,0.08)";
    octx.fill();
  }

  // progress arc across the top
  if (state.progress > 0) {
    octx.fillStyle = "rgba(60,220,140,0.9)";
    octx.fillRect(0, 0, dw * state.progress, 4);
  }

  // tips
  const reasons = v?.reasons?.length ? v.reasons : ["no-detection"];
  tip.textContent = pass ? "保持不动…" : (TIPS[reasons[0]] ?? reasons[0]);
  tip.dataset.state = pass ? "ok" : "wait";
  meterFill.style.width = `${Math.round(state.progress * 100)}%`;

  debugEl.textContent =
    `${state.fps}fps · det ${state.detMs.toFixed(1)}ms` +
    (v?.quad ? ` · area ${(v.areaRatio ?? 0).toFixed(2)} · ang ${(v.maxAngleDev ?? 0).toFixed(0)}°` : "") +
    (state.quality ? ` · sharp ${(state.quality.sharpness ?? 0).toFixed(0)} · lum ${(state.quality.brightness ?? 0).toFixed(0)}` : "");
}

/* ------------------------------------------------------------------ */
/* capture + upload                                                    */
/* ------------------------------------------------------------------ */

function quadAspect(quad) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(d(quad[0], quad[1]), d(quad[3], quad[2]));
  const h = Math.max(d(quad[0], quad[3]), d(quad[1], quad[2]));
  return w / h;
}

async function capture() {
  state.captured = true;
  state.running = false;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  capCanvas.width = vw;
  capCanvas.height = vh;
  capCtx.drawImage(video, 0, 0);
  const src = capCtx.getImageData(0, 0, vw, vh);

  // Rectify: map the detected quad onto an axis-aligned rect of the same
  // measured aspect. The solver expects dst -> src, hence the argument order.
  const quad = state.quadNative;
  const aspect = quadAspect(quad);
  const outW = Math.min(vw, Math.round(Math.max(640, Math.min(1600, vw * 0.8))));
  const outH = Math.max(1, Math.round(outW / aspect));
  const dst = [[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]];
  const H = solveHomography(dst, quad);

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx2 = out.getContext("2d");

  if (H) {
    const warped = warpPerspective(src.data, vw, vh, H, outW, outH);
    octx2.putImageData(new ImageData(warped, outW, outH), 0, 0);
  } else {
    // Degenerate homography: fall back to the unrectified frame rather than
    // silently producing a blank image.
    octx2.drawImage(capCanvas, 0, 0, outW, outH);
  }

  const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
  showResult(out, blob);
  upload(blob);
}

function showResult(canvas, blob) {
  resultPane.hidden = false;
  shotImg.src = canvas.toDataURL("image/jpeg", 0.9);
  const v = state.verdict;
  resultInfo.textContent =
    `已截取 ${canvas.width}×${canvas.height} · ${(blob.size / 1024).toFixed(0)}KB\n` +
    `面积占比 ${(v?.areaRatio ?? 0).toFixed(3)} · 角度偏差 ${(v?.maxAngleDev ?? 0).toFixed(1)}°\n` +
    `清晰度 ${(state.quality?.sharpness ?? 0).toFixed(0)} · 亮度 ${(state.quality?.brightness ?? 0).toFixed(0)}`;
}

async function upload(blob) {
  const v = state.verdict;
  const meta = {
    areaRatio: v?.areaRatio,
    maxAngleDev: v?.maxAngleDev,
    quality: state.quality,
    config: { minAreaRatio: CONFIG.minAreaRatio, maxAngleDeg: CONFIG.maxAngleDeg, stackTime: CONFIG.stackTime },
    capturedAt: new Date().toISOString(),
  };
  try {
    // Raw body + headers keeps the server free of multipart parsing.
    const r = await fetch("/api/capture", {
      method: "POST",
      headers: {
        "Content-Type": "image/jpeg",
        "X-Capture-Meta": encodeURIComponent(JSON.stringify(meta)),
      },
      body: blob,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    resultInfo.textContent += `\n已上传: ${j.id} (${(j.bytes / 1024).toFixed(0)}KB, sha256 ${j.sha256.slice(0, 12)}…)`;
  } catch (e) {
    resultInfo.textContent += `\n上传失败: ${e.message}`;
  }
}

function retake() {
  state.captured = false;
  state.stableSince = null;
  state.progress = 0;
  state.quadSmooth = null;
  state.quality = null;
  resultPane.hidden = true;
  state.running = true;
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

retakeBtn.addEventListener("click", retake);

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  try {
    await startCamera();
    startBtn.hidden = true;
  } catch (e) {
    startBtn.disabled = false;
    tip.textContent = `无法打开摄像头: ${e.name} — ${e.message}`;
    tip.dataset.state = "wait";
  }
});

// Keep the overlay sized to the viewport.
new ResizeObserver(() => render()).observe(document.body);
