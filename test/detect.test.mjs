// Synthetic-image tests for the classical-CV document detector.
// Run: node test/detect.test.mjs

import { detectDocument, DEFAULT_CONFIG } from "../detect.js";
import { orderQuad, polygonArea } from "../geometry.js";

const W = 320, H = 240;

function blank(rgb = [40, 42, 48]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: W, height: H };
}

function inPoly(x, y, quad) {
  let inside = false;
  for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
    const [xi, yi] = quad[i], [xj, yj] = quad[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function fill(img, quad, rgb) {
  const { data } = img;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inPoly(x + 0.5, y + 0.5, quad)) continue;
      const o = (y * W + x) * 4;
      data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
    }
  }
}

/** Simulate card content: dark blobs that must not be mistaken for the card. */
function addContent(img, quad) {
  const rect = quad.reduce(
    (a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])],
    [1e9, 1e9, -1e9, -1e9],
  );
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0, h = y1 - y0;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 4; c++) {
      const bx = Math.round(x0 + w * (0.1 + c * 0.2));
      const by = Math.round(y0 + h * (0.12 + r * 0.17));
      const bw = Math.round(w * 0.12), bh = Math.round(h * 0.07);
      for (let y = by; y < by + bh; y++) {
        for (let x = bx; x < bx + bw; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const o = (y * W + x) * 4;
          img.data[o] = 30; img.data[o + 1] = 30; img.data[o + 2] = 34;
        }
      }
    }
  }
}

function maxCornerError(a, b) {
  const A = orderQuad(a), B = orderQuad(b);
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    worst = Math.max(worst, Math.hypot(A[i][0] - B[i][0], A[i][1] - B[i][1]));
  }
  return worst;
}

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  " + detail : ""}`); }
}

/* ---------------- case 1: clean perspective card ---------------- */
{
  console.log("\ncase 1: flat card, perspective quad");
  const truth = [[62, 38], [252, 56], [238, 202], [48, 186]];
  const img = blank();
  fill(img, truth, [236, 234, 228]);
  const det = detectDocument(img);
  if (det?.failed) {
    check("detected", false, `failed=${det.failed}`);
  } else {
    check("detected", true);
    check("quad within 10px", maxCornerError(det.quad, truth) < 10, `err=${maxCornerError(det.quad, truth).toFixed(1)}px`);
    check("areaRatio sane", det.areaRatio > 0.3 && det.areaRatio < 0.9, `=${det.areaRatio.toFixed(3)}`);
    check("angle dev small", det.maxAngleDev < 12, `=${det.maxAngleDev.toFixed(1)}deg`);
    check("not touching border", det.touchesBorder === false);
  }
}

/* ---------------- case 2: card with interior content ---------------- */
{
  console.log("\ncase 2: card with simulated text/photo content");
  const truth = [[62, 38], [252, 56], [238, 202], [48, 186]];
  const img = blank();
  fill(img, truth, [236, 234, 228]);
  addContent(img, truth);
  const det = detectDocument(img);
  if (det?.failed) {
    check("detected despite content", false, `failed=${det.failed}`);
  } else {
    check("detected despite content", true);
    check("quad within 12px", maxCornerError(det.quad, truth) < 12, `err=${maxCornerError(det.quad, truth).toFixed(1)}px`);
  }
}

/* ---------------- case 3: card clipped by frame ---------------- */
{
  console.log("\ncase 3: card running off the frame");
  const truth = [[-20, 40], [250, 60], [240, 200], [-30, 180]];
  const img = blank();
  fill(img, truth, [236, 234, 228]);
  const det = detectDocument(img);
  check("detected", !!det && !det.failed, det?.failed ? `failed=${det.failed}` : "");
  if (det && !det.failed) {
    check("touchesBorder flag set", det.touchesBorder === true);
  }
}

/* ---------------- case 4: card too small for the area gate ---------------- */
{
  console.log("\ncase 4: small card (area gate)");
  const truth = [[140, 100], [180, 104], [176, 140], [136, 136]];
  const img = blank();
  fill(img, truth, [236, 234, 228]);
  const det = detectDocument(img);
  check("detected", !!det && !det.failed, det?.failed ? `failed=${det.failed}` : "");
  if (det && !det.failed) {
    check("areaRatio below default gate", det.areaRatio < DEFAULT_CONFIG.minAreaRatio, `=${det.areaRatio.toFixed(4)}`);
  }
}

/* ---------------- case 5: empty scene ---------------- */
{
  console.log("\ncase 5: empty scene");
  const img = blank();
  const det = detectDocument(img);
  check("no quad reported", !!det?.failed, det?.failed ? `failed=${det.failed}` : "unexpected quad");
}

/* ---------------- case 6: two cards, largest wins ---------------- */
{
  console.log("\ncase 6: two quads, larger one chosen");
  // Keep a wide gap: if the two outlines come within the dilation radius they
  // legitimately bridge into one component, which is not a detector bug.
  const big = [[30, 25], [170, 35], [165, 140], [25, 130]];
  const small = [[210, 150], [292, 155], [289, 215], [207, 210]];
  const img = blank();
  fill(img, small, [230, 230, 225]);
  fill(img, big, [236, 234, 228]);
  const det = detectDocument(img);
  check("detected", !!det && !det.failed, det?.failed ? `failed=${det.failed}` : "");
  if (det && !det.failed) {
    const errBig = maxCornerError(det.quad, big);
    const errSmall = maxCornerError(det.quad, small);
    check("picked the larger card", errBig < errSmall, `errBig=${errBig.toFixed(1)} errSmall=${errSmall.toFixed(1)}`);
    check("larger card located accurately", errBig < 15, `err=${errBig.toFixed(1)}px`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
