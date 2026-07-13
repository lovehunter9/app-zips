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

// Index of the last TRUSTWORTHY unit in one align window: the last unit whose start
// is within the reliable time cap tMax, backed off to just before the FIRST collapse
// plateau (>=N consecutive starts within dt seconds — the LIS-clamp signature Qwen's
// aligner emits once it saturates). Never keeps piled-up timestamps.
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

// Long-audio forced alignment. Qwen3-ForcedAligner-0.6B is only reliable to ~270s;
// beyond that its indices saturate and the LIS monotonic pass collapses every
// trailing word onto ONE timestamp (the "same-second pile-up"). So we chunk by the
// aligner's OWN saturation point, never by guessed char proportions: align a <=WIN
// audio window fed with MORE than a window's worth of text, keep only the reliable
// prefix (words ending within SAFE seconds, cut before the first plateau), then
// start the next window at the last reliable word's END time with the remaining text
// (STT char ORDER tells us exactly which chars are left). Works for any length.
// Returns {units, map} in fullText coords; every time is pure ALIGN.
async function alignLong(alignSlice, fullText, total, onProg, id = "") {
  const WIN = 290, SAFE = 255;
  const units = [], map = [];
  let a = 0, cOff = 0, pass = 0, degraded = 0;
  let cps = fullText.length / Math.max(1, total); // running chars/sec estimate
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  while (a < total - 0.05 && cOff < fullText.length) {
    pass++;
    const b = Math.min(total, a + WIN);
    const lastWin = b >= total - 0.05;
    // Over-provide text so the reliable prefix is never starved; the surplus just
    // collapses at the tail and gets discarded by reliableAlignEnd.
    const want = lastWin ? fullText.length - cOff : Math.ceil(cps * (b - a) * 1.5) + 30;
    const part = fullText.slice(cOff, Math.min(fullText.length, cOff + want));
    // Align the window, retrying BOTH transient empty responses (timeout / 5xx) AND
    // load-induced degradation. Under a busy shared GPU the aligner can, for one
    // window, advance AUDIO normally but consume almost no TEXT — because unit texts
    // stop matching the transcript, or the times back-load so the reliable prefix
    // trims to nothing. Either way the next window gets stale text aligned against
    // later audio, shifting it ~one window (~5 min) later: the load-only "+290s jump"
    // (unloaded runs of the same audio/text are clean). We keep the best attempt and,
    // if still degraded, force the text cursor to track the audio cursor by cps.
    let best = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await alignSlice(a, b, part, attempt ? `wa_${pass}r${attempt}` : `wa_${pass}`);
      if (!cur.length) continue;
      const ck = lastWin ? cur.length - 1 : reliableAlignEnd(cur, a + SAFE);
      const lmTry = mapUnitsBounded(cur.slice(0, ck + 1), part);
      const covA = cur[ck].end - a;                               // reliable prefix audio span
      const covC = lmTry.length ? lmTry[lmTry.length - 1].cj : 0;  // chars consumed in part
      const rawSpan = cur[cur.length - 1].end - a;                // content span of raw window
      const matched = lmTry.reduce((n, x) => n + (x.hit ? 1 : 0), 0);
      const matchRate = matched / Math.max(1, lmTry.length);
      const expC = cps * Math.max(0, covA);                       // chars the audio span implies
      const dense = cur.length > 40;
      const earlyPlateau = !lastWin && dense && covA < 30 && rawSpan > 60;
      // Mechanism-agnostic: audio moved but text consumed far below the running rate.
      // Catches char-undermap (garbage texts) AND back-loaded times (prefix trimmed).
      const lagging = !lastWin && dense && covA > 20 && covC < 0.3 * expC;
      const bad = earlyPlateau || lagging;
      // Prefer a non-degraded attempt; otherwise keep the one with the best matchRate.
      if (!best || (best.bad && !bad) || (best.bad === bad && matchRate > best.matchRate)) {
        best = { u: cur, k: ck, lm: lmTry, covA, covC, expC, matchRate, earlyPlateau, lagging, bad };
      }
      if (!bad) break;
    }
    if (onProg) try { onProg(Math.min(1, b / Math.max(1, total))); } catch { /* ignore */ }
    if (!best) {
      // All attempts empty. CRITICAL: advance the TEXT cursor too, not just the
      // audio — skipping only audio re-feeds this window's text to the next window
      // (the ~5-min shift). Advance cOff by the cps estimate so the skipped text
      // degrades to interpolated time in [a,b] and later windows stay in sync.
      degraded++;
      console.log(`[${id}] alignLong 空窗 pass${pass} a=${a.toFixed(0)} b=${b.toFixed(0)} cOff=${cOff}（重试后仍空，按 cps 前进）`);
      if (!lastWin) cOff = Math.min(fullText.length, cOff + Math.max(1, Math.round(cps * (b - a))));
      a = b;
      continue;
    }
    const { u, k, lm } = best;
    // Clamp every kept time into THIS window so no single unit can inject an
    // out-of-window (huge forward) timestamp into the global map.
    for (let i = 0; i <= k; i++) {
      const st = clamp(u[i].start, a, b);
      units.push({ text: u[i].text, start: st, end: clamp(u[i].end, st, b) });
      map.push({ ci: cOff + lm[i].ci, cj: cOff + lm[i].cj });
    }
    if (lastWin) break;
    let nextA = u[k].end, nextC = cOff + lm[k].cj, action = "";
    if (best.earlyPlateau) {
      // Reliable prefix collapsed at the window start: advance audio + text together
      // by the cps estimate (that span becomes interpolated) instead of trusting it.
      const adv = Math.min(SAFE, total - a);
      nextA = a + adv;
      nextC = Math.min(fullText.length, cOff + Math.max(1, Math.round(cps * adv)));
      action = "earlyPlateau→proportional";
    } else if (best.lagging) {
      // Audio advanced but text lagged: force the text cursor to track the audio span
      // so stale text is NOT re-fed to a later window (this span becomes interpolated).
      nextC = Math.min(fullText.length, cOff + Math.max(1, Math.round(cps * (nextA - a))));
      action = "textLag→trackAudio";
    }
    if (best.bad) {
      // Diagnostic: capture the failing window so a test-machine reproduction gives
      // the raw evidence (which shape, whether the guard fired) instead of a guess.
      degraded++;
      const w0 = best.u[0] || {};
      console.log(`[${id}] alignLong 窗降级 pass${pass} ${action} a=${a.toFixed(0)} b=${b.toFixed(0)} cOff=${cOff} units=${best.u.length} k=${k} covA=${best.covA.toFixed(0)}s covC=${best.covC} expC=${Math.round(best.expC)} matchRate=${best.matchRate.toFixed(2)} 首unit="${(w0.text || "").slice(0, 16)}"@${(w0.start || 0).toFixed(1)}`);
    }
    if (nextA <= a + 1 || nextC <= cOff) { a = b; cOff = Math.max(nextC, cOff + 1); continue; } // no-progress guard
    cps = (nextC - cOff) / Math.max(0.5, nextA - a);
    a = nextA; cOff = nextC;
  }
  if (degraded) console.log(`[${id}] alignLong 完成：${degraded} 个窗判定降级并已按 cps 兜底前进（正常应为 0）`);
  return { units, map };
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
        // Forced alignment over the WHOLE clip, chunked at the aligner's OWN
        // saturation point (see alignLong). Qwen3-ForcedAligner is reliable only to
        // ~270s; past that its output collapses. alignLong keeps each window's
        // reliable prefix and re-aligns the remainder from the last reliable word,
        // so char times come straight from ALIGN — never from char-proportion guesses.
        const alignTotal = rec.durationSec || 0;
        const { units, map } = await alignLong(
          alignSlice, fullText, alignTotal,
          (frac) => setP(55 + Math.round(30 * frac), "词级对齐"),
          id,
        );
        console.log(`[${id}] 词级对齐(alignLong)完成：${units.length} 个单元，音频≈${Math.round(alignTotal)}s`);
        if (!units.length) throw new Error("对齐无结果");
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
    // Times come straight from forced alignment; only order + drop empties. No
    // redistribution — alignment is authoritative (segment/merge/split must not
    // move a word's time), so the old repair pass is intentionally not called.
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
    res.status(200).send("Audio Minutes X Demo server up. SPA not built yet (web/dist missing).")
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
    console.log(`[audiominutesxdemo] listening on :${PORT}  ffmpeg=${hasFfmpeg()}  data=${DATA_DIR}`);
  });
}

export { repairSegmentTimes, sentenceCuts, sentBounds, spreadWords, hasPunctuation };
