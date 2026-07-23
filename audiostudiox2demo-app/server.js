// Audio Studio X2 Demo — App Server
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
import http from "node:http";
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

// ffmpeg: compress to a compact 16k mono MP3 that fits UNDER the gateway's 32M
// upload cap. Uncompressed WAV (a 1h clip ≈ 115 MB) — and even a FIXED 64k mp3 of a
// multi-hour meeting (3h22m ≈ 97 MB) — trips a 413. So derive the bitrate from the
// clip duration so the output always lands safely under the cap. The engines
// downsample to 16k mono anyway, so this is the working resolution regardless.
const COMPRESS_TARGET_BYTES = 30 * 1024 * 1024; // aim comfortably below the 32M edge cap
function toMp3_16kMono(input, output) {
  const dur = probeDuration(input) || 0;
  let kbps = dur > 0 ? Math.floor((COMPRESS_TARGET_BYTES * 8) / dur / 1000) : 64;
  kbps = Math.max(16, Math.min(64, kbps)); // clamp to a speech-sane range
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", `${kbps}k`, "-f", "mp3", output]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error("ffmpeg failed: " + err.slice(-2000)))));
    ff.on("error", reject);
  });
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// ffmpeg silencedetect → voiced ("speech") runs. Pure DSP, no model. Lets whole-clip
// STT (used without VAD/Diarize) get a timeline for non-AI timestamp post-processing.
function detectSilences(file, durationSec, noise = "-30dB", d = 0.4) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-i", file, "-af", `silencedetect=noise=${noise}:d=${d}`, "-f", "null", "-"]);
    let err = "";
    ff.stderr.on("data", (x) => (err += x.toString()));
    ff.on("close", () => {
      const sil = [];
      let curStart = null;
      for (const ln of err.split("\n")) {
        const ms = ln.match(/silence_start:\s*(-?[0-9.]+)/);
        const me = ln.match(/silence_end:\s*([0-9.]+)/);
        if (ms) curStart = Math.max(0, parseFloat(ms[1]));
        else if (me && curStart != null) {
          sil.push({ start: round3(curStart), end: round3(parseFloat(me[1])) });
          curStart = null;
        }
      }
      const dur = durationSec || (sil.length ? sil[sil.length - 1].end : 0);
      if (curStart != null) sil.push({ start: round3(curStart), end: round3(dur || curStart) });
      // invert the silences into speech runs over [0, duration]
      const speech = [];
      let cursor = 0;
      for (const s of sil) {
        if (s.start > cursor + 0.05) speech.push({ start: round3(cursor), end: round3(s.start) });
        cursor = Math.max(cursor, s.end);
      }
      if (dur > cursor + 0.05) speech.push({ start: round3(cursor), end: round3(dur) });
      resolve({ duration: round3(dur), speech, silence: sil });
    });
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

