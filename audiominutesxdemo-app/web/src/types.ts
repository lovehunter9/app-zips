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
}

export type RecordStatus = "uploaded" | "processing" | "done" | "error";

export interface RecordOptions {
  language: string;
  segmentedStt: boolean;
  translate?: boolean;
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
}

export interface RecordFull extends RecordSummary {
  mime: string;
  result: RecordResult | null;
}

export interface ModelOpt {
  id: string;
  name: string;
  provider_name?: string;
}

export interface TranslateConfig {
  enabled: boolean;
  model: string;
  sourceLang: string; // "auto" (detect per segment) or a FLORES code
  targetLang: string; // "auto" (smart zh<->en) or a FLORES code (zho_Hans/eng_Latn/…)
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
  ready: boolean;
  missing: string[];
}
