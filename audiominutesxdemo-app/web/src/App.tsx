// Audio Minutes X Demo — Feishu-Minutes-style app.
//   • Library ("我的内容"): upload audio/video, server transcribes asynchronously,
//     cards show 处理中 N% and survive refresh.
//   • Record detail: media player <-> word-level transcript two-way sync. Playback
//     highlights the current word and auto-scrolls; click a word to seek there.
//   • Settings: LLM Gateway address + which STT/align/diar models to use (chosen
//     from what the gateway actually serves). Missing a required model => the app
//     tells you it cannot transcribe.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GatewayConfig, ModelOpt, Notice, RecordFull, RecordSummary, Segment, Word } from "./types";
import * as api from "./api";
import { ensureJieba, jiebaCut, jiebaState } from "./jieba";

// ---- small helpers ----
function fmtTC(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(ss).padStart(2, "0")}`;
}
function fmtDur(sec: number | null): string {
  if (!sec && sec !== 0) return "";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h} 时 ${m} 分`;
  if (m > 0) return `${m} 分 ${ss} 秒`;
  return `${ss} 秒`;
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;
// Client mirror of the server finalizeWords: clamp into [lo,hi] and make word
// starts strictly increasing with a minimum duration, so every word is hittable
// and highlightable. Returns NEW word objects (never mutates the input).
function fixWordTimes(words: Word[], lo: number, hi: number): Word[] {
  if (!words.length) return words;
  const out = words.map((w) => ({ ...w }));
  const hasBound = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo;
  if (hasBound) {
    for (const w of out) {
      w.start = Math.min(Math.max(w.start, lo), hi);
      w.end = Math.min(Math.max(w.end, lo), hi);
    }
  }
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
  const n = out.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && out[j + 1].start <= out[i].start) j++;
    const s = out[i].start;
    if (j > i) {
      const next = j + 1 < n ? out[j + 1].start : s + (j - i + 1) * 0.2;
      const step = Math.max(0.05, (next - s) / (j - i + 1));
      for (let k = i; k <= j; k++) { out[k].start = round3(s + step * (k - i)); out[k].end = round3(s + step * (k - i + 1)); }
    } else if (!(out[i].end > out[i].start)) {
      out[i].end = round3(out[i].start + 0.15);
    }
    i = j + 1;
  }
  return out;
}
// A CJK ideograph (Han). Alignment/STT gives Chinese ONE char per token; the 词
// (word) view groups these into words. Latin tokens are already whole words.
const isCJKChar = (ch: string) => !!ch && /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(ch);
const isCJKToken = (w: Word) => isCJKChar((w.text || "").charAt(0));
// sliceToWords drops the whitespace between tokens, so rendering the word <span>s
// back-to-back glues English words together AND removes every line-break
// opportunity (a whole English line becomes one unbreakable token → horizontal
// overflow). Re-insert a separating space before a word EXCEPT when either side
// touches a CJK char (Chinese/Japanese need no spaces). Punctuation stays attached
// to its own token, so this never inserts a space in front of / loses punctuation.
const needsSpaceBefore = (prev: Word, cur: Word) => {
  const a = prev?.text || "";
  const b = cur?.text || "";
  if (!a || !b) return false;
  if (isCJKChar(a.charAt(a.length - 1)) || isCJKChar(b.charAt(0))) return false;
  // A contraction split across tokens by an older tokenizer (I' + m, Let' + s):
  // don't insert a space around the apostrophe.
  if (/['’]$/.test(a) || /^['’]/.test(b)) return false;
  return true;
};

// Subtitle cue: a SHORT clause (one line of on-screen subtitle) with its own time
// window. Feishu-Minutes shows only the currently-spoken clause, never a whole
// speaker paragraph — so we re-split the word stream on clause punctuation (and a
// hard width cap for run-ons), independent of how the transcript groups segments.
type SubCue = { start: number; end: number; text: string };
const CLAUSE_END = /[，。！？；、,.!?;:…]$/;
// Display width: CJK glyphs are ~2x a latin char. ~40 ≈ 20 Chinese chars / line.
const cueWidth = (s: string) => {
  let w = 0;
  for (const ch of s) w += isCJKChar(ch) ? 2 : 1;
  return w;
};
function buildCues(words: { segIdx: number; text: string; start: number; end: number }[]): SubCue[] {
  const cues: SubCue[] = [];
  let cur: { segIdx: number; text: string; start: number; end: number }[] = [];
  const flush = () => {
    if (!cur.length) return;
    let text = "";
    for (let i = 0; i < cur.length; i++) {
      if (i > 0 && needsSpaceBefore(cur[i - 1], cur[i])) text += " ";
      text += cur[i].text;
    }
    text = text.trim();
    if (text) cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && w.segIdx !== cur[cur.length - 1].segIdx) flush(); // speaker turn
    cur.push(w);
    const t = w.text || "";
    const width = cueWidth(cur.map((x) => x.text).join(""));
    if (CLAUSE_END.test(t) || width >= 40) flush();
  }
  flush();
  return cues;
}

// Per-character search match, computed OVER THE WHOLE LINE (not per word) so a
// query can span word boundaries (e.g. "我们讨" over 我们|讨论, or "a fresh" over
// a|fresh). Reconstructs the exact visible line text — same inter-word spaces as
// rendering (needsSpaceBefore) — lowercases it, finds every occurrence of the
// (already-lowercased) query, then projects the hit mask back onto each word's
// chars and the space in front of it.
interface LineMatch { wordMask: boolean[][]; spaceMatched: boolean[]; count: number }
function matchLine(words: Word[], query: string): LineMatch {
  const wordMask = words.map((w) => new Array((w.text || "").length).fill(false));
  const spaceMatched = words.map(() => false);
  if (!query) return { wordMask, spaceMatched, count: 0 };
  // Build the line text + a map from each UTF-16 unit back to (word, isSpace).
  let full = "";
  const owner: number[] = [];
  const isSpace: boolean[] = [];
  for (let wi = 0; wi < words.length; wi++) {
    if (wi > 0 && needsSpaceBefore(words[wi - 1], words[wi])) { full += " "; owner.push(wi); isSpace.push(true); }
    const t = words[wi].text || "";
    for (let k = 0; k < t.length; k++) { full += t[k]; owner.push(wi); isSpace.push(false); }
  }
  const hay = full.toLowerCase();
  let from = 0, idx: number, count = 0;
  const hit = new Array(full.length).fill(false);
  while ((idx = hay.indexOf(query, from)) >= 0) {
    for (let p = idx; p < idx + query.length; p++) hit[p] = true;
    count++;
    from = idx + query.length;
  }
  if (count) {
    const off = words.map(() => 0);
    for (let p = 0; p < hit.length; p++) {
      const wi = owner[p];
      if (isSpace[p]) { if (hit[p]) spaceMatched[wi] = true; }
      else { if (hit[p]) wordMask[wi][off[wi]] = true; off[wi]++; }
    }
  }
  return { wordMask, spaceMatched, count };
}

// Split a string into consecutive [matched | not] runs using a boolean mask.
function maskRuns(text: string, mask: boolean[]): { text: string; hit: boolean }[] {
  const runs: { text: string; hit: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const m = !!mask[i];
    let j = i;
    while (j < text.length && !!mask[j] === m) j++;
    runs.push({ text: text.slice(i, j), hit: m });
    i = j;
  }
  return runs;
}

// A word segment over a piece of text: the substring, its char offset, and whether
// it's a real word (vs punctuation/symbol). Produced by jieba (preferred) or, as a
// fallback, the browser's ICU Intl.Segmenter.
interface MiniSeg { segment: string; index: number; isWordLike: boolean }

const zhSegmenter: any =
  typeof Intl !== "undefined" && (Intl as any).Segmenter
    ? new (Intl as any).Segmenter("zh", { granularity: "word" })
    : null;
// ICU fallback tokenizer (used until jieba's wasm finishes loading, or if it fails).
function intlCut(text: string): MiniSeg[] {
  if (!zhSegmenter) return [{ segment: text, index: 0, isWordLike: true }];
  return Array.from(zhSegmenter.segment(text)) as MiniSeg[];
}
const WORDLIKE_RE = /[\p{L}\p{N}]/u;

// Group per-CHAR Chinese tokens into per-WORD tokens for the 词 view. Only runs of
// adjacent CJK single-char tokens are merged (via `cut`); Latin/other tokens pass
// through untouched so English spacing/words are preserved. Each merged word keeps
// the first char's start and last char's end so highlight + click-seek stay
// accurate. Trailing punctuation stays attached to its word. Returns NEW objects.
function groupWordsToCi(words: Word[], cut: (t: string) => MiniSeg[]): Word[] {
  if (words.length <= 1) return words;
  const out: Word[] = [];
  let i = 0;
  while (i < words.length) {
    if (!isCJKToken(words[i])) { out.push(words[i]); i++; continue; }
    // Collect a maximal run of CJK single-char tokens.
    let j = i;
    while (j < words.length && isCJKToken(words[j])) j++;
    const run = words.slice(i, j);
    // Build the run's text and a char→token index map.
    let full = "";
    const charTok: number[] = [];
    run.forEach((w, ti) => { for (const ch of w.text) { full += ch; charTok.push(ti); } });
    for (const seg of cut(full)) {
      const a = seg.index;
      const b = seg.index + seg.segment.length;
      if (b <= a) continue;
      const tStart = charTok[a];
      const tEnd = charTok[b - 1];
      const start = run[tStart].start;
      const end = run[tEnd].end;
      if (!seg.isWordLike && out.length) {
        // Punctuation / symbols → attach to the previous word.
        const prev = out[out.length - 1];
        prev.text += seg.segment;
        if (end > prev.end) prev.end = end;
      } else {
        out.push({ text: seg.segment, start, end });
      }
    }
    i = j;
  }
  return out;
}
const SPK_COLORS = ["#34d399", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#22d3ee", "#fb923c", "#4ade80"];
function spkIdx(spk: string): number {
  const m = /(\d+)/.exec(spk || "");
  return m ? parseInt(m[1], 10) : 0;
}
function spkColor(spk: string): string {
  return SPK_COLORS[spkIdx(spk) % SPK_COLORS.length];
}
function spkLabel(spk: string): string {
  const m = /(\d+)/.exec(spk || "");
  return m ? `说话人 ${parseInt(m[1], 10) + 1}` : spk || "说话人";
}

function SpeakerChip({ spk }: { spk: string }) {
  const c = spkColor(spk);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium leading-none"
      style={{ color: c, backgroundColor: c + "22", border: `1px solid ${c}55` }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c }} />
      {spkLabel(spk)}
    </span>
  );
}