// Voiced timeline (ffmpeg silencedetect) for non-AI STT timestamp post-processing.
app.get("/api/upload/:id/silences", async (req, res) => {
  const meta = uploads.get(req.params.id);
  if (!meta) return res.status(404).json({ error: "not found" });
  if (!hasFfmpeg()) return res.status(503).json({ error: "ffmpeg not available" });
  const noise = (req.query.noise || "-30dB").toString();
  const d = parseFloat(req.query.d) || 0.4;
  try {
    res.json(await detectSilences(meta.audioPath, meta.durationSec, noise, d));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
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
// The WebSocket data plane (mode=stt_stream, GET /v1/audio/stream) can't use the
// X-GW-* control headers the SPA sets on fetch() calls: a browser WebSocket API
// cannot set request headers. So for WS the SPA smuggles the gateway base/key/
// cookie as query params (__base/__key/__cookie); here we read them, inject the
// real Authorization/Cookie headers on the UPSTREAM handshake, and strip the
// control params from the forwarded URL. (Same reason the gateway WS auth is
// Bearer-header-only: the header is added server-side, here, not by the browser.)
function wsControl(req) {
  const u = new URL(req.url, "http://x");
  return {
    base: (u.searchParams.get("__base") || GATEWAY_URL || "").replace(/\/+$/, ""),
    key: u.searchParams.get("__key") || "",
    cookie: u.searchParams.get("__cookie") || "",
  };
}

const gwProxy = createProxyMiddleware({
    changeOrigin: true,
    secure: false,
    ws: true,
    // Long audio jobs (enhance/diarize on multi-minute clips) legitimately take a
    // while; don't let the proxy itself abort the upstream connection.
    proxyTimeout: 600000,
    timeout: 600000,
    router: (req) => {
      // WS upgrades carry the base in a query param (browser can't set headers);
      // HTTP requests carry it in X-GW-Base. Fall back to env for both.
      // req._wsctl is stashed at the raw 'upgrade' entry (before pathRewrite
      // strips the __* params), so prefer it for WS.
      const base =
        (req.headers["x-gw-base"] || "").toString().replace(/\/+$/, "") ||
        (req._wsctl && req._wsctl.base) ||
        wsControl(req).base;
      if (!base) throw new Error("no gateway base configured");
      return base;
    },
    pathRewrite: (pathAndQuery) => {
      // Strip our mount prefix and any WS control params, keep the rest (e.g. ?model=).
      let out = pathAndQuery.replace(/^\/api\/gw/, "");
      const qIdx = out.indexOf("?");
      if (qIdx >= 0) {
        const sp = new URLSearchParams(out.slice(qIdx + 1));
        sp.delete("__base");
        sp.delete("__key");
        sp.delete("__cookie");
        const rest = sp.toString();
        out = out.slice(0, qIdx) + (rest ? "?" + rest : "");
      }
      return out;
    },
    on: {
      // WS handshake: inject Bearer (data plane auth) + SSO cookie. Read from the
      // stash captured at the raw 'upgrade' entry — by the time this fires,
      // pathRewrite has already stripped the __* params off req.url.
      proxyReqWs: (proxyReq, req) => {
        const c = req._wsctl || wsControl(req);
        if (c.key) proxyReq.setHeader("authorization", "Bearer " + c.key);
        if (c.cookie) proxyReq.setHeader("cookie", c.cookie);
        console.log(`[gw-proxy-ws] upgrade -> ${c.base} (key=${c.key ? "yes" : "no"} cookie=${c.cookie ? "yes" : "no"})`);
      },
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
      error: (err, req, resOrSocket) => {
        const ms = req && req._t0 ? Date.now() - req._t0 : -1;
        // Log the hard signal: which path, which target, elapsed, error code.
        // Elapsed ~40s ≈ Olares public-edge cutting a long job (TCP RST seen as
        // "socket hang up"); elapsed ~0s ≈ connection refused/reset before TLS.
        console.error(
          `[gw-proxy-error] ${req?.method} ${req?.url} -> ${req?._target} after ${ms}ms` +
            ` code=${err?.code || "?"} msg=${String(err?.message || err)}`
        );
        // On a WS upgrade the third arg is a raw net.Socket (no writeHead/HTTP
        // status), so we can't send a JSON body — just tear the socket down and
        // let the browser see a failed handshake.
        if (resOrSocket && typeof resOrSocket.writeHead === "function") {
          if (!resOrSocket.headersSent) resOrSocket.writeHead(502, { "content-type": "application/json" });
          resOrSocket.end(JSON.stringify({ error: "gateway proxy error: " + String(err.message || err), code: err?.code, afterMs: ms }));
        } else if (resOrSocket && typeof resOrSocket.destroy === "function") {
          resOrSocket.destroy();
        }
      },
    },
  });

app.use("/api/gw", gwProxy);

// ---- static SPA ----
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get("*", (_req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));
} else {
  app.get("/", (_req, res) =>
    res.status(200).send("Audio Studio X2 Demo server up. SPA not built yet (web/dist missing).")
  );
}

// Explicit http.Server so we can attach the WS upgrade handler (app.listen would
// create the server for us but not wire 'upgrade' to the proxy).
const server = http.createServer(app);
// Capture the WS control params from the raw URL BEFORE http-proxy-middleware's
// pathRewrite strips them, so proxyReqWs can still inject the auth headers.
server.on("upgrade", (req, socket, head) => {
  try { req._wsctl = wsControl(req); } catch { /* ignore */ }
  gwProxy.upgrade(req, socket, head);
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[audiostudiox2demo] listening on :${PORT}  gateway=${GATEWAY_URL || "(set via UI)"}  ffmpeg=${hasFfmpeg()}`);
});
