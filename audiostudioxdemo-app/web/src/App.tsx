import { useEffect, useMemo, useState } from "react";
import {
  audioMultipart,
  fetchDefaultModels,
  fetchProviderModels,
  fetchSilences,
  fetchUploadAudio,
  transcodeToMp3,
  translate,
  uploadMedia,
  type CallResult,
} from "./api";
import { alignTextToTimeline, distributeTextOverRuns } from "./align";
import {
  CAP_LABEL,
  CAP_MODE,
  CAP_ORDER,
  type CapId,
  type ExecRecord,
  type ProviderModel,
  type Settings,
  type UploadInfo,
} from "./types";
import { decodeAudio, mapLimit, sliceWav, type DecodedAudio } from "./audio";
import { franc } from "franc-min";

const LS_KEY = "audiostudioxdemo.settings";
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
  if (m.includes("qwen")) return { def: 4, max: 8 };
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
  const [settings, setSettings] = useState<Settings>(loadSettings());
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [modelStatus, setModelStatus] = useState<string>("");
  const [enabled, setEnabled] = useState<Record<CapId, boolean>>({
    stt: true,
    translate: true,
    vad: true,
    diar: true,
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
  // Per-segment STT fan-out: when ON (and VAD/Diarize is selected) the audio is sliced by
  // the coalesced VAD/Diarize windows and each is transcribed separately (N calls). Slower
  // but higher quality (full context per turn). OFF = the whole-clip single-call path.
  const [sttPerSeg, setSttPerSeg] = useState(false);
  // Per-segment (per-line) translation: ON = translate each fused transcript line (concurrent,
  // shown per-segment in the fused view); OFF = one whole-text translation call. Default OFF
  // — like every other default, it minimises the number of gateway calls.
  const [translatePerSeg, setTranslatePerSeg] = useState(false);
  const [translateConc, setTranslateConc] = useState(4);
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

  const modelsByMode = useMemo(() => {
    const m: Record<string, ProviderModel[]> = {};
    for (const pm of models) {
      if (!pm.mode) continue;
      (m[pm.mode] ||= []).push(pm);
    }
    return m;
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
      const next: Record<CapId, string> = { ...selModel };
      for (const cap of CAP_ORDER) {
        const mode = CAP_MODE[cap];
        const list = pm.filter((x) => x.mode === mode);
        const def = dm[mode];
        next[cap] = (def && list.find((x) => x.name === def)?.name) || list[0]?.name || "";
      }
      setSelModel(next);
      const counts = CAP_ORDER.map((c) => `${c}:${pm.filter((x) => x.mode === CAP_MODE[c]).length}`).join("  ");
      setModelStatus(`✅ 模型 ${pm.length} 个 — ${counts}`);
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
      case "translate":
        return `→ ${String(j?.translation ?? j?.text ?? j?.translated_text ?? "").slice(0, 60)}`;
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

  // Run the selected capabilities as a dependency-ordered workflow (not in isolation):
  //   enhance(preprocess) -> vad/diar(segmentation) -> stt(segment-wise) -> translate(per-line) -> embed(per-speaker)
  async function run() {
    if (!hasGateway) {
      alert("未配置 Gateway URL：请先在『① Gateway 设置』里填写地址。未配置时不会发起任何模型调用。");
      return;
    }
    if (!upload) {
      alert("请先上传音频/视频");
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
        const res = await callRetry(() => audioMultipart(settings, "diarization", workingAudio, model, {}), 1);
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
          if (sttPerSeg && segSource.length) {
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
            out.stt = { text: fused.map((f) => f.text).join(" "), segments: fused, tsSource };
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
            fullText = texts.filter(Boolean).join(" ");
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
            tsSource = `非 AI 后处理 (整段文本按 ${tlSource} 分段对齐)`;
          } else if (isWhisper && nativeSegs.length) {
            // No VAD/Diarize, Whisper: keep the engine's native verbose_json segments.
            fused = nativeSegs.map((s) => ({ start: s.start, end: s.end, text: s.text }));
            tsSource = "引擎原生 (Whisper verbose_json)";
            tlSource = "";
          } else if (!alignTs) {
            // No VAD/Diarize, Qwen, post-processing OFF → show the raw whole-clip transcript
            // as one untimed block (the model's pure output, no fabricated timestamps).
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
          const joined = fused.map((f) => (f.text || "").trim()).filter(Boolean).join(" ") || fullText;
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

    // ── Stage 3: Translate (per-line over the fused transcript) ────────
    if (enabled.translate) {
      const model = selModel.translate;
      // Fine mode: translate each segment so the fused view shows per-segment
      // translation (the nice part). Each call is fail-fast (tries=1) so it degrades
      // gracefully instead of stacking gateway timeouts. Whole-text otherwise.
      const lines = translatePerSeg ? fused.filter((f) => (f.text || "").trim()) : [];
      const wholeText = out.stt?.text || (fused.length ? fused.map((f) => f.text || "").join(" ").trim() : "");
      // Source language: explicit pick, or auto-detect. The document-level guess
      // (over the whole transcript) is the stable fallback for short per-line text.
      const docLang = source === "auto" ? detectLang(wholeText, "eng_Latn") : source;
      const srcMode = source === "auto" ? `自动(${langLabel(docLang)})` : langLabel(source);
      if (!model) skip("translate", "无可用模型");
      else if (!lines.length && !wholeText) skip("translate", "需要转写文本(请同时启用 STT)");
      else if (lines.length) {
        // translate each transcript line (sequential, abort on breaker). Lines whose
        // (detected) source already equals the target are skipped — no gateway call,
        // no NLLB same-language self-rewrite artifact.
        try {
          // CONCURRENT per-line translation (same rationale as STT): NLLB calls are
          // independent, so batch them instead of serial. Same-language lines are
          // skipped (no call). mapLimit keeps order; `aborted` stops on breaker.
          const TRANSLATE_CONCURRENCY = translateConc;
          const t0 = Date.now();
          let okCount = 0,
            skipCount = 0,
            todo = 0,
            done = 0,
            lastStatus = 0,
            errSample = "",
            aborted = false;
          setProgress({ cap: "translate", phase: "逐行翻译中", done: 0, total: lines.length });
          await mapLimit(lines, TRANSLATE_CONCURRENCY, async (ln) => {
            const eff = source === "auto" ? detectLang(ln.text || "", docLang) : source;
            (ln as any).srcLang = eff;
            if (eff === target) {
              skipCount++;
              (ln as any).translation = "";
              (ln as any).sameLang = true;
              setProgress({ cap: "translate", phase: "逐行翻译中", done: ++done, total: lines.length });
              return;
            }
            if (aborted) {
              setProgress({ cap: "translate", phase: "逐行翻译中", done: ++done, total: lines.length });
              return;
            }
            todo++;
            const res = await callRetry(() => translate(settings, model, ln.text || "", target, eff), 2);
            lastStatus = res.status;
            if (res.ok) okCount++;
            else if (!errSample) errSample = `${res.status}: ${errBody(res)}`;
            (ln as any).translation = (res.json?.translation ?? res.json?.text ?? res.json?.translated_text ?? "").toString();
            if (isCircuitOpen(res)) aborted = true;
            setProgress({ cap: "translate", phase: "逐行翻译中", done: ++done, total: lines.length });
          });
          const wallMs = Date.now() - t0;
          if (todo === 0) {
            skip("translate", `逐行检测全部为 ${langLabel(target)},与目标相同,整体跳过(${skipCount} 段)`);
          } else {
            out.translate = { segments: lines, text: lines.map((l) => (l as any).translation || "").join(" "), target, source: srcMode };
            push({
              cap: "translate",
              invoked: true,
              endpoint: "/v1/translate",
              method: `POST ×${todo}(并发${TRANSLATE_CONCURRENCY})`,
              model,
              params: { 模式: "逐行翻译", 源语言: srcMode, target: langLabel(target), 并发: TRANSLATE_CONCURRENCY },
              status: lastStatus,
              ok: okCount === todo,
              durationMs: wallMs,
              responseSummary:
                `逐行翻译 ${todo} 行,成功 ${okCount}/${todo}` +
                (skipCount ? ` · 跳过同语言 ${skipCount} 行` : "") +
                (aborted ? " · 触发熔断已中止" : "") +
                (okCount < todo && errSample ? ` · 首个错误 ${errSample}` : ""),
              rawResponse: JSON.stringify(
                lines.slice(0, 8).map((l) => ({ src: (l as any).srcLang, text: l.text, translation: (l as any).translation, skipped: (l as any).sameLang || false })),
                null,
                2
              ),
            });
          }
        } catch (e: any) {
          push({ cap: "translate", invoked: true, model, error: String(e.message || e) });
        }
      } else if (docLang === target) {
        // whole-text mode, source already == target → skip the single call too.
        skip("translate", `源(${langLabel(docLang)})与目标(${langLabel(target)})相同,跳过翻译`);
      } else {
        try {
          const res = await callRetry(() => translate(settings, model, wholeText, target, docLang));
          out.translate = res.json;
          push({
            cap: "translate",
            invoked: true,
            endpoint: "/v1/translate",
            method: "POST",
            model,
            params: { text: wholeText.slice(0, 80) + (wholeText.length > 80 ? "…" : ""), 源语言: srcMode, target: langLabel(target) },
            status: res.status,
            ok: res.ok,
            durationMs: res.durationMs,
            responseSummary: res.ok ? summarize("translate", res) : `失败 ${res.status}: ${errBody(res)}`,
            rawResponse: JSON.stringify(res.json ?? res.text, null, 2)?.slice(0, 4000),
          });
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
        <h1 className="text-xl font-semibold">Audio Studio X Demo</h1>
        <p className="text-sm text-neutral-400">上传音频/视频 → 经 LLM Gateway 调用 M1 音频能力(STT / 翻译 / VAD / 分离 / 增强 / 声纹)</p>
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

        {/* capabilities */}
        <Card title="③ 能力开关(仅勾选项会被调用)">
          <div className="space-y-2">
            {CAP_ORDER.map((cap) => {
              const list = modelsByMode[CAP_MODE[cap]] || [];
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
                    {list.length === 0 && <option value="">(无 {CAP_MODE[cap]} 模型 — 先刷新)</option>}
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
                      const perSegOn = perSegActive && sttPerSeg;
                      // The align toggle is only meaningful for a timestamp-less engine (Qwen)
                      // when there is NO VAD/Diarize (and not in per-segment mode).
                      const alignActive = enabled.stt && !fuseOn && !sttIsWhisper;
                      const status = !enabled.stt
                        ? ""
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
                          <label
                            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs ${perSegActive ? "text-neutral-300" : "text-neutral-600"}`}
                            title={
                              perSegActive
                                ? "开:按 VAD/Diarize 窗口逐段切音频分别转写(N 次调用),上下文更完整、质量更稳;关:整段一次调用。"
                                : "需先勾选 VAD 或 Diarize 才能按段切片转写(本项当前不生效)。"
                            }
                          >
                            <input
                              type="checkbox"
                              disabled={!perSegActive}
                              checked={sttPerSeg}
                              onChange={(e) => setSttPerSeg(e.target.checked)}
                            />
                            分段发送转写请求
                          </label>
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
                              fuseOn
                                ? "已选 VAD/Diarize,STT 必与之协同融合,本开关不生效"
                                : sttIsWhisper
                                  ? "Whisper 自带时间戳,本开关只对 Qwen 等无时间戳引擎生效"
                                  : "开:整段文本按静音检测/总时长匀速对齐出时间戳。关:显示 Qwen 整段原文,不造分段时间戳"
                            }
                          >
                            <input
                              type="checkbox"
                              disabled={!alignActive}
                              checked={alignTs}
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
            <button className="btn" disabled={running || !upload || !hasGateway} onClick={run}>
              {running ? "执行中…" : "▶ 运行所选能力"}
            </button>
            {!hasGateway && <span className="text-sm text-amber-400">⚠ 未配置 Gateway URL，已禁用调用(见①)。</span>}
            {hasGateway && !upload && <span className="text-sm text-neutral-500">先上传音频/视频(见②)。</span>}
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
          <Card title="④ 执行透明面板(自证:只调了勾选项)">
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
          <Card title="⑤ 工作流融合结果(各能力按依赖编排后的统一产出)">
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
          <Card title="⑥ 各能力单独输出(工作流中间产物 / 证据)">
            {results.stt && <SttView data={results.stt} />}
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
