import { useEffect, useMemo, useState } from "react";
import {
  alignAudio,
  audioBatch,
  audioMultipart,
  BATCH_TARGET_BYTES,
  WAV_BYTES_PER_SEC,
  fetchDefaultModels,
  fetchProviderModels,
  fetchSilences,
  fetchUploadAudio,
  transcodeToMp3,
  translate,
  translateBatch,
  uploadMedia,
  type CallResult,
} from "./api";
import { alignTextToTimeline, distributeTextOverRuns } from "./align";
import {
  AUDIO_MODE,
  CAP_LABEL,
  CAP_SUPPORT,
  CAP_ORDER,
  type CapId,
  type ExecRecord,
  type ProviderModel,
  type Settings,
  type UploadInfo,
} from "./types";
import { decodeAudio, mapLimit, sliceWav, type DecodedAudio } from "./audio";
import { StreamView } from "./stream";
import { franc } from "franc-min";

const LS_KEY = "audiostudiox2demo.settings";
const TARGET_LANGS = [
  { code: "zho_Hans", label: "中文(简)" },
  { code: "eng_Latn", label: "English" },
  { code: "jpn_Jpan", label: "日本語" },
  { code: "kor_Hang", label: "한국어" },
  { code: "fra_Latn", label: "Français" },
  { code: "spa_Latn", label: "Español" },
];
// Source picker = auto-detect + the same language set as targets.
const SOURCE_LANGS = [{ code: "auto", label: "自动检测" }, ...TARGET_LANGS];

// Lightweight source-language detection limited to the languages we support.
// Script checks first (reliable even on short lines: Hangul / Kana / Han), then
// franc for the Latin trio (en/fr/es) where script alone can't decide. Returns a
// FLORES-200 code; `fallback` (usually the document-level guess) covers text too
// short for franc (it returns "und").
const FRANC_TO_FLORES: Record<string, string> = {
  cmn: "zho_Hans",
  eng: "eng_Latn",
  jpn: "jpn_Jpan",
  kor: "kor_Hang",
  fra: "fra_Latn",
  spa: "spa_Latn",
};
function detectLang(text: string, fallback = "eng_Latn"): string {
  const t = (text || "").trim();
  if (!t) return fallback;
  if (/[\uAC00-\uD7A3]/.test(t)) return "kor_Hang"; // Hangul
  if (/[\u3040-\u30FF]/.test(t)) return "jpn_Jpan"; // Hiragana / Katakana
  if (/[\u4E00-\u9FFF]/.test(t)) return "zho_Hans"; // Han (kanji-only treated as zh here)
  const code = franc(t, { only: ["eng", "fra", "spa", "cmn", "jpn", "kor"] });
  return FRANC_TO_FLORES[code] || fallback;
}
const langLabel = (code: string) => SOURCE_LANGS.find((l) => l.code === code)?.label || code;

// Qwen3-ForcedAligner takes a language NAME ("Chinese"/"English"/…), not a FLORES
// code. Map our FLORES source codes to the aligner's names; unknown → undefined
// (let the model auto-detect). "auto" is resolved by the caller via detectLang first.
const FLORES_TO_ALIGN_LANG: Record<string, string> = {
  zho_Hans: "Chinese",
  eng_Latn: "English",
  jpn_Jpan: "Japanese",
  kor_Hang: "Korean",
  fra_Latn: "French",
  spa_Latn: "Spanish",
};
const alignLangName = (floresCode: string): string | undefined => FLORES_TO_ALIGN_LANG[floresCode];

// The Hy-MT2 translate model speaks MTran codes (zh-Hans/en/ja/…), not FLORES.
// Map our FLORES picks to MTran; unknown -> "auto" (let the model detect).
const FLORES_TO_MTRAN: Record<string, string> = {
  zho_Hans: "zh-Hans",
  zho_Hant: "zh-Hant",
  eng_Latn: "en",
  jpn_Jpan: "ja",
  kor_Hang: "ko",
  fra_Latn: "fr",
  spa_Latn: "es",
};
const floresToMtran = (flores: string): string => FLORES_TO_MTRAN[flores] || "auto";

function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return { base: s.base || "", key: s.key || "", bflUser: s.bflUser || "", cookie: s.cookie || "" };
  } catch {
    return { base: "", key: "", bflUser: "", cookie: "" };
  }
}

