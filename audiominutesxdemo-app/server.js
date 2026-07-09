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
import { setGlobalDispatcher, Agent } from "undici";

// Node's global fetch (undici) defaults to a 5-minute headers/body timeout. A
// whole-clip STT / enhance on an hour-long file can take longer than that to
// return, which would abort the 整段转写 path and force the per-window fallback
// (the browser DEMO has no such limit, so it "just worked" there). Disable the
// idle/response timeouts so long single calls complete; keep a sane connect cap.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8080", 10);
const GATEWAY_URL = (process.env.GATEWAY_URL || "").replace(/\/+$/, "");
const GW_BFL_USER = process.env.GW_BFL_USER || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const LIBRARY_DIR = path.join(DATA_DIR, "library");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const BACKGROUND_PATH = path.join(DATA_DIR, "background.bin");
const COVERS_DIR = path.join(DATA_DIR, "covers");
const STATIC_DIR = path.join(__dirname, "web", "dist");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_DIR, { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");
// 12mb so a captured video-frame cover (base64 JPEG) fits in the JSON body.
app.use(express.json({ limit: "12mb" }));

const round3 = (n) => Math.round(n * 1000) / 1000;
const nowIso = () => new Date().toISOString();

// Normalize ASCII punctuation to full-width Chinese punctuation in a translated
// string. Only converts a mark when it sits next to a CJK character (prev/next
// non-space), so decimals ("3.14"), URLs and embedded English fragments keep their
// half-width punctuation. Straight double quotes around CJK are converted to the
// curly pair “…” by alternating open/close.
const CJK_RE = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7A3]/;
function toChinesePunct(s) {
  if (!s) return s;
  const map = { ",": "，", ".": "。", "!": "！", "?": "？", ":": "：", ";": "；", "(": "（", ")": "）" };
  const chars = Array.from(s);
  const isCJK = (c) => !!c && CJK_RE.test(c);
  let quoteOpen = true;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    let p = i - 1; while (p >= 0 && /\s/.test(chars[p])) p--;
    let n = i + 1; while (n < chars.length && /\s/.test(chars[n])) n++;
    const prev = chars[p], next = chars[n];
    const nearCJK = isCJK(prev) || isCJK(next);
    if (map[c] && nearCJK) {
      chars[i] = map[c];
    } else if (c === '"' && nearCJK) {
      chars[i] = quoteOpen ? "\u201C" : "\u201D";
      quoteOpen = !quoteOpen;
    }
  }
  return chars.join("");
}

// Split `text` into `n` proportional parts, snapping each cut to a nearby sentence
// end so a window's aligned text never begins/ends mid-sentence. Joining the parts
// with "" reproduces the input exactly. Ported from audiostudioxdemo so long-audio
// forced alignment can be chunked (each align call only sees its own audio's text).
function splitTextN(text, n) {
  if (n <= 1 || !text) return [text];
  const len = text.length;
  const parts = [];
  let start = 0;
  for (let i = 1; i < n; i++) {
    const target = Math.round((len * i) / n);
    const reach = Math.max(8, Math.round(len * 0.15));
    let cut = -1;
    for (let j = target; j < Math.min(len, target + reach); j++) {
      if (/[。！？!?.]/.test(text[j])) { cut = j + 1; break; }
    }
    if (cut < 0) for (let j = target; j > Math.max(start + 1, target - reach); j--) {
      if (/[。！？!?.]/.test(text[j])) { cut = j + 1; break; }
    }
    if (cut < 0 || cut <= start) cut = Math.max(start + 1, target);
    parts.push(text.slice(start, cut));
    start = cut;
  }
  parts.push(text.slice(start));
  return parts;
}

