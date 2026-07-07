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
  // false (default) = 整段转写: one whole-clip STT call. true = 分段转写: STT is
  // called per diarization window (more calls, tighter per-turn context).
  segmentedStt: false,
  // Forced-alignment needs a language NAME and Qwen3-ASR can't report one, so we
  // auto-detect it from the transcript text (like audiostudioxdemo). "auto" =
  // detect per slice; a code (zh/en/ja/ko/…) here forces that language instead.
  language: "auto",
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
    stepDone: rec.stepDone || 0,
    stepTotal: rec.stepTotal || 0,
    startedAt: rec.startedAt || "",
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
// Build gateway auth headers. Data plane (/v1/*) uses the Bearer key. Identity for
// the console API (and, on this gateway, edge auth) comes from the Olares SSO
// cookie + X-BFL-USER, which the Olares edge injects into requests reaching THIS
// app. So once deployed we do NOT need a manually-pasted cookie: we forward the
// live browser cookie and edge-injected x-bfl-user from the current request (`req`).
// The saved cfg.cookie/cfg.bflUser remain only as a local-dev fallback. `req` is
// absent for the async transcribe job — there cfg.bflUser is set from the record's
// captured identity (see runJob), so data-plane calls still carry x-bfl-user.
function gwHeaders(cfg, { req, extra } = {}) {
  const h = { ...(extra || {}) };
  if (cfg.key) h["authorization"] = "Bearer " + cfg.key;
  const cookie = req?.headers?.cookie || cfg.cookie;
  if (cookie) h["cookie"] = cookie;
  const bfl = req?.headers?.["x-bfl-user"] || cfg.bflUser;
  if (bfl) h["x-bfl-user"] = bfl;
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
// Serial job queue: only ONE record transcribes at a time. Diarization/STT hit
// a shared gateway/GPU, so running several jobs at once starves them all (records
// stall together at 3%). Jobs are therefore queued FIFO and drained one by one.
const running = new Set(); // the single id currently processing (in-process guard)
const queue = [];          // ids waiting their turn (FIFO)
let draining = false;      // true while a job is active (the serial gate)

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

function enqueueJob(id) {
  if (running.has(id) || queue.includes(id)) return false;
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
  try {
    await runJob(id);
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

// Tokenize refText[c0,c1) into clickable words WITH punctuation, each timed by
// char→time. CJK = one char + trailing punctuation; Latin = a word + trailing
// punctuation; spaces separate.
function sliceToWords(refText, c0, c1, timeAtChar) {
  const PUNCT = /[。！？，、；：,.!?;:"'”’」』）)\]…—·]/;
  const words = [];
  let i = c0;
  while (i < c1) {
    if (/\s/.test(refText[i])) { i++; continue; }
    let j;
    if (isCJK(refText[i])) j = i + 1;
    else { j = i; while (j < c1 && !/\s/.test(refText[j]) && !isCJK(refText[j]) && !PUNCT.test(refText[j])) j++; if (j === i) j = i + 1; }
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

async function runJob(id) {
  if (running.has(id)) return;
  const rec = readRecord(id);
  if (!rec) return;
  const cfg = loadConfig();
  // Use the identity captured when this record's transcribe was requested so the
  // gateway gets x-bfl-user even though the job runs without a live browser request.
  if (rec.bflUser) cfg.bflUser = rec.bflUser;
  const { ready, missing } = configReady(cfg);
  if (!ready) {
    rec.status = "error";
    rec.error = "无法转录:缺少 " + missing.join("、");
    writeRecord(rec);
    return;
  }
  running.add(id);
  const startedAt = nowIso();
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
    setP(3, "说话人分离（整段分析中）");
    // 1) diarization over the whole clip
    const diar = await gwAudioOp(cfg, "diarization", rec.audioPath, cfg.models.diar);
    const diarSegs = Array.isArray(diar?.segments) ? diar.segments : [];

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
        await sliceWav(rec.audioPath, aStart, aEnd, slicePath);
        const langName = resolveAlignLang(cfg.language, text);
        if (!language) language = langName;
        const al = await gwAudioOp(cfg, "align", slicePath, cfg.models.align, { text, language: langName });
        if (al?.language) language = al.language;
        return (Array.isArray(al?.units) ? al.units : []).map((u) => ({
          text: u.text ?? u.word ?? u.token ?? "",
          start: round3(Number(u.start ?? u.start_time ?? 0) + aStart),
          end: round3(Number(u.end ?? u.end_time ?? 0) + aStart),
        }));
      } catch {
        return [];
      }
    };

    // Per-(merged)-window path: STT + align per diarization window. buildWindows
    // already coalesces tiny same-speaker fragments into ~30s windows, so this is
    // a handful of requests, not one-per-diar-segment. Used directly by 分段转写
    // and as the robust fallback for 整段转写.
    const runWindows = async () => {
      const windows = buildWindows(diarSegs, rec.durationSec);
      setP(20, "分段转写与词级对齐", 0, windows.length);
      let done = 0;
      return mapLimit(windows, 2, async (w, idx) => {
        const slicePath = path.join(UPLOAD_DIR, `${id}-w${idx}.wav`);
        tmp.push(slicePath);
        await sliceWav(rec.audioPath, w.start, w.end, slicePath);
        let text = "";
        try {
          const stt = await gwAudioOp(cfg, "transcriptions", slicePath, cfg.models.stt, { response_format: "json" });
          text = (typeof stt === "string" ? stt : stt?.text ?? "").trim();
        } catch { text = ""; }
        // align only for timing; DISPLAY text (with punctuation) stays the STT text
        const units = await alignSlice(w.start, w.end, text, `wa${idx}`);
        const words = finalizeWords(wordsFromRef(text, units), w.start, w.end);
        done++;
        setP(20 + Math.round((70 * done) / windows.length), "分段转写与词级对齐", done, windows.length);
        return { start: round3(w.start), end: round3(w.end), speaker: w.speaker, text, words };
      });
    };

    if (segmented) {
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
        setP(20, "整段转写");
        const stt = await gwAudioOp(cfg, "transcriptions", rec.audioPath, cfg.models.stt, { response_format: "json" });
        const fullText = (typeof stt === "string" ? stt : stt?.text ?? "").trim();
        if (!fullText) throw new Error("STT 无文本");

        setP(55, "词级对齐");
        const units = await alignSlice(0, rec.durationSec || 0, fullText, "wa_full");
        if (!units.length) throw new Error("对齐无结果");

        setP(85, "整理结果");
        // char<->time over the punctuated reference, then cut along diar windows
        // (boundaries snapped to punctuation) and re-wrap into readable, timed,
        // punctuation-preserving lines. Reuses the audiostudioxdemo algorithm.
        const map = mapUnitsToRef(units, fullText);
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
        const bounds = punctBounds(fullText);
        const wins = buildWindows(diarSegs, rec.durationSec).sort((a, b) => a.start - b.start);
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

        segsOut = [];
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
        if (!segsOut.length) {
          const words = finalizeWords(sliceToWords(fullText, 0, fullText.length, timeAtChar), 0, rec.durationSec || 0);
          segsOut = [{ start: 0, end: round3(rec.durationSec || 0), speaker: pickSpeaker(0, rec.durationSec || 0), text: fullText, words }];
        }
      } catch (e) {
        segsOut = await runWindows();
      }
    }

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
  if (running.has(rec.id) || queue.includes(rec.id))
    return res.json({ ok: true, alreadyRunning: true });
  // Capture the caller's Olares identity (edge-injected on THIS app's requests) so
  // the async job's data-plane gateway calls carry x-bfl-user without a manual
  // cookie. Not a secret; falls back to any existing value / env.
  const bfl = (req.headers["x-bfl-user"] || "").toString();
  if (bfl) rec.bflUser = bfl;
  rec.status = "processing";
  rec.progress = 1;
  rec.phase = "排队中";
  rec.error = "";
  writeRecord(rec);
  enqueueJob(rec.id); // queued; the serial pump runs it when its turn comes
  res.json({ ok: true, queued: true });
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
