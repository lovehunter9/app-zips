// Live streaming STT view (mode=stt_stream, WebSocket).
//
// This capability is intentionally STANDALONE — it does not compose with the
// offline file-analysis capabilities (STT/VAD/Diar/Align/…), which all need the
// WHOLE clip or a global timeline. Streaming is real-time: audio in, partial
// text out as it arrives, one final at the end.
//
// Transport: the browser WebSocket API cannot set request headers, and the
// gateway's stt_stream data plane authenticates by Authorization: Bearer only.
// So we smuggle the gateway base/key/cookie as query params (__base/__key/
// __cookie); the App Server proxy (server.js) reads them, injects the real
// Authorization/Cookie headers on the upstream handshake, and strips them.
//
// Wire protocol (see audiolabxv3 wrappers.yaml stream.py):
//   -> TEXT   {"type":"start","language":null,"sample_rate":16000,"step_ms":500}
//   -> BINARY raw PCM16LE mono @ sample_rate chunks
//   -> TEXT   {"type":"stop"}
//   <- TEXT   {"type":"ready"}
//   <- TEXT   {"type":"partial","text":<cumulative>,"language":...}   (each step)
//   <- TEXT   {"type":"final","text":<full>,"language":...}           (once, at end)
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderModel, Settings } from "./types";
import { decodeAudio } from "./audio";

const TARGET_SR = 16000;
const STEP_MS = 500;
const CHUNK_SAMPLES = (TARGET_SR * STEP_MS) / 1000; // 8000 samples / 500ms