// ---------------------------------------------------------------------------
// Config (LLM Gateway creds + chosen models) — persisted at /data/config.json
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  base: GATEWAY_URL || "",
  key: "",
  cookie: "",
  bflUser: GW_BFL_USER || "",
  models: { stt: "", align: "", diar: "" },
  // DEFAULTS for NEW files (each record snapshots these into record.options at
  // upload; per-file overrides win at (re)transcribe time):
  //   segmentedStt false = 整段转写 (one whole-clip STT); true = 分段转写 (STT per
  //   diarization window).
  segmentedStt: false,
  //   language "auto" = detect per slice from the STT text; a code (zh/en/ja/ko/…)
  //   forces that language for forced alignment.
  language: "auto",
  // Upload → auto-start transcription with the defaults above. Off = uploads only
  // land in the library as 待转录; the user picks per-file options then transcribes.
  autoTranscribe: true,
  // Translation (global). Off by default; only takes effect when enabled AND a
  // translate-mode model is chosen.
  //   sourceLang "auto" = detect the source per segment; or a fixed FLORES code.
  //   targetLang "auto" = smart zh<->en (Chinese → English, everything else →
  //     Chinese); or an explicit FLORES code (zho_Hans/eng_Latn/…).
  // Segments whose (resolved) source == target are skipped.
  translate: { enabled: false, model: "", sourceLang: "auto", targetLang: "auto" },
  // Speech enhancement / denoise (global). Off by default; when enabled AND a
  // enhance-mode model is chosen, the clip is denoised BEFORE diar/STT/align. The
  // denoiser strips non-speech, so it hurts music-heavy clips (see UI hint).
  enhance: { enabled: false, model: "" },
  // Cosmetic background image (uploaded separately to /api/background). `enabled`
  // shows it behind the UI; `dim` (0..80) darkens it for text legibility; `mime`
  // is remembered so GET /api/background can serve it with the right type.
  background: { enabled: false, dim: 40, mime: "" },
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      models: { ...DEFAULT_CONFIG.models, ...(raw.models || {}) },
      translate: { ...DEFAULT_CONFIG.translate, ...(raw.translate || {}) },
      enhance: { ...DEFAULT_CONFIG.enhance, ...(raw.enhance || {}) },
      background: { ...DEFAULT_CONFIG.background, ...(raw.background || {}) },
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
function coverPath(id) {
  return path.join(COVERS_DIR, id + ".jpg");
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
// Append a user-visible processing event/notice to a record (persisted so the UI
// can show WHAT happened — denoise fell back, alignment auto-split, a step failed —
// instead of a black box). Always re-reads the fresh record so it doesn't clobber
// progress written concurrently by setP. level: "info" | "warn" | "error".
function addNotice(id, level, msg) {
  const r = readRecord(id);
  if (!r) return;
  r.notices = Array.isArray(r.notices) ? r.notices : [];
  r.notices.push({ at: nowIso(), level, msg });
  if (r.notices.length > 60) r.notices = r.notices.slice(-60);
  writeRecord(r);
  const tag = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
  console.log(`[${id}] (${tag}) ${msg}`);
}
// Human-friendly duration (Chinese) for processing-time notices.
function fmtMs(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m} 分 ${r} 秒`;
}
// A tiny sequential stopwatch for the transcription pipeline. begin(name) closes
// the current step and opens a new one; durations for the SAME name accumulate
// (so a step visited twice — e.g. 整理结果 — shows one summed entry). finish()
// returns { steps:[{name,ms}], totalMs }.
function makeTimer() {
  const steps = [];
  const start0 = Date.now();
  let curName = null, curStart = 0;
  const close = () => {
    if (curName == null) return;
    const ms = Date.now() - curStart;
    const ex = steps.find((s) => s.name === curName);
    if (ex) ex.ms += ms; else steps.push({ name: curName, ms });
    curName = null;
  };
  return {
    begin(name) { close(); curName = name; curStart = Date.now(); },
    finish() { close(); return { steps, totalMs: Date.now() - start0 }; },
  };
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
    stepDone: rec.stepDone || 0,
    stepTotal: rec.stepTotal || 0,
    startedAt: rec.startedAt || "",
    error: rec.error || "",
    createdAt: rec.createdAt,
    speakers: rec.result?.speakers?.length || 0,
    segments: rec.result?.segments?.length || 0,
    options: rec.options || { language: "auto", segmentedStt: false, translate: false, enhance: false },
    translated: !!(rec.result?.segments || []).some((s) => s.translation),
    jobKind: rec.jobKind || "full",
    notices: Array.isArray(rec.notices) ? rec.notices : [],
    hasCover: !!rec.cover,
    coverVer: rec.cover?.at || "",
    totalMs: rec.timings?.totalMs ?? null,
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

// Transcode any audio to a compact mono 16k mp3. The speech-enhancement endpoint
// returns an uncompressed WAV (~32KB/s → >100MB for an hour), which then gets
// rejected by the gateway's upload limit (413) on the whole-clip diarization/STT
// calls. Re-encoding to mp3 keeps those uploads small while preserving the
// enhanced audio for downstream steps (per-window align re-slices to WAV anyway).
function transcodeMp3(input, output) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-i", input,
      "-ac", "1", "-ar", "16000", "-b:a", "64k", output,
    ]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error("ffmpeg transcode failed: " + err.slice(-1500)))));
    ff.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// LLM Gateway calls (server-side; Bearer/Cookie from saved config)
// ---------------------------------------------------------------------------
function gwUrl(cfg, p) {
  return cfg.base.replace(/\/+$/, "") + p;
}
// Build gateway auth headers. Data plane (/v1/*) uses the Bearer key. Identity for
// the console API (and, on this gateway, edge auth) comes from the Olares SSO
// cookie + X-BFL-USER.
//
// Priority = MANUALLY-FILLED value wins, else fall back to the current request.
//   • Local dev: you paste the Olares cookie into 设置; the browser's cookie for
//     localhost is unrelated junk, so the pasted one MUST win.
//   • Deployed on Olares: leave the cookie blank; the app sits behind the gateway
//     on the same domain, so the browser sends the real auth_token and the edge
//     injects x-bfl-user — both forwarded here via `req`.
//   • Async transcribe job: no `req`; cfg.bflUser is set from the record's captured
//     identity (see runJob) so data-plane calls still carry x-bfl-user.
function gwHeaders(cfg, { req, extra } = {}) {
  const h = { ...(extra || {}) };
  if (cfg.key) h["authorization"] = "Bearer " + cfg.key;
  const cookie = cfg.cookie || req?.headers?.cookie;
  if (cookie) h["cookie"] = cookie;
  const bfl = cfg.bflUser || req?.headers?.["x-bfl-user"];
  if (bfl) h["x-bfl-user"] = bfl;
  return h;
}

async function gwAudioOp(cfg, op, wavPath, model, extra = {}) {
  const buf = fs.readFileSync(wavPath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  fd.append("model", model);
  for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
  const r = await fetch(gwUrl(cfg, `/v1/audio/${op}`), { method: "POST", headers: gwHeaders(cfg), body: fd, signal: cfg._signal });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = text; }
  if (!r.ok) throw new Error(`${op} ${r.status}: ${String(text).slice(0, 300)}`);
  return j;
}

// Speech enhancement: POST the whole clip to /v1/audio/enhance and write the
// returned WAV (binary, not JSON) to outPath. Used as a pre-processing step
// before diar/STT/align. Throws on non-2xx so the caller can fall back to the
// original audio.
async function gwAudioEnhance(cfg, wavPath, model, outPath) {
  const buf = fs.readFileSync(wavPath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  fd.append("model", model);
  const r = await fetch(gwUrl(cfg, "/v1/audio/enhance"), { method: "POST", headers: gwHeaders(cfg), body: fd, signal: cfg._signal });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`enhance ${r.status}: ${String(t).slice(0, 300)}`);
  }
  const ab = await r.arrayBuffer();
  fs.writeFileSync(outPath, Buffer.from(ab));
  return outPath;
}

// ---------------------------------------------------------------------------
// GET /api/models — discover gateway models grouped by mode + readiness
// ---------------------------------------------------------------------------
app.get("/api/models", async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.base) return res.status(400).json({ error: "尚未配置网关地址", modes: {} });
  try {
    const r = await fetch(gwUrl(cfg, "/console/api/provider-models?limit=1000"), {
      method: "GET",
      headers: gwHeaders(cfg, { req }),
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
    console.error("[/api/models] fetch error:", e?.message, "cause:", e?.cause?.code || e?.cause?.message || e?.cause, "url:", gwUrl(cfg, "/console/api/provider-models"));
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
    segmentedStt: Boolean(b.segmentedStt ?? cur.segmentedStt ?? false),
    language: (b.language ?? cur.language ?? "auto").toString().trim() || "auto",
    autoTranscribe: Boolean(b.autoTranscribe ?? cur.autoTranscribe ?? true),
    translate: {
      enabled: Boolean(b.translate?.enabled ?? cur.translate?.enabled ?? false),
      model: (b.translate?.model ?? cur.translate?.model ?? "").toString(),
      sourceLang: (b.translate?.sourceLang ?? cur.translate?.sourceLang ?? "auto").toString().trim() || "auto",
      targetLang: (b.translate?.targetLang ?? cur.translate?.targetLang ?? "auto").toString().trim() || "auto",
    },
    enhance: {
      enabled: Boolean(b.enhance?.enabled ?? cur.enhance?.enabled ?? false),
      model: (b.enhance?.model ?? cur.enhance?.model ?? "").toString(),
    },
    background: {
      enabled: Boolean(b.background?.enabled ?? cur.background?.enabled ?? false),
      dim: Math.max(0, Math.min(80, Number(b.background?.dim ?? cur.background?.dim ?? 40) || 0)),
      mime: (b.background?.mime ?? cur.background?.mime ?? "").toString(),
    },
  };
  saveConfig(next);
  res.json({ ...next, ...configReady(next) });
});

// ---------------------------------------------------------------------------
// Background image (cosmetic) — single uploaded file at DATA_DIR/background.bin
// ---------------------------------------------------------------------------
const bgUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.post("/api/background", bgUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file" });
  const mime = req.file.mimetype || "";
  if (!mime.startsWith("image/")) return res.status(400).json({ error: "仅支持图片文件" });
  try {
    fs.writeFileSync(BACKGROUND_PATH, req.file.buffer);
    const cfg = loadConfig();
    cfg.background = { ...cfg.background, enabled: true, mime };
    saveConfig(cfg);
    res.json({ ...cfg, ...configReady(cfg) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/background", (_req, res) => {
  if (!fs.existsSync(BACKGROUND_PATH)) return res.status(404).end();
  const cfg = loadConfig();
  if (cfg.background?.mime) res.type(cfg.background.mime);
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.resolve(BACKGROUND_PATH));
});

app.delete("/api/background", (_req, res) => {
  fs.rm(BACKGROUND_PATH, { force: true }, () => {});
  const cfg = loadConfig();
  cfg.background = { ...cfg.background, enabled: false, mime: "" };
  saveConfig(cfg);
  res.json({ ...cfg, ...configReady(cfg) });
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
  const cfg = loadConfig();
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
      // Per-file transcription options, snapshotted from the current global
      // defaults; the user can override them per record before (re)transcribing.
      options: {
        language: cfg.language || "auto",
        segmentedStt: !!cfg.segmentedStt,
        translate: !!cfg.translate?.enabled,
        enhance: !!cfg.enhance?.enabled,
      },
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
  // Expose the same cover flags the summary carries so the detail view knows a
  // cover exists (raw record only has the internal `cover` object).
  res.json({ ...rec, hasCover: !!rec.cover, coverVer: rec.cover?.at || "" });
});

app.delete("/api/records/:id", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  for (const p of [rec.mediaPath, rec.audioPath, coverPath(rec.id)]) {
    if (p) fs.rm(p, { force: true }, () => {});
  }
  fs.rm(recPath(rec.id), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Cover image — a per-record thumbnail shown on the library cards. Accepts either
// an uploaded image file (multipart "file") or a captured video frame as a base64
// data URL (JSON { dataUrl }). Stored as covers/<id>.jpg; cleared via DELETE.
// ---------------------------------------------------------------------------
const coverUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.post("/api/records/:id/cover", coverUpload.single("file"), (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  let buf = null;
  if (req.file) {
    if (!(req.file.mimetype || "").startsWith("image/")) return res.status(400).json({ error: "仅支持图片文件" });
    buf = req.file.buffer;
  } else if (typeof req.body?.dataUrl === "string") {
    const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(req.body.dataUrl);
    if (!m) return res.status(400).json({ error: "无效的图片数据" });
    buf = Buffer.from(m[1], "base64");
  }
  if (!buf || !buf.length) return res.status(400).json({ error: "no image" });
  try {
    fs.writeFileSync(coverPath(rec.id), buf);
    rec.cover = { at: nowIso() };
    writeRecord(rec);
    res.json(recordSummary(rec));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/records/:id/cover", (req, res) => {
  const p = coverPath(req.params.id);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.type("image/jpeg");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.resolve(p));
});

app.delete("/api/records/:id/cover", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  fs.rm(coverPath(rec.id), { force: true }, () => {});
  delete rec.cover;
  writeRecord(rec);
  res.json(recordSummary(rec));
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
// Serial job queue: only ONE record transcribes at a time. Diarization/STT hit
// a shared gateway/GPU, so running several jobs at once starves them all (records
// stall together at 3%). Jobs are therefore queued FIFO and drained one by one.
const running = new Set(); // the single id currently processing (in-process guard)
const queue = [];          // ids waiting their turn (FIFO)
const jobKinds = new Map(); // id -> "full" | "translate" (translate = add译文 only)
let draining = false;      // true while a job is active (the serial gate)
// Ids the user asked to STOP. There is no true pause (diar/STT are one-shot remote
// calls we can't interrupt mid-flight), so this is a cooperative abort: the running
// job checks it at each checkpoint (between windows / segments) and bails out.
const cancelled = new Set();
// id -> AbortController for the job's in-flight gateway fetches, so a stop can
// abort a long single call (whole-clip STT/enhance) immediately instead of
// waiting for it to return at the next checkpoint.
const jobAbort = new Map();

class CancelError extends Error { constructor() { super("__cancelled__"); this.cancelled = true; } }
// Throw at a checkpoint if this job was asked to stop.
function ckCancel(id) { if (cancelled.has(id)) throw new CancelError(); }
// Put a stopped record back into a stable, non-processing state: keep the previous
// transcript if there was one (done), otherwise mark it as待转录 so it can be re-run.
function revertStopped(id, fallbackRec) {
  const r = readRecord(id) || fallbackRec;
  if (!r) return;
  if (r.result && r.result.segments && r.result.segments.length) {
    r.status = "done"; r.progress = 100;
  } else {
    r.status = "uploaded"; r.progress = 0;
  }
  r.phase = ""; r.error = ""; r.stepDone = 0; r.stepTotal = 0;
  writeRecord(r);
}

// Reflect each waiting record's queue position in its phase so the UI clearly
// shows it is lined up (not silently doing nothing).
function refreshQueuePhases() {
  queue.forEach((qid, k) => {
    const r = readRecord(qid);
    if (!r) return;
    r.status = "processing";
    r.progress = 1;
    r.phase = `排队中（第 ${k + 1} 位）`;
    r.error = "";
    writeRecord(r);
  });
}

function enqueueJob(id, kind = "full") {
  if (running.has(id) || queue.includes(id)) return false;
  jobKinds.set(id, kind);
  queue.push(id);
  refreshQueuePhases();
  pump();
  return true;
}

// Drain the queue strictly one job at a time.
async function pump() {
  if (draining) return;
  const id = queue.shift();
  if (id === undefined) return;
  draining = true;
  refreshQueuePhases();
  const kind = jobKinds.get(id) || "full";
  jobKinds.delete(id);
  try {
    if (kind === "translate") await runTranslateJob(id);
    else await runJob(id);
  } catch {
    /* runJob persists its own terminal status/error */
  } finally {
    draining = false;
    pump();
  }
}

// Build STT/align windows from diarization. Ported from the audiostudioxdemo
// paragraph-merging algorithm: diar can emit MANY tiny same-speaker fragments
// (a podcast narrator producing one 2–4s bit per sentence => hundreds of
// micro-clips), and one STT+align round-trip per fragment is both slow (too many
// requests) and low quality (1–2 words, no context). So we COALESCE adjacent
// same-speaker segments into ~30s windows (merge while the running window stays
// under MAXDUR and the silence gap to the next stays under MAXGAP), then SPLIT
// any single turn longer than SPLIT_MAX into even <=SPLIT_MAX pieces. Result:
// far fewer requests, fuller text, better accuracy. Timestamps/speaker are
// preserved (window start = first bit, end = last bit, speaker = the shared one).
function buildWindows(diarSegs, duration) {
  const MAXDUR = 28, MAXGAP = 1.5, SPLIT_MAX = 30, MINSEG = 0.2;
  let segs = (diarSegs || [])
    .map((s) => ({ start: +s.start, end: +s.end, speaker: String(s.speaker ?? "SPEAKER_00") }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (!segs.length) segs = [{ start: 0, end: Math.max(duration || 0, 0.1), speaker: "SPEAKER_00" }];

  // coalesce same-speaker neighbours while window < MAXDUR and gap < MAXGAP
  const co = [];
  for (const s of segs) {
    const l = co[co.length - 1];
    if (l && l.speaker === s.speaker && s.start - l.end <= MAXGAP && s.end - l.start <= MAXDUR) {
      l.end = Math.max(l.end, s.end);
    } else {
      co.push({ ...s });
    }
  }

  // split any oversized turn into even <=SPLIT_MAX pieces (keeps STT/align happy)
  const out = [];
  for (const s of co) {
    const dur = s.end - s.start;
    if (dur <= SPLIT_MAX + 0.01) { out.push(s); continue; }
    const n = Math.ceil(dur / SPLIT_MAX);
    const step = dur / n;
    for (let i = 0; i < n; i++) {
      out.push({
        start: i === 0 ? s.start : s.start + i * step,
        end: i === n - 1 ? s.end : s.start + (i + 1) * step,
        speaker: s.speaker,
      });
    }
  }
  return out.filter((w) => w.end - w.start >= MINSEG);
}

// ---------------------------------------------------------------------------
// Punctuation-preserving word timing — ported from audiostudioxdemo. The
// forced aligner returns BARE spoken tokens (per-char / per-word) with NO
// spaces or punctuation, so concatenating them destroys the readable text.
// Instead we keep the STT reference text (which HAS punctuation) as the display
// source and use the aligner ONLY for timing: map each unit back to its char
// span in the reference, build a monotonic char→time table, then tokenize the
// reference (keeping punctuation) with a time on every token.
// ---------------------------------------------------------------------------
const isCJK = (ch) => !!ch && /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(ch);

function mapUnitsToRef(units, refText) {
  const out = [];
  let cursor = 0;
  const lower = refText.toLowerCase();
  for (const u of units) {
    const t = (u.text || "").trim();
    if (!t) { out.push({ ci: cursor, cj: cursor }); continue; }
    let idx = refText.indexOf(t, cursor);
    if (idx < 0) idx = lower.indexOf(t.toLowerCase(), cursor);
    if (idx < 0) { out.push({ ci: cursor, cj: Math.min(refText.length, cursor + t.length) }); continue; }
    out.push({ ci: idx, cj: idx + t.length });
    cursor = idx + t.length;
  }
  return out;
}

function buildCharToTime(units, map) {
  const aC = [], aT = [];
  for (let i = 0; i < units.length; i++) {
    aC.push(map[i].ci); aT.push(units[i].start);
    aC.push(map[i].cj); aT.push(units[i].end);
  }
  for (let i = 1; i < aC.length; i++) if (aC[i] < aC[i - 1]) aC[i] = aC[i - 1];
  return (c) => {
    if (!aC.length) return 0;
    if (c <= aC[0]) return aT[0];
    for (let i = 1; i < aC.length; i++) {
      if (c <= aC[i]) {
        const c0 = aC[i - 1], c1 = aC[i];
        return c1 <= c0 ? aT[i] : aT[i - 1] + ((aT[i] - aT[i - 1]) * (c - c0)) / (c1 - c0);
      }
    }
    return aT[aT.length - 1];
  };
}

// Candidate cut positions: after every sentence-end / clause mark (swallowing
// trailing closing quotes/brackets/spaces), plus 0 and length.
function punctBounds(refText) {
  const s = new Set([0, refText.length]);
  for (let i = 0; i < refText.length; i++) {
    const ch = refText[i];
    const nxt = refText[i + 1] || "";
    const sentEnd = /[。！？]/.test(ch) || (/[.!?]/.test(ch) && (nxt === "" || /[\s"'”’)\]]/.test(nxt)));
    const clause = /[，、；,;：:]/.test(ch);
    if (sentEnd || clause) {
      let j = i + 1;
      while (j < refText.length && /["'”’」』）)\]\s]/.test(refText[j])) j++;
      s.add(j);
    }
  }
  return Array.from(s).sort((a, b) => a - b);
}

// Break refText[c0,c1) into readable lines: after each sentence end, or at the
// last clause mark before maxLen (CJK wraps at a char if none). Returns exclusive
// ends, last == c1.
function punctLineBreaks(refText, c0, c1, maxLen) {
  const swallow = (k) => { let j = k + 1; while (j < c1 && /["'”’」』）)\]\s]/.test(refText[j])) j++; return j; };
  const hardCap = Math.max(maxLen * 2, 120);
  const cuts = [];
  let lineStart = c0, lastComma = -1;
  for (let i = c0; i < c1; i++) {
    const ch = refText[i];
    const nxt = i + 1 < c1 ? refText[i + 1] : "";
    const sentEnd = /[。！？]/.test(ch) || (/[.!?]/.test(ch) && (nxt === "" || /[\s"'”’)\]]/.test(nxt)));
    const comma = /[，、；,;：:]/.test(ch);
    let cutAt = -1;
    if (sentEnd) cutAt = swallow(i);
    else if (comma) lastComma = swallow(i);
    if (cutAt < 0 && i - lineStart + 1 >= maxLen) {
      if (lastComma > lineStart) cutAt = lastComma;
      else if (isCJK(ch)) cutAt = i + 1;
    }
    if (cutAt < 0 && !isCJK(ch) && (nxt === "" || /\s/.test(nxt)) && i - lineStart + 1 >= hardCap) cutAt = i + 1;
    if (cutAt > lineStart) { cuts.push(cutAt); lineStart = cutAt; lastComma = -1; i = cutAt - 1; }
  }
  if (!cuts.length || cuts[cuts.length - 1] !== c1) cuts.push(c1);
  return cuts;
}

// Does this transcript carry usable punctuation? Whisper punctuates English but
// NOT Chinese, so this is decided per-RESULT (not per-model). Punctuated → keep the
// existing punctuation-driven segmentation untouched; unpunctuated → use the
// pause/speaker/length fallback below so timestamps don't collapse.
function hasPunctuation(text) {
  const t = text || "";
  if (!t) return true; // empty: don't change behavior
  const marks = (t.match(/[。！？，、；：…,.!?;:]/g) || []).length;
  const chars = t.replace(/\s/g, "").length || 1;
  return marks >= 3 && marks / chars >= 0.01;
}

// Line cuts for UNPUNCTUATED text. With no punctuation to lean on we break on the
// aligned pauses — but a pause ALONE would shatter slow singing (every drawn-out
// character has a >0.6s gap) into one-char lines. So a pause only cuts once the line
// has enough substance (minChars / minSec); a hard length/duration cap always cuts.
// Mirrors punctLineBreaks' contract: exclusive char ends within [c0,c1), last == c1.
function pauseLineCuts(units, map, c0, c1, opts = {}, speakerAt = null) {
  // CHARACTER-COUNT driven on purpose: forced aligners stretch single characters
  // across held notes / instrumental gaps (one char can span 3–20s), so DURATION is
  // unreliable and word "pauses" are usually 0 (times are made contiguous). Char
  // count is the only trustworthy signal. Genuine gaps / speaker turns still break,
  // but only once the line has enough characters (so a stretched char can't split).
  const { pauseS = 1.0, minChars = 10, maxChars = 36 } = opts;
  const idx = [];
  for (let i = 0; i < units.length; i++) {
    const m = map[i];
    if (m && m.ci >= c0 && m.ci < c1) idx.push(i);
  }
  if (idx.length === 0) return [c1];
  const spkOf = (i) => (speakerAt ? speakerAt((units[i].start + units[i].end) / 2) : null);
  const cuts = [];
  let lineStartCi = c0;
  let lineSpk = spkOf(idx[0]);
  let prevEnd = units[idx[0]].end;
  let prevCj = Math.min(c1, map[idx[0]].cj);
  for (let k = 1; k < idx.length; k++) {
    const i = idx[k];
    const gap = units[i].start - prevEnd;
    const chars = map[i].ci - lineStartCi;
    const spk = spkOf(i);
    const spkChanged = lineSpk !== null && spk !== lineSpk;
    const cutHere = chars >= maxChars || ((gap > pauseS || spkChanged) && chars >= minChars);
    if (cutHere) {
      const cut = Math.max(lineStartCi + 1, Math.min(c1, prevCj));
      cuts.push(cut);
      lineStartCi = cut;
      lineSpk = spk;
    }
    prevEnd = units[i].end;
    prevCj = Math.min(c1, map[i].cj);
  }
  if (!cuts.length || cuts[cuts.length - 1] !== c1) cuts.push(c1);
  return cuts;
}

// Optional STT params. For Whisper, pass `language` when the user picked one so it
// decodes the right language (higher accuracy). We DELIBERATELY DO NOT send an
// `initial_prompt` to coax Chinese punctuation: Whisper doesn't follow instructions,
// it treats the prompt as preceding transcript and HALLUCINATES it back into the
// output (the prompt text literally leaked into transcripts of music/gappy audio).
// Unpunctuated Chinese is instead handled by the robust pause/speaker/length split.
// Qwen already punctuates → plain params. "auto" → nothing added.
function sttParams(cfg) {
  const p = { response_format: "json" };
  const isWhisper = /whisper/i.test(cfg.models?.stt || "");
  if (!isWhisper) return p;
  const lang = (cfg.language || "auto").toLowerCase();
  if (lang && lang !== "auto") p.language = lang; // let Whisper decode the chosen language
  return p;
}

// Tokenize refText[c0,c1) into clickable words WITH punctuation, each timed by
// char→time. CJK = one char + trailing punctuation; Latin = a word + trailing
// punctuation; spaces separate.
function sliceToWords(refText, c0, c1, timeAtChar) {
  const PUNCT = /[。！？，、；：,.!?;:"'”’」』）)\]…—·]/;
  const APOS = /['’]/;                 // contraction apostrophe (I'm, Let's, don't)
  const WORDCH = /[\p{L}\p{N}]/u;      // letter/digit
  const words = [];
  let i = c0;
  while (i < c1) {
    if (/\s/.test(refText[i])) { i++; continue; }
    let j;
    if (isCJK(refText[i])) j = i + 1;
    else {
      j = i;
      while (j < c1 && !/\s/.test(refText[j]) && !isCJK(refText[j])) {
        if (PUNCT.test(refText[j])) {
          // Keep an apostrophe INSIDE a word (letter ' letter) so contractions
          // like I'm / Let's / don't stay one token; any other punct breaks.
          if (APOS.test(refText[j]) && j > i && WORDCH.test(refText[j - 1]) && j + 1 < c1 && WORDCH.test(refText[j + 1])) { j++; continue; }
          break;
        }
        j++;
      }
      if (j === i) j = i + 1;
    }
    while (j < c1 && PUNCT.test(refText[j])) j++;
    const text = refText.slice(i, j);
    if (text.trim()) words.push({ text, start: round3(timeAtChar(i)), end: round3(timeAtChar(j)) });
    i = j;
  }
  return words;
}

// Forced-alignment language. Qwen3-ForcedAligner wants a language NAME
// ("Chinese"/"English"/…) and this gateway REQUIRES it (omitting it 500s). Like
// audiostudioxdemo we DON'T ask the user for it: we auto-detect from the STT text
// (script checks cover 中/日/韩; everything else → English). A translation model
// (NLLB) can't do detection — it needs the source language given — so local
// detection is both cheaper and what the DEMO relies on. An explicit config
// `language` (code) overrides detection.
const LANG_CODE_TO_NAME = {
  zh: "Chinese", "zh-cn": "Chinese", "zh-hans": "Chinese", cmn: "Chinese",
  en: "English", ja: "Japanese", jp: "Japanese", ko: "Korean",
  yue: "Cantonese", fr: "French", es: "Spanish", de: "German", ru: "Russian",
};
function detectAlignLangName(text) {
  const t = (text || "").trim();
  if (!t) return "English";
  if (/[\uAC00-\uD7A3]/.test(t)) return "Korean";      // Hangul
  if (/[\u3040-\u30FF]/.test(t)) return "Japanese";    // Hiragana / Katakana
  if (/[\u4E00-\u9FFF]/.test(t)) return "Chinese";     // Han
  return "English";                                     // Latin (default)
}
// Resolve the aligner language for a given reference text: explicit config code
// wins (mapped to a name); "auto"/empty → detect from the text.
function resolveAlignLang(cfgLanguage, text) {
  const ov = (cfgLanguage || "auto").trim().toLowerCase();
  if (ov && ov !== "auto") return LANG_CODE_TO_NAME[ov] || cfgLanguage.trim();
  return detectAlignLangName(text);
}

// Post-process word times so EVERY word is clickable AND highlightable:
//   • clamp into [lo,hi] — the word's own speech window (diar). Forced alignment
//     on a clip with a non-vocal intro (e.g. a song's instrumental opening) mis-
//     places the first words at t≈0; clamping pulls them back into the real
//     spoken window instead of the silent intro.
//   • make starts STRICTLY increasing. The aligner often gives several leading
//     chars the SAME start (0) with zero duration; since highlight picks the word
//     by [start, nextStart) such words are invisible/unhittable. We spread equal-
//     start runs by a small step and give every word a minimum duration.
function finalizeWords(words, lo, hi) {
  if (!words || !words.length) return words || [];
  const hasBound = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo;
  if (hasBound) {
    for (const w of words) {
      w.start = Math.min(Math.max(w.start, lo), hi);
      w.end = Math.min(Math.max(w.end, lo), hi);
    }
  }
  for (let i = 1; i < words.length; i++) if (words[i].start < words[i - 1].start) words[i].start = words[i - 1].start;
  const n = words.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && words[j + 1].start <= words[i].start) j++;
    const s = words[i].start;
    if (j > i) {
      // run [i..j] shares start s → spread by small steps up to the next distinct start
      const next = j + 1 < n ? words[j + 1].start : s + (j - i + 1) * 0.2;
      const step = Math.max(0.05, (next - s) / (j - i + 1));
      for (let k = i; k <= j; k++) { words[k].start = round3(s + step * (k - i)); words[k].end = round3(s + step * (k - i + 1)); }
    } else if (!(words[i].end > words[i].start)) {
      words[i].end = round3(words[i].start + 0.15);
    }
    i = j + 1;
  }
  return words;
}

// Per-segment: given the segment's OWN reference text (STT, punctuated) and its
// align units, produce punctuation-preserving timed words. Empty units → [] (UI
// then shows the punctuated text as one clickable line).
function wordsFromRef(refText, units) {
  if (!refText || !units || !units.length) return [];
  const map = mapUnitsToRef(units, refText);
  const timeAtChar = buildCharToTime(units, map);
  return sliceToWords(refText, 0, refText.length, timeAtChar);
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

// ---------------------------------------------------------------------------
// Translation (NLLB via the gateway's /v1/translate). Per-segment, driven by the
// original transcript. The audio is in the SOURCE language, so we can't get real
// word times for the translation — we instead spread the translated text evenly
// across each segment's [start,end] (pseudo word-level) so the UI can still
// click-to-seek and highlight-in-sync at word granularity.
// ---------------------------------------------------------------------------
async function gwTranslate(cfg, model, text, target, source) {
  const body = { model, text, target };
  if (source) body.source = source;
  const r = await fetch(gwUrl(cfg, "/v1/translate"), {
    method: "POST",
    headers: { ...gwHeaders(cfg), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: cfg._signal,
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`translate ${r.status}: ${String(t).slice(0, 200)}`);
  return (j?.translation ?? j?.text ?? j?.translated_text ?? "").toString();
}

// Script-based source-language guess (FLORES code) — enough to drive the smart
// zh<->en default and the same-language skip. No franc on the server; scripts
// decide (Kana → ja, Hangul → ko, Han → zh, else → en).
function detectFlores(text) {
  const t = (text || "").trim();
  if (!t) return "eng_Latn";
  if (/[\u3040-\u30ff]/.test(t)) return "jpn_Jpan";
  if (/[\uac00-\ud7af]/.test(t)) return "kor_Hang";
  if (/[\u4e00-\u9fff]/.test(t)) return "zho_Hans";
  return "eng_Latn";
}

// Resolve the target FLORES code. "auto" = smart zh<->en (Chinese → English,
// anything else → Chinese). An explicit code wins.
function resolveTarget(cfgTarget, src) {
  const t = cfgTarget || "auto";
  if (t && t !== "auto") return t;
  return src === "zho_Hans" ? "eng_Latn" : "zho_Hans";
}

// Spread a translated string evenly across [lo,hi] as pseudo-timed words (same
// tokenization as the original transcript, so the frontend renders/handles them
// identically — jieba grouping, click-to-seek, highlight).
function evenTimedWords(text, lo, hi) {
  const L = (text || "").length;
  if (!L) return [];
  const dur = Math.max(0.001, (hi || 0) - (lo || 0));
  const timeAtChar = (c) => lo + dur * (Math.min(Math.max(c, 0), L) / L);
  return finalizeWords(sliceToWords(text, 0, L, timeAtChar), lo, hi);
}

// Translate each segment in place (adds seg.translation + seg.twords). Segments
// whose detected source == target are left untranslated (translation cleared).
async function translateSegments(cfg, segments, setP, id) {
  const model = cfg.translate?.model;
  if (!model || !segments?.length) return { translated: 0 };
  const cfgSource = cfg.translate?.sourceLang || "auto";
  const cfgTarget = cfg.translate?.targetLang || "auto";
  const total = segments.length;
  let done = 0, translated = 0, failed = 0, lastErr = "";
  if (setP) setP(95, "翻译", 0, total);
  await mapLimit(segments, 4, async (seg) => {
    // Checkpoint OUTSIDE the per-segment try/catch below so a stop actually
    // propagates (the inner catch swallows per-segment errors on purpose).
    if (id) ckCancel(id);
    const text = (seg.text || "").trim();
    if (text) {
      try {
        // Source: use the fixed choice if set, else detect per segment. Target:
        // fixed choice, else smart zh<->en based on the (resolved) source.
        const src = cfgSource !== "auto" ? cfgSource : detectFlores(text);
        const target = resolveTarget(cfgTarget, src);
        if (src !== target) {
          let tr = (await gwTranslate(cfg, model, text, target, src)).trim();
          // Chinese target: convert the model's half-width punctuation (,.!? etc.)
          // to full-width Chinese punctuation so the译文 reads naturally.
          if (tr && /^zho/i.test(target)) tr = toChinesePunct(tr);
          if (tr) {
            seg.translation = tr;
            seg.twords = evenTimedWords(tr, seg.start, seg.end);
            seg.translateTo = target;
            translated++;
          } else {
            delete seg.translation; delete seg.twords; delete seg.translateTo;
          }
        } else {
          delete seg.translation; delete seg.twords; delete seg.translateTo;
        }
      } catch (e) {
        // leave this segment untranslated; the run still succeeds. Remember the
        // failure so the caller can surface a single aggregate notice.
        failed++;
        if (!(e && e.cancelled)) lastErr = (e?.message || String(e));
        else throw e;
      }
    }
    done++;
    if (setP) setP(95 + Math.round((5 * done) / total), "翻译", done, total);
  });
  if (id && failed > 0) {
    addNotice(id, "warn", `翻译有 ${failed}/${total} 段未成功（该部分保留原文）。${lastErr ? "示例错误：" + lastErr : ""}`);
  }
  return { translated, failed };
}

// Translate-only job for an ALREADY-transcribed record (补翻译). Reuses the serial
// queue so it never contends with a running transcription for the gateway/GPU.
async function runTranslateJob(id) {
  if (running.has(id)) return;
  const rec = readRecord(id);
  if (!rec) return;
  const cfg = loadConfig();
  if (rec.bflUser) cfg.bflUser = rec.bflUser;
  if (!rec.result?.segments?.length) {
    rec.status = rec.result ? "done" : rec.status;
    rec.error = "无内容可翻译";
    writeRecord(rec);
    return;
  }
  if (!cfg.translate?.model) {
    rec.status = "error";
    rec.error = "无法翻译:未选择翻译模型";
    writeRecord(rec);
    return;
  }
  running.add(id);
  cancelled.delete(id); // clear any stale stop flag from a prior desync/cancel
  const ac = new AbortController();
  jobAbort.set(id, ac);
  cfg._signal = ac.signal; // gateway fetches abort immediately on stop
  const startedAt = nowIso();
  const timer = makeTimer();
  const setP = (progress, phase, stepDone = 0, stepTotal = 0) => {
    const r = readRecord(id);
    if (!r) return;
    r.status = "processing";
    r.progress = progress;
    r.phase = phase;
    r.stepDone = stepDone;
    r.stepTotal = stepTotal;
    r.startedAt = startedAt;
    r.error = "";
    writeRecord(r);
  };
  try {
    ckCancel(id);
    const out = readRecord(id);
    const segments = out.result.segments;
    timer.begin("翻译");
    const tr = await translateSegments(cfg, segments, setP, id);
    const timings = timer.finish();
    addNotice(id, "info", `补翻译完成：${tr.translated}/${segments.length} 段（模型 ${cfg.translate.model}）。`);
    out.result.segments = segments;
    out.options = { ...(out.options || {}), translate: true };
    out.status = "done";
    out.progress = 100;
    out.phase = "";
    out.error = "";
    out.timings = timings;
    writeRecord(out);
    addNotice(id, "info", `处理完成：总用时 ${fmtMs(timings.totalMs)}（${timings.steps.map((s) => `${s.name} ${fmtMs(s.ms)}`).join("、")}）。`);
  } catch (e) {
    if ((e && e.cancelled) || cancelled.has(id)) {
      // Stopped by the user (CancelError OR an aborted in-flight fetch): this
      // record already had a transcript, so just restore its 已完成 state (keep
      // whatever partial译文 was written).
      revertStopped(id, rec);
    } else {
      const out = readRecord(id) || rec;
      out.status = "error";
      out.error = String(e.message || e);
      writeRecord(out);
    }
  } finally {
    running.delete(id);
    cancelled.delete(id);
    jobAbort.delete(id);
  }
}

async function runJob(id) {
  if (running.has(id)) return;
  const rec = readRecord(id);
  if (!rec) return;
  const cfg = loadConfig();
  // Use the identity captured when this record's transcribe was requested so the
  // gateway gets x-bfl-user even though the job runs without a live browser request.
  if (rec.bflUser) cfg.bflUser = rec.bflUser;
  // Per-file options override the global defaults for THIS job.
  const opts = rec.options || {};
  if (opts.language) cfg.language = opts.language;
  cfg.segmentedStt = !!opts.segmentedStt;
  const { ready, missing } = configReady(cfg);
  if (!ready) {
    rec.status = "error";
    rec.error = "无法转录:缺少 " + missing.join("、");
    writeRecord(rec);
    return;
  }
  running.add(id);
  cancelled.delete(id); // clear any stale stop flag from a prior desync/cancel
  const ac = new AbortController();
  jobAbort.set(id, ac);
  cfg._signal = ac.signal; // gateway fetches abort immediately on stop
  console.log(`[${id}] 开始转写 "${rec.title}" 时长=${rec.durationSec ?? "?"}s options=${JSON.stringify(rec.options || {})} models=${JSON.stringify(cfg.models)} enhanceModel=${cfg.enhance?.model || "-"}`);
  const startedAt = nowIso();
  const timer = makeTimer();
  // Persist progress with a granular step counter so the UI can show
  // "阶段 · 第 done/total" and an elapsed timer (see setP calls below).
  const setP = (progress, phase, stepDone = 0, stepTotal = 0) => {
    const r = readRecord(id);
    if (!r) return;
    r.status = "processing";
    r.progress = progress;
    r.phase = phase;
    r.stepDone = stepDone;
    r.stepTotal = stepTotal;
    r.startedAt = startedAt;
    r.error = "";
    writeRecord(r);
  };
  const tmp = [];
  try {
    ckCancel(id);
    // 0) optional speech enhancement (denoise) as a PRE-processing step. The
    // enhanced clip becomes the working audio for diar/STT/align; playback still
    // uses the original media. On failure we silently keep the original audio.
    let workAudio = rec.audioPath;
    if (rec.options?.enhance && cfg.enhance?.model) {
      try {
        timer.begin("降噪增强");
        setP(2, "降噪增强（整段处理中）");
        const enhPath = path.join(UPLOAD_DIR, `${id}-enh.wav`);
        tmp.push(enhPath);
        await gwAudioEnhance(cfg, rec.audioPath, cfg.enhance.model, enhPath);
        ckCancel(id);
        // The enhancer returns raw WAV; compress to mp3 so the whole-clip diar/STT
        // uploads stay under the gateway limit (a raw hour-long WAV → 413).
        const enhMp3 = path.join(UPLOAD_DIR, `${id}-enh.mp3`);
        tmp.push(enhMp3);
        await transcodeMp3(enhPath, enhMp3);
        workAudio = enhMp3;
        ckCancel(id);
        addNotice(id, "info", `降噪增强完成（模型 ${cfg.enhance.model}），后续转写基于增强后音频。`);
      } catch (e) {
        // a stop during enhance (CancelError or aborted fetch) must bubble up, not
        // silently fall through to diar
        if ((e && e.cancelled) || cancelled.has(id)) throw e;
        addNotice(id, "warn", `降噪增强失败，已改用原始音频转写。原因：${e?.message || e}`);
        workAudio = rec.audioPath;
      }
    }
    timer.begin("说话人分离");
    setP(3, "说话人分离（整段分析中）");
    // 1) diarization over the whole clip
    const diar = await gwAudioOp(cfg, "diarization", workAudio, cfg.models.diar);
    ckCancel(id);
    const diarSegs = Array.isArray(diar?.segments) ? diar.segments : [];
    console.log(`[${id}] 说话人分离完成: ${diarSegs.length} 段  workAudio=${path.basename(workAudio)}`);

    // 2) transcription strategy (integral vs segmented). Both feed the same
    //    fuse/sort tail below via segsOut. Forced alignment needs a language NAME
    //    per call; alignSlice auto-detects it from each slice's own text (or uses
    //    the explicit cfg.language override) — see resolveAlignLang.
    const segmented = !!cfg.segmentedStt;
    let language = "";
    let segsOut;

    // speaker for an absolute [a,b] span = diar speaker with max time overlap
    const dseg = (diarSegs || [])
      .map((s) => ({ start: +s.start, end: +s.end, speaker: String(s.speaker ?? "SPEAKER_00") }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
    const pickSpeaker = (a, b) => {
      let best = dseg[0]?.speaker || "SPEAKER_00", bestOv = 0;
      for (const d of dseg) {
        const ov = Math.min(b, d.end) - Math.max(a, d.start);
        if (ov > bestOv) { bestOv = ov; best = d.speaker; }
      }
      return best;
    };

    // Forced-alignment on a [start,end] slice -> word times on the absolute
    // timeline. Empty on failure (UI then degrades to segment-level).
    const alignSlice = async (aStart, aEnd, text, tag) => {
      if (!text) return [];
      const slicePath = path.join(UPLOAD_DIR, `${id}-${tag}.wav`);
      tmp.push(slicePath);
      try {
        await sliceWav(workAudio, aStart, aEnd, slicePath);
        const langName = resolveAlignLang(cfg.language, text);
        if (!language) language = langName;
        const al = await gwAudioOp(cfg, "align", slicePath, cfg.models.align, { text, language: langName });
        if (al?.language) language = al.language;
        const units = (Array.isArray(al?.units) ? al.units : []).map((u) => ({
          text: u.text ?? u.word ?? u.token ?? "",
          start: round3(Number(u.start ?? u.start_time ?? 0) + aStart),
          end: round3(Number(u.end ?? u.end_time ?? 0) + aStart),
        }));
        if (tag === "wa_full") {
          console.log(`[${id}] 对齐(${tag}) 返回 ${units.length} 个单元 · 切片时长≈${round3(aEnd - aStart)}s · text长度=${text.length} · lang=${langName} · resp类型=${al && typeof al === "object" ? "keys[" + Object.keys(al).join(",") + "]" : typeof al}`);
        }
        return units;
      } catch (e) {
        if (e && e.cancelled) throw e;
        console.error(`[${id}] 对齐(${tag})调用失败: ${e?.message || e}`);
        return [];
      }
    };

    // Per-(merged)-window path: STT + align per diarization window. buildWindows
    // already coalesces tiny same-speaker fragments into ~30s windows, so this is
    // a handful of requests, not one-per-diar-segment. Used directly by 分段转写
    // and as the robust fallback for 整段转写.
    // `phase` distinguishes the user-chosen 分段转写 from the 整段转写 long-audio
    // fallback (which reuses this same per-window machinery) so the UI doesn't
    // mislead the user into thinking 分段 was turned on when it wasn't.
    const runWindows = async (phase = "分段转写与词级对齐") => {
      const windows = buildWindows(diarSegs, rec.durationSec);
      setP(20, phase, 0, windows.length);
      let done = 0;
      return mapLimit(windows, 2, async (w, idx) => {
        ckCancel(id);
        const slicePath = path.join(UPLOAD_DIR, `${id}-w${idx}.wav`);
        tmp.push(slicePath);
        await sliceWav(workAudio, w.start, w.end, slicePath);
        let text = "";
        try {
          const stt = await gwAudioOp(cfg, "transcriptions", slicePath, cfg.models.stt, sttParams(cfg));
          text = (typeof stt === "string" ? stt : stt?.text ?? "").trim();
        } catch { text = ""; }
        // align only for timing; DISPLAY text (with punctuation) stays the STT text
        const units = await alignSlice(w.start, w.end, text, `wa${idx}`);
        const words = finalizeWords(wordsFromRef(text, units), w.start, w.end);
        done++;
        setP(20 + Math.round((70 * done) / windows.length), phase, done, windows.length);
        return { start: round3(w.start), end: round3(w.end), speaker: w.speaker, text, words };
      });
    };

    if (segmented) {
      timer.begin("分段转写与对齐");
      segsOut = await runWindows();
    } else {
      // 整段转写 (默认): Qwen3-ASR has NO verbose_json, so STT can't segment. We
      // instead do ONE whole-clip STT (full text) + ONE whole-clip forced align
      // (word times over the whole timeline), then cut into segments along the
      // (merged) diarization windows, distributing aligned words by time. Only 3
      // gateway calls total (diar + stt + align) and still word-level. Any
      // failure (e.g. clip too long for a single call) degrades to the per-window
      // path so a result is always produced.
      try {
        ckCancel(id);
        timer.begin("整段转写");
        setP(20, "整段转写");
        console.log(`[${id}] 整段转写：单次 STT 整段音频 (${path.basename(workAudio)}, 时长≈${rec.durationSec ?? "?"}s, model=${cfg.models.stt})`);
        const t0 = Date.now();
        const stt = await gwAudioOp(cfg, "transcriptions", workAudio, cfg.models.stt, sttParams(cfg));
        console.log(`[${id}] 整段 STT 返回，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        const fullText = (typeof stt === "string" ? stt : stt?.text ?? "").trim();
        if (!fullText) throw new Error("STT 无文本");
        ckCancel(id);

        // Whole-clip punctuation decision (once). Punctuated → keep the existing
        // punctuation-driven segmentation exactly as-is. Unpunctuated (e.g. Whisper
        // Chinese) → cut by pause/speaker/length so timestamps don't collapse.
        const punctuated = hasPunctuation(fullText);
        console.log(`[${id}] 标点检测：${punctuated ? "有标点，按标点分句" : "无标点，改用停顿/说话人/长度分句"}`);
        if (!punctuated) {
          addNotice(id, "info", "转写结果缺少标点，已自动改用「停顿/说话人/长度」分句（不依赖标点），以避免时间戳错乱。");
          if (/whisper/i.test(cfg.models?.stt || "")) {
            addNotice(id, "info", "该转写模型（Whisper）对中文不输出标点；如需带标点的中文转写，建议改用 Qwen 系列模型。");
          }
        }

        timer.begin("词级对齐");
        setP(55, "词级对齐");
        // Forced alignment respects the aligner's native ~300s / upload-size cap and
        // handles length on OUR side (the audiostudioxdemo strategy): a single call
        // only when short enough, otherwise AUTO-SPLIT the audio into ≤290s windows
        // and split the full STT text proportionally so each call sees only its own
        // window's text (never overfed) and each uploaded WAV stays small (no 413).
        const ALIGN_WIN_S = 290;
        const ALIGN_CONCURRENCY = 2;
        const alignTotal = rec.durationSec || 0;
        let units, map;
        if (alignTotal <= ALIGN_WIN_S + 5) {
          units = await alignSlice(0, alignTotal || ALIGN_WIN_S, fullText, "wa_full");
          map = mapUnitsToRef(units, fullText);
        } else {
          const nWin = Math.ceil(alignTotal / ALIGN_WIN_S);
          const winLen = alignTotal / nWin;
          const parts = splitTextN(fullText, nWin);
          // Char offset of each part inside fullText (parts concatenate to fullText
          // exactly), so each window's units can be char-mapped LOCALLY against its
          // own text slice and then shifted into fullText coordinates. This is what
          // keeps one window's text drift from freezing the global cursor (which
          // otherwise pins every later char to a single time).
          const partStart = [];
          { let acc = 0; for (let i = 0; i < nWin; i++) { partStart.push(acc); acc += (parts[i] || "").length; } }
          console.log(`[${id}] 词级对齐：整段${Math.round(alignTotal)}s 超过单窗上限，自动分 ${nWin} 窗(≤${ALIGN_WIN_S}s/窗)·并发${ALIGN_CONCURRENCY} 对齐`);
          addNotice(id, "info", `整段音频较长（约 ${Math.round(alignTotal)} 秒），词级对齐已自动分为 ${nWin} 个窗口（每窗 ≤${ALIGN_WIN_S} 秒）分别处理。`);
          const resU = new Array(nWin), resM = new Array(nWin);
          let next = 0, okWin = 0, doneWin = 0;
          const worker = async () => {
            while (true) {
              const i = next++;
              if (i >= nWin) break;
              ckCancel(id);
              const a = i * winLen;
              const b = Math.min(alignTotal, (i + 1) * winLen);
              const part = parts[i] || "";
              const u = await alignSlice(a, b, part, `wa_${i}`);
              // Map THIS window's units against ONLY its own text slice, then shift
              // char positions into fullText coordinates by the part's offset.
              const localMap = mapUnitsToRef(u, part);
              resM[i] = localMap.map((m) => ({ ci: partStart[i] + m.ci, cj: partStart[i] + m.cj }));
              if (u.length) okWin++;
              resU[i] = u;
              doneWin++;
              setP(55 + Math.round((30 * doneWin) / nWin), "词级对齐");
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(ALIGN_CONCURRENCY, nWin) }, worker)
          );
          units = resU.filter(Boolean).flat();
          map = resM.filter(Boolean).flat();
          console.log(`[${id}] 词级对齐完成：${okWin}/${nWin} 窗成功，共 ${units.length} 个单元`);
          if (okWin < nWin) {
            addNotice(id, "warn", `词级对齐有 ${nWin - okWin}/${nWin} 个窗口未成功，这部分文字将退化为句级时间（仍可点击定位，但逐字高亮可能不精确）。`);
          }
        }
        if (!units.length) throw new Error("对齐无结果");

        timer.begin("整理结果");
        setP(85, "整理结果");
        // char<->time over the punctuated reference, then cut along diar windows
        // (boundaries snapped to punctuation) and re-wrap into readable, timed,
        // punctuation-preserving lines. Reuses the audiostudioxdemo algorithm.
        const timeAtChar = buildCharToTime(units, map);
        const timeToChar = (t) => {
          for (let i = 0; i < units.length; i++) {
            if (t <= units[i].end) {
              if (t <= units[i].start) return map[i].ci;
              const span = Math.max(1e-6, units[i].end - units[i].start);
              return Math.round(map[i].ci + ((t - units[i].start) / span) * (map[i].cj - map[i].ci));
            }
          }
          return fullText.length;
        };
        const wins = buildWindows(diarSegs, rec.durationSec).sort((a, b) => a.start - b.start);
        segsOut = [];
        if (punctuated) {
          // HAS PUNCTUATION (unchanged): cut along diar windows (boundaries snapped to
          // punctuation), then re-wrap each window into punctuation-preserving lines.
          const bounds = punctBounds(fullText);
          const ci = [0];
          let last = 0;
          for (let k = 1; k < wins.length; k++) {
            const target = timeToChar(wins[k].start);
            let cand = -1, bd = Infinity;
            for (const b of bounds) {
              if (b <= last) continue;
              const d = Math.abs(b - target);
              if (d < bd) { bd = d; cand = b; }
            }
            ci.push(cand < 0 ? fullText.length : cand);
            last = ci[ci.length - 1];
          }
          ci.push(fullText.length);
          for (let k = 0; k < wins.length; k++) {
            const c0 = ci[k], c1 = ci[k + 1];
            if (c1 <= c0 || !fullText.slice(c0, c1).trim()) continue;
            const cuts = punctLineBreaks(fullText, c0, c1, 48);
            let prev = c0;
            for (const e of cuts) {
              const text = fullText.slice(prev, e).trim();
              // clamp this line's word times into the diar speech window so words
              // never land in a non-vocal intro/gap, then make them hittable.
              const words = finalizeWords(sliceToWords(fullText, prev, e, timeAtChar), wins[k].start, wins[k].end);
              if (text || words.length) {
                const start = words.length ? words[0].start : round3(Math.max(wins[k].start, timeAtChar(prev)));
                const end = words.length ? words[words.length - 1].end : round3(Math.min(wins[k].end, timeAtChar(e)));
                segsOut.push({ start, end, speaker: wins[k].speaker, text, words });
              }
              prev = e;
            }
          }
        } else {
          // NO PUNCTUATION: do ONE pause/length/speaker pass over the WHOLE text — do
          // NOT cut along the fine diar windows (singing produces dozens of tiny
          // windows that would shatter the transcript into one-char lines). Segment
          // count is driven by pauses/length; the speaker of each line is assigned by
          // diar time-overlap, and a speaker change also breaks a (substantial) line.
          const spkAt = (t) => pickSpeaker(t - 0.25, t + 0.25);
          const cuts = pauseLineCuts(
            units, map, 0, fullText.length,
            { pauseS: 1.0, minChars: 10, maxChars: 36 }, spkAt,
          );
          let prev = 0;
          for (const e of cuts) {
            if (e <= prev) continue;
            const text = fullText.slice(prev, e).trim();
            const words = finalizeWords(sliceToWords(fullText, prev, e, timeAtChar), timeAtChar(prev), timeAtChar(e));
            if (text || words.length) {
              const start = words.length ? words[0].start : round3(timeAtChar(prev));
              const end = words.length ? words[words.length - 1].end : round3(timeAtChar(e));
              segsOut.push({ start, end, speaker: pickSpeaker(start, end), text, words });
            }
            prev = e;
          }
        }
        if (!segsOut.length) {
          const words = finalizeWords(sliceToWords(fullText, 0, fullText.length, timeAtChar), 0, rec.durationSec || 0);
          segsOut = [{ start: 0, end: round3(rec.durationSec || 0), speaker: pickSpeaker(0, rec.durationSec || 0), text: fullText, words }];
        }
      } catch (e) {
        // A stop must abort, not fall into the fallback path.
        if ((e && e.cancelled) || cancelled.has(id)) throw e;
        // 整段 STT/align failed — fall back to the per-window path so a result is
        // still produced. Label it clearly as a fallback so the user doesn't think
        // 分段转写 was enabled. LOG the real reason (gateway status/body, etc.).
        console.error(`[${id}] 整段转写失败，回退逐段转写与对齐 — 原因: ${e && e.stack ? e.stack : (e?.message || e)}`);
        addNotice(id, "warn", `整段转写失败，已自动回退为逐段转写与对齐（结果仍可用）。原因：${e?.message || e}`);
        timer.begin("回退逐段转写与对齐");
        segsOut = await runWindows("整段转写失败，回退逐段转写与对齐");
      }
    }

    timer.begin("整理结果");
    setP(94, "整理结果");
    const segments = segsOut
      .filter((s) => s.text || (s.words && s.words.length))
      .sort((a, b) => a.start - b.start);
    const speakers = Array.from(new Set(segments.map((s) => s.speaker)));

    // Optional translation for this run (per-file toggle; needs a translate model).
    // If the user hit stop, skip translating and keep the transcript we just built
    // (translate is the last 5% — no reason to throw the transcript away).
    if (rec.options?.translate && cfg.translate?.model && !cancelled.has(id)) {
      try {
        timer.begin("翻译");
        const tr = await translateSegments(cfg, segments, setP, id);
        addNotice(id, "info", `翻译完成：${tr.translated}/${segments.length} 段（模型 ${cfg.translate.model}）。`);
      } catch (e) {
        if ((e && e.cancelled) || cancelled.has(id)) throw e;
        addNotice(id, "warn", `翻译过程中出错，已保留转写结果。原因：${e?.message || e}`);
      }
    }

    const timings = timer.finish();
    const out = readRecord(id);
    out.result = { language: language || "", speakers, segments };
    out.status = "done";
    out.progress = 100;
    out.phase = "";
    out.error = "";
    out.timings = timings;
    writeRecord(out);
    addNotice(id, "info", `处理完成：总用时 ${fmtMs(timings.totalMs)}（${timings.steps.map((s) => `${s.name} ${fmtMs(s.ms)}`).join("、")}）。`);
  } catch (e) {
    if ((e && e.cancelled) || cancelled.has(id)) {
      // Stopped mid-transcribe (CancelError OR an aborted in-flight fetch): no
      // full result was written, so drop back to待转录 (or keep a prior transcript
      // if this was a 重新转写 over an existing one).
      revertStopped(id, rec);
    } else {
      addNotice(id, "error", `转写失败：${e?.message || e}`);
      const out = readRecord(id) || rec;
      out.status = "error";
      out.error = String(e.message || e);
      writeRecord(out);
    }
  } finally {
    running.delete(id);
    cancelled.delete(id);
    jobAbort.delete(id);
    for (const t of tmp) fs.rm(t, { force: true }, () => {});
  }
}

