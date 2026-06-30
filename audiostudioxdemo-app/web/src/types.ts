export type CapId = "stt" | "align" | "translate" | "vad" | "diar" | "enhance" | "embed";

// Gateway provider_models.mode values map to our capabilities. translate/vad/
// diar/embed/enhance/align are 1:1; stt is the "transcriptions" surface.
export const CAP_MODE: Record<CapId, string> = {
  stt: "stt",
  align: "align",
  translate: "translate",
  vad: "vad",
  diar: "diar",
  enhance: "enhance",
  embed: "embed",
};

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