function statusText(r: RecordSummary): string {
  if (r.status === "processing") {
    const cnt = r.stepTotal > 0 ? ` (${r.stepDone}/${r.stepTotal})` : "";
    return `处理中 ${r.progress}%${r.phase ? " · " + r.phase : ""}${cnt}`;
  }
  if (r.status === "uploaded") return "待转录";
  if (r.status === "done") return "已完成";
  if (r.status === "error") return "失败";
  return r.status;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// Detailed processing view: overall %, a pipeline checklist with the active
// stage's step counter, and a live elapsed timer (the diarization stage is a
// single long gateway call with no sub-progress, so the timer reassures the
// user it is still working).
// Processing event/notice log — surfaces WHAT happened during a run (denoise fell
// back, alignment auto-split, a step failed) so the pipeline isn't a black box.
function NoticeList({ notices, className = "" }: { notices?: Notice[]; className?: string }) {
  if (!notices || notices.length === 0) return null;
  const box = (l: string) =>
    l === "error"
      ? "border-red-900/60 bg-red-950/30 text-red-200"
      : l === "warn"
      ? "border-amber-900/60 bg-amber-950/30 text-amber-100"
      : "border-neutral-800 bg-neutral-900/50 text-neutral-300";
  const dot = (l: string) =>
    l === "error" ? "bg-red-600 text-white" : l === "warn" ? "bg-amber-500 text-black" : "bg-neutral-700 text-neutral-200";
  const sym = (l: string) => (l === "error" ? "✕" : l === "warn" ? "!" : "i");
  const clock = (at: string) => {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
  };
  return (
    <div className={`space-y-1.5 ${className}`}>
      {notices.map((n, i) => (
        <div key={i} className={`flex items-start gap-2 rounded-lg border px-3 py-1.5 text-xs ${box(n.level)}`}>
          <span className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${dot(n.level)}`}>
            {sym(n.level)}
          </span>
          <span className="flex-1 break-words leading-snug">{n.msg}</span>
          <span className="shrink-0 tabular-nums text-[10px] opacity-50">{clock(n.at)}</span>
        </div>
      ))}
    </div>
  );
}

// Draggable left/right splitter (Feishu-Minutes style): the left pane has an
// explicit, user-resizable width (persisted); the right pane fills the rest. Drag
// the thin bar between them to rebalance the player vs. transcript panes.
function ResizableSplit({
  storageKey,
  defaultPx,
  minPx = 220,
  maxFrac = 0.8,
  left,
  right,
}: {
  storageKey: string;
  defaultPx: number;
  minPx?: number;
  maxFrac?: number;
  left: ReactNode;
  right: ReactNode;
}) {
  const [w, setW] = useState<number>(() => {
    const s = localStorage.getItem(storageKey);
    const n = s ? parseFloat(s) : NaN;
    return Number.isFinite(n) ? n : defaultPx;
  });
  const wRef = useRef(w);
  wRef.current = w;
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      let nw = e.clientX - rect.left;
      nw = Math.max(minPx, Math.min(rect.width * maxFrac, nw));
      setW(nw);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(storageKey, String(Math.round(wRef.current)));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [minPx, maxFrac, storageKey]);
  const start = () => {
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
      <div className="min-h-0 shrink-0 overflow-hidden" style={{ width: w }}>{left}</div>
      <div
        onMouseDown={start}
        title="拖动调整左右宽度"
        className="group relative w-px shrink-0 cursor-col-resize bg-neutral-800 hover:bg-emerald-500/70"
      >
        {/* wider invisible hit area so the 1px bar is easy to grab */}
        <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
        <div className="absolute inset-y-0 left-0 w-px bg-emerald-500/0 group-hover:bg-emerald-500/70" />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{right}</div>
    </div>
  );
}

function ProcessingView({ rec, onStop }: { rec: RecordFull; onStop?: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const p = rec.progress || 0;
  const elapsed = rec.startedAt ? now - new Date(rec.startedAt).getTime() : 0;
  const hasCount = (rec.stepTotal || 0) > 0;

  // The step list reflects the OPTIONS actually enabled for THIS file — optional
  // stages (降噪增强 / 翻译) appear as their own steps instead of being hidden
  // inside the native three. The active step is derived from the server phase
  // text (robust to the 整段/分段/回退 variants); progress is only the fallback.
  const opts = rec.options;
  const ph = rec.phase || "";
  const queued = ph.includes("排队");
  // 补翻译 (translate-only) reuses the queue but runs ONLY the translation step —
  // don't show the transcription pipeline (说话人分离/转写/整理), which isn't running.
  const translateOnly = rec.jobKind === "translate";
  const steps: { key: string; label: string }[] = [];
  if (translateOnly) {
    steps.push({ key: "translate", label: "翻译" });
  } else {
    if (opts?.enhance) steps.push({ key: "enhance", label: "降噪增强" });
    steps.push({ key: "diar", label: "说话人分离" });
    steps.push({ key: "stt", label: "转写与词级对齐" });
    steps.push({ key: "tidy", label: "整理结果" });
    if (opts?.translate) steps.push({ key: "translate", label: "翻译" });
  }

  const activeKey = queued
    ? translateOnly
      ? "translate"
      : null
    : ph.includes("降噪")
    ? "enhance"
    : ph.includes("说话人")
    ? "diar"
    : ph.includes("翻译")
    ? "translate"
    : ph.includes("整理结果")
    ? "tidy"
    : ph.includes("转写") || ph.includes("对齐")
    ? "stt"
    : translateOnly
    ? "translate"
    : p >= 94
    ? "tidy"
    : p >= 20
    ? "stt"
    : p >= 3
    ? "diar"
    : opts?.enhance
    ? "enhance"
    : "diar";
  const stage = activeKey ? steps.findIndex((s) => s.key === activeKey) : -1;

  return (
    <div className="w-full max-w-md space-y-5">
      <div className="text-center">
        <div className="text-3xl font-semibold tabular-nums text-neutral-100">{p}%</div>
        <div className="mt-1 text-sm text-neutral-400">{rec.phase || "处理中…"}</div>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-neutral-800">
        <div className="h-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${p}%` }} />
      </div>
      <ol className="space-y-2 text-left">
        {steps.map(({ key, label }, i) => {
          const done = stage >= 0 && i < stage;
          const active = i === stage;
          return (
            <li
              key={i}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
                active
                  ? "border-emerald-600/60 bg-emerald-950/30 text-emerald-200"
                  : done
                  ? "border-neutral-800 text-neutral-400"
                  : "border-neutral-800/60 text-neutral-600"
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                  done ? "bg-emerald-600 text-white" : active ? "bg-emerald-500/80 text-white" : "bg-neutral-800 text-neutral-500"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span className="flex-1">{label}</span>
              {active && hasCount && <span className="tabular-nums text-xs text-emerald-300">{rec.stepDone}/{rec.stepTotal} 段</span>}
              {active && !hasCount && <span className="text-xs text-emerald-300/80">进行中…</span>}
            </li>
          );
        })}
      </ol>
      {rec.notices && rec.notices.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-neutral-400">处理记录</div>
          <NoticeList notices={rec.notices} />
        </div>
      )}
      <div className="text-center text-xs text-neutral-500">已用时 {fmtElapsed(elapsed)} · 串行处理,多个任务会自动排队</div>
      {onStop && (
        <div className="text-center">
          <button
            className="rounded border border-red-800/70 px-4 py-1.5 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-40"
            disabled={stopping}
            title="停止本次转写(无法真正暂停,只能中止)"
            onClick={() => { setStopping(true); onStop(); }}
          >
            {stopping ? "停止中…" : "停止"}
          </button>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Settings modal
// ===========================================================================
function SettingsPage({
  config,
  onBack,
  onSaved,
}: {
  config: GatewayConfig;
  onBack: () => void;
  onSaved: (cfg: GatewayConfig) => void;
}) {
  const [base, setBase] = useState(config.base);
  const [key, setKey] = useState(config.key);
  const [cookie, setCookie] = useState(config.cookie);
  const [modes, setModes] = useState<Record<string, ModelOpt[]>>({});
  const [stt, setStt] = useState(config.models.stt);
  const [align, setAlign] = useState(config.models.align);
  const [diar, setDiar] = useState(config.models.diar);
  const [segmentedStt, setSegmentedStt] = useState(config.segmentedStt);
  const [language, setLanguage] = useState(config.language || "auto");
  const [autoTranscribe, setAutoTranscribe] = useState(config.autoTranscribe ?? true);
  const [trEnabled, setTrEnabled] = useState(config.translate?.enabled ?? false);
  const [trModel, setTrModel] = useState(config.translate?.model || "");
  const [trSource, setTrSource] = useState(config.translate?.sourceLang || "auto");
  const [trTarget, setTrTarget] = useState(config.translate?.targetLang || "auto");
  const [enhEnabled, setEnhEnabled] = useState(config.enhance?.enabled ?? false);
  const [enhModel, setEnhModel] = useState(config.enhance?.model || "");
  const [bgEnabled, setBgEnabled] = useState(config.background?.enabled ?? false);
  const [bgDim, setBgDim] = useState(config.background?.dim ?? 40);
  const [bgHasImg, setBgHasImg] = useState(!!config.background?.mime);
  const bgFileRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const loadModels = useCallback(async () => {
    setErr(""); setMsg(""); setLoading(true);
    try {
      // Persist creds first so /api/models (server-side) can reach the gateway.
      await api.putConfig({ base, key, cookie });
      const m = await api.getModels();
      setModes(m.modes || {});
      const cnt = Object.values(m.modes || {}).reduce((n, a) => n + a.length, 0);
      setMsg(`已从网关发现 ${cnt} 个模型`);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setModes({});
    } finally {
      setLoading(false);
    }
  }, [base, key, cookie]);

  useEffect(() => {
    // If a gateway is already configured, load models on open.
    if (config.base) loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setErr(""); setLoading(true);
    try {
      const saved = await api.putConfig({
        base, key, cookie,
        models: { stt, align, diar },
        segmentedStt, language, autoTranscribe,
        translate: { enabled: trEnabled, model: trModel, sourceLang: trSource, targetLang: trTarget },
        enhance: { enabled: enhEnabled, model: enhModel },
        background: { enabled: bgEnabled, dim: bgDim },
      });
      onSaved(saved);
      setMsg("已保存");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function onPickBg(f: File | null) {
    if (!f) return;
    setErr(""); setLoading(true);
    try {
      const saved = await api.uploadBackground(f);
      onSaved(saved);
      setBgEnabled(true); setBgHasImg(true);
      setBgDim(saved.background?.dim ?? bgDim);
      setMsg("背景图已上传");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
      if (bgFileRef.current) bgFileRef.current.value = "";
    }
  }

  async function onRemoveBg() {
    setErr(""); setLoading(true);
    try {
      const saved = await api.deleteBackground();
      onSaved(saved);
      setBgEnabled(false); setBgHasImg(false);
      setMsg("背景图已移除");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  const ModelSelect = ({ label, mode, value, set }: { label: string; mode: string; value: string; set: (v: string) => void }) => {
    const opts = modes[mode] || [];
    return (
      <label className="block text-sm">
        <span className="mb-0.5 block text-xs text-neutral-400">{label} <span className="text-neutral-600">(mode={mode})</span></span>
        <select className="input !py-1.5" value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{opts.length ? "— 请选择 —" : "(网关无此模型)"}</option>
          {opts.map((o) => (
            <option key={o.id || o.name} value={o.name}>
              {o.name}{o.provider_name ? ` · ${o.provider_name}` : ""}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const LANG_OPTS = (
    <>
      <option value="auto">自动检测</option>
      <option value="zho_Hans">中文(简) zho_Hans</option>
      <option value="eng_Latn">English eng_Latn</option>
      <option value="jpn_Jpan">日本語 jpn_Jpan</option>
      <option value="kor_Hang">한국어 kor_Hang</option>
    </>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Page header — 返回 + title + 保存 always visible */}
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2.5">
        <button className="btn-ghost" onClick={onBack}>← 返回</button>
        <div className="text-base font-semibold">设置 · LLM Gateway</div>
        {!err && msg && <span className="text-xs text-emerald-400">✓ {msg}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-ghost" onClick={loadModels} disabled={loading || !base}>
            {loading ? "加载中…" : "加载模型"}
          </button>
          <button className="btn-primary" onClick={save} disabled={loading}>保存</button>
        </div>
      </div>

      {/* Error banner — pinned at the TOP so it is never buried. */}
      {err && (
        <div className="px-4 pt-2">
          <p className="rounded bg-red-950/70 px-3 py-2 text-sm text-red-200 ring-1 ring-red-800/60">⚠ {err}</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto grid w-full max-w-6xl auto-rows-min gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {/* 连接网关 */}
          <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2.5">
            <div className="text-sm font-medium text-neutral-200">连接网关</div>
            <label className="block text-sm">
              <span className="mb-0.5 block text-xs text-neutral-400">网关地址(Base URL)</span>
              <input className="input !py-1.5" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://<gateway-host>" />
            </label>
            <label className="block text-sm">
              <span className="mb-0.5 block text-xs text-neutral-400">API Key(数据面 Bearer)</span>
              <input className="input !py-1.5" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." />
            </label>
            <label className="block text-sm">
              <span className="mb-0.5 block text-xs text-neutral-400">Olares Cookie(本地调试用;部署到 Olares 请留空)</span>
              <input className="input !py-1.5" value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="auth_token=..." />
              <span className="mt-1 block text-[11px] leading-tight text-neutral-500">留空则自动透传浏览器身份(部署在 Olares 时用它)。</span>
            </label>
          </div>

          {/* 模型 */}
          <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2.5">
            <div className="text-sm font-medium text-neutral-200">模型</div>
            <ModelSelect label="转写 STT" mode="stt" value={stt} set={setStt} />
            <ModelSelect label="强制对齐 Align" mode="align" value={align} set={setAlign} />
            <ModelSelect label="说话人分离 Diarize" mode="diar" value={diar} set={setDiar} />
            <label className="block text-sm">
              <span className="mb-0.5 block text-xs text-neutral-400">对齐语言(默认自动识别)</span>
              <select className="input !py-1.5" value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="auto">自动识别(按转写文本判定)</option>
                <option value="zh">中文 zh</option>
                <option value="en">English en</option>
                <option value="ja">日本語 ja</option>
                <option value="ko">한국어 ko</option>
                <option value="yue">粤语 yue</option>
              </select>
            </label>
          </div>

          {/* 转写默认(新文件) */}
          <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2.5">
            <div className="text-sm font-medium text-neutral-200">
              转写默认值 <span className="text-[11px] font-normal text-neutral-500">· 详情页可逐文件覆盖</span>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={segmentedStt} onChange={(e) => setSegmentedStt(e.target.checked)} />
              <span>
                <span className="block text-neutral-200">分段转写</span>
                <span className="block text-[11px] leading-tight text-neutral-500">关=整段一次 STT 再切分;开=按 diarization 窗口逐段转写。</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={autoTranscribe} onChange={(e) => setAutoTranscribe(e.target.checked)} />
              <span>
                <span className="block text-neutral-200">上传后自动转写</span>
                <span className="block text-[11px] leading-tight text-neutral-500">开(默认)=上传即转写;关=仅入库「待转录」,可先选选项再手动转写。</span>
              </span>
            </label>
          </div>

          {/* 翻译 */}
          <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2.5">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={trEnabled} onChange={(e) => setTrEnabled(e.target.checked)} />
              <span>
                <span className="block font-medium text-neutral-200">翻译 Translate</span>
                <span className="block text-[11px] leading-tight text-neutral-500">默认关。开启后转写时一并翻译,已转写记录可在详情页「补翻译」。</span>
              </span>
            </label>
            <ModelSelect label="翻译模型" mode="translate" value={trModel} set={setTrModel} />
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-sm">
                <span className="mb-0.5 block text-xs text-neutral-400">源语言</span>
                <select className="input !py-1.5" value={trSource} onChange={(e) => setTrSource(e.target.value)}>{LANG_OPTS}</select>
              </label>
              <label className="block text-sm">
                <span className="mb-0.5 block text-xs text-neutral-400">目标语言</span>
                <select className="input !py-1.5" value={trTarget} onChange={(e) => setTrTarget(e.target.value)}>
                  <option value="auto">自动(中→英,其他→中)</option>
                  <option value="zho_Hans">中文(简) zho_Hans</option>
                  <option value="eng_Latn">English eng_Latn</option>
                  <option value="jpn_Jpan">日本語 jpn_Jpan</option>
                  <option value="kor_Hang">한국어 kor_Hang</option>
                </select>
              </label>
            </div>
          </div>

          {/* 降噪增强 Enhance */}
          <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2.5">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={enhEnabled} onChange={(e) => setEnhEnabled(e.target.checked)} />
              <span>
                <span className="block font-medium text-neutral-200">降噪增强 Enhance</span>
                <span className="block text-[11px] leading-tight text-neutral-500">
                  默认关。转写前先降噪(仅用于识别,播放仍原音频)。
                  <span className="text-amber-400">背景音乐较明显的文件不建议开启</span>——降噪会把音乐当噪声抹除。
                </span>
              </span>
            </label>
            <ModelSelect label="增强模型" mode="enhance" value={enhModel} set={setEnhModel} />
          </div>

          {/* 界面 · 背景图 */}
          <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2.5">
            <div className="text-sm font-medium text-neutral-200">
              界面 · 背景图 <span className="text-[11px] font-normal text-neutral-500">· 白天/夜晚见右上角 🌙/☀️</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input ref={bgFileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onPickBg(e.target.files?.[0] || null)} />
              <button className="btn-ghost !py-1.5" onClick={() => bgFileRef.current?.click()} disabled={loading}>上传背景图</button>
              {bgHasImg && <button className="btn-ghost !py-1.5" onClick={onRemoveBg} disabled={loading}>移除</button>}
              <span className="text-xs text-neutral-500">{bgHasImg ? "已设置" : "未设置"}</span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={bgEnabled} onChange={(e) => setBgEnabled(e.target.checked)} disabled={!bgHasImg} />
              <span className="text-neutral-200">显示背景图</span>
            </label>
            <label className="block text-sm">
              <span className="mb-0.5 block text-xs text-neutral-400">压暗程度 {bgDim}%</span>
              <input type="range" min={0} max={80} value={bgDim} onChange={(e) => setBgDim(Number(e.target.value))} className="w-full" />
            </label>
            <span className="block text-[11px] leading-tight text-neutral-500">上传即生效;显示开关与压暗需点「保存」。</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Record detail — player <-> word-level transcript sync
// ===========================================================================
interface FlatWord {
  gi: number;
  segIdx: number;
  text: string;
  start: number;
  end: number;
}

function RecordDetail({
  id,
  config,
  onBack,
  onChanged,
}: {
  id: string;
  config: GatewayConfig | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [rec, setRec] = useState<RecordFull | null>(null);
  const [err, setErr] = useState("");
  // Per-file transcription options (seeded from the record; user can override then
  // (re)transcribe). `optTouched` tracks whether the user changed anything so we
  // re-seed from the record on load until they do.
  const [optLang, setOptLang] = useState("auto");
  const [optSeg, setOptSeg] = useState(false);
  const [optTr, setOptTr] = useState(false);
  const [optEnh, setOptEnh] = useState(false);
  const [showOpts, setShowOpts] = useState(false);
  // Translation UI is entirely hidden unless the global feature is ON. `available`
  // additionally requires a translate model (needed to actually run 补翻译).
  const showTranslation = !!config?.translate?.enabled;
  const translateAvailable = showTranslation && !!config?.translate?.model;
  const enhanceAvailable = !!config?.enhance?.model;
  const [activeGi, setActiveGi] = useState<number>(-1);   // active WORD (word-level path)
  const [activeTi, setActiveTi] = useState<number>(-1);   // active TRANSLATION word
  const [activeSeg, setActiveSeg] = useState<number>(-1); // active SEGMENT (fallback path)
  const [activeCue, setActiveCue] = useState<number>(-1);  // active subtitle clause (original)
  const [activeTCue, setActiveTCue] = useState<number>(-1); // active subtitle clause (translation)
  const [q, setQ] = useState("");                         // transcript search query
  // Video subtitle overlay (CC): show the CURRENT line over the video (bilingual if
  // a translation exists). Default on, persisted. Feishu-Minutes style.
  const [subs, setSubs] = useState<boolean>(() => localStorage.getItem("amx.subs") !== "0");
  useEffect(() => { localStorage.setItem("amx.subs", subs ? "1" : "0"); }, [subs]);
  // Chinese highlight unit: 词 (word, Feishu-style) or 字 (per-char). English is
  // always word-level. Persisted so the choice sticks across records/sessions.
  const [granularity, setGranularity] = useState<"word" | "char">(
    () => (localStorage.getItem("amx.granularity") === "char" ? "char" : "word"),
  );
  useEffect(() => { localStorage.setItem("amx.granularity", granularity); }, [granularity]);
  // jieba (WASM) gives much better Chinese word boundaries than ICU. Flip this once
  // it's loaded so the 词 grouping re-runs with jieba instead of the ICU fallback.
  const [jiebaReady, setJiebaReady] = useState(jiebaState() === "ok");
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try { setRec(await api.getRecord(id)); } catch (e: any) { setErr(String(e?.message || e)); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Poll while processing.
  useEffect(() => {
    if (!rec || (rec.status !== "processing" && rec.status !== "uploaded")) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [rec, load]);

  // Seed the per-file option controls from the CURRENT GLOBAL settings (so changing
  // 总设置 is reflected here — otherwise the global toggle feels ineffective). You can
  // still tweak this bar per run before clicking 重新转写. Seeded once we have both
  // the record and the config; RecordDetail remounts when returning from 设置, so a
  // fresh global value is picked up automatically.
  const seededId = useRef<string>("");
  useEffect(() => {
    if (!rec || !config) return;
    if (seededId.current === rec.id) return;
    seededId.current = rec.id;
    setOptLang(config.language || "auto");
    setOptSeg(!!config.segmentedStt);
    setOptTr(!!config.translate?.enabled);
    setOptEnh(!!config.enhance?.enabled);
  }, [rec, config]);

  // Normalize word times so EVERY word is clickable/highlightable even on older
  // records: clamp into the segment's [start,end] and make starts strictly
  // increasing (the aligner often gives leading chars the same 0 start with zero
  // duration, which makes them impossible to hit/highlight). Mirrors the server's
  // finalizeWords; safe no-op when times are already good.
  const segments: Segment[] = useMemo(
    () => {
      const useJieba = granularity === "word" && jiebaReady && jiebaState() === "ok";
      const cut = useJieba
        ? (t: string) => jiebaCut(t).map((k) => ({ segment: k.word, index: k.start, isWordLike: WORDLIKE_RE.test(k.word) }))
        : intlCut;
      return (rec?.result?.segments || []).map((s) => {
        const fixed = fixWordTimes(s.words || [], s.start, s.end);
        const words = granularity === "word" ? groupWordsToCi(fixed, cut) : fixed;
        let twords = s.twords;
        if (twords && twords.length) {
          const tf = fixWordTimes(twords, s.start, s.end);
          twords = granularity === "word" ? groupWordsToCi(tf, cut) : tf;
        }
        return { ...s, words, twords };
      });
    },
    [rec, granularity, jiebaReady],
  );
  // Whether this transcript has any Chinese (only then is the 字/词 toggle useful).
  const hasCJK = useMemo(
    () => (rec?.result?.segments || []).some(
      (s) => /[\u4E00-\u9FFF\u3400-\u4DBF]/.test((s.text || "") + (s.translation || "")),
    ),
    [rec],
  );
  // Load jieba lazily the first time we actually need Chinese word grouping.
  useEffect(() => {
    if (granularity === "word" && hasCJK && jiebaState() !== "ok" && jiebaState() !== "err") {
      ensureJieba().then(() => setJiebaReady(jiebaState() === "ok"));
    }
  }, [granularity, hasCJK]);
  const flat: FlatWord[] = useMemo(() => {
    const out: FlatWord[] = [];
    let gi = 0;
    segments.forEach((s, si) => {
      (s.words || []).forEach((w) => out.push({ gi: gi++, segIdx: si, text: w.text, start: w.start, end: w.end }));
    });
    return out;
  }, [segments]);
  // Starting global word index of each segment, so per-word `gi` is O(1) in render.
  const segBase: number[] = useMemo(() => {
    const base: number[] = [];
    let acc = 0;
    for (const s of segments) { base.push(acc); acc += (s.words?.length || 0); }
    return base;
  }, [segments]);

  // Parallel machinery for the TRANSLATION words (twords): its own flat list, base
  // indices and active pointer, so translated lines highlight/seek independently of
  // the original (their pseudo timings live in the same segment window).
  const tflat: FlatWord[] = useMemo(() => {
    const out: FlatWord[] = [];
    let ti = 0;
    segments.forEach((s, si) => {
      (s.twords || []).forEach((w) => out.push({ gi: ti++, segIdx: si, text: w.text, start: w.start, end: w.end }));
    });
    return out;
  }, [segments]);
  const segBaseT: number[] = useMemo(() => {
    const base: number[] = [];
    let acc = 0;
    for (const s of segments) { base.push(acc); acc += (s.twords?.length || 0); }
    return base;
  }, [segments]);
  const hasTranslation = tflat.length > 0;

  const hasWords = flat.length > 0;

  // Short subtitle clauses (Feishu-style): re-split the word streams on clause
  // punctuation so the overlay shows ONE clause at a time, not a whole paragraph.
  const cues = useMemo(() => buildCues(flat), [flat]);
  const tcues = useMemo(() => buildCues(tflat), [tflat]);
  const cueStartsRef = useRef<number[]>([]);
  const tcueStartsRef = useRef<number[]>([]);
  const cuesRef = useRef<SubCue[]>([]);
  const tcuesRef = useRef<SubCue[]>([]);
  useEffect(() => {
    cuesRef.current = cues; cueStartsRef.current = cues.map((c) => c.start);
    tcuesRef.current = tcues; tcueStartsRef.current = tcues.map((c) => c.start);
  }, [cues, tcues]);

  // Binary search: last item whose start <= t. Shared by word- and segment-level.
  function lastAtOrBefore(starts: number[], t: number): number {
    let lo = 0, hi = starts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  const wordStarts = useMemo(() => flat.map((w) => w.start), [flat]);
  const twordStarts = useMemo(() => tflat.map((w) => w.start), [tflat]);
  const segStarts = useMemo(() => segments.map((s) => +s.start), [segments]);
  // Latest arrays kept in refs so the rAF loop reads fresh values without needing
  // to restart whenever they change.
  const wordStartsRef = useRef(wordStarts);
  const twordStartsRef = useRef(twordStarts);
  const segStartsRef = useRef(segStarts);
  useEffect(() => { wordStartsRef.current = wordStarts; twordStartsRef.current = twordStarts; segStartsRef.current = segStarts; }, [wordStarts, twordStarts, segStarts]);

  const syncToTime = useCallback((t: number) => {
    const gi = lastAtOrBefore(wordStartsRef.current, t);
    setActiveGi((prev) => (prev === gi ? prev : gi));
    const ti = lastAtOrBefore(twordStartsRef.current, t);
    setActiveTi((prev) => (prev === ti ? prev : ti));
    const sg = lastAtOrBefore(segStartsRef.current, t);
    setActiveSeg((prev) => (prev === sg ? prev : sg));
    // Subtitle clauses: hide during long gaps (silence) so a clause doesn't linger.
    const pick = (starts: number[], arr: SubCue[]) => {
      const i = lastAtOrBefore(starts, t);
      if (i < 0) return -1;
      const c = arr[i];
      return c && t > c.end + 1.2 ? -1 : i;
    };
    const ci = pick(cueStartsRef.current, cuesRef.current);
    setActiveCue((prev) => (prev === ci ? prev : ci));
    const tci = pick(tcueStartsRef.current, tcuesRef.current);
    setActiveTCue((prev) => (prev === tci ? prev : tci));
  }, []);

  const onTimeUpdate = useCallback(() => {
    const m = mediaRef.current;
    if (m) syncToTime(m.currentTime);
  }, [syncToTime]);

  // While playing, refresh the highlight every animation frame (~16ms) rather than
  // relying on the media element's 'timeupdate' event, which only fires ~4x/sec
  // (~250ms). That coarse sampling skips any word whose display window is shorter
  // than the gap between two events (you'd see the highlight jump over words even
  // though clicking them still worked). At 60fps every word — even short ones —
  // gets sampled while it is current, so nothing is skipped.
  const rafRef = useRef<number | null>(null);
  const rafTick = useCallback(() => {
    const m = mediaRef.current;
    if (m) syncToTime(m.currentTime);
    rafRef.current = requestAnimationFrame(rafTick);
  }, [syncToTime]);
  const startRaf = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(rafTick);
  }, [rafTick]);
  const stopRaf = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const m = mediaRef.current;
    if (m) syncToTime(m.currentTime); // settle on the exact word at the stop point
  }, [syncToTime]);
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  // Which segment is highlighted right now (word path derives it from the word).
  const activeSegIdx = hasWords
    ? (activeGi >= 0 && flat[activeGi] ? flat[activeGi].segIdx : -1)
    : activeSeg;

  // Current subtitle clause(s) for the video overlay — one short clause at a time.
  const subCueText = activeCue >= 0 ? cues[activeCue]?.text || "" : "";
  const subTCueText = activeTCue >= 0 ? tcues[activeTCue]?.text || "" : "";

  // Auto-scroll the active word (or, without word times, the active segment).
  useEffect(() => {
    const sel = hasWords
      ? (activeGi >= 0 ? `[data-gi="${activeGi}"]` : null)
      : (activeSeg >= 0 ? `[data-seg="${activeSeg}"]` : null);
    if (!sel) return;
    const el = scrollRef.current?.querySelector(sel) as HTMLElement | null;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeGi, activeSeg, hasWords]);

  function seekTo(t: number) {
    const m = mediaRef.current;
    if (!m) return;
    // Only move the playhead — never change play/pause state (playing keeps
    // playing, paused keeps paused).
    m.currentTime = Math.max(0, t);
  }
  // Jump ±N seconds from the current playhead (Feishu-style -15s / +15s).
  function skip(delta: number) {
    const m = mediaRef.current;
    if (!m) return;
    const dur = Number.isFinite(m.duration) ? m.duration : Infinity;
    m.currentTime = Math.min(Math.max(0, m.currentTime + delta), dur);
    syncToTime(m.currentTime);
  }
  const [coverOpen, setCoverOpen] = useState(false);

  async function doTranscribe() {
    try {
      await api.transcribeRecord(id, { language: optLang, segmentedStt: optSeg, translate: optTr, enhance: optEnh });
      setShowOpts(false);
      await load(); onChanged();
    } catch (e: any) { setErr(String(e?.message || e)); }
  }
  async function doTranslate() {
    try { await api.translateRecord(id); await load(); onChanged(); }
    catch (e: any) { setErr(String(e?.message || e)); }
  }
  async function doCancel() {
    try { await api.cancelRecord(id); await load(); onChanged(); }
    catch (e: any) { setErr(String(e?.message || e)); }
  }
  async function doDelete() {
    if (!confirm("删除这条记录?")) return;
    try { await api.deleteRecord(id); onChanged(); onBack(); }
    catch (e: any) { setErr(String(e?.message || e)); }
  }

  if (!rec) {
    return (
      <div className="p-6 text-neutral-400">{err ? <span className="text-red-400">{err}</span> : "加载中…"}</div>
    );
  }

  const mediaSrc = `/api/records/${id}/media`;

  const query = q.trim().toLowerCase();
  // A line matches if the query appears in the original OR the translation, so
  // search covers both. Count total occurrences (not lines) — Feishu-style.
  const countOcc = (s: string) => {
    if (!query || !s) return 0;
    const hay = s.toLowerCase();
    let n = 0, from = 0, i: number;
    while ((i = hay.indexOf(query, from)) >= 0) { n++; from = i + query.length; }
    return n;
  };
  const lineMatches = (s: Segment) => query && (countOcc(s.text || "") > 0 || countOcc(s.translation || "") > 0);
  const matchCount = query
    ? segments.reduce((n, s) => n + countOcc(s.text || "") + countOcc(s.translation || ""), 0)
    : 0;

  // Search box over the transcript (Feishu-Minutes style). Filters the list to
  // matching lines and reports a hit count.
  const searchBox = (
    <div className="relative">
      <input
        className="input pl-8"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索文字记录…"
      />
      <svg className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
      </svg>
      {query && (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-neutral-500 hover:text-neutral-300"
          onClick={() => setQ("")}
        >
          {matchCount} 条 · 清除
        </button>
      )}
    </div>
  );

  // 字/词 segmented control (only meaningful for Chinese transcripts).
  const granularityToggle = hasCJK ? (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-neutral-700 text-xs" title="中文高亮以词或以字为单位">
      <button
        className={`px-2 py-1 ${granularity === "word" ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
        onClick={() => setGranularity("word")}
      >
        词
      </button>
      <button
        className={`px-2 py-1 ${granularity === "char" ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
        onClick={() => setGranularity("char")}
      >
        字
      </button>
    </div>
  ) : null;

  // Render one line of clickable, per-unit spans (original OR translation). CJK
  // units carry NO horizontal padding so 字/词 both pack tightly like normal
  // Chinese; English keeps its real inter-word spaces. Search hits are painted in
  // a distinct amber (different from the emerald/sky playback highlight) and can
  // span word boundaries (see matchLine).
  const searchHl = "rounded-[3px] bg-amber-400/60 text-amber-950";
  const renderUnits = (
    words: Word[],
    base: number,
    activeIdx: number,
    dataKey: "data-gi" | "data-ti",
    activeCls: string,
  ) => {
    const m = query ? matchLine(words, query) : null;
    return words.map((w, wi) => {
      const gi = base + wi;
      const active = gi === activeIdx;
      const sp = wi > 0 && needsSpaceBefore(words[wi - 1], w);
      const spHit = m ? m.spaceMatched[wi] : false;
      const mask = m ? m.wordMask[wi] : null;
      const hasHit = mask ? mask.some(Boolean) : false;
      return (
        <span key={wi}>
          {sp ? (spHit ? <span className={searchHl}> </span> : " ") : ""}
          <span
            {...{ [dataKey]: gi }}
            onClick={() => seekTo(w.start)}
            className={`cursor-pointer rounded-[3px] transition-colors ${active ? activeCls : "hover:bg-neutral-700/60"}`}
          >
            {hasHit
              ? maskRuns(w.text || "", mask!).map((r, ri) =>
                  r.hit ? <span key={ri} className={searchHl}>{r.text}</span> : <span key={ri}>{r.text}</span>,
                )
              : (w.text || "")}
          </span>
        </span>
      );
    });
  };

  // Highlight search hits in a plain (non-timed) string — used by the segment-level
  // fallbacks that have no per-word timings.
  const markPlain = (text: string) => {
    if (!query || !text) return text;
    const mask = new Array(text.length).fill(false);
    const hay = text.toLowerCase();
    let from = 0, i: number;
    while ((i = hay.indexOf(query, from)) >= 0) { for (let p = i; p < i + query.length; p++) mask[p] = true; from = i + query.length; }
    return maskRuns(text, mask).map((r, ri) => (r.hit ? <span key={ri} className={searchHl}>{r.text}</span> : <span key={ri}>{r.text}</span>));
  };

  // The transcript list is shared by both layouts (video: right column; audio:
  // full-width main body). The scroll container that wraps it differs per layout.
  const transcriptList = (
    <>
      {segments.length === 0 && <p className="text-sm text-neutral-600">(无转写内容)</p>}
      {query && matchCount === 0 && <p className="text-sm text-neutral-600">未找到「{q.trim()}」</p>}
      <div className="space-y-0.5">
        {segments.map((seg, si) => {
          if (query && !lineMatches(seg)) return null;
          return (
          <div key={si} data-seg={si} className={`rounded-md px-2 py-1 transition-colors ${si === activeSegIdx ? "bg-neutral-800/40" : ""}`}>
            <div className="mb-0.5 flex items-center gap-1.5">
              <SpeakerChip spk={seg.speaker} />
              <button className="font-mono text-[11px] tabular-nums text-neutral-500 hover:text-neutral-300" onClick={() => seekTo(seg.start)}>
                {fmtTC(seg.start)}
              </button>
            </div>
            <p className="break-words text-[14px] leading-snug text-neutral-200">
              {seg.words && seg.words.length
                ? renderUnits(seg.words, segBase[si], activeGi, "data-gi", "bg-emerald-500/70 text-white")
                : (
                  // No word-level timings (align returned nothing): fall back to
                  // segment-level — click the whole line to seek, highlight the
                  // active segment during playback.
                  <span
                    onClick={() => seekTo(seg.start)}
                    className={`cursor-pointer rounded px-0.5 transition-colors ${
                      si === activeSegIdx ? "bg-emerald-500/25 text-emerald-100" : "hover:bg-neutral-700/50"
                    }`}
                  >
                    {markPlain(seg.text)}
                  </span>
                )}
            </p>
            {showTranslation && seg.translation && (
              <p className="mt-0.5 break-words border-l-2 border-sky-700/50 pl-2 text-[13px] leading-snug text-sky-200/90">
                {seg.twords && seg.twords.length
                  ? renderUnits(seg.twords, segBaseT[si], activeTi, "data-ti", "bg-sky-500/70 text-white")
                  : (
                    <span onClick={() => seekTo(seg.start)} className="cursor-pointer">
                      {markPlain(seg.translation)}
                    </span>
                  )}
              </p>
            )}
          </div>
          );
        })}
      </div>
    </>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
        <button className="btn-ghost" onClick={onBack}>← 返回</button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{rec.title}</div>
          <div className="text-xs text-neutral-500">
            {fmtDur(rec.durationSec)} · {statusText(rec)}
            {rec.status === "done"
              ? ` · ${rec.result?.speakers?.length ?? 0} 位说话人 · ${rec.result?.segments?.length ?? 0} 段`
              : ""}
          </div>
        </div>
        {rec.status === "done" && <ExportButtons rec={rec} />}
        {(rec.status === "done" || rec.status === "uploaded" || rec.status === "error") && (
          <button
            className={`btn-ghost ${showOpts ? "text-emerald-300" : ""}`}
            onClick={() => setShowOpts((v) => !v)}
            title="选择该文件的转写语言 / 分段 / 是否翻译"
          >
            转写设置
          </button>
        )}
        {rec.status === "done" && translateAvailable && (
          <button className="btn-ghost" onClick={doTranslate} title="仅对现有转写补一遍翻译(不重跑 STT)">
            {rec.translated ? "重新翻译" : "补翻译"}
          </button>
        )}
        {rec.status === "done" && (
          <button className="btn-ghost" onClick={doTranscribe} title="用下方「转写设置」重新跑一遍转写">重新转写</button>
        )}
        {(rec.status === "uploaded" || rec.status === "error") && (
          <button className="btn-primary" onClick={doTranscribe}>AI 转录</button>
        )}
        <button className="btn-ghost" onClick={doDelete}>删除</button>
      </div>

      {showOpts && (
        <div className="flex flex-wrap items-center gap-4 border-b border-neutral-800 bg-neutral-900/50 px-4 py-2.5 text-sm">
          <label className="flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-neutral-400">语言</span>
            <select className="input !w-auto py-1" value={optLang} onChange={(e) => setOptLang(e.target.value)}>
              <option value="auto">自动识别</option>
              <option value="zh">中文 zh</option>
              <option value="en">English en</option>
              <option value="ja">日本語 ja</option>
              <option value="ko">한국어 ko</option>
              <option value="yue">粤语 yue</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={optSeg} onChange={(e) => setOptSeg(e.target.checked)} />
            <span className="text-neutral-300">分段转写</span>
          </label>
          {showTranslation && (
            <label className="flex items-center gap-2" title={translateAvailable ? "" : "请先在设置中选择翻译模型"}>
              <input type="checkbox" className="h-4 w-4" checked={optTr} disabled={!translateAvailable} onChange={(e) => setOptTr(e.target.checked)} />
              <span className={translateAvailable ? "text-neutral-300" : "text-neutral-600"}>转写时翻译</span>
            </label>
          )}
          <label className="flex items-center gap-2" title={enhanceAvailable ? "背景音乐较明显的文件不建议开启" : "请先在设置中选择增强模型"}>
            <input type="checkbox" className="h-4 w-4" checked={optEnh} disabled={!enhanceAvailable} onChange={(e) => setOptEnh(e.target.checked)} />
            <span className={enhanceAvailable ? "text-neutral-300" : "text-neutral-600"}>降噪增强</span>
          </label>
          <span className="text-xs text-neutral-500">改动后点「{rec.status === "done" ? "重新转写" : "AI 转录"}」生效</span>
        </div>
      )}

      {err && <p className="mx-4 mt-3 rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</p>}

      {rec.status !== "done" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          {rec.status === "processing" ? (
            <ProcessingView rec={rec} onStop={doCancel} />
          ) : rec.status === "error" ? (
            <div className="w-full max-w-md space-y-3">
              <div className="text-red-400">{rec.error || "失败"}</div>
              {rec.notices && rec.notices.length > 0 && (
                <div className="text-left">
                  <div className="mb-1.5 text-xs font-medium text-neutral-400">处理记录</div>
                  <NoticeList notices={rec.notices} />
                </div>
              )}
            </div>
          ) : (
            <div className="text-neutral-400">尚未转录,点击右上角「AI 转录」。</div>
          )}
        </div>
      ) : rec.kind === "video" ? (
        // Video (Feishu-Minutes layout): a large player on the left that stays put,
        // compact metadata below it; the transcript scrolls on the right.
        <div className="flex flex-1 overflow-hidden p-3">
          <ResizableSplit
            storageKey="amx.split.video"
            defaultPx={720}
            minPx={360}
            left={
              <div className="flex h-full flex-col gap-2 overflow-hidden pr-3">
                <div className="relative shrink-0">
                  <video ref={(el) => { mediaRef.current = el; }} src={mediaSrc} controls className="max-h-[52vh] w-full rounded-lg bg-black object-contain" onTimeUpdate={onTimeUpdate} onPlay={startRaf} onPause={stopRaf} onEnded={stopRaf} onSeeking={onTimeUpdate} />
                  {subs && (subCueText || (showTranslation && subTCueText)) && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-12 flex flex-col items-center gap-1 px-4 text-center">
                      {subCueText && (
                        <span className="max-w-[90%] rounded bg-black/65 px-2 py-0.5 text-[17px] font-medium leading-snug text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]">
                          {subCueText}
                        </span>
                      )}
                      {showTranslation && subTCueText && (
                        <span className="max-w-[90%] rounded bg-black/55 px-2 py-0.5 text-[14px] leading-snug text-sky-100 [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]">
                          {subTCueText}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <PlayerBar kind="video" subs={subs} setSubs={setSubs} skip={skip} onSetCover={() => setCoverOpen(true)} />
                <MetaTabs rec={rec} defaultTab="spk" />
              </div>
            }
            right={
              <div className="flex h-full flex-col overflow-hidden pl-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-200">文字记录</span>
                  <div className="ml-auto flex items-center gap-2">
                    {granularityToggle}
                    <div className="w-44 sm:w-56">{searchBox}</div>
                  </div>
                </div>
                <div ref={scrollRef} className="flex-1 overflow-y-auto pr-1">
                  {transcriptList}
                </div>
              </div>
            }
          />
        </div>
      ) : (
        // Audio (Feishu-Minutes layout): left sidebar (文件信息 / 发言人) + right
        // transcript (文字记录 with search) as the main body + full-width player bar.
        <div className="flex flex-1 flex-col overflow-hidden">
          <ResizableSplit
            storageKey="amx.split.audio"
            defaultPx={260}
            minPx={200}
            maxFrac={0.5}
            left={
              <div className="flex h-full flex-col overflow-hidden border-r border-neutral-800">
                <MetaTabs rec={rec} defaultTab="info" />
              </div>
            }
            right={
              <div className="flex h-full min-w-0 flex-col">
                <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2">
                  <span className="text-sm font-medium text-neutral-200">文字记录</span>
                  <div className="ml-auto flex items-center gap-2">
                    {granularityToggle}
                    <div className="w-48 sm:w-64">{searchBox}</div>
                  </div>
                </div>
                <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-3">
                  <div className="mx-auto w-full max-w-5xl">{transcriptList}</div>
                </div>
              </div>
            }
          />
          <div className="border-t border-neutral-800 bg-neutral-900/80 px-4 py-3">
            <div className="mx-auto flex max-w-5xl items-center gap-2">
              <button onClick={() => skip(-15)} className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium bg-neutral-700/60 text-neutral-300 hover:brightness-110" title="后退 15 秒">⏪ 15s</button>
              <button onClick={() => skip(15)} className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium bg-neutral-700/60 text-neutral-300 hover:brightness-110" title="前进 15 秒">15s ⏩</button>
              <audio ref={(el) => { mediaRef.current = el; }} src={mediaSrc} controls className="min-w-0 flex-1" onTimeUpdate={onTimeUpdate} onPlay={startRaf} onPause={stopRaf} onEnded={stopRaf} onSeeking={onTimeUpdate} />
              <button onClick={() => setCoverOpen(true)} className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium bg-neutral-700/60 text-neutral-300 hover:brightness-110" title="设置封面">🖼 设置封面</button>
            </div>
          </div>
        </div>
      )}
      {coverOpen && rec && (
        <CoverModal
          rec={rec}
          mediaSrc={mediaSrc}
          onClose={() => setCoverOpen(false)}
          onSaved={() => { setCoverOpen(false); load(); onChanged(); }}
        />
      )}
    </div>
  );
}

// Feishu-style control strip that sits just under the native player: -15s / +15s,
// (video only) the CC subtitle toggle, and 设置封面. Native <video>/<audio>
// controls can't host custom buttons, so these live in a row right below.
function PlayerBar({
  kind, subs, setSubs, skip, onSetCover,
}: {
  kind: "audio" | "video";
  subs: boolean;
  setSubs: (fn: (v: boolean) => boolean) => void;
  skip: (delta: number) => void;
  onSetCover: () => void;
}) {
  const btn = "flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium bg-neutral-700/60 text-neutral-300 hover:brightness-110";
  return (
    <div className="mt-1.5 flex shrink-0 flex-nowrap items-center justify-between gap-2 px-1">
      <div className="flex items-center gap-2">
        <button onClick={() => skip(-15)} className={btn} title="后退 15 秒">⏪ 15s</button>
        <button onClick={() => skip(15)} className={btn} title="前进 15 秒">15s ⏩</button>
        {kind === "video" && (
          <button
            onClick={() => setSubs((v) => !v)}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${subs ? "bg-emerald-600/80 text-white" : "bg-neutral-700/60 text-neutral-300"} hover:brightness-110`}
            title={subs ? "关闭字幕" : "开启字幕"}
          >
            <span className="rounded-sm border border-current px-1 text-[10px] leading-tight">CC</span>
            字幕 {subs ? "开" : "关"}
          </button>
        )}
      </div>
      <button onClick={onSetCover} className={btn} title="设置封面">🖼 设置封面</button>
    </div>
  );
}

// Draw a video frame (at its current time) to a JPEG data URL, capped to maxW wide.
function frameToDataUrl(v: HTMLVideoElement, maxW = 1280): string {
  const vw = v.videoWidth || 1280, vh = v.videoHeight || 720;
  const scale = Math.min(1, maxW / vw);
  const cw = Math.max(1, Math.round(vw * scale)), ch = Math.max(1, Math.round(vh * scale));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(v, 0, 0, cw, ch);
  return c.toDataURL("image/jpeg", 0.82);
}
function seekAndCapture(v: HTMLVideoElement, t: number, maxW = 1280): Promise<string> {
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener("seeked", done); resolve(frameToDataUrl(v, maxW)); };
    v.addEventListener("seeked", done, { once: true });
    try { v.currentTime = t; } catch { resolve(frameToDataUrl(v, maxW)); }
  });
}
function CoverModal({
  rec, mediaSrc, onClose, onSaved,
}: {
  rec: RecordFull;
  mediaSrc: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isVideo = rec.kind === "video";
  const [tab, setTab] = useState<"rec" | "pick" | "upload">(isVideo ? "rec" : "upload");
  const [recs, setRecs] = useState<string[]>([]);       // system-recommended thumbnails (dataUrls)
  const [sel, setSel] = useState<string | null>(null);  // chosen dataUrl (recommend/pick/preset)
  const [file, setFile] = useState<File | null>(null);  // chosen upload file
  const [filePrev, setFilePrev] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const capRef = useRef<HTMLVideoElement | null>(null); // hidden video for recommend capture
  const pickRef = useRef<HTMLVideoElement | null>(null); // visible scrubber

  // System-recommended frames: for video, capture a handful evenly spaced frames;
  // for audio, offer preset gradient tiles (no frames to sample).
  useEffect(() => {
    if (!isVideo) return; // audio has no frames — only 上传/取消
    let alive = true;
    const v = document.createElement("video");
    v.src = mediaSrc; v.muted = true; (v as any).playsInline = true; v.preload = "auto";
    capRef.current = v;
    const run = async () => {
      await new Promise<void>((res) => {
        if (v.readyState >= 1) return res();
        v.addEventListener("loadedmetadata", () => res(), { once: true });
      });
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      if (!dur) return;
      const fracs = [0.05, 0.2, 0.4, 0.6, 0.8, 0.95];
      const out: string[] = [];
      for (const f of fracs) {
        if (!alive) return;
        const url = await seekAndCapture(v, dur * f, 960);
        if (url) out.push(url);
        if (alive) setRecs([...out]);
      }
    };
    run().catch(() => {});
    return () => { alive = false; try { v.src = ""; } catch { /* ignore */ } };
  }, [isVideo, mediaSrc]);

  const chosen = tab === "upload" ? (file ? filePrev : "") : sel || "";

  async function save() {
    setBusy(true); setErr("");
    try {
      if (tab === "upload") {
        if (!file) throw new Error("请先选择图片");
        await api.uploadCover(rec.id, file);
      } else {
        if (!sel) throw new Error("请先选择一张封面");
        await api.setCoverDataUrl(rec.id, sel);
      }
      onSaved();
    } catch (e: any) { setErr(String(e?.message || e)); setBusy(false); }
  }
  async function clear() {
    setBusy(true); setErr("");
    try { await api.deleteCover(rec.id); onSaved(); }
    catch (e: any) { setErr(String(e?.message || e)); setBusy(false); }
  }

  const tabBtn = (id: "rec" | "pick" | "upload", label: string) => (
    <button
      onClick={() => setTab(id)}
      className={`border-b-2 px-3 py-2 text-sm ${tab === id ? "border-emerald-500 text-emerald-400" : "border-transparent text-neutral-400 hover:text-neutral-200"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border border-neutral-700 bg-neutral-900 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <div className="text-base font-medium text-neutral-100">设置封面</div>
          <button className="rounded px-2 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>✕</button>
        </div>

        <div className="flex gap-1 border-b border-neutral-800 px-2">
          {isVideo && tabBtn("rec", "系统推荐")}
          {isVideo && tabBtn("pick", "从视频中选")}
          {tabBtn("upload", "上传封面")}
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4">
          {tab === "rec" && (
            <div className="grid grid-cols-3 gap-3">
              {recs.length === 0 && <div className="col-span-3 py-8 text-center text-sm text-neutral-500">正在生成推荐封面…</div>}
              {recs.map((u, i) => (
                <button
                  key={i}
                  onClick={() => setSel(u)}
                  className={`overflow-hidden rounded-lg border-2 ${sel === u ? "border-emerald-500" : "border-transparent hover:border-neutral-600"}`}
                >
                  <img src={u} className="aspect-video w-full object-cover" />
                </button>
              ))}
            </div>
          )}

          {tab === "pick" && isVideo && (
            <div className="flex flex-col gap-3">
              <video ref={pickRef} src={mediaSrc} controls className="max-h-[42vh] w-full rounded-lg bg-black object-contain" />
              <div className="flex items-center gap-2">
                <button
                  className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
                  onClick={() => { const v = pickRef.current; if (v) setSel(frameToDataUrl(v, 1280)); }}
                >
                  截取当前画面
                </button>
                <span className="text-xs text-neutral-500">拖动播放条到想要的画面,再点「截取当前画面」。</span>
              </div>
              {sel && tab === "pick" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-400">已截取:</span>
                  <img src={sel} className="h-16 rounded border border-emerald-500 object-cover" />
                </div>
              )}
            </div>
          )}

          {tab === "upload" && (
            <div className="flex flex-col items-start gap-3">
              <label className="cursor-pointer rounded bg-neutral-700 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-600">
                选择图片文件
                <input
                  type="file" accept="image/*" className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    setFile(f);
                    if (filePrev) URL.revokeObjectURL(filePrev);
                    setFilePrev(f ? URL.createObjectURL(f) : "");
                  }}
                />
              </label>
              {filePrev && <img src={filePrev} className="max-h-[42vh] rounded-lg object-contain" />}
            </div>
          )}

          {err && <div className="mt-3 rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</div>}
        </div>

        <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-3">
          <button
            className="rounded px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-red-400 disabled:opacity-40"
            onClick={clear}
            disabled={busy || !rec.hasCover}
            title={rec.hasCover ? "移除封面,恢复默认" : "当前没有自定义封面"}
          >
            取消封面(恢复默认)
          </button>
          <div className="flex items-center gap-2">
            <button className="rounded px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800" onClick={onClose} disabled={busy}>取消</button>
            <button
              className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40"
              onClick={save}
              disabled={busy || !chosen}
            >
              {busy ? "保存中…" : "确定"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- export (TXT / SRT / JSON) ----
function download(name: string, text: string, type = "text/plain") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(mm, 3)}`;
}
// "文件信息" 元数据行（复用于视频左栏卡片 + 音频左侧「更多」标签）。
function FileInfoRows({ rec }: { rec: RecordFull }) {
  const rows: [string, string][] = [
    ["类型", rec.kind === "video" ? "视频" : "音频"],
    ["时长", fmtDur(rec.durationSec) || "—"],
    ["创建时间", rec.createdAt ? new Date(rec.createdAt).toLocaleString() : "—"],
    ["语言", rec.result?.language || "—"],
    ["说话人", `${rec.result?.speakers?.length ?? 0} 位`],
    ["段落", `${rec.result?.segments?.length ?? 0} 段`],
    ["原文件", rec.originalName || "—"],
  ];
  return (
    <dl className="space-y-1 text-xs leading-snug">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <dt className="w-14 shrink-0 text-neutral-500">{k}</dt>
          <dd className="min-w-0 flex-1 break-words text-neutral-300">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// Feishu-style tabbed metadata panel (说话人 / 文件信息 / 处理记录) used in both the
// audio sidebar and the video left column, so only the transcript needs to scroll —
// the panel itself is compact and its active tab scrolls internally if needed.
function MetaTabs({ rec, defaultTab = "info" }: { rec: RecordFull; defaultTab?: "spk" | "info" | "log" }) {
  const [tab, setTab] = useState<"spk" | "info" | "log">(defaultTab);
  const spkN = rec.result?.speakers?.length ?? 0;
  const logN = rec.notices?.length ?? 0;
  const btn = (id: "spk" | "info" | "log", label: string) => (
    <button
      className={`rounded px-2 py-1 ${tab === id ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 border-b border-neutral-800 px-1 py-1.5 text-xs">
        {btn("spk", `说话人 (${spkN})`)}
        {btn("info", "文件信息")}
        {btn("log", `处理记录${logN ? ` (${logN})` : ""}`)}
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 py-2">
        {tab === "spk" ? (
          <SpeakerStats rec={rec} />
        ) : tab === "info" ? (
          <FileInfoRows rec={rec} />
        ) : logN ? (
          <NoticeList notices={rec.notices} />
        ) : (
          <p className="text-xs text-neutral-600">(暂无处理记录)</p>
        )}
      </div>
    </div>
  );
}
// 「发言人」统计（妙记左栏对应）：每位说话人的发言占比（时长）+ 段数。
function SpeakerStats({ rec }: { rec: RecordFull }) {
  const segs = rec.result?.segments || [];
  const total = segs.reduce((n, s) => n + Math.max(0, s.end - s.start), 0) || 1;
  const map = new Map<string, { dur: number; count: number }>();
  for (const s of segs) {
    const d = map.get(s.speaker) || { dur: 0, count: 0 };
    d.dur += Math.max(0, s.end - s.start);
    d.count++;
    map.set(s.speaker, d);
  }
  const rows = [...map.entries()].sort((a, b) => b[1].dur - a[1].dur);
  if (!rows.length) return <p className="text-xs text-neutral-600">(暂无说话人)</p>;
  return (
    <div className="space-y-2">
      {rows.map(([spk, st]) => {
        const pct = Math.round((100 * st.dur) / total);
        return (
          <div key={spk} className="text-xs">
            <div className="mb-0.5 flex items-center gap-2">
              <SpeakerChip spk={spk} />
              <span className="ml-auto tabular-nums text-neutral-400">{pct}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
              <div className="h-full rounded" style={{ width: `${pct}%`, background: spkColor(spk) }} />
            </div>
            <div className="mt-0.5 text-neutral-500">{st.count} 段 · {fmtDur(st.dur)}</div>
          </div>
        );
      })}
    </div>
  );
}
function ExportButtons({ rec }: { rec: RecordFull }) {
  const segs = rec.result?.segments || [];
  const txt = () => download(`${rec.title}.txt`, segs.map((s) => `[${fmtTC(s.start)}] ${spkLabel(s.speaker)}: ${s.text}`).join("\n"));
  const srt = () => download(`${rec.title}.srt`, segs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${spkLabel(s.speaker)}: ${s.text}`).join("\n\n"), "application/x-subrip");
  const json = () => download(`${rec.title}.json`, JSON.stringify(rec.result, null, 2), "application/json");
  return (
    <div className="flex gap-1">
      <button className="btn-ghost" onClick={txt}>TXT</button>
      <button className="btn-ghost" onClick={srt}>SRT</button>
      <button className="btn-ghost" onClick={json}>JSON</button>
    </div>
  );
}

// A library-card thumbnail: the custom cover if set, else a default kind-based
// tile (video film glyph / audio mic glyph), with a duration badge.
function CoverThumb({ r, className }: { r: RecordSummary; className?: string }) {
  const url = r.hasCover ? `/api/records/${r.id}/cover?v=${encodeURIComponent(r.coverVer || "")}` : "";
  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-md bg-gradient-to-br ${
        r.kind === "video" ? "from-neutral-700 to-neutral-800" : "from-indigo-600/50 to-sky-600/40"
      } ${className || ""}`}
    >
      {url ? (
        <img src={url} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center opacity-80">
          <span className="text-[1.6em]">{r.kind === "video" ? "🎬" : "🎙"}</span>
        </div>
      )}
      {r.durationSec != null && (
        <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[10px] leading-tight text-white">
          {fmtDur(r.durationSec)}
        </span>
      )}
    </div>
  );
}

// ===========================================================================
// Library + shell
// ===========================================================================
export default function App() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  // UI preferences (persisted locally, per browser).
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("amx.theme") === "light" ? "light" : "dark"),
  );
  const [cardView, setCardView] = useState<"grid" | "list">(
    () => (localStorage.getItem("amx.cardview") === "list" ? "list" : "grid"),
  );
  // Grid density: how many cards per row (大图3 / 中图4 / 小图5).
  const [gridCols, setGridCols] = useState<3 | 4 | 5>(() => {
    const n = parseInt(localStorage.getItem("amx.gridcols") || "3", 10);
    return (n === 4 || n === 5 ? n : 3) as 3 | 4 | 5;
  });
  useEffect(() => { localStorage.setItem("amx.gridcols", String(gridCols)); }, [gridCols]);
  // Bumped whenever the background image changes so the <img> URL busts its cache.
  const [bgVer, setBgVer] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem("amx.theme", theme);
  }, [theme]);
  useEffect(() => { localStorage.setItem("amx.cardview", cardView); }, [cardView]);

  const refreshRecords = useCallback(async () => {
    try { setRecords((await api.listRecords()).records); } catch (e: any) { setErr(String(e?.message || e)); }
  }, []);

  const retry = useCallback(async (id: string) => {
    setErr("");
    setBusyIds((s) => new Set(s).add(id));
    try {
      await api.transcribeRecord(id);
      await refreshRecords();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [refreshRecords]);

  const onDelete = useCallback(async (id: string) => {
    if (!confirm("删除这条记录?")) return;
    try { await api.deleteRecord(id); await refreshRecords(); } catch (e: any) { setErr(String(e?.message || e)); }
  }, [refreshRecords]);

  const cancel = useCallback(async (id: string) => {
    setErr("");
    setBusyIds((s) => new Set(s).add(id));
    try {
      await api.cancelRecord(id);
      await refreshRecords();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [refreshRecords]);

  useEffect(() => {
    (async () => {
      try { setConfig(await api.getConfig()); } catch { /* ignore */ }
      refreshRecords();
    })();
  }, [refreshRecords]);

  // Poll the library while anything is processing.
  useEffect(() => {
    const anyBusy = records.some((r) => r.status === "processing");
    if (!anyBusy) return;
    const t = setInterval(refreshRecords, 2000);
    return () => clearInterval(t);
  }, [records, refreshRecords]);

  const ready = !!config?.ready;

  async function onUpload(f: File | null) {
    if (!f) return;
    setErr(""); setUploadPct(0);
    try {
      const rec = await api.uploadFile(f, (p) => setUploadPct(Math.round(p)));
      setUploadPct(null);
      await refreshRecords();
      if (ready && (config?.autoTranscribe ?? true)) { await api.transcribeRecord(rec.id); await refreshRecords(); }
    } catch (e: any) {
      setErr(String(e?.message || e));
      setUploadPct(null);
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  // Status + primary action for a record — shared by the grid and list views.
  const statusActions = (r: RecordSummary) => {
    if (r.status === "processing") {
      return (
        <div className="flex flex-1 items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 truncate text-xs text-amber-400">{statusText(r)}</div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
              <div className="h-full bg-amber-500 transition-[width] duration-500" style={{ width: `${r.progress}%` }} />
            </div>
          </div>
          <button
            className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950/60 hover:text-red-200 disabled:opacity-40"
            disabled={busyIds.has(r.id)}
            title="停止本次转写"
            onClick={(e) => { e.stopPropagation(); cancel(r.id); }}
          >
            {busyIds.has(r.id) ? "…" : "停止"}
          </button>
        </div>
      );
    }
    if (r.status === "done") {
      const warns = (r.notices || []).filter((n) => n.level !== "info").length;
      return (
        <>
          <span className="min-w-0 flex-1 truncate text-xs text-emerald-400">
            已完成 · {r.speakers} 位说话人
            {warns > 0 && (
              <span className="ml-1.5 rounded bg-amber-950/60 px-1 py-0.5 text-[10px] text-amber-300" title="本次处理有提示,点开查看「处理记录」">
                ⚠ {warns} 条提示
              </span>
            )}
          </span>
          <button
            className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            disabled={!ready || busyIds.has(r.id)}
            title={!ready ? "请先在设置里完成网关与模型配置" : "用当前设置(整段/分段)重新跑一遍转写"}
            onClick={(e) => { e.stopPropagation(); retry(r.id); }}
          >
            {busyIds.has(r.id) ? "…" : "重新转写"}
          </button>
        </>
      );
    }
    if (r.status === "error") {
      return (
        <>
          <span className="min-w-0 flex-1 truncate text-xs text-red-400" title={r.error}>失败:{r.error}</span>
          <button
            className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            disabled={!ready || busyIds.has(r.id)}
            title={!ready ? "请先在设置里完成网关与模型配置" : "重新转录"}
            onClick={(e) => { e.stopPropagation(); retry(r.id); }}
          >
            {busyIds.has(r.id) ? "…" : "重试"}
          </button>
        </>
      );
    }
    return (
      <>
        <span className="flex-1 text-xs text-neutral-400">待转录</span>
        <button
          className="shrink-0 rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-40"
          disabled={!ready || busyIds.has(r.id)}
          title={!ready ? "请先在设置里完成网关与模型配置" : "开始转录"}
          onClick={(e) => { e.stopPropagation(); retry(r.id); }}
        >
          {busyIds.has(r.id) ? "…" : "转录"}
        </button>
      </>
    );
  };

  const bg = config?.background;
  return (
    <div className="flex h-screen flex-col">
      {bg?.enabled && (
        <div className="pointer-events-none fixed inset-0 -z-10">
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(/api/background?v=${bgVer})` }}
          />
          <div className="absolute inset-0 bg-black" style={{ opacity: (bg.dim || 0) / 100 }} />
        </div>
      )}
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
        <button
          className="text-lg font-semibold hover:text-emerald-300"
          onClick={() => { setShowSettings(false); setSelectedId(null); }}
          title="返回文件列表"
        >
          🎙 Audio Minutes <span className="text-neutral-500">X Demo</span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn-ghost"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "切换到白天模式" : "切换到夜晚模式"}
          >
            {theme === "dark" ? "🌙" : "☀️"}
          </button>
          <button
            className={`btn-ghost ${showSettings ? "text-emerald-300" : ""}`}
            onClick={() => setShowSettings((v) => !v)}
          >
            设置
          </button>
        </div>
      </header>

      {!ready && !showSettings && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-sm text-red-300">
          无法转录:缺少 {config?.missing?.join("、") || "网关配置"}。请点击右上角「设置」配置网关地址并选择 STT / Align / Diarize 模型。
        </div>
      )}

      {showSettings && config ? (
        <div className="flex-1 overflow-hidden">
          <SettingsPage config={config} onBack={() => setShowSettings(false)} onSaved={(cfg) => { setConfig(cfg); setBgVer((v) => v + 1); }} />
        </div>
      ) : selectedId ? (
        <div className="flex-1 overflow-hidden">
          <RecordDetail id={selectedId} config={config} onBack={() => setSelectedId(null)} onChanged={refreshRecords} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-4 flex items-center gap-3">
            <h2 className="text-base font-semibold">我的内容</h2>
            <div className="ml-auto flex items-center gap-2">
              {uploadPct != null && <span className="text-xs text-neutral-400">上传中 {uploadPct}%</span>}
              <div className="mr-1 inline-flex overflow-hidden rounded-md border border-neutral-700">
                <button
                  className={`px-2 py-1.5 text-sm ${cardView === "grid" ? "bg-neutral-700 text-neutral-100" : "bg-neutral-900 text-neutral-400 hover:bg-neutral-800"}`}
                  title="大图视图"
                  onClick={() => setCardView("grid")}
                >
                  ▦
                </button>
                <button
                  className={`px-2 py-1.5 text-sm ${cardView === "list" ? "bg-neutral-700 text-neutral-100" : "bg-neutral-900 text-neutral-400 hover:bg-neutral-800"}`}
                  title="列表视图"
                  onClick={() => setCardView("list")}
                >
                  ☰
                </button>
              </div>
              {cardView === "grid" && (
                <div className="mr-1 inline-flex overflow-hidden rounded-md border border-neutral-700" title="每行卡片数(大/中/小图)">
                  {([[3, "大图"], [4, "中图"], [5, "小图"]] as [3 | 4 | 5, string][]).map(([n, label]) => (
                    <button
                      key={n}
                      className={`px-2 py-1.5 text-xs ${gridCols === n ? "bg-neutral-700 text-neutral-100" : "bg-neutral-900 text-neutral-400 hover:bg-neutral-800"}`}
                      title={label}
                      onClick={() => setGridCols(n)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,video/*"
                className="hidden"
                onChange={(e) => onUpload(e.target.files?.[0] || null)}
              />
              <button className="btn-primary" onClick={() => fileRef.current?.click()} disabled={uploadPct != null}>
                ＋ {(config?.autoTranscribe ?? true) ? "上传并转录" : "上传音视频"}
              </button>
            </div>
          </div>

          {err && <p className="mb-3 rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</p>}

          {records.length === 0 ? (
            <div className="card text-center text-sm text-neutral-500">
              还没有内容。点击「{(config?.autoTranscribe ?? true) ? "上传并转录" : "上传音视频"}」上传一段音频或视频。
            </div>
          ) : cardView === "grid" ? (
            <div className={`grid gap-3 sm:grid-cols-2 ${gridCols === 3 ? "lg:grid-cols-3" : gridCols === 4 ? "lg:grid-cols-4" : "lg:grid-cols-5"}`}>
              {records.map((r) => (
                <div
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className="card cursor-pointer text-left transition-colors hover:border-neutral-600"
                >
                  <CoverThumb r={r} className="aspect-video w-full text-4xl" />
                  <div className="mt-2 flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-neutral-100">{r.title}</div>
                      <div className="mt-0.5 text-xs text-neutral-500">
                        {new Date(r.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                      title="删除"
                      onClick={(e) => { e.stopPropagation(); onDelete(r.id); }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-2 flex items-center gap-2">{statusActions(r)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-neutral-800">
              {records.map((r, i) => (
                <div
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-800/40 ${i > 0 ? "border-t border-neutral-800/60" : ""}`}
                >
                  <CoverThumb r={r} className="h-10 w-16 text-base" />
                  <div className="min-w-0 flex-[2]">
                    <div className="truncate text-sm font-medium text-neutral-100">{r.title}</div>
                    <div className="mt-0.5 text-xs text-neutral-500">
                      {fmtDur(r.durationSec)} · {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="hidden w-64 shrink-0 items-center gap-2 sm:flex">{statusActions(r)}</div>
                  <button
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                    title="删除"
                    onClick={(e) => { e.stopPropagation(); onDelete(r.id); }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
