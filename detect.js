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
  // ID-1 format (most ID cards, incl. Philippine PhilSys): 85.60 x 53.98 mm.
  // Passports are TD3 (125 x 88 mm, ratio 1.42) — override per document type.
  guideAspect: 1.585,
  aspectTolerance: 0.30,  // allowed RELATIVE deviation from guideAspect
  minAreaRatio: 0.45,     // card area / GUIDE area  (not image area)
  maxAreaRatio: 1.35,     // above this the card overflows the guide: move back
  maxAngleDeg: 12,        // worst interior-angle deviation from 90deg
  maxCornerJitter: 6,     // px at detection scale, for temporal stability
  blurMin: 60,            // Laplacian variance floor (native-res crop)
  brightnessMin: 45,      // mean luma floor
  brightnessMax: 225,     // mean luma ceiling
  glareMax: 0.06,         // fraction of near-white pixels
  stackTime: 900,         // ms of continuous validity before auto-capture
  hysteresis: { enter: 1.0, exit: 0.8 }, // area thresholds while timing
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

/**
 * Separable 3x3 binomial gaussian, kernel [1,2,1]/4.
 *
 * The 5x5 [1,4,6,4,1] version measured 3.2ms of a 5.7ms frame at 320x240 —
 * over half the budget — and low-end Android is roughly 10x slower than the
 * desktop V8 used for that measurement. Detection runs on a 320px-wide frame
 * whose edge features are many pixels wide, so the extra 5x5 smoothing buys
 * nothing that the dilation stage does not already recover.
 */
export function gaussianBlur(gray, w, h) {
  const k = [1, 2, 1];
  const tmp = new Uint8ClampedArray(w * h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      tmp[y * w + x] = (gray[y * w + xm] + 2 * gray[y * w + x] + gray[y * w + xp]) / 4;
    }
  }
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      out[y * w + x] = (tmp[ym * w + x] + 2 * tmp[y * w + x] + tmp[yp * w + x]) / 4;
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
 * Pick the component that best represents the document, and return its edge
 * extremes rather than every pixel.
 *
 * Why extremes: the hull of a rasterised blob is fully determined by the
 * min/max-x of each row and the min/max-y of each column. Every hull vertex has
 * a supporting line; if that line is more vertical the vertex is a row
 * x-extreme, otherwise it is a column y-extreme. So the union of those extremes
 * has exactly the same convex hull, while being at most ~2(w+h) points instead
 * of one entry per pixel.
 *
 * That matters a lot in practice: a phone body filling the frame is a component
 * of ~30k pixels at 256px, and building + sorting that point list measured
 * 21-40ms per frame in Chrome (a 1.2ms early-exit path next to it). The extreme
 * set is ~900 points worst case and usually a few dozen.
 *
 * `guide` (optional, in this image's coordinate space) is the on-screen capture
 * rectangle. When supplied, a component must clear three plausibility tests:
 *
 *   1. centroid inside the guide (plus slack) — not enough alone, since the
 *      phone body or a monitor behind the card also covers the guide;
 *   2. bounding-box aspect close to the guide's — real captures showed a phone
 *      body winning at aspect 0.67 against a landscape guide;
 *   3. bounding-box area not grossly larger than the guide — the same captures
 *      showed the winner at 2.25-2.43x the guide area.
 *
 * Selection among survivors is by bounding-box area, not pixel count: a card
 * outline is a thin ring whose pixel count is far below the area it encloses.
 */
export function selectComponent(bin, w, h, guide = null, cfg = {}) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);

  // Reused across components; only touched rows/columns are reset.
  const rowMinX = new Int32Array(h).fill(w);
  const rowMaxX = new Int32Array(h).fill(-1);
  const colMinY = new Int32Array(w).fill(h);
  const colMaxY = new Int32Array(w).fill(-1);
  const touchedRows = [];
  const touchedCols = [];

  const slack = 0.10;
  const gx0 = guide ? guide.x - guide.width * slack : 0;
  const gy0 = guide ? guide.y - guide.height * slack : 0;
  const gx1 = guide ? guide.x + guide.width * (1 + slack) : w;
  const gy1 = guide ? guide.y + guide.height * (1 + slack) : h;

  const bboxAspectTol = Math.max(c.aspectTolerance, 0.45);
  const bboxMaxAreaFactor = 1.8;

  let best = null;
  let bestScore = -1;
  let sawAny = false;
  let sawInGuide = false;

  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || seen[start]) continue;

    touchedRows.length = 0;
    touchedCols.length = 0;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;

    let count = 0, sumX = 0, sumY = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1, touches = false;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w, y = (idx / w) | 0;
      count++; sumX += x; sumY += y;

      if (rowMinX[y] === w) touchedRows.push(y);
      if (rowMinX[y] > x) rowMinX[y] = x;
      if (rowMaxX[y] < x) rowMaxX[y] = x;
      if (colMinY[x] === h) touchedCols.push(x);
      if (colMinY[x] > y) colMinY[x] = y;
      if (colMaxY[x] < y) colMaxY[x] = y;

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
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

    sawAny = true;
    const cx = sumX / count, cy = sumY / count;
    const inGuide = !guide || (cx >= gx0 && cx <= gx1 && cy >= gy0 && cy <= gy1);
    if (inGuide) sawInGuide = true;

    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const bboxArea = bw * bh;

    let eligible = inGuide;
    if (eligible && guide) {
      const aspect = bw / Math.max(1e-6, bh);
      if (Math.abs(aspect - c.guideAspect) / c.guideAspect > bboxAspectTol) eligible = false;
      else if (bboxArea > guide.width * guide.height * bboxMaxAreaFactor) eligible = false;
    }

    if (eligible && bboxArea > bestScore) {
      // Materialise the extreme set only for the current best candidate; a
      // later, larger component simply replaces it.
      const points = [];
      for (const y of touchedRows) {
        points.push([rowMinX[y], y], [rowMaxX[y], y]);
      }
      for (const x of touchedCols) {
        points.push([x, colMinY[x]], [x, colMaxY[x]]);
      }
      bestScore = bboxArea;
      best = {
        points,
        count,
        touchesBorder: touches,
        bbox: { x: minX, y: minY, width: bw, height: bh },
        centroid: [cx, cy],
      };
    }

    // Reset only what this component touched.
    for (const y of touchedRows) { rowMinX[y] = w; rowMaxX[y] = -1; }
    for (const x of touchedCols) { colMinY[x] = h; colMaxY[x] = -1; }
  }

  return { component: best, sawAny, sawInGuide };
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

