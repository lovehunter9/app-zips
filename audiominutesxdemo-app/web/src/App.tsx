// Audio Minutes X Demo — Feishu-Minutes-style app.
//   • Library ("我的内容"): upload audio/video, server transcribes asynchronously,
//     cards show 处理中 N% and survive refresh.
//   • Record detail: media player <-> word-level transcript two-way sync. Playback
//     highlights the current word and auto-scrolls; click a word to seek there.
//   • Settings: LLM Gateway address + which STT/align/diar models to use (chosen
//     from what the gateway actually serves). Missing a required model => the app
//     tells you it cannot transcribe.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GatewayConfig, ModelOpt, RecordFull, RecordSummary, Segment, Word } from "./types";
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
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium leading-none"
      style={{ color: c, backgroundColor: c + "22", border: `1px solid ${c}55` }}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: c }} />
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
const PIPELINE = ["说话人分离", "转写与词级对齐", "整理结果"];
function ProcessingView({ rec }: { rec: RecordFull }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const p = rec.progress || 0;
  const stage = p < 20 ? 0 : p < 94 ? 1 : 2;
  const elapsed = rec.startedAt ? now - new Date(rec.startedAt).getTime() : 0;
  const hasCount = (rec.stepTotal || 0) > 0;
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
        {PIPELINE.map((label, i) => {
          const done = i < stage;
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
      <div className="text-center text-xs text-neutral-500">已用时 {fmtElapsed(elapsed)} · 串行处理,多个任务会自动排队</div>
    </div>
  );
}

// ===========================================================================
// Settings modal
// ===========================================================================
function SettingsModal({
  config,
  onClose,
  onSaved,
}: {
  config: GatewayConfig;
  onClose: () => void;
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
      const saved = await api.putConfig({ base, key, cookie, models: { stt, align, diar }, segmentedStt, language });
      onSaved(saved);
      onClose();
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
        <span className="mb-1 block text-neutral-400">{label}(mode={mode})</span>
        <select className="input" value={value} onChange={(e) => set(e.target.value)}>
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div className="mt-10 w-full max-w-xl card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">设置 · LLM Gateway</h2>
          <button className="btn-ghost" onClick={onClose}>关闭</button>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-400">网关地址(Base URL,含 /v1 前的根,如 https://xxx.olares.com)</span>
          <input className="input" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://<gateway-host>" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-400">API Key(数据面 Bearer)</span>
          <input className="input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-400">Olares Cookie(本地调试用,可选)</span>
          <input className="input" value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="auth_token=..." />
        </label>

        <div className="flex items-center gap-3">
          <button className="btn-ghost" onClick={loadModels} disabled={loading || !base}>
            {loading ? "加载中…" : "保存并加载模型"}
          </button>
          {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        </div>

        <div className="grid gap-3 border-t border-neutral-800 pt-3">
          <ModelSelect label="转写 STT" mode="stt" value={stt} set={setStt} />
          <ModelSelect label="强制对齐 Align(词级时间戳)" mode="align" value={align} set={setAlign} />
          <ModelSelect label="说话人分离 Diarize" mode="diar" value={diar} set={setDiar} />
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-400">对齐语言(默认自动识别,无需手填)</span>
            <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="auto">自动识别(按转写文本判定)</option>
              <option value="zh">中文 zh</option>
              <option value="en">English en</option>
              <option value="ja">日本語 ja</option>
              <option value="ko">한국어 ko</option>
              <option value="yue">粤语 yue</option>
            </select>
          </label>
        </div>

        <label className="flex items-start gap-3 border-t border-neutral-800 pt-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={segmentedStt}
            onChange={(e) => setSegmentedStt(e.target.checked)}
          />
          <span>
            <span className="block text-neutral-200">分段转写(按说话人分段逐段调用 STT)</span>
            <span className="block text-xs text-neutral-500">
              默认关闭 = 整段转写(整段音频一次 STT,再按说话人切分)。开启后按 diarization 窗口逐段转写,调用次数更多、单段上下文更聚焦。
            </span>
          </span>
        </label>

        {err && <p className="rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</p>}

        <div className="flex justify-end gap-2 border-t border-neutral-800 pt-3">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={save} disabled={loading}>保存</button>
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
  onBack,
  onChanged,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [rec, setRec] = useState<RecordFull | null>(null);
  const [err, setErr] = useState("");
  const [activeGi, setActiveGi] = useState<number>(-1);   // active WORD (word-level path)
  const [activeSeg, setActiveSeg] = useState<number>(-1); // active SEGMENT (fallback path)
  const [q, setQ] = useState("");                         // transcript search query
  const [sideTab, setSideTab] = useState<"info" | "spk">("info"); // audio left sidebar
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
        return { ...s, words: granularity === "word" ? groupWordsToCi(fixed, cut) : fixed };
      });
    },
    [rec, granularity, jiebaReady],
  );
  // Whether this transcript has any Chinese (only then is the 字/词 toggle useful).
  const hasCJK = useMemo(
    () => (rec?.result?.segments || []).some((s) => /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(s.text || "")),
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

  const hasWords = flat.length > 0;

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
  const segStarts = useMemo(() => segments.map((s) => +s.start), [segments]);
  // Latest arrays kept in refs so the rAF loop reads fresh values without needing
  // to restart whenever they change.
  const wordStartsRef = useRef(wordStarts);
  const segStartsRef = useRef(segStarts);
  useEffect(() => { wordStartsRef.current = wordStarts; segStartsRef.current = segStarts; }, [wordStarts, segStarts]);

  const syncToTime = useCallback((t: number) => {
    const gi = lastAtOrBefore(wordStartsRef.current, t);
    setActiveGi((prev) => (prev === gi ? prev : gi));
    const sg = lastAtOrBefore(segStartsRef.current, t);
    setActiveSeg((prev) => (prev === sg ? prev : sg));
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

  async function doTranscribe() {
    try { await api.transcribeRecord(id); await load(); onChanged(); }
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
  const matchCount = query
    ? segments.filter((s) => (s.text || "").toLowerCase().includes(query)).length
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

  // The transcript list is shared by both layouts (video: right column; audio:
  // full-width main body). The scroll container that wraps it differs per layout.
  const transcriptList = (
    <>
      {segments.length === 0 && <p className="text-sm text-neutral-600">(无转写内容)</p>}
      {query && matchCount === 0 && <p className="text-sm text-neutral-600">未找到「{q.trim()}」</p>}
      <div className="space-y-4">
        {segments.map((seg, si) => {
          if (query && !(seg.text || "").toLowerCase().includes(query)) return null;
          return (
          <div key={si} data-seg={si} className={`rounded-lg p-2 transition-colors ${si === activeSegIdx ? "bg-neutral-800/40" : ""}`}>
            <div className="mb-1 flex items-center gap-2">
              <SpeakerChip spk={seg.speaker} />
              <button className="font-mono text-xs tabular-nums text-neutral-500 hover:text-neutral-300" onClick={() => seekTo(seg.start)}>
                {fmtTC(seg.start)}
              </button>
            </div>
            <p className="text-[15px] leading-relaxed text-neutral-200">
              {seg.words && seg.words.length
                ? seg.words.map((w, wi) => {
                    const gi = segBase[si] + wi;
                    const active = gi === activeGi;
                    return (
                      <span
                        key={wi}
                        data-gi={gi}
                        onClick={() => seekTo(w.start)}
                        className={`cursor-pointer rounded px-px transition-colors ${active ? "bg-emerald-500/70 text-white" : "hover:bg-neutral-700/60"}`}
                      >
                        {w.text}
                      </span>
                    );
                  })
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
                    {seg.text}
                  </span>
                )}
            </p>
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
        {rec.status === "done" && (
          <button className="btn-ghost" onClick={doTranscribe} title="用当前设置(整段/分段)重新跑一遍转写">重新转写</button>
        )}
        {(rec.status === "uploaded" || rec.status === "error") && (
          <button className="btn-primary" onClick={doTranscribe}>AI 转录</button>
        )}
        <button className="btn-ghost" onClick={doDelete}>删除</button>
      </div>

      {err && <p className="mx-4 mt-3 rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</p>}

      {rec.status !== "done" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          {rec.status === "processing" ? (
            <ProcessingView rec={rec} />
          ) : rec.status === "error" ? (
            <div className="text-red-400">{rec.error || "失败"}</div>
          ) : (
            <div className="text-neutral-400">尚未转录,点击右上角「AI 转录」。</div>
          )}
        </div>
      ) : rec.kind === "video" ? (
        // Video: player on the left, transcript on the right (unchanged).
        <div className="grid flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <video ref={(el) => { mediaRef.current = el; }} src={mediaSrc} controls className="w-full rounded-lg bg-black" onTimeUpdate={onTimeUpdate} onPlay={startRaf} onPause={stopRaf} onEnded={stopRaf} onSeeking={onTimeUpdate} />
            <FileInfo rec={rec} />
            <p className="card text-xs leading-relaxed text-neutral-400">点击文字记录(有词级时间时可点单词,否则点整句)可跳转播放;播放时会高亮当前位置并自动滚动。</p>
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="mb-3 flex items-center gap-2">
              <div className="min-w-0 flex-1">{searchBox}</div>
              {granularityToggle}
            </div>
            <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-lg border border-neutral-800 bg-black/30 p-4">
              {transcriptList}
            </div>
          </div>
        </div>
      ) : (
        // Audio (Feishu-Minutes layout): left sidebar (文件信息 / 发言人) + right
        // transcript (文字记录 with search) as the main body + full-width player bar.
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <aside className="hidden w-60 shrink-0 flex-col border-r border-neutral-800 md:flex">
              <div className="flex gap-1 border-b border-neutral-800 px-2 py-2 text-xs">
                <button
                  className={`rounded px-2 py-1 ${sideTab === "info" ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
                  onClick={() => setSideTab("info")}
                >
                  文件信息
                </button>
                <button
                  className={`rounded px-2 py-1 ${sideTab === "spk" ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
                  onClick={() => setSideTab("spk")}
                >
                  发言人 ({rec.result?.speakers?.length ?? 0})
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {sideTab === "info" ? <FileInfoRows rec={rec} /> : <SpeakerStats rec={rec} />}
              </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2">
                <span className="text-sm font-medium text-neutral-200">文字记录</span>
                <div className="ml-auto flex items-center gap-2">
                  {granularityToggle}
                  <div className="w-48 sm:w-64">{searchBox}</div>
                </div>
              </div>
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5">
                <div className="mx-auto w-full max-w-3xl">{transcriptList}</div>
              </div>
            </div>
          </div>
          <div className="border-t border-neutral-800 bg-neutral-900/80 px-4 py-3">
            <audio ref={(el) => { mediaRef.current = el; }} src={mediaSrc} controls className="mx-auto block w-full max-w-4xl" onTimeUpdate={onTimeUpdate} onPlay={startRaf} onPause={stopRaf} onEnded={stopRaf} onSeeking={onTimeUpdate} />
          </div>
        </div>
      )}
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
    <dl className="space-y-2 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <dt className="w-14 shrink-0 text-neutral-500">{k}</dt>
          <dd className="min-w-0 flex-1 break-words text-neutral-300">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
// "文件信息" 卡片（视频左栏用）：元数据 + 说话人色块。
function FileInfo({ rec }: { rec: RecordFull }) {
  return (
    <div className="card">
      <div className="mb-2 text-xs font-medium text-neutral-300">文件信息</div>
      <FileInfoRows rec={rec} />
      {(rec.result?.speakers?.length ?? 0) > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-neutral-800 pt-2 text-xs">
          <span className="text-neutral-500">说话人</span>
          {(rec.result?.speakers || []).map((s) => <SpeakerChip key={s} spk={s} />)}
        </div>
      )}
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
    <div className="space-y-3">
      {rows.map(([spk, st]) => {
        const pct = Math.round((100 * st.dur) / total);
        return (
          <div key={spk} className="text-xs">
            <div className="mb-1 flex items-center gap-2">
              <SpeakerChip spk={spk} />
              <span className="ml-auto tabular-nums text-neutral-400">{pct}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
              <div className="h-full rounded" style={{ width: `${pct}%`, background: spkColor(spk) }} />
            </div>
            <div className="mt-1 text-neutral-500">{st.count} 段 · {fmtDur(st.dur)}</div>
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
      if (ready) { await api.transcribeRecord(rec.id); await refreshRecords(); }
    } catch (e: any) {
      setErr(String(e?.message || e));
      setUploadPct(null);
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="mx-auto flex h-screen max-w-6xl flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
        <h1 className="text-lg font-semibold">🎙 Audio Minutes <span className="text-neutral-500">X Demo</span></h1>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-ghost" onClick={() => setShowSettings(true)}>设置</button>
        </div>
      </header>

      {!ready && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-sm text-red-300">
          无法转录:缺少 {config?.missing?.join("、") || "网关配置"}。请点击右上角「设置」配置网关地址并选择 STT / Align / Diarize 模型。
        </div>
      )}

      {selectedId ? (
        <div className="flex-1 overflow-hidden">
          <RecordDetail id={selectedId} onBack={() => setSelectedId(null)} onChanged={refreshRecords} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-4 flex items-center gap-3">
            <h2 className="text-base font-semibold">我的内容</h2>
            <div className="ml-auto flex items-center gap-2">
              {uploadPct != null && <span className="text-xs text-neutral-400">上传中 {uploadPct}%</span>}
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,video/*"
                className="hidden"
                onChange={(e) => onUpload(e.target.files?.[0] || null)}
              />
              <button className="btn-primary" onClick={() => fileRef.current?.click()} disabled={uploadPct != null}>
                ＋ 上传并转录
              </button>
            </div>
          </div>

          {err && <p className="mb-3 rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</p>}

          {records.length === 0 ? (
            <div className="card text-center text-sm text-neutral-500">
              还没有内容。点击「上传并转录」上传一段音频或视频。
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {records.map((r) => (
                <div
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className="card cursor-pointer text-left transition-colors hover:border-neutral-600"
                >
                  <div className="flex items-start gap-2">
                    <span className="text-2xl">{r.kind === "video" ? "🎬" : "🎧"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-neutral-100">{r.title}</div>
                      <div className="mt-0.5 text-xs text-neutral-500">
                        {fmtDur(r.durationSec)} · {new Date(r.createdAt).toLocaleString()}
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
                  <div className="mt-3 flex items-center gap-2">
                    {r.status === "processing" ? (
                      <div className="flex-1">
                        <div className="mb-1 text-xs text-amber-400">{statusText(r)}</div>
                        <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
                          <div className="h-full bg-amber-500 transition-[width] duration-500" style={{ width: `${r.progress}%` }} />
                        </div>
                      </div>
                    ) : r.status === "done" ? (
                      <>
                        <span className="min-w-0 flex-1 truncate text-xs text-emerald-400">已完成 · {r.speakers} 位说话人</span>
                        <button
                          className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                          disabled={!ready || busyIds.has(r.id)}
                          title={!ready ? "请先在设置里完成网关与模型配置" : "用当前设置(整段/分段)重新跑一遍转写"}
                          onClick={(e) => { e.stopPropagation(); retry(r.id); }}
                        >
                          {busyIds.has(r.id) ? "…" : "重新转写"}
                        </button>
                      </>
                    ) : r.status === "error" ? (
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
                    ) : (
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
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showSettings && config && (
        <SettingsModal
          config={config}
          onClose={() => setShowSettings(false)}
          onSaved={(cfg) => setConfig(cfg)}
        />
      )}
    </div>
  );
}
