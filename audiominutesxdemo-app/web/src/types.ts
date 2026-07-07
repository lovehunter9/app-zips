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
}

export interface RecordResult {
  language: string;
  speakers: string[];
  segments: Segment[];
}

export type RecordStatus = "uploaded" | "processing" | "done" | "error";

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

export interface GatewayConfig {
  base: string;
  key: string;
  cookie: string;
  bflUser: string;
  models: { stt: string; align: string; diar: string };
  segmentedStt: boolean;
  language: string;
  ready: boolean;
  missing: string[];
}