/**
 * RDP for a CLOSED polygon.
 *
 * Running plain RDP on a closed hull as if it were an open polyline is wrong:
 * the first and last vertices are adjacent, both get force-kept, and you end up
 * with a spurious vertex at the seam while real corners get dropped — which is
 * what produced quads with two corners collapsed onto the same edge.
 *
 * The correct treatment splits the ring at the vertex farthest from the start,
 * simplifies each half, then rejoins without duplicating the shared endpoints.
 */
export function rdpClosed(pts, eps) {
  const n = pts.length;
  if (n < 4) return pts.slice();
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const half1 = pts.slice(0, far + 1);
  const half2 = pts.slice(far).concat([pts[0]]);
  const a = rdp(half1, eps);
  const b = rdp(half2, eps);
  return a.concat(b.slice(1, -1));
}

/**
 * Reject degenerate quads.
 *
 * The failure this guards against: all four vertices are real hull points, the
 * shape is convex and has decent area, but one edge has collapsed — e.g. two
 * corners sitting on the same card edge, 9px apart. Such a shape reports the
 * wrong area and the wrong aspect, so gates pass intermittently, the progress
 * bar keeps resetting and the capture never locks.
 *
 * An ID card's short side is ~63% of its long side (ID-1 is 1.585:1), so even
 * under noticeable perspective no side should fall below ~28% of the longest.
 */
function wellFormed(q) {
  const sides = q.map((p, i) => {
    const r = q[(i + 1) % 4];
    return Math.hypot(r[0] - p[0], r[1] - p[1]);
  });
  const maxS = Math.max(...sides);
  if (Math.min(...sides) < maxS * 0.28) return false;
  // Opposite sides of a (near-)parallelogram stay comparable under perspective.
  if (Math.min(sides[0], sides[2]) < Math.max(sides[0], sides[2]) * 0.4) return false;
  if (Math.min(sides[1], sides[3]) < Math.max(sides[1], sides[3]) * 0.4) return false;
  return true;
}

/**
 * Pick the max-area well-formed convex quad from a point set.
 *
 * The point set must still CONTAIN the true corners — searching an
 * over-simplified polygon is what produced collapsed edges, so callers pass a
 * lightly-reduced hull rather than an aggressively simplified one.
 */
export function maxAreaQuad(pts) {
  const n = pts.length;
  if (n < 4) return null;
  let bestQ = null, bestA = -1;
  for (let a = 0; a < n - 3; a++)
    for (let b = a + 1; b < n - 2; b++)
      for (let c = b + 1; c < n - 1; c++)
        for (let d = c + 1; d < n; d++) {
          const q = [pts[a], pts[b], pts[c], pts[d]];
          if (!isConvex(q)) continue;
          if (!wellFormed(q)) continue;
          const area = polygonArea(q);
          if (area > bestA) { bestA = area; bestQ = q; }
        }
  return bestQ;
}

/**
 * Reduce a convex hull to exactly 4 corners.
 *
 * Primary path sweeps the RDP epsilon on the closed ring and takes the first
 * result that has exactly four well-formed vertices. RDP can step from five
 * vertices straight to three, so the fallback searches a LIGHTLY reduced hull
 * (1% of perimeter) rather than the last aggressive simplification — that keeps
 * the true corners inside the candidate pool.
 */
