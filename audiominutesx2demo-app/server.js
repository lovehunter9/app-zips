// Audio Minutes X2 Demo — App Server
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
const QAINDEX_DIR = path.join(DATA_DIR, "qaindex");
const STATIC_DIR = path.join(__dirname, "web", "dist");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_DIR, { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });
fs.mkdirSync(QAINDEX_DIR, { recursive: true });

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
  // 智能摘要 (on-demand, per record). `model` is a chat-mode gateway model id
  // (e.g. Qwen3-4B). No enabled flag — it's triggered by a button, not the pipeline.
  summary: { model: "" },
  // 智能问答 / RAG (on-demand, per record). `model` = chat model (falls back to
  // summary.model when empty); `embedModel` = embedding-mode model (e.g. Qwen3-Embedding).
  qa: { model: "", embedModel: "" },
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
      summary: { ...DEFAULT_CONFIG.summary, ...(raw.summary || {}) },
      qa: { ...DEFAULT_CONFIG.qa, ...(raw.qa || {}) },
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

// Human-readable build/version info shown on the 设置 page so it's obvious WHICH
// build is running: the app folder name, the latest modification time (max mtime
// of server.js + the built SPA), and an optional APP_VERSION tag from the env.
function appVersion() {
  const dir = path.basename(__dirname); // e.g. "audiominutesx2demo-app"
  let latest = 0;
  for (const f of [path.join(__dirname, "server.js"), path.join(__dirname, "web", "dist", "index.html"), path.join(__dirname, "web", "dist", "assets")]) {
    try {
      const st = fs.statSync(f);
      const m = st.mtimeMs;
      if (m > latest) latest = m;
    } catch { /* file may not exist */ }
  }
  // Also scan the built asset bundle (its filename hash changes each build, but
  // the dir mtime already captures rebuilds; keep it simple with the dir above).
  let builtAt = "";
  if (latest) {
    const d = new Date(latest);
    const pad = (n) => String(n).padStart(2, "0");
    builtAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return {
    app: "audiominutesx2demo",
    dir,
    builtAt,
    tag: process.env.APP_VERSION || "",
    label: `${dir}${builtAt ? " · 修改于 " + builtAt : ""}${process.env.APP_VERSION ? " · " + process.env.APP_VERSION : ""}`,
  };
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
    options: rec.options || { language: "auto", segmentedStt: false, translate: false, enhance: false, maxSpeakers: 0 },
    translated: !!(rec.result?.segments || []).some((s) => s.translation),
    jobKind: rec.jobKind || "full",
    notices: Array.isArray(rec.notices) ? rec.notices : [],
    hasCover: !!rec.cover,
    coverVer: rec.cover?.at || "",
    totalMs: rec.timings?.totalMs ?? null,
    // Clip metadata: `clipOf` marks this record as a 片段 of another; `continuous`
    // is true for a single-range clip. Used by the UI for the 片段 badge / back-link.
    clipOf: rec.clipOf || "",
    continuous: rec.clipOf ? !!rec.continuous : undefined,
    clipCount: rec.clipRanges?.length || 0,
  };
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------
// Cache the probe: spawnSync blocks the event loop, so we must NEVER call this on
// a hot request path repeatedly. Computed once (lazily) and reused.
let _ffmpegOk = null;
function hasFfmpeg() {
  if (_ffmpegOk !== null) return _ffmpegOk;
  try {
    _ffmpegOk = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    _ffmpegOk = false;
  }
  return _ffmpegOk;
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

// Same as toWav16kMono but streams ffmpeg's progress so the caller can surface a
// live "提取音频 N%" phase to the UI. We probe the input duration first and parse
// `-progress pipe:1` (out_time_us) to compute a percentage. onPct is best-effort.
function extractWav16kMono(input, output, onPct) {
  const totalSec = probeDuration(input) || 0;
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000",
      "-progress", "pipe:1", "-nostats", output,
    ]);
    let err = "";
    let buf = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.stdout.on("data", (d) => {
      if (!onPct || totalSec <= 0) return;
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) {
          const sec = parseInt(m[1], 10) / 1e6;
          const pct = Math.max(1, Math.min(99, Math.round((sec / totalSec) * 100)));
          try { onPct(pct); } catch { /* ignore */ }
        }
      }
    });
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

// Cut one or more time ranges out of `input` and concat them into `output`,
// PRECISELY (frame-accurate re-encode via the trim/atrim + concat filter graph —
// works for single or multiple ranges, audio-only or video). Used by 创建片段.
function ffClip(input, ranges, isVideo, output) {
  return new Promise((resolve, reject) => {
    const parts = [];
    const labels = [];
    ranges.forEach((r, i) => {
      const s = round3(r.start), e = round3(r.end);
      if (isVideo) {
        parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
        parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
        labels.push(`[v${i}][a${i}]`);
      } else {
        parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
        labels.push(`[a${i}]`);
      }
    });
    const n = ranges.length;
    const concat = isVideo
      ? `${labels.join("")}concat=n=${n}:v=1:a=1[v][a]`
      : `${labels.join("")}concat=n=${n}:v=0:a=1[a]`;
    const filter = parts.concat(concat).join(";");
    const args = ["-y", "-i", input, "-filter_complex", filter];
    if (isVideo) args.push("-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-movflags", "+faststart", output);
    else args.push("-map", "[a]", "-c:a", "aac", output);
    const ff = spawn("ffmpeg", args);
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error("ffmpeg clip failed: " + err.slice(-2000)))));
    ff.on("error", reject);
  });
}

// Grab a single JPEG frame at time `t` from a video into `output` (used to auto-set
// a video clip's cover to its first frame).
function ffFrameJpeg(input, t, output) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-ss", String(round3(Math.max(0, t))), "-i", input, "-frames:v", "1", "-q:v", "3", output]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error("ffmpeg frame failed: " + err.slice(-800)))));
    ff.on("error", reject);
  });
}

