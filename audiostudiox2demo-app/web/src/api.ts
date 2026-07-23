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

// The public Olares edge/tunnel intermittently resets the connection (ECONNRESET / 502 /
// 530 before TLS was even established) — an INFRA blip, unrelated to any model. The app
// server surfaces it as a 502 JSON response, so retry idempotent console GETs a few times
// with backoff (mirrors the data-plane callRetry) so a single edge hiccup doesn't fail the
// whole "refresh models / test connection". Auth redirects (status 0 / 3xx) are NOT retried.
async function consoleGetRetry(url: string, s: Settings, tries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: gwHeaders(s), credentials: "include", redirect: "manual" });
      if (r.status >= 500 && i < tries - 1) {
        await new Promise((res) => setTimeout(res, 600 * Math.pow(2, i)));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        await new Promise((res) => setTimeout(res, 600 * Math.pow(2, i)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

export async function fetchProviderModels(s: Settings): Promise<ProviderModel[]> {
  // The admin-list endpoint (/console/api/provider-models) is a LIGHT projection
  // that omits model_spec.supports — so it can't drive supports-based discovery.
  // The provider DETAIL endpoint (/console/api/providers/:id) DOES return each
  // inline model WITH `supports` ({key:bool}). So we list providers, then fetch
  // each provider's detail and flatten its models (carrying supports).
  const rp = await consoleGetRetry("/api/gw/console/api/providers", s);
  throwIfAuthRedirect(rp);
  const pbody = await readBody(rp);
  if (!rp.ok) throw new Error(`providers ${rp.status}: ${JSON.stringify(pbody).slice(0, 300)}`);
  const provs: any[] = Array.isArray(pbody) ? pbody : pbody.items || pbody.data || pbody.providers || [];

  const out: ProviderModel[] = [];
  for (const p of provs) {
    const pid = p.id ?? p.provider_id;
    if (!pid) continue;
    let detail: any;
    try {
      const rd = await consoleGetRetry(`/api/gw/console/api/providers/${pid}`, s);
      if (!rd.ok) continue;
      detail = await readBody(rd);
    } catch {
      continue; // one bad provider shouldn't fail the whole refresh
    }
    const models: any[] = detail?.models || detail?.model || [];
    for (const m of models) {
      out.push({
        id: m.id ?? m.provider_model_id,
        name: m.name ?? m.model ?? m.id,
        mode: m.mode,
        supports: extractSupports(m ?? {}),
        provider_id: pid,
        provider_name: detail?.name ?? p.name,
        enabled: m.enabled,
        status: m.status,
      });
    }
  }
  return out;
}

// extractSupports reads the audio capability keys off a model row. The console
// serves supports under model_spec.supports (a {key:bool} map), possibly as a raw
// JSON string; some shapes surface a flat `supports` object/array directly. Return
// the keys whose value is truthy.
function extractSupports(m: any): string[] {
  let sup = m?.supports ?? m?.model_spec?.supports ?? m?.modelSpec?.supports;
  if (typeof m?.model_spec === "string") {
    try {
      sup = JSON.parse(m.model_spec)?.supports ?? sup;
    } catch {
      /* ignore */
    }
  }
  if (!sup) return [];
  if (Array.isArray(sup)) return sup.map(String);
  if (typeof sup === "object") return Object.keys(sup).filter((k) => !!sup[k]);
  return [];
}

export async function fetchDefaultModels(s: Settings): Promise<Record<string, string>> {
  try {
    const r = await consoleGetRetry("/api/gw/console/api/default-models", s);
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

// Global cap on concurrent data-plane HTTP calls. The browser allows only ~6
// connections per origin; when every capability fires at once (STT fan-out + align +
// vad/diar/embed/enhance/translate) the requests beyond that queue INSIDE the browser
// as raw sockets, and a socket that waits long enough behind a slow call (e.g. enhance
// returning a 100+ MB WAV over ~60s) gets reset → "socket hang up" / ECONNRESET. Gating
// here keeps total in-flight below the browser limit, so overflow waits as a pending
// PROMISE (cheap, reset-proof) instead of a reset-prone queued socket.
// 2, not 5: on the shared/over-subscribed vGPU (many audio instances resident),
// running 5 heavy inferences at once thrashes GPU memory and starves each one — a
// single enhance ballooned to ~5min and hit the ~300s edge timeout. Capping active
// data-plane calls at 2 gives each inference a big enough time-slice to finish well
// under the timeout; total run is a bit slower but it completes.
const MAX_DATA_INFLIGHT = 2;
let _dataInflight = 0;
const _dataQueue: (() => void)[] = [];
function _acquireData(): Promise<void> {
  if (_dataInflight < MAX_DATA_INFLIGHT) {
    _dataInflight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => _dataQueue.push(resolve));
}
function _releaseData(): void {
  const next = _dataQueue.shift();
  if (next) next(); // hand the slot straight to the next waiter (inflight unchanged)
  else _dataInflight--;
}

async function dataCall(
  s: Settings,
  path: string,
  init: RequestInit,
  wantBlob = false
): Promise<CallResult> {
  await _acquireData();
  const t0 = performance.now();
  try {
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
  } finally {
    _releaseData();
  }
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

// MTran-style translate via the gateway TEMP passthrough: POST /v1/translate?model=<name>.
// Body {from,to,text}; from "" / "auto" => the model auto-detects. Response {result}.
// (Codes are MTran, e.g. zh-Hans/en — see floresToMtran in App.tsx.)
export function translate(
  s: Settings,
  model: string,
  from: string,
  to: string,
  text: string
): Promise<CallResult> {
  const q = model ? `?model=${encodeURIComponent(model)}` : "";
  return dataCall(s, `/v1/translate${q}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: from || "auto", to, text }),
  });
}

// Batch translate: POST /v1/translate/batch?model=<name>, ONE call for all texts.
// Body {from,to,texts[]}; response {results[]} in the same order as texts.
export function translateBatch(
  s: Settings,
  model: string,
  from: string,
  to: string,
  texts: string[]
): Promise<CallResult> {
  const q = model ? `?model=${encodeURIComponent(model)}` : "";
  return dataCall(s, `/v1/translate/batch${q}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: from || "auto", to, texts }),
  });
}

// Forced alignment (mode=align): audio + known text -> precise char/word
// timestamps. Multipart like the other audio ops but carries a `text` field
// (and optional `language`). Gateway routes POST /v1/audio/align to the
// Qwen3-ForcedAligner provider. Callers pass a WAV slice (skipEdgeSafe) so the
// engine decode path matches what STT uses.
export function alignAudio(
  s: Settings,
  model: string,
  clip: Blob,
  text: string,
  language?: string
): Promise<CallResult> {
  const extra: Record<string, string> = { text };
  if (language) extra.language = language;
  return audioMultipart(s, "align", clip, model, extra, false, true);
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
