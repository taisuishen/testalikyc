// tools/analyze-debug.mjs — replay collected real-device samples offline.
//
// Reads debug/log.jsonl + debug/frames/*.jpg written by the phone, re-runs the
// detector on the exact frame the device saw, and reports where and why
// detection fails. This is what turns "it doesn't work on my phone" into a
// reproducible case with real numbers.
//
// Run: node tools/analyze-debug.mjs [--limit N] [--dump N] [--write-frames]

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { detectDocument, DEFAULT_CONFIG, toGray } from "../detect.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEBUG_DIR = join(ROOT, "debug");
const LOG = join(DEBUG_DIR, "log.jsonl");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? Number(process.argv[i + 1])
    : dflt;
};
const LIMIT = arg("limit", 0);
const DUMP = arg("dump", 0);
const WRITE_FRAMES = process.argv.includes("--write-frames");

if (!existsSync(LOG)) {
  console.log(`没有找到 ${LOG}`);
  console.log("先在手机上打开页面 → 点右上角「采集样本」→ 对着证件移动几秒，然后再跑这个脚本。");
  process.exit(0);
}

const records = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

console.log(`读到 ${records.length} 条样本\n`);

/* ---------------- replay ---------------- */

const failReasons = new Map();
const gateFails = new Map();
const aspectSamples = [];
const replayMismatch = [];
let withFrame = 0, detected = 0, passed = 0;

for (const rec of records) {
  if (rec.failed) failReasons.set(rec.failed, (failReasons.get(rec.failed) ?? 0) + 1);
  if (rec.gates) {
    for (const [k, ok] of Object.entries(rec.gates)) {
      if (ok === false) gateFails.set(k, (gateFails.get(k) ?? 0) + 1);
    }
    if (rec.gates.allGatesPass) passed++;
  }
  if (rec.detected) {
    detected++;
    if (typeof rec.detected.aspect === "number") aspectSamples.push(rec.detected.aspect);
  }

  if (!rec.frame) continue;
  const framePath = join(DEBUG_DIR, rec.frame);
  if (!existsSync(framePath)) continue;
  withFrame++;

  const raw = jpeg.decode(readFileSync(framePath), { useTArray: true });
  const img = { data: raw.data, width: raw.width, height: raw.height };
  const cfg = { ...DEFAULT_CONFIG, ...(rec.config ?? {}) };
  const guide = rec.guideDet ?? null;
  const off = detectDocument(img, cfg, guide);

  // Replay fidelity: the offline run must reproduce what the device reported,
  // otherwise the frame/metadata pair is not a trustworthy record.
  const devFailed = rec.failed ?? null;
  const offFailed = off?.failed ?? null;
  const sameFailure = devFailed === offFailed;
  const bothOk = !devFailed && !offFailed;
  if (!sameFailure && !bothOk) {
    replayMismatch.push({ id: rec.id, device: devFailed, offline: offFailed });
  }

  if (WRITE_FRAMES) {
    const out = join(DEBUG_DIR, "gray");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${rec.id}.gray`), Buffer.from(toGray(img.data, img.width, img.height)));
  }
}

/* ---------------- report ---------------- */

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");

console.log(`带帧样本:   ${withFrame}/${records.length}`);
console.log(`检出证件:   ${detected}/${records.length}  (${pct(detected, records.length)})`);
console.log(`全门通过:   ${passed}/${records.length}  (${pct(passed, records.length)})`);
if (withFrame) console.log(`离线复现不一致: ${replayMismatch.length}/${withFrame}`);
console.log();

const show = (title, map) => {
  if (!map.size) return;
  console.log(title);
  for (const [k, v] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${String(v).padStart(4)}  ${pct(v, records.length)}`);
  }
  console.log();
};
show("失败原因分布:", failReasons);
show("门控失败分布:", gateFails);

if (aspectSamples.length) {
  aspectSamples.sort((a, b) => a - b);
  const q = (p) => aspectSamples[Math.min(aspectSamples.length - 1, Math.floor(p * aspectSamples.length))];
  console.log("检出长宽比分布 (目标 " + (records[0]?.config?.guideAspect ?? 1.585) + "):");
  console.log(`  min ${aspectSamples[0].toFixed(2)}  p25 ${q(0.25).toFixed(2)}  median ${q(0.5).toFixed(2)}  p75 ${q(0.75).toFixed(2)}  max ${aspectSamples.at(-1).toFixed(2)}`);
  console.log(`  -> 中位数离目标 ${(Math.abs(q(0.5) - (records[0]?.config?.guideAspect ?? 1.585))).toFixed(3)}`);
  console.log();
}

if (replayMismatch.length) {
  console.log("离线复现不一致的样本（帧与元数据不匹配，或版本不同）:");
  for (const m of replayMismatch.slice(0, 10)) {
    console.log(`  ${m.id}  设备=${m.device}  离线=${m.offline}`);
  }
  console.log();
}

if (DUMP) {
  console.log(`最近 ${DUMP} 条明细:`);
  for (const rec of records.slice(-DUMP)) {
    const d = rec.detected;
    console.log(
      `  ${rec.id}  det ${rec.detMs ?? "?"}ms  ` +
      (d ? `fill ${d.areaRatio} ar ${d.aspect} ang ${d.maxAngleDev} border ${d.touchesBorder}` : `FAILED ${rec.failed}`) +
      `  reasons=[${(rec.reasons ?? []).join(",")}]`,
    );
  }
}
