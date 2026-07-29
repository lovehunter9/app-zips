export type CapId = "stt" | "align" | "translate" | "vad" | "diar" | "enhance" | "embed";

// AUDIOBASE (x2) model: every audio model registers with the coarse gateway
// mode `audio` and declares its concrete capabilities in model_spec.supports
// (supports_* keys, which api.ts normalizes to bare). So a capability is served when
//   model.mode === AUDIO_MODE && model.supports.includes(CAP_SUPPORT[cap]).
export const AUDIO_MODE = "audio";

// CapId -> the model_spec.supports KEY that gates it. Mostly 1:1; `embed` maps to
// `speaker_embed` (the renamed audio support). `translate` maps to `translate` but
// is NOT an audio support in this line — no audio provider declares it, so the
// translate slot stays present in the UI but finds no model (placeholder; the
// translation model is intentionally not wired in yet).
export const CAP_SUPPORT: Record<CapId, string> = {
  stt: "stt",
  align: "align",
  translate: "translate",
  vad: "vad",
  diar: "diar",
  enhance: "enhance",
  embed: "speaker_embed",
};

// Deprecated per-mode map kept only for any legacy reference; the x2 line selects
// models by AUDIO_MODE + CAP_SUPPORT (see above), NOT by a per-capability mode.
export const CAP_MODE: Record<CapId, string> = { ...CAP_SUPPORT };

export const CAP_LABEL: Record<CapId, string> = {
  stt: "转写 STT",
  align: "强制对齐 Align",
  translate: "翻译 Translate",
  vad: "人声分段 VAD",
  diar: "说话人分离 Diarize",
  enhance: "降噪增强 Enhance",
  embed: "声纹向量 Embed",
};

export const CAP_ORDER: CapId[] = ["stt", "align", "translate", "vad", "diar", "enhance", "embed"];

export interface Settings {
  base: string; // gateway base URL (may be empty -> use server env)
  key: string; // data-plane API key (Bearer)
  bflUser: string; // optional console identity (edge-bypass fallback)
  cookie: string; // optional Olares SSO cookie, forwarded by server (local-debug)
}

export interface ProviderModel {
  id: string;
  name: string;
  mode: string;
  // Audio capability keys declared by the model (model_spec.supports where true).
  // Populated for mode=audio models; drives capability availability in the x2 line.
  supports?: string[];
  provider_id?: string;
  provider_name?: string;
  enabled?: boolean;
  status?: string;
}

export interface ExecRecord {
  cap: CapId;
  invoked: boolean;
  skippedReason?: string;
  endpoint?: string;
  method?: string;
  model?: string;
  params?: Record<string, unknown>;
  status?: number;
  ok?: boolean;
  durationMs?: number;
  responseSummary?: string;
  rawResponse?: string;
  error?: string;
}

export interface UploadInfo {
  id: string;
  kind: "audio" | "video";
  originalName: string;
  durationSec: number | null;
}
