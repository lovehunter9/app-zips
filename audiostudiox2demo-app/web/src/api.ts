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
// JSON string; some shapes surface a flat `supports` object/array directly. Returns
// the truthy keys, bare: the wire carries supports_stt, a capability is named stt.
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
  const bare = (k: any) => String(k).replace(/^supports_/, "");
  if (Array.isArray(sup)) return sup.map(bare);
  if (typeof sup === "object") return Object.keys(sup).filter((k) => !!sup[k]).map(bare);
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

// ---- run lifecycle / stop ----
// The workflow used to be unstoppable: the button only disabled itself and every
// call ran to the end. Async tasks give us something to stop with — abort the
// in-flight fetches AND tell the engine to drop the tasks, so a wrong model or a
// wrong file doesn't keep the GPU for another ten minutes.
export const STOPPED_MSG = "已停止";
let runAbort: AbortController | null = null;
const liveTasks = new Map<string, string>(); // task id -> model (the poll/cancel needs ?model=)

export function beginRun(): void {
  runAbort = new AbortController();
  liveTasks.clear();
}
export function endRun(): void {
  runAbort = null;
  liveTasks.clear();
}
export function isStopped(): boolean {
  return runAbort?.signal.aborted ?? false;
}
export function stopRun(s: Settings): void {
  const ids = [...liveTasks.entries()];
  liveTasks.clear();
  runAbort?.abort();
  // `unstoppable`: these requests must reach the engine, so they don't ride the
  // signal we just aborted.
  for (const [id, model] of ids) {
    void dataCall(s, `/v1/audio/tasks/${encodeURIComponent(id)}?model=${encodeURIComponent(model)}`,
      { method: "DELETE" }, false, true);
  }
}

async function dataCall(
  s: Settings,
  path: string,
  init: RequestInit,
  wantBlob = false,
  unstoppable = false
): Promise<CallResult> {
  await _acquireData();
  const t0 = performance.now();
  try {
    const r = await fetch("/api/gw" + path, {
      ...init,
      headers: gwHeaders(s, (init.headers as Record<string, string>) || {}),
      credentials: "include",
      redirect: "manual",
      signal: unstoppable ? undefined : runAbort?.signal,
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
  } catch (e: any) {
    // A stop aborts every in-flight fetch. Report it as a call result instead of
    // throwing, so the ledger shows 已停止 on the step that was running and the
    // later stages simply don't start.
    if (isStopped() && (e?.name === "AbortError" || String(e).includes("abort"))) {
      return { status: 0, ok: false, durationMs: Math.round(performance.now() - t0), contentType: "", text: STOPPED_MSG };
    }
    throw e;
  } finally {
    _releaseData();
  }
}

// Uncompressed WAV blows past the Olares edge's request-body limit (a 1h 16k mono
// clip ≈ 115 MB → 413 from envoy). Round large clips through the app server's ffmpeg
// to 16k mono MP3 before sending. Small slices (STT 30s windows ≈ 1 MB) pass untouched.
const EDGE_SAFE_BYTES = Math.floor(31.8 * 1024 * 1024); // ~200KB under the gateway nginx 32M body cap

// Upload byte budget for batch sub-clips: 16k mono WAV = 32 KB/s; keep each POST body
// under the gateway nginx 32M cap (target 30M ≈ ~15.6 min of audio per batch).
export const WAV_BYTES_PER_SEC = 16000 * 2;
export const BATCH_TARGET_BYTES = 30 * 1024 * 1024;

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
  if (file.size <= EDGE_SAFE_BYTES) return file; // under the 32M edge cap — 能不压就不压
  // Over the cap: shrink even if the source is ALREADY compressed — a multi-hour mp3
  // (e.g. a 3h22m clip ≈ 194 MB) still 413s, so re-encode to a duration-fit bitrate
  // (the app server derives kbps from the clip length) instead of passing it through.
  try {
    return await transcodeToMp3(file);
  } catch {
    return file; // best effort — let the gateway respond if it still can't
  }
}

// ---- async task mode ----
// A capability POST carrying `async=1` is answered with 202 + a task id instead
// of the result, and polling that task reports the engine's OWN progress (stage
// + done/total). Two things it buys this demo: a long clip no longer rides on
// one held-open request through every hop, and the progress bar can show what
// the engine is actually doing instead of a pulsing placeholder.
//
// It needs the gateway's task routes (v2.0.12-test1) and an engine that honours
// the flag; both degrade on their own. An engine that ignores it answers 200
// with the result, and a gateway without the routes 404s the poll — which turns
// the mode off for the page and retries the call synchronously.
export interface TaskProgress {
  stage?: string;
  ratio?: number;
  done?: number;
  total?: number;
}
export type TaskProgressFn = (p: TaskProgress | null, status: string) => void;
export interface AudioOpts {
  onProgress?: TaskProgressFn;
}

let asyncTasks = true;
const TASK_POLL_MS = 1500;

// An engine 404 names the task it couldn't find; a gateway without the routes
// answers gin's plain "404 page not found" or an envelope about the route.
function missingTaskAPI(res: CallResult): boolean {
  const body = res.text || JSON.stringify(res.json ?? "");
  return res.status === 404 && !/no such task/i.test(body);
}

// Poll one submitted task to a terminal state and return its result shaped like
// an ordinary CallResult, so callers can't tell which mode ran.
async function awaitTask(
  s: Settings,
  op: string,
  model: string,
  submitted: any,
  wantBlob: boolean,
  startedAt: number,
  onProgress?: TaskProgressFn
): Promise<CallResult | "no-task-api"> {
  const id = (submitted?.task || submitted)?.id;
  if (!id) throw new Error(`${op}: 202 without a task id`);
  const q = `?model=${encodeURIComponent(model)}`;
  const took = () => Math.round(performance.now() - startedAt);
  // Registered so 停止 can cancel it upstream, not just abandon it here.
  liveTasks.set(id, model);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, TASK_POLL_MS));
      const poll = await dataCall(s, `/v1/audio/tasks/${encodeURIComponent(id)}${q}`, { method: "GET" });
      if (missingTaskAPI(poll)) return "no-task-api";
      if (!poll.ok) return { ...poll, durationMs: took() };
      const doc = poll.json || {};
      onProgress?.(doc.progress || null, String(doc.status || ""));
      if (doc.status === "failed" || doc.status === "canceled") {
        const msg = doc.error?.message || doc.status;
        return { status: doc.error?.code || 500, ok: false, durationMs: took(), contentType: "", text: `${op}: ${msg}` };
      }
      if (doc.status !== "succeeded") continue;
      if (!wantBlob && doc.result_kind === "json" && doc.result != null) {
        return { status: 200, ok: true, durationMs: took(), contentType: "application/json", json: doc.result };
      }
      const got = await dataCall(s, `/v1/audio/tasks/${encodeURIComponent(id)}/result${q}`, { method: "GET" }, wantBlob);
      return { ...got, durationMs: took() };
    }
  } finally {
    liveTasks.delete(id);
  }
}