// ---- shape-tolerant parsers for engine responses ----
interface Seg {
  start: number;
  end: number;
  text?: string;
  speaker?: string;
  cont?: boolean; // this slice is a split-continuation overlapping the previous one (dedup its head)
}
function asSegments(obj: any, key = "segments"): Seg[] {
  const arr = Array.isArray(obj) ? obj : obj?.[key] || obj?.segments || [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s: any) => ({
      start: Number(s.start ?? s.begin ?? s.from ?? 0),
      end: Number(s.end ?? s.stop ?? s.to ?? 0),
      text: s.text ?? s.transcript,
      speaker: s.speaker ?? s.label ?? s.speaker_id,
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
}
// Merge adjacent segments into fewer, larger STT windows. VAD (and even diar) can
// emit many tiny fragments (one every ~2s → hundreds of micro-clips for a long
// file), and transcribing each one is slow (one gateway round-trip per fragment)
// AND low-quality (1–2 words, no context). We coalesce same-speaker neighbours
// while the running window stays under `maxDur` (whisper's native window is 30s)
// and the silence gap to the next stays under `maxGap`. 371 VAD bits → a few dozen
// ~30s windows: far fewer calls, fuller text, better accuracy. Timestamps/speaker
// are preserved (window start = first bit, end = last bit, speaker = the shared one).
function coalesceSegments(segs: Seg[], maxDur = 28, maxGap = 1.5): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (
      last &&
      (last.speaker || "") === (s.speaker || "") &&
      s.start - last.end <= maxGap &&
      s.end - last.start <= maxDur
    ) {
      last.end = s.end;
    } else {
      out.push({ start: s.start, end: s.end, speaker: s.speaker });
    }
  }
  return out;
}
// coalesceSegments only MERGES — it never splits an input segment that is already longer
// than maxDur (a single speaker turn can run 100s+). Feeding whisper a >30s clip makes it
// hallucinate repetition loops ("姆·姆·姆…") even though vLLM chunks internally. So split
// oversized slices into <=maxDur pieces. Each non-first piece reaches `overlap` seconds back
// into the previous one (so a word cut at the seam is fully captured by at least one piece);
// the duplicated text is removed afterwards by dedupOverlap. Pieces are tagged `cont`.
function splitLong(segs: Seg[], maxDur = 30, overlap = 1): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const dur = s.end - s.start;
    if (dur <= maxDur + 0.01) {
      out.push(s);
      continue;
    }
    const eff = Math.max(1, maxDur - overlap); // base step keeps piece+overlap <= maxDur
    const n = Math.ceil(dur / eff);
    const step = dur / n;
    for (let i = 0; i < n; i++) {
      const a = i === 0 ? s.start : s.start + i * step - overlap;
      const b = i === n - 1 ? s.end : s.start + (i + 1) * step;
      out.push({ start: Math.max(s.start, a), end: b, speaker: s.speaker, cont: i > 0 });
    }
  }
  return out;
}
// With neither VAD nor Diarize, there are no segments to slice by. We still must NOT send
// the raw upload (e.g. an mp3) straight to the STT engine — the vLLM transcription engines
// reject containers they can't decode ("Invalid or unsupported audio file"); only the
// decoded-to-WAV slices the per-segment path produces are guaranteed to work. So tile the
// whole clip into fixed `win`-second windows and run the SAME WAV fan-out (also fixes long
// audio + gives per-call progress). A short clip becomes a single window ≈ whole-clip.
function windowSegs(duration: number, win = 30): Seg[] {
  if (!Number.isFinite(duration) || duration <= 0) return [{ start: 0, end: 0 }];
  const out: Seg[] = [];
  for (let t = 0; t < duration - 0.05; t += win) out.push({ start: t, end: Math.min(duration, t + win) });
  return out.length ? out : [{ start: 0, end: duration }];
}
// 分段批量:把窗口按"累计上传 WAV 字节 ≤ target"贪心成批(避开网关 32M body 上限;
// 16k 单声道 WAV = 32KB/s,target 30M ≈ ~15.6min/批)。
function packSttBatches(windows: Seg[], targetBytes = BATCH_TARGET_BYTES): Seg[][] {
  const batches: Seg[][] = [];
  let cur: Seg[] = [];
  let bytes = 0;
  for (const w of windows) {
    const wb = Math.max(1, w.end - w.start) * WAV_BYTES_PER_SEC;
    if (cur.length && bytes + wb > targetBytes) { batches.push(cur); cur = []; bytes = 0; }
    cur.push(w);
    bytes += wb;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
// ---- Align (forced alignment) helpers ----
interface AlignWin {
  clip: Blob;
  text: string;
  offset: number; // absolute start (s) added to each window-local unit time
  speaker?: string; // stable speaker for ALL units in this window (per-segment mode)
}
// Window-primitive runner shared by BOTH modes: whole-clip ("分段对齐" off → a
// single window) and per-segment ("分段对齐" on → one window per VAD/Diar segment).
// The ONLY thing that differs between the two is how the caller builds `wins`;
// the call, merge, speaker attribution and display are identical — so switching
// modes is a small delta, never a rewrite.
async function runAlignWindows(
  s: Settings,
  model: string,
  wins: AlignWin[],
  language: string | undefined,
  concurrency: number,
  onTick?: () => void
): Promise<{ units: Seg[]; ok: number; total: number; lastStatus: number; errSample: string }> {
  let ok = 0,
    lastStatus = 0,
    errSample = "";
  const per = await mapLimit(wins, Math.max(1, concurrency), async (w) => {
    const res = await callRetry(() => alignAudio(s, model, w.clip, w.text, language), 4);
    lastStatus = res.status;
    if (res.ok) ok++;
    else if (!errSample) errSample = `${res.status}: ${errBody(res)}`;
    const raw = Array.isArray(res.json?.units) ? res.json.units : [];
    const units: Seg[] = raw.map((u: any) => ({
      start: Number(u.start ?? 0) + w.offset,
      end: Number(u.end ?? 0) + w.offset,
      text: u.text ?? "",
      // stable per-window speaker (per-segment mode); undefined → caller derives later
      ...(w.speaker !== undefined ? { speaker: w.speaker } : {}),
    }));
    onTick?.();
    return units;
  });
  const units = per.flat().sort((a, b) => a.start - b.start);
  return { units, ok, total: wins.length, lastStatus, errSample };
}
// Join text pieces inserting a space ONLY when both sides of the seam are non-CJK
// (so English "fresh" + "start" → "fresh start", but Chinese "万里" + "，飞过" stays glued
// without the spurious spaces that a naive join(" ") sprinkles through CJK text).
const isCJK = (ch: string): boolean => !!ch && /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(ch);
function smartCat(x: string, y: string): string {
  const a = (x || "").trim();
  const b = (y || "").trim();
  if (!a) return b;
  if (!b) return a;
  const sp = !isCJK(a[a.length - 1]) && !isCJK(b[0]) ? " " : "";
  return a + sp + b;
}
function joinSegText(parts: (string | undefined)[]): string {
  return parts.reduce<string>((acc, p) => smartCat(acc, p || ""), "");
}
// The aligner returns bare spoken tokens (word/char level) WITHOUT spaces or
// sentence punctuation. Rebuilding line text by concatenating units therefore glues
// English words and drops all punctuation. Instead we map each unit back to its
// character span in the ORIGINAL reference text (greedy forward search, case-
// insensitive fallback) and slice the ORIGINAL text for display — preserving spaces,
// punctuation and casing. Align is used ONLY for timing.
function mapUnitsToRef(units: Seg[], refText: string): { ci: number; cj: number }[] {
  const out: { ci: number; cj: number }[] = [];
  let cursor = 0;
  const lower = refText.toLowerCase();
  for (const u of units) {
    const t = (u.text || "").trim();
    if (!t) {
      out.push({ ci: cursor, cj: cursor });
      continue;
    }
    let idx = refText.indexOf(t, cursor);
    if (idx < 0) idx = lower.indexOf(t.toLowerCase(), cursor);
    if (idx < 0) {
      out.push({ ci: cursor, cj: Math.min(refText.length, cursor + t.length) });
      continue;
    }
    out.push({ ci: idx, cj: idx + t.length });
    cursor = idx + t.length;
  }
  return out;
}
// Build a monotonic char-position → time table from the aligned units so ANY character index
// can be given a time by interpolation — even where the aligner's tokens didn't match the
// reference text (so a line never has to "fold" into a neighbour for lack of a unit).
function buildCharToTime(units: Seg[], map: { ci: number; cj: number }[]): (c: number) => number {
  const aC: number[] = [];
  const aT: number[] = [];
  for (let i = 0; i < units.length; i++) {
    aC.push(map[i].ci);
    aT.push(units[i].start);
    aC.push(map[i].cj);
    aT.push(units[i].end);
  }
  for (let i = 1; i < aC.length; i++) if (aC[i] < aC[i - 1]) aC[i] = aC[i - 1];
  return (c: number): number => {
    if (!aC.length) return 0;
    if (c <= aC[0]) return aT[0];
    for (let i = 1; i < aC.length; i++) {
      if (c <= aC[i]) {
        const c0 = aC[i - 1];
        const c1 = aC[i];
        return c1 <= c0 ? aT[i] : aT[i - 1] + ((aT[i] - aT[i - 1]) * (c - c0)) / (c1 - c0);
      }
    }
    return aT[aT.length - 1];
  };
}
// Punctuation-driven line breaks within refText[c0,c1):
//   • always break after a sentence end (。！？, or Latin .!? next to space/quote/end)
//   • a sentence shorter than maxLen stays whole (a line never stops on an early comma)
//   • a longer sentence wraps at its LAST comma before the cap (pieces as long as possible),
//     or — if it has no comma — at a CJK char / Latin space (never mid-word)
// Returns exclusive end positions, the last being c1.
function punctLineBreaks(refText: string, c0: number, c1: number, maxLen: number): number[] {
  const swallow = (k: number): number => {
    let j = k + 1;
    while (j < c1 && /["'”’」』）)\]\s]/.test(refText[j])) j++;
    return j;
  };
  // A comma-less clause is only force-wrapped once it runs this long, so English lines
  // break at punctuation (comma / sentence end) rather than at an arbitrary mid-clause
  // space (which produced orphan fragments like ".../ do" + "it myself.").
  const hardCap = Math.max(maxLen * 2, 160);
  const cuts: number[] = [];
  let lineStart = c0;
  let lastComma = -1;
  for (let i = c0; i < c1; i++) {
    const ch = refText[i];
    const nxt = i + 1 < c1 ? refText[i + 1] : "";
    const sentEnd = /[。！？]/.test(ch) || (/[.!?]/.test(ch) && (nxt === "" || /[\s"'”’)\]]/.test(nxt)));
    const comma = /[，、；,;：:]/.test(ch);
    let cutAt = -1;
    if (sentEnd) cutAt = swallow(i);
    else if (comma) lastComma = swallow(i);
    // Past the soft cap, prefer a natural CLAUSE break (comma/、；: etc.) for BOTH scripts.
    if (cutAt < 0 && i - lineStart + 1 >= maxLen) {
      if (lastComma > lineStart) cutAt = lastComma;
      else if (isCJK(ch)) cutAt = i + 1; // CJK has no spaces → wrap at a char (unchanged)
      // Latin with NO clause mark yet: do NOT wrap mid-clause at a space — respect the
      // punctuation and read on to the next comma / sentence end. The hardCap below is
      // the only space-wrap fallback, so one comma-less run can't swallow the screen.
    }
    if (cutAt < 0 && !isCJK(ch) && (nxt === "" || /\s/.test(nxt)) && i - lineStart + 1 >= hardCap) {
      cutAt = i + 1;
    }
    if (cutAt > lineStart) {
      cuts.push(cutAt);
      lineStart = cutAt;
      lastComma = -1;
      i = cutAt - 1;
    }
  }
  if (!cuts.length || cuts[cuts.length - 1] !== c1) cuts.push(c1);
  return cuts;
}
// Build fused Seg lines for refText[c0,c1): break by punctuation/length, time each line by
// char-position interpolation, and attach the given speaker (if any). Verbatim text slices.
function linesFromRange(
  refText: string,
  c0: number,
  c1: number,
  timeAtChar: (c: number) => number,
  maxLen: number,
  speaker?: string
): Seg[] {
  const cuts = punctLineBreaks(refText, c0, c1, maxLen);
  const lines: Seg[] = [];
  let prev = c0;
  for (const e of cuts) {
    const s0 = prev;
    prev = e;
    const text = refText.slice(s0, e).trim();
    if (!text) continue;
    lines.push({ start: timeAtChar(s0), end: timeAtChar(e), text, ...(speaker !== undefined ? { speaker } : {}) });
  }
  return lines;
}
// No-skeleton path: group the whole transcript purely by its own punctuation.
function groupAlignUnitsRef(units: Seg[], refText: string, maxLen = 80): Seg[] {
  if (!units.length || !refText) return [];
  const map = mapUnitsToRef(units, refText);
  return linesFromRange(refText, 0, refText.length, buildCharToTime(units, map), maxLen);
}
// Use an EXISTING segmentation (the STT / VAD / Diarize segments — text + speaker already
// good) as the fused skeleton, and let Align only TIGHTEN each segment's start/end to the
// real spoken extent (min/max of the aligned units overlapping that segment). This keeps the
// granularity the user already liked instead of re-grouping from scratch — the answer to
// "能不能把说话人分离的分段拿来做参考". Segments with no overlapping unit keep their original times.
function refineSegmentsWithAlign(skeleton: Seg[], units: Seg[]): Seg[] {
  return skeleton
    .filter((s) => (s.text || "").trim())
    .map((s) => {
      const inside = units.filter((u) => Math.min(u.end, s.end) - Math.max(u.start, s.start) > 0);
      if (!inside.length) return { ...s };
      const start = Math.min(...inside.map((u) => u.start));
      const end = Math.max(...inside.map((u) => u.end));
      return { start, end, text: s.text, speaker: s.speaker };
    });
}
// Candidate punctuation positions (char index AFTER the mark, swallowing trailing closing
// quotes/brackets/spaces) — sentence ends AND clause marks, plus 0 and length. These are the
// only places a fused line is allowed to start/end.
function punctBounds(refText: string): number[] {
  const s = new Set<number>([0, refText.length]);
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
// Respect BOTH the diar timeline AND the text punctuation: keep one fused line per diar run
// (so the speaker timeline is honoured) but SNAP every run boundary to the nearest punctuation
// position. When a diar boundary lands mid-sentence it moves to the closest mark — merging a
// run into its neighbour if that empties it — so a line never starts/ends mid-word or on a lone
// quote, while the timeline shifts as little as possible. Implements the user's rule:
//   • no punctuation        → (caller uses refineSegmentsWithAlign: timeline is everything)
//   • diar boundary == punct → unchanged (snap distance 0)
//   • diar boundary ≠ punct  → snap to nearest punct (minimal timeline impact)
function snapRunsToPunct(runs: Seg[], units: Seg[], refText: string, maxLen = 80): Seg[] {
  if (!runs.length) return [];
  if (!units.length) return refineSegmentsWithAlign(runs, units);
  const map = mapUnitsToRef(units, refText);
  const timeAtChar = buildCharToTime(units, map);
  const bounds = punctBounds(refText);
  const timeToChar = (t: number): number => {
    for (let i = 0; i < units.length; i++) {
      if (t <= units[i].end) {
        if (t <= units[i].start) return map[i].ci;
        const span = Math.max(1e-6, units[i].end - units[i].start);
        return Math.round(map[i].ci + ((t - units[i].start) / span) * (map[i].cj - map[i].ci));
      }
    }
    return refText.length;
  };
  // Snap each run boundary to the nearest punctuation that is STRICTLY AFTER the previous
  // boundary. This both cleans the cut to a punctuation AND guarantees every run keeps a
  // distinct, non-empty slice — so a run shorter than a sentence is nudged to the next mark
  // instead of collapsing (which previously cascaded whole passages into one giant block).
  const ci: number[] = [0];
  let last = 0;
  for (let k = 1; k < runs.length; k++) {
    const target = timeToChar(runs[k].start);
    let cand = -1;
    let bd = Infinity;
    for (const b of bounds) {
      if (b <= last) continue;
      const d = Math.abs(b - target);
      if (d < bd) {
        bd = d;
        cand = b;
      }
    }
    ci.push(cand < 0 ? refText.length : cand);
    last = ci[ci.length - 1];
  }
  ci.push(refText.length);
  const out: Seg[] = [];
  for (let k = 0; k < runs.length; k++) {
    const c0 = ci[k];
    const c1 = ci[k + 1];
    if (c1 <= c0) continue; // run swallowed by snapping → merged into a neighbour
    if (!refText.slice(c0, c1).trim()) continue;
    // Split the run's text by punctuation/length too — so a long single-speaker monologue
    // run becomes several readable lines (same speaker) instead of one giant block.
    out.push(...linesFromRange(refText, c0, c1, timeAtChar, maxLen, runs[k].speaker));
  }
  return out.length ? out : refineSegmentsWithAlign(runs, units);
}
// Split a long reference text into n roughly-equal parts for the whole-clip auto-split
// align path, preferring to cut at sentence boundaries (。！？.!?) near each target so a
// sentence isn't sliced across two audio windows. Proportional (assumes ~steady speech
// rate) — coarse on purpose; the accurate path is per-segment ("分段对齐").
function splitTextN(text: string, n: number): string[] {
  if (n <= 1 || !text) return [text];
  const len = text.length;
  const parts: string[] = [];
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

// Remove text duplicated by the audio overlap between a split-continuation piece and its
// predecessor: find the largest tail-of-prev == head-of-cur (char-level, so it works for
// both space-delimited and CJK text) and drop it from the head of `cur`. Best-effort — if
// ASR transcribed the seam differently, no match is found and `cur` is returned intact.
function dedupOverlap(prev: string, cur: string): string {
  const a = prev.trimEnd();
  const b = cur.trimStart();
  const max = Math.min(40, a.length, b.length);
  for (let k = max; k >= 2; k--) {
    if (a.slice(a.length - k).toLowerCase() === b.slice(0, k).toLowerCase()) {
      return b.slice(k).trimStart();
    }
  }
  return b;
}
function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
function srtTime(t: number): string {
  const ms = Math.floor((t % 1) * 1000);
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}
function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
const SPEAKER_COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#a3e635"];
function speakerColor(spk: string, list: string[]): string {
  const i = list.indexOf(spk);
  return SPEAKER_COLORS[(i < 0 ? 0 : i) % SPEAKER_COLORS.length];
}

// Per-model concurrency presets for the STT fan-out. Whisper (encoder-decoder, tiny
// per-request KV, short decode) tolerates far more parallelism than Qwen3-ASR
// (decoder-only, autoregressive, heavier audio-context KV). def = recommended start
// value, max = the slider ceiling. Shared-GPU contention can lower the real sweet
// spot, so these are starting points the user can drag.
function sttConcBounds(model: string): { def: number; max: number } {
  const m = (model || "").toLowerCase();
  if (m.includes("whisper")) return { def: 8, max: 16 };
  // Qwen3-ASR on vLLM: each concurrent request holds host-RAM audio-decode + KV
  // buffers; too many at once spikes RAM past the container limit → OOMKilled →
  // restart → 502 window (vLLM is slow to boot). Keep the default conservative
  // (user can still drag up) so the base instance stays stable under long-audio load.
  if (m.includes("qwen")) return { def: 2, max: 6 };
  return { def: 4, max: 8 };
}
const TRANSLATE_CONC_MAX = 12;

const is5xx = (res: CallResult) => res.status === 502 || res.status === 503 || res.status === 504;
// A 502/504 whose body is the Olares edge HTML (envoy/openresty) — i.e. the public
// edge cut a still-running long job, NOT a real engine error. Used to show a calm
// "edge timeout on long audio" note instead of dumping the gateway error page.
const isEdgeTimeout = (res: CallResult) =>
  (res.status === 502 || res.status === 504) &&
  /openresty|gateway|<html|terminus-language|bad gateway|gateway timeout/i.test(String(res.text ?? JSON.stringify(res.json ?? "")));
// The Gateway opens a per-provider circuit breaker after repeated upstream
// failures; once open it returns 503 immediately. Retrying an open breaker is
// pointless and only prolongs the outage, so detect it and stop.
function isCircuitOpen(res: CallResult): boolean {
  return /circuit/i.test(JSON.stringify(res.json ?? res.text ?? ""));
}
// Retry only genuine transient failures, with backoff; never hammer an open breaker.
async function callRetry(fn: () => Promise<CallResult>, tries = 3): Promise<CallResult> {
  let res = await fn();
  for (let attempt = 1; attempt < tries && (is5xx(res) || res.status === 0); attempt++) {
    if (isCircuitOpen(res)) break;
    await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    res = await fn();
  }
  return res;
}
function errBody(res: CallResult): string {
  return JSON.stringify(res.json ?? res.text ?? "").slice(0, 400);
}

export default function App() {
  const [view, setView] = useState<"file" | "stream">("file");
  const [settings, setSettings] = useState<Settings>(loadSettings());
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [modelStatus, setModelStatus] = useState<string>("");
  const [enabled, setEnabled] = useState<Record<CapId, boolean>>({
    stt: true,
    align: false,
    translate: false,
    vad: false,
    diar: false,
    enhance: false,
    embed: false,
  });
  const [selModel, setSelModel] = useState<Record<CapId, string>>({} as any);
  const [target, setTarget] = useState("zho_Hans");
  const [source, setSource] = useState("auto");
  // whether enhance output feeds downstream steps (off is safer for music: the
  // speech-denoiser strips non-speech, which can gut a song before VAD/STT see it)
  const [enhancePre, setEnhancePre] = useState(true);
  // Fan-out concurrency (user-tunable sliders). STT default tracks the selected STT
  // model (see effect below); translate is model-agnostic (NLLB is light).
  const [sttConc, setSttConc] = useState(4);
  // STT timestamp post-processing: ON = distribute the whole-clip transcript over the
  // VAD/Diarize (or silencedetect) timeline to get per-segment timestamps; OFF = show the
  // engine's raw output (Qwen → one untimed block, Whisper → native verbose_json segments).
  const [alignTs, setAlignTs] = useState(true);
  // 转写模式: "batch"(默认) 分段批量——窗口按上传字节成批,每批 1 次 batch STT + 1 次 batch
  // align(少往返、抗长音频); "segmented" 逐段——每窗一个请求(N 次); "integral" 整段——单次整段。
  // batch/segmented 需 VAD/Diarize 提供分段;integral 走原来的整段路径。
  const [sttMode, setSttMode] = useState<"integral" | "segmented" | "batch">("batch");
  // "分段对齐": OFF = whole-clip single align call (the heuristic was here before);
  // ON (needs VAD/Diarize + STT) = align each VAD/Diar segment against its own STT
  // text (one call per segment, offset=seg.start). The proper long-audio path —
  // each segment is <300s, so the model's 5-min cap never bites.
  const [alignPerSeg, setAlignPerSeg] = useState(false);
  // Per-segment (per-line) translation: ON = translate each fused transcript line (concurrent,
  // shown per-segment in the fused view); OFF = one whole-text translation call. Default OFF
  // — like every other default, it minimises the number of gateway calls.
  const [translatePerSeg, setTranslatePerSeg] = useState(false);
  const [translateConc, setTranslateConc] = useState(4);
  // Manual text → translate WITHOUT audio. Only used when no audio is uploaded; when audio
  // IS present this box is ignored (audio transcript drives translation). Lets the Demo also
  // act as a plain text translator.
  const [manualText, setManualText] = useState("");
  const [upload, setUpload] = useState<UploadInfo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [running, setRunning] = useState(false);
  // Live workflow progress: which capability, what phase, and how far (done/total).
  // total=0 ⇒ indeterminate (a single whole-clip call still in flight).
  const [progress, setProgress] = useState<{ cap: CapId; phase: string; done: number; total: number } | null>(null);
  const [exec, setExec] = useState<ExecRecord[]>([]);
  const [results, setResults] = useState<Record<string, any>>({});
  const [enhanceUrl, setEnhanceUrl] = useState<string>("");

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  }, [settings]);

  // When the STT model changes, reset the STT concurrency slider to that model's
  // recommended default (whisper tolerates much more parallelism than qwen).
  useEffect(() => {
    setSttConc(sttConcBounds(selModel.stt).def);
  }, [selModel.stt]);

  const sttConcMax = sttConcBounds(selModel.stt).max;
  const hasGateway = settings.base.trim().length > 0;

  // x2 (audiobase): a capability is served by a model with mode=audio that DECLARES
  // the capability in supports (CAP_SUPPORT[cap]). We also tolerate a model that
  // (legacy/degenerate) carries the capability key directly as its mode, so the demo
  // still lists a model if the gateway ever reports the old shape.
  const modelServesCap = (pm: ProviderModel, cap: CapId): boolean => {
    const key = CAP_SUPPORT[cap];
    // A model serves a capability if it DECLARES the key in supports — regardless of
    // mode. This covers mode=audio bases (supports=bare audio keys) AND the translate
    // model, which is mode=chat + supports={translate:true} (translate rides the gateway
    // TEMP passthrough, not the audio data plane). Legacy: mode === the cap key.
    if ((pm.supports || []).includes(key)) return true;
    return pm.mode === key;
  };
  const modelsByCap = useMemo(() => {
    const m = {} as Record<CapId, ProviderModel[]>;
    for (const cap of CAP_ORDER) m[cap] = models.filter((pm) => modelServesCap(pm, cap));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  async function refreshModels() {
    if (!hasGateway) {
      setModelStatus("⚠ 请先填写 Gateway URL，再刷新模型。");
      return;
    }
    setModelStatus("加载中…");
    try {
      const [pm, dm] = await Promise.all([fetchProviderModels(settings), fetchDefaultModels(settings)]);
      setModels(pm);
      setDefaults(dm);
      // pick default selection per capability
      // Pick a default selection per capability: prefer the per-capability default
      // (default-model keyed by the capability pseudo-mode, CAP_SUPPORT[cap]), else
      // the first model that DECLARES the capability in supports (mode=audio).
      const next: Record<CapId, string> = { ...selModel };
      for (const cap of CAP_ORDER) {
        const key = CAP_SUPPORT[cap];
        const list = pm.filter((x) => modelServesCap(x, cap));
        const def = dm[key];
        next[cap] = (def && list.find((x) => x.name === def)?.name) || list[0]?.name || "";
      }
      setSelModel(next);
      // Count models per CAPABILITY (audiobase: models are mode=audio + supports, so a
      // per-mode count is meaningless). A model that supports several capabilities is
      // counted under each. Streaming caps (stt_stream / diar_stream) are shown too.
      const capCounts = CAP_ORDER.map((cap) => {
        const n = pm.filter((x) => modelServesCap(x, cap)).length;
        return `${CAP_SUPPORT[cap]}:${n}`;
      });
      const streamCaps = ["stt_stream", "diar_stream"].map((key) => {
        const n = pm.filter((x) => (x.mode === AUDIO_MODE ? (x.supports || []).includes(key) : x.mode === key)).length;
        return `${key}:${n}`;
      });
      setModelStatus(`✅ 模型 ${pm.length} 个 — ${[...capCounts, ...streamCaps].join("  ")}`);
    } catch (e: any) {
      setModelStatus("❌ " + String(e.message || e));
    }
  }

  async function onUpload(file: File) {
    setUploading(true);
    setUpload(null);
    setUploadPct(0);
    try {
      const info = await uploadMedia(file, (pct) => setUploadPct(pct));
      setUpload(info as UploadInfo);
    } catch (e: any) {
      alert("上传失败: " + String(e.message || e));
    } finally {
      setUploading(false);
    }
  }

  function summarize(cap: CapId, res: CallResult): string {
    const j = res.json;
    switch (cap) {
      case "stt":
        return `text ${String(j?.text || "").length} 字, segments ${asSegments(j).length}`;
      case "align": {
        const u = j?.units;
        return Array.isArray(u) ? `${u.length} 个对齐单元` : "无对齐单元";
      }
      case "translate":
        return `→ ${String(j?.result ?? j?.translation ?? j?.text ?? j?.translated_text ?? "").slice(0, 60)}`;
      case "vad":
        return `${asSegments(j).length} 段语音`;
      case "diar": {
        const segs = asSegments(j);
        const spk = new Set(segs.map((s) => s.speaker).filter(Boolean));
        return `${spk.size} 说话人 / ${segs.length} 段`;
      }
      case "enhance":
        return res.blob ? `音频 ${res.blob.size} B` : "无音频输出";
      case "embed": {
        const v = j?.embedding || j?.embeddings || j?.vector || j?.data;
        const dim = Array.isArray(v) ? (Array.isArray(v[0]) ? v[0].length : v.length) : "?";
        return `向量维度 ${dim}`;
      }
    }
  }

  // Text-only translate: no audio uploaded, translate the manual text box content directly.
  // All audio-dependent capabilities are reported as skipped. Whole-text only (the gateway
  // splits long input into sentences server-side, so pasted paragraphs won't truncate).
  async function runTextTranslate(manual: string) {
    const model = selModel.translate;
    setRunning(true);
    setExec([]);
    setResults({});
    setEnhanceUrl("");
    setProgress(null);
    const records: ExecRecord[] = [];
    const out: Record<string, any> = {};
    const push = (r: ExecRecord) => {
      records.push(r);
      setExec([...records]);
    };
    const skip = (cap: CapId, reason: string) => push({ cap, invoked: false, skippedReason: reason });
    // Everything except translate needs audio.
    (["enhance", "vad", "diar", "stt", "embed"] as CapId[]).forEach((c) => skip(c, "纯文本翻译模式(未上传音频)"));
    try {
      const docLang = source === "auto" ? detectLang(manual, "eng_Latn") : source;
      const srcMode = source === "auto" ? `自动(${langLabel(docLang)})` : langLabel(source);
      if (!model) {
        skip("translate", "无可用模型");
      } else if (docLang === target) {
        skip("translate", `源(${langLabel(docLang)})与目标(${langLabel(target)})相同,跳过翻译`);
      } else {
        const to = floresToMtran(target);
        const from = source === "auto" ? "auto" : floresToMtran(source);
        const res = await callRetry(() => translate(settings, model, from, to, manual));
        const result = (res.json?.result ?? "").toString();
        out.translate = { text: result, translation: result, target, source: srcMode };
        push({
          cap: "translate",
          invoked: true,
          endpoint: "/v1/translate",
          method: "POST ×1(整段)",
          model,
          params: { 模式: "纯文本(无音频)", text: manual.slice(0, 80) + (manual.length > 80 ? "…" : ""), 源语言: srcMode, target: langLabel(target) },
          status: res.status,
          ok: res.ok,
          durationMs: res.durationMs,
          responseSummary: res.ok ? summarize("translate", res) : `失败 ${res.status}: ${errBody(res)}`,
          rawResponse: JSON.stringify(res.json ?? res.text, null, 2)?.slice(0, 4000),
        });
      }
      setResults(out);
    } catch (e: any) {
      push({ cap: "translate", invoked: true, model, error: String(e.message || e) });
      setResults(out);
    } finally {
      setRunning(false);
    }
  }

  // Run the selected capabilities as a dependency-ordered workflow (not in isolation):
  //   enhance(preprocess) -> vad/diar(segmentation) -> stt(segment-wise) -> translate(per-line) -> embed(per-speaker)
  async function run() {
    if (!hasGateway) {
      alert("未配置 Gateway URL：请先在『① Gateway 设置』里填写地址。未配置时不会发起任何模型调用。");
      return;
    }
    if (!upload) {
      const manual = manualText.trim();
      if (manual && enabled.translate) {
        await runTextTranslate(manual);
        return;
      }
      alert("请先上传音频/视频(或在『翻译』下方文本框输入文字做纯文本翻译)");
      return;
    }
    if (!settings.key) {
      if (!confirm("未填写 API Key,数据面调用可能 401。仍要继续?")) return;
    }
    setRunning(true);
    setExec([]);
    setResults({});
    setEnhanceUrl("");
    setProgress(null);
    const records: ExecRecord[] = [];
    const out: Record<string, any> = {};

    let original: Blob;
    try {
      original = await fetchUploadAudio(upload.id);
    } catch (e: any) {
      alert("读取音频失败: " + String(e.message || e));
      setRunning(false);
      return;
    }

    const push = (r: ExecRecord) => {
      records.push(r);
      setExec([...records]);
    };
    const skip = (cap: CapId, reason: string) => push({ cap, invoked: false, skippedReason: reason });

    // working audio: the blob downstream steps operate on (may be the enhanced output)
    let workingAudio: Blob = original;
    let workingLabel = "原始音频";
    let decoded: DecodedAudio | null = null;
    const getDecoded = async () => (decoded ||= await decodeAudio(workingAudio));

    // Speaker-embedding models (ECAPA) have conv kernels (size 7) that crash on ultra-short
    // clips ("Calculated padded input size (6) < kernel size (7)"). Diarization/VAD can emit
    // sub-second segments, so before embedding we expand the window symmetrically to a safe
    // minimum length (clamped to the clip). Exact boundaries don't matter for a voiceprint.
    const embedSlice = (dec: DecodedAudio, start: number, end: number, minDur = 1.2): Blob => {
      const total = dec.duration || dec.data.length / dec.sampleRate;
      let s = start,
        e = end;
      if (e - s < minDur) {
        const need = minDur - (e - s);
        s = Math.max(0, s - need / 2);
        e = Math.min(total, s + minDur);
        s = Math.max(0, e - minDur); // re-clamp left if we bumped the right edge
      }
      return sliceWav(dec, s, e);
    };

    // ── Stage 0: Enhance (pre-processing) ──────────────────────────────
    // Whole-clip enhance: the engine now chunks internally (sliding window + crossfade
    // overlap-add, see enhance.py), so peak VRAM is bounded by one window and the client
    // always sends the FULL clip in a single request regardless of duration.
    if (enabled.enhance) {
      const model = selModel.enhance;
      if (!model) skip("enhance", "无可用模型");
      else {
        try {
          setProgress({ cap: "enhance", phase: "整段降噪中", done: 0, total: 0 });
          const res = await callRetry(() => audioMultipart(settings, "enhance", original, model, {}, true));
          if (res.blob) {
            // engine returns WAV → compress to MP3 so it stays edge-safe downstream
            const enhanced = await transcodeToMp3(res.blob).catch(() => res.blob!);
            setEnhanceUrl(URL.createObjectURL(enhanced));
            if (enhancePre) {
              workingAudio = enhanced;
              workingLabel = "增强后音频";
              decoded = null; // force downstream to re-decode the enhanced track
            }
          }
          push({
            cap: "enhance",
            invoked: true,
            endpoint: "/v1/audio/enhance",
            method: "POST",
            model,
            params: { 角色: enhancePre ? "前处理 → 后续步骤使用增强后的音频" : "仅前后对比(不作为后续输入)" },
            status: res.status,
            ok: res.ok,
            durationMs: res.durationMs,
            responseSummary: res.blob
              ? `增强音频 ${res.blob.size} B${enhancePre ? ",后续步骤将使用它" : "(后续仍用原始音频)"}`
              : res.ok ? "无音频输出" : `失败 ${res.status}: ${errBody(res)}`,
            rawResponse: res.blob ? `[binary ${res.blob.size} B ${res.contentType}]` : JSON.stringify(res.json ?? res.text, null, 2)?.slice(0, 4000),
          });
        } catch (e: any) {
          push({ cap: "enhance", invoked: true, model, error: String(e.message || e) });
        }
      }
    } else skip("enhance", "未勾选");

    // ── Stage 1: Segmentation (VAD / Diarize) on the working audio ─────
    let vadSegs: Seg[] = [];
    let diarSegs: Seg[] = [];

    const vadTask = async () => {
      if (!enabled.vad) return skip("vad", "未勾选");
      const model = selModel.vad;
      if (!model) return skip("vad", "无可用模型");
      try {
        const res = await callRetry(() => audioMultipart(settings, "vad", workingAudio, model, {}), 3);
        out.vad = res.json;
        vadSegs = asSegments(res.json);
        push({
          cap: "vad",
          invoked: true,
          endpoint: "/v1/audio/vad",
          method: "POST",
          model,
          params: { 输入: workingLabel },
          status: res.status,
          ok: res.ok,
          durationMs: res.durationMs,
          responseSummary: res.ok
            ? summarize("vad", res)
            : isEdgeTimeout(res)
              ? `失败 ${res.status}: 公网边缘在 ~${Math.round(res.durationMs / 1000)}s 截断,非引擎故障。`
              : `失败 ${res.status}: ${errBody(res)}`,
          rawResponse: JSON.stringify(res.json ?? res.text, null, 2)?.slice(0, 4000),
        });
      } catch (e: any) {
        push({ cap: "vad", invoked: true, model, error: String(e.message || e) });
      }
    };

    const diarTask = async () => {
      if (!enabled.diar) return skip("diar", "未勾选");
      const model = selModel.diar;
      if (!model) return skip("diar", "无可用模型");
      try {
        // WHOLE-CLIP diarization — no client-side chunking / voiceprint-stitching. With the
        // GPU compute-throttle disabled on the engine, pyannote returns native GLOBAL
        // speakers for the full clip in a single call, which is cleaner than chunk-and-stitch
        // (that over-fragmented long audio into many tiny turns). The gateway allows up to
        // 600s for the round-trip, covering long clips.
        // Retry transient 5xx like VAD (its sibling segmentation op). A transient edge/gateway
        // 502 returns fast so the retries are cheap; callRetry still short-circuits an open
        // circuit breaker so we never hammer a genuinely-down provider.
        const res = await callRetry(() => audioMultipart(settings, "diarization", workingAudio, model, {}), 3);
        out.diar = res.json;
        diarSegs = asSegments(res.json);
        push({
          cap: "diar",
          invoked: true,
          endpoint: "/v1/audio/diarization",
          method: "POST ×1(整段)",
          model,
          params: { 输入: workingLabel, 模式: "整段(原生全局说话人)" },
          status: res.status,
          ok: res.ok,
          durationMs: res.durationMs,
          responseSummary: res.ok
            ? summarize("diar", res)
            : isEdgeTimeout(res)
              ? `失败 ${res.status}: 公网边缘在 ~${Math.round(res.durationMs / 1000)}s 截断,非引擎故障。`
              : `失败 ${res.status}: ${errBody(res)}`,
          rawResponse: JSON.stringify(res.json ?? res.text, null, 2)?.slice(0, 4000),
        });
      } catch (e: any) {
        push({ cap: "diar", invoked: true, model: selModel.diar, error: String(e.message || e) });
      }
    };

    // VAD and Diarize are independent — run concurrently.
    if (enabled.vad || enabled.diar) {
      const cap: CapId = enabled.diar ? "diar" : "vad";
      const phase = enabled.vad && enabled.diar ? "人声分段 + 说话人分离中" : enabled.diar ? "说话人分离中" : "人声分段中";
      setProgress({ cap, phase, done: 0, total: 0 });
    }
    await Promise.all([vadTask(), diarTask()]);

    // segmentation source for slicing: prefer diarization (carries speaker labels)
    const segSource: Seg[] = diarSegs.length ? diarSegs : vadSegs;
    const segHasSpeaker = diarSegs.length > 0;

    // ── Stage 2: STT ──────────────────────────────────────────────────
    let fused: Seg[] = []; // {start,end,speaker?,text}
    let alignPrimary = false; // set when Align supersedes the STT heuristic timeline
    if (enabled.stt) {
      const model = selModel.stt;
      if (!model) skip("stt", "无可用模型");
      else {
        // Two STT paths, chosen by the "分段发送转写请求" toggle:
        //   • OFF (default): WHOLE-CLIP ONE call — the model's native usage. Qwen returns
        //     plain text (no timestamps), timed in the Demo via NON-AI post-processing
        //     (align.ts); Whisper returns native verbose_json segments.
        //   • ON (requires VAD/Diarize): per-segment fan-out — slice the audio by the
        //     coalesced VAD/Diarize windows and transcribe each (N calls). Slower but higher
        //     quality (full context per turn, real per-slice text, speaker labels preserved).
        try {
          const isWhisper = (model || "").toLowerCase().includes("whisper");
          const dur = upload!.durationSec || 0;
          if (sttMode === "batch" && segSource.length) {
            // ── 分段批量 (default): 窗口 → 按字节成批 → 每批 1 次 batch STT ──
            const dec = await getDecoded();
            const windows = splitLong(coalesceSegments(segSource, 28, 1.5), 30, 0);
            const batches = packSttBatches(windows);
            const sliceSrc = segHasSpeaker ? "Diarize" : "VAD";
            const t0 = Date.now();
            let okCalls = 0, calls = 0, lastStatus = 0, errSample = "", done = 0;
            setProgress({ cap: "stt", phase: `分段批量转写(${sliceSrc})`, done: 0, total: windows.length });
            for (const batch of batches) {
              const bStart = batch[0].start, bEnd = batch[batch.length - 1].end;
              const clip = sliceWav(dec, bStart, bEnd);
              const relSegs = batch.map((w) => ({ start: +(w.start - bStart).toFixed(3), end: +(w.end - bStart).toFixed(3) }));
              calls++;
              let results: any[] = [];
              try {
                results = await audioBatch(settings, "transcriptions", clip, relSegs, model, { response_format: "json" });
                okCalls++; lastStatus = 200;
              } catch (e: any) { if (!errSample) errSample = String(e?.message || e); }
              batch.forEach((w, i) => {
                const r = results[i] || {};
                (w as any)._text = (typeof r === "string" ? r : (r.text ?? "")).toString().trim();
                done++;
              });
              setProgress({ cap: "stt", phase: `分段批量转写(${sliceSrc})`, done: Math.min(done, windows.length), total: windows.length });
            }
            fused = windows.filter((w) => (w as any)._text).map((w) => ({ start: w.start, end: w.end, speaker: w.speaker, text: (w as any)._text }));
            const tsSource = `分段批量转写 (按 ${sliceSrc} 切窗,${batches.length} 批;时间戳待 Align 接管)`;
            out.stt = { text: joinSegText(fused.map((f) => f.text || "")), segments: fused, tsSource };
            push({
              cap: "stt", invoked: true, endpoint: "/v1/audio/transcriptions",
              method: `POST ×${batches.length}批(共${windows.length}窗)`, model,
              params: { 模式: "分段批量", 切片来源: sliceSrc, 分批: `${windows.length}窗→${batches.length}批(WAV≤30MiB)`, response_format: "json", 时间戳来源: tsSource },
              status: lastStatus, ok: okCalls === calls && fused.length > 0, durationMs: Date.now() - t0,
              responseSummary: `分段批量转写 ${windows.length} 窗 / ${batches.length} 批,成功 ${okCalls}/${calls} 批;合计 ${out.stt.text.length} 字` + (okCalls < calls && errSample ? ` · 首个错误 ${errSample}` : ""),
              rawResponse: JSON.stringify(fused.slice(0, 8), null, 2),
            });
          } else if (sttMode === "segmented" && segSource.length) {
            // ── PER-SEGMENT FAN-OUT (quality path; requires VAD/Diarize) ──
            const dec = await getDecoded();
            // Coalesce raw VAD/diar bits into far fewer ~30s windows (maxGap=10 bridges
            // instrumental breaks), then split any still-oversized turn back to <=30s with
            // ~1s overlap (whisper loops on >30s inputs); dedupOverlap strips the seam later.
            const sttSlices = splitLong(coalesceSegments(segSource, 30, 10), 30, 1);
            const sliceSrc = segHasSpeaker ? "Diarize" : "VAD";
            const STT_CONCURRENCY = sttConc;
            const t0 = Date.now();
            let okCount = 0,
              lastStatus = 0,
              errSample = "",
              aborted = false,
              done = 0;
            setProgress({ cap: "stt", phase: `逐段转写中(${sliceSrc})`, done: 0, total: sttSlices.length });
            const texts = await mapLimit(sttSlices, STT_CONCURRENCY, async (sl) => {
              if (aborted) return "";
              const clip = sliceWav(dec, sl.start, sl.end);
              const res = await callRetry(() => audioMultipart(settings, "transcriptions", clip, model, { response_format: "json" }, false, true), 2);
              lastStatus = res.status;
              if (res.ok) okCount++;
              else if (!errSample) errSample = `${res.status}: ${errBody(res)}`;
              if (isCircuitOpen(res)) aborted = true;
              setProgress({ cap: "stt", phase: `逐段转写中(${sliceSrc})`, done: ++done, total: sttSlices.length });
              return (res.json?.text ?? res.text ?? "").toString().trim();
            });
            const wallMs = Date.now() - t0;
            // build segments, then strip overlapped text from split-continuation pieces
            const raw = sttSlices.map((s, i) => ({ start: s.start, end: s.end, speaker: s.speaker, cont: s.cont, text: texts[i] || "" }));
            for (let i = 1; i < raw.length; i++) {
              if (raw[i].cont && raw[i].text.trim() && raw[i - 1].text.trim()) {
                raw[i].text = dedupOverlap(raw[i - 1].text, raw[i].text);
              }
            }
            // drop slices that transcribed to nothing (silence/noise)
            fused = raw.filter((f) => f.text.trim()).map((f) => ({ start: f.start, end: f.end, speaker: f.speaker, text: f.text }));
            const tsSource = `逐段转写 (按 ${sliceSrc} 切片,引擎原生分段)`;
            out.stt = { text: joinSegText(fused.map((f) => f.text)), segments: fused, tsSource };
            push({
              cap: "stt",
              invoked: true,
              endpoint: "/v1/audio/transcriptions",
              method: `POST ×${sttSlices.length}(并发${STT_CONCURRENCY})`,
              model,
              params: {
                模式: "逐段转写(精细)",
                切片来源: sliceSrc,
                合并: `${segSource.length} 碎片→${sttSlices.length} 窗口(≤30s)`,
                并发: STT_CONCURRENCY,
                response_format: "json",
                时间戳来源: tsSource,
              },
              status: lastStatus,
              ok: okCount === sttSlices.length,
              durationMs: wallMs,
              responseSummary:
                `逐段转写 ${sttSlices.length} 段(由 ${segSource.length} 个 VAD/Diar 碎片合并),并发${STT_CONCURRENCY},成功 ${okCount}/${sttSlices.length}; 合计 ${out.stt.text.length} 字` +
                (aborted ? " · 触发熔断已中止" : "") +
                (okCount < sttSlices.length && errSample ? ` · 首个错误 ${errSample}` : ""),
              rawResponse: JSON.stringify(fused.slice(0, 8), null, 2),
            });
          } else {
          const fmt = isWhisper ? "verbose_json" : "json";
          const t0 = Date.now();
          setProgress({ cap: "stt", phase: "整段转写中(模型原生用法)", done: 0, total: 0 });
          // Send the working audio AS-IS (mp3/m4a/wav). edgeSafe() only transcodes a huge
          // RAW-WAV upload (e.g. video-extracted 1h ≈ 115 MB) down to mp3 to clear the edge.
          const res = await callRetry(
            () => audioMultipart(settings, "transcriptions", workingAudio, model, { response_format: fmt }, false, false),
            2
          );
          let nativeSegs = asSegments(res.json).filter((s) => (s.text || "").trim());
          let fullText = (res.json?.text ?? res.text ?? "").toString().trim();

          // Long-audio fallback: if the whole-clip call failed or came back empty (a very long
          // clip can exceed the engine's single-request limit), window the clip and concatenate
          // — this still mirrors how the engine chunks internally, and timestamps are derived
          // the same way afterwards. Rare; short/medium clips never hit this.
          let fellBack = false;
          if (!res.ok || (!nativeSegs.length && !fullText)) {
            const dec = await getDecoded();
            const wins = windowSegs(dur || dec.duration, 600);
            let done = 0;
            setProgress({ cap: "stt", phase: "整段未果→分窗转写中", done: 0, total: wins.length });
            const texts = await mapLimit(wins, isWhisper ? 4 : 2, async (w) => {
              const clip = sliceWav(dec, w.start, w.end);
              const r = await callRetry(
                () => audioMultipart(settings, "transcriptions", clip, model, { response_format: "json" }, false, true),
                2
              );
              setProgress({ cap: "stt", phase: "整段未果→分窗转写中", done: ++done, total: wins.length });
              return (r.json?.text ?? r.text ?? "").toString().trim();
            });
            fullText = joinSegText(texts.filter(Boolean));
            nativeSegs = [];
            fellBack = true;
          }

          // EXPLICIT segmentation the user enabled drives the fused output: Diarize
          // (carries speaker) > VAD. When present it segments the transcript for EVERY
          // engine (one segment per run) — this is what "fusion" means and why VAD/Diarize
          // visibly change the STT result. silencedetect is only a STT-only Qwen fallback.
          const modelRuns: Seg[] = diarSegs.length ? diarSegs : vadSegs;
          let tlSource = diarSegs.length ? "Diarize" : vadSegs.length ? "VAD" : "";

          // The "时间戳后处理对齐" toggle ONLY governs the timestamp-less engine (Qwen) when
          // there is NO VAD/Diarize. Whenever VAD/Diarize IS selected the transcript is
          // ALWAYS fused onto that segmentation (that's the whole point of choosing it) —
          // the toggle is irrelevant there. Whisper carries native timestamps, so the
          // toggle never affects it either.
          let tsSource: string;
          if (modelRuns.length) {
            // VAD/Diarize selected → ALWAYS fuse, regardless of the toggle. Segment by the
            // run timeline and fill each run with its share of the whole-clip text. Works
            // even for Whisper's punctuation-less zh output (sentence-splitting can't, so
            // slice by run duration). Coalesce the raw runs into fewer ~28s windows first
            // (same optimisation the per-segment path used) so the view isn't too choppy.
            const coalesced = coalesceSegments(modelRuns);
            const textForRuns = fullText || nativeSegs.map((s) => s.text).join("");
            fused = distributeTextOverRuns(textForRuns, coalesced);
            // When Align is on this is only a PRE-segmentation for the STT view + speaker/run
            // skeleton — its rough timestamps are discarded, Align supplies the final ones. So
            // don't call it "非 AI 后处理" (which implies a competing timestamp step).
            tsSource = enabled.align
              ? `预分段展示 (按 ${tlSource} 切分文本;最终时间戳由 Align 接管)`
              : `非 AI 后处理 (整段文本按 ${tlSource} 分段对齐)`;
          } else if (isWhisper && nativeSegs.length) {
            // No VAD/Diarize, Whisper: keep the engine's native verbose_json segments.
            fused = nativeSegs.map((s) => ({ start: s.start, end: s.end, text: s.text }));
            tsSource = "引擎原生 (Whisper verbose_json)";
            tlSource = "";
          } else if (!alignTs || enabled.align) {
            // No VAD/Diarize, Qwen, post-processing OFF (or Align enabled, which TAKES OVER
            // timestamping — the heuristic must not also run) → show the raw whole-clip
            // transcript as one untimed block (the model's pure output, no fabricated times).
            const whole = fullText || nativeSegs.map((s) => s.text).join("");
            fused = whole ? [{ start: 0, end: dur || 0, text: whole }] : [];
            tsSource = "关闭后处理 (整段原文,无分段时间戳)";
            tlSource = "";
          } else {
            // No VAD/Diarize, Qwen, post-processing ON → sentence-split and spread over
            // ffmpeg silencedetect speech runs (or the whole clip) as a best-effort timeline.
            let runs: Seg[] = [];
            try {
              const sil = await fetchSilences(upload!.id);
              if (sil.speech?.length) {
                runs = sil.speech.map((r) => ({ start: r.start, end: r.end }));
                tlSource = "silencedetect";
              }
            } catch {
              /* no timeline available → align over the whole clip as a single run */
            }
            fused = alignTextToTimeline(fullText, runs.length ? runs : [{ start: 0, end: dur || 0 }], dur);
            tsSource = runs.length
              ? `非 AI 后处理 (整段文本按 ${tlSource} 匀速对齐)`
              : "非 AI 后处理 (整段文本按总时长匀速断句)";
          }
          const joined = joinSegText(fused.map((f) => (f.text || "").trim()).filter(Boolean)) || fullText;
          out.stt = { text: joined, segments: fused, tsSource };

          push({
            cap: "stt",
            invoked: true,
            endpoint: "/v1/audio/transcriptions",
            method: fellBack ? "POST ×N(整段未果→分窗)" : "POST ×1(整段)",
            model,
            params: {
              模式: fellBack ? "分窗兜底(整段一次未果)" : "整段一次(模型原生用法)",
              输入: workingLabel,
              response_format: fmt,
              时间戳来源: tsSource,
              时间轴: tlSource || "(无,按总时长匀速)",
            },
            status: res.status,
            ok: (res.ok || fellBack) && fused.length > 0,
            durationMs: Date.now() - t0,
            responseSummary:
              res.ok || fellBack
                ? `${fellBack ? "整段一次未果,已分窗兜底" : "整段 1 次调用"}; 合计 ${joined.length} 字、${fused.length} 段 · 时间戳:${tsSource}`
                : isEdgeTimeout(res)
                  ? `失败 ${res.status}: 公网边缘截断,非引擎故障。`
                  : `失败 ${res.status}: ${errBody(res)}`,
            rawResponse: JSON.stringify(fused.slice(0, 10), null, 2),
          });
          }
        } catch (e: any) {
          push({ cap: "stt", invoked: true, model, error: String(e.message || e) });
        }
      }
    } else skip("stt", "未勾选");

    // ── Stage 2.5: Align (forced alignment → precise char/word timestamps) ──
    // We RESPECT the model's native 300s/inference cap (no engine change) and handle
    // length entirely on the client. Two modes via the "分段对齐" toggle, both feeding a
    // {clip,text,offset}[] window list into runAlignWindows (mode only changes how the
    // list is built):
    //   • OFF (whole-clip): one window if ≤5min; if longer, AUTO-SPLIT the audio into
    //     ≤290s windows and the text proportionally (sentence-aware) — one call per
    //     window. Critically each call gets only the text for its own audio, so the
    //     model is never overfed (that overfeeding is what piled everything at the end).
    //   • ON (per VAD/Diar segment): align each STT segment's audio against its own
    //     text (each <300s naturally). The accurate long-audio path.
    // On success Align becomes the PRIMARY timeline (supersedes the STT heuristic);
    // the heuristic stays as fallback when Align is off or yields nothing.
    const ALIGN_WIN_S = 290;     // stay safely under the model's 300s cap
    // Serial (1): the engine serialises aligns under a lock anyway, so parallelism just
    // adds browser-connection contention (a queued align socket got reset under full load).
    const ALIGN_CONCURRENCY = 1;
    // Attribute units to speakers (diar overlap), publish out.align, and — if any units
    // came back — rebuild `fused` from the real timestamps. Shared by both modes.
    const finishAlign = (
      units: Seg[],
      refText: string,
      meta: { mode: string; textSrc: string; lang?: string; calls: number; ok: number; lastStatus: number; errSample: string; durationMs: number }
    ) => {
      // Speaker per unit: per-segment mode already carries a STABLE window speaker
      // (don't re-derive — re-deriving per unit makes short function words like "a"/"the"
      // land in diar micro-gaps → "" → absurd single-word lines). Only derive by overlap
      // for units that have no speaker yet (whole-clip mode), then median-smooth single-
      // unit islands so one stray unit can't split a line.
      let withSpk = units.map((u) => ({ ...u }));
      if (diarSegs.length) {
        for (let i = 0; i < withSpk.length; i++) {
          if (withSpk[i].speaker !== undefined) continue;
          let best = "",
            bestOv = 0;
          for (const d of diarSegs) {
            const ov = Math.max(0, Math.min(withSpk[i].end, d.end) - Math.max(withSpk[i].start, d.start));
            if (ov > bestOv) {
              bestOv = ov;
              best = d.speaker || "";
            }
          }
          withSpk[i].speaker = best;
        }
        for (let i = 1; i < withSpk.length - 1; i++) {
          const a = withSpk[i - 1].speaker || "",
            b = withSpk[i].speaker || "",
            c = withSpk[i + 1].speaker || "";
          if (b !== a && b !== c && a === c) withSpk[i].speaker = a;
        }
      }
      out.align = { units: withSpk, text: refText, textSource: meta.textSrc, language: meta.lang || "(自动)", mode: meta.mode, withSpeaker: diarSegs.length > 0, calls: meta.calls };
      // Line text comes from the ORIGINAL text (spaces/punctuation preserved); Align
      // supplies only timing. One grouping rule for both modes (speaker change / sentence
      // / pause / duration / length) — merges same-speaker turns yet still breaks a long
      // monologue into readable lines.
      // When the user enabled VAD/Diarize, the STT step already produced good segments
      // (text + speaker). Use THAT as the fused skeleton and let Align only tighten the
      // boundaries — this respects the segmentation the user liked instead of re-grouping
      // (which over-merged spaceless CJK into one block). Without VAD/Diarize there is no
      // trustworthy skeleton (whole-clip = 1 block), so fall back to sentence-level grouping.
      const hasSkeleton = (diarSegs.length > 0 || vadSegs.length > 0) && fused.length > 0;
      const hasPunct = /[。！？.!?]/.test(refText);
      // With a diar/vad skeleton: if the text has punctuation, keep the speaker timeline but
      // snap every boundary to a punctuation mark (no mid-word/mid-sentence cuts); if it has
      // none, the timeline IS the segmentation (just tighten times). Without a skeleton, group
      // purely by punctuation.
      const alignFused = hasSkeleton
        ? hasPunct
          ? snapRunsToPunct(fused, withSpk, refText)
          : refineSegmentsWithAlign(fused, withSpk)
        : groupAlignUnitsRef(withSpk, refText);
      if (alignFused.length) {
        fused = alignFused; // Align-primary: real timestamps supersede the heuristic
        alignPrimary = true;
        // Align and the STT heuristic timestamping are mutually exclusive — only one is ever
        // in effect. So when Align owns the final timeline, REPLACE the STT row's timestamp
        // source (don't append) so it never advertises "非 AI 后处理" next to Align.
        const sttRec = records.find((r) => r.cap === "stt" && r.invoked);
        if (sttRec && !/Align/.test(sttRec.responseSummary || "")) {
          const note = "由 Align 强制对齐接管(精确时间)";
          if (sttRec.responseSummary) {
            sttRec.responseSummary = /· 时间戳:/.test(sttRec.responseSummary)
              ? sttRec.responseSummary.replace(/· 时间戳:.*$/, `· 时间戳:${note}`)
              : sttRec.responseSummary + ` · 时间戳:${note}`;
          }
          if (sttRec.params && typeof sttRec.params === "object" && "时间戳来源" in (sttRec.params as object)) {
            (sttRec.params as Record<string, unknown>)["时间戳来源"] = `${note} — STT 自身分段时间戳已被取代`;
          }
          setExec([...records]);
        }
      }
      push({
        cap: "align",
        invoked: true,
        endpoint: "/v1/audio/align",
        method: `POST ×${meta.calls}${meta.calls > 1 ? `(并发${ALIGN_CONCURRENCY})` : ""}`,
        model: selModel.align,
        params: {
          模式: meta.mode,
          文本来源: meta.textSrc,
          语言: meta.lang || "(自动检测)",
          调用数: meta.calls,
          说话人归属: diarSegs.length ? "按 Diarize overlap" : "(无 Diarize)",
        },
        status: meta.lastStatus,
        ok: meta.ok === meta.calls && withSpk.length > 0,
        durationMs: meta.durationMs,
        responseSummary:
          `${meta.mode} · 对齐 ${withSpk.length} 个单元(来源:${meta.textSrc}),调用 ${meta.ok}/${meta.calls} 成功` +
          (diarSegs.length ? " · 已按说话人归属" : "") +
          (alignFused.length ? ` · 已作为融合时间轴(${alignFused.length} 段${hasSkeleton ? (hasPunct ? ",Diar 时间轴+边界对齐标点" : ",按 Diar 分段精修边界") : ""})` : "") +
          (meta.ok < meta.calls && meta.errSample ? ` · 首个错误 ${meta.errSample}` : ""),
        rawResponse: JSON.stringify(withSpk.slice(0, 60), null, 2),
      });
    };

    if (enabled.align) {
      const model = selModel.align;
      const sttText = (out.stt?.text || "").trim();
      const manual = manualText.trim();
      const dur = upload!.durationSec || 0;
      const lang = alignLangName(source === "auto" ? detectLang(sttText || manual) : source);
      // per-segment mode needs VAD/Diar segmentation AND per-segment STT text (fused)
      const perSeg = alignPerSeg && (enabled.vad || enabled.diar) && fused.length > 0;
      const batchAlign = sttMode === "batch" && (enabled.vad || enabled.diar) && fused.length > 0;
      if (!model) skip("align", "无可用模型");
      else if (batchAlign) {
        // ── 分段批量对齐: 窗口按字节成批,每批 1 次 batch align,units 片内相对时间回加
        // 窗起点到绝对轴,再复用 finishAlign 归属说话人 + 重建融合时间轴 ──
        try {
          const dec = await getDecoded();
          const segs = fused.filter((f) => (f.text || "").trim());
          const batches = packSttBatches(segs);
          const t0 = Date.now();
          const allUnits: Seg[] = [];
          let calls = 0, ok = 0, lastStatus = 0, errSample = "", done = 0;
          setProgress({ cap: "align", phase: "分段批量对齐", done: 0, total: segs.length });
          for (const batch of batches) {
            const bStart = batch[0].start, bEnd = batch[batch.length - 1].end;
            const clip = sliceWav(dec, bStart, bEnd);
            const alignSegs = batch.map((w) => ({ start: +(w.start - bStart).toFixed(3), end: +(w.end - bStart).toFixed(3), text: w.text || "", language: lang }));
            calls++;
            let results: any[] = [];
            try { results = await audioBatch(settings, "align", clip, alignSegs, model); ok++; lastStatus = 200; }
            catch (e: any) { if (!errSample) errSample = String(e?.message || e); }
            batch.forEach((w, i) => {
              const r = results[i] || {};
              const raw = Array.isArray(r.units) ? r.units : [];
              for (const u of raw) {
                allUnits.push({
                  start: Number(u.start ?? u.start_time ?? 0) + w.start,
                  end: Number(u.end ?? u.end_time ?? 0) + w.start,
                  text: u.text ?? u.word ?? u.token ?? "",
                  ...(w.speaker !== undefined ? { speaker: w.speaker } : {}),
                });
              }
              done++;
            });
            setProgress({ cap: "align", phase: "分段批量对齐", done: Math.min(done, segs.length), total: segs.length });
          }
          finishAlign(allUnits, joinSegText(segs.map((s) => s.text || "")), { mode: `分段批量对齐(${batches.length}批)`, textSrc: "STT 分段文本", lang, calls, ok, lastStatus, errSample, durationMs: Date.now() - t0 });
        } catch (e: any) {
          push({ cap: "align", invoked: true, model, error: String(e.message || e) });
        }
      }
      else if (perSeg) {
        // ── 分段对齐: one window per STT segment (each already <300s) ──
        try {
          const dec = await getDecoded();
          const segs = fused.filter((f) => (f.text || "").trim());
          const wins: AlignWin[] = segs.map((s) => ({ clip: sliceWav(dec, s.start, s.end), text: s.text || "", offset: s.start, speaker: s.speaker }));
          const src = enabled.diar ? "Diarize" : "VAD";
          let done = 0;
          const t0 = Date.now();
          setProgress({ cap: "align", phase: `分段对齐中(${src})`, done: 0, total: wins.length });
          const r = await runAlignWindows(settings, model, wins, lang, ALIGN_CONCURRENCY, () =>
            setProgress({ cap: "align", phase: `分段对齐中(${src})`, done: ++done, total: wins.length })
          );
          finishAlign(r.units, joinSegText(segs.map((s) => s.text || "")), { mode: `分段对齐(逐段·${src})`, textSrc: "STT 分段文本", lang, calls: r.total, ok: r.ok, lastStatus: r.lastStatus, errSample: r.errSample, durationMs: Date.now() - t0 });
        } catch (e: any) {
          push({ cap: "align", invoked: true, model, error: String(e.message || e) });
        }
      } else {
        // ── whole-clip: 1 window if ≤5min, else auto-split audio + text ──
        const alignText = sttText || manual;
        const textSrc = sttText ? "STT 转写" : manual ? "文本框参考文稿" : "";
        if (!alignText) skip("align", "需要文本:勾选 STT,或在文本框输入参考文稿");
        else {
          try {
            const dec = await getDecoded();
            const total = dur || dec.duration || 0;
            const wins: AlignWin[] = [];
            if (total <= ALIGN_WIN_S + 5) {
              wins.push({ clip: sliceWav(dec, 0, total || ALIGN_WIN_S), text: alignText, offset: 0 });
            } else {
              const nWin = Math.ceil(total / ALIGN_WIN_S);
              const winLen = total / nWin;
              const parts = splitTextN(alignText, nWin);
              for (let i = 0; i < nWin; i++) {
                const a = i * winLen,
                  b = Math.min(total, (i + 1) * winLen);
                wins.push({ clip: sliceWav(dec, a, b), text: parts[i] || "", offset: a });
              }
            }
            const phase = wins.length > 1 ? `整段自动分段对齐中(${wins.length}×≤${ALIGN_WIN_S}s)` : "强制对齐中(整段)";
            let done = 0;
            const t0 = Date.now();
            setProgress({ cap: "align", phase, done: 0, total: wins.length });
            const r = await runAlignWindows(settings, model, wins, lang, ALIGN_CONCURRENCY, () =>
              setProgress({ cap: "align", phase, done: ++done, total: wins.length })
            );
            finishAlign(r.units, alignText, {
              mode: wins.length > 1 ? `整段自动分段(${wins.length}×≤${ALIGN_WIN_S}s)` : "整段一次",
              textSrc,
              lang,
              calls: r.total,
              ok: r.ok,
              lastStatus: r.lastStatus,
              errSample: r.errSample,
              durationMs: Date.now() - t0,
            });
          } catch (e: any) {
            push({ cap: "align", invoked: true, model, error: String(e.message || e) });
          }
        }
      }
    } else skip("align", "未勾选");

    // ── Stage 3: Translate (per-line over the fused transcript) ────────
    if (enabled.translate) {
      const model = selModel.translate;
      // Fine mode: translate each segment so the fused view shows per-segment
      // translation (the nice part). Each call is fail-fast (tries=1) so it degrades
      // gracefully instead of stacking gateway timeouts. Whole-text otherwise.
      const lines = translatePerSeg ? fused.filter((f) => (f.text || "").trim()) : [];
      const wholeText = out.stt?.text || (fused.length ? joinSegText(fused.map((f) => f.text || "")).trim() : "");
      // Source language: explicit pick, or auto-detect. The document-level guess
      // (over the whole transcript) is the stable fallback for short per-line text.
      const docLang = source === "auto" ? detectLang(wholeText, "eng_Latn") : source;
      const srcMode = source === "auto" ? `自动(${langLabel(docLang)})` : langLabel(source);
      if (!model) skip("translate", "无可用模型");
      else if (!lines.length && !wholeText) skip("translate", "需要转写文本(请同时启用 STT)");
      else if (docLang === target && source !== "auto")
        skip("translate", `源(${langLabel(docLang)})与目标(${langLabel(target)})相同,跳过翻译`);
      else {
        // Hy-MT2 (MTran) via the gateway TEMP passthrough. from="auto" lets the model
        // auto-detect; codes are MTran (mapped from our FLORES picks). Whole-text ->
        // /translate (one call); per-segment -> /translate/batch (ONE call for ALL
        // lines, sequential inside the engine) — no more per-line fan-out.
        const to = floresToMtran(target);
        const from = source === "auto" ? "auto" : floresToMtran(source);
        const t0 = Date.now();
        try {
          if (lines.length) {
            const texts = lines.map((l) => l.text || "");
            setProgress({ cap: "translate", phase: `整批翻译 ${texts.length} 段`, done: 0, total: 1 });
            const res = await callRetry(() => translateBatch(settings, model, from, to, texts), 3);
            const results: string[] = Array.isArray(res.json?.results)
              ? res.json.results.map((x: any) => (x ?? "").toString())
              : [];
            lines.forEach((ln, i) => {
              (ln as any).translation = results[i] ?? "";
              (ln as any).srcLang = docLang;
            });
            setProgress({ cap: "translate", phase: `整批翻译 ${texts.length} 段`, done: 1, total: 1 });
            out.translate = { segments: lines, text: lines.map((l) => (l as any).translation || "").join(" "), target, source: srcMode };
            push({
              cap: "translate",
              invoked: true,
              endpoint: "/v1/translate/batch",
              method: `POST ×1(整批 ${texts.length} 段)`,
              model,
              params: { 模式: "分段(整批一次)", 源语言: srcMode, target: langLabel(target) },
              status: res.status,
              ok: res.ok && results.length === texts.length,
              durationMs: Date.now() - t0,
              responseSummary: res.ok
                ? `整批翻译 ${texts.length} 段,返回 ${results.length} 段`
                : `失败 ${res.status}: ${errBody(res)}`,
              rawResponse: JSON.stringify(lines.slice(0, 8).map((l) => ({ text: l.text, translation: (l as any).translation })), null, 2),
            });
          } else {
            const res = await callRetry(() => translate(settings, model, from, to, wholeText), 3);
            const result = (res.json?.result ?? "").toString();
            out.translate = { text: result, translation: result, target, source: srcMode };
            push({
              cap: "translate",
              invoked: true,
              endpoint: "/v1/translate",
              method: "POST ×1(整段)",
              model,
              params: { text: wholeText.slice(0, 80) + (wholeText.length > 80 ? "…" : ""), 源语言: srcMode, target: langLabel(target) },
              status: res.status,
              ok: res.ok,
              durationMs: res.durationMs,
              responseSummary: res.ok ? `整段翻译 ${result.length} 字` : `失败 ${res.status}: ${errBody(res)}`,
              rawResponse: JSON.stringify(res.json ?? res.text, null, 2)?.slice(0, 4000),
            });
          }
        } catch (e: any) {
          push({ cap: "translate", invoked: true, model, error: String(e.message || e) });
        }
      }
    } else skip("translate", "未勾选");

    // ── Stage 4: Embed (per-speaker voiceprint -> similarity matrix) ───
    if (enabled.embed) {
      const model = selModel.embed;
      if (!model) skip("embed", "无可用模型");
      else if (segHasSpeaker) {
        // representative slice per speaker (the longest segment), then embed each
        try {
          const speakers = Array.from(new Set(diarSegs.map((s) => s.speaker || "?")));
          const reps = speakers.map((spk) => {
            const segs = diarSegs.filter((s) => (s.speaker || "?") === spk);
            return segs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a), segs[0]);
          });
          const dec = await getDecoded();
          let lastStatus = 0,
            lastDur = 0,
            okCount = 0,
            errSample = "",
            aborted = false;
          const vecs: number[][] = [];
          setProgress({ cap: "embed", phase: "逐说话人声纹", done: 0, total: reps.length });
          for (let i = 0; i < reps.length; i++) {
            const clip = embedSlice(dec, reps[i].start, reps[i].end);
            const res = await callRetry(() => audioMultipart(settings, "embeddings", clip, model, {}), 2);
            lastStatus = res.status;
            lastDur = res.durationMs;
            if (res.ok) okCount++;
            else if (!errSample) errSample = `${res.status}: ${errBody(res)}`;
            setProgress({ cap: "embed", phase: "逐说话人声纹", done: i + 1, total: reps.length });
            const raw = res.json?.embedding || res.json?.embeddings || res.json?.vector || res.json?.data;
            vecs.push((Array.isArray(raw) ? (Array.isArray(raw[0]) ? raw[0] : raw) : []) as number[]);
            if (isCircuitOpen(res)) {
              aborted = true;
              break;
            }
          }
          out.embed = { perSpeaker: true, speakers: speakers.slice(0, vecs.length), embeddings: vecs };
          push({
            cap: "embed",
            invoked: true,
            endpoint: "/v1/audio/embeddings",
            method: `POST ×${reps.length}(串行)`,
            model,
            params: { 模式: "按说话人代表片段", 说话人数: speakers.length },
            status: lastStatus,
            ok: okCount === reps.length,
            durationMs: lastDur,
            responseSummary:
              `${speakers.length} 位说话人声纹,维度 ${vecs[0]?.length || "?"},成功 ${okCount}/${reps.length}` +
              (aborted ? " · 触发熔断已中止" : "") +
              (okCount < reps.length && errSample ? ` · 首个错误 ${errSample}` : ""),
            rawResponse: JSON.stringify({ speakers, dim: vecs[0]?.length || 0 }, null, 2),
          });
        } catch (e: any) {
          push({ cap: "embed", invoked: true, model, error: String(e.message || e) });
        }
      } else {
        // no diarization: whole-clip embedding
        try {
          setProgress({ cap: "embed", phase: "整段声纹中", done: 0, total: 0 });
          const res = await callRetry(() => audioMultipart(settings, "embeddings", workingAudio, model, {}));
          out.embed = res.json;
          push({
            cap: "embed",
            invoked: true,
            endpoint: "/v1/audio/embeddings",
            method: "POST",
            model,
            params: { 模式: "整段(未启用 Diarize)" },
            status: res.status,
            ok: res.ok,
            durationMs: res.durationMs,
            responseSummary: res.ok ? summarize("embed", res) : `失败 ${res.status}: ${errBody(res)}`,
            rawResponse: JSON.stringify(res.json ?? res.text, null, 2)?.slice(0, 4000),
          });
        } catch (e: any) {
          push({ cap: "embed", invoked: true, model, error: String(e.message || e) });
        }
      }
    } else skip("embed", "未勾选");

    out._fused = fused;
    setResults(out);
    setProgress(null);
    setRunning(false);
  }

  // Unified workflow transcript: fused stt segments (already speaker-attributed when
  // segment-wise) else align whole-clip stt segments with diarization by overlap.
  const merged = useMemo(() => {
    const fused: Seg[] = results._fused || [];
    if (fused.length && fused.some((s) => s.speaker)) return fused;
    const stt = fused.length ? fused : asSegments(results.stt);
    const diar = asSegments(results.diar);
    if (!stt.length) return [];
    if (!diar.length) return stt;
    return stt.map((s) => {
      let best = "",
        bestOv = 0;
      for (const d of diar) {
        const ov = Math.max(0, Math.min(s.end, d.end) - Math.max(s.start, d.start));
        if (ov > bestOv) {
          bestOv = ov;
          best = d.speaker || "";
        }
      }
      return { ...s, speaker: best };
    });
  }, [results]);

  function exportFile(kind: "txt" | "json" | "srt") {
    const timeline: Seg[] = merged.length ? merged : asSegments(results.stt);
    let content = "",
      mime = "text/plain";
    const ext = kind;
    if (kind === "json") {
      content = JSON.stringify({ upload, settings: { base: settings.base }, exec, results }, null, 2);
      mime = "application/json";
    } else if (kind === "srt") {
      content = timeline
        .map((s, i) => {
          const spk = s.speaker ? `[${s.speaker}] ` : "";
          const tr = (s as any).translation ? `\n${(s as any).translation}` : "";
          return `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${spk}${s.text || ""}${tr}\n`;
        })
        .join("\n");
    } else {
      const lines: string[] = [];
      if (timeline.length) {
        lines.push("# 工作流融合转写(说话人 + 时间轴 + 翻译)");
        for (const s of timeline) {
          const spk = s.speaker ? `[${s.speaker}] ` : "";
          lines.push(`${spk}${fmtTime(s.start)}  ${s.text || ""}`);
          if ((s as any).translation) lines.push(`        ↳ ${(s as any).translation}`);
        }
      } else if (results.stt?.text) {
        lines.push("# 转写\n" + results.stt.text);
        const tr = results.translate?.translation ?? results.translate?.text ?? results.translate?.translated_text;
        if (tr) lines.push("\n# 翻译\n" + tr);
      }
      content = lines.join("\n");
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = `audiostudio-export.${ext}`;
    a.click();
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4">
        <h1 className="text-xl font-semibold">Audio Studio X2 Demo</h1>
        <p className="text-sm text-neutral-400">经 LLM Gateway 调用音频能力 · 文件分析(离线)与实时字幕(流式)</p>
        <nav className="mt-3 flex gap-2">
          <button
            className={`rounded-md px-3 py-1.5 text-sm ${view === "file" ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"}`}
            onClick={() => setView("file")}
          >文件分析</button>
          <button
            className={`rounded-md px-3 py-1.5 text-sm ${view === "stream" ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"}`}
            onClick={() => setView("stream")}
          >实时字幕</button>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-6">
        {/* settings */}
        <Card title="① Gateway 设置">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Gateway URL(留空用服务端默认)">
              <input
                className="input"
                placeholder="https://<gateway>.olares.com"
                value={settings.base}
                onChange={(e) => setSettings({ ...settings, base: e.target.value })}
              />
            </Field>
            <Field label="API Key(数据面 Bearer)">
              <input
                className="input"
                type="password"
                placeholder="sk-..."
                value={settings.key}
                onChange={(e) => setSettings({ ...settings, key: e.target.value })}
              />
            </Field>
            <Field label="X-BFL-User(可选,集群内绕边缘时用)">
              <input
                className="input"
                placeholder="olarestest003"
                value={settings.bflUser}
                onChange={(e) => setSettings({ ...settings, bflUser: e.target.value })}
              />
            </Field>
            <Field label="Cookie(本地调试用:粘贴 Olares 登录 Cookie,部署后留空)">
              <input
                className="input"
                type="password"
                placeholder="auth_token=...; ..."
                value={settings.cookie}
                onChange={(e) => setSettings({ ...settings, cookie: e.target.value })}
              />
            </Field>
            <div className="flex items-end">
              <button className="btn" onClick={refreshModels}>
                测试连接 / 刷新模型
              </button>
            </div>
          </div>
          {modelStatus && <p className="mt-2 text-sm text-neutral-300">{modelStatus}</p>}
        </Card>

        {view === "stream" && (
          <StreamView settings={settings} models={models} defaults={defaults} />
        )}

        {view === "file" && (<>
        {/* upload */}
        <Card title="② 上传音频 / 视频">
          <input
            type="file"
            accept="audio/*,video/*"
            className="text-sm"
            onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
          />
          {uploading && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-sm text-amber-400">
                <span>{uploadPct >= 100 ? "上传完成,服务器处理中(提取/转码)…" : "上传中…"}</span>
                <span className="tabular-nums">{uploadPct.toFixed(2)}%</span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded bg-neutral-800">
                <div
                  className={`h-full ${uploadPct >= 100 ? "animate-pulse bg-amber-500" : "bg-amber-400"}`}
                  style={{ width: `${Math.min(100, uploadPct)}%` }}
                />
              </div>
            </div>
          )}
          {upload && (
            <div className="mt-3 text-sm text-neutral-300">
              <div>
                已就绪:<span className="text-neutral-100">{upload.originalName}</span>(
                {upload.kind === "video" ? "视频→已提取16k单声道wav" : "音频"}
                {upload.durationSec ? ` · ${upload.durationSec.toFixed(1)}s` : ""})
              </div>
              {upload.kind === "video" && (
                <video className="mt-2 max-h-72 w-full rounded bg-black" controls src={`/api/upload/${upload.id}/media`} />
              )}
              <div className="mt-2 text-xs text-neutral-500">{upload.kind === "video" ? "提取的音频(送入各能力):" : "音频:"}</div>
              <audio className="mt-1 w-full" controls src={`/api/upload/${upload.id}/audio`} />
            </div>
          )}
        </Card>

        {/* shared text box: translation source (no audio) / Align reference (with audio) */}
        <Card title="③ 文本输入 — 翻译源(无音频) / Align 参考文稿(有音频)">
          {(() => {
            // Two roles depending on whether audio is present:
            //   • no audio + Translate → plain-text translation source
            //   • audio + Align        → reference transcript for forced alignment
            //     (used as a FALLBACK when STT is off / yields nothing)
            const boxActive = (!upload && enabled.translate) || (!!upload && enabled.align);
            const has = manualText.trim().length > 0;
            return (
              <div className="flex flex-col gap-1">
                <textarea
                  className="input min-h-[120px] w-full"
                  rows={5}
                  disabled={!boxActive}
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                  placeholder="未上传音频 → 纯文本翻译(在此输入/粘贴文字);已上传音频 + 启用 Align → 可填参考文稿(留空则用 STT 转写文本对齐)"
                />
                <span className={`text-xs ${boxActive && has ? "text-emerald-400" : boxActive ? "text-neutral-500" : "text-neutral-600"}`}>
                  {upload
                    ? enabled.align
                      ? enabled.stt
                        ? "Align 将优先使用 STT 转写文本对齐;此框作为 STT 无输出时的后备参考文稿"
                        : has
                          ? "Align 将使用此文本框内容做强制对齐(未勾选 STT)"
                          : "请输入参考文稿:未勾选 STT 时 Align 需要此框提供文本"
                      : "已上传音频:勾选 Align 后,此框可作对齐参考文稿(翻译则以音频转写为源)"
                    : has
                      ? "将翻译此文本框内容(纯文本模式,无需音频)"
                      : "未上传音频:可在此输入文字做纯文本翻译"}
                </span>
              </div>
            );
          })()}
        </Card>

        {/* capabilities */}
        <Card title="④ 能力开关(仅勾选项会被调用)">
          <div className="space-y-2">
            {CAP_ORDER.map((cap) => {
              const list = modelsByCap[cap] || [];
              return (
                <div key={cap} className="flex flex-wrap items-center gap-3 rounded border border-neutral-800 px-3 py-2">
                  <label className="flex w-40 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={enabled[cap]}
                      onChange={(e) => setEnabled({ ...enabled, [cap]: e.target.checked })}
                    />
                    <span className="font-medium">{CAP_LABEL[cap]}</span>
                  </label>
                  <select
                    className="input min-w-[20rem] max-w-md flex-1"
                    disabled={!enabled[cap]}
                    value={selModel[cap] || ""}
                    onChange={(e) => setSelModel({ ...selModel, [cap]: e.target.value })}
                  >
                    {list.length === 0 && <option value="">(无 {CAP_SUPPORT[cap]} 模型 — 先刷新)</option>}
                    {list.map((m) => (
                      <option key={m.id} value={m.name}>
                        {m.name} {m.provider_name ? `· ${m.provider_name}` : ""}
                      </option>
                    ))}
                  </select>
                  {cap === "translate" &&
                    (() => {
                      const sttIsWhisper = (selModel.stt || "").toLowerCase().includes("whisper");
                      const fuseOn = enabled.vad || enabled.diar;
                      // Per-line translation only yields per-segment output when STT actually
                      // produces segments: VAD/Diarize on, OR Whisper (native timestamps), OR
                      // Qwen with the non-AI post-processing toggle on. Otherwise the transcript
                      // is one whole block and "分段翻译" degrades to a single whole-text call.
                      const segsAvailable = enabled.stt && (fuseOn || sttIsWhisper || alignTs);
                      const perSegWarn = translatePerSeg && !segsAvailable;
                      return (
                        <div className="flex w-full basis-full flex-wrap items-center gap-2 border-t border-neutral-800/60 pt-2" title="源语言:自动检测或手动指定;若源(含自动检测结果)与目标相同则跳过翻译">
                      <select className="input !w-36" disabled={!enabled.translate} value={source} onChange={(e) => setSource(e.target.value)}>
                        {SOURCE_LANGS.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                      <span className="text-xs text-neutral-500">→</span>
                      <select className="input !w-36" disabled={!enabled.translate} value={target} onChange={(e) => setTarget(e.target.value)}>
                        {TARGET_LANGS.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                      <label
                        className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${enabled.translate ? "text-neutral-300" : "text-neutral-600"}`}
                        title="开:按转写的每一段(行)分别翻译,融合视图逐段显示译文;关:整段文本一次翻译。注意:分段翻译需要转写有分段时间戳(VAD/DIAR、或 Whisper 原生、或 Qwen 开启非AI后处理),否则等同整段翻译。"
                      >
                        <input
                          type="checkbox"
                          disabled={!enabled.translate}
                          checked={translatePerSeg}
                          onChange={(e) => setTranslatePerSeg(e.target.checked)}
                        />
                        分段翻译
                      </label>
                      <label
                        className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${enabled.translate && translatePerSeg ? "text-neutral-400" : "text-neutral-600"}`}
                        title="逐行翻译的并发路数(NLLB 较轻,可适当高)。"
                      >
                        并发
                        <input
                          type="range"
                          min={1}
                          max={TRANSLATE_CONC_MAX}
                          step={1}
                          disabled={!enabled.translate || !translatePerSeg}
                          value={translateConc}
                          onChange={(e) => setTranslateConc(Number(e.target.value))}
                          className="w-24"
                        />
                        <span className="w-10 tabular-nums text-neutral-300">
                          {translateConc}/{TRANSLATE_CONC_MAX}
                        </span>
                      </label>
                      {enabled.translate && (perSegWarn || translatePerSeg) && (
                        <span
                          className={`ml-auto shrink-0 text-xs ${perSegWarn ? "text-amber-400" : "text-neutral-500"}`}
                          title="分段翻译需要转写存在分段时间戳:勾选 VAD/DIAR、或用 Whisper(原生时间戳)、或 Qwen 开启“时间戳后处理对齐”;否则只能整段翻译。"
                        >
                          {perSegWarn ? "⚠ 需分段时间戳,否则=整段翻译" : "按 STT 分段逐行"}
                        </span>
                      )}
                        </div>
                      );
                    })()}
                  {cap === "stt" &&
                    (() => {
                      const sttIsWhisper = (selModel.stt || "").toLowerCase().includes("whisper");
                      const fuseOn = enabled.vad || enabled.diar; // VAD/Diarize selected
                      // Per-segment fan-out needs a segmentation source (VAD/Diarize).
                      const perSegActive = enabled.stt && fuseOn;
                      const perSegOn = perSegActive && sttMode === "segmented";
                      // The align toggle is only meaningful for a timestamp-less engine (Qwen)
                      // when there is NO VAD/Diarize (and not in per-segment mode).
                      // When Align is enabled it produces the final (precise) timeline and
                      // supersedes STT's own timestamp post-processing — so the toggle is
                      // moot for the result; grey it out to avoid a "switch does nothing"
                      // confusion (it still only governs STT's standalone view otherwise).
                      const alignTakenOver = enabled.align;
                      const alignActive = enabled.stt && !fuseOn && !sttIsWhisper && !alignTakenOver;
                      const status = !enabled.stt
                        ? ""
                        : (sttMode === "batch" && fuseOn)
                          ? `分段批量 · 按 ${enabled.diar ? "Diarize" : "VAD"} 切窗成批转写${enabled.align ? " + 分段批量对齐(精确时间)" : ""}`
                        : alignTakenOver
                          ? "整段一次 · 时间戳由 Align 接管(强制对齐提供精确时间)"
                          : perSegOn
                            ? `逐段发送 · 按 ${enabled.diar ? "Diarize" : "VAD"} 切片转写(并发${sttConc})`
                            : fuseOn
                              ? `整段一次 · 按 ${enabled.diar ? "Diarize" : "VAD"} 分段协同(必融合)`
                              : sttIsWhisper
                                ? "整段一次 · Whisper 引擎原生分段"
                                : alignTs
                                  ? "整段一次 · 按静音检测/匀速对齐(造时间戳)"
                                  : "整段一次 · 整段原文(不造时间戳)";
                      return (
                        <div className="flex w-full basis-full flex-wrap items-center gap-3 border-t border-neutral-800/60 pt-2">
                          {/* Interactive controls are anchored left with constant-width labels
                              so they DON'T shift when switching models; the variable status
                              text floats to the right (ml-auto) and never moves the controls. */}
                          <div
                            className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs"
                            title="分段批量/分段 需先勾选 VAD 或 Diarize(靠它分段);整段无需。分段批量=窗口成批,一次请求多窗(少往返、抗长音频)。"
                          >
                            <span className="text-neutral-400">转写模式</span>
                            {([
                              ["batch", "分段批量", perSegActive],
                              ["segmented", "分段", perSegActive],
                              ["integral", "整段", true],
                            ] as const).map(([v, label, en]) => (
                              <label key={v} className={`flex items-center gap-1 ${en ? "text-neutral-300" : "text-neutral-600"}`}>
                                <input type="radio" name="sttMode" disabled={!en} checked={sttMode === v} onChange={() => setSttMode(v)} />
                                {label}
                              </label>
                            ))}
                          </div>
                          <label
                            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${perSegOn ? "text-neutral-400" : "text-neutral-600"}`}
                            title="逐段转写的并发路数。Whisper 可较高,Qwen3-ASR 较低;切换模型会重置为推荐默认值。"
                          >
                            并发
                            <input
                              type="range"
                              min={1}
                              max={sttConcMax}
                              step={1}
                              disabled={!perSegOn}
                              value={sttConc}
                              onChange={(e) => setSttConc(Number(e.target.value))}
                              className="w-24"
                            />
                            <span className="w-10 tabular-nums text-neutral-300">
                              {sttConc}/{sttConcMax}
                            </span>
                          </label>
                          <label
                            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${alignActive ? "text-neutral-300" : "text-neutral-600"}`}
                            title={
                              alignTakenOver
                                ? "已勾选 Align:最终时间戳由强制对齐(精确)提供,本开关不影响结果,已置灰"
                                : fuseOn
                                  ? "已选 VAD/Diarize,STT 必与之协同融合,本开关不生效"
                                  : sttIsWhisper
                                    ? "Whisper 自带时间戳,本开关只对 Qwen 等无时间戳引擎生效"
                                    : "开:整段文本按静音检测/总时长匀速对齐出时间戳。关:显示 Qwen 整段原文,不造分段时间戳"
                            }
                          >
                            <input
                              type="checkbox"
                              disabled={!alignActive}
                              // When Align has taken over, show UNCHECKED (not just greyed) — the
                              // heuristic genuinely does not run, so a lingering check would imply
                              // it still triggers. The user's real preference (alignTs) is kept and
                              // restored once Align is unchecked.
                              checked={alignTs && !alignTakenOver}
                              onChange={(e) => setAlignTs(e.target.checked)}
                            />
                            时间戳后处理对齐
                          </label>
                          <span className="ml-auto shrink-0 text-xs text-neutral-500" title="STT 的调用方式与分段来源;详见执行面板。">
                            {status}
                          </span>
                        </div>
                      );
                    })()}
                  {cap === "align" &&
                    (() => {
                      const dur = upload?.durationSec || 0;
                      const fuseOn = enabled.vad || enabled.diar;
                      // 分段对齐 needs VAD/Diar (segments) AND STT (per-segment text).
                      const perSegActive = enabled.align && fuseOn && enabled.stt;
                      const perSegOn = perSegActive && alignPerSeg;
                      const willSplit = enabled.align && !perSegOn && dur > 295;
                      const needText = enabled.align && !!upload && !enabled.stt && !manualText.trim();
                      const status = !enabled.align
                        ? ""
                        : !upload
                          ? "需上传音频(Align = 音频 + 已知文本 → 精确时间戳)"
                          : needText
                            ? "缺文本:勾选 STT 或在『③ 文本输入』框填参考文稿"
                            : perSegOn
                              ? `分段对齐 · 按 ${enabled.diar ? "Diarize" : "VAD"} 逐段(每段 <5min,精确)`
                              : willSplit
                                ? `整段 · 音频>5min 自动按 ≤${290}s 分段(${Math.ceil(dur / 290)} 段)+ 文本同步切分`
                                : `整段一次 · 文本来源:${enabled.stt ? "STT 转写" : "文本框"}${enabled.diar ? " · 按 Diarize 归属说话人" : ""}`;
                      return (
                        <div className="flex w-full basis-full flex-wrap items-center gap-3 border-t border-neutral-800/60 pt-2">
                          <label
                            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${perSegActive ? "text-neutral-300" : "text-neutral-600"}`}
                            title={
                              perSegActive
                                ? "开:按 VAD/Diarize 段逐段对齐(每段都 <5min,音频与文本天然对应,最准、可处理任意长度);关:整段对齐(>5min 时自动按≤290s切分+文本同步切分)。"
                                : "需同时勾选 STT 和 VAD/Diarize 才能分段对齐(逐段需要每段的转写文本)。"
                            }
                          >
                            <input
                              type="checkbox"
                              disabled={!perSegActive}
                              checked={alignPerSeg}
                              onChange={(e) => setAlignPerSeg(e.target.checked)}
                            />
                            分段对齐
                          </label>
                          <span
                            className="text-xs text-neutral-500"
                            title="强制对齐:给定音频与已知文本,输出每字/词精确起止时间。模型单次上限 5 分钟:不分段时,>5min 会在本应用侧自动切音频+切文本多次调用(尊重模型原生限制,不改引擎)。"
                          >
                            Align = 音频 + 文本 → 精确字/词时间戳(WhisperX 式)
                          </span>
                          <span className={`ml-auto shrink-0 text-xs ${needText ? "text-amber-400" : "text-neutral-500"}`}>{status}</span>
                        </div>
                      );
                    })()}
                  {cap === "enhance" && (
                    <label className="flex items-center gap-1.5 text-xs text-neutral-400" title="语音降噪会把音乐当噪声抹掉;处理歌曲时建议关闭,仅做前后对比">
                      <input
                        type="checkbox"
                        disabled={!enabled.enhance}
                        checked={enhancePre}
                        onChange={(e) => setEnhancePre(e.target.checked)}
                      />
                      作为后续输入(歌曲建议关)
                    </label>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button className="btn" disabled={running || !hasGateway || (!upload && !(manualText.trim() && enabled.translate))} onClick={run}>
              {running ? "执行中…" : !upload && manualText.trim() ? "▶ 翻译文本框内容" : "▶ 运行所选能力"}
            </button>
            {!hasGateway && <span className="text-sm text-amber-400">⚠ 未配置 Gateway URL，已禁用调用(见①)。</span>}
            {hasGateway && !upload && !(manualText.trim() && enabled.translate) && (
              <span className="text-sm text-neutral-500">先上传音频/视频(见②),或在『翻译』文本框输入文字做纯文本翻译。</span>
            )}
            {hasGateway && !upload && manualText.trim() && enabled.translate && (
              <span className="text-sm text-emerald-400">纯文本翻译模式:将翻译文本框内容(无需音频)。</span>
            )}
          </div>
          {running && progress && (
            <div className="mt-3 rounded border border-blue-900/60 bg-blue-950/30 px-3 py-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-blue-200">
                  {CAP_LABEL[progress.cap]} · {progress.phase}
                </span>
                <span className="tabular-nums text-blue-300">
                  {progress.total > 0 ? `${progress.done} / ${progress.total}` : "处理中…"}
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded bg-neutral-800">
                <div
                  className={`h-full bg-blue-500 ${progress.total > 0 ? "" : "w-1/3 animate-pulse"}`}
                  style={progress.total > 0 ? { width: `${Math.round((progress.done / progress.total) * 100)}%` } : undefined}
                />
              </div>
            </div>
          )}
        </Card>

        {/* execution transparency */}
        {exec.length > 0 && (
          <Card title="⑤ 执行透明面板(自证:只调了勾选项)">
            <div className="space-y-2">
              {CAP_ORDER.map((cap) => {
                const r = exec.find((x) => x.cap === cap);
                if (!r) return null;
                return <ExecRow key={cap} r={r} />;
              })}
            </div>
          </Card>
        )}

        {/* fused workflow result */}
        {exec.length > 0 && (
          <Card title="⑥ 工作流融合结果(各能力按依赖编排后的统一产出)">
            <FusionView merged={merged} diarSegs={asSegments(results.diar)} vadSegs={asSegments(results.vad)} embed={results.embed} />
            <div className="mt-5 flex gap-2">
              <button className="btn" onClick={() => exportFile("txt")}>
                导出 TXT
              </button>
              <button className="btn" onClick={() => exportFile("srt")}>
                导出 SRT
              </button>
              <button className="btn" onClick={() => exportFile("json")}>
                导出 JSON
              </button>
            </div>
          </Card>
        )}

        {/* per-capability raw outputs (evidence) */}
        {Object.keys(results).filter((k) => k !== "_fused").length > 0 || enhanceUrl ? (
          <Card title="⑦ 各能力单独输出(工作流中间产物 / 证据)">
            {results.stt && <SttView data={results.stt} />}
            {results.align && <AlignView data={results.align} />}
            {results.translate && <TranslateView data={results.translate} />}
            {results.vad && <SegView title="VAD 语音段" segs={asSegments(results.vad)} />}
            {results.diar && <DiarView segs={asSegments(results.diar)} />}
            {enhanceUrl && (
              <div className="mt-4">
                <h3 className="mb-1 font-medium">降噪增强(前 / 后)</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {upload && <audio className="w-full" controls src={`/api/upload/${upload.id}/audio`} />}
                  <audio className="w-full" controls src={enhanceUrl} />
                </div>
                <a className="btn mt-2 inline-block" href={enhanceUrl} download="enhanced.wav">
                  下载增强音频
                </a>
              </div>
            )}
            {results.embed && <EmbedView data={results.embed} />}
          </Card>
        ) : null}
        </>)}
      </main>

      <style>{`
        .input { width:100%; background:#0a0a0a; border:1px solid #333; border-radius:6px; padding:6px 10px; font-size:14px; color:#eee; }
        .input:disabled { opacity:.4; }
        .btn { background:#2563eb; color:#fff; border-radius:6px; padding:7px 14px; font-size:14px; font-weight:500; }
        .btn:disabled { opacity:.4; }
      `}</style>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-400">{label}</span>
      {children}
    </label>
  );
}

function ExecRow({ r }: { r: ExecRecord }) {
  const [open, setOpen] = useState(false);
  const badge = r.invoked
    ? r.error
      ? "bg-red-900 text-red-200"
      : r.ok
      ? "bg-emerald-900 text-emerald-200"
      : "bg-amber-900 text-amber-200"
    : "bg-neutral-800 text-neutral-400";
  const label = r.invoked ? (r.error ? "调用出错" : `已调用 ${r.status}`) : "已跳过";
  return (
    <div className="rounded border border-neutral-800 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-40 font-medium">{CAP_LABEL[r.cap]}</span>
        <span className={`rounded px-2 py-0.5 text-xs ${badge}`}>{label}</span>
        {!r.invoked && <span className="text-neutral-500">{r.skippedReason}</span>}
        {r.invoked && (
          <span className="text-neutral-400">
            {r.method} {r.endpoint} · {r.model} {r.durationMs != null ? `· ${r.durationMs}ms` : ""}
          </span>
        )}
        {(r.rawResponse || r.error) && (
          <button className="ml-auto text-xs text-blue-400" onClick={() => setOpen(!open)}>
            {open ? "收起" : "证据"}
          </button>
        )}
      </div>
      {r.invoked && r.responseSummary && <div className="mt-1 text-neutral-300">{r.responseSummary}</div>}
      {r.error && <div className="mt-1 text-red-300">{r.error}</div>}
      {open && (
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-black/60 p-2 text-xs text-neutral-300">
          {r.params ? "params: " + JSON.stringify(r.params) + "\n\n" : ""}
          {r.rawResponse || ""}
        </pre>
      )}
    </div>
  );
}

function SttView({ data }: { data: any }) {
  const segs = asSegments(data);
  return (
    <div className="mb-4">
      <h3 className="mb-1 flex items-center gap-2 font-medium">
        转写
        {data.tsSource && (
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-normal text-neutral-400">
            时间戳来源:{data.tsSource}
          </span>
        )}
      </h3>
      <p className="whitespace-pre-wrap rounded bg-black/40 p-2 text-sm text-neutral-200">{data.text || "(空)"}</p>
      {segs.length > 0 && (
        <div className="mt-2 max-h-56 overflow-auto text-xs">
          {segs.map((s, i) => (
            <div key={i} className="flex gap-2 border-b border-neutral-800 py-0.5">
              <span className="w-24 shrink-0 text-neutral-500">
                {fmtTime(s.start)}–{fmtTime(s.end)}
              </span>
              <span>{s.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function AlignView({ data }: { data: any }) {
  const units: Seg[] = Array.isArray(data?.units) ? data.units : [];
  const speakers = Array.from(new Set(units.map((u) => u.speaker || "").filter(Boolean)));
  const text = data?.text || units.map((u) => u.text || "").join("");
  return (
    <div className="mb-4">
      <h3 className="mb-1 flex flex-wrap items-center gap-2 font-medium">
        强制对齐 Align
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-normal text-neutral-400">
          {data.mode || "对齐"} · 文本来源:{data.textSource || "?"} · 语言:{data.language || "?"}
          {data.calls > 1 ? ` · ${data.calls} 次调用` : ""}
        </span>
      </h3>
      {!units.length ? (
        <p className="rounded bg-black/40 p-2 text-sm text-neutral-400">(无对齐单元)</p>
      ) : (
        <>
          <p className="whitespace-pre-wrap rounded bg-black/40 p-2 text-sm text-neutral-200">{text || "(空)"}</p>
          <div className="mt-2 flex max-h-56 flex-wrap gap-1 overflow-auto">
            {units.map((u, i) => (
              <span
                key={i}
                className="inline-flex flex-col items-center rounded border border-neutral-800 bg-neutral-900/60 px-1.5 py-0.5"
                title={`${fmtTime(u.start)}–${fmtTime(u.end)}${u.speaker ? ` · ${u.speaker}` : ""}`}
                style={u.speaker ? { borderColor: speakerColor(u.speaker, speakers) } : undefined}
              >
                <span className="text-sm text-neutral-100">{u.text || "·"}</span>
                <span className="text-[10px] tabular-nums text-neutral-500">{u.start.toFixed(2)}</span>
              </span>
            ))}
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            {units.length} 个对齐单元(字/词级精确时间戳){speakers.length ? ` · 已按 ${speakers.length} 位说话人归属(悬停看说话人)` : ""}
          </p>
        </>
      )}
    </div>
  );
}
function TranslateView({ data }: { data: any }) {
  const t = data.translation ?? data.text ?? data.translated_text ?? JSON.stringify(data);
  return (
    <div className="mb-4">
      <h3 className="mb-1 font-medium">翻译</h3>
      <p className="whitespace-pre-wrap rounded bg-black/40 p-2 text-sm text-neutral-200">{t}</p>
    </div>
  );
}
function SegView({ title, segs }: { title: string; segs: Seg[] }) {
  return (
    <div className="mb-4">
      <h3 className="mb-1 font-medium">{title}（{segs.length} 段）</h3>
      <div className="max-h-40 overflow-auto text-xs">
        {segs.map((s, i) => (
          <span key={i} className="mr-2 inline-block rounded bg-neutral-800 px-2 py-0.5">
            {fmtTime(s.start)}–{fmtTime(s.end)}
          </span>
        ))}
      </div>
    </div>
  );
}
function DiarView({ segs }: { segs: Seg[] }) {
  const speakers = Array.from(new Set(segs.map((s) => s.speaker || "?")));
  return (
    <div className="mb-4">
      <h3 className="mb-1 font-medium">说话人分离（{speakers.length} 人 / {segs.length} 段）</h3>
      <div className="max-h-56 overflow-auto text-xs">
        {segs.map((s, i) => (
          <div key={i} className="flex items-center gap-2 py-0.5">
            <span className="inline-block h-3 w-3 rounded-full" style={{ background: speakerColor(s.speaker || "?", speakers) }} />
            <span className="w-20 text-neutral-400">{s.speaker || "?"}</span>
            <span className="text-neutral-500">
              {fmtTime(s.start)}–{fmtTime(s.end)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
function EmbedView({ data }: { data: any }) {
  let vecs: number[][] = [];
  const raw = data.embeddings || data.embedding || data.vector || data.data;
  if (Array.isArray(raw)) vecs = Array.isArray(raw[0]) ? raw : [raw];
  const dim = vecs[0]?.length || 0;
  const labels: string[] = data.perSpeaker ? data.speakers || [] : vecs.map((_, i) => `#${i + 1}`);
  return (
    <div className="mb-4">
      <h3 className="mb-1 font-medium">
        声纹向量（{vecs.length} 个 · 维度 {dim}{data.perSpeaker ? " · 按说话人" : ""}）
      </h3>
      {vecs.length > 1 && (
        <table className="text-xs">
          <tbody>
            <tr>
              <td className="px-2 py-0.5" />
              {labels.map((l, j) => (
                <td key={j} className="px-2 py-0.5 text-center text-neutral-400">
                  {l}
                </td>
              ))}
            </tr>
            {vecs.map((a, i) => (
              <tr key={i}>
                <td className="px-2 py-0.5 text-neutral-400">{labels[i]}</td>
                {vecs.map((b, j) => (
                  <td key={j} className="border border-neutral-800 px-2 py-0.5 text-center" style={{ opacity: 0.5 + cosine(a, b) / 2 }}>
                    {cosine(a, b).toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {vecs.length === 1 && <p className="text-xs text-neutral-400">[{vecs[0].slice(0, 8).map((x) => x.toFixed(3)).join(", ")} …]</p>}
    </div>
  );
}
function FusionView({
  merged,
  diarSegs,
  vadSegs,
  embed,
}: {
  merged: Seg[];
  diarSegs: Seg[];
  vadSegs: Seg[];
  embed: any;
}) {
  // unified timeline: prefer transcript; else speaker-only (diar); else speech-only (vad)
  const timeline = merged.length ? merged : diarSegs.length ? diarSegs : vadSegs;
  const speakers = Array.from(new Set(timeline.map((s) => s.speaker || "?").filter((x) => x !== "?")));
  const hasText = merged.some((s) => (s.text || "").trim());
  const hasTr = merged.some((s) => (s as any).translation);

  // per-speaker similarity (from per-speaker embed)
  const simSpeakers: string[] = embed?.perSpeaker ? embed.speakers || [] : [];
  const simVecs: number[][] = embed?.perSpeaker ? embed.embeddings || [] : [];

  if (!timeline.length) {
    return <p className="text-sm text-neutral-400">没有可融合的结果(请至少启用 STT 或 Diarize/VAD)。</p>;
  }
  return (
    <div className="space-y-4">
      {speakers.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {speakers.map((spk) => (
            <span key={spk} className="rounded px-2 py-0.5" style={{ background: speakerColor(spk, speakers) }}>
              {spk}
            </span>
          ))}
        </div>
      )}

      <div className="max-h-96 overflow-auto rounded border border-neutral-800">
        {timeline.map((s, i) => {
          const spk = s.speaker || "";
          const tr = (s as any).translation as string | undefined;
          return (
            <div key={i} className="flex gap-3 border-b border-neutral-800/60 px-3 py-1.5 text-sm">
              {spk && (
                <span
                  className="mt-0.5 h-fit shrink-0 rounded px-1.5 py-0.5 text-xs"
                  style={{ background: speakerColor(spk, speakers) }}
                >
                  {spk}
                </span>
              )}
              <span className="mt-0.5 w-20 shrink-0 text-xs text-neutral-500">{fmtTime(s.start)}</span>
              <div className="min-w-0 flex-1">
                {hasText ? (
                  <>
                    <div className="text-neutral-100">{s.text || <span className="text-neutral-600">(无转写)</span>}</div>
                    {tr && <div className="text-neutral-400">↳ {tr}</div>}
                  </>
                ) : (
                  <span className="text-neutral-400">
                    {fmtTime(s.start)}–{fmtTime(s.end)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-neutral-500">
        {hasText
          ? `融合自:转写${hasTr ? " + 翻译" : ""}${speakers.length ? " + 说话人分离" : ""}(共 ${timeline.length} 段)`
          : speakers.length
          ? `说话人时间轴(${speakers.length} 人 / ${timeline.length} 段) — 启用 STT 可获得带文字的转写`
          : `人声时间轴(${timeline.length} 段) — 启用 STT/Diarize 可获得更丰富的融合`}
      </p>

      {simSpeakers.length > 1 && simVecs.length > 1 && (
        <div>
          <h3 className="mb-1 text-sm font-medium">说话人声纹相似度矩阵(对角≈1,异说话人应偏低 → 证明区分成功)</h3>
          <table className="text-xs">
            <tbody>
              <tr>
                <td className="px-2 py-0.5" />
                {simSpeakers.map((spk) => (
                  <td key={spk} className="px-2 py-0.5 text-center text-neutral-400">
                    {spk}
                  </td>
                ))}
              </tr>
              {simVecs.map((a, i) => (
                <tr key={i}>
                  <td className="px-2 py-0.5 text-neutral-400">{simSpeakers[i]}</td>
                  {simVecs.map((b, j) => (
                    <td
                      key={j}
                      className="border border-neutral-800 px-2 py-0.5 text-center"
                      style={{ background: `rgba(96,165,250,${Math.max(0, cosine(a, b)) * 0.5})` }}
                    >
                      {cosine(a, b).toFixed(2)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
