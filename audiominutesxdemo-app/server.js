// Audio Minutes X Demo — App Server
//
// A Feishu-Minutes-style notes app. Unlike audiostudioxdemo (which orchestrates
// the gateway from the browser), here the SERVER runs the transcription pipeline
// asynchronously so progress survives page refreshes and results persist in a
// library on disk.
//
// Responsibilities:
//   1. Serve the built SPA (web/dist).
//   2. POST /api/upload  — accept audio/video; normalize to 16k mono wav (ffmpeg);
//      create a persistent record.
//   3. GET  /api/records[/:id]        — library list / one record (full transcript).
//   4. POST /api/records/:id/transcribe — start the async pipeline (diar -> stt ->
//      align -> fuse words<->speaker), updating progress on disk.
//   5. DELETE /api/records/:id        — remove a record + its media.
//   6. GET  /api/records/:id/{media,audio} — stream media/audio for playback.
//   7. GET/PUT /api/config            — LLM Gateway creds + chosen models (on disk).
//   8. GET  /api/models               — models available in the gateway, grouped by
//      mode, plus a readiness verdict for the required modes (stt/align/diar).
import express from "express";
import multer from "multer";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8080", 10);
const GATEWAY_URL = (process.env.GATEWAY_URL || "").replace(/\/+$/, "");
const GW_BFL_USER = process.env.GW_BFL_USER || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const LIBRARY_DIR = path.join(DATA_DIR, "library");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const STATIC_DIR = path.join(__dirname, "web", "dist");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

const round3 = (n) => Math.round(n * 1000) / 1000;
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Config (LLM Gateway creds + chosen models) — persisted at /data/config.json
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  base: GATEWAY_URL || "",
  key: "",
  cookie: "",
  bflUser: GW_BFL_USER || "",
  models: { stt: "", align: "", diar: "" },
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      models: { ...DEFAULT_CONFIG.models, ...(raw.models || {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models } };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function configReady(cfg) {
  const missing = [];
  if (!cfg.base) missing.push("网关地址");
  if (!cfg.key && !cfg.cookie) missing.push("网关鉴权(API Key 或 Cookie)");
  if (!cfg.models?.stt) missing.push("STT 模型");
  if (!cfg.models?.align) missing.push("Align 模型");
  if (!cfg.models?.diar) missing.push("Diarize 模型");
  return { ready: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Records store — one JSON file per record under /data/library
// ---------------------------------------------------------------------------
function recPath(id) {
  return path.join(LIBRARY_DIR, id + ".json");
}
function readRecord(id) {
  try {
    return JSON.parse(fs.readFileSync(recPath(id), "utf8"));
  } catch {
    return null;
  }
}
function writeRecord(rec) {
  rec.updatedAt = nowIso();
  fs.writeFileSync(recPath(rec.id), JSON.stringify(rec));
}
function listRecords() {
  let files = [];
  try {
    files = fs.readdirSync(LIBRARY_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  const out = [];
  for (const f of files) {
    const rec = readRecord(f.replace(/\.json$/, ""));
    if (rec) out.push(rec);
  }
  out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return out;
}
// List view is metadata only (never ships the full transcript).
function recordSummary(rec) {
  return {
    id: rec.id,
    title: rec.title,
    kind: rec.kind,
    originalName: rec.originalName,
    durationSec: rec.durationSec,
    status: rec.status,
    progress: rec.progress,
    phase: rec.phase,
    error: rec.error || "",
    createdAt: rec.createdAt,
    speakers: rec.result?.speakers?.length || 0,
    segments: rec.result?.segments?.length || 0,
  };
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------
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

function toWav16kMono(input, output) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", output]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error("ffmpeg failed: " + err.slice(-2000)))));
    ff.on("error", reject);
  });
}

// Cut [start, end] out of a wav into a fresh 16k mono wav slice.
function sliceWav(input, start, end, output) {
  const dur = Math.max(0.05, end - start);
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-i", input,
      "-ss", String(round3(start)), "-t", String(round3(dur)),
      "-ac", "1", "-ar", "16000", output,
    ]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error("ffmpeg slice failed: " + err.slice(-1500)))));
    ff.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// LLM Gateway calls (server-side; Bearer/Cookie from saved config)
// ---------------------------------------------------------------------------
function gwUrl(cfg, p) {
  return cfg.base.replace(/\/+$/, "") + p;
}
function gwHeaders(cfg, extra = {}) {
  const h = { ...extra };
  if (cfg.key) h["authorization"] = "Bearer " + cfg.key;
  if (cfg.cookie) h["cookie"] = cfg.cookie;
  if (cfg.bflUser) h["x-bfl-user"] = cfg.bflUser;
  return h;
}

async function gwAudioOp(cfg, op, wavPath, model, extra = {}) {
  const buf = fs.readFileSync(wavPath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  fd.append("model", model);
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  const r = await fetch(gwUrl(cfg, `/v1/audio/${op}`), { method: "POST", headers: gwHeaders(cfg), body: fd });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = text; }
  if (!r.ok) throw new Error(`${op} ${r.status}: ${String(text).slice(0, 300)}`);
  return j;
}

