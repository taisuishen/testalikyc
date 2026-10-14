// detect.js — document (card) detection by classical CV.
//
// Why not a CNN: in this flow the user is cooperating — they hold the card,
// they want it scanned. The target is a high-contrast, straight-edged,
// convex quadrilateral that dominates the frame. Classical CV resolves that
// in ~2-5 ms at 320px, needs no model download, no WASM, and no GPU.
// The detector is intentionally swappable: detectDocument() takes an
// optional `detector` hook so an ONNX/TF.js model can replace the CV stage
// while the gating + auto-capture state machine stay identical.
//
// Input is always a downscaled RGBA frame (~320px wide). Nothing here touches
// the DOM, so the same module runs in the browser and in Node tests.

import {
  polygonArea,
  perimeter,
  isConvex,
  orderQuad,
  maxAngleDeviation,
  boundingRect,
} from "./geometry.js";

/** Default gates. Tune per document type, mirroring doc.Config in the SDK. */
export const DEFAULT_CONFIG = {
  minAreaRatio: 0.25,     // card must cover >= 25% of the frame
  maxAngleDeg: 12,        // worst interior-angle deviation from 90deg
  maxCornerJitter: 6,     // px at detection scale, for temporal stability
  blurMin: 60,            // Laplacian variance floor (native-res crop)
  brightnessMin: 45,      // mean luma floor
  brightnessMax: 225,     // mean luma ceiling
  glareMax: 0.06,         // fraction of near-white pixels
  stackTime: 900,         // ms of continuous validity before auto-capture
  hysteresis: { enter: 0.72, exit: 0.5 }, // ratio thresholds for lock/unlock
};

/* ------------------------------------------------------------------ */
/* pixel stages                                                        */
/* ------------------------------------------------------------------ */

export function toGray(rgba, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return g;
}

/** Separable 5x5 gaussian, kernel [1,4,6,4,1]/16. */
export function gaussianBlur(gray, w, h) {
  const k = [1, 4, 6, 4, 1];
  const tmp = new Uint8ClampedArray(w * h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        s += gray[y * w + xx] * k[i + 2];
      }
      tmp[y * w + x] = s / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        s += tmp[yy * w + x] * k[i + 2];
      }
      out[y * w + x] = s / 16;
    }
  }
  return out;
}

export function sobelMagnitude(gray, w, h) {
  const mag = new Uint8ClampedArray(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = gray[i - w - 1], b = gray[i - w], c = gray[i - w + 1];
      const d = gray[i - 1], f = gray[i + 1];
      const g = gray[i + w - 1], hh = gray[i + w], k = gray[i + w + 1];
      const gx = a + 2 * d + g - (c + 2 * f + k);
      const gy = a + 2 * b + c - (g + 2 * hh + k);
      mag[i] = Math.min(255, Math.hypot(gx, gy) / 4);
    }
  }
  return mag;
}

/** Otsu threshold over a 8-bit histogram. */
export function otsu(hist) {
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  if (total === 0) return 128;
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

export function binarize(mag, w, h) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < mag.length; i++) hist[mag[i]]++;
  // Otsu on a gradient map can sit too low and flood the mask with texture
  // noise; clamp it up so only genuine edges survive.
  const thr = Math.max(otsu(hist), 38);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = mag[i] >= thr ? 1 : 0;
  return { bin, thr };
}

/** 3x3 dilation: bridges small gaps so a card outline becomes one blob. */
export function dilate(bin, w, h, iterations = 1) {
  let cur = bin;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!cur[y * w + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            out[yy * w + xx] = 1;
          }
        }
      }
    }
    cur = out;
  }
  return cur;
}

/**
 * Largest 8-connected component. Also reports whether it touches the frame
 * border — that is the practical test for "all four corners visible": a card
 * that is partially out of frame produces a blob clipped by the image edge.
 */
export function largestComponent(bin, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best = null;
  let bestCount = 0;
  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const pixels = [];
    let touches = false;
    while (sp > 0) {
      const idx = stack[--sp];
      pixels.push(idx);
      const x = idx % w, y = (idx / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const n = yy * w + xx;
          if (bin[n] && !seen[n]) { seen[n] = 1; stack[sp++] = n; }
        }
      }
    }
    if (pixels.length > bestCount) { bestCount = pixels.length; best = pixels; }
  }
  return best ? { pixels: best, touchesBorder: best.length && touchesFrame(best, w, h) } : null;
}

