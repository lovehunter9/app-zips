import type { ProviderModel, Settings } from "./types";

// Control headers consumed by the App Server proxy (see server.js).
function gwHeaders(s: Settings, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (s.base) h["X-GW-Base"] = s.base.replace(/\/+$/, "");
  if (s.key) h["X-GW-Key"] = s.key;
  if (s.bflUser) h["X-GW-BflUser"] = s.bflUser;
  if (s.cookie) h["X-GW-Cookie"] = s.cookie;
  return h;
}

async function readBody(r: Response): Promise<any> {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

// ---- console (SSO): list models with mode ----
const AUTH_REDIRECT_MSG = "未认证(被重定向到 SSO 登录)。请在设置里填入有效的 Olares Cookie 后重试。";
function throwIfAuthRedirect(r: Response) {
  if (r.type === "opaqueredirect" || r.status === 0 || (r.status >= 301 && r.status <= 308)) {
    throw new Error(AUTH_REDIRECT_MSG);
  }
}

export async function fetchProviderModels(s: Settings): Promise<ProviderModel[]> {
  const r = await fetch("/api/gw/console/api/provider-models?limit=1000", {
    headers: gwHeaders(s),
    credentials: "include",
    redirect: "manual",
  });
  throwIfAuthRedirect(r);
  const body = await readBody(r);
  if (!r.ok) throw new Error(`provider-models ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  // tolerate {items:[...]} / {data:[...]} / [...] shapes
  const arr: any[] = Array.isArray(body) ? body : body.items || body.data || body.models || [];
  // AdminModelRow nests the model fields under `model` (provider ctx at top level).
  return arr.map((row) => {
    const m = row.model ?? row;
    return {
      id: m.id ?? row.provider_model_id,
      name: m.name ?? m.model ?? m.id,
      mode: m.mode ?? row.mode,
      provider_id: row.provider_id ?? m.provider_id,
      provider_name: row.provider_name ?? row.provider,
      enabled: m.enabled ?? row.enabled,
      status: m.status ?? row.status,
    };
  });
}

export async function fetchDefaultModels(s: Settings): Promise<Record<string, string>> {
  try {
    const r = await fetch("/api/gw/console/api/default-models", {
      headers: gwHeaders(s),
      credentials: "include",
      redirect: "manual",
    });
    if (!r.ok || r.type === "opaqueredirect" || r.status === 0) return {};
    const body = await readBody(r);
    const out: Record<string, string> = {};
    const arr: any[] = Array.isArray(body) ? body : body.items || body.data || [];
    for (const d of arr) {
      const mode = d.mode;
      const name = d.model_name ?? d.name ?? d.provider_model_name;
      if (mode && name) out[mode] = name;
    }
    return out;
  } catch {
    return {};
  }
}

// ---- data plane (Bearer): audio capabilities ----
export interface CallResult {
  status: number;
  ok: boolean;
  durationMs: number;
  contentType: string;
  json?: any;
  blob?: Blob;
  text?: string;
}

async function dataCall(
  s: Settings,
  path: string,
  init: RequestInit,
  wantBlob = false
): Promise<CallResult> {
  const t0 = performance.now();
  const r = await fetch("/api/gw" + path, {
    ...init,
    headers: gwHeaders(s, (init.headers as Record<string, string>) || {}),
    credentials: "include",
    redirect: "manual",
  });
  const durationMs = Math.round(performance.now() - t0);
  if (r.type === "opaqueredirect" || r.status === 0) {
    return { status: 0, ok: false, durationMs, contentType: "", text: AUTH_REDIRECT_MSG };
  }
  const ct = r.headers.get("content-type") || "";
  const res: CallResult = { status: r.status, ok: r.ok, durationMs, contentType: ct };
  if (wantBlob && r.ok && !ct.includes("application/json")) {
    res.blob = await r.blob();
  } else if (ct.includes("application/json")) {
    res.json = await readBody(r);
  } else {
    res.text = await r.text();
  }
  return res;
}

// Uncompressed WAV blows past the Olares edge's request-body limit (a 1h 16k mono
// clip ≈ 115 MB → 413 from envoy). Round large clips through the app server's ffmpeg
// to 16k mono MP3 before sending. Small slices (STT 30s windows ≈ 1 MB) pass untouched.
const EDGE_SAFE_BYTES = 8 * 1024 * 1024;

export async function transcodeToMp3(blob: Blob): Promise<Blob> {
  const r = await fetch("/api/transcode", {
    method: "POST",
    headers: { "content-type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!r.ok) throw new Error(`transcode ${r.status}`);
  return r.blob();
}

async function edgeSafe(file: Blob): Promise<Blob> {
  if (/mpeg|mp3|ogg|opus|m4a|aac/i.test(file.type)) return file; // already compressed
  if (file.size <= EDGE_SAFE_BYTES) return file; // small enough for the edge
  try {
    return await transcodeToMp3(file);
  } catch {
    return file; // best effort — let the gateway respond if it still can't
  }
}

export async function audioMultipart(
  s: Settings,
  op: string,
  file: Blob,
  model: string,
  extra: Record<string, string> = {},
  wantBlob = false,
  // STT must keep WAV: the vLLM transcription engines decode via libsndfile/soundfile,
  // which can't read MP3 → 400 "Invalid or unsupported audio file". So callers that send
  // already-edge-safe WAV (STT windows ≤25 MB) skip the >8 MB → MP3 transcode.
  skipEdgeSafe = false
): Promise<CallResult> {
  const sendable = skipEdgeSafe ? file : await edgeSafe(file);
  const fd = new FormData();
  fd.append("file", sendable, /mpeg|mp3/i.test(sendable.type) ? "audio.mp3" : "audio.wav");
  fd.append("model", model);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return dataCall(s, `/v1/audio/${op}`, { method: "POST", body: fd }, wantBlob);
}

export function translate(
  s: Settings,
  model: string,
  text: string,
  target: string,
  source?: string
): Promise<CallResult> {
  const body: Record<string, unknown> = { model, text, target };
  if (source) body.source = source;
  return dataCall(s, "/v1/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function uploadMedia(
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ id: string; kind: string; originalName: string; durationSec: number | null }> {
  // XHR (not fetch) so we get byte-level upload progress events. fetch() has no
  // upload-progress API in browsers yet.
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.upload.onload = () => onProgress?.(100); // bytes done; server may still extract
    xhr.onload = () => {
      let body: any;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(`upload ${xhr.status}: ${JSON.stringify(body)}`));
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(fd);
  });
}

export async function fetchUploadAudio(id: string): Promise<Blob> {
  const r = await fetch(`/api/upload/${id}/audio`);
  if (!r.ok) throw new Error(`fetch audio ${r.status}`);
  return r.blob();
}

export interface SilenceResult {
  duration: number;
  speech: { start: number; end: number }[];
  silence: { start: number; end: number }[];
}

// Non-AI voiced-timeline detection via the app server's ffmpeg `silencedetect` filter.
// Used only to give whole-clip STT (no VAD/Diarize) a timeline for timestamp
// post-processing — no model involved.
export async function fetchSilences(
  id: string,
  opts: { noise?: string; d?: number } = {}
): Promise<SilenceResult> {
  const q = new URLSearchParams();
  if (opts.noise) q.set("noise", opts.noise);
  if (opts.d != null) q.set("d", String(opts.d));
  const r = await fetch(`/api/upload/${id}/silences${q.toString() ? "?" + q.toString() : ""}`);
  if (!r.ok) throw new Error(`silences ${r.status}`);
  return r.json();
}
