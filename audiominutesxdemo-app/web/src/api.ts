import type { GatewayConfig, ModelOpt, RecordFull, RecordOptions, RecordSummary, Word } from "./types";

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const t = await r.text();
  let body: any;
  try { body = JSON.parse(t); } catch { body = t; }
  if (!r.ok) throw new Error(body?.error || `${url} -> ${r.status}`);
  return body as T;
}

async function jsend<T>(url: string, method: string, payload?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: payload !== undefined ? { "content-type": "application/json" } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const t = await r.text();
  let body: any;
  try { body = JSON.parse(t); } catch { body = t; }
  if (!r.ok) throw new Error(body?.error || `${url} -> ${r.status}`);
  return body as T;
}

export const getConfig = () => jget<GatewayConfig>("/api/config");
export const putConfig = (cfg: Partial<GatewayConfig>) => jsend<GatewayConfig>("/api/config", "PUT", cfg);

export const getModels = () => jget<{ modes: Record<string, ModelOpt[]>; error?: string }>("/api/models");

export const listRecords = () => jget<{ records: RecordSummary[] }>("/api/records");
export const getRecord = (id: string) => jget<RecordFull>(`/api/records/${id}`);
export const deleteRecord = (id: string) => jsend<{ ok: boolean }>(`/api/records/${id}`, "DELETE");
export const transcribeRecord = (id: string, opts?: Partial<RecordOptions>) =>
  jsend<{ ok: boolean }>(`/api/records/${id}/transcribe`, "POST", opts ?? {});
export const translateRecord = (id: string) =>
  jsend<{ ok: boolean }>(`/api/records/${id}/translate`, "POST", {});

// Save manual edits (transcript editor): per-segment text/translation/speaker,
// speaker display names, and the participant roster. Returns the updated record.
export interface ResultPatch {
  // When `words`/`twords` are provided, the server uses them verbatim (sentence-unit
  // editing recomputes only the changed sentences' timings client-side); otherwise it
  // re-derives word timings from `text`/`translation`.
  segments?: { text?: string; translation?: string; speaker?: string; words?: Word[]; twords?: Word[] }[];
  speakerNames?: Record<string, string>;
  participants?: string[];
  speakerColors?: Record<string, string>;
}
export const saveResult = (id: string, patch: ResultPatch) =>
  jsend<RecordFull>(`/api/records/${id}/result`, "PATCH", patch);
export const cancelRecord = (id: string) =>
  jsend<{ ok: boolean }>(`/api/records/${id}/cancel`, "POST", {});
export const rediarize = (id: string, speakers: number) =>
  jsend<{ ok: boolean }>(`/api/records/${id}/rediarize`, "POST", { speakers });
// 创建片段: cut one or more [start,end] ranges from a done record into a new
// independent record (generated async). Returns the new clip's summary.
export const createClip = (id: string, ranges: { start: number; end: number }[], title?: string, continuous?: boolean) =>
  jsend<RecordSummary>(`/api/records/${id}/clip`, "POST", { ranges, title, continuous });
export const deleteNotice = (id: string, idx: number) =>
  jsend<RecordFull>(`/api/records/${id}/notices/${idx}`, "DELETE");
export const clearNotices = (id: string) =>
  jsend<RecordFull>(`/api/records/${id}/notices`, "DELETE");

export function uploadBackground(file: File): Promise<GatewayConfig> {
  const fd = new FormData();
  fd.append("file", file);
  return fetch("/api/background", { method: "POST", body: fd }).then(async (r) => {
    const t = await r.text();
    let b: any; try { b = JSON.parse(t); } catch { b = t; }
    if (!r.ok) throw new Error(b?.error || `background ${r.status}`);
    return b as GatewayConfig;
  });
}
export const deleteBackground = () => jsend<GatewayConfig>("/api/background", "DELETE");

// Cover: set from a captured video frame (base64 data URL) or an uploaded file;
// or clear it (revert to the default kind-based tile).
export const setCoverDataUrl = (id: string, dataUrl: string) =>
  jsend<RecordSummary>(`/api/records/${id}/cover`, "POST", { dataUrl });
export function uploadCover(id: string, file: File): Promise<RecordSummary> {
  const fd = new FormData();
  fd.append("file", file);
  return fetch(`/api/records/${id}/cover`, { method: "POST", body: fd }).then(async (r) => {
    const t = await r.text();
    let b: any; try { b = JSON.parse(t); } catch { b = t; }
    if (!r.ok) throw new Error(b?.error || `cover ${r.status}`);
    return b as RecordSummary;
  });
}
export const deleteCover = (id: string) => jsend<RecordSummary>(`/api/records/${id}/cover`, "DELETE");

export function uploadFile(
  file: File,
  onProgress?: (pct: number) => void
): Promise<RecordSummary> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      let body: any;
      try { body = JSON.parse(xhr.responseText); } catch { body = xhr.responseText; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error || `upload ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(fd);
  });
}
