import type { GatewayConfig, ModelOpt, QaState, QaTurn, RecordFull, RecordOptions, RecordSummary, Word } from "./types";

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

// 智能摘要: generate (POST, optional model override) or clear (DELETE). Returns the
// updated record (with `summary` populated / removed).
export const summarizeRecord = (id: string, model?: string) =>
  jsend<RecordFull>(`/api/records/${id}/summary`, "POST", model ? { model } : {});
export const clearSummary = (id: string) =>
  jsend<RecordFull>(`/api/records/${id}/summary`, "DELETE");

// 智能问答 / RAG: (re)build the vector index, ask a question (retrieval + grounded
// answer with clickable citations), or clear the index + conversation history.
export const buildQaIndex = (id: string, embedModel?: string) =>
  jsend<RecordFull>(`/api/records/${id}/qa/index`, "POST", embedModel ? { embedModel } : {});
export const askQuestion = (id: string, question: string, opts?: { model?: string; embedModel?: string }) =>
  jsend<{ turn: QaTurn; qa: QaState }>(`/api/records/${id}/qa`, "POST", { question, ...(opts ?? {}) });
export const clearQa = (id: string) =>
  jsend<RecordFull>(`/api/records/${id}/qa`, "DELETE");

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
    // Big files over a flaky gateway can take a while; the server now replies the
    // instant the bytes land (no inline ffmpeg), so we don't need a short timeout.
    xhr.timeout = 0;
    let reached = 0; // fraction of bytes the browser confirmed it sent
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        reached = e.loaded / e.total;
        if (onProgress) onProgress(reached * 100);
      }
    };
    xhr.onload = () => {
      let body: any;
      try { body = JSON.parse(xhr.responseText); } catch { body = xhr.responseText; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error || `上传失败（HTTP ${xhr.status}）`));
    };
    // Distinguish "bytes never finished" (true transport drop) from "bytes sent but
    // no response" (gateway/server didn't reply in time) — the latter usually means
    // the file DID arrive, so tell the user to refresh rather than blindly retry.
    xhr.onerror = () =>
      reject(new Error(
        reached >= 1
          ? "文件已上传，但服务器未及时响应（可能是网关超时）。文件可能已在处理，请刷新列表查看；若未出现再重试。"
          : `上传中断（网络错误，已发送约 ${Math.round(reached * 100)}%）。请检查网络后重试。`
      ));
    xhr.ontimeout = () => reject(new Error("上传超时，请重试。"));
    xhr.onabort = () => reject(new Error("上传已取消。"));
    xhr.send(fd);
  });
}
