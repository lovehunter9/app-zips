export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Segment {
  start: number;
  end: number;
  speaker: string;
  text: string;
  words: Word[];
  // Optional translation of `text`. `twords` are pseudo word-level timings spread
  // evenly across [start,end] (the audio is source-language, so real word times
  // for the translation aren't available) — used for click-to-seek + highlight.
  translation?: string;
  twords?: Word[];
  translateTo?: string;
}

export interface RecordResult {
  language: string;
  speakers: string[];
  segments: Segment[];
  // Custom display name per speaker/participant id (id → name). Empty/absent = show
  // the default "说话人 N". Renaming propagates to every segment of that speaker.
  speakerNames?: Record<string, string>;
  // Ordered ids shown in the top "参会者" roster. Seeded from `speakers`; the user can
  // add (people who didn't speak) or remove (anyone) — segments keep their speaker id.
  participants?: string[];
  // Custom color per speaker/participant id (id → #hex). Absent = auto color by index.
  speakerColors?: Record<string, string>;
}

export type RecordStatus = "uploaded" | "preparing" | "processing" | "done" | "error" | "generating";

// A user-visible processing event/notice attached to a record so the UI can show
// WHAT happened during a run (denoise fell back, alignment auto-split, a step
// failed) instead of a black box.
export interface Notice {
  at: string;
  level: "info" | "warn" | "error";
  msg: string;
}

// Processing-time breakdown for a run: total wall-clock + per-step durations (ms).
export interface Timings {
  totalMs: number;
  steps: { name: string; ms: number }[];
}

export interface RecordOptions {
  language: string;
  segmentedStt: boolean;
  translate?: boolean;
  enhance?: boolean;
  // Upper bound on speakers for diarization (0 = 自动/不限). Same "最多" semantics as
  // 重新识别说话人 — a maximum, never a forced count.
  maxSpeakers?: number;
}

export interface RecordSummary {
  id: string;
  title: string;
  kind: "audio" | "video";
  originalName: string;
  durationSec: number | null;
  status: RecordStatus;
  progress: number;
  phase: string;
  stepDone: number;
  stepTotal: number;
  startedAt: string;
  error: string;
  createdAt: string;
  speakers: number;
  segments: number;
  options?: RecordOptions;
  translated?: boolean;
  jobKind?: "full" | "translate" | "rediarize";
  notices?: Notice[];
  hasCover?: boolean;
  coverVer?: string; // changes when the cover is (re)set, used to bust the <img> cache
  totalMs?: number | null; // total processing time of the last run (ms)
  // Clip metadata: `clipOf` (parent record id) marks this record as a 片段; a clip
  // is generated (status "generating") then becomes an independent record. `continuous`
  // is true for a single-range clip. `clipCount` = number of concatenated ranges.
  clipOf?: string;
  continuous?: boolean;
  clipCount?: number;
}

export interface RecordFull extends RecordSummary {
  mime: string;
  result: RecordResult | null;
  timings?: Timings | null;
  clipRanges?: { start: number; end: number }[]; // present on 片段 records
  summary?: RecordSummaryBlock | null; // 智能摘要 (generated on demand)
  qa?: QaState | null; // 智能问答 / RAG (index metadata + conversation history)
}

export interface ModelOpt {
  id: string;
  name: string;
  mode?: string;
  supports?: string[];
  provider_name?: string;
}

export interface TranslateConfig {
  enabled: boolean;
  model: string;
  sourceLang: string; // "auto" (detect per segment) or a FLORES code
  targetLang: string; // "auto" (smart zh<->en) or a FLORES code (zho_Hans/eng_Latn/…)
}

export interface EnhanceConfig {
  enabled: boolean;
  model: string;
}

// 智能摘要 config: `model` is a chat-mode gateway model id (e.g. Qwen3-4B).
export interface SummaryConfig {
  model: string;
}

// A generated 智能摘要. All time fields are SECONDS into the audio (click-to-seek).
export interface Summary {
  oneLine: string;
  overview: string;
  chapters: { title: string; start: number; end: number; summary: string }[];
  keyPoints: { text: string; time: number }[];
  actionItems: { text: string; owner: string; time: number }[];
  speakers: { name: string; points: string }[];
}

export interface RecordSummaryBlock {
  data: Summary;
  model: string;
  at: string;
}

// 智能问答 / RAG config: `model` is the chat model (falls back to summary.model when
// empty); `embedModel` is the embedding-mode model id (e.g. Qwen3-Embedding-0.6B).
export interface QaConfig {
  model: string;
  embedModel: string;
}

// A retrieved chunk cited by an answer. `time`/`end` are SECONDS (click-to-seek).
export interface QaCitation {
  n: number;
  time: number;
  end: number;
  speaker: string;
  text: string;
  score: number;
}

// One Q&A exchange in a record's conversation history.
export interface QaTurn {
  q: string;
  a: string;
  model?: string;
  citations: QaCitation[];
  at: string;
}

// Per-record Q&A state: index metadata + conversation history (vectors live in a
// separate index file on the server, never sent to the client).
export interface QaState {
  indexedAt?: string;
  embedModel?: string;
  chunkCount?: number;
  dim?: number;
  history?: QaTurn[];
}

export interface BackgroundConfig {
  enabled: boolean;
  dim: number; // 0..80 darken overlay
  mime?: string;
}

export interface GatewayConfig {
  base: string;
  key: string;
  cookie: string;
  bflUser: string;
  models: { stt: string; align: string; diar: string };
  segmentedStt: boolean;
  language: string;
  autoTranscribe: boolean;
  translate: TranslateConfig;
  enhance: EnhanceConfig;
  summary: SummaryConfig;
  qa: QaConfig;
  background: BackgroundConfig;
  ready: boolean;
  missing: string[];
  // Build/version info for the 设置 page (which folder + when it was last modified).
  version?: { app: string; dir: string; builtAt: string; tag: string; label: string };
}