// One audio call, async-first. `buildForm` is a callback because a body can only
// be sent once and the async→sync fallback needs a second one.
async function audioCall(
  s: Settings,
  op: string,
  model: string,
  buildForm: () => FormData,
  wantBlob: boolean,
  onProgress?: TaskProgressFn
): Promise<CallResult> {
  for (;;) {
    const startedAt = performance.now();
    const useAsync = asyncTasks;
    const fd = buildForm();
    if (useAsync) fd.append("async", "1");
    const res = await dataCall(s, `/v1/audio/${op}`, { method: "POST", body: fd }, wantBlob);
    if (res.status !== 202) return res;
    const settled = await awaitTask(s, op, model, res.json, wantBlob, startedAt, onProgress);
    if (settled !== "no-task-api") return settled;
    asyncTasks = false;
    console.warn(`[gw] 网关没有任务 API，本页改回同步调用（${op}）`);
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
  skipEdgeSafe = false,
  opts: AudioOpts = {}
): Promise<CallResult> {
  const sendable = skipEdgeSafe ? file : await edgeSafe(file);
  return audioCall(s, op, model, () => {
    const fd = new FormData();
    fd.append("file", sendable, /mpeg|mp3/i.test(sendable.type) ? "audio.mp3" : "audio.wav");
    fd.append("model", model);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fd;
  }, wantBlob, opts.onProgress);
}

// Batch audio op (分段批量): POST /v1/audio/<op> with the sub-clip WAV + a `segments`
// JSON array (start/end RELATIVE to the sub-clip). The base wrapper decodes once, slices
// per segment, runs each, returns {results:[…]} in order. Returns that array. Always WAV,
// never edgeSafe (sub-clips are packed under the 32M body cap on purpose).
export async function audioBatch(
  s: Settings,
  op: "transcriptions" | "align",
  file: Blob,
  segments: object[],
  model: string,
  extra: Record<string, string> = {},
  opts: AudioOpts = {}
): Promise<any[]> {
  const res = await audioCall(s, op, model, () => {
    const fd = new FormData();
    fd.append("file", file, "audio.wav");
    fd.append("model", model);
    fd.append("segments", JSON.stringify(segments));
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fd;
  }, false, opts.onProgress);
  if (!res.ok) throw new Error(`${op} batch ${res.status}: ${(res.text || JSON.stringify(res.json) || "").slice(0, 200)}`);
  return Array.isArray(res.json?.results) ? res.json.results : [];
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
  language?: string,
  opts: AudioOpts = {}
): Promise<CallResult> {
  const extra: Record<string, string> = { text };
  if (language) extra.language = language;
  return audioMultipart(s, "align", clip, model, extra, false, true, opts);
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