// ---------------------------------------------------------------------------
// GET /api/models — discover gateway models grouped by mode + readiness
// ---------------------------------------------------------------------------
app.get("/api/models", async (_req, res) => {
  const cfg = loadConfig();
  if (!cfg.base) return res.status(400).json({ error: "尚未配置网关地址", modes: {} });
  try {
    const r = await fetch(gwUrl(cfg, "/console/api/provider-models?limit=1000"), {
      method: "GET",
      headers: gwHeaders(cfg),
      redirect: "manual",
    });
    if (r.status === 0 || (r.status >= 301 && r.status <= 308)) {
      return res.status(401).json({ error: "网关未认证(被重定向到 SSO)。请检查 Cookie / API Key。", modes: {} });
    }
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok) return res.status(502).json({ error: `provider-models ${r.status}: ${String(text).slice(0, 200)}`, modes: {} });
    const arr = Array.isArray(body) ? body : body.items || body.data || body.models || [];
    const modes = {};
    for (const row of arr) {
      const m = row.model ?? row;
      const mode = m.mode ?? row.mode;
      if (!mode) continue;
      (modes[mode] = modes[mode] || []).push({
        id: m.id ?? row.provider_model_id,
        name: m.name ?? m.model ?? m.id,
        provider_name: row.provider_name ?? row.provider,
      });
    }
    res.json({ modes });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e), modes: {} });
  }
});

// ---------------------------------------------------------------------------
// GET/PUT /api/config
// ---------------------------------------------------------------------------
app.get("/api/config", (_req, res) => {
  const cfg = loadConfig();
  res.json({ ...cfg, ...configReady(cfg) });
});

app.put("/api/config", (req, res) => {
  const cur = loadConfig();
  const b = req.body || {};
  const next = {
    base: (b.base ?? cur.base ?? "").toString().replace(/\/+$/, ""),
    key: (b.key ?? cur.key ?? "").toString(),
    cookie: (b.cookie ?? cur.cookie ?? "").toString(),
    bflUser: (b.bflUser ?? cur.bflUser ?? "").toString(),
    models: {
      stt: (b.models?.stt ?? cur.models.stt ?? "").toString(),
      align: (b.models?.align ?? cur.models.align ?? "").toString(),
      diar: (b.models?.diar ?? cur.models.diar ?? "").toString(),
    },
  };
  saveConfig(next);
  res.json({ ...next, ...configReady(next) });
});

// ---------------------------------------------------------------------------
// Upload -> create record
// ---------------------------------------------------------------------------
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
  const originalName = Buffer.from(req.file.originalname || "", "latin1").toString("utf8");
  const isVideo = mime.startsWith("video/") || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(originalName);
  try {
    let audioPath = stored;
    if (isVideo || !mime.startsWith("audio/")) {
      if (!hasFfmpeg()) return res.status(503).json({ error: "ffmpeg not available; cannot extract audio" });
      audioPath = path.join(UPLOAD_DIR, id + ".wav");
      await toWav16kMono(stored, audioPath);
    }
    const title = originalName.replace(/\.[^.]+$/, "") || "未命名";
    const rec = {
      id,
      title,
      kind: isVideo ? "video" : "audio",
      originalName,
      mime,
      mediaPath: stored,
      audioPath,
      durationSec: probeDuration(audioPath),
      status: "uploaded",
      progress: 0,
      phase: "",
      error: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      result: null,
    };
    writeRecord(rec);
    res.json(recordSummary(rec));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Records CRUD
// ---------------------------------------------------------------------------
app.get("/api/records", (_req, res) => {
  res.json({ records: listRecords().map(recordSummary) });
});

app.get("/api/records/:id", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  res.json(rec);
});

app.delete("/api/records/:id", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  for (const p of [rec.mediaPath, rec.audioPath]) {
    if (p) fs.rm(p, { force: true }, () => {});
  }
  fs.rm(recPath(rec.id), { force: true }, () => {});
  res.json({ ok: true });
});

app.get("/api/records/:id/media", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec || !rec.mediaPath) return res.status(404).json({ error: "not found" });
  if (rec.mime) res.type(rec.mime);
  res.sendFile(path.resolve(rec.mediaPath));
});

app.get("/api/records/:id/audio", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec || !rec.audioPath) return res.status(404).json({ error: "not found" });
  res.sendFile(path.resolve(rec.audioPath));
});

// ---------------------------------------------------------------------------
// Transcribe pipeline (async) : diar -> per-window (stt + align) -> fuse
// ---------------------------------------------------------------------------
const running = new Set(); // record ids currently processing (in-process guard)