export function approxQuad(hull) {
  if (hull.length < 4) return null;
  if (hull.length === 4) return wellFormed(hull) ? hull.slice() : null;

  const peri = perimeter(hull);

  // Light reduction only, tightening just enough to bound the combinatorics.
  // A small epsilon keeps every real corner (corner deviations are tens of px
  // while edge noise is sub-pixel) and only bounds the search space.
  let pool = hull;
  for (const frac of [0.004, 0.008, 0.015, 0.03, 0.06]) {
    const r = rdpClosed(hull, Math.max(1.0, peri * frac));
    if (r.length >= 4) pool = r;
    if (pool.length <= 20) break;
  }
  if (pool.length > 30) return null;   // refuse rather than emit a bad quad

  // Max-enclosed-area is the robust corner objective: a point in the middle of
  // an edge can never increase the area, so true corners win by construction.
  const q = maxAreaQuad(pool);
  if (q) return q;

  const coarse = rdpClosed(hull, peri * 0.03);
  return coarse.length === 4 && wellFormed(coarse) ? coarse : null;
}

/* ------------------------------------------------------------------ */
/* public entry points                                                 */
/* ------------------------------------------------------------------ */

/**
 * Detect a document quad in one downscaled frame.
 *
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img
 * @param {object} [cfg]
 * @param {{x:number,y:number,width:number,height:number}} [guide]
 *        The capture rectangle in THIS image's coordinate space. When supplied,
 *        areaRatio is measured against the guide (matching the SDK's
 *        checkCardAreaRatio(cardQuad, frameQuad, min)), and only components
 *        centred inside it are eligible.
 */
export function detectDocument(img, cfg = {}, guide = null) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const { width: w, height: h } = img;
  if (!w || !h) return null;

  const gray = toGray(img.data, w, h);
  const blur = gaussianBlur(gray, w, h);
  const mag = sobelMagnitude(blur, w, h);
  const { bin } = binarize(mag, w, h);
  const dil = dilate(bin, w, h, 2);

  const { component: comp, sawAny, sawInGuide } = selectComponent(dil, w, h, guide, c);
  if (!comp) {
    // Three distinct outcomes, three distinct tips: nothing anywhere, something
    // present but not in the guide, or something in the guide that is plainly
    // not a card (wrong shape or far too large).
    if (!sawAny) return { failed: "no-component" };
    if (!sawInGuide) return { failed: "outside-guide" };
    return { failed: "implausible-component" };
  }

  // Keep this floor low: a genuinely small card must still produce a quad so
  // the area gate can answer "move closer" instead of "no document".
  const coverage = comp.count / (w * h);
  if (coverage < 0.005) return { failed: "component-too-small", coverage };

  // The component already carries its edge extremes (identical convex hull,
  // at most ~2(w+h) points instead of one per pixel).
  const hull = convexHull(comp.points);
  const quadRaw = approxQuad(hull);
  if (!quadRaw) return { failed: "no-quad", coverage };

  const quad = orderQuad(quadRaw);
  if (!isConvex(quad)) return { failed: "not-convex", coverage };

  const cardArea = polygonArea(quad);
  const refArea = guide ? guide.width * guide.height : w * h;
  const areaRatio = cardArea / refArea;

  const side = quad.map((p, i) => {
    const q = quad[(i + 1) % 4];
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  const aspect = Math.max(side[0], side[2]) / Math.max(1e-6, Math.max(side[1], side[3]));

  return {
    quad,
    areaRatio,
    aspect,
    maxAngleDev: maxAngleDeviation(quad),
    touchesBorder: comp.touchesBorder,
    coverage,
    minSide: Math.min(...side),
    centroid: comp.centroid,
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
  out.aspect = det.aspect;
  out.maxAngleDev = det.maxAngleDev;
  out.quality = quality;

  out.areaOk = det.areaRatio >= c.minAreaRatio;
  out.angleOk = det.maxAngleDev <= c.maxAngleDeg;
  out.cornersOk = !det.touchesBorder;
  // Aspect is the gate that rejects non-documents. Without it any convex quad
  // with right angles and enough area passes — a table edge, a monitor bezel,
  // a door frame. A card has a fixed ID-1 ratio, so constrain it.
  out.aspectOk = det.aspect === undefined
    ? true
    : Math.abs(det.aspect - c.guideAspect) / c.guideAspect <= c.aspectTolerance;
  out.notTooLarge = det.areaRatio <= c.maxAreaRatio;

  // Order matters: reasons[0] is what the UI shows. Report "this is the wrong
  // shape" before "move back", because a grossly oversized quad is almost
  // always the detector locked onto the phone body or a monitor rather than
  // the user standing too close.
  if (!out.aspectOk) out.reasons.push("wrong-shape");
  if (!out.cornersOk) out.reasons.push("corners-clipped");
  if (!out.areaOk) out.reasons.push("move-closer");
  if (!out.notTooLarge) out.reasons.push("move-back");
  if (!out.angleOk) out.reasons.push("tilt-invalid");
  if (quality && !quality.ok) out.reasons.push(...quality.reasons);

  out.qualityOk = !!quality?.ok;
  // Geometry is fine but this tick did not sample quality: report it as
  // pending rather than letting the UI jump straight to a failure tip.
  if (quality === null && out.areaOk && out.angleOk && out.cornersOk && out.aspectOk && out.notTooLarge) {
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

  out.allGatesPass = out.hasDoc && out.areaOk && out.notTooLarge &&
    out.angleOk && out.cornersOk && out.aspectOk && out.qualityOk;
  return out;
}
