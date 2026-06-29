// Audio Studio X Demo — App Server
// Responsibilities (kept deliberately small):
//   1. Serve the built SPA (web/dist).
//   2. POST /api/upload — accept audio/video; for video, extract a 16k mono
//      wav via ffmpeg. Return an upload id the SPA reuses for every capability.
//   3. GET  /api/upload/:id/audio — stream the normalized audio for playback.
//   4. /api/gw/* — reverse-proxy to the LLM Gateway. Data plane (/v1/*) gets a
//      Bearer key injected; console (/console/*) forwards the browser's Olares
//      SSO cookie. The Gateway base + key + (optional) bfl-user come from
//      per-request headers set by the SPA, falling back to env.
import express from "express";
import multer from "multer";
import { createProxyMiddleware } from "http-proxy-middleware";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8080", 10);
// Default Gateway base; the SPA can override per-request via X-GW-Base.
const GATEWAY_URL = (process.env.GATEWAY_URL || "").replace(/\/+$/, "");
// Optional fallback identity for in-cluster (edge-bypass) console calls.
const GW_BFL_USER = process.env.GW_BFL_USER || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const STATIC_DIR = path.join(__dirname, "web", "dist");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");

// ---- upload metadata (in-memory; demo scope) ----
const uploads = new Map(); // id -> { id, kind, originalName, audioPath, durationSec }

function hasFfmpeg() {
  try {
    return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function probeDuration(file) {
  try {
    const r = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { encoding: "utf8" }
    );
    const d = parseFloat((r.stdout || "").trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

// ffmpeg: extract/normalize to 16k mono wav (what the audio engines expect).
function toWav16kMono(input, output) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", output]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error("ffmpeg failed: " + err.slice(-2000)))
    );
    ff.on("error", reject);
  });
}

// ffmpeg: compress to 16k mono MP3. Uncompressed WAV blows past the Olares edge's
// request-body limit (a 1h clip ≈ 115 MB → 413). The audio engines downsample to
// 16k mono anyway, so 64 kbps MP3 is the working resolution at a fraction of the size.
function toMp3_16kMono(input, output) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-f", "mp3", output]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error("ffmpeg failed: " + err.slice(-2000)))));
    ff.on("error", reject);
  });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname || "")),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GiB
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file" });
  const id = randomUUID();
  const stored = req.file.path;
  const mime = req.file.mimetype || "";
  // multer decodes the multipart filename as latin1; re-decode as UTF-8 so
  // non-ASCII (e.g. Chinese) names are preserved.
  const originalName = Buffer.from(req.file.originalname || "", "latin1").toString("utf8");
  const isVideo = mime.startsWith("video/") || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(originalName);

  try {
    let audioPath = stored;
    if (isVideo || mime.startsWith("audio/") === false) {
      // Non-audio (video or unknown) → extract wav. Audio passes through.
      if (!hasFfmpeg()) {
        return res.status(503).json({ error: "ffmpeg not available; cannot extract audio from video" });
      }
      audioPath = path.join(UPLOAD_DIR, id + ".wav");
      await toWav16kMono(stored, audioPath);
    }
    const meta = {
      id,
      kind: isVideo ? "video" : "audio",
      originalName,
      mediaPath: stored, // original upload, served for in-browser preview
      mime,
      audioPath,
      durationSec: probeDuration(audioPath),
    };
    uploads.set(id, meta);
    res.json({ id: meta.id, kind: meta.kind, originalName: meta.originalName, durationSec: meta.durationSec });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/upload/:id/audio", (req, res) => {
  const meta = uploads.get(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  res.sendFile(path.resolve(meta.audioPath));
});