// Rebuild a display string from word tokens: a space is inserted between two
// tokens only when both sides are latin/alphanumeric (CJK stays tight). Mirrors
// the client's needsSpaceBefore closely enough for clipped transcripts.
function joinWordsServer(words) {
  let s = "";
  for (let i = 0; i < words.length; i++) {
    const t = words[i].text || "";
    if (i > 0) {
      const prev = words[i - 1].text || "";
      if (/[A-Za-z0-9)\]]$/.test(prev) && /^[A-Za-z0-9(\[]/.test(t)) s += " ";
    }
    s += t;
  }
  return s;
}
// Keep the word tokens that overlap [rs,re], clamped to the window and rebased to
// the clip timeline (window start → `offset`).
function clipWords(words, rs, re, offset) {
  const arr = Array.isArray(words) ? words : [];
  const kept = [];
  for (const w of arr) {
    const ws = Number(w.start) || 0;
    const we = Number(w.end) || ws;
    if (we <= rs || ws >= re) continue;
    kept.push({
      text: String(w.text ?? ""),
      start: round3(Math.max(ws, rs) - rs + offset),
      end: round3(Math.min(we, re) - rs + offset),
    });
  }
  return kept;
}
// Derive a clip's transcript from the parent result by slicing every segment to the
// selected ranges and rebasing all timestamps onto the concatenated clip timeline.
// Speaker names / participants / language are inherited; the clip is then edited
// independently of the parent.
function deriveClipResult(parentResult, ranges) {
  const segsIn = (parentResult && parentResult.segments) || [];
  const out = [];
  let offset = 0;
  for (const r of ranges) {
    const rs = r.start, re = r.end;
    for (const seg of segsIn) {
      if (seg.end <= rs || seg.start >= re) continue; // no overlap with this range
      const hasWords = Array.isArray(seg.words) && seg.words.length > 0;
      let start, end, text, words;
      if (hasWords) {
        words = clipWords(seg.words, rs, re, offset);
        if (!words.length) continue;
        text = joinWordsServer(words);
        start = words[0].start;
        end = words[words.length - 1].end;
      } else {
        start = round3(Math.max(seg.start, rs) - rs + offset);
        end = round3(Math.min(seg.end, re) - rs + offset);
        if (end - start < 0.02) continue;
        text = seg.text || "";
        words = [];
      }
      const nseg = { start, end, speaker: seg.speaker, text, words };
      if (seg.translation) {
        const tw = clipWords(seg.twords, rs, re, offset);
        nseg.translation = tw.length ? joinWordsServer(tw) : seg.translation;
        nseg.twords = tw;
      }
      out.push(nseg);
    }
    offset += (re - rs);
  }
  out.sort((a, b) => a.start - b.start);
  const speakers = [...new Set(out.map((s) => s.speaker).filter(Boolean))];
  const parentParts = Array.isArray(parentResult && parentResult.participants) ? parentResult.participants : null;
  return {
    language: (parentResult && parentResult.language) || "auto",
    speakers,
    segments: out,
    speakerNames: (parentResult && parentResult.speakerNames) || {},
    speakerColors: (parentResult && parentResult.speakerColors) || {},
    // Keep only participants that actually appear in the clip, preserving order.
    participants: (parentParts ? parentParts.filter((p) => speakers.includes(p)) : speakers.slice()),
  };
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

// Text chat completion via the gateway's OpenAI /v1/chat/completions (mode=chat).
// Backs 智能摘要. Returns the assistant message string with Qwen3 <think> blocks
// stripped (we ask for /no_think but strip defensively so JSON parsing is clean).
async function gwChat(cfg, model, messages, { temperature = 0.3, maxTokens = 3000, signal, req } = {}) {
  const r = await fetch(gwUrl(cfg, "/v1/chat/completions"), {
    method: "POST",
    headers: { ...gwHeaders(cfg, { req }), "content-type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
    signal: signal ?? cfg._signal,
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`chat ${r.status}: ${String(t).slice(0, 300)}`);
  let content = j?.choices?.[0]?.message?.content ?? "";
  if (Array.isArray(content)) content = content.map((c) => (c?.text || "")).join("");
  return String(content).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// Text embeddings via the gateway's OpenAI /v1/embeddings (mode=embedding). Backs
// 智能问答 RAG. Returns one number[] vector per input (batched by the caller).
async function gwEmbed(cfg, model, inputs, { req, signal } = {}) {
  const r = await fetch(gwUrl(cfg, "/v1/embeddings"), {
    method: "POST",
    headers: { ...gwHeaders(cfg, { req }), "content-type": "application/json" },
    body: JSON.stringify({ model, input: inputs }),
    signal: signal ?? cfg._signal,
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`embeddings ${r.status}: ${String(t).slice(0, 300)}`);
  const data = j?.data || [];
  return data.map((d) => d.embedding || d.vector || []);
}

// ---------------------------------------------------------------------------
// 智能摘要 (Smart Summary) — prompt building + robust JSON extraction
// ---------------------------------------------------------------------------
function clockLabel(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(h > 0 ? m : m).padStart(2, "0"), rr = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

// Render the transcript as timestamped, speaker-labelled lines for the LLM.
// Speaker names use the user's custom names when set. Very long transcripts are
// truncated by a character budget (keeps head+tail) so we stay within context.
function buildSummaryInput(rec) {
  const result = rec.result || {};
  const segs = Array.isArray(result.segments) ? result.segments : [];
  const names = result.speakerNames || {};
  const nameOf = (spk) => (names[spk] || spk || "说话人").toString();
  const lines = segs.map((s) => `[${clockLabel(s.start)}] ${nameOf(s.speaker)}: ${(s.text || "").trim()}`);
  let transcript = lines.join("\n");
  const BUDGET = 24000; // ~ chars; keeps us within a ~32k-token context (4B model)
  if (transcript.length > BUDGET) {
    const head = transcript.slice(0, Math.floor(BUDGET * 0.7));
    const tail = transcript.slice(-Math.floor(BUDGET * 0.25));
    transcript = `${head}\n…（中间省略 ${transcript.length - head.length - tail.length} 字）…\n${tail}`;
  }
  const dur = segs.length ? Number(segs[segs.length - 1].end) || 0 : 0;
  const speakers = Array.from(new Set(segs.map((s) => nameOf(s.speaker))));
  return { transcript, dur, speakers };
}

function summaryMessages(rec) {
  const { transcript, dur, speakers } = buildSummaryInput(rec);
  // Schema is FIXED (all 6 sections the user picked). Times are SECONDS (float) into
  // the audio so the UI can click-to-seek. The model must reply with ONLY the JSON.
  const schema = `{
  "oneLine": "一句话总结（不超过40字）",
  "overview": "全文概要，2-4 句连贯文字",
  "chapters": [{"title":"话题标题","start":<秒,数字>,"end":<秒,数字>,"summary":"本节小结一句话"}],
  "keyPoints": [{"text":"关键要点","time":<秒,数字>}],
  "actionItems": [{"text":"待办事项","owner":"负责人名或空字符串","time":<秒,数字>}],
  "speakers": [{"name":"发言人名","points":"该发言人的观点/要点总结"}]
}`;
  const sys = [
    "你是会议纪要助手。基于带时间戳的转写文本，生成结构化的智能摘要。",
    "严格只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块围栏、不要 <think>。",
    "所有时间字段一律用“秒”为单位的数字（可带小数），取自行首 [时:分:秒] 标签换算的秒数，用于点击跳转。",
    "语言与转写文本保持一致（中文转写→中文摘要）。若某板块无内容，用空数组或空字符串。",
    "chapters 覆盖全程、不重叠；keyPoints/actionItems 精炼不重复；speakers 覆盖主要发言人。",
    "/no_think",
  ].join("\n");
  const user = [
    `会议时长约 ${clockLabel(dur)}（${Math.round(dur)} 秒）。发言人：${speakers.join("、") || "未知"}。`,
    "请严格按如下 JSON 结构输出（字段名不可改）：",
    schema,
    "",
    "转写文本（每行格式 [时:分:秒] 发言人: 内容）：",
    transcript,
  ].join("\n");
  return [ { role: "system", content: sys }, { role: "user", content: user } ];
}

// Pull the first balanced {...} JSON object out of a model reply (tolerates stray
// prose, ```json fences, and trailing text). Throws if none parses.
function extractSummaryJson(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/```(?:json)?/gi, "").trim();
  const start = s.indexOf("{");
  if (start < 0) throw new Error("模型未返回 JSON");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { const cand = s.slice(start, i + 1); return JSON.parse(cand); } }
  }
  throw new Error("模型返回的 JSON 不完整");
}

// Normalise the parsed summary into the fixed shape the UI expects (defensive
// against a model that omits/renames fields or returns strings where we want arrays).
function normalizeSummary(d) {
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  const str = (x) => (x == null ? "" : String(x));
  const arr = (x) => (Array.isArray(x) ? x : []);
  return {
    oneLine: str(d.oneLine),
    overview: str(d.overview),
    chapters: arr(d.chapters).map((c) => ({ title: str(c.title), start: num(c.start), end: num(c.end), summary: str(c.summary) })),
    keyPoints: arr(d.keyPoints).map((k) => ({ text: str(k.text), time: num(k.time) })),
    actionItems: arr(d.actionItems).map((a) => ({ text: str(a.text), owner: str(a.owner), time: num(a.time) })),
    speakers: arr(d.speakers).map((s) => ({ name: str(s.name), points: str(s.points) })),
  };
}

// ---------------------------------------------------------------------------
// 智能问答 / RAG — chunking, cosine retrieval, prompt building, index persistence
// ---------------------------------------------------------------------------

// Merge adjacent same-speaker segments into retrieval chunks (~maxChars each),
// keeping each chunk's start/end/speaker so citations can click-to-seek.
function buildQaChunks(rec, maxChars = 500) {
  const result = rec.result || {};
  const segs = Array.isArray(result.segments) ? result.segments : [];
  const names = result.speakerNames || {};
  const nameOf = (spk) => (names[spk] || spk || "说话人").toString();
  const chunks = [];
  let cur = null;
  for (const s of segs) {
    const spk = nameOf(s.speaker);
    const txt = (s.text || "").trim();
    if (!txt) continue;
    if (cur && cur.speaker === spk && cur.text.length + txt.length <= maxChars) {
      cur.text += (/[\u4e00-\u9fff]$/.test(cur.text) ? "" : " ") + txt;
      cur.end = Number(s.end) || cur.end;
    } else {
      if (cur) chunks.push(cur);
      cur = { text: txt, start: Number(s.start) || 0, end: Number(s.end) || 0, speaker: spk };
    }
    if (cur && cur.text.length >= maxChars) { chunks.push(cur); cur = null; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function qaIndexPath(id) { return path.join(QAINDEX_DIR, `${id}.json`); }
function readQaIndex(id) { try { return JSON.parse(fs.readFileSync(qaIndexPath(id), "utf8")); } catch { return null; } }
function writeQaIndex(id, idx) { fs.writeFileSync(qaIndexPath(id), JSON.stringify(idx)); }

// Embed all chunks (batched) and persist the vector index next to the record.
async function buildQaIndex(cfg, rec, embedModel, req) {
  const chunks = buildQaChunks(rec);
  if (!chunks.length) throw new Error("无可索引的转写内容");
  const vecs = [];
  const B = 32;
  for (let i = 0; i < chunks.length; i += B) {
    const batch = chunks.slice(i, i + B).map((c) => c.text);
    const vs = await gwEmbed(cfg, embedModel, batch, { req });
    vecs.push(...vs);
  }
  const dim = vecs[0]?.length || 0;
  const idx = { embedModel, dim, at: nowIso(), chunks: chunks.map((c, i) => ({ ...c, vec: vecs[i] || [] })) };
  writeQaIndex(rec.id, idx);
  return idx;
}

function qaMessages(question, ctx) {
  const sys = [
    "你是会议问答助手。只依据下面给出的『会议片段』回答用户问题，不要编造。",
    "每条关键结论后用方括号标注引用的片段号，如 [1]、[2]（可多个）。",
    "若片段中找不到答案，明确说明「根据记录未提及」，不要臆测。",
    "用与记录一致的语言（中文记录→中文作答），简洁清晰。",
    "/no_think",
  ].join("\n");
  const user = `会议片段：\n${ctx}\n\n问题：${question}\n\n请依据片段作答，并用 [片段号] 标注引用来源。`;
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

// ---------------------------------------------------------------------------
// GET /api/models — discover gateway models by CAPABILITY (supports) + mode
// ---------------------------------------------------------------------------
// Audio models are registered mode=audio with a model_spec.supports map of bare
// capability keys (stt/align/diar/enhance/…). The translate model is mode=chat
// with supports.translate. The light /provider-models endpoint DOESN'T return
// supports, so we list providers then GET each provider DETAIL (whose inline
// models carry supports) and group by capability. chat/embedding (摘要/问答/RAG)
// stay mode-based.
const AUDIO_CAPS = ["stt", "align", "diar", "enhance", "translate"];

// Read the capability keys off a model row (model_spec.supports {key:bool} map,
// possibly a raw JSON string; or a flat supports object/array). Truthy keys only.
function extractSupports(m) {
  let sup = m?.supports ?? m?.model_spec?.supports ?? m?.modelSpec?.supports;
  if (typeof m?.model_spec === "string") {
    try { sup = JSON.parse(m.model_spec)?.supports ?? sup; } catch { /* ignore */ }
  }
  if (!sup) return [];
  if (Array.isArray(sup)) return sup.map(String);
  if (typeof sup === "object") return Object.keys(sup).filter((k) => !!sup[k]);
  return [];
}

// A model serves a capability if its supports map contains the key (new audio
// arch), or — legacy fallback — its mode equals the key (old per-mode registrations).
function modelServesCap(m, cap) {
  if ((m.supports || []).includes(cap)) return true;
  return m.mode === cap;
}

app.get("/api/models", async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.base) return res.status(400).json({ error: "尚未配置网关地址", modes: {}, caps: {} });
  const headers = gwHeaders(cfg, { req });
  const isAuthRedirect = (r) => r.status === 0 || (r.status >= 301 && r.status <= 308) || r.type === "opaqueredirect";
  try {
    const rp = await fetch(gwUrl(cfg, "/console/api/providers"), { method: "GET", headers, redirect: "manual" });
    if (isAuthRedirect(rp)) {
      return res.status(401).json({ error: "网关未认证(被重定向到 SSO)。请检查 Cookie / API Key。", modes: {}, caps: {} });
    }
    const ptext = await rp.text();
    let pbody;
    try { pbody = JSON.parse(ptext); } catch { pbody = ptext; }
    if (!rp.ok) return res.status(502).json({ error: `providers ${rp.status}: ${String(ptext).slice(0, 200)}`, modes: {}, caps: {} });
    const provs = Array.isArray(pbody) ? pbody : pbody.items || pbody.data || pbody.providers || [];

    const all = [];
    for (const p of provs) {
      const pid = p.id ?? p.provider_id;
      if (!pid) continue;
      let detail;
      try {
        const rd = await fetch(gwUrl(cfg, `/console/api/providers/${pid}`), { method: "GET", headers, redirect: "manual" });
        if (!rd.ok) continue;
        const dt = await rd.text();
        try { detail = JSON.parse(dt); } catch { continue; }
      } catch { continue; } // one bad provider shouldn't fail the whole refresh
      const models = detail?.models || detail?.model || [];
      for (const m of models) {
        all.push({
          id: m.id ?? m.provider_model_id,
          name: m.name ?? m.model ?? m.id,
          mode: m.mode ?? detail?.mode,
          supports: extractSupports(m ?? {}),
          provider_name: detail?.name ?? p.name,
        });
      }
    }

    // caps: capability-based lists for the audio ops + translate dropdowns.
    const caps = {};
    for (const cap of AUDIO_CAPS) {
      caps[cap] = all
        .filter((m) => modelServesCap(m, cap))
        .map(({ id, name, provider_name }) => ({ id, name, provider_name }));
    }
    // modes: mode-based lists (chat/embedding drive 摘要/问答/RAG; kept for compat).
    const modes = {};
    for (const m of all) {
      if (!m.mode) continue;
      (modes[m.mode] = modes[m.mode] || []).push({ id: m.id, name: m.name, provider_name: m.provider_name });
    }
    res.json({ caps, modes });
  } catch (e) {
    console.error("[/api/models] fetch error:", e?.message, "cause:", e?.cause?.code || e?.cause?.message || e?.cause);
    res.status(502).json({ error: String(e.message || e), modes: {}, caps: {} });
  }
});

// ---------------------------------------------------------------------------
// GET/PUT /api/config
// ---------------------------------------------------------------------------
app.get("/api/config", (_req, res) => {
  const cfg = loadConfig();
  res.json({ ...cfg, ...configReady(cfg), version: appVersion() });
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
    summary: {
      model: (b.summary?.model ?? cur.summary?.model ?? "").toString(),
    },
    qa: {
      model: (b.qa?.model ?? cur.qa?.model ?? "").toString(),
      embedModel: (b.qa?.embedModel ?? cur.qa?.embedModel ?? "").toString(),
    },
    background: {
      enabled: Boolean(b.background?.enabled ?? cur.background?.enabled ?? false),
      dim: Math.max(0, Math.min(80, Number(b.background?.dim ?? cur.background?.dim ?? 40) || 0)),
      mime: (b.background?.mime ?? cur.background?.mime ?? "").toString(),
    },
  };
  saveConfig(next);
  res.json({ ...next, ...configReady(next), version: appVersion() });
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

// File extensions we treat as audio even when the browser's MIME is missing or
// wrong (empty / application/octet-stream / video/mp4 for .m4a, etc.). Anything
// NOT confirmed as audio is sent through ffmpeg extraction in the background.
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|wma|amr|aif|aiff|caf|mka|weba)$/i;
const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v|flv|wmv|mpe?g|ts|3gp|ogv)$/i;

// Wrap multer so a transport abort / size-limit / field error becomes a clean
// JSON response we can SEE (and log), instead of an unhandled error that leaves
// the connection to hang until the gateway resets it (surfaces as a bogus
// client-side "upload network error").
const uploadSingle = upload.single("file");
app.post("/api/upload", (req, res) => {
  const t0 = Date.now();
  const len = Number(req.headers["content-length"] || 0);
  console.log(`[upload] recv start len=${len || "?"}B ct=${req.headers["content-type"] || ""}`);
  uploadSingle(req, res, (err) => {
    if (err) {
      const code = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      console.error(`[upload] multer error after ${Date.now() - t0}ms:`, err.code || "", err.message);
      if (!res.headersSent) res.status(code).json({ error: String(err.message || err) });
      return;
    }
    handleUpload(req, res, t0);
  });
});

function handleUpload(req, res, t0) {
  if (!req.file) return res.status(400).json({ error: "no file" });
  const cfg = loadConfig();
  const id = randomUUID();
  const stored = req.file.path;
  const mime = req.file.mimetype || "";
  const originalName = Buffer.from(req.file.originalname || "", "latin1").toString("utf8");
  const isVideo = mime.startsWith("video/") || VIDEO_EXT.test(originalName);
  // Confirmed audio (by MIME or extension) can skip ffmpeg entirely; everything
  // else — video or an unknown container — gets extracted to 16k mono WAV.
  const isAudio = mime.startsWith("audio/") || AUDIO_EXT.test(originalName);
  const needsExtract = !isAudio;
  try {
    const audioPath = needsExtract ? path.join(UPLOAD_DIR, id + ".wav") : stored;
    const title = originalName.replace(/\.[^.]+$/, "") || "未命名";
    // IMPORTANT: this handler does NO blocking work — no ffprobe, no ffmpeg. Both
    // spawnSync (probe) and the ffmpeg transcode block the event loop / hold the
    // connection open, which is what tripped the gateway timeout before (even a
    // pure-audio upload stalled on the inline ffprobe). We persist a record and
    // reply instantly; a background prep job probes duration and (if needed)
    // extracts the audio as its own visible phase.
    const rec = {
      id,
      title,
      kind: isVideo ? "video" : "audio",
      originalName,
      mime,
      mediaPath: stored,
      audioPath,
      durationSec: null, // probed in the background prep job
      status: "preparing",
      progress: 1,
      phase: needsExtract ? "提取音频…" : "读取文件信息…",
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
    // Reply immediately; probe + (optional) extraction happen in the background.
    res.json(recordSummary(rec));
    console.log(`[upload] ok id=${id} kind=${rec.kind} extract=${needsExtract} in ${Date.now() - (t0 || Date.now())}ms`);
    enqueuePrep(id);
  } catch (e) {
    console.error("[upload] handler error:", e);
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
  }
}

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

// POST /api/records/:id/summary — generate 智能摘要 from the transcript using a
// chat-mode gateway model. Synchronous (4B is fast); result persisted on the record.
app.post("/api/records/:id/summary", async (req, res) => {
  const cfg = loadConfig();
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  if (rec.status !== "done" || !rec.result?.segments?.length) {
    return res.status(400).json({ error: "记录尚未完成转写，无法生成摘要" });
  }
  const model = (req.body?.model || cfg.summary?.model || "").toString();
  if (!model) return res.status(400).json({ error: "未选择智能摘要模型（请在设置中选择 chat 模型）" });
  if (!cfg.base) return res.status(400).json({ error: "尚未配置网关地址" });
  try {
    const raw = await gwChat(cfg, model, summaryMessages(rec), { req, maxTokens: 4000 });
    const data = normalizeSummary(extractSummaryJson(raw));
    rec.summary = { data, model, at: nowIso() };
    writeRecord(rec);
    res.json({ ...rec, hasCover: !!rec.cover, coverVer: rec.cover?.at || "" });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// DELETE /api/records/:id/summary — clear a generated summary.
app.delete("/api/records/:id/summary", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  delete rec.summary;
  writeRecord(rec);
  res.json({ ...rec, hasCover: !!rec.cover, coverVer: rec.cover?.at || "" });
});

// POST /api/records/:id/qa/index — (re)build the RAG vector index for a record
// using the configured embedding model. Idempotent; overwrites any prior index.
app.post("/api/records/:id/qa/index", async (req, res) => {
  const cfg = loadConfig();
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  if (rec.status !== "done" || !rec.result?.segments?.length) {
    return res.status(400).json({ error: "记录尚未完成转写，无法建立问答索引" });
  }
  const embedModel = (req.body?.embedModel || cfg.qa?.embedModel || "").toString();
  if (!embedModel) return res.status(400).json({ error: "未选择嵌入模型（请在设置中选择 embedding 模型）" });
  if (!cfg.base) return res.status(400).json({ error: "尚未配置网关地址" });
  try {
    const idx = await buildQaIndex(cfg, rec, embedModel, req);
    rec.qa = { ...(rec.qa || {}), indexedAt: idx.at, embedModel, chunkCount: idx.chunks.length, dim: idx.dim };
    if (!Array.isArray(rec.qa.history)) rec.qa.history = [];
    writeRecord(rec);
    res.json({ ...rec, hasCover: !!rec.cover, coverVer: rec.cover?.at || "" });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// POST /api/records/:id/qa — ask a question. Retrieves top-k chunks by cosine
// similarity, grounds a chat model on them, returns the answer + clickable citations.
// Auto-(re)builds the index when missing or built with a different embed model.
app.post("/api/records/:id/qa", async (req, res) => {
  const cfg = loadConfig();
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  if (rec.status !== "done" || !rec.result?.segments?.length) {
    return res.status(400).json({ error: "记录尚未完成转写，无法问答" });
  }
  const question = (req.body?.question || "").toString().trim();
  if (!question) return res.status(400).json({ error: "问题为空" });
  const chatModel = (req.body?.model || cfg.qa?.model || cfg.summary?.model || "").toString();
  const embedModel = (req.body?.embedModel || cfg.qa?.embedModel || "").toString();
  if (!chatModel) return res.status(400).json({ error: "未选择问答对话模型（请在设置中选择 chat 模型）" });
  if (!embedModel) return res.status(400).json({ error: "未选择嵌入模型（请在设置中选择 embedding 模型）" });
  if (!cfg.base) return res.status(400).json({ error: "尚未配置网关地址" });
  try {
    let idx = readQaIndex(rec.id);
    if (!idx || idx.embedModel !== embedModel || !idx.chunks?.length) {
      idx = await buildQaIndex(cfg, rec, embedModel, req);
      rec.qa = { ...(rec.qa || {}), indexedAt: idx.at, embedModel, chunkCount: idx.chunks.length, dim: idx.dim };
    }
    const [qv] = await gwEmbed(cfg, embedModel, [question], { req });
    if (!qv?.length) throw new Error("嵌入模型未返回向量");
    const scored = idx.chunks
      .map((c, i) => ({ i, c, s: cosine(qv, c.vec) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.min(6, idx.chunks.length));
    const ctx = scored.map((t, n) => `[${n + 1}] (${clockLabel(t.c.start)}) ${t.c.speaker}: ${t.c.text}`).join("\n");
    const answer = await gwChat(cfg, chatModel, qaMessages(question, ctx), { req, maxTokens: 1500 });
    const citations = scored.map((t, n) => ({
      n: n + 1, time: t.c.start, end: t.c.end, speaker: t.c.speaker,
      text: t.c.text.slice(0, 160), score: Number(t.s.toFixed(3)),
    }));
    const turn = { q: question, a: answer, model: chatModel, citations, at: nowIso() };
    rec.qa = rec.qa || {};
    if (!Array.isArray(rec.qa.history)) rec.qa.history = [];
    rec.qa.history.push(turn);
    if (rec.qa.history.length > 50) rec.qa.history = rec.qa.history.slice(-50);
    writeRecord(rec);
    res.json({ turn, qa: rec.qa });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// DELETE /api/records/:id/qa — clear the Q&A index + conversation history.
app.delete("/api/records/:id/qa", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  fs.rm(qaIndexPath(rec.id), { force: true }, () => {});
  delete rec.qa;
  writeRecord(rec);
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

// Manual edits from the transcript editor: per-segment text/translation, speaker
// display names (id → name), and the participant roster. Autosaved by the client
// after every change (undo/redo lives on the client). Word/twords timings are
// recomputed ONLY for segments whose text/translation actually changed, so untouched
// lines keep their real forced-alignment word times.
app.patch("/api/records/:id/result", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  if (!rec.result) return res.status(400).json({ error: "该记录尚无转写结果，无法编辑" });
  const b = req.body || {};
  const segs = rec.result.segments || [];
  if (Array.isArray(b.segments)) {
    for (let i = 0; i < segs.length && i < b.segments.length; i++) {
      const src = b.segments[i] || {};
      const seg = segs[i];
      // Sentence-unit editing sends precomputed `words`/`twords` (only changed
      // sentences were re-timed client-side); use them verbatim. Otherwise re-derive
      // char-proportional word timings from the new text (whole-segment).
      const cleanWords = (arr) =>
        (Array.isArray(arr) ? arr : [])
          .map((w) => ({ text: String(w?.text ?? ""), start: Number(w?.start) || 0, end: Number(w?.end) || 0 }))
          .filter((w) => w.text !== "");
      if (typeof src.text === "string" && (src.text !== seg.text || Array.isArray(src.words))) {
        seg.text = src.text;
        seg.words = Array.isArray(src.words) ? cleanWords(src.words) : spreadWords(src.text, seg.start, seg.end);
      }
      if (typeof src.translation === "string" && (src.translation !== (seg.translation || "") || Array.isArray(src.twords))) {
        seg.translation = src.translation;
        seg.twords = Array.isArray(src.twords) ? cleanWords(src.twords) : (src.translation ? spreadWords(src.translation, seg.start, seg.end) : []);
      }
      if (typeof src.speaker === "string" && src.speaker) seg.speaker = src.speaker;
    }
  }
  if (b.speakerNames && typeof b.speakerNames === "object") {
    const names = {};
    for (const [k, v] of Object.entries(b.speakerNames)) {
      if (typeof v === "string" && v.trim()) names[k] = v.trim();
    }
    rec.result.speakerNames = names;
  }
  if (Array.isArray(b.participants)) {
    rec.result.participants = b.participants.filter((x) => typeof x === "string");
  }
  if (b.speakerColors && typeof b.speakerColors === "object") {
    const colors = {};
    for (const [k, v] of Object.entries(b.speakerColors)) {
      if (typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v)) colors[k] = v;
    }
    rec.result.speakerColors = colors;
  }
  rec.updatedAt = nowIso();
  writeRecord(rec);
  res.json({ ...rec, hasCover: !!rec.cover, coverVer: rec.cover?.at || "" });
});

// Delete a single processing-record notice (by index) or clear them all. The
// card badge (⚠ N 条提示) reads from the same list, so removing entries clears it.
app.delete("/api/records/:id/notices/:idx", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  const idx = parseInt(req.params.idx, 10);
  if (Array.isArray(rec.notices) && idx >= 0 && idx < rec.notices.length) {
    rec.notices.splice(idx, 1);
    rec.updatedAt = nowIso();
    writeRecord(rec);
  }
  res.json({ ...rec, hasCover: !!rec.cover, coverVer: rec.cover?.at || "" });
});

app.delete("/api/records/:id/notices", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  rec.notices = [];
  rec.updatedAt = nowIso();
  writeRecord(rec);
  res.json({ ...rec, hasCover: !!rec.cover, coverVer: rec.cover?.at || "" });
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
// Detailed processing report — a DEBUG aid (remove before public release). Shows
// the exact alignment segments actually used and flags which ones fall inside an
// interpolated (collapsed-window) span, plus per-window align decisions, timings
// and notices. Open in a browser tab for a formatted page, or ?format=txt to
// download a plain-text dump. Same-origin GET → carries the Olares session cookie.
// ---------------------------------------------------------------------------
function debugReportData(rec) {
  const d = rec.debug || {};
  const align = d.align || null;
  const spans = Array.isArray(align?.interpSpans) ? align.interpSpans : [];
  const uncovered = Array.isArray(align?.uncoveredSpans) ? align.uncoveredSpans : [];
  const candidates = Array.isArray(align?.candidateSpans) ? align.candidateSpans : [];
  const segs = Array.isArray(rec.result?.segments) ? rec.result.segments : [];
  const names = rec.result?.speakerNames || {};
  const interpAt = (s) => spans.some((sp) => Math.min(+s.end, sp.b) - Math.max(+s.start, sp.a) > 0.05);
  const segRows = segs.map((s, i) => ({
    i: i + 1, start: +s.start || 0, end: +s.end || 0,
    speaker: names[s.speaker] || s.speaker || "", interp: interpAt(s),
    words: Array.isArray(s.words) ? s.words.length : 0, text: s.text || "",
  }));
  const interpCount = segRows.filter((r) => r.interp).length;
  const interpSecs = spans.reduce((n, sp) => n + Math.max(0, sp.b - sp.a), 0);
  const suspects = detectSuspects(segs);
  // 逐字时间戳：从最终 segments[].words 铺平（CJK 粒度即逐字）。给出每字 start/end、时长、
  // 距上一字的间隔，并标记「0s 堆叠」(接缝处飞掠) 与落在插值区间的字——用于人工可视化，
  // 好据此设计更好的插值（如向后插值：用后一字 start 作锚点反推被堆叠字的时间）。
  const charRows = [];
  {
    let gi = 0, prevEnd = null;
    const inSpan = (t, arr) => arr.some((sp) => t >= sp.a - 1e-3 && t <= sp.b + 1e-3);
    segs.forEach((s, si) => {
      (s.words || []).forEach((w) => {
        const st = +w.start || 0, en = +w.end || 0;
        charRows.push({
          gi: gi++, si: si + 1, text: w.text ?? "",
          start: round3(st), end: round3(en),
          durMs: Math.round((en - st) * 1000),
          gapMs: prevEnd == null ? null : Math.round((st - prevEnd) * 1000),
          piled: en - st < 0.02,
          interp: inSpan(st, spans),
          cram: false, giant: false, repair: false,
        });
        prevEnd = en;
      });
    });
  }
  // 逐字异常标注（诊断用）：
  //   • cram（非人类语速）：单字时长 ≤ max(60ms, 0.4×中位)——被压扁飞掠的字（含 0s 堆叠）。
  //   • giant（巨无霸）：单字时长 ≥ max(4s, 15×中位)——一个字吞掉好几秒。
  //   这两个是「原始症状」；重铺后症状消失，所以「修复区(紫)」不靠重算，而是读取重铺算法
  //   落盘的 align.repairSpans（权威）——按时间区间命中即紫，各处一致。
  {
    const durs = charRows.filter((c) => !c.piled && c.durMs > 0).map((c) => c.durMs).sort((a, b) => a - b);
    const med = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
    const giantMs = Math.max(4000, med * 15);
    const cramMs = Math.max(60, med * 0.4);
    for (const c of charRows) {
      if (c.durMs > 0 && c.durMs <= cramMs) c.cram = true;
      if (!c.piled && c.durMs >= giantMs) c.giant = true;
    }
  }
  const repairSpans = Array.isArray(align?.repairSpans) ? align.repairSpans : [];
  const inRepair = (t) => repairSpans.some((sp) => t >= sp.tStart - 1e-3 && t <= sp.tEnd + 1e-3);
  for (const c of charRows) if (inRepair(c.start)) c.repair = true;
  for (const r of segRows) r.repair = repairSpans.some((sp) => Math.min(r.end, sp.tEnd) - Math.max(r.start, sp.tStart) > 0.05);
  const piledChars = charRows.filter((c) => c.piled).length;
  const cramChars = charRows.filter((c) => c.cram).length;
  const giantChars = charRows.filter((c) => c.giant).length;
  const repairChars = charRows.filter((c) => c.repair).length;
  return { d, align, spans, uncovered, candidates, segRows, interpCount, interpSecs, suspects, charRows, piledChars, cramChars, giantChars, repairChars, repairSpans };
}

// A档·可视化：从最终词级时间反推「可疑对齐区间」，让 committed 里看不出来的问题现形。
// 纯启发式（无真值），基于 SPEECH-RATE 异常：
//   • 挤压(飞速掠过)：极短段却语速爆表（>3×全局速率），一整句被塞进一瞬。
//   • 疑似停滞/漂移：较长段语速异常慢（<0.4×全局速率），文字明显跟不上音频。
// 基准 R0 = 该文件「总可见字 / 总段时长」的加权平均（非中位数），避免语种/语速差异误报。
// committed uniform drift
// （整体平移、局部语速仍正常）此法测不出——那需要重叠共识(C)才能量化。
function visCharCount(t) { return ((t || "").match(/[\p{L}\p{N}]/gu) || []).length; }
function detectSuspects(segs) {
  const rows = [];
  for (const s of segs) {
    const dur = (+s.end || 0) - (+s.start || 0);
    const n = visCharCount(s.text);
    if (n >= 2 && dur > 0.01) rows.push({ start: +s.start, end: +s.end, dur, n, rate: n / dur, text: s.text || "" });
  }
  if (rows.length < 3) return [];
  // 全局参考速率 = 总可见字 / 总有效段时长（排除极短/空段的噪声）。
  const totN = rows.reduce((a, r) => a + r.n, 0), totD = rows.reduce((a, r) => a + r.dur, 0);
  const R0 = totN / Math.max(0.5, totD);
  const flagged = rows.map((r) => {
    let kind = null;
    if (r.dur < 2 && r.rate > 3 * R0) kind = "cram";
    else if (r.dur >= 2 && r.rate < 0.4 * R0) kind = "slow";
    return { ...r, kind };
  });
  // 合并相邻同类可疑段成一个区间，报告更紧凑。
  const out = [];
  for (const r of flagged) {
    if (!r.kind) continue;
    const last = out[out.length - 1];
    if (last && last.kind === r.kind && r.start - last.end <= 1.5) {
      last.end = r.end; last.n += r.n; last.dur += r.dur; last.text += " " + r.text;
    } else {
      out.push({ kind: r.kind, start: r.start, end: r.end, n: r.n, dur: r.dur, text: r.text });
    }
  }
  return out.map((r) => ({
    kind: r.kind, start: round3(r.start), end: round3(r.end),
    rate: Math.round((r.n / Math.max(0.01, r.dur)) * 10) / 10, ref: Math.round(R0 * 10) / 10,
    text: r.text.replace(/\s+/g, " ").trim(),
  }));
}
const mmss = (sec) => {
  let s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
};
function debugReportText(rec) {
  const { d, align, spans, uncovered, candidates, segRows, interpCount, interpSecs, suspects, charRows, piledChars, cramChars, giantChars, repairChars, repairSpans } = debugReportData(rec);
  const uncReason = (r) => (r === "badcand" ? "候选时间不合理→插值" : "无对齐候选");
  const suspKind = (k) => (k === "cram" ? "挤压·飞速掠过" : "疑似停滞/漂移");
  const L = [];
  L.push(`详细处理记录 — ${rec.title || rec.id}`);
  L.push("=".repeat(60));
  L.push(`记录ID       ${rec.id}`);
  L.push(`原文件       ${rec.originalName || "—"}`);
  L.push(`生成时间     ${d.builtAt || "—"}${d.version ? "  版本 " + d.version : ""}`);
  L.push(`转写模式     ${d.mode || "—"}`);
  L.push(`标点分句     ${d.punctuated === null || d.punctuated === undefined ? "—" : d.punctuated ? "是（按标点）" : "否（按停顿/说话人/长度）"}`);
  L.push(`语言 / 时长  ${d.language || "—"} / ${mmss(d.durationSec)}`);
  L.push(`模型 STT     ${d.models?.stt || "—"}`);
  L.push(`模型 对齐    ${d.models?.align || "—"}`);
  L.push(`模型 分离    ${d.models?.diar || "—"}`);
  L.push(`模型 翻译    ${d.models?.translate || "—"}`);
  L.push(`选项         分段转写=${d.options?.segmentedStt ? "开" : "关"} · 转写时翻译=${d.options?.translate ? "开" : "关"} · 降噪=${d.options?.enhance ? "开" : "关"} · 最多说话人=${d.options?.maxSpeakers ? d.options.maxSpeakers + "人" : "自动"}`);
  L.push(`分离窗口     ${d.diarWindows ?? "—"} 段`);
  L.push(`整段STT字数  ${d.sttChars || 0}   对齐单元 ${d.unitCount || 0}   最终分段 ${d.segCount ?? segRows.length}`);
  if (d.fallbackError) L.push(`回退原因     ${d.fallbackError}`);
  L.push("");
  const tim = d.timings || rec.timings;
  if (tim?.steps?.length) {
    L.push("阶段耗时");
    L.push("-".repeat(60));
    for (const s of tim.steps) L.push(`  ${String(s.name).padEnd(16)} ${fmtMs(s.ms)}`);
    L.push(`  ${"合计".padEnd(16)} ${fmtMs(tim.totalMs)}`);
    L.push("");
  }
  L.push("对齐诊断");
  L.push("-".repeat(60));
  if (!align) {
    L.push("  （本次未走整段 alignLong 路径，无逐窗对齐轨迹）");
  } else {
    L.push(`  初始窗=${align.winInit}s 安全区=${align.safe}s 最小窗=${align.minWin}s`);
    L.push(`  缩窗次数=${align.shrinks}  降级/插值窗=${align.degraded}  插值区间=${spans.length} 段  插值总时长≈${mmss(interpSecs)}`);
    if (align.totalChars != null) {
      const uc = align.uncoveredChars || 0;
      L.push(`  字符覆盖   总 ${align.totalChars} 字 · 真实对齐+候选救回 ${align.coveredChars ?? "—"} 字（其中候选救回 ${align.rescuedChars || 0} 字）· 无对齐候选(纯插值) ${uc} 字 / ${uncovered.length} 段${uc ? "  ⚠" : "  ✓"}`);
    }
    L.push("");
    L.push(`  ${"#".padStart(3)} ${"区间".padEnd(15)} ${"窗长".padStart(5)} ${"单元".padStart(5)} ${"covA".padStart(6)} ${"covC".padStart(6)} ${"匹配".padStart(5)}  结果`);
    for (const r of align.rows || []) {
      const rng = `${mmss(r.a)}→${mmss(r.b)}`;
      L.push(`  ${String(r.pass).padStart(3)} ${rng.padEnd(15)} ${String(r.winLen).padStart(4)}s ${String(r.n).padStart(5)} ${(r.covA == null ? "-" : r.covA + "s").padStart(6)} ${(r.covC == null ? "-" : String(r.covC)).padStart(6)} ${(r.matchRate == null ? "-" : r.matchRate.toFixed(2)).padStart(5)}  ${r.outcome}`);
    }
    if (spans.length) {
      L.push("");
      L.push("  插值区间（这些音频时间段的字幕时间为估算，可能不准）:");
      for (const sp of spans) L.push(`    ${mmss(sp.a)} – ${mmss(sp.b)}  (${Math.round(sp.b - sp.a)}s, ${sp.reason})`);
    }
    if (candidates.length) {
      L.push("");
      L.push("  采用候选时间的字/词（时间取自其它对齐尝试的候选，非本窗真实对齐，可能飘移）:");
      for (const u of candidates) {
        const t = (u.text || "").replace(/\s+/g, " ");
        const shown = t.length > 60 ? t.slice(0, 60) + "…" : t;
        L.push(`    ${mmss(u.tStart)}–${mmss(u.tEnd)}  字[${u.c0}–${u.c1})  「${shown}」`);
      }
    }
    if (uncovered.length) {
      L.push("");
      L.push("  ⚠ 未获真实对齐的字/词（已线性插值兜底，需人工核对）:");
      for (const u of uncovered) {
        const t = (u.text || "").replace(/\s+/g, " ");
        const shown = t.length > 60 ? t.slice(0, 60) + "…" : t;
        const cand = u.candStart != null ? `  候选建议${mmss(u.candStart)}–${mmss(u.candEnd)}` : "";
        L.push(`    [${uncReason(u.reason)}] 字[${u.c0}–${u.c1}) ${u.c1 - u.c0}字  用时${mmss(u.tStart)}–${mmss(u.tEnd)}${cand}  「${shown}」`);
      }
    }
    if (repairSpans.length) {
      L.push("");
      L.push("  ★ 重对齐区（未获真实=触发；与飞掠重叠则扩到突变spike；紫色标注）:");
      for (const r of repairSpans) {
        const t = (r.text || "").replace(/\s+/g, " ").trim();
        const shown = t.length > 140 ? t.slice(0, 140) + "…" : t;
        const way = r.method === "realign" ? (r.kind === "debt" ? "重对齐·还债" : "重对齐·未获真实") : (r.method === "uniform" ? "均匀兜底(重对齐又塌)" : "启发式兜底");
        const spk = r.spikeText ? `  债spike「${(r.spikeText || "").trim()}」${r.spikeSecs ? "=" + r.spikeSecs + "s" : ""}` : "";
        L.push(`    字[${r.c0}–${r.c1}) ${r.c1 - r.c0}字  重铺至 ${mmss(r.tStart)}–${mmss(r.tEnd)} [${way}]${spk}  「${shown}」`);
      }
    }
  }
  if (suspects.length) {
    L.push("");
    L.push(`可疑对齐区间（按词级时间的语速异常自动检出 · ${suspects.length} 段 · 启发式，需人工核对）`);
    L.push("-".repeat(60));
    for (const s of suspects) {
      const t = s.text.length > 54 ? s.text.slice(0, 54) + "…" : s.text;
      L.push(`  [${suspKind(s.kind)}] ${mmss(s.start)}–${mmss(s.end)}  语速${s.rate}字/秒(基准${s.ref})  「${t}」`);
    }
    L.push("  注：挤压=一整句被压进一瞬（飞速掠过）；停滞/漂移=语速异常慢，文字跟不上音频。");
    L.push("      整体平移式漂移（局部语速正常）此表测不出，需重叠共识(C档)才能量化。");
  }
  L.push("");
  L.push(`最终分段（共 ${segRows.length} 段，其中 ${interpCount} 段落在插值区间，行首标 ⚠）`);
  L.push("-".repeat(60));
  for (const r of segRows) {
    const flag = r.repair ? "★" : r.interp ? "⚠" : " ";
    L.push(`${flag} ${String(r.i).padStart(4)} [${mmss(r.start)}→${mmss(r.end)}] ${(r.speaker || "").padEnd(10)} ${r.text}`);
  }
  if (charRows.length) {
    L.push("");
    L.push(`逐字时间戳（${charRows.length} 字 · ★=停顿债重铺块(紫) · P=0s堆叠 · C=非人类语速 · G=巨无霸 · I=插值区间 · start→end 秒、时长/间隔 毫秒）`);
    L.push("-".repeat(60));
    for (const c of charRows) {
      const fl = c.repair ? "*" : c.piled ? "P" : c.giant ? "G" : c.cram ? "C" : c.interp ? "I" : " ";
      const gap = c.gapMs == null ? "  —" : String(c.gapMs);
      L.push(`  ${fl} ${String(c.gi).padStart(5)} 段${String(c.si).padStart(4)}  ${c.start.toFixed(3)}→${c.end.toFixed(3)}  ${String(c.durMs).padStart(5)}ms  gap${gap.padStart(6)}  「${c.text}」`);
    }
  }
  L.push("");
  const notices = Array.isArray(rec.notices) ? rec.notices : [];
  L.push(`处理提示（${notices.length} 条）`);
  L.push("-".repeat(60));
  for (const n of notices) L.push(`  [${n.level || "info"}] ${n.msg || n.text || ""}`);
  return L.join("\n");
}
function debugReportHtml(rec) {
  const { d, align, spans, uncovered, candidates, segRows, interpCount, interpSecs, suspects, charRows, piledChars, cramChars, giantChars, repairChars, repairSpans } = debugReportData(rec);
  const uncReason = (r) => (r === "badcand" ? "候选时间不合理→插值" : "无对齐候选");
  const suspKind = (k) => (k === "cram" ? "挤压·飞速掠过" : "疑似停滞/漂移");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
  const tim = d.timings || rec.timings || {};
  const steps = (tim.steps || []).map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${esc(fmtMs(s.ms))}</td></tr>`).join("");
  const rowsHtml = align ? (align.rows || []).map((r) => {
    const interp = /插值/.test(r.outcome);
    const shrink = /缩窗/.test(r.outcome);
    return `<tr class="${interp ? "bad" : shrink ? "warn" : ""}"><td class="num">${r.pass}</td><td>${mmss(r.a)}→${mmss(r.b)}</td><td class="num">${r.winLen}s</td><td class="num">${r.n}</td><td class="num">${r.covA == null ? "–" : r.covA + "s"}</td><td class="num">${r.covC == null ? "–" : r.covC}</td><td class="num">${r.matchRate == null ? "–" : r.matchRate.toFixed(2)}</td><td>${esc(r.outcome)}</td></tr>`;
  }).join("") : "";
  const spansHtml = spans.map((sp) => `<li><code>${mmss(sp.a)} – ${mmss(sp.b)}</code> · ${Math.round(sp.b - sp.a)}s · ${esc(sp.reason)}</li>`).join("");
  const uncovChars = align?.uncoveredChars || 0;
  const uncovHtml = uncovered.map((u) => { const t = (u.text || "").replace(/\s+/g, " "); const cand = u.candStart != null ? `${mmss(u.candStart)}–${mmss(u.candEnd)}` : "—"; return `<tr><td>${esc(uncReason(u.reason))}</td><td class="num">${u.c0}–${u.c1}</td><td class="num">${u.c1 - u.c0}</td><td>${mmss(u.tStart)}–${mmss(u.tEnd)}</td><td class="num">${cand}</td><td>${esc(t)}</td></tr>`; }).join("");
  const candHtml = candidates.map((u) => { const t = (u.text || "").replace(/\s+/g, " "); return `<tr><td>${mmss(u.tStart)}–${mmss(u.tEnd)}</td><td class="num">${u.c0}–${u.c1}</td><td>${esc(t)}</td></tr>`; }).join("");
  const segHtml = segRows.map((r) => `<tr class="${r.repair ? "repair" : r.interp ? "bad" : ""}"><td class="num">${r.i}</td><td class="num">${r.repair ? "★" : r.interp ? "⚠" : ""}</td><td>${mmss(r.start)}→${mmss(r.end)}</td><td class="num">${Math.round(r.end - r.start)}s</td><td>${esc(r.speaker)}</td><td>${esc(r.text)}</td></tr>`).join("");
  const repairMethod = (r) => r.method === "realign" ? (r.kind === "debt" ? "重对齐·还债" : "重对齐·未获真实") : (r.method === "uniform" ? "均匀兜底(重对齐又塌)" : "启发式(兜底)");
  const repairHtml = repairSpans.map((r) => { const t = (r.text || "").replace(/\s+/g, " "); return `<tr class="repair"><td class="num">${r.c0}–${r.c1}</td><td class="num">${r.c1 - r.c0}</td><td>${mmss(r.tStart)}–${mmss(r.tEnd)}</td><td>${repairMethod(r)}</td><td>${r.spikeText ? esc((r.spikeText || "").trim()) + (r.spikeSecs ? " =" + r.spikeSecs + "s" : "") : "—"}</td><td>${esc(t)}</td></tr>`; }).join("");
  const suspHtml = suspects.map((s) => `<tr class="${s.kind === "cram" ? "bad" : "warn"}"><td>${esc(suspKind(s.kind))}</td><td>${mmss(s.start)}–${mmss(s.end)}</td><td class="num">${s.rate}/${s.ref}</td><td>${esc(s.text.length > 80 ? s.text.slice(0, 80) + "…" : s.text)}</td></tr>`).join("");
  const charHtml = charRows.map((c) => `<tr class="${c.repair ? "repair" : c.giant ? "giant" : c.piled ? "bad" : c.cram ? "cram" : c.interp ? "warn" : ""}"><td class="num">${c.gi}</td><td class="num">${c.si}</td><td>${esc(c.text)}</td><td class="num">${c.start.toFixed(3)}</td><td class="num">${c.end.toFixed(3)}</td><td class="num">${c.durMs}</td><td class="num">${c.gapMs == null ? "" : c.gapMs}</td></tr>`).join("");
  const notices = (rec.notices || []).map((n) => `<li class="lv-${esc(n.level || "info")}"><b>${esc(n.level || "info")}</b> ${esc(n.msg || n.text || "")}</li>`).join("");
  const pill = d.punctuated === null || d.punctuated === undefined ? "—" : d.punctuated ? "按标点" : "按停顿/说话人/长度";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>详细处理记录 · ${esc(rec.title || rec.id)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0b0e;color:#e5e5e5;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:20px 20px 80px}
h1{font-size:18px;margin:0 0 2px}
h2{font-size:14px;margin:26px 0 8px;color:#9ca3af;border-bottom:1px solid #23232a;padding-bottom:6px}
.sub{color:#8b8b93;font-size:12px;margin-bottom:14px}
.bar{position:sticky;top:0;background:#0b0b0eee;backdrop-filter:blur(6px);padding:10px 0;margin:-20px 0 0;border-bottom:1px solid #23232a;z-index:5;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.bar a{color:#0b0b0e;background:#38bdf8;text-decoration:none;padding:5px 12px;border-radius:6px;font-weight:600;font-size:12px}
.bar .note{color:#f59e0b;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:2px 20px}
.kv{display:flex;gap:8px;padding:2px 0}
.kv .k{color:#7c7c85;min-width:88px}
.kv .v{color:#e5e5e5;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #1c1c22;vertical-align:top}
th{color:#8b8b93;font-weight:600;position:sticky;top:44px;background:#0b0b0e}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:#c7c7cf}
tr.bad td{background:#3a1a1a}
tr.warn td{background:#3a301a}
tr.giant td{background:#1a2a3a}
tr.cram td{background:#33221a}
tr.repair td{background:#2e1a3a;box-shadow:inset 3px 0 0 #c084fc}
code{background:#17171d;padding:1px 5px;border-radius:4px}
.badge{display:inline-block;background:#17171d;border:1px solid #2a2a33;border-radius:999px;padding:1px 9px;margin-left:6px;font-size:11px}
.bad-badge{color:#fca5a5;border-color:#7f1d1d}
ul{margin:6px 0;padding-left:20px}
.lv-warn{color:#fbbf24}.lv-error{color:#f87171}
.empty{color:#6b7280;padding:8px 0}
</style></head><body><div class="wrap">
<div class="bar">
  <a href="?format=txt" download>⬇ 下载 TXT</a>
  <span class="note">调试用页面 · 正式发布前移除</span>
</div>
<h1>详细处理记录 <span class="badge">${esc(rec.kind === "video" ? "视频" : "音频")}</span>${repairSpans.length ? `<span class="badge" style="color:#c084fc;border-color:#6b21a8">★ ${repairSpans.length} 处重对齐</span>` : ""}${interpCount ? `<span class="badge bad-badge">⚠ ${interpCount} 段落在插值区间</span>` : ""}${uncovChars ? `<span class="badge bad-badge">⚠ ${uncovChars} 字无对齐时间戳</span>` : ""}</h1>
<div class="sub">${esc(rec.title || rec.id)} · 生成于 ${esc(d.builtAt || "—")}${d.version ? " · 版本 " + esc(d.version) : ""}</div>

<h2>概览</h2>
<div class="grid">
${kv("记录ID", esc(rec.id))}
${kv("原文件", esc(rec.originalName || "—"))}
${kv("转写模式", esc(d.mode || "—"))}
${kv("分句方式", esc(pill))}
${kv("语言 / 时长", esc(d.language || "—") + " / " + mmss(d.durationSec))}
${kv("STT 模型", esc(d.models?.stt || "—"))}
${kv("对齐模型", esc(d.models?.align || "—"))}
${kv("分离模型", esc(d.models?.diar || "—"))}
${kv("翻译模型", esc(d.models?.translate || "—"))}
${kv("选项", `分段=${d.options?.segmentedStt ? "开" : "关"} · 翻译=${d.options?.translate ? "开" : "关"} · 降噪=${d.options?.enhance ? "开" : "关"} · 最多说话人=${d.options?.maxSpeakers ? d.options.maxSpeakers + "人" : "自动"}`)}
${kv("分离窗口", (d.diarWindows ?? "—") + " 段")}
${kv("STT字数/单元/分段", `${d.sttChars || 0} / ${d.unitCount || 0} / ${d.segCount ?? segRows.length}`)}
${d.fallbackError ? kv("回退原因", `<span style="color:#f87171">${esc(d.fallbackError)}</span>`) : ""}
</div>

<h2>阶段耗时</h2>
${steps ? `<table><thead><tr><th>阶段</th><th class="num">用时</th></tr></thead><tbody>${steps}<tr><td><b>合计</b></td><td class="num"><b>${esc(fmtMs(tim.totalMs || 0))}</b></td></tr></tbody></table>` : `<div class="empty">无耗时数据</div>`}

<h2>对齐诊断</h2>
${align ? `<div class="sub">初始窗 ${align.winInit}s · 安全区 ${align.safe}s · 最小窗 ${align.minWin}s · 缩窗 ${align.shrinks} 次 · 降级/插值窗 ${align.degraded} · 插值区间 ${spans.length} 段（≈${mmss(interpSecs)}）${align.totalChars != null ? ` · 字符覆盖 ${align.coveredChars}/${align.totalChars}（候选救回 ${align.rescuedChars || 0} 字，纯插值 ${uncovChars} 字）${uncovChars ? " ⚠" : " ✓"}` : ""}</div>
<table><thead><tr><th class="num">#</th><th>音频区间</th><th class="num">窗长</th><th class="num">单元</th><th class="num">covA</th><th class="num">covC</th><th class="num">匹配率</th><th>结果</th></tr></thead><tbody>${rowsHtml}</tbody></table>
${spans.length ? `<h3 style="font-size:13px;color:#fca5a5;margin:14px 0 4px">插值区间（此段时间为估算，字幕可能不准）</h3><ul>${spansHtml}</ul>` : ""}
${candidates.length ? `<h3 style="font-size:13px;color:#fcd34d;margin:14px 0 4px">采用候选时间的字/词（时间取自其它对齐尝试的候选，非本窗真实对齐，可能飘移）</h3><table><thead><tr><th>估算时间</th><th class="num">字符区间</th><th>文本</th></tr></thead><tbody>${candHtml}</tbody></table>` : ""}
${uncovered.length ? `<h3 style="font-size:13px;color:#fca5a5;margin:14px 0 4px">⚠ 未获真实对齐的字/词（已线性插值兜底，需人工核对）</h3><div class="sub">「候选建议」=被拒候选原本想放的时间；若它明显超出「估算时间」的右界，说明是右接缝(下一committed单元)塌了/太早，候选其实更可信 → 应向后扩锚重插。</div><table><thead><tr><th>原因</th><th class="num">字符区间</th><th class="num">字数</th><th>估算时间</th><th class="num">候选建议</th><th>文本</th></tr></thead><tbody>${uncovHtml}</tbody></table>` : ""}
${repairSpans.length ? `<h3 style="font-size:13px;color:#c084fc;margin:14px 0 4px">★ 重对齐区（触发=未获真实时间戳；与飞掠重叠则扩到突变spike）</h3><div class="sub"><b>触发器只有「未获真实时间戳」的字</b>（resolveCoverage 只能线性插值的洞）。每段未获真实区取<b>自己的音频切片</b>喂回对齐器拿真实逐字时间（重对齐·未获真实）；若它与「飞掠区」重叠，则窗口右扩过 飞掠+伪正常 直到「突变spike」末端（那才是可信右锚），标为<b>重对齐·还债</b>。切片对齐失败：还债窗回退<b>启发式(兜底)</b>，纯未获真实窗保留原插值。<b>只改窗内的字，窗外一律不动</b>；两端为 committed 真锚点，零级联。成功重对齐的区间会从上面的「未获真实」告警中移除。紫色标注全篇一致。</div><table><thead><tr><th class="num">字符区间</th><th class="num">字数</th><th>重铺至</th><th>方式</th><th>飞掠spike</th><th>文本</th></tr></thead><tbody>${repairHtml}</tbody></table>` : ""}` : `<div class="empty">本次未走整段 alignLong 路径（分段转写或回退），无逐窗对齐轨迹。</div>`}

<h2>可疑对齐区间（语速异常自动检出 · ${suspects.length} 段）</h2>
${suspects.length ? `<div class="sub">启发式，需人工核对：<b style="color:#fca5a5">挤压·飞速掠过</b>=一整句被压进一瞬；<b style="color:#fbbf24">疑似停滞/漂移</b>=语速异常慢。整体平移式漂移（局部语速正常）此表测不出，需重叠共识(C档)量化。</div>
<table><thead><tr><th>类型</th><th>时间</th><th class="num">语速/基准</th><th>文本</th></tr></thead><tbody>${suspHtml}</tbody></table>` : `<div class="empty">未检出语速异常区间。（注：整体平移式漂移此法测不出。）</div>`}

<h2>逐字时间戳（${charRows.length} 字${repairChars ? ` · <span style="color:#c084fc">${repairChars} 字 修复区</span>` : ""}${piledChars ? ` · <span style="color:#fca5a5">${piledChars} 字 0s堆叠</span>` : ""}${giantChars ? ` · <span style="color:#7dd3fc">${giantChars} 字 巨无霸</span>` : ""}）</h2>
${charRows.length ? `<div class="sub"><b style="color:#c084fc">紫（左边框）=停顿债重铺块</b>：飞掠run+下游债spike 已整块重排后的最终结果（来自 align.repairSpans，全篇一致）。<b style="color:#fca5a5">红=0s堆叠</b>（&lt;20ms）；<b style="color:#f0a868">橙=非人类语速</b>（≤max(60ms,0.4×中位)，重铺后应基本消失）；<b style="color:#7dd3fc">蓝=巨无霸</b>（≥max(4s,15×中位)，重铺后应基本消失）；<b style="color:#fbbf24">黄=落在插值区间</b>。若重铺后仍见红/蓝残留，说明该处未命中模式（如抢话/重叠）。</div>
<details open><summary style="cursor:pointer;color:#93c5fd;margin-bottom:8px">展开 / 收起逐字表</summary>
<table><thead><tr><th class="num">#</th><th class="num">段</th><th>字</th><th class="num">start</th><th class="num">end</th><th class="num">时长ms</th><th class="num">距上字ms</th></tr></thead><tbody>${charHtml}</tbody></table>
</details>` : `<div class="empty">无逐字时间戳数据。</div>`}

<h2>最终分段（${segRows.length} 段 · ⚠ ${interpCount} 段插值）</h2>
<table><thead><tr><th class="num">#</th><th class="num">插值</th><th>时间</th><th class="num">时长</th><th>说话人</th><th>文本</th></tr></thead><tbody>${segHtml}</tbody></table>

<h2>处理提示（${(rec.notices || []).length} 条）</h2>
${notices ? `<ul>${notices}</ul>` : `<div class="empty">无</div>`}
</div></body></html>`;
}
app.get("/api/records/:id/debug", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).send("not found");
  if ((req.query.format || "") === "txt") {
    res.type("text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="debug-${rec.id}.txt"`);
    return res.send(debugReportText(rec));
  }
  res.type("text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.send(debugReportHtml(rec));
});

// ---------------------------------------------------------------------------
// Transcribe pipeline (async) : diar -> per-window (stt + align) -> fuse
// ---------------------------------------------------------------------------
// Serial job queue: only ONE record transcribes at a time. Diarization/STT hit
// a shared gateway/GPU, so running several jobs at once starves them all (records
// stall together at 3%). Jobs are therefore queued FIFO and drained one by one.
const running = new Set(); // the single id currently processing (in-process guard)
const queue = [];          // ids waiting their turn (FIFO)
const jobKinds = new Map(); // id -> "full" | "translate" | "rediarize"
const rediarTargets = new Map(); // id -> target speaker count for a rediarize job
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

// Move a record into the full-transcription queue. Shared by the /transcribe
// endpoint and by the audio-extraction (prep) job when the upload asked to
// auto-transcribe but had to wait for ffmpeg to finish first.
function startTranscribeJob(rec) {
  rec.status = "processing";
  rec.progress = 1;
  rec.phase = "排队中";
  rec.error = "";
  rec.jobKind = "full";
  rec.notices = [];
  delete rec.timings;
  delete rec.pendingTranscribe;
  writeRecord(rec);
  enqueueJob(rec.id);
}

// --- 音频提取 (prep) ----------------------------------------------------------
// Uploaded video / non-audio files need a 16k mono WAV before transcription. We
// used to do this INSIDE the upload request, which held the HTTP connection open
// for the whole ffmpeg run — large videos then tripped the Olares gateway's
// idle/timeout and surfaced as a client-side "upload network error", even though
// the bytes had already arrived. Now the upload returns immediately and this
// serial queue extracts the audio as its OWN visible phase ("提取音频"), which is
// deliberately NOT part of the transcription step timings.
const prepQueue = [];
let prepDraining = false;
function enqueuePrep(id) {
  prepQueue.push(id);
  pumpPrep();
}
async function pumpPrep() {
  if (prepDraining) return;
  const id = prepQueue.shift();
  if (id === undefined) return;
  prepDraining = true;
  try { await runPrepJob(id); } catch { /* runPrepJob persists its own error */ }
  finally { prepDraining = false; pumpPrep(); }
}
async function runPrepJob(id) {
  const rec = readRecord(id);
  if (!rec) return;
  const t0 = Date.now();
  // audioPath differs from mediaPath only when we planned an extraction at upload.
  const needsExtract = rec.audioPath && rec.audioPath !== rec.mediaPath;
  try {
    rec.status = "preparing";
    rec.error = "";
    if (needsExtract) {
      if (!hasFfmpeg()) throw new Error("ffmpeg 不可用，无法提取音频");
      rec.phase = "提取音频…";
      rec.progress = 1;
      writeRecord(rec);
      await extractWav16kMono(rec.mediaPath, rec.audioPath, (pct) => {
        const r = readRecord(id);
        if (!r || r.status !== "preparing") return;
        r.progress = pct;
        r.phase = `提取音频… ${pct}%`;
        writeRecord(r);
      });
    } else {
      rec.phase = "读取文件信息…";
      rec.progress = 50;
      writeRecord(rec);
    }
    const r = readRecord(id) || rec;
    // Probe here (background) — NOT on the upload request — so a slow/large probe
    // never blocks the event loop or the upload response.
    r.durationSec = probeDuration(needsExtract ? r.audioPath : r.mediaPath) ?? r.durationSec;
    r.status = "uploaded";
    r.progress = 0;
    r.phase = "";
    r.error = "";
    writeRecord(r);
    if (needsExtract) addNotice(id, "info", `音频提取完成（用时 ${fmtMs(Date.now() - t0)}）`);
    // Honour an upload that asked to auto-transcribe but had to wait for us.
    if (r.pendingTranscribe) startTranscribeJob(readRecord(id) || r);
  } catch (e) {
    const r = readRecord(id) || rec;
    r.status = "error";
    r.error = (needsExtract ? "音频提取失败：" : "文件预处理失败：") + String(e.message || e);
    r.phase = "";
    r.progress = 0;
    delete r.pendingTranscribe;
    writeRecord(r);
    addNotice(id, "error", r.error);
  }
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
    else if (kind === "rediarize") await runRediarizeJob(id, rediarTargets.get(id) || 0);
    else await runJob(id);
  } catch {
    /* runJob persists its own terminal status/error */
  } finally {
    draining = false;
    pump();
  }
}

// --- 创建片段 (clip) generation ------------------------------------------------
// Clip generation is pure local ffmpeg (cut+concat) + transcript slicing — it does
// NOT touch the gateway/GPU, so it runs on its OWN serial queue (avoids CPU thrash
// from many clips at once, without blocking transcription jobs).
const clipQueue = [];
let clipDraining = false;
function enqueueClip(id) {
  clipQueue.push(id);
  pumpClip();
}
async function pumpClip() {
  if (clipDraining) return;
  const id = clipQueue.shift();
  if (id === undefined) return;
  clipDraining = true;
  try { await runClipJob(id); } catch { /* runClipJob persists its own error */ }
  finally { clipDraining = false; pumpClip(); }
}
async function runClipJob(id) {
  const rec = readRecord(id);
  if (!rec || !rec.clipOf) return;
  try {
    const parent = readRecord(rec.clipOf);
    if (!parent) throw new Error("原记录不存在");
    if (!parent.mediaPath || !fs.existsSync(parent.mediaPath)) throw new Error("原始媒体文件缺失");
    if (!hasFfmpeg()) throw new Error("ffmpeg 不可用，无法生成片段");
    const isVideo = rec.kind === "video";
    const outMedia = path.join(UPLOAD_DIR, id + "-clip" + (isVideo ? ".mp4" : ".m4a"));
    await ffClip(parent.mediaPath, rec.clipRanges, isVideo, outMedia);
    rec.mediaPath = outMedia;
    // 16k mono wav for schema consistency (clips never transcribe, so it's a spare).
    try {
      const wav = path.join(UPLOAD_DIR, id + ".wav");
      await toWav16kMono(outMedia, wav);
      rec.audioPath = wav;
    } catch { rec.audioPath = outMedia; }
    rec.durationSec = probeDuration(outMedia) ?? rec.durationSec;
    rec.result = deriveClipResult(parent.result, rec.clipRanges);
    // Auto-cover for video clips: grab the clip's first frame. The user can change it
    // later via 设置封面 (which overwrites covers/<id>.jpg). Non-fatal on failure.
    if (isVideo && !rec.cover) {
      try { await ffFrameJpeg(outMedia, 0.2, coverPath(id)); rec.cover = { at: nowIso() }; } catch { /* keep default tile */ }
    }
    rec.status = "done";
    rec.progress = 100;
    rec.phase = "";
    rec.error = "";
    writeRecord(rec);
    addNotice(id, "info", `片段生成完成（${rec.continuous ? "连续片段" : "非连续片段"}，${rec.clipRanges.length} 段，共 ${fmtMs((rec.durationSec || 0) * 1000)}）`);
  } catch (e) {
    const r = readRecord(id) || rec;
    r.status = "error";
    r.error = String(e.message || e);
    r.phase = "";
    writeRecord(r);
    addNotice(id, "error", "片段生成失败：" + String(e.message || e));
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

// Sentence terminators and the closing quotes/brackets (CJK + ASCII) that must
// stay WITH the sentence they end. A segment break lands AFTER these closers, never
// before them: 走吧。」→ after 」; He said, "go." → after the ". Missing any closer
// (e.g. 】 》 〉) strands it at the head of the next segment. All segmenters below
// share these so their sentence-end and "swallow trailing closer" logic can't drift.
const CLOSER_ONLY = /["'”’)\]}」』）】》〉〕｣›»]/;
const CLOSER_OR_WS = /[\s"'”’)\]}」』）】》〉〕｣›»]/;
// A char is a sentence end when it is a CJK terminator (。！？…), OR a Latin
// terminator (.!?) that is followed by end-of-text, whitespace, or a closer.
const isSentEnd = (ch, nxt) =>
  /[。！？]/.test(ch) || (/[.!?]/.test(ch) && (nxt === "" || CLOSER_OR_WS.test(nxt)));
// Advance past trailing closers (and whitespace) so the break includes them.
const swallowClosers = (text, k, end) => { let j = k + 1; while (j < end && CLOSER_OR_WS.test(text[j])) j++; return j; };

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

// Like mapUnitsToRef but a token may only match within `slack` chars ahead of the
// cursor; otherwise the cursor advances minimally. Prevents a single repeated short
// word (So/It/the…) from racing the cursor to end-of-text on a saturated window.
function mapUnitsBounded(units, refText, slack = 48) {
  const out = [];
  let cursor = 0;
  const lower = refText.toLowerCase();
  for (const u of units) {
    const t = (u.text || "").trim();
    if (!t) { out.push({ ci: cursor, cj: cursor, hit: false }); continue; }
    const idx = lower.indexOf(t.toLowerCase(), cursor);
    if (idx < 0 || idx > cursor + slack) {
      const cj = Math.min(refText.length, cursor + t.length);
      out.push({ ci: cursor, cj, hit: false });
      cursor = cj;
      while (cursor < refText.length && /\s/.test(refText[cursor])) cursor++;
      continue;
    }
    out.push({ ci: idx, cj: idx + t.length, hit: true });
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

// GUARANTEE EVERY 字/词 A TIMESTAMP. Committed align units pass through verbatim; the
// chars BETWEEN them (mainly forward-retry "shed" spans, plus any trailing text) are
// holes, filled PER CHAR by the best pooled candidate (GOOD-window units weighted high),
// clamped monotonically into the seam. Coverage & alarm are judged at TOKEN granularity:
// each CJK char is one 字, each Latin/digit run is one 词. A token is fine if ANY of its
// chars got a real align time (a word-internal fragment like "nt"/"ed" inherits the
// word's time); only a token with NO covered char is truly unaligned → interpolated and
// listed in uncoveredSpans so the record alarms exactly which 字/词 were guessed.
function resolveCoverage(units, map, pool, fullText, total) {
  const N = fullText.length;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const isVis = (c) => c >= 0 && c < N && /[\p{L}\p{N}]/u.test(fullText[c]);          // 字母/数字/汉字才算“字”
  const isCJK = (c) => c >= 0 && c < N && /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u.test(fullText[c]);
  const order = units.map((_, i) => i).sort((x, y) => (map[x].ci - map[y].ci) || (map[x].cj - map[y].cj));
  const cU = order.map((i) => units[i]);
  const cM = order.map((i) => map[i]);
  const outU = [], outM = [];
  const covered = new Uint8Array(N);   // 1 = committed real time, 2 = pooled-candidate rescue
  const rejected = new Uint8Array(N);  // a candidate EXISTED but its time was unreasonable → interpolated
  const rejTime = new Float64Array(N).fill(-1); // the (bogus-per-seam) time that candidate SUGGESTED — kept for diagnosis
  const SEAM_TOL = 1.0;                // a candidate must land within the seam ±1s, else it is bogus

  // Fill hole [g0,g1) (no committed unit) between seam times tPrev..tNext.
  const fillGap = (g0, g1, tPrev, tNext) => {
    g0 = clamp(Math.round(g0), 0, N); g1 = clamp(Math.round(g1), g0, N);
    if (g1 <= g0) return;
    const n = g1 - g0;
    const T = new Float64Array(n), Q = new Float64Array(n).fill(-1);
    // per-char best candidate from the pool (highest quality wins)
    for (const u of pool) {
      if (u.cj <= g0 || u.ci >= g1) continue;
      const s = Math.max(g0, u.ci), e = Math.min(g1, u.cj), w = Math.max(1, u.cj - u.ci);
      for (let c = s; c < e; c++) {
        const k = c - g0;
        if (u.q > Q[k]) { Q[k] = u.q; T[k] = u.t0 + (u.t1 - u.t0) * ((c + 0.5 - u.ci) / w); }
      }
    }
    // anchors: left seam + every ACCEPTED candidate char + right seam, monotonic.
    // A candidate whose time falls outside the seam ±SEAM_TOL is unreasonable (it would
    // only pile at a seam edge) → dropped here, marked `rejected`, and interpolated.
    const lo = Math.min(tPrev, tNext), hi = Math.max(tPrev, tNext);
    const aC = [g0], aT = [tPrev];
    for (let k = 0; k < n; k++) {
      if (Q[k] < 0) continue;
      if (T[k] < lo - SEAM_TOL || T[k] > hi + SEAM_TOL) { rejected[g0 + k] = 1; rejTime[g0 + k] = T[k]; continue; }
      aC.push(g0 + k + 0.5); aT.push(clamp(T[k], lo, hi)); if (!covered[g0 + k]) covered[g0 + k] = 2;
    }
    aC.push(g1); aT.push(tNext);
    for (let i = 1; i < aT.length; i++) if (aT[i] < aT[i - 1]) aT[i] = aT[i - 1];
    const timeAt = (c) => {
      for (let i = 1; i < aC.length; i++) if (c <= aC[i]) { const p = aC[i - 1], q = aC[i]; return q <= p ? aT[i] : aT[i - 1] + (aT[i] - aT[i - 1]) * (c - p) / (q - p); }
      return aT[aT.length - 1];
    };
    // emit word tokens over the hole, timed by timeAt (never all-on-one-timestamp)
    const span = fullText.slice(g0, g1);
    const re = /\S+/g; let m, any = false;
    while ((m = re.exec(span))) {
      any = true;
      const ci = g0 + m.index, cj = ci + m[0].length;
      let st = timeAt(ci), en = timeAt(cj);
      if (en < st) en = st;
      outU.push({ text: m[0], start: round3(st), end: round3(en) });
      outM.push({ ci, cj });
    }
    if (!any) { outU.push({ text: span, start: round3(tPrev), end: round3(tNext) }); outM.push({ ci: g0, cj: g1 }); }
  };

  let prevCj = 0, prevT = cU.length ? cU[0].start : 0;
  for (let k = 0; k < cU.length; k++) {
    const ci = cM[k].ci, cj = cM[k].cj;
    if (ci > prevCj) fillGap(prevCj, ci, prevT, cU[k].start);
    outU.push(cU[k]); outM.push(cM[k]);
    for (let c = Math.max(ci, prevCj); c < Math.min(cj, N); c++) covered[c] = 1;
    prevCj = Math.max(prevCj, cj); prevT = cU[k].end;
  }
  if (N > prevCj) fillGap(prevCj, N, prevT, total);

  // TOKEN-LEVEL coverage & alarm. Walk 字/词: CJK char = 1 token, Latin/digit run = 1
  // token. A token with ANY covered char is OK; a fully-uncovered token is alarmed with
  // a reason ('badcand' if it had a rejected candidate, else 'nocand'). Tokens that used
  // a pooled candidate are also reported (candidateSpans) so drift can be located.
  const tAt = buildCharToTime(outU, outM);
  const uncoveredSpans = [], candidateSpans = [];
  let visTotal = 0, uncoveredChars = 0, rescuedChars = 0, committedChars = 0;
  let pend = null, cpend = null;
  const flush = () => { if (pend) { uncoveredSpans.push({ c0: pend.c0, c1: pend.c1, text: fullText.slice(pend.c0, pend.c1), tStart: round3(tAt(pend.c0)), tEnd: round3(tAt(pend.c1)), reason: pend.reason, candStart: pend.candLo == null ? null : round3(pend.candLo), candEnd: pend.candHi == null ? null : round3(pend.candHi) }); pend = null; } };
  const cflush = () => { if (cpend) { candidateSpans.push({ c0: cpend.c0, c1: cpend.c1, text: fullText.slice(cpend.c0, cpend.c1), tStart: round3(tAt(cpend.c0)), tEnd: round3(tAt(cpend.c1)) }); cpend = null; } };
  let c = 0;
  while (c < N) {
    if (!isVis(c)) { c++; continue; }
    let e;
    if (isCJK(c)) e = c + 1;
    else { e = c; while (e < N && isVis(e) && !isCJK(e)) e++; }   // one Latin/digit 词
    let anyCov = false, anyCand = false, anyRej = false, vis = 0;
    for (let k = c; k < e; k++) {
      if (isVis(k)) { vis++; if (covered[k] === 2) rescuedChars++; else if (covered[k] === 1) committedChars++; }
      if (covered[k]) anyCov = true;
      if (covered[k] === 2) anyCand = true;
      if (rejected[k]) anyRej = true;
    }
    visTotal += vis;
    if (anyCand) { if (cpend) cpend.c1 = e; else cpend = { c0: c, c1: e }; } else cflush();
    if (!anyCov) {
      uncoveredChars += vis;
      const reason = anyRej ? "badcand" : "nocand";
      // for badcand: what time did the rejected candidates SUGGEST for this token? (min/max)
      let tlo = Infinity, thi = -Infinity;
      if (anyRej) for (let k = c; k < e; k++) if (rejected[k] && rejTime[k] >= 0) { if (rejTime[k] < tlo) tlo = rejTime[k]; if (rejTime[k] > thi) thi = rejTime[k]; }
      const hasCand = thi !== -Infinity;
      if (pend && pend.reason === reason) {
        pend.c1 = e;
        if (hasCand) { pend.candLo = pend.candLo == null ? tlo : Math.min(pend.candLo, tlo); pend.candHi = pend.candHi == null ? thi : Math.max(pend.candHi, thi); }
      } else { flush(); pend = { c0: c, c1: e, reason, candLo: hasCand ? tlo : null, candHi: hasCand ? thi : null }; }
    } else flush();
    c = e;
  }
  flush(); cflush();

  const coveredChars = visTotal - uncoveredChars;
  return { units: outU, map: outM, uncoveredSpans, candidateSpans, rescuedChars, committedChars, coveredChars, totalChars: visTotal };
}

// De-burst the aligner's local micro-collapses. At pauses (usually sentence ends)
// Qwen's aligner packs several words into an impossibly short span (>~8 words/sec)
// and leaves the freed time as a gap, so karaoke highlight RACES then STALLS. We
// guarantee each unit a readable min display slot by borrowing from nearby slack and
// repaying the "debt" during roomy gaps (bounded, so no permanent drift) — this only
// smooths DISPLAY timing where speech was physically impossible; genuine pauses stay.
// Times remain strictly monotonic. Operates on the global unit list in place.
function deburstUnits(units, MINSLOT = 0.14, MAXCARRY = 1.5) {
  const n = units.length;
  if (n < 2) return units;
  let carry = 0;
  for (let i = 1; i < n; i++) {
    let ns = units[i].start + carry;
    const slot = ns - units[i - 1].start;
    if (slot < MINSLOT) { const push = MINSLOT - slot; ns += push; carry = Math.min(MAXCARRY, carry + push); }
    else if (carry > 0) { const repay = Math.min(carry, slot - MINSLOT); ns -= repay; carry -= repay; }
    units[i].start = round3(ns);
  }
  for (let i = 0; i < n; i++) {
    const nx = i + 1 < n ? units[i + 1].start : units[i].end;
    units[i].end = round3(Math.max(units[i].start + 0.05, Math.min(units[i].end, nx)));
  }
  return units;
}

// Re-align GUESSED spans to real per-char times. TRIGGER = "未获真实时间戳" (uncovered) chars
// only — the spans resolveCoverage had to LINEARLY INTERPOLATE (no committed align time). For
// each contiguous uncovered run we take its own audio slice [left anchor .. right anchor] and
// feed it back to the aligner for REAL times. EXTENSION: if an uncovered run overlaps a "flying
// run" (cram) whose borrowed time was DUMPED on a downstream duration SPIKE (突变点), the
// uncovered right anchor is itself the collapsed spike and thus untrustworthy — so we extend
// the window rightward through the flying run + the "pseudo-normal" tail up to (and including)
// the spike, whose END is the next reliable anchor. A flying run that overlaps NO uncovered
// region does NOT trigger (leave it). Only units inside the chosen window are ever rewritten;
// committed words outside stay put. Successful re-aligns are dropped from diag.uncoveredSpans
// (they're no longer guessed) and recorded in diag.repairSpans for the report.
async function realignGuessedSpans(segsOut, fullText, diag, alignSlice, id = "") {
  const uncov = Array.isArray(diag?.uncoveredSpans) ? diag.uncoveredSpans : [];
  if (!uncov.length) return;                        // nothing was guessed → nothing to re-align
  // Flatten to per-word units (CJK flying appears only after sliceToWords splits per char).
  const units = [];
  for (const s of segsOut) for (const w of (s.words || [])) units.push(w);
  const n = units.length;
  if (n < 2) return;
  const visLen = (t) => ((t || "").match(/[\p{L}\p{N}]/gu) || []).length;
  const dur = (i) => Math.max(0, (units[i].end || 0) - (units[i].start || 0));

  // Map each flat word to its fullText [ci,cj) by a forward scan (word.text is an exact
  // substring of fullText, in order) — lets us mark which words are uncovered (char coords).
  const wci = new Array(n), wcj = new Array(n);
  { let cur = 0; for (let k = 0; k < n; k++) { const t = units[k].text || ""; const at = t ? fullText.indexOf(t, cur) : -1; if (at >= 0) { wci[k] = at; wcj[k] = at + t.length; cur = at + t.length; } else { wci[k] = cur; wcj[k] = cur; } } }
  const isUncovWord = (k) => uncov.some((u) => wci[k] < u.c1 && wcj[k] > u.c0);
  const uw = new Uint8Array(n); for (let k = 0; k < n; k++) uw[k] = isUncovWord(k) ? 1 : 0;
  if (!uw.some((x) => x)) return;

  // duration stats (over the CURRENT/pre-realign timeline) for cram & spike detection
  const ds = [];
  for (let i = 0; i < n; i++) { const d = dur(i); if (d > 0.001) ds.push(d); }
  ds.sort((a, b) => a - b);
  const med = ds.length ? ds[Math.floor(ds.length / 2)] : 0.2;
  const cramMax = Math.max(0.06, med * 0.4);
  const giantAbs = Math.max(4, med * 15);
  const isCram = (i) => { const d = dur(i); return d > 0 && d <= cramMax; };
  const isSpike = (i) => {
    const d = dur(i);
    if (i <= 0 || i >= n - 1) return d >= giantAbs;
    return d >= 3 * med && d >= 2.5 * dur(i - 1) && d >= 2.5 * dur(i + 1);
  };
  // Given a start index inside/at a flying run, return the block [runStart..spike] or null.
  const flyingBlock = (from) => {
    // walk left to the run start, right to the run end (allow single 1-unit gaps)
    let s = from; while (s - 1 >= 0 && (isCram(s - 1) || (s - 2 >= 0 && isCram(s - 2)))) s--;
    let e = from; while (e + 1 < n && (isCram(e + 1) || (e + 2 < n && isCram(e + 2)))) e++;
    let runLen = 0; for (let k = s; k <= e; k++) if (isCram(k)) runLen++;
    if (runLen < 3) return null;
    let sp = -1, spDur = 0;
    for (let k = e + 1; k < n && k - e <= 15; k++) if (isSpike(k) && dur(k) > spDur) { sp = k; spDur = dur(k); }
    if (sp < 0) return null;
    return { s, sp, spDur };
  };
  const anyCramIn = (a, b) => { for (let k = a; k <= b; k++) if (isCram(k)) return k; return -1; };

  // ---- Build re-align windows from uncovered runs (with the flying→spike extension) ----
  const windows = [];
  let k = 0;
  while (k < n) {
    if (!uw[k]) { k++; continue; }
    let u0 = k; while (k + 1 < n && uw[k + 1]) k++; let u1 = k; k++;
    let lo = u0, hi = u1, spike = -1, spDur = 0;
    // does the uncovered run touch a flying run? (a cram inside it, or a cram just after it)
    let seed = anyCramIn(u0, u1);
    if (seed < 0 && u1 + 1 < n && isCram(u1 + 1)) seed = u1 + 1;
    if (seed < 0 && u0 - 1 >= 0 && isCram(u0 - 1)) seed = u0 - 1;
    if (seed >= 0) {
      const blk = flyingBlock(seed);
      if (blk) { lo = Math.min(lo, blk.s); hi = Math.max(hi, blk.sp); spike = blk.sp; spDur = blk.spDur; }
    }
    windows.push({ lo, hi, spike, spDur });
  }
  if (!windows.length) return;
  // merge windows that overlap/abut (extension can make two uncovered runs share a block)
  windows.sort((a, b) => a.lo - b.lo);
  const merged = [windows[0]];
  for (let w = 1; w < windows.length; w++) {
    const last = merged[merged.length - 1], cur = windows[w];
    if (cur.lo <= last.hi + 1) { last.hi = Math.max(last.hi, cur.hi); if (cur.spike > last.spike || (last.spike < 0)) { last.spike = cur.spike; last.spDur = cur.spDur; } }
    else merged.push(cur);
  }

  // TRUE idle region: a large collapse piles many words at ONE instant, and LATE — so
  // units[lo].start / units[hi].end are collapsed values, NOT real anchors. Grow the window
  // over contiguous PILED neighbours, then take [prev reliable word END .. next reliable word
  // START] — the real span this text occupies. Both the re-align slice AND the uniform fallback
  // use it. (Zoom 4:33: 59 words piled into 1.3s; real region = [4:21.36 .. 4:35.44] ≈ 14s.)
  const isPiled = (i) => dur(i) < 0.06;
  for (const w of merged) {
    while (w.lo - 1 >= 0 && isPiled(w.lo - 1)) w.lo--;
    while (w.hi + 1 < n && isPiled(w.hi + 1)) w.hi++;
    w.A = w.lo > 0 ? (units[w.lo - 1].end || 0) : (units[w.lo].start || 0);
    w.B = w.hi < n - 1 ? (units[w.hi + 1].start || 0) : (units[w.hi].end || 0);
    if (!(w.B > w.A + 0.05)) { w.A = units[w.lo].start || 0; w.B = Math.max(w.A + 0.05, units[w.hi].end || 0); }
    let t = ""; for (let x = w.lo; x <= w.hi; x++) t += (units[x].text || ""); w.text = t;
  }

  // ---- Re-align each window over its TRUE idle region (parallel, bounded). ----
  await mapLimit(merged, 4, async (w, wi) => {
    const { A, B, text } = w;
    if (!(B > A + 0.15) || visLen(text) < 2 || typeof alignSlice !== "function") { w.ok = false; return; }
    let reUnits = [];
    try { reUnits = await alignSlice(A, B, text, `re${wi}`); } catch { reUnits = []; }
    if (!Array.isArray(reUnits) || !reUnits.length) { w.ok = false; return; }
    const map = mapUnitsToRef(reUnits, text);
    const tAt = buildCharToTime(reUnits, map);
    const t0 = tAt(0), t1 = tAt(text.length);
    // Reject a re-align that COLLAPSED AGAIN inside the slice (text piled near one end, covering
    // ≪ the window): require it to span ≥50% of [A,B]; otherwise we uniform-spread instead.
    if (!(t1 > t0 && t0 >= A - 0.05 && t1 <= B + 0.05 && (t1 - t0) >= (B - A) * 0.5)) { w.ok = false; return; }
    w.ok = true; w.tAt = tAt;
  });

  // ---- Apply: SUCCESS → real per-char times; FAILURE (re-align collapsed / unavailable) →
  // UNIFORM distribution across the TRUE idle region [A,B] (never keep a collapsed version).
  const covered = [];                               // fullText char ranges now given REAL times
  const spans = [];
  for (const w of merged) {
    const { lo, hi, spike, spDur, A, B } = w;
    // DISPLAY text = original slice of fullText (keeps real spaces/punctuation). w.text is the
    // units concatenation (no separators) — fine to FEED the aligner, but "wehadsome…" for
    // English in the report. fullText.slice(c0,c1) reads correctly for both English and CJK.
    const blkText = fullText.slice(wci[lo], wcj[hi]);
    if (w.ok) {
      let off = 0, last = A;
      for (let x = lo; x <= hi; x++) {
        const len = (units[x].text || "").length;
        let st = w.tAt(off), en = w.tAt(off + len);
        st = Math.min(Math.max(st, last), B); en = Math.min(Math.max(en, st + 0.02), B);
        units[x].start = round3(st); units[x].end = round3(en); last = en; off += len;
      }
      covered.push([wci[lo], wcj[hi]]);            // got REAL times → drop from uncovered alarm
      spans.push({ c0: wci[lo], c1: wcj[hi], tStart: round3(A), tEnd: round3(B), text: blkText, method: "realign", kind: spike >= 0 ? "debt" : "uncovered", spikeText: spike >= 0 ? units[spike].text : "", spikeSecs: spike >= 0 ? round3(spDur) : 0 });
      continue;
    }
    // FALLBACK — uniform across [A,B], proportional to each unit's char length. Still a GUESS
    // (not real alignment), so it STAYS in the uncovered alarm; we just refuse to leave the
    // collapsed pile behind.
    let totalLen = 0; for (let x = lo; x <= hi; x++) totalLen += Math.max(1, (units[x].text || "").length);
    const span = B - A; let acc = 0;
    for (let x = lo; x <= hi; x++) {
      const len = Math.max(1, (units[x].text || "").length);
      const st = A + span * (acc / totalLen); acc += len; const en = A + span * (acc / totalLen);
      units[x].start = round3(st); units[x].end = round3(Math.max(st + 0.02, en));
    }
    spans.push({ c0: wci[lo], c1: wcj[hi], tStart: round3(A), tEnd: round3(B), text: blkText, method: "uniform", kind: spike >= 0 ? "debt" : "uncovered", spikeText: spike >= 0 ? units[spike].text : "", spikeSecs: spike >= 0 ? round3(spDur) : 0 });
  }

  if (spans.length) {
    diag.repairSpans = spans;
    for (const s of segsOut) { const ws = s.words || []; if (ws.length) { s.start = ws[0].start; s.end = ws[ws.length - 1].end; } }
  }
  // Drop the now-REAL spans from the uncovered alarm (they got true timestamps).
  if (covered.length) {
    diag.uncoveredSpans = uncov.filter((u) => !covered.some(([c0, c1]) => u.c0 >= c0 && u.c1 <= c1));
    // recount the headline uncovered-chars figure so the report/badge matches
    if (typeof diag.uncoveredChars === "number") {
      let uc = 0; for (const u of diag.uncoveredSpans) uc += visLen(u.text || "");
      diag.uncoveredChars = uc;
    }
  }
}

// Speaker smoothing: a collapsed/forward-retry "shed" span crams a whole sentence into a
// sub-second instant at a window seam; that degenerate ~0s segment then grabs whatever diar
// cluster sits at that instant (often a spurious micro-blip), so one sentence shows as a
// different speaker. Fix WITHOUT touching text or times: a run of abnormally-fast, very-short
// segments sandwiched between two segments of the SAME (other) speaker is a diar artifact →
// inherit that speaker. Real short interjections (neighbors differ, or normal rate) untouched.
// MUST run BEFORE redistributeParkedDebt — once the crammed segment is spread back to a normal
// duration, the "crammed" test no longer fires and the wrong speaker would survive.
function smoothSpeakers(segments, id = "") {
  const visLen = (t) => ((t || "").match(/\S/g) || []).length;
  const isCrammed = (s) => {
    const d = (s.end - s.start), n = visLen(s.text);
    return d < 1.2 && n >= 4 && n / Math.max(d, 0.01) > 12; // >12 字/秒 = 非真实语速
  };
  let smoothed = 0, i = 0;
  while (i < segments.length) {
    if (!isCrammed(segments[i])) { i++; continue; }
    let j = i;
    while (j + 1 < segments.length && isCrammed(segments[j + 1])) j++;
    const prev = segments[i - 1], next = segments[j + 1];
    if (prev && next && prev.speaker && prev.speaker === next.speaker) {
      for (let k = i; k <= j; k++) if (segments[k].speaker !== prev.speaker) { segments[k].speaker = prev.speaker; smoothed++; }
    }
    i = j + 1;
  }
  if (smoothed) console.log(`[${id}] 说话人平滑：修正 ${smoothed} 个挤压伪段的说话人（并入前后同一说话人）`);
  return smoothed;
}

// Index of the last TRUSTWORTHY unit in one align window: the last unit whose start
// is within the reliable time cap tMax, backed off to just before the FIRST collapse
// plateau (>=N consecutive starts within dt seconds — the LIS-clamp signature Qwen's
// aligner emits once it saturates). Never keeps piled-up timestamps.
// Reliable end of an aligned window: cut at the FIRST dense plateau (>=N units within
// dt seconds) — that is where Qwen's aligner starts saturating/cramming. Cutting EARLY
// is deliberately safe here: the remaining audio simply flows into the next window and
// re-aligns, so an early cut costs at most an extra window, NEVER a collapse. (Do NOT
// try to "skip transient bursts" and extend the window past the first plateau: that
// lets a saturating window keep cramming FUTURE text into its tail, inflating the char
// cursor and starving later windows of text — the exact cause of a text-starved last
// window collapsing. See WORK_LOG 2026-07-14.)
function reliableAlignEnd(units, tMax, N = 6, dt = 0.12) {
  let k = units.length - 1;
  while (k > 0 && units[k].start > tMax) k--;
  let runStart = 0;
  for (let i = 1; i <= k; i++) {
    if (units[i].start - units[i - 1].start < dt) {
      if (i - runStart + 1 >= N) { k = Math.max(0, runStart - 1); break; }
    } else {
      runStart = i;
    }
  }
  return Math.max(0, k);
}

// Long-audio forced alignment — 方案 B「DIAR 规约」(2026-07-14 重做).
// Qwen3-ForcedAligner collapses when (a) a window exceeds its reliable horizon
// (~255s) or (b) it is fed LEADING text — text whose audio lies before the window
// start. This design uses the DIARIZATION timeline — the one real audio-time truth
// we already computed — to REGULARIZE the windowing, while keeping the char handoff
// between windows EXACT so leading text can never appear:
//   (1) WINDOW EDGES snap to the MIDDLE of diar pauses (silence gaps) and every
//       window is capped at WINMAX < the aligner's reliable horizon. Cutting inside
//       silence never splits a word, and staying under the horizon is the direct fix
//       for the test-machine collapse of the old 290s windows.
//   (2) HOW MUCH TEXT a window gets is estimated from a DIAR-regularized char↔time
//       curve (chars accrue over SPEECH time, flat during pauses), anchor-corrected
//       by every good window's real (char,time) so a fast/slow segment can't skew it.
//   (3) The next window's text START is the EXACT char the previous window aligned up
//       to (reliable-end), so the audio cursor `a` and char cursor `cOff` are derived
//       from the SAME aligned word and cannot drift apart — this is what actually
//       prevents leading text (a lagging char cursor was the 1.0.11 collapse cause).
// A window that still collapses pushes its text start forward and retries; a collapsed
// or empty window is interpolated in place (1.0.14 behaviour, untouched). The ONE thing
// 1.0.14 threw away — the text a successful forward-retry SHEDS (the "flew-by" chars) —
// is now rescued: every attempt's units seed a candidate pool (GOOD windows weighted
// high), and resolveCoverage() gives each shed char the best pooled time, or interpolates
// + ALARMS it in diag.uncoveredSpans if nothing covers it. Chars 1.0.14 timed correctly
// are passed through verbatim. No diar → uniform char-rate + fixed WINMAX cuts. Network
// errors throw and abort. Returns {units, map, diag}.
async function alignLong(alignSlice, fullText, total, diarSegs, onProg, id = "") {
  const WINMAX = 230, SAFE = 230, MAXRETRY = 2;    // WINMAX < aligner horizon (~255s)
  const N = fullText.length;
  const units = [], map = [];
  // Candidate pool: EVERY unit of EVERY attempt (good OR failed), in global chars.
  // resolveCoverage() uses it to give every hole char the best available real time
  // instead of dropping forward-retry "shed" text to zero.
  const pool = [];
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const diag = { winInit: WINMAX, safe: SAFE, minWin: 0, rows: [], interpSpans: [], shrinks: 0, degraded: 0 };

  // --- DIAR speech timeline: merge speech intervals + monotonic "speech seconds
  //     before t" so char accumulation ignores silence.
  const dsegs = (diarSegs || [])
    .map((s) => ({ start: +s.start, end: +s.end }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((x, y) => x.start - y.start);
  const merged = [];
  for (const s of dsegs) {
    const l = merged[merged.length - 1];
    if (l && s.start <= l.end + 0.01) l.end = Math.max(l.end, s.end);
    else merged.push({ start: clamp(s.start, 0, total), end: clamp(s.end, 0, total) });
  }
  const S = merged.reduce((acc, m) => acc + Math.max(0, m.end - m.start), 0);
  const hasDiar = merged.length > 0 && S > 1;
  const speechBefore = (t) => {
    let acc = 0;
    for (const m of merged) {
      if (t <= m.start) break;
      acc += Math.min(t, m.end) - m.start;
      if (t <= m.end) break;
    }
    return acc;
  };
  const cps0 = N / Math.max(1, total);             // uniform fallback chars/sec

  // --- char↔time curve: piecewise-linear through GOOD-window anchors (real, exact),
  //     and BEYOND the last anchor projected by DIAR SPEECH share (chars accrue over
  //     remaining speech time, not wall-clock). Anchors kill cross-segment rate skew;
  //     the DIAR projection keeps the one-window-ahead text estimate honest.
  const anC = [0], anT = [0];
  const charAtTime = (t) => {
    if (t <= anT[0]) return anC[0];
    for (let i = 1; i < anT.length; i++) {
      if (t <= anT[i]) { const t0 = anT[i - 1], t1 = anT[i]; return anC[i - 1] + (anC[i] - anC[i - 1]) * (t - t0) / Math.max(1e-6, t1 - t0); }
    }
    const lc = anC[anC.length - 1], lt = anT[anT.length - 1];
    if (hasDiar) {
      const remSpeech = S - speechBefore(lt);
      if (remSpeech > 0.5) return clamp(lc + (N - lc) * (speechBefore(t) - speechBefore(lt)) / remSpeech, lc, N);
    }
    return total > lt + 0.5 ? lc + (N - lc) * (t - lt) / (total - lt) : Math.min(N, lc + cps0 * (t - lt));
  };

  // --- Candidate window cut points = MIDDLE of every diar pause, plus the clip end.
  const cuts = [];
  for (let i = 0; i + 1 < merged.length; i++) {
    const gap = merged[i + 1].start - merged[i].end;
    if (gap > 0.05) cuts.push((merged[i].end + merged[i + 1].start) / 2);
  }
  cuts.push(total);
  // Furthest pause-cut in (a, a+WINMAX]; require a real gap, else hard-cut at WINMAX.
  const chooseCut = (a) => {
    let best = -1;
    for (const c of cuts) {
      if (c <= a + 0.05) continue;
      if (c > a + WINMAX + 0.01) break;            // cuts are sorted ascending
      best = c;
    }
    if (best > a + 20) return best;                // usable pause window
    if (best > a + 0.05 && a + WINMAX >= total) return best;   // tiny final tail
    return Math.min(total, a + WINMAX);            // no usable pause → hard cut
  };

  let a = 0, cOff = 0, pass = 0, degraded = 0, retries = 0;
  const row = (b, outcome, best) => diag.rows.push({
    pass, a: round3(a), b: round3(b), winLen: Math.round(b - a),
    n: best ? best.u.length : 0, k: best ? best.k : -1,
    covA: best ? round3(best.covA) : null, covC: best ? best.covC : null,
    matchRate: best ? Math.round(best.matchRate * 100) / 100 : null, outcome,
  });
  // 1.0.14 interpolation: spread fullText[cStart,cEnd) linearly over [tStart,tEnd] as
  // word tokens so a collapsed/empty span never piles every char on one timestamp.
  const emitInterp = (cStart, cEnd, tStart, tEnd) => {
    cStart = clamp(Math.round(cStart), 0, N); cEnd = clamp(Math.round(cEnd), cStart, N);
    if (cEnd <= cStart || tEnd <= tStart) return;
    const span = fullText.slice(cStart, cEnd);
    const dur = Math.max(1e-3, tEnd - tStart), wide = Math.max(1, cEnd - cStart);
    const fc = (c) => tStart + dur * ((c - cStart) / wide);
    const re = /\S+/g; let m, any = false;
    while ((m = re.exec(span))) {
      any = true;
      const ci = cStart + m.index, cj = ci + m[0].length;
      units.push({ text: m[0], start: round3(fc(ci)), end: round3(fc(cj)) });
      map.push({ ci, cj });
    }
    if (!any) { units.push({ text: span, start: round3(tStart), end: round3(tEnd) }); map.push({ ci: cStart, cj: cEnd }); }
  };

  while (a < total - 0.05 && cOff < N) {
    pass++;
    const b = chooseCut(a);                         // DIAR pause-snapped, <= WINMAX
    const lastWin = b >= total - 0.05;
    const PUSH = Math.round(cps0 * 15);             // ~15s of text per forward retry step
    let resolved = false;
    for (let attempt = 0; attempt <= MAXRETRY && !resolved; attempt++) {
      // Text start = EXACT continuation cursor (cOff), pushed forward on a retry to
      // shed residual leading text. Never behind cOff.
      const c0 = clamp(cOff + attempt * PUSH, cOff, N - 1);
      // Text amount: DIAR curve estimate for this window, GENEROUSLY over-provided so
      // the aligner reaches `b` even in a fast segment (trailing surplus is harmless).
      const estWin = Math.max(0, charAtTime(b) - c0);
      const want = lastWin ? N - c0
        : Math.min(N - c0, Math.max(Math.ceil(estWin * 1.6), Math.ceil(cps0 * (b - a) * 1.7)) + 80);
      const part = fullText.slice(c0, c0 + want);
      const cur = await alignSlice(a, b, part, attempt ? `wa_${pass}r${attempt}` : `wa_${pass}`);
      if (onProg && attempt === 0) try { onProg(Math.min(1, b / Math.max(1, total))); } catch { /* ignore */ }
      if (!cur.length) {
        if (attempt < MAXRETRY) { retries++; diag.shrinks++; row(b, "空窗·前移重试", null); continue; }
        degraded++;
        console.log(`[${id}] alignLong 空窗 pass${pass} a=${a.toFixed(0)} b=${b.toFixed(0)} c0=${c0}`);
        row(b, "插值·空窗", null);
        diag.interpSpans.push({ a: round3(a), b: round3(b), reason: "空窗" });
        // 1.0.14 exactly: interpolate [c0,cEnd). Any shed [cOff,c0) from a prior retry
        // stays a hole → resolveCoverage() rescues it from GOOD-window candidates.
        const cEnd = lastWin ? N : clamp(Math.round(charAtTime(b)), c0 + 1, N);
        emitInterp(c0, cEnd, a, b);
        cOff = clamp(cEnd, c0, N); a = b; resolved = true; break;
      }
      const ckRel = reliableAlignEnd(cur, a + SAFE);
      const rawSpan = cur[cur.length - 1].end - a;
      const dense = cur.length > 40;
      let ck, covRel, bad, earlyPlateau = false, lagging = false;
      if (lastWin) {
        // Last window: keep ALL units; "collapsed" only if the whole alignment piles
        // near the start (reaches far less than the span it should cover).
        ck = cur.length - 1;
        covRel = rawSpan;
        bad = dense && rawSpan < Math.max(30, (b - a) * 0.3);
        earlyPlateau = bad;
      } else {
        ck = ckRel;
        covRel = cur[ckRel].end - a;
        // TRUE collapse only: many units but the reliable prefix advances < 8s (piled
        // at the start). A SHORT-BUT-REAL prefix (e.g. 16s) is NOT a collapse — it is a
        // harmless early cut; keep it and let the remaining audio re-align next window
        // (validated "早切无害"). Interpolating a good short prefix was the 660→883 bug.
        earlyPlateau = dense && covRel < 8;
      }
      // Map ALL units (sequential scan → prefix == reliable slice) so the pool can
      // hold candidates for EVERY char this attempt touched, not just the kept prefix.
      const lmFull = mapUnitsBounded(cur, part);
      const lm = lmFull.slice(0, ck + 1);
      const covC = lm.length ? lm[lm.length - 1].cj : 0;
      const matched = lm.reduce((n, x) => n + (x.hit ? 1 : 0), 0);
      const matchRate = matched / Math.max(1, lm.length);
      if (!lastWin) {
        const expC = cps0 * Math.max(0, covRel);
        lagging = dense && covRel > 20 && covC < 0.3 * expC;
        bad = earlyPlateau || lagging;
      }
      // Record this attempt's units into the candidate pool ONLY to rescue forward-
      // retry "shed" holes later. A GOOD window's units (incl. its over-provided tail,
      // which aligns the shed text over its REAL audio) get a big quality bonus so a
      // shed hole prefers them over a failed attempt's piled/collapsed times.
      const addToPool = (isGood) => {
        const bonus = isGood ? 10 : 0;
        for (let i = 0; i < cur.length; i++) {
          const gi = c0 + lmFull[i].ci, gj = c0 + lmFull[i].cj;
          if (gj > gi) pool.push({ ci: gi, cj: gj, t0: cur[i].start, t1: Math.max(cur[i].start, cur[i].end), q: bonus + matchRate * 2 + (i <= ckRel ? 1 : 0) + (lmFull[i].hit ? 0.5 : 0) });
        }
      };
      const best = { u: cur, k: ck, lm, covA: covRel, covC, matchRate };
      if (bad && attempt < MAXRETRY) {
        retries++; diag.shrinks++;
        addToPool(false);
        row(b, `前移重试 +${PUSH}字（${earlyPlateau ? "塌窗" : "文本滞后"}）`, best);
        continue;
      }
      if (bad) {
        degraded++;
        const w0 = cur[0] || {};
        console.log(`[${id}] alignLong 塌窗直插 pass${pass} a=${a.toFixed(0)} b=${b.toFixed(0)} c0=${c0} units=${cur.length} covRel=${covRel.toFixed(0)}s covC=${covC} matchRate=${matchRate.toFixed(2)} 首unit="${(w0.text || "").slice(0, 16)}"@${(w0.start || 0).toFixed(1)}`);
        addToPool(false);
        row(b, `插值·塌窗 ${Math.round(b - a)}s`, best);
        diag.interpSpans.push({ a: round3(a), b: round3(b), reason: earlyPlateau ? "塌窗" : "文本滞后" });
        // 1.0.14 exactly: interpolate [cOff,cEnd) cleanly (NO candidate processing on a
        // collapsed window — it wasn't a "dropped" span, it was interpolated already).
        const cEnd = lastWin ? N : clamp(Math.round(charAtTime(b)), cOff + 1, N);
        emitInterp(cOff, cEnd, a, b);
        cOff = clamp(cEnd, cOff, N); a = b; resolved = true; break;
      }
      // GOOD: keep the reliable prefix (exactly 1.0.14); its units also seed the pool
      // (with the good bonus) so a following window's shed hole can borrow this tail.
      addToPool(true);
      for (let i = 0; i <= ck; i++) {
        const st = clamp(cur[i].start, a, b);
        units.push({ text: cur[i].text, start: round3(st), end: round3(clamp(cur[i].end, st, b)) });
        map.push({ ci: c0 + lm[i].ci, cj: c0 + lm[i].cj });
      }
      if (lastWin) { row(b, "真实对齐(末窗)", best); cOff = N; a = b; resolved = true; break; }
      // Register the (reliable-end char, time) anchor, then continue from it EXACTLY.
      const endC = Math.min(N, c0 + lm[ckRel].cj), endT = cur[ckRel].end;
      if (endT > anT[anT.length - 1] + 0.05 && endC > anC[anC.length - 1]) { anT.push(endT); anC.push(endC); }
      row(b, attempt ? `真实对齐(前移${attempt})` : "真实对齐", best);
      cOff = endC; a = endT; resolved = true; break;
    }
    if (!resolved) a = b;  // safety net; should not happen
  }
  // Settlement — ONLY touches holes (chars no committed/interpolated unit covers, i.e.
  // forward-retry "shed" spans + any trailing text). Everything 1.0.14 already timed
  // (committed prefixes, collapsed/empty interpolation) is passed through untouched.
  // A hole char takes the best pooled candidate (GOOD-window tail wins); a char with no
  // candidate is interpolated + ALARMED. No char is ever left without a timestamp.
  const cov = resolveCoverage(units, map, pool, fullText, total);
  diag.degraded = degraded;
  diag.uncoveredSpans = cov.uncoveredSpans;
  diag.candidateSpans = cov.candidateSpans;
  diag.uncoveredChars = cov.totalChars - cov.coveredChars;
  diag.rescuedChars = cov.rescuedChars;
  diag.committedChars = cov.committedChars;
  diag.coveredChars = cov.coveredChars;
  diag.totalChars = cov.totalChars;
  if (degraded || cov.rescuedChars || diag.uncoveredChars) {
    console.log(`[${id}] alignLong 完成：${degraded} 个窗塌/空、${retries} 次前移；候选救回 ${cov.rescuedChars} 字（${cov.candidateSpans.length} 段），纯插值兜底 ${diag.uncoveredChars} 字（${cov.uncoveredSpans.length} 段），覆盖 ${cov.coveredChars}/${cov.totalChars}，DIAR=${hasDiar ? merged.length + "段" : "无"}`);
  }
  return { units: cov.units, map: cov.map, diag };
}

// Candidate cut positions: after every sentence-end / clause mark (swallowing
// trailing closing quotes/brackets/spaces), plus 0 and length.
function punctBounds(refText) {
  const s = new Set([0, refText.length]);
  for (let i = 0; i < refText.length; i++) {
    const ch = refText[i];
    const sentEnd = isSentEnd(ch, refText[i + 1] || "");
    const clause = /[，、；,;：:]/.test(ch);
    if (sentEnd || clause) s.add(swallowClosers(refText, i, refText.length));
  }
  return Array.from(s).sort((a, b) => a - b);
}

// Break refText[c0,c1) into readable lines: after each sentence end, or at the
// last clause mark before maxLen (CJK wraps at a char if none). Returns exclusive
// ends, last == c1.
function punctLineBreaks(refText, c0, c1, maxLen) {
  const swallow = (k) => swallowClosers(refText, k, c1);
  const hardCap = Math.max(maxLen * 2, 120);
  const cuts = [];
  let lineStart = c0, lastComma = -1;
  for (let i = c0; i < c1; i++) {
    const ch = refText[i];
    const nxt = i + 1 < c1 ? refText[i + 1] : "";
    const sentEnd = isSentEnd(ch, nxt);
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

// Sentence-end boundaries only (plus 0 and length). Unlike punctBounds this does
// NOT include commas/clause marks, so diar-window boundaries snap to whole
// sentences and never split a sentence at an interior comma.
function sentBounds(refText) {
  const s = new Set([0, refText.length]);
  for (let i = 0; i < refText.length; i++) {
    if (isSentEnd(refText[i], refText[i + 1] || "")) s.add(swallowClosers(refText, i, refText.length));
  }
  return Array.from(s).sort((a, b) => a - b);
}

// Break refText[c0,c1) into ONE segment per SENTENCE. Segments END ONLY at a
// sentence terminator (。！？ / . ! ? followed by a space or closer) — NEVER at a
// comma, so a block never reads as an unfinished clause ("…database credential,").
// A comma is a poor wrap point AND a "pause after comma" is common, so pausing
// there would still end a block on ",". Over-long run-ons with no terminator are
// handled by the caller (splitByPause, which wraps on a real silence, not a comma).
// Returns exclusive char ends within [c0,c1), last == c1.
function sentenceCuts(refText, c0, c1) {
  const cuts = [];
  let lineStart = c0;
  for (let i = c0; i < c1; i++) {
    if (!isSentEnd(refText[i], i + 1 < c1 ? refText[i + 1] : "")) continue;
    const cutAt = swallowClosers(refText, i, c1);
    if (cutAt > lineStart) { cuts.push(cutAt); lineStart = cutAt; i = cutAt - 1; }
  }
  if (!cuts.length || cuts[cuts.length - 1] !== c1) cuts.push(c1);
  return cuts;
}

// Fallback ONLY for a run-on longer than maxChars with no sentence terminator
// (e.g. ASR that emits commas but few periods): wrap it at the LARGEST interior
// word pause — a real silence is the least jarring place to break — and never at
// a comma. Recurses so a very long run-on wraps more than once. maxChars is set
// high so ordinary long-but-complete sentences are left whole. Returns exclusive
// ends within (c0,c1], last == c1.
function splitByPause(c0, c1, units, map, maxChars = 400) {
  if (c1 - c0 <= maxChars) return [c1];
  let bestCi = -1, bestGap = -Infinity;
  for (let i = 1; i < units.length; i++) {
    const ci = map[i].ci;
    if (ci <= c0 + 40 || ci >= c1 - 40) continue; // keep both sides substantial
    const gap = units[i].start - units[i - 1].end;
    if (gap > bestGap) { bestGap = gap; bestCi = ci; }
  }
  if (bestCi < 0) return [c1]; // nowhere sensible to split
  return [
    ...splitByPause(c0, bestCi, units, map, maxChars),
    ...splitByPause(bestCi, c1, units, map, maxChars),
  ];
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
  const PUNCT = /[。！？，、；：,.!?;:"'”’」』）)\]}】》〉〕｣›»…—·]/;
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

// Recompute clickable, timed words for an EDITED line: real forced-alignment is gone
// once the text changed, so spread the line's [start,end] evenly across the new
// characters (same idea as translation twords). Keeps click-to-seek + highlight.
function spreadWords(text, start, end) {
  const t = text || "";
  const n = t.length || 1;
  const s = Number(start) || 0;
  const span = Math.max(0, (Number(end) || 0) - s);
  const timeAtChar = (c) => s + (span * Math.min(n, Math.max(0, c))) / n;
  return finalizeWords(sliceToWords(t, 0, t.length, timeAtChar), s, s + span);
}

// Repair collapsed / non-monotonic segment times. Forced alignment drifts at the
// TAIL of each align window (the STT text is split proportionally by char count,
// which never matches the real per-window audio), which pins many consecutive
// segments to the SAME second or squeezes a whole window into a fraction of a
// second. Exact times can't be recovered, but every segment carries its diar
// window's REAL audio bounds (_t0/_t1); for each collapsed RUN we redistribute
// time across those real bounds proportional to text length so timestamps stay
// monotonic, distinct and roughly correct, and re-spread that run's words.
// Non-collapsed segments (alignment was fine) are left untouched.
function repairSegmentTimes(segs, duration) {
  if (!segs || !segs.length) { return segs || []; }
  const dur = Math.max(0, Number(duration) || 0);
  const MAX_CPS = 30;   // chars/sec above this over a run => implausible => collapsed
  const GROUP = 0.12;   // starts within this (s) of each other belong to one run
  let i = 0;
  while (i < segs.length) {
    let j = i;
    // group only NEAR-EQUAL starts (both directions) so a good segment next to a
    // collapsed run isn't swept in and re-timed. Raw starts, no monotonic pre-pass.
    while (j + 1 < segs.length && Math.abs(segs[j + 1].start - segs[j].start) < GROUP) j++;
    if (j > i) {
      let chars = 0;
      for (let k = i; k <= j; k++) chars += Math.max(1, (segs[k].text || "").length);
      // Anchor the run's real audio window (_t0/_t1) BUT clamp it between the
      // neighbours: a diar window can start earlier than the previous segment
      // ended (or end later than the next begins), and using it raw would rewind
      // the clock. prevEnd..nextStart is the only interval this run may occupy.
      const prevEnd = i > 0 ? Math.max(segs[i - 1].start, segs[i - 1].end || segs[i - 1].start) : 0;
      const nextStart = j + 1 < segs.length ? segs[j + 1].start : (dur || segs[j].end || prevEnd);
      const upper = Math.max(prevEnd, nextStart);
      let lo = Number.isFinite(segs[i]._t0) ? segs[i]._t0 : segs[i].start;
      let hi = Number.isFinite(segs[j]._t1) ? segs[j]._t1 : nextStart;
      lo = Math.min(Math.max(lo, prevEnd), upper);
      hi = Math.min(Math.max(hi, lo), upper);
      let span = hi - lo;
      const collapsed = span < chars / MAX_CPS || (segs[j].start - segs[i].start) < 0.05 * (j - i);
      if (collapsed) {
        if (!(span > 0)) { hi = upper > lo ? upper : lo + (j - i + 1) * 0.4; span = hi - lo; }
        let acc = 0;
        for (let k = i; k <= j; k++) {
          const L = Math.max(1, (segs[k].text || "").length);
          const s = lo + span * (acc / chars); acc += L;
          const e = lo + span * (acc / chars);
          segs[k].start = round3(s);
          segs[k].end = round3(Math.max(s + 0.05, e));
          segs[k].words = spreadWords(segs[k].text, segs[k].start, segs[k].end);
        }
      }
    }
    i = j + 1;
  }
  // Hard safety net (independent of the above): strictly non-decreasing starts and
  // positive, non-overlapping durations — guarantees the timeline never goes back.
  for (let k = 1; k < segs.length; k++) if (segs[k].start < segs[k - 1].start) segs[k].start = round3(segs[k - 1].start);
  for (let k = 0; k < segs.length; k++) {
    const nextStart = k + 1 < segs.length ? segs[k + 1].start : (dur || segs[k].end || segs[k].start + 0.15);
    if (!(segs[k].end > segs[k].start)) segs[k].end = round3(Math.max(segs[k].start + 0.05, Math.min(segs[k].start + 0.15, nextStart)));
    if (nextStart > segs[k].start && segs[k].end > nextStart) segs[k].end = round3(nextStart);
    // only re-spread words if the safety net moved the span out from under them —
    // untouched, well-aligned segments keep their real forced-alignment word times.
    const w = segs[k].words;
    if (w && w.length && (w[0].start < segs[k].start - 0.01 || w[w.length - 1].end > segs[k].end + 0.01)) {
      segs[k].words = spreadWords(segs[k].text || "", segs[k].start, segs[k].end);
    }
  }
  for (const s of segs) { delete s._t0; delete s._t1; }
  return segs;
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
// FLORES (this app's internal lang codes) -> MTran codes used by the new translate
// model (Hy-MT2 style). from="auto" lets the model auto-detect the source.
const FLORES_TO_MTRAN = {
  zho_Hans: "zh-Hans",
  zho_Hant: "zh-Hant",
  eng_Latn: "en",
  jpn_Jpan: "ja",
  kor_Hang: "ko",
  fra_Latn: "fr",
  spa_Latn: "es",
  deu_Latn: "de",
  rus_Cyrl: "ru",
};
function floresToMtran(flores) {
  return FLORES_TO_MTRAN[flores] || "auto";
}

// Single-text translate via the gateway TEMP passthrough: POST /v1/translate?model=<name>.
// Body {from,to,text}; from ""/"auto" => model auto-detects. Response {result}.
async function gwTranslate(cfg, model, from, to, text) {
  const q = model ? `?model=${encodeURIComponent(model)}` : "";
  const r = await fetch(gwUrl(cfg, `/v1/translate${q}`), {
    method: "POST",
    headers: { ...gwHeaders(cfg), "content-type": "application/json" },
    body: JSON.stringify({ from: from || "auto", to, text }),
    signal: cfg._signal,
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`translate ${r.status}: ${String(t).slice(0, 200)}`);
  return (j?.result ?? j?.translation ?? j?.text ?? j?.translated_text ?? "").toString();
}

// Batch translate: POST /v1/translate/batch?model=<name>, ONE call for all texts.
// Body {from,to,texts[]}; response {results[]} in the same order as texts.
async function gwTranslateBatch(cfg, model, from, to, texts) {
  const q = model ? `?model=${encodeURIComponent(model)}` : "";
  const r = await fetch(gwUrl(cfg, `/v1/translate/batch${q}`), {
    method: "POST",
    headers: { ...gwHeaders(cfg), "content-type": "application/json" },
    body: JSON.stringify({ from: from || "auto", to, texts }),
    signal: cfg._signal,
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`translate/batch ${r.status}: ${String(t).slice(0, 200)}`);
  const arr = j?.results ?? j?.translations ?? j?.data ?? [];
  return Array.isArray(arr) ? arr.map((x) => (x == null ? "" : (typeof x === "string" ? x : (x.result ?? x.translation ?? x.text ?? "")))) : [];
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
  if (setP) setP(95, "翻译", 0, total);

  // Decide per-segment (srcFlores → targetFlores) exactly like before (smart
  // zh<->en when both are "auto"), then GROUP segments by the resolved
  // (from,to) MTran pair so we can translate each group in ONE batch call
  // instead of one HTTP request per segment. Non-translatable segments (empty,
  // or src==target) have their translation cleared up front.
  const groups = new Map(); // `${from}|${to}` -> { from, to, targetFlores, items:[{seg,text}] }
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (!text) { delete seg.translation; delete seg.twords; delete seg.translateTo; continue; }
    const srcF = cfgSource !== "auto" ? cfgSource : detectFlores(text);
    const tgtF = resolveTarget(cfgTarget, srcF);
    if (srcF === tgtF) { delete seg.translation; delete seg.twords; delete seg.translateTo; continue; }
    // If the source is fixed, pass the MTran code; if auto, let the model detect.
    const from = cfgSource !== "auto" ? floresToMtran(srcF) : "auto";
    const to = floresToMtran(tgtF);
    const key = `${from}|${to}`;
    let g = groups.get(key);
    if (!g) { g = { from, to, targetFlores: tgtF, items: [] }; groups.set(key, g); }
    g.items.push({ seg, text });
  }

  let translated = 0, failed = 0, lastErr = "", done = 0;
  const applyTr = (g, seg, tr) => {
    tr = (tr || "").trim();
    // Chinese target: convert half-width punctuation to full-width so 译文 reads naturally.
    if (tr && /^zho/i.test(g.targetFlores)) tr = toChinesePunct(tr);
    if (tr) {
      seg.translation = tr;
      seg.twords = evenTimedWords(tr, seg.start, seg.end);
      seg.translateTo = g.targetFlores;
      translated++;
    } else {
      delete seg.translation; delete seg.twords; delete seg.translateTo;
    }
  };

  // The model caps /translate/batch at 64 texts per call (400 otherwise), so we
  // split each group into chunks and send ONE batch request per chunk (headroom
  // below 64). If a whole chunk fails, fall back to per-segment single calls.
  const BATCH_MAX = 50;
  for (const g of groups.values()) {
    for (let off = 0; off < g.items.length; off += BATCH_MAX) {
      if (id) ckCancel(id);
      const chunk = g.items.slice(off, off + BATCH_MAX);
      const texts = chunk.map((it) => it.text);
      let results = null;
      try {
        results = await gwTranslateBatch(cfg, model, g.from, g.to, texts);
      } catch (e) {
        if (e && e.cancelled) throw e;
        // Batch failed — fall back to per-segment single calls below.
        lastErr = e?.message || String(e);
        results = null;
      }
      for (let i = 0; i < chunk.length; i++) {
        if (id) ckCancel(id);
        const { seg, text } = chunk[i];
        let tr = "";
        if (results && results[i] != null && String(results[i]).trim()) {
          tr = String(results[i]);
        } else {
          try {
            tr = await gwTranslate(cfg, model, g.from, g.to, text);
          } catch (e) {
            if (e && e.cancelled) throw e;
            failed++;
            lastErr = e?.message || String(e);
            tr = "";
          }
        }
        applyTr(g, seg, tr);
        done++;
        if (setP) setP(95 + Math.round((5 * done) / total), "翻译", done, total);
      }
    }
  }
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

// Re-run ONLY diarization on an existing transcript and re-assign each segment's
// speaker by time-overlap, keeping the transcript text/word-times/translation edits
// intact. `target` is the requested max speaker count (Feishu semantics): the result
// has at most `target` speakers — if the audio naturally has fewer, it stays fewer.
// Speaker display-name edits + the participant roster are reset (they no longer map).
async function runRediarizeJob(id, target) {
  if (running.has(id)) return;
  const rec = readRecord(id);
  if (!rec) return;
  const cfg = loadConfig();
  if (rec.bflUser) cfg.bflUser = rec.bflUser;
  if (!rec.result?.segments?.length) {
    rec.status = rec.result ? "done" : rec.status;
    rec.error = "无内容可识别";
    writeRecord(rec);
    return;
  }
  if (!cfg.models?.diar) {
    rec.status = "done";
    rec.error = "无法重新识别：未选择说话人分离(Diarize)模型";
    writeRecord(rec);
    return;
  }
  const N = Math.max(1, Math.floor(Number(target) || 1));
  running.add(id);
  cancelled.delete(id);
  const ac = new AbortController();
  jobAbort.set(id, ac);
  cfg._signal = ac.signal;
  const startedAt = nowIso();
  const timer = makeTimer();
  const setP = (progress, phase) => {
    const r = readRecord(id);
    if (!r) return;
    r.status = "processing"; r.progress = progress; r.phase = phase;
    r.stepDone = 0; r.stepTotal = 0; r.startedAt = startedAt; r.error = "";
    writeRecord(r);
  };
  try {
    ckCancel(id);
    setP(10, "重新识别说话人");
    const workAudio = rec.audioPath;
    timer.begin("说话人分离");
    // Hint the gateway with an UPPER BOUND only (max_speakers). Never num_speakers —
    // that forces EXACTLY N and would split a single speaker into N. We ALSO cap
    // client-side below so the contract holds even if the backend ignores the hint.
    const diar = await gwAudioOp(cfg, "diarization", workAudio, cfg.models.diar, { max_speakers: N });
    timer.finish();
    ckCancel(id);
    let dseg = (Array.isArray(diar?.segments) ? diar.segments : [])
      .map((s) => ({ start: +s.start, end: +s.end, speaker: String(s.speaker ?? "SPEAKER_00") }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
    if (!dseg.length) throw new Error("说话人分离未返回任何片段");
    const rawSpk = [...new Set(dseg.map((d) => d.speaker))];
    console.log(`[${id}] 重新识别：max_speakers=${N} → diar 返回 ${dseg.length} 段 / ${rawSpk.length} 位说话人 (${rawSpk.join(",")})`);

    // Cap to the top-N speakers by total speaking time; drop the rest so segments
    // fall back onto the nearest KEPT speaker. No-op when the backend already
    // honored max_speakers (distinct <= N).
    const dur = {};
    for (const d of dseg) dur[d.speaker] = (dur[d.speaker] || 0) + (d.end - d.start);
    const kept = Object.keys(dur).sort((a, b) => dur[b] - dur[a]).slice(0, N);
    const keptSet = new Set(kept);
    dseg = dseg.filter((d) => keptSet.has(d.speaker));
    const pick = (a, b) => {
      let best = dseg[0].speaker, bestOv = -1;
      for (const d of dseg) {
        const ov = Math.min(b, d.end) - Math.max(a, d.start);
        if (ov > bestOv) { bestOv = ov; best = d.speaker; }
      }
      return best;
    };

    setP(70, "重新指派说话人");
    const out = readRecord(id);
    const segments = out.result.segments || [];
    // Relabel to clean SPEAKER_0k in first-appearance order.
    const relabel = new Map();
    let next = 0;
    for (const seg of segments) {
      const raw = pick(seg.start, seg.end);
      if (!relabel.has(raw)) relabel.set(raw, `SPEAKER_${String(next++).padStart(2, "0")}`);
      seg.speaker = relabel.get(raw);
    }
    const speakers = [...relabel.values()];
    out.result.speakers = speakers;
    out.result.speakerNames = {}; // speaker edits no longer map -> reset
    out.result.participants = speakers.slice();
    const timings = timer.finish();
    out.status = "done"; out.progress = 100; out.phase = ""; out.error = "";
    writeRecord(out);
    addNotice(id, "info", `重新识别完成：目标上限 ${N} 人，实际识别出 ${speakers.length} 位说话人（文字记录已保留，说话人命名已重置）。`);
  } catch (e) {
    if ((e && e.cancelled) || cancelled.has(id)) revertStopped(id, rec);
    else {
      const cause = e?.cause ? `（${e.cause.code || e.cause.message || e.cause}）` : "";
      console.error(`[${id}] (ERROR) 重新识别失败：${e?.message || e}`, e?.cause || "");
      const out = readRecord(id) || rec;
      out.status = "done"; // record still has its transcript
      out.progress = 100; out.phase = "";
      out.error = String(e.message || e) + cause;
      writeRecord(out);
      addNotice(id, "error", `重新识别失败：${e?.message || e}${cause}`);
    }
  } finally {
    running.delete(id);
    cancelled.delete(id);
    jobAbort.delete(id);
    rediarTargets.delete(id);
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
    // 1) diarization over the whole clip. maxSpk is an UPPER BOUND only (max_speakers) —
    // never num_speakers — so the gateway may return FEWER if the audio has fewer voices.
    const maxSpk = Math.max(0, Math.floor(Number(opts.maxSpeakers) || 0));
    const diar = await gwAudioOp(cfg, "diarization", workAudio, cfg.models.diar, maxSpk > 0 ? { max_speakers: maxSpk } : {});
    ckCancel(id);
    const diarSegs = Array.isArray(diar?.segments) ? diar.segments : [];
    console.log(`[${id}] 说话人分离完成: ${diarSegs.length} 段  workAudio=${path.basename(workAudio)}${maxSpk > 0 ? `  (max_speakers=${maxSpk})` : ""}`);

    // 2) transcription strategy (integral vs segmented). Both feed the same
    //    fuse/sort tail below via segsOut. Forced alignment needs a language NAME
    //    per call; alignSlice auto-detects it from each slice's own text (or uses
    //    the explicit cfg.language override) — see resolveAlignLang.
    const segmented = !!cfg.segmentedStt;
    let language = "";
    let segsOut;
    let dbg = null;                 // detailed processing trace → /api/records/:id/debug
    const dbgDiar = diarSegs.length;

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
      const _t0 = Date.now();
      let _tSlice = 0, _tGw = 0;
      try {
        await sliceWav(workAudio, aStart, aEnd, slicePath);
        _tSlice = Date.now() - _t0;
        const langName = resolveAlignLang(cfg.language, text);
        if (!language) language = langName;
        const _g0 = Date.now();
        const al = await gwAudioOp(cfg, "align", slicePath, cfg.models.align, { text, language: langName });
        _tGw = Date.now() - _g0;
        if (al?.language) language = al.language;
        const units = (Array.isArray(al?.units) ? al.units : []).map((u) => ({
          text: u.text ?? u.word ?? u.token ?? "",
          start: round3(Number(u.start ?? u.start_time ?? 0) + aStart),
          end: round3(Number(u.end ?? u.end_time ?? 0) + aStart),
        }));
        // PER-CALL TIMING (every call): this is the only way to see where alignLong's wall
        // time goes — slice ffmpeg vs gateway inference, and how many calls happen.
        console.log(`[${id}] ⏱对齐(${tag}) 网关${(_tGw/1000).toFixed(1)}s 切片${(_tSlice/1000).toFixed(1)}s · 切片长${round3(aEnd - aStart)}s · text${text.length}字 · ${units.length}单元`);
        return units;
      } catch (e) {
        if (e && e.cancelled) throw e;
        console.error(`[${id}] 对齐(${tag})调用失败(${((Date.now()-_t0)/1000).toFixed(1)}s): ${e?.message || e}`);
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
      // Per-window STT+align run several windows at once for speed. These aligns are
      // SHORT (~30s) and independent, so a rare localhost collapse is bounded to one
      // window (degrades to spread word-timing) — no cross-window drift like 整段.
      return mapLimit(windows, 4, async (w, idx) => {
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
      dbg = { mode: "分段转写与词级对齐（逐窗 STT + 逐窗对齐）", punctuated: null, sttChars: 0, align: null };
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
        // Forced alignment over the WHOLE clip, REGULARIZED BY DIARIZATION (see
        // alignLong): windows are cut at diar pause midpoints and each window's text
        // is the diar-speech-time char span, so no leading text can trigger a
        // collapse. Times come straight from ALIGN; only an irreducible collapsed
        // span is interpolated. diarSegs is the same timeline used for segmentation.
        const alignTotal = rec.durationSec || 0;
        const { units, map, diag: alignDiag } = await alignLong(
          alignSlice, fullText, alignTotal, diarSegs,
          (frac) => setP(55 + Math.round(30 * frac), "词级对齐"),
          id,
        );
        console.log(`[${id}] 词级对齐(alignLong)完成：${units.length} 个单元，音频≈${Math.round(alignTotal)}s`);
        if (!units.length) throw new Error("对齐无结果");
        // Stash everything the detailed processing report needs (mode, whole-clip
        // STT text, and the per-window align trace incl. interpolated spans).
        dbg = { mode: `整段转写 + 词级对齐（${punctuated ? "按标点分句" : "按停顿/说话人/长度分句"}）`, punctuated, sttChars: fullText.length, fullText, alignTotal, align: alignDiag, units: units.length };
        // Smooth the aligner's local burst-then-gap micro-collapses so highlight
        // advances evenly instead of racing a run of words then stalling at a pause.
        deburstUnits(units);

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
        segsOut = [];
        if (punctuated) {
          // Segment by SENTENCE over the whole transcript, and take every word's
          // time DIRECTLY from forced alignment. We do NOT cut along, nor clamp into,
          // diarization windows any more: that crushed correct align times into a
          // single diar window and produced the same-second pile-ups. Diarization is
          // now used ONLY to label each finished segment's speaker (by time overlap).
          const cuts = sentenceCuts(fullText, 0, fullText.length);
          let prev = 0;
          for (const e of cuts) {
            // Sentence boundaries only; a rare over-long run-on wraps on a real
            // pause (never a comma) so no block ends on an unfinished clause.
            let sp = prev;
            for (const se of splitByPause(prev, e, units, map)) {
              const text = fullText.slice(sp, se).trim();
              const words = finalizeWords(sliceToWords(fullText, sp, se, timeAtChar));
              if (text || words.length) {
                const start = words.length ? words[0].start : round3(timeAtChar(sp));
                const end = words.length ? words[words.length - 1].end : round3(timeAtChar(se));
                segsOut.push({ start, end, speaker: pickSpeaker(start, end), text, words });
              }
              sp = se;
            }
            prev = e;
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
        // Speaker smoothing MUST run BEFORE the re-align pass: it keys off the crammed (~0s)
        // state, which the re-align is about to spread back to a normal duration.
        smoothSpeakers(segsOut, id);
        // Re-align GUESSED spans on the FINAL per-word timeline (CJK flying appears only after
        // sliceToWords): TRIGGER = uncovered (interpolated) chars; each uncovered run gets its
        // own audio slice re-aligned for REAL times, extended through a flying-run→spike block
        // when it overlaps one. Only units inside the chosen window are rewritten. alignDiag is
        // the same obj stashed in dbg.align (drives the report + uncovered alarm).
        await realignGuessedSpans(segsOut, fullText, alignDiag, alignSlice, id);
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
        dbg = { mode: "整段转写失败 → 回退分段转写与词级对齐", punctuated: null, sttChars: 0, align: null, fallbackError: String(e?.message || e) };
      }
    }

    timer.begin("整理结果");
    setP(94, "整理结果");
    // Times come straight from forced alignment; only order + drop empties. No
    // redistribution — alignment is authoritative (segment/merge/split must not
    // move a word's time), so the old repair pass is intentionally not called.
    const segments = segsOut
      .filter((s) => s.text || (s.words && s.words.length))
      .sort((a, b) => a.start - b.start);
    // Speaker smoothing (also covers the 分段转写 / fallback path here; the whole-clip path
    // already smoothed BEFORE its repair pass — this second call is a harmless no-op there).
    smoothSpeakers(segments, id);
    // Relabel diar's raw cluster IDs to SPEAKER_0k in FIRST-APPEARANCE order so the
    // roster numbering matches speaking order. pyannote numbers by cluster, not by who
    // speaks first, so 说话人 8 could be the first voice — the same relabel the
    // 重新识别说话人 path applies. Display-only: word/segment times and text untouched.
    const relabel = new Map();
    for (const s of segments) {
      if (!relabel.has(s.speaker)) relabel.set(s.speaker, `SPEAKER_${String(relabel.size).padStart(2, "0")}`);
      s.speaker = relabel.get(s.speaker);
    }
    const speakers = [...relabel.values()];

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
    out.result = { language: language || "", speakers, segments, participants: speakers.slice() };
    out.status = "done";
    out.progress = 100;
    out.phase = "";
    out.error = "";
    out.timings = timings;
    // Detailed processing trace for the debug report (/api/records/:id/debug). Kept
    // deliberately small (per-window rows + interpolated spans, no raw units) and
    // separate from result so exports stay clean. Remove before public release.
    out.debug = {
      builtAt: nowIso(),
      version: process.env.APP_VERSION || "",
      mode: dbg?.mode || "",
      punctuated: dbg?.punctuated ?? null,
      language: language || "",
      durationSec: rec.durationSec || 0,
      models: { stt: cfg.models?.stt || "", align: cfg.models?.align || "", diar: cfg.models?.diar || "", translate: cfg.translate?.model || "" },
      options: { segmentedStt: !!cfg.segmentedStt, translate: !!rec.options?.translate, enhance: !!rec.options?.enhance, maxSpeakers: Math.max(0, Math.floor(Number(rec.options?.maxSpeakers) || 0)) },
      diarWindows: dbgDiar,
      sttChars: dbg?.sttChars || 0,
      unitCount: dbg?.units || 0,
      segCount: segments.length,
      timings,
      align: dbg?.align || null,
      fallbackError: dbg?.fallbackError || "",
    };
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
  if (rec.clipOf) return res.status(400).json({ error: "片段不支持重新转写" });
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
    // Upper bound on speakers passed to diarization (0 = 自动/不限). Same semantics as
    // 重新识别说话人: it's a MAX (max_speakers), never a forced count.
    maxSpeakers: b.maxSpeakers !== undefined ? Math.max(0, Math.floor(Number(b.maxSpeakers) || 0)) : (prev.maxSpeakers ?? 0),
  };
  // Still extracting audio (or the wav isn't on disk yet)? Don't enqueue now —
  // remember the intent and let the prep job start transcription when it finishes.
  const wavMissing = rec.audioPath && !fs.existsSync(rec.audioPath);
  if (rec.status === "preparing" || wavMissing) {
    rec.pendingTranscribe = true;
    writeRecord(rec);
    return res.json({ ok: true, deferred: true, preparing: true });
  }
  startTranscribeJob(rec); // queued; the serial pump runs it when its turn comes
  res.json({ ok: true, queued: true });
});

// Add/refresh translation for an already-transcribed record (补翻译), without
// re-running the whole STT/align pipeline. Uses the current global translate model
// + target language.
app.post("/api/records/:id/translate", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  if (rec.clipOf) return res.status(400).json({ error: "片段不支持翻译" });
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

// Re-identify speakers: re-run diarization with an upper-bound speaker count and
// re-assign each segment's speaker, keeping transcript text edits. Speaker names +
// participant roster are reset.
app.post("/api/records/:id/rediarize", (req, res) => {
  const rec = readRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  if (rec.clipOf) return res.status(400).json({ error: "片段不支持重新识别说话人" });
  const cfg = loadConfig();
  if (!cfg.models?.diar) return res.status(400).json({ error: "无法重新识别：请先在设置中选择说话人分离(Diarize)模型" });
  if (!rec.result?.segments?.length) return res.status(400).json({ error: "该记录尚无转写内容" });
  if (running.has(rec.id) || queue.includes(rec.id))
    return res.json({ ok: true, alreadyRunning: true });
  const n = Math.max(1, Math.floor(Number(req.body?.speakers) || 1));
  const bfl = (req.headers["x-bfl-user"] || "").toString();
  if (bfl) rec.bflUser = bfl;
  rec.status = "processing";
  rec.progress = 1;
  rec.phase = "排队中（重新识别说话人）";
  rec.error = "";
  rec.jobKind = "rediarize";
  writeRecord(rec);
  rediarTargets.set(rec.id, n);
  enqueueJob(rec.id, "rediarize");
  res.json({ ok: true, queued: true });
});

// 创建片段: cut one or more time ranges out of a DONE record and concat them into a
// brand-new, fully-independent record (media re-encoded + transcript sliced/rebased
// from the parent). The new record links back via `clipOf`; it is generated async
// (status "generating") on the local clip queue. Clips cannot be re-transcribed /
// translated / re-diarized, nor can they spawn further clips (guarded above/here).
app.post("/api/records/:id/clip", (req, res) => {
  const parent = readRecord(req.params.id);
  if (!parent) return res.status(404).json({ error: "not found" });
  if (parent.clipOf) return res.status(400).json({ error: "片段不支持再创建片段" });
  if (parent.status !== "done" || !parent.result?.segments) return res.status(400).json({ error: "请先完成转写再创建片段" });
  const body = req.body || {};
  const dur = Number.isFinite(parent.durationSec) ? parent.durationSec : Infinity;
  const ranges = (Array.isArray(body.ranges) ? body.ranges : [])
    .map((r) => ({ start: Math.max(0, Number(r.start) || 0), end: Math.min(dur, Number(r.end) || 0) }))
    .filter((r) => r.end - r.start >= 0.1)
    .sort((a, b) => a.start - b.start)
    .map((r) => ({ start: round3(r.start), end: round3(r.end) }));
  if (!ranges.length) return res.status(400).json({ error: "请至少选择一个有效区间" });
  const id = randomUUID();
  const isVideo = parent.kind === "video";
  const total = ranges.reduce((a, r) => a + (r.end - r.start), 0);
  const title = (typeof body.title === "string" && body.title.trim()) ? body.title.trim() : `${parent.title} · 片段`;
  const rec = {
    id,
    title,
    kind: parent.kind,
    originalName: title + (isVideo ? ".mp4" : ".m4a"),
    mime: isVideo ? "video/mp4" : "audio/mp4",
    mediaPath: "",
    audioPath: "",
    durationSec: round3(total),
    status: "generating",
    progress: 5,
    phase: "生成中",
    error: "",
    options: { language: parent.options?.language || "auto", segmentedStt: false, translate: false, enhance: false },
    clipOf: parent.id,
    clipRanges: ranges,
    // 连续/非连续 reflects the user's selection (a single contiguous block is 连续),
    // even when 跳过空白 splits it into several speech-only cut ranges.
    continuous: typeof body.continuous === "boolean" ? body.continuous : ranges.length === 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    result: null,
  };
  writeRecord(rec);
  enqueueClip(id);
  res.json(recordSummary(rec));
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
    res.status(200).send("Audio Minutes X2 Demo server up. SPA not built yet (web/dist missing).")
  );
}

// On boot, any record left mid-flight from a previous process is re-queued so it
// resumes automatically — strictly one at a time through the serial queue (never
// in parallel). Ordered by createdAt so earlier uploads run first.
const interrupted = process.env.NO_LISTEN ? [] : listRecords()
  .filter((r) => r.status === "processing")
  .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
for (const rec of interrupted) enqueueJob(rec.id);

if (!process.env.NO_LISTEN) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[audiominutesx2demo] listening on :${PORT}  ffmpeg=${hasFfmpeg()}  data=${DATA_DIR}`);
  });
}

export { repairSegmentTimes, sentenceCuts, sentBounds, spreadWords, hasPunctuation, alignLong, reliableAlignEnd, mapUnitsBounded, buildCharToTime, resolveCoverage };
