// Vercel serverless function: POST /api/capture
//
// Deliberately does NOT persist the image. Serverless filesystems are
// ephemeral, and an ID document is exactly the kind of payload you should not
// scatter across a deployment. This endpoint validates the upload and returns
// a receipt (digest + byte count) so the client can prove the round trip.
//
// Where to go next:
//   - OCR / field extraction  -> forward the buffer to your OCR service here
//   - durability              -> write to object storage (S3/R2/GCS) here
//   - audit                   -> emit the digest to your log/queue, not the image
// If you add any of those, revisit the retention and consent story first.

export const config = { api: { bodyParser: false } };

const MAX_UPLOAD = 12 * 1024 * 1024;

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("image/")) {
    return res.status(415).json({ error: "expected image/* body" });
  }

  let body;
  try {
    body = await readRaw(req);
  } catch (e) {
    return res.status(413).json({ error: e.message });
  }
  if (!body.length) return res.status(400).json({ error: "empty body" });

  const { createHash, randomUUID } = await import("node:crypto");
  const sha256 = createHash("sha256").update(body).digest("hex");

  let meta = null;
  const rawMeta = req.headers["x-capture-meta"];
  if (typeof rawMeta === "string") {
    try { meta = JSON.parse(decodeURIComponent(rawMeta)); } catch { meta = { parseError: true }; }
  }

  console.log(`[capture] ${(body.length / 1024).toFixed(0)}KB sha256=${sha256.slice(0, 12)}…`);

  return res.status(200).json({
    id: randomUUID().slice(0, 8),
    bytes: body.length,
    sha256,
    persisted: false,
    receivedAt: new Date().toISOString(),
    meta,
  });
}