function touchesFrame(pixels, w, h) {
  for (const idx of pixels) {
    const x = idx % w, y = (idx / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* shape stages                                                        */
/* ------------------------------------------------------------------ */

/** Andrew monotone chain. pts = [[x,y], ...] */
export function convexHull(points) {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Ramer-Douglas-Peucker on an open polyline. */
export function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    const [x1, y1] = points[s], [x2, y2] = points[e];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = points[i];
      const d = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Pick the largest-area convex quad from a small point set. */
function bestFourByArea(pts) {
  let bestQ = null, bestA = -1;
  const n = pts.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const q = [pts[a], pts[b], pts[c], pts[d]];
          if (!isConvex(q)) continue;
          const area = polygonArea(q);
          if (area > bestA) { bestA = area; bestQ = q; }
        }
  return bestQ;
}

/**
 * Reduce a convex hull to exactly 4 corners by sweeping the RDP epsilon,
 * falling back to the maximal convex quad when the sweep skips past 4.
 */
export function approxQuad(hull) {
  if (hull.length < 4) return null;
  if (hull.length === 4) return hull.slice();
  const peri = perimeter(hull);
  let fallback = null;
  for (let k = 2; k <= 60; k++) {
    const eps = (peri * k) / 400;
    const a = rdp(hull, eps);
    if (a.length === 4) return a;
    if (a.length > 4 && a.length <= 9) fallback = a;
    if (a.length < 4) break;
  }
  return fallback ? bestFourByArea(fallback) : null;
}

/* ------------------------------------------------------------------ */
/* public entry points                                                 */
/* ------------------------------------------------------------------ */

/**
 * Detect a document quad in one downscaled frame.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img
 * @param {object} [cfg]
 * @returns {{quad:number[][], areaRatio:number, maxAngleDev:number,
 *            touchesBorder:boolean, coverage:number, stage:string}|null}
 */
export function detectDocument(img, cfg = {}) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const { width: w, height: h } = img;
  if (!w || !h) return null;

  const gray = toGray(img.data, w, h);
  const blur = gaussianBlur(gray, w, h);
  const mag = sobelMagnitude(blur, w, h);
  const { bin, thr } = binarize(mag, w, h);
  const dil = dilate(bin, w, h, 2);
  const comp = largestComponent(dil, w, h);
  if (!comp) return { failed: "no-component" };

  // Keep this floor low: a genuinely small card must still produce a quad so
  // the area gate can answer "move closer" instead of reporting "no document".
  const coverage = comp.pixels.length / (w * h);
  if (coverage < 0.005) return { failed: "component-too-small", coverage };

  // Subsample for hull cost; hull is unaffected at these densities.
  const pts = [];
  const step = comp.pixels.length > 4000 ? 2 : 1;
  for (let i = 0; i < comp.pixels.length; i += step) {
    const idx = comp.pixels[i];
    pts.push([idx % w, (idx / w) | 0]);
  }
  const hull = convexHull(pts);
  const quadRaw = approxQuad(hull);
  if (!quadRaw) return { failed: "no-quad", coverage };

  const quad = orderQuad(quadRaw);
  if (!isConvex(quad)) return { failed: "not-convex", coverage };

  const areaRatio = polygonArea(quad) / (w * h);
  const maxAngleDev = maxAngleDeviation(quad);
  const minSide = Math.min(
    ...quad.map((p, i) => Math.hypot(...quad[(i + 1) % 4].map((v, k) => v - p[k]))),
  );

  return {
    quad,
    areaRatio,
    maxAngleDev,
    touchesBorder: comp.touchesBorder,
    coverage,
    minSide,
    stage: "ok",
  };
}

/**
 * Quality gates measured on a NATIVE-resolution crop. Downscaling hides blur,
 * so sharpness must not be judged on the detection image.
 */
export function assessQuality(gray, w, h, quad, cfg = {}) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const rect = boundingRect(quad);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(w - 1, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(h - 1, Math.ceil(rect.y + rect.height));
  if (x1 - x0 < 8 || y1 - y0 < 8) return { ok: false, reason: "crop-too-small" };

  let sum = 0, n = 0, glare = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = gray[y * w + x];
      sum += v; n++;
      if (v >= 245) glare++;
    }
  }
  const brightness = sum / n;
  const glareRatio = glare / n;

  // Laplacian variance over the crop.
  let lsum = 0, lsq = 0, ln = 0;
  for (let y = y0 + 1; y < y1; y++) {
    for (let x = x0 + 1; x < x1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      lsum += lap; lsq += lap * lap; ln++;
    }
  }
  const mean = ln ? lsum / ln : 0;
  const sharpness = ln ? lsq / ln - mean * mean : 0;

  const reasons = [];
  if (sharpness < c.blurMin) reasons.push("blurry");
  if (brightness < c.brightnessMin) reasons.push("too-dark");
  if (brightness > c.brightnessMax) reasons.push("too-bright");
  if (glareRatio > c.glareMax) reasons.push("glare");

  return { ok: reasons.length === 0, reasons, sharpness, brightness, glareRatio };
}

/**
 * Run every gate the SDK uses and return a per-condition verdict so the UI
 * can give directional feedback (which edge, or which quality axis failed).
 */
export function evaluateFrame(det, quality, cfg = {}, prevQuad = null) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const out = {
    hasDoc: false,
    qualityOk: false,
    areaOk: false,
    angleOk: false,
    cornersOk: false,
    stable: false,
    reasons: [],
  };
  if (!det || det.failed) {
    out.reasons.push(det?.failed ?? "no-detection");
    return out;
  }
  out.hasDoc = true;
  out.quad = det.quad;
  out.areaRatio = det.areaRatio;
  out.maxAngleDev = det.maxAngleDev;
  out.quality = quality;

  out.areaOk = det.areaRatio >= c.minAreaRatio;
  out.angleOk = det.maxAngleDev <= c.maxAngleDeg;
  out.cornersOk = !det.touchesBorder;

  if (!out.areaOk) out.reasons.push("move-closer");
  if (!out.angleOk) out.reasons.push("tilt-invalid");
  if (!out.cornersOk) out.reasons.push("corners-clipped");
  if (quality && !quality.ok) out.reasons.push(...quality.reasons);

  out.qualityOk = !!quality?.ok;
  // Geometry is fine but this tick did not sample quality: report it as
  // pending rather than letting the UI jump straight to a failure tip.
  if (quality === null && out.areaOk && out.angleOk && out.cornersOk) {
    out.reasons.push("quality-pending");
  }

  if (prevQuad) {
    let jitter = 0;
    for (let i = 0; i < 4; i++) {
      jitter = Math.max(jitter, Math.hypot(prevQuad[i][0] - det.quad[i][0], prevQuad[i][1] - det.quad[i][1]));
    }
    out.jitter = jitter;
    out.stable = jitter <= c.maxCornerJitter;
  }

  out.allGatesPass = out.hasDoc && out.areaOk && out.angleOk && out.cornersOk && out.qualityOk;
  return out;
}