app.post("/api/records/:id/transcribe", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  const cfg = loadConfig();
  const { ready, missing } = configReady(cfg);
  if (!ready) return res.status(400).json({ error: "无法转录:缺少 " + missing.join("、"), missing });
  if (running.has(rec.id) || queue.includes(rec.id))
    return res.json({ ok: true, alreadyRunning: true });
  // Capture the caller's Olares identity (edge-injected on THIS app's requests) so
  // the async job's data-plane gateway calls carry x-bfl-user without a manual
  // cookie. Not a secret; falls back to any existing value / env.
  const bfl = (req.headers["x-bfl-user"] || "").toString();
  if (bfl) rec.bflUser = bfl;
  // Options for THIS run are STICKY PER FILE: explicit body values win (the detail
  // bar sends them); otherwise fall back to the file's OWN saved options (seeded from
  // the global defaults at upload), NOT the live global — so a file keeps the language
  // it was last transcribed with even for card-level 重新转写. New files pick up the
  // current global at upload time.
  const b = req.body || {};
  const prev = rec.options || {};
  rec.options = {
    language: (b.language ?? prev.language ?? cfg.language ?? "auto").toString().trim() || "auto",
    segmentedStt: b.segmentedStt !== undefined ? !!b.segmentedStt : (prev.segmentedStt ?? !!cfg.segmentedStt),
    translate: b.translate !== undefined ? !!b.translate : (prev.translate ?? !!cfg.translate?.enabled),
    enhance: b.enhance !== undefined ? !!b.enhance : (prev.enhance ?? !!cfg.enhance?.enabled),
  };
  rec.status = "processing";
  rec.progress = 1;
  rec.phase = "排队中";
  rec.error = "";
  rec.jobKind = "full"; // full transcription pipeline (drives the processing step list)
  rec.notices = []; // fresh run → fresh event log
  delete rec.timings; // fresh run → recompute step/total durations
  writeRecord(rec);
  enqueueJob(rec.id); // queued; the serial pump runs it when its turn comes
  res.json({ ok: true, queued: true });
});