// Original uploaded media (for in-browser preview of audio/video). sendFile
// honours Range requests, so video seeking works.
app.get("/api/upload/:id/media", (req, res) => {
  const meta = uploads.get(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  if (meta.mime) res.type(meta.mime);
  res.sendFile(path.resolve(meta.mediaPath));
});

// Transcode an arbitrary audio blob to 16k mono MP3 so large WAV payloads (enhanced
// output, long diarization chunks) stay under the Olares edge's request-body limit.
// The SPA POSTs raw audio bytes; we write a temp file, run ffmpeg, return audio/mpeg.
app.post("/api/transcode", express.raw({ type: "*/*", limit: "1024mb" }), async (req, res) => {
  if (!hasFfmpeg()) return res.status(503).json({ error: "ffmpeg not available" });
  if (!req.body || !req.body.length) return res.status(400).json({ error: "empty body" });
  const inPath = path.join(UPLOAD_DIR, "tx-" + randomUUID());
  const outPath = inPath + ".mp3";
  try {
    fs.writeFileSync(inPath, req.body);
    await toMp3_16kMono(inPath, outPath);
    const buf = fs.readFileSync(outPath);
    res.type("audio/mpeg").send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    fs.rm(inPath, { force: true }, () => {});
    fs.rm(outPath, { force: true }, () => {});
  }
});

// Health for k8s probes.
app.get("/healthz", (_req, res) => res.json({ status: "ok", ffmpeg: hasFfmpeg(), gateway: GATEWAY_URL || null }));

// ---- Gateway reverse proxy ----
// SPA calls /api/gw/<console|v1>/... and sets:
//   X-GW-Base   : gateway base URL (overrides env GATEWAY_URL)
//   X-GW-Key    : data-plane API key (injected as Bearer for /v1/*)
//   X-GW-BflUser: optional console identity (edge-bypass fallback)
app.use(
  "/api/gw",
  createProxyMiddleware({
    changeOrigin: true,
    secure: false,
    // Long audio jobs (enhance/diarize on multi-minute clips) legitimately take a
    // while; don't let the proxy itself abort the upstream connection.
    proxyTimeout: 600000,
    timeout: 600000,
    router: (req) => {
      const base = (req.headers["x-gw-base"] || GATEWAY_URL || "").toString().replace(/\/+$/, "");
      if (!base) throw new Error("no gateway base configured");
      return base;
    },
    pathRewrite: { "^/api/gw": "" },
    on: {
      proxyReq: (proxyReq, req) => {
        req._t0 = Date.now();
        req._target = (req.headers["x-gw-base"] || GATEWAY_URL || "").toString().replace(/\/+$/, "");
        const isDataPlane = req.url.startsWith("/v1/");
        // Forward an explicit Olares SSO cookie if the SPA supplied one
        // (local-debug: lets a Mac browser reach the gateway's SSO entrance).
        const cookie = (req.headers["x-gw-cookie"] || "").toString();
        if (cookie) proxyReq.setHeader("cookie", cookie);
        if (isDataPlane) {
          const key = (req.headers["x-gw-key"] || "").toString();
          if (key) proxyReq.setHeader("authorization", "Bearer " + key);
        } else {
          // console: rely on forwarded Olares SSO cookie (edge injects X-BFL-USER).
          const bfl = (req.headers["x-gw-bfluser"] || GW_BFL_USER || "").toString();
          if (bfl) proxyReq.setHeader("x-bfl-user", bfl);
        }
        // strip our control headers so they never leak upstream
        proxyReq.removeHeader("x-gw-base");
        proxyReq.removeHeader("x-gw-key");
        proxyReq.removeHeader("x-gw-bfluser");
        proxyReq.removeHeader("x-gw-cookie");
      },
      proxyRes: (proxyRes, req) => {
        const ms = req._t0 ? Date.now() - req._t0 : -1;
        console.log(`[gw-proxy] ${req.method} ${req.url} -> ${req._target} ${proxyRes.statusCode} ${ms}ms`);
      },
      error: (err, req, res) => {
        const ms = req && req._t0 ? Date.now() - req._t0 : -1;
        // Log the hard signal: which path, which target, elapsed, error code.
        // Elapsed ~40s ≈ Olares public-edge cutting a long job (TCP RST seen as
        // "socket hang up"); elapsed ~0s ≈ connection refused/reset before TLS.
        console.error(
          `[gw-proxy-error] ${req?.method} ${req?.url} -> ${req?._target} after ${ms}ms` +
            ` code=${err?.code || "?"} msg=${String(err?.message || err)}`
        );
        if (res && !res.headersSent && res.writeHead) {
          res.writeHead(502, { "content-type": "application/json" });
        }
        if (res && res.end)
          res.end(JSON.stringify({ error: "gateway proxy error: " + String(err.message || err), code: err?.code, afterMs: ms }));
      },
    },
  })
);

// ---- static SPA ----
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get("*", (_req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));
} else {
  app.get("/", (_req, res) =>
    res.status(200).send("Audio Studio X Demo server up. SPA not built yet (web/dist missing).")
  );
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[audiostudioxdemo] listening on :${PORT}  gateway=${GATEWAY_URL || "(set via UI)"}  ffmpeg=${hasFfmpeg()}`);
});
