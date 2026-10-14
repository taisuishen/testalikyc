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
  // Area is measured against the GUIDE rect, not the whole frame — this is the
  // SDK's checkCardAreaRatio(cardQuad, frameQuad, min) semantics.
  minAreaRatio: 0.55,
  maxAreaRatio: 1.35,
  guideAspect: 1.585,   // ID-1 landscape: 85.60 x 53.98 mm
  aspectTolerance: 0.30,
  maxAngleDeg: 10,
  stackTime: 900,
  hysteresis: { enter: 1.0, exit: 0.8 },
  blurMin: 22,          // calibrated for the 600px-normalised crop
  brightnessMin: 50,
  brightnessMax: 220,
  glareMax: 0.05,
  qualityMinCropWidth: 320,  // below this the capture is not worth keeping
};

// The capture rectangle is a centred LANDSCAPE rectangle, not a full-bleed
// frame. Forcing the user to fill the whole viewport makes them hold the card
// too close (blur, perspective, cast shadow) and tells the detector nothing
// about where the card should be.
const GUIDE = {
  widthFrac: 0.88,     // fraction of available screen width
  centerYFrac: 0.45,   // slightly above centre so the HUD does not overlap
  marginPx: 14,
};

const TIPS = {
  "no-detection": "把证件放进框内",
  "no-component": "把证件放进框内",
  "outside-guide": "把证件移进框内",
  "component-too-small": "靠近一点",
  "no-quad": "对准证件四角",
  "not-convex": "换个背景，避免杂物干扰",
  "move-closer": "靠近一点，让证件填满框",
  "move-back": "离远一点，证件超出框了",
  "wrong-shape": "只对准一张证件，四个角都露出来",
  "tilt-invalid": "手机端平，减少倾斜",
  "corners-clipped": "证件四个角都要在画面内",
  "crop-too-small": "靠近一点",
  "low-resolution": "靠近一点，分辨率不够",
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
/* layout: guide rect + screen <-> image mapping                       */
/* ------------------------------------------------------------------ */

/** object-fit: cover transform between video pixels and displayed pixels. */
function coverTransform(dw, dh, vw, vh) {
  const s = Math.max(dw / vw, dh / vh);
  return { s, ox: (dw - vw * s) / 2, oy: (dh - vh * s) / 2 };
}

/** The capture rectangle in SCREEN coordinates: centred, landscape, card aspect. */
function guideRectScreen(dw, dh) {
  const availW = Math.max(1, dw - GUIDE.marginPx * 2);
  const width = availW * GUIDE.widthFrac;
  const height = width / CONFIG.guideAspect;
  return {
    x: (dw - width) / 2,
    y: dh * GUIDE.centerYFrac - height / 2,
    width,
    height,
  };
}

/**
 * Resolve everything the tick and the renderer both need: the cover transform,
 * the guide in screen space, and the guide in native video pixels. The guide is
 * defined in screen space (so it looks right regardless of video aspect) and
 * then mapped back into image space for the gates.
 */
function layout() {
  const dw = overlay.clientWidth || window.innerWidth;
  const dh = overlay.clientHeight || window.innerHeight;
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const t = coverTransform(dw, dh, vw, vh);
  const g = guideRectScreen(dw, dh);
  const x0 = (g.x - t.ox) / t.s;
  const y0 = (g.y - t.oy) / t.s;
  const x1 = (g.x + g.width - t.ox) / t.s;
  const y1 = (g.y + g.height - t.oy) / t.s;
  return {
    dw, dh, vw, vh, t,
    guideScreen: g,
    guideNative: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
  };
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

  // An ID needs enough pixels to be worth keeping. Below this the capture is
  // useless for downstream OCR regardless of how sharp it looks.
  if (cw < CONFIG.qualityMinCropWidth) {
    return { ok: false, reasons: ["low-resolution"], cropWidth: cw };
  }

  // Normalise by DOWNSCALING only. Upscaling a small crop interpolates detail
  // away and makes a perfectly sharp card measure as blurry, which would pin
  // the blur gate permanently shut on low-resolution camera streams.
  const targetW = Math.min(NORM_W, cw);
  const nh = Math.max(8, Math.round((targetW * ch) / cw));
  qualCanvas.width = targetW;
  qualCanvas.height = nh;
  qualCtx.drawImage(video, cx, cy, cw, ch, 0, 0, targetW, nh);
  const img = qualCtx.getImageData(0, 0, targetW, nh);
  const gray = toGray(img.data, targetW, nh);
  const full = [[0, 0], [targetW - 1, 0], [targetW - 1, nh - 1], [0, nh - 1]];
  const res = assessQuality(gray, targetW, nh, full, CONFIG);
  res.cropWidth = cw;
  return res;
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

  // Resolve layout once per tick and reuse it in the renderer.
  const L = layout();
  state.layout = L;

  // Guide in detection-image coordinates. Detection runs at DET_W wide, so the
  // native guide must be scaled down by the same factor.
  const scale = vw / DET_W;
  const guideDet = {
    x: L.guideNative.x / scale,
    y: L.guideNative.y / scale,
    width: L.guideNative.width / scale,
    height: L.guideNative.height / scale,
  };

  const t0 = performance.now();
  const det = detectDocument(frame, CONFIG, guideDet);
  state.detMs = performance.now() - t0;

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
    const areaMin = CONFIG.minAreaRatio *
      (relaxed ? CONFIG.hysteresis.exit : CONFIG.hysteresis.enter);
    const aspectOk =
      Math.abs(det.aspect - CONFIG.guideAspect) / CONFIG.guideAspect <= CONFIG.aspectTolerance;

    const geometryOk =
      det.areaRatio >= areaMin &&
      det.areaRatio <= CONFIG.maxAreaRatio &&
      det.maxAngleDev <= CONFIG.maxAngleDeg &&
      !det.touchesBorder &&
      aspectOk;

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

  // Reuse the transform resolved in the tick so the guide and the detected
  // quad are guaranteed to share one coordinate mapping.
  const L = state.layout ?? layout();
  const { t } = L;
  const toDisplay = ([x, y]) => [x * t.s + t.ox, y * t.s + t.oy];

  const v = state.verdict;
  const pass = !!v?.allGatesPass;

  // ---- capture rectangle: centred landscape, card aspect ----
  const g = L.guideScreen;
  const r = Math.min(14, g.height * 0.14);

  // Dim everything outside the guide so the target area reads unambiguously.
  octx.save();
  octx.beginPath();
  octx.rect(0, 0, dw, dh);
  octx.roundRect(g.x, g.y, g.width, g.height, r);
  octx.fillStyle = "rgba(0,0,0,0.42)";
  octx.fill("evenodd");
  octx.restore();

  octx.lineWidth = 2;
  octx.strokeStyle = pass ? "rgba(60,220,140,0.95)" : "rgba(255,255,255,0.5)";
  octx.beginPath();
  octx.roundRect(g.x, g.y, g.width, g.height, r);
  octx.stroke();

  // corner brackets, sized to the guide rather than the viewport
  const arm = Math.min(g.width, g.height) * 0.16;
  const corners = [
    [g.x, g.y, 1, 1], [g.x + g.width, g.y, -1, 1],
    [g.x + g.width, g.y + g.height, -1, -1], [g.x, g.y + g.height, 1, -1],
  ];
  octx.lineWidth = 4;
  octx.strokeStyle = pass ? "rgba(60,220,140,1)" : "rgba(255,255,255,0.85)";
  octx.beginPath();
  for (const [cx, cy, sx, sy] of corners) {
    octx.moveTo(cx + sx * arm, cy);
    octx.lineTo(cx, cy);
    octx.lineTo(cx, cy + sy * arm);
  }
  octx.stroke();

  // ---- detected quad ----
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

  // progress bar across the top
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
    (v?.quad
      ? ` · fill ${(v.areaRatio ?? 0).toFixed(2)} · ar ${(v.aspect ?? 0).toFixed(2)} · ang ${(v.maxAngleDev ?? 0).toFixed(0)}°`
      : "") +
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

// Diagnostics hook: lets the debug line, tests and the console inspect live
// state (resolved guide, smoothed quad, verdicts) without re-deriving it.
window.__docscan = { state, CONFIG, GUIDE, layout };