// Linear resample to 16k mono (good enough for ASR; matches the engine's own path).
function resampleTo16k(data: Float32Array, from: number): Float32Array {
  if (from === TARGET_SR || data.length === 0) return data;
  const ratio = TARGET_SR / from;
  const outLen = Math.max(1, Math.round(data.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(data.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = data[i0] * (1 - frac) + data[i1] * frac;
  }
  return out;
}

function floatToPcm16(f: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(f.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return buf;
}

function buildWsUrl(settings: Settings, model: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const p = new URLSearchParams();
  p.set("model", model);
  if (settings.base) p.set("__base", settings.base.replace(/\/+$/, ""));
  if (settings.key) p.set("__key", settings.key);
  if (settings.cookie) p.set("__cookie", settings.cookie);
  return `${proto}//${location.host}/api/gw/v1/audio/stream?${p.toString()}`;
}

// The engine sends the CUMULATIVE transcript in every partial. To get a rolling
// subtitle feel we split at sentence boundaries: complete sentences settle into
// stacked lines, the trailing fragment is the live (interim) line.
const SENT_END = /[。．\.！!？\?…\n]+/;
function splitSentences(text: string): { committed: string[]; tail: string } {
  const t = (text || "").trim();
  if (!t) return { committed: [], tail: "" };
  const parts: string[] = [];
  let buf = "";
  for (const ch of t) {
    buf += ch;
    if (SENT_END.test(ch)) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  return { committed: parts.filter(Boolean), tail: buf.trim() };
}

// mm:ss (or h:mm:ss past an hour) — caption-style timecode.
function fmtTC(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(ss).padStart(2, "0")}`;
}

type Status = "idle" | "connecting" | "streaming" | "stopping" | "done" | "error";
type Source = "file" | "mic";

export function StreamView({
  settings,
  models,
  defaults,
}: {
  settings: Settings;
  models: ProviderModel[];
  defaults: Record<string, string>;
}) {
  const streamModels = useMemo(
    () => models.filter((m) => m.mode === "stt_stream"),
    [models]
  );
  const [model, setModel] = useState<string>("");
  useEffect(() => {
    // Only auto-fill from what the gateway actually returned; never pre-seed a
    // guessed model name. If nothing is available yet the select stays on its
    // "(无 stt_stream 模型 — 先刷新)" placeholder (models come ONLY from the gateway).
    if (model) return;
    const pick = defaults["stt_stream"] || streamModels[0]?.name || "";
    if (pick) setModel(pick);
  }, [defaults, streamModels, model]);

  const [source, setSource] = useState<Source>("file");
  const [status, setStatus] = useState<Status>("idle");
  const [err, setErr] = useState<string>("");
  const [language, setLanguage] = useState<string>("");
  const [committed, setCommitted] = useState<string[]>([]);
  const [interim, setInterim] = useState<string>("");
  const [elapsed, setElapsed] = useState<number>(0);
  const [level, setLevel] = useState<number>(0);
  const [file, setFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string>("");
  const [isVideo, setIsVideo] = useState<boolean>(false);
  // Timecoded captions. DERIVED in the demo from the audio clock the demo itself
  // drives (file = media.currentTime, mic = wall time since start) — the base
  // stt_stream model has NO native timestamps, so we never fake one on the base;
  // this stays a consumer-side convenience. (When diar_stream lands it will FORCE
  // this on, since speaker fusion needs the ASR timeline.)
  const [showTimecode, setShowTimecode] = useState<boolean>(true);
  const [capTimes, setCapTimes] = useState<number[]>([]); // audio-sec per committed line
  const capTimesRef = useRef<number[]>([]);
  const t0Ref = useRef<number>(0); // performance.now() at stream start (mic clock base)

  const wsRef = useRef<WebSocket | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const stopFileRef = useRef<boolean>(false);
  const stopSentRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // File-session state kept in refs so a seek can restart the stream at a new
  // position: pcmRef = decoded 16k mono PCM; sentRef = samples already streamed;
  // runningRef = an active file session is live (gate the seek handler);
  // seekTimerRef = debounce rapid native "seeked" events.
  const pcmRef = useRef<Float32Array | null>(null);
  const sentRef = useRef<number>(0);
  const runningRef = useRef<boolean>(false);
  const seekTimerRef = useRef<number | null>(null);

  // Current on-screen caption = the live (interim) fragment, else the last settled line.
  const currentCaption = interim || (committed.length ? committed[committed.length - 1] : "");

  function onPickFile(f: File | null) {
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    setFile(f);
    setMediaUrl(f ? URL.createObjectURL(f) : "");
    setIsVideo(!!f && f.type.startsWith("video/"));
    reset();
  }

  useEffect(() => {
    // autoscroll to the latest line
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [committed, interim]);

  useEffect(() => () => cleanup(), []); // unmount

  function cleanup() {
    runningRef.current = false;
    if (seekTimerRef.current) { clearTimeout(seekTimerRef.current); seekTimerRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    stopFileRef.current = true;
    try { nodeRef.current?.disconnect(); } catch {}
    nodeRef.current = null;
    try { micRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    micRef.current = null;
    try { acRef.current?.close(); } catch {}
    acRef.current = null;
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;
    if (mediaUrl) { try { URL.revokeObjectURL(mediaUrl); } catch {} }
  }

  // Demo-side audio clock (seconds): file follows the player head, mic uses wall
  // time since the stream started. Same clock we'd feed a future diar_stream, so
  // the two streams share a timeline for fusion.
  function audioClock(): number {
    const m = mediaRef.current;
    if (source === "file" && m && isFinite(m.currentTime)) return m.currentTime;
    return t0Ref.current ? (performance.now() - t0Ref.current) / 1000 : 0;
  }

  function applyPartial(text: string, lang?: string | null) {
    const { committed: c, tail } = splitSentences(text);
    // Stamp each NEWLY-settled sentence with the current audio clock (approx: the
    // engine emits ~1–2s behind the audio; fine for a caption timecode / fusion).
    const times = capTimesRef.current;
    if (c.length > times.length) {
      const now = audioClock();
      for (let i = times.length; i < c.length; i++) times.push(now);
      capTimesRef.current = times;
      setCapTimes([...times]);
    } else if (c.length < times.length) {
      times.length = c.length;
      capTimesRef.current = times;
      setCapTimes([...times]);
    }
    setCommitted(c);
    setInterim(tail);
    if (lang) setLanguage(lang);
  }

  async function openWs(): Promise<WebSocket> {
    if (!settings.key && !settings.cookie) {
      throw new Error("请先在『① Gateway 设置』填入 API Key(和本地调试用 Cookie)。");
    }
    if (!model.trim()) {
      throw new Error("请先选择流式模型(在『① Gateway 设置』测试连接/刷新模型)。");
    }
    const url = buildWsUrl(settings, model.trim());
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("连接网关超时(15s)")), 15000);
      ws.onopen = () => { clearTimeout(to); resolve(ws); };
      ws.onerror = () => { clearTimeout(to); reject(new Error("WebSocket 连接失败(网关/上游不可达或未授权)")); };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return; // superseded by a seek-restart
        if (typeof ev.data !== "string") return;
        let obj: any;
        try { obj = JSON.parse(ev.data); } catch { return; }
        if (obj.type === "partial") applyPartial(obj.text, obj.language);
        else if (obj.type === "final") { applyPartial(obj.text, obj.language); finish("done"); }
        else if (obj.type === "error") { setErr(obj.detail || "engine error"); finish("error"); }
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return; // an old session we intentionally replaced
        if (status === "streaming" || status === "stopping") finish("done");
      };
    });
  }

  function startTimer() {
    const t0 = performance.now();
    t0Ref.current = t0;
    setElapsed(0);
    timerRef.current = window.setInterval(() => setElapsed((performance.now() - t0) / 1000), 200);
  }

  function finish(s: Status) {
    runningRef.current = false;
    if (seekTimerRef.current) { clearTimeout(seekTimerRef.current); seekTimerRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    stopFileRef.current = true;
    try { mediaRef.current?.pause(); } catch {}
    try { nodeRef.current?.disconnect(); } catch {}
    nodeRef.current = null;
    try { micRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    micRef.current = null;
    try { acRef.current?.close(); } catch {}
    acRef.current = null;
    setLevel(0);
    setStatus(s);
  }

  function reset() {
    setCommitted([]); setInterim(""); setLanguage(""); setErr(""); setElapsed(0); setLevel(0);
    capTimesRef.current = []; setCapTimes([]);
  }

  function sendStopOnce(ws: WebSocket) {
    if (stopSentRef.current) return;
    stopSentRef.current = true;
    if (ws.readyState === WebSocket.OPEN) { setStatus("stopping"); ws.send(JSON.stringify({ type: "stop" })); }
  }

  // Playback-driven send: stream audio up to the media element's currentTime so the
  // captions track what the user is HEARING (only the engine's own latency behind).
  // Pausing the player pauses the stream; there's no timer drift. Guarded on ws
  // identity so a seek-restart's stale RAF loop stops immediately.
  function startPump(ws: WebSocket) {
    const pcm = pcmRef.current;
    if (!pcm) return;
    const media = mediaRef.current;
    const pump = () => {
      if (stopFileRef.current || wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
      const target = media && isFinite(media.currentTime)
        ? Math.floor(media.currentTime * TARGET_SR)
        : pcm.length;
      let peak = 0;
      while (sentRef.current < Math.min(target, pcm.length)) {
        const end = Math.min(pcm.length, sentRef.current + CHUNK_SAMPLES);
        const chunk = pcm.subarray(sentRef.current, end);
        for (let k = 0; k < chunk.length; k++) peak = Math.max(peak, Math.abs(chunk[k]));
        ws.send(floatToPcm16(chunk));
        sentRef.current = end;
      }
      setLevel(peak || 0);
      if (sentRef.current >= pcm.length) { setLevel(0); sendStopOnce(ws); return; }
      rafRef.current = requestAnimationFrame(pump);
    };
    rafRef.current = requestAnimationFrame(pump);
  }

  async function startFile() {
    if (!file) { setErr("请先选择一个音频/视频文件。"); return; }
    reset();
    setStatus("connecting");
    stopFileRef.current = false;
    stopSentRef.current = false;
    try {
      const dec = await decodeAudio(file);
      pcmRef.current = resampleTo16k(dec.data, dec.sampleRate);
      const media = mediaRef.current;
      if (media) { try { media.currentTime = 0; } catch {} }
      const ws = await openWs();
      if (wsRef.current !== ws) { try { ws.close(); } catch {} return; }
      sentRef.current = 0;
      setStatus("streaming");
      runningRef.current = true;
      startTimer();
      ws.send(JSON.stringify({ type: "start", language: null, sample_rate: TARGET_SR, step_ms: STEP_MS }));
      if (media) {
        media.onended = () => { const w = wsRef.current; if (w) sendStopOnce(w); };
        try { await media.play(); } catch { /* autoplay may be blocked; user can hit play, pump follows currentTime */ }
      }
      startPump(ws);
    } catch (e: any) {
      setErr(String(e?.message || e));
      finish("error");
    }
  }

  // Seek support: streaming ASR state is append-only (can't rewind the model), so a
  // scrub = tear down the current session and open a FRESH one that captions from the
  // dragged position onward. Prior lines are cleared (they belong to the old timeline).
  async function restartFileAt(sec: number) {
    if (!pcmRef.current) return;
    stopFileRef.current = false;
    stopSentRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    try { wsRef.current?.close(); } catch {} // old ws; its handlers are ws-identity guarded
    setCommitted([]); setInterim("");
    capTimesRef.current = []; setCapTimes([]); // timecodes belong to the old timeline
    setStatus("connecting");
    try {
      const ws = await openWs();
      if (wsRef.current !== ws) { try { ws.close(); } catch {} return; } // superseded again
      sentRef.current = Math.max(0, Math.floor(sec * TARGET_SR));
      setStatus("streaming");
      runningRef.current = true;
      ws.send(JSON.stringify({ type: "start", language: null, sample_rate: TARGET_SR, step_ms: STEP_MS }));
      startPump(ws);
    } catch (e: any) {
      setErr(String(e?.message || e));
      finish("error");
    }
  }

  function onSeeked() {
    if (source !== "file" || !runningRef.current || !pcmRef.current) return;
    // Debounce the burst of native "seeked" events fired while dragging.
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = window.setTimeout(() => {
      const media = mediaRef.current;
      if (!media || !runningRef.current || !pcmRef.current) return;
      restartFileAt(media.currentTime);
    }, 250);
  }

  async function startMic() {
    reset();
    setStatus("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      micRef.current = stream;
      // Ask the browser to hand us 16k directly when it can (avoids a resample).
      const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
      let ac: AudioContext;
      try { ac = new AC({ sampleRate: TARGET_SR }); } catch { ac = new AC(); }
      acRef.current = ac;
      const src = ac.createMediaStreamSource(stream);
      const node = ac.createScriptProcessor(4096, 1, 1);
      nodeRef.current = node;

      const ws = await openWs();
      setStatus("streaming");
      startTimer();
      ws.send(JSON.stringify({ type: "start", language: null, sample_rate: TARGET_SR, step_ms: STEP_MS }));

      let acc = new Float32Array(0);
      node.onaudioprocess = (ev) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = ev.inputBuffer.getChannelData(0);
        const res = ac.sampleRate === TARGET_SR ? input : resampleTo16k(new Float32Array(input), ac.sampleRate);
        let peak = 0;
        for (let k = 0; k < res.length; k++) peak = Math.max(peak, Math.abs(res[k]));
        setLevel(peak);
        const merged = new Float32Array(acc.length + res.length);
        merged.set(acc); merged.set(res, acc.length);
        acc = merged;
        while (acc.length >= CHUNK_SAMPLES) {
          const chunk = acc.subarray(0, CHUNK_SAMPLES);
          ws.send(floatToPcm16(chunk));
          acc = acc.subarray(CHUNK_SAMPLES);
        }
      };
      src.connect(node);
      node.connect(ac.destination); // required for onaudioprocess to fire
    } catch (e: any) {
      setErr(String(e?.message || e));
      finish("error");
    }
  }

  function stopMic() {
    const ws = wsRef.current;
    setStatus("stopping");
    try { nodeRef.current?.disconnect(); } catch {}
    nodeRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    try { micRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    micRef.current = null;
    setLevel(0);
  }

  function stopFile() {
    stopFileRef.current = true;
    runningRef.current = false;
    if (seekTimerRef.current) { clearTimeout(seekTimerRef.current); seekTimerRef.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    try { mediaRef.current?.pause(); } catch {}
    const ws = wsRef.current;
    setStatus("stopping");
    if (ws && ws.readyState === WebSocket.OPEN && !stopSentRef.current) {
      stopSentRef.current = true;
      ws.send(JSON.stringify({ type: "stop" }));
    }
  }

  const busy = status === "connecting" || status === "streaming" || status === "stopping";
  const statusLabel: Record<Status, string> = {
    idle: "空闲",
    connecting: "连接中…",
    streaming: "识别中…",
    stopping: "收尾中…",
    done: "完成",
    error: "错误",
  };
  const statusColor: Record<Status, string> = {
    idle: "text-neutral-400",
    connecting: "text-amber-400",
    streaming: "text-emerald-400",
    stopping: "text-amber-400",
    done: "text-sky-400",
    error: "text-red-400",
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">实时字幕 · Streaming STT</h2>
          <span className={`text-sm ${statusColor[status]}`}>● {statusLabel[status]}</span>
        </div>

        <p className="mb-4 text-xs leading-relaxed text-neutral-500">
          流式 STT 是<strong className="text-neutral-300">独立能力</strong>:音频边进、文本边出,与文件分析里的
          STT/VAD/分离/对齐等离线能力不组合(那些需要完整音频/全局时间轴)。经 LLM Gateway 的 WebSocket
          数据面(mode=stt_stream)实时转写。
        </p>

        {/* model */}
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-neutral-400">流式模型(mode=stt_stream)</span>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
              {streamModels.length === 0 && <option value="">(无 stt_stream 模型 — 先刷新)</option>}
              {streamModels.map((m) => (
                <option key={m.id || m.name} value={m.name}>
                  {m.name}{m.provider_name ? ` · ${m.provider_name}` : ""}
                </option>
              ))}
            </select>
            {streamModels.length === 0 && (
              <span className="mt-1 block text-xs text-amber-500">未在网关发现 stt_stream 模型;请先在『① Gateway 设置』测试连接/刷新模型。</span>
            )}
          </label>

          {/* source */}
          <div className="text-sm">
            <span className="mb-1 block text-neutral-400">输入源</span>
            <div className="flex gap-2">
              <button
                className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-40 ${source === "file" ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"}`}
                disabled={busy} onClick={() => setSource("file")}
              >文件模拟直播</button>
              <button
                className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-40 ${source === "mic" ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"}`}
                disabled={busy} onClick={() => setSource("mic")}
              >麦克风实时</button>
            </div>
          </div>
        </div>

        {/* controls */}
        {source === "file" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <input type="file" accept="audio/*,video/*" className="text-sm" disabled={busy}
                onChange={(e) => onPickFile(e.target.files?.[0] || null)} />
              {!busy ? (
                <button className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40" onClick={startFile} disabled={!file}>▶ 开始(边放边出字幕)</button>
              ) : (
                <button className="rounded-md bg-neutral-700 px-4 py-1.5 text-sm text-neutral-100 hover:bg-neutral-600" onClick={stopFile}>■ 停止</button>
              )}
            </div>

            {mediaUrl && isVideo && (
              <div className="relative overflow-hidden rounded-lg bg-black">
                <video ref={(el) => { mediaRef.current = el; }} src={mediaUrl} className="max-h-[46vh] w-full" playsInline controls onSeeked={onSeeked} />
                {currentCaption && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center px-4">
                    <span className="max-w-[92%] rounded bg-black/70 px-3 py-1 text-center text-lg font-medium leading-snug text-white shadow-lg">
                      {currentCaption}
                    </span>
                  </div>
                )}
              </div>
            )}
            {mediaUrl && !isVideo && (
              <div className="rounded-lg border border-neutral-800 bg-black/30 p-3">
                <audio ref={(el) => { mediaRef.current = el; }} src={mediaUrl} className="w-full" controls onSeeked={onSeeked} />
                <p className="mt-2 min-h-[1.75rem] text-center text-lg font-medium leading-snug text-white">
                  {currentCaption || <span className="text-neutral-600 text-sm">字幕将随播放实时出现…</span>}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {!busy ? (
              <button className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500" onClick={startMic}>🎙 开始说话</button>
            ) : (
              <button className="rounded-md bg-neutral-700 px-4 py-1.5 text-sm text-neutral-100 hover:bg-neutral-600" onClick={stopMic}>■ 停止</button>
            )}
            <span className="text-xs text-neutral-500">需要浏览器麦克风权限(HTTPS 下可用)。</span>
          </div>
        )}

        {/* meters */}
        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-neutral-400">
          <span className="tabular-nums">⏱ {elapsed.toFixed(1)}s</span>
          {language && <span>🌐 {language}</span>}
          <div className="flex items-center gap-1">
            <span>音量</span>
            <div className="h-2 w-28 overflow-hidden rounded bg-neutral-800">
              <div className="h-full bg-emerald-500 transition-[width] duration-100" style={{ width: `${Math.min(100, level * 140)}%` }} />
            </div>
          </div>
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 select-none" title="给每句已定字幕加上 mm:ss 时间码(勾选 diar_stream 时将自动开启)">
            <input type="checkbox" className="accent-emerald-500" checked={showTimecode} onChange={(e) => setShowTimecode(e.target.checked)} />
            <span>时间码字幕</span>
          </label>
        </div>

        {err && <p className="mt-3 rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</p>}
      </div>

      {/* rolling subtitles */}
      <div className="rounded-lg border border-neutral-800 bg-black/40 p-4">
        <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
          <span>实时字幕</span>
          <span>{committed.length} 句已定{interim ? " · 1 句识别中" : ""}</span>
        </div>
        <div ref={scrollRef} className="max-h-[46vh] min-h-[10rem] space-y-2 overflow-y-auto pr-1">
          {committed.length === 0 && !interim && (
            <p className="text-sm text-neutral-600">{busy ? "等待识别结果…" : "选择输入源后点击开始,字幕会在这里逐句滚动。"}</p>
          )}
          {committed.map((line, i) => (
            <p key={i} className="flex gap-2 text-[15px] leading-relaxed text-neutral-100">
              {showTimecode && (
                <span className="shrink-0 pt-px font-mono text-xs tabular-nums text-emerald-400/80">
                  {fmtTC(capTimes[i] ?? 0)}
                </span>
              )}
              <span>{line}</span>
            </p>
          ))}
          {interim && (
            <p className="text-[15px] italic leading-relaxed text-neutral-400">
              {interim}<span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-emerald-400 align-middle" />
            </p>
          )}
        </div>
        {(committed.length > 0 || interim) && (
          <div className="mt-3 border-t border-neutral-800 pt-2 text-right">
            <button
              className="rounded-md bg-neutral-700 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-600"
              onClick={() => {
                const body = showTimecode
                  ? committed.map((l, i) => `[${fmtTC(capTimes[i] ?? 0)}] ${l}`).join("\n") + (interim ? `\n${interim}` : "")
                  : [...committed, interim].filter(Boolean).join("");
                navigator.clipboard?.writeText(body);
              }}
            >复制全文</button>
          </div>
        )}
      </div>
    </div>
  );
}