// Add/refresh translation for an already-transcribed record (补翻译), without
// re-running the whole STT/align pipeline. Uses the current global translate model
// + target language.
app.post("/api/records/:id/translate", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  const cfg = loadConfig();
  if (!cfg.translate?.model) return res.status(400).json({ error: "无法翻译:请先在设置中选择翻译模型" });
  if (!rec.result?.segments?.length) return res.status(400).json({ error: "该记录尚无转写内容可翻译" });
  if (running.has(rec.id) || queue.includes(rec.id))
    return res.json({ ok: true, alreadyRunning: true });
  const bfl = (req.headers["x-bfl-user"] || "").toString();
  if (bfl) rec.bflUser = bfl;
  rec.status = "processing";
  rec.progress = 1;
  rec.phase = "排队中（翻译）";
  rec.error = "";
  rec.jobKind = "translate"; // translate-only → processing view shows just 翻译
  writeRecord(rec);
  enqueueJob(rec.id, "translate");
  res.json({ ok: true, queued: true });
});

// Stop a queued or running job. No true pause (diar/STT are one-shot remote calls),
// so this is a best-effort cooperative abort: queued jobs are dropped immediately;
// a running job stops at its next checkpoint (between windows/segments), which can
// take a moment if a single long gateway call is in flight.
app.post("/api/records/:id/cancel", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  const id = rec.id;
  const qi = queue.indexOf(id);
  if (qi >= 0) {
    queue.splice(qi, 1);
    jobKinds.delete(id);
    cancelled.delete(id);
    revertStopped(id, rec);
    refreshQueuePhases();
    return res.json({ ok: true, stopped: "queued" });
  }
  if (running.has(id)) {
    cancelled.add(id);
    jobAbort.get(id)?.abort(); // abort any in-flight gateway call → near-instant stop
    const r = readRecord(id) || rec;
    r.phase = "停止中…";
    writeRecord(r);
    return res.json({ ok: true, stopping: true });
  }
  // Not tracked as queued or running, yet the record still says 处理中. This can
  // happen after a process restart (the in-memory running/queue sets are empty
  // but a boot re-queue is mid-flight) or any tracking desync. Flag cancellation
  // regardless — ckCancel keys off `cancelled`, so any live job WILL bail at its
  // next checkpoint — and revert the record now so the UI unsticks immediately.
  if (rec.status === "processing") {
    cancelled.add(id);
    jobAbort.get(id)?.abort();
    revertStopped(id, rec);
    return res.json({ ok: true, stopped: "stale" });
  }
  return res.json({ ok: true, noop: true }); // already finished / not active
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

// On boot, any record left mid-flight from a previous process is re-queued so it
// resumes automatically — strictly one at a time through the serial queue (never
// in parallel). Ordered by createdAt so earlier uploads run first.
const interrupted = listRecords()
  .filter((r) => r.status === "processing")
  .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
for (const rec of interrupted) enqueueJob(rec.id);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[audiominutesxdemo] listening on :${PORT}  ffmpeg=${hasFfmpeg()}  data=${DATA_DIR}`);
});
