// geometry.js — quadrilateral math, homography, perspective warp.
// Pure functions over plain arrays: no DOM, no canvas. Safe to import in Node tests.

/** Shoelace area of any simple polygon. pts = [[x,y], ...] */
export function polygonArea(pts) {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export const quadArea = polygonArea;

export function perimeter(pts) {
  let p = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}

export function boundingRect(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Interior angles (degrees) at each vertex of an ordered polygon. */
export function interiorAngles(q) {
  const n = q.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = q[(i - 1 + n) % n];
    const c = q[i];
    const nx = q[(i + 1) % n];
    const v1 = [p[0] - c[0], p[1] - c[1]];
    const v2 = [nx[0] - c[0], nx[1] - c[1]];
    const dot = v1[0] * v2[0] + v1[1] * v2[1];
    const m = Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]);
    const cos = m < 1e-9 ? 0 : dot / m;
    out.push((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
  }
  return out;
}

/**
 * Max deviation of any interior angle from 90 degrees.
 * This is the `maxAngleDeg` gate: a card seen head-on reads near 0,
 * a tilted/perspective view grows quickly.
 */
export function maxAngleDeviation(q) {
  const angles = interiorAngles(q);
  let worst = 0;
  for (const a of angles) worst = Math.max(worst, Math.abs(a - 90));
  return worst;
}

/** Signed cross product of edge (a->b) and (b->c). */
function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
}

/** True when every turn has the same sign (no reflex vertex). */
export function isConvex(pts) {
  const n = pts.length;
  if (n < 3) return false;
  let pos = 0, neg = 0;
  for (let i = 0; i < n; i++) {
    const c = cross(pts[i], pts[(i + 1) % n], pts[(i + 2) % n]);
    if (c > 0) pos++;
    else if (c < 0) neg++;
  }
  return pos === 0 || neg === 0;
}

/**
 * Order 4 points as top-left, top-right, bottom-right, bottom-left.
 * Angular sort about the centroid gives a consistent winding, then we
 * rotate so the corner closest to the origin-ish side leads.
 */
export function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  );
  let start = 0, best = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i][0] + sorted[i][1];
    if (s < best) { best = s; start = i; }
  }
  return sorted.map((_, k) => sorted[(start + k) % sorted.length]);
}

/** 8x8 dense solve with partial pivoting. A is mutated. */
function solve8(A, b) {
  const n = 8;
  for (let i = 0; i < n; i++) A[i].push(b[i]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (piv !== col) { const t = A[col]; A[col] = A[piv]; A[piv] = t; }
    const d = A[col][col];
    if (Math.abs(d) < 1e-12) return null;
    for (let c = col; c <= n; c++) A[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row) => row[n]);
}

/**
 * Homography mapping src[i] -> dst[i] for 4 point pairs.
 * Returns a flat 9-element row-major 3x3, or null when degenerate.
 */
export function solveHomography(src, dst) {
  if (src.length !== 4 || dst.length !== 4) return null;
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  const h = solve8(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Apply a homography to a point. */
export function applyH(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  const s = Math.abs(w) < 1e-12 ? 1e-12 : w;
  return [(H[0] * x + H[1] * y + H[2]) / s, (H[3] * x + H[4] * y + H[5]) / s];
}

/**
 * Warp an RGBA buffer through H (dst -> src direction) with bilinear sampling.
 * Caller passes H = solveHomography(dstQuad, srcQuad).
 */
export function warpPerspective(src, srcW, srcH, H, outW, outH) {
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const [sx, sy] = applyH(H, [x + 0.5, y + 0.5]);
      const o = (y * outW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= srcW - 1 || sy >= srcH - 1) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + srcW * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bot = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bot * fy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Axis-aligned target rect for a card of the given aspect ratio. */
export function targetRect(aspect, longSide = 1000) {
  const w = aspect >= 1 ? longSide : Math.round(longSide * aspect);
  const h = aspect >= 1 ? Math.round(longSide / aspect) : longSide;
  return { width: w, height: h };
}
