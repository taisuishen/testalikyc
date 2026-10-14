// server.mjs — HTTPS static host + capture endpoint.
//
// TLS is not optional here: browsers only expose getUserMedia in a secure
// context, and http://<lan-ip>:port is not one. A self-signed certificate with
// the LAN addresses in subjectAltName makes the page work over the network.
//
// Run: node server.mjs [--port 8443] [--bind 0.0.0.0]

import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname);
const CERT_DIR = join(ROOT, "certs");
const CAPTURE_DIR = join(ROOT, "captures");
const DEBUG_DIR = join(ROOT, "debug");

// Explicit allowlist rather than serving the project root: the root also holds
// server.mjs, package.json and certs/, none of which should be reachable.
const STATIC_FILES = new Set([
  "index.html", "app.js", "detect.js", "geometry.js", "style.css",
]);

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PORT = Number(argOf("port", 8443));
const BIND = argOf("bind", "0.0.0.0");
const MAX_UPLOAD = 12 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

/* ------------------------------------------------------------------ */
/* certificate                                                         */
/* ------------------------------------------------------------------ */

function localAddresses() {
  const out = ["127.0.0.1"];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return [...new Set(out)];
}

function ensureCert() {
  mkdirSync(CERT_DIR, { recursive: true });
  const keyPath = join(CERT_DIR, "key.pem");
  const certPath = join(CERT_DIR, "cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath), reused: true };
  }

  const ips = localAddresses();
  const san = [...ips.map((ip) => `IP:${ip}`), "DNS:localhost"].join(",");
  const cnf = join(CERT_DIR, "openssl.cnf");
  writeFileSync(cnf, [
    "[req]",
    "distinguished_name=dn",
    "x509_extensions=v3",
    "prompt=no",
    "[dn]",
    "CN=docscan-local",
    "[v3]",
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=${san}`,
    "",
  ].join("\n"));

  console.log(`[cert] issuing self-signed cert for: ${ips.join(", ")}`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "825", "-config", cnf,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  return { key: readFileSync(keyPath), cert: readFileSync(certPath), reused: false };
}

/* ------------------------------------------------------------------ */
/* static files                                                        */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "https://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  const name = urlPath.replace(/^\/+/, "");

  if (!STATIC_FILES.has(name)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  const target = join(ROOT, name);
  try {
    if (!statSync(target).isFile()) throw new Error("not a file");
    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
  }
}

/* ------------------------------------------------------------------ */
/* capture endpoint                                                    */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleCapture(req, res) {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("image/")) {
    res.writeHead(415, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "expected image/* body" }));
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }
  if (!body.length) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "empty body" }));
    return;
  }

  const sha256 = createHash("sha256").update(body).digest("hex");
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  mkdirSync(CAPTURE_DIR, { recursive: true });

  const ext = type === "image/png" ? "png" : "jpg";
  writeFileSync(join(CAPTURE_DIR, `${id}.${ext}`), body);

  let meta = null;
  const rawMeta = req.headers["x-capture-meta"];
  if (typeof rawMeta === "string") {
    try { meta = JSON.parse(decodeURIComponent(rawMeta)); } catch { meta = { parseError: true }; }
  }
  writeFileSync(join(CAPTURE_DIR, `${id}.json`), JSON.stringify(
    { id, sha256, bytes: body.length, contentType: type, receivedAt: new Date().toISOString(), meta },
    null, 2,
  ));

  console.log(`[capture] ${id} ${(body.length / 1024).toFixed(0)}KB sha256=${sha256.slice(0, 12)}…`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id, bytes: body.length, sha256 }));
}

/* ------------------------------------------------------------------ */

const { key, cert, reused } = ensureCert();

/**
 * One line per request, including the peer address.
 *
 * This exists because "the phone cannot load it" has two very different causes
 * that look identical from the browser: the request never arrives (routing or
 * AP client isolation) versus it arrives and something fails (cert, app error).
 * Without a peer-address log there is no way to tell them apart.
 *
 * The UA is logged too: a request from a phone is the proof that the LAN path
 * works, independent of whether the page then rendered.
 */
function logRequest(req, res, pathname) {
  const peer = (req.socket.remoteAddress ?? "?").replace(/^::ffff:/, "");
  const ua = (req.headers["user-agent"] ?? "").slice(0, 60);
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(
      `[req] ${new Date().toISOString().slice(11, 19)} ${peer} ${req.method} ${pathname} ` +
      `-> ${res.statusCode} ${ms}ms${ua ? `  ${ua}` : ""}`,
    );
  });
}

/**
 * POST /api/debug — real-device capture for offline tuning.
 *
 * Two request shapes:
 *   image/jpeg + X-Debug-Meta header -> store the detection-resolution frame
 *     and append its metadata. This is the exact frame the detector saw, so a
 *     collected sample can be replayed through detectDocument() offline and
 *     reproduce the failure deterministically.
 *   application/json -> metadata-only sample (no frame).
 *
 * Frames are written under debug/frames with a JSONL index in debug/log.jsonl.
 * Neither is committed (see .gitignore) — these are real identity documents,
 * so treat the directory as sensitive and delete it when tuning is done.
 */
async function handleDebug(req, res) {
  const type = req.headers["content-type"] ?? "";
  let meta = {};
  const rawMeta = req.headers["x-debug-meta"];
  if (typeof rawMeta === "string") {
    try { meta = JSON.parse(decodeURIComponent(rawMeta)); } catch { meta = { parseError: true }; }
  }

  mkdirSync(join(DEBUG_DIR, "frames"), { recursive: true });
  const id = `${Date.now()}_${randomUUID().slice(0, 6)}`;
  const record = { id, receivedAt: new Date().toISOString(), ...meta };

  try {
    if (type.startsWith("image/")) {
      const body = await readBody(req);
      record.bytes = body.length;
      record.frameSha256 = createHash("sha256").update(body).digest("hex").slice(0, 16);
      const frameName = `${id}.jpg`;
      writeFileSync(join(DEBUG_DIR, "frames", frameName), body);
      record.frame = `frames/${frameName}`;
    } else if (type.startsWith("application/json")) {
      const body = await readBody(req);
      Object.assign(record, JSON.parse(body.toString("utf8")));
    } else {
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "expected image/* or application/json" }));
      return;
    }
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }

  appendFileSync(join(DEBUG_DIR, "log.jsonl"), JSON.stringify(record) + "\n");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id, stored: true }));
}

const handler = (req, res) => {
  const { pathname } = new URL(req.url, "https://x");
  logRequest(req, res, pathname);
  if (pathname === "/api/debug" && req.method === "POST") return handleDebug(req, res);
  if (pathname === "/api/capture" && req.method === "POST") return handleCapture(req, res);
  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end("method not allowed");
    return;
  }
  return serveStatic(req, res);
};

const httpsServer = createHttpsServer({ key, cert }, handler);

// A TLS failure means the TCP connection DID arrive but the handshake died —
// typically an old client rejecting the self-signed cert. That is a different
// fix from "nothing arrived at all", so it must be visible.
httpsServer.on("tlsClientError", (err, socket) => {
  const peer = (socket?.remoteAddress ?? "?").replace(/^::ffff:/, "");
  console.log(`[tls]  ${peer} handshake failed: ${err.code ?? err.message}`);
});

httpsServer.listen(PORT, BIND, () => {
  const addrs = localAddresses().filter((a) => a !== "127.0.0.1");
  console.log(`\n  docscan (HTTPS)  ${reused ? "reusing" : "issued"} cert`);
  console.log(`  local   https://localhost:${PORT}`);
  for (const a of addrs) console.log(`  LAN     https://${a}:${PORT}`);
  console.log(`\n  手机需在同一局域网；证书是自签的，浏览器会警告，选择"继续访问"即可。`);
  console.log(`  摄像头只在安全上下文可用 —— 必须走 https，不能用 http。`);
  console.log(`\n  每个请求都会打印来源 IP。手机打开页面时这里应该出现一行 [req]：`);
  console.log(`    - 没有 [req] 行  → 网络层不通（不同子网 / AP 客户端隔离）`);
  console.log(`    - 有 [tls] 报错   → 连上了但证书被拒`);
  console.log(`    - 有 [req] 200    → 局域网没问题，问题在页面本身\n`);
});

// Plain HTTP companion: typing the bare ip:port still lands somewhere useful.
createHttpServer((req, res) => {
  const host = (req.headers.host ?? "").split(":")[0];
  res.writeHead(302, { Location: `https://${host}:${PORT}${req.url}` });
  res.end();
}).listen(PORT + 1, BIND, () => {
  console.log(`  HTTP → HTTPS redirect on ${BIND}:${PORT + 1}\n`);
});