// Build STT/align windows from diarization: coalesce same-speaker turns, split
// long ones so each slice stays short enough for STT + forced alignment.
function buildWindows(diarSegs, duration) {
  const MAXWIN = 40, MERGE_GAP = 0.8, MINSEG = 0.2;
  let segs = (diarSegs || [])
    .map((s) => ({ start: +s.start, end: +s.end, speaker: String(s.speaker ?? "SPEAKER_00") }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (!segs.length) segs = [{ start: 0, end: Math.max(duration || 0, 0.1), speaker: "SPEAKER_00" }];
  const co = [];
  for (const s of segs) {
    const l = co[co.length - 1];
    if (l && l.speaker === s.speaker && s.start - l.end <= MERGE_GAP) l.end = Math.max(l.end, s.end);
    else co.push({ ...s });
  }
  const out = [];
  for (const s of co) {
    let a = s.start;
    while (s.end - a > MAXWIN + 5) {
      out.push({ start: a, end: a + MAXWIN, speaker: s.speaker });
      a += MAXWIN;
    }
    out.push({ start: a, end: s.end, speaker: s.speaker });
  }
  return out.filter((w) => w.end - w.start >= MINSEG);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function runJob(id) {
  if (running.has(id)) return;
  const rec = readRecord(id);
  if (!rec) return;
  const cfg = loadConfig();
  const { ready, missing } = configReady(cfg);
  if (!ready) {
    rec.status = "error";
    rec.error = "无法转录:缺少 " + missing.join("、");
    writeRecord(rec);
    return;
  }
  running.add(id);
  const setP = (progress, phase) => {
    const r = readRecord(id);
    if (!r) return;
    r.status = "processing";
    r.progress = progress;
    r.phase = phase;
    r.error = "";
    writeRecord(r);
  };
  const tmp = [];
  try {
    setP(3, "说话人分离");
    // 1) diarization over the whole clip
    const diar = await gwAudioOp(cfg, "diarization", rec.audioPath, cfg.models.diar);
    const diarSegs = Array.isArray(diar?.segments) ? diar.segments : [];

    // 2) windows
    const windows = buildWindows(diarSegs, rec.durationSec);
    setP(20, "转写与词级对齐");

    // 3) per window: slice -> STT (text) -> align (word times)
    let language = "";
    let done = 0;
    const segsOut = await mapLimit(windows, 2, async (w, idx) => {
      const slicePath = path.join(UPLOAD_DIR, `${id}-w${idx}.wav`);
      tmp.push(slicePath);
      await sliceWav(rec.audioPath, w.start, w.end, slicePath);

      // STT (plain text; word timing comes from align)
      let text = "";
      try {
        const stt = await gwAudioOp(cfg, "transcriptions", slicePath, cfg.models.stt, { response_format: "json" });
        text = (typeof stt === "string" ? stt : stt?.text ?? "").trim();
      } catch (e) {
        text = "";
      }

      let words = [];
      if (text) {
        try {
          const al = await gwAudioOp(cfg, "align", slicePath, cfg.models.align, { text });
          if (!language && al?.language) language = al.language;
          words = (Array.isArray(al?.units) ? al.units : []).map((u) => ({
            text: u.text ?? u.word ?? u.token ?? "",
            start: round3((Number(u.start ?? u.start_time ?? 0)) + w.start),
            end: round3((Number(u.end ?? u.end_time ?? 0)) + w.start),
          }));
        } catch (e) {
          words = [];
        }
      }
      done++;
      setP(20 + Math.round((70 * done) / windows.length), "转写与词级对齐");
      return { start: round3(w.start), end: round3(w.end), speaker: w.speaker, text, words };
    });

    setP(94, "整理结果");
    const segments = segsOut
      .filter((s) => s.text || (s.words && s.words.length))
      .sort((a, b) => a.start - b.start);
    const speakers = Array.from(new Set(segments.map((s) => s.speaker)));

    const out = readRecord(id);
    out.result = { language: language || "", speakers, segments };
    out.status = "done";
    out.progress = 100;
    out.phase = "";
    out.error = "";
    writeRecord(out);
  } catch (e) {
    const out = readRecord(id) || rec;
    out.status = "error";
    out.error = String(e.message || e);
    writeRecord(out);
  } finally {
    running.delete(id);
    for (const t of tmp) fs.rm(t, { force: true }, () => {});
  }
}

app.post("/api/records/:id/transcribe", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  const cfg = loadConfig();
  const { ready, missing } = configReady(cfg);
  if (!ready) return res.status(400).json({ error: "无法转录:缺少 " + missing.join("、"), missing });
  if (running.has(rec.id)) return res.json({ ok: true, alreadyRunning: true });
  rec.status = "processing";
  rec.progress = 1;
  rec.phase = "排队中";
  rec.error = "";
  writeRecord(rec);
  runJob(rec.id); // fire and forget
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Health + static SPA
// ---------------------------------------------------------------------------
app.get("/healthz", (_req, res) => res.json({ status: "ok", ffmpeg: hasFfmpeg() }));

if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get("*", (_req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));
} else {
  app.get("/", (_req, res) =>
    res.status(200).send("Audio Minutes X Demo server up. SPA not built yet (web/dist missing).")
  );
}

// On boot, any record left mid-flight from a previous process is marked failed so
// the UI never shows a stuck "处理中" that will never advance.
for (const rec of listRecords()) {
  if (rec.status === "processing") {
    rec.status = "error";
    rec.error = "处理中断(服务重启),请重试";
    writeRecord(rec);
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[audiominutesxdemo] listening on :${PORT}  ffmpeg=${hasFfmpeg()}  data=${DATA_DIR}`);
});
