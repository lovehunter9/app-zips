// Live streaming view — two independent real-time capabilities that can run
// alone OR together on the SAME audio:
//   • 转写 (mode=stt_stream)  — audio in, partial text out, one final at the end.
//   • 说话人 (mode=diar_stream) — audio in, speaker segments (native timestamps).
//
// STANDALONE: tick either box on its own — STT gives rolling captions; Diar gives
// a live "who's speaking" timeline. TOGETHER: both engines are fed the exact same
// PCM frames off ONE audio clock (file = media.currentTime, mic = wall time), so
// the demo can FUSE them — every settled caption line is attributed to the speaker
// whose diarization segment overlaps that line's time span.
//
// Both capabilities are otherwise STANDALONE vs. the offline file-analysis tab
// (STT/VAD/Diar/Align/…), which need the whole clip / a global timeline.
//
// Transport: the browser WebSocket API cannot set request headers, and the
// gateway's streaming data planes authenticate by Authorization: Bearer only.
// So we smuggle the gateway base/key/cookie as query params (__base/__key/
// __cookie); the App Server proxy (server.js) reads them, injects the real
// Authorization/Cookie headers on the upstream handshake, and strips them.
//
// Wire protocol (see audiolabxv3 wrappers.yaml stream.py / diar_stream.py):
//   stt  -> {"type":"start","language":null,"sample_rate":16000,"step_ms":500}
//   diar -> {"type":"start","sample_rate":16000}
//        -> BINARY raw PCM16LE mono @ sample_rate chunks   (broadcast to both)
//        -> {"type":"stop"}
//   stt  <- {"type":"partial"|"final","text":<cumulative>,"language":...}
//   diar <- {"type":"partial"|"final","segments":[{start,end,speaker}],"speakers":[...]}
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

type Kind = "stt" | "diar";
const WS_PATH: Record<Kind, string> = {
  stt: "/v1/audio/stream",
  diar: "/v1/audio/diarize/stream",
};

function buildWsUrl(settings: Settings, model: string, path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const p = new URLSearchParams();
  p.set("model", model);
  if (settings.base) p.set("__base", settings.base.replace(/\/+$/, ""));
  if (settings.key) p.set("__key", settings.key);
  if (settings.cookie) p.set("__cookie", settings.cookie);
  return `${proto}//${location.host}/api/gw${path}?${p.toString()}`;
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

// ---- speaker helpers (diar) ----
type Seg = { start: number; end: number; speaker: string };
const SPK_COLORS = ["#34d399", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#22d3ee", "#fb923c", "#4ade80"];
function spkIdx(spk: string): number {
  const m = /(\d+)/.exec(spk || "");
  return m ? parseInt(m[1], 10) : 0;
}
function spkColor(spk: string): string {
  return SPK_COLORS[spkIdx(spk) % SPK_COLORS.length];
}
function spkLabel(spk: string): string {
  const m = /(\d+)/.exec(spk || "");
  return m ? `说话人 ${parseInt(m[1], 10) + 1}` : spk || "?";
}

// Collapse consecutive same-speaker segments (short gaps included) into blocks
// for a compact "who spoke when" timeline.
function mergeSegs(segs: Seg[]): Seg[] {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out: Seg[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end <= 0.8) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

// Only truly momentary blips (a couple of 80ms frames) are diarisation noise worth
// hiding. Keep the threshold low so GENUINE short turns (a quick "Bye", a one-word
// interjection) survive and rapid speaker switches stay visible; if filtering would
// empty the set, fall back to the merged raw segments.
const MIN_TURN = 0.25;
function stableSegs(segs: Seg[]): Seg[] {
  const merged = mergeSegs(segs);
  const kept = merged.filter((s) => s.end - s.start >= MIN_TURN);
  return kept.length ? kept : merged;
}

// Attribute a caption line to the speaker on screen AT ITS OWN TIMECODE `t` (the
// same time shown next to the line and used by the timeline panel), so the fused
// chip is always consistent with the timeline. Uses the covering turn, else the
// nearest turn in time. NO [t0,t1] overlap window — that window is polluted by the
// previous line / inter-sentence gap and mis-attributes short lines.
function speakerAtTime(t: number, segs: Seg[]): string {
  if (!segs.length) return "";
  for (const s of segs) if (t >= s.start && t <= s.end) return s.speaker;
  let best = segs[0];
  let bestGap = Infinity;
  for (const s of segs) {
    const gap = t < s.start ? s.start - t : t - s.end;
    if (gap < bestGap) { bestGap = gap; best = s; }
  }
  return best.speaker;
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
  // x2 (audiobase): streaming models register with mode=audio and declare the
  // streaming capability in supports; tolerate the legacy per-mode shape too.
  const servesStream = (m: ProviderModel, key: string) =>
    m.mode === "audio" ? (m.supports || []).includes(key) : m.mode === key;
  const streamModels = useMemo(() => models.filter((m) => servesStream(m, "stt_stream")), [models]);
  const diarModels = useMemo(() => models.filter((m) => servesStream(m, "diar_stream")), [models]);

  // Which capabilities are active. Both can run alone or together (fusion).
  // Diar defaults ON so the headline "实时字幕 + 说话人" fusion is invoked out of
  // the box (if no diar_stream model exists in the gateway, the run silently
  // degrades to STT-only — see openEngines/precheck).
  const [enableStt, setEnableStt] = useState<boolean>(true);
  const [enableDiar, setEnableDiar] = useState<boolean>(true);

  const [model, setModel] = useState<string>("");
  const [diarModel, setDiarModel] = useState<string>("");
  useEffect(() => {
    // Auto-pick ONLY from models the gateway actually serves (never a guessed
    // vendor name). Self-heal: if the current selection is empty OR no longer in
    // the served list (e.g. the gateway still returns a stale default that points
    // at a deleted/renamed model), snap to a valid one — prefer the gateway
    // default when it's actually served, else the first served model.
    const has = (name: string, list: ProviderModel[]) => !!name && list.some((m) => m.name === name);
    if (streamModels.length && !has(model, streamModels)) {
      const pref = defaults["stt_stream"] || "";
      setModel(has(pref, streamModels) ? pref : streamModels[0].name);
    }
    if (diarModels.length && !has(diarModel, diarModels)) {
      const pref = defaults["diar_stream"] || "";
      setDiarModel(has(pref, diarModels) ? pref : diarModels[0].name);
    }
  }, [defaults, streamModels, diarModels, model, diarModel]);

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
  // drives (file = media.currentTime, mic = wall time since start). Speaker fusion
  // needs this timeline, so diar FORCES it on.
  const [showTimecode, setShowTimecode] = useState<boolean>(true);
  const [capTimes, setCapTimes] = useState<number[]>([]); // audio-sec per committed line
  const capTimesRef = useRef<number[]>([]);
  const t0Ref = useRef<number>(0); // performance.now() at stream start (mic clock base)

  // Diarization results (whole-session segments; re-emitted on every partial).
  const [diarSegs, setDiarSegs] = useState<Seg[]>([]);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const diarSegsRef = useRef<Seg[]>([]);

  const wsRef = useRef<WebSocket | null>(null); // stt socket
  const diarWsRef = useRef<WebSocket | null>(null); // diar socket
  const acRef = useRef<AudioContext | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const stopFileRef = useRef<boolean>(false);
  const stopSentRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Session token: bumped on every start/restart/finish so a stale pump loop or a
  // superseded (seek-restarted) socket bails out. Sockets also guard on ref identity.
  const sessionRef = useRef<number>(0);
  const pendingRef = useRef<Set<Kind>>(new Set()); // engines still running this session
  // Settle guard + watchdog: `finish` must be idempotent (multiple engines finishing,
  // socket onclose, and the watchdog can all race), and a session MUST settle even if
  // an engine never sends `final`/closes (e.g. a stalled diar engine) — otherwise the
  // UI is stuck at "收尾中" forever and only a refresh clears it. Gating on `status`
  // failed because the socket handlers close over a STALE status value.
  const finalizedRef = useRef<boolean>(false);
  const finalizeTimerRef = useRef<number | null>(null);
  // File-session state kept in refs so a seek can restart the stream at a new
  // position: pcmRef = decoded 16k mono PCM; sentRef = samples already streamed;
  // runningRef = an active file session is live (gate the seek handler);
  // seekTimerRef = debounce rapid native "seeked" events.
  const pcmRef = useRef<Float32Array | null>(null);
  const sentRef = useRef<number>(0);
  const runningRef = useRef<boolean>(false);
  const seekTimerRef = useRef<number | null>(null);

  // Fusion (per-line speaker chips) only makes sense when diar can actually run;
  // if the gateway has no diar_stream model we degraded to STT-only, so don't
  // leave every line stuck at "识别中…".
  const fusion = enableStt && enableDiar && diarModels.length > 0;
  // Current on-screen caption = the live (interim) fragment, else the last settled line.
  const currentCaption = interim || (committed.length ? committed[committed.length - 1] : "");

  function onPickFile(f: File | null) {
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    setFile(f);
    setMediaUrl(f ? URL.createObjectURL(f) : "");
    setIsVideo(!!f && f.type.startsWith("video/"));
    reset();
  }

  // Diar fusion needs the ASR timeline → force timecodes on while diar is active.
  useEffect(() => { if (enableDiar) setShowTimecode(true); }, [enableDiar]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [committed, interim]);

  useEffect(() => () => cleanup(), []); // unmount

  function closeSockets() {
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;
    try { diarWsRef.current?.close(); } catch {}
    diarWsRef.current = null;
  }

  function cleanup() {
    runningRef.current = false;
    sessionRef.current++;
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
    closeSockets();
    if (mediaUrl) { try { URL.revokeObjectURL(mediaUrl); } catch {} }
  }

  // Demo-side audio clock (seconds): file follows the player head, mic uses wall
  // time since the stream started. The SAME clock feeds both engines, so their
  // outputs share a timeline for fusion.
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
      // Several sentences can settle in ONE engine message. Stamping them all with
      // `now` collapses their timecodes AND their fusion anchor -> they'd all get
      // one speaker. Spread the new lines across (lastTime, now] so each gets a
      // distinct, monotonically-increasing timecode for display + fusion.
      const now = audioClock();
      const prev = times.length ? times[times.length - 1] : 0;
      const n = c.length - times.length;
      const span = Math.max(0, now - prev);
      for (let k = 1; k <= n; k++) times.push(prev + (span * k) / n);
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

  function applyDiar(segments: any, speakerList: any) {
    const segs: Seg[] = Array.isArray(segments)
      ? segments
          .map((s: any) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, speaker: String(s.speaker ?? "spk_0") }))
          .filter((s: Seg) => s.end >= s.start)
      : [];
    diarSegsRef.current = segs;
    setDiarSegs(segs);
    if (Array.isArray(speakerList)) setSpeakers(speakerList.map(String));
    else setSpeakers(Array.from(new Set(segs.map((s) => s.speaker))));
  }

  // One engine finished (final or socket close). When the LAST active engine is
  // done, settle the whole session.
  function noteDone(kind: Kind) {
    pendingRef.current.delete(kind);
    // Settle when the LAST engine is done. Gate on the finalize guard (a ref), NOT the
    // `status` React state — these run inside socket handlers that captured a stale
    // `status`, which used to leave the session stuck at "收尾中".
    if (pendingRef.current.size === 0 && !finalizedRef.current) finish("done");
  }

  function openSock(kind: Kind, modelName: string): Promise<WebSocket> {
    const url = buildWsUrl(settings, modelName, WS_PATH[kind]);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const ref = kind === "stt" ? wsRef : diarWsRef;
    ref.current = ws;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`连接网关超时(15s, ${kind})`)), 15000);
      ws.onopen = () => { clearTimeout(to); resolve(ws); };
      ws.onerror = () => { clearTimeout(to); reject(new Error(`WebSocket 连接失败(${kind}:网关/上游不可达或未授权)`)); };
      ws.onmessage = (ev) => {
        if (ref.current !== ws) return; // superseded by a seek-restart
        if (typeof ev.data !== "string") return;
        let obj: any;
        try { obj = JSON.parse(ev.data); } catch { return; }
        if (kind === "stt") {
          if (obj.type === "partial") applyPartial(obj.text, obj.language);
          else if (obj.type === "final") { applyPartial(obj.text, obj.language); noteDone("stt"); }
          else if (obj.type === "error") { setErr(obj.detail || "engine error"); finish("error"); }
        } else {
          if (obj.type === "partial" || obj.type === "final") applyDiar(obj.segments, obj.speakers);
          if (obj.type === "final") noteDone("diar");
          else if (obj.type === "error") { setErr(obj.detail || "diar engine error"); finish("error"); }
        }
      };
      ws.onclose = () => {
        if (ref.current !== ws) return; // an old session we intentionally replaced
        if (!finalizedRef.current) noteDone(kind);
      };
    });
  }

  function precheck() {
    if (!settings.key && !settings.cookie) {
      throw new Error("请先在『① Gateway 设置』填入 API Key(和本地调试用 Cookie)。");
    }
    if (!enableStt && !enableDiar) throw new Error("请至少启用一项能力(转写 / 说话人)。");
    if (enableStt && !model.trim()) throw new Error("请先选择流式转写模型(mode=stt_stream)。");
    // Diar只在网关确有 diar_stream 模型、却没选的情况下才报错;若网关根本没有
    // diar_stream 模型,则本次静默降级为仅转写(不阻塞 STT)。
    if (enableDiar && diarModels.length > 0 && !diarModel.trim())
      throw new Error("请先选择流式说话人模型(mode=diar_stream)。");
  }

  // Open every enabled engine and register it as pending for this session.
  // Diar只有在真正拿到模型时才连接;否则本次仅跑转写。
  async function openEngines() {
    pendingRef.current = new Set();
    if (enableStt) { await openSock("stt", model.trim()); pendingRef.current.add("stt"); }
    if (enableDiar && diarModel.trim()) { await openSock("diar", diarModel.trim()); pendingRef.current.add("diar"); }
  }

  function sendStarts() {
    const s = wsRef.current;
    if (enableStt && s && s.readyState === WebSocket.OPEN)
      s.send(JSON.stringify({ type: "start", language: null, sample_rate: TARGET_SR, step_ms: STEP_MS }));
    const d = diarWsRef.current;
    if (enableDiar && d && d.readyState === WebSocket.OPEN)
      d.send(JSON.stringify({ type: "start", sample_rate: TARGET_SR }));
  }

  function broadcastPcm(buf: ArrayBuffer) {
    for (const ws of [wsRef.current, diarWsRef.current])
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
  }

  function broadcastStopOnce() {
    if (stopSentRef.current) return;
    stopSentRef.current = true;
    setStatus("stopping");
    for (const ws of [wsRef.current, diarWsRef.current])
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    // Watchdog: an engine may be slow to send its `final` or may never close (a stalled
    // diar engine can sit inside a long inference). Don't let the UI hang at "收尾中" —
    // force-settle after a grace period. `finish` is idempotent, so a timely engine
    // `final` still wins and this becomes a no-op.
    if (finalizeTimerRef.current) clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = window.setTimeout(() => {
      if (!finalizedRef.current) finish("done");
    }, 5000);
  }

  function startTimer() {
    const t0 = performance.now();
    t0Ref.current = t0;
    setElapsed(0);
    timerRef.current = window.setInterval(() => setElapsed((performance.now() - t0) / 1000), 200);
  }

  function finish(s: Status) {
    if (finalizedRef.current) return; // idempotent: engines / onclose / watchdog all race here
    finalizedRef.current = true;
    if (finalizeTimerRef.current) { clearTimeout(finalizeTimerRef.current); finalizeTimerRef.current = null; }
    runningRef.current = false;
    sessionRef.current++;
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
    closeSockets(); // drop any lingering/stalled engine sockets so nothing hangs open
    setLevel(0);
    setStatus(s);
  }

  function reset() {
    setCommitted([]); setInterim(""); setLanguage(""); setErr(""); setElapsed(0); setLevel(0);
    capTimesRef.current = []; setCapTimes([]);
    diarSegsRef.current = []; setDiarSegs([]); setSpeakers([]);
  }

  // Playback-driven send: stream audio up to the media element's currentTime so the
  // captions track what the user is HEARING (only the engine's own latency behind).
  // Pausing the player pauses the stream; there's no timer drift. Guarded on the
  // session token so a seek-restart's stale RAF loop stops immediately.
  function startPump(sess: number) {
    const pcm = pcmRef.current;
    if (!pcm) return;
    const media = mediaRef.current;
    const pump = () => {
      if (stopFileRef.current || sessionRef.current !== sess) return;
      const target = media && isFinite(media.currentTime)
        ? Math.floor(media.currentTime * TARGET_SR)
        : pcm.length;
      let peak = 0;
      while (sentRef.current < Math.min(target, pcm.length)) {
        const end = Math.min(pcm.length, sentRef.current + CHUNK_SAMPLES);
        const chunk = pcm.subarray(sentRef.current, end);
        for (let k = 0; k < chunk.length; k++) peak = Math.max(peak, Math.abs(chunk[k]));
        broadcastPcm(floatToPcm16(chunk));
        sentRef.current = end;
      }
      setLevel(peak || 0);
      if (sentRef.current >= pcm.length) { setLevel(0); broadcastStopOnce(); return; }
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
    finalizedRef.current = false;
    try {
      precheck();
      const dec = await decodeAudio(file);
      pcmRef.current = resampleTo16k(dec.data, dec.sampleRate);
      const media = mediaRef.current;
      if (media) { try { media.currentTime = 0; } catch {} }
      const sess = ++sessionRef.current;
      await openEngines();
      if (sessionRef.current !== sess) { closeSockets(); return; }
      sentRef.current = 0;
      setStatus("streaming");
      runningRef.current = true;
      startTimer();
      sendStarts();
      if (media) {
        media.onended = () => broadcastStopOnce();
        try { await media.play(); } catch { /* autoplay may be blocked; pump follows currentTime */ }
      }
      startPump(sess);
    } catch (e: any) {
      setErr(String(e?.message || e));
      finish("error");
    }
  }

  // Seek support: streaming state is append-only (can't rewind the models), so a
  // scrub = tear down the current sockets and open FRESH ones that caption/diarize
  // from the dragged position onward. Prior lines/segments are cleared.
  async function restartFileAt(sec: number) {
    if (!pcmRef.current) return;
    stopFileRef.current = false;
    stopSentRef.current = false;
    finalizedRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    closeSockets(); // old sockets; their handlers are ref-identity guarded
    setCommitted([]); setInterim("");
    capTimesRef.current = []; setCapTimes([]); // timecodes belong to the old timeline
    diarSegsRef.current = []; setDiarSegs([]); setSpeakers([]);
    setStatus("connecting");
    try {
      const sess = ++sessionRef.current;
      await openEngines();
      if (sessionRef.current !== sess) { closeSockets(); return; } // superseded again
      sentRef.current = Math.max(0, Math.floor(sec * TARGET_SR));
      setStatus("streaming");
      runningRef.current = true;
      sendStarts();
      startPump(sess);
    } catch (e: any) {
      setErr(String(e?.message || e));
      finish("error");
    }
  }

  function onSeeked() {
    if (source !== "file" || !runningRef.current || !pcmRef.current) return;
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
    stopSentRef.current = false;
    finalizedRef.current = false;
    try {
      precheck();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      micRef.current = stream;
      const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
      let ac: AudioContext;
      try { ac = new AC({ sampleRate: TARGET_SR }); } catch { ac = new AC(); }
      acRef.current = ac;
      const src = ac.createMediaStreamSource(stream);
      const node = ac.createScriptProcessor(4096, 1, 1);
      nodeRef.current = node;

      const sess = ++sessionRef.current;
      await openEngines();
      if (sessionRef.current !== sess) { closeSockets(); return; }
      setStatus("streaming");
      startTimer();
      sendStarts();

      let acc = new Float32Array(0);
      node.onaudioprocess = (ev) => {
        if (sessionRef.current !== sess) return;
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
          broadcastPcm(floatToPcm16(chunk));
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
    setStatus("stopping");
    try { nodeRef.current?.disconnect(); } catch {}
    nodeRef.current = null;
    broadcastStopOnce();
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
    setStatus("stopping");
    broadcastStopOnce();
  }

  // Flash-filtered, merged turns — the single source of truth shared by BOTH the
  // fused caption chips and the timeline panel, so they can never disagree.
  const fuseSegs = useMemo(() => stableSegs(diarSegs), [diarSegs]);
  // How far diarisation has actually committed. Diar trails the transcript by ~1-2s
  // (right-context + emit cadence), so a freshly-settled line often sits AHEAD of
  // this. We must NOT guess a speaker for those lines (that caused a burst of lines
  // to all show the last speaker, then "backfill" when diar caught up). Instead they
  // stay PENDING (no chip) until diar covers their timecode, then fill once, right.
  const diarCoveredTo = useMemo(
    () => fuseSegs.reduce((m, s) => Math.max(m, s.end), 0), [fuseSegs]);
  // Per-line speaker attribution (fusion): each covered line takes the speaker on
  // screen at its OWN displayed timecode; uncovered (future) lines are pending WHILE
  // LIVE. Once the session has ended, diar won't advance any further, so stop leaving
  // the tail stuck at 识别中… — give those lines their best-effort (nearest) speaker.
  const finalized = status === "done" || status === "error";
  const lineSpeakers = useMemo(() => {
    if (!enableDiar) return [] as string[];
    return committed.map((_, i) => {
      const t = capTimes[i] ?? 0;
      if (!finalized && t > diarCoveredTo + 0.3) return "";   // still live & diar hasn't reached here -> pending
      return speakerAtTime(t, fuseSegs);
    });
  }, [committed, capTimes, fuseSegs, diarCoveredTo, enableDiar, finalized]);

  const mergedSegs = fuseSegs;
  const nowSpeaker = enableDiar ? speakerAtTime(audioClock(), fuseSegs) : "";
  const currentLineSpeaker = enableDiar && fuseSegs.length ? speakerAtTime(audioClock(), fuseSegs) : "";

  const busy = status === "connecting" || status === "streaming" || status === "stopping";
  const statusLabel: Record<Status, string> = {
    idle: "空闲", connecting: "连接中…", streaming: "识别中…", stopping: "收尾中…", done: "完成", error: "错误",
  };
  const statusColor: Record<Status, string> = {
    idle: "text-neutral-400", connecting: "text-amber-400", streaming: "text-emerald-400",
    stopping: "text-amber-400", done: "text-sky-400", error: "text-red-400",
  };

  function SpeakerChip({ spk }: { spk: string }) {
    if (!spk) return null;
    const c = spkColor(spk);
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium leading-none"
        style={{ color: c, backgroundColor: c + "22", border: `1px solid ${c}55` }}
      >
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: c }} />
        {spkLabel(spk)}
      </span>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">实时字幕 · 流式转写 + 说话人</h2>
          <span className={`text-sm ${statusColor[status]}`}>● {statusLabel[status]}</span>
        </div>

        <p className="mb-4 text-xs leading-relaxed text-neutral-500">
          两项<strong className="text-neutral-300">实时能力</strong>可单独或同时开启,喂给同一路音频:
          <strong className="text-emerald-300"> 转写</strong>(mode=stt_stream,边进边出字幕)、
          <strong className="text-sky-300"> 说话人</strong>(mode=diar_stream,实时区分谁在说)。
          <strong className="text-neutral-300">同时开启</strong>时,两路结果基于同一音频时钟<strong className="text-neutral-300">融合</strong>——每句字幕自动标注说话人。
          均经 LLM Gateway 的 WebSocket 数据面。
        </p>

        {/* capability toggles */}
        <div className="mb-4 flex flex-wrap items-center gap-4 rounded-md border border-neutral-800 bg-neutral-950/40 px-3 py-2">
          <span className="text-xs text-neutral-500">能力:</span>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm select-none">
            <input type="checkbox" className="accent-emerald-500" checked={enableStt} disabled={busy} onChange={(e) => setEnableStt(e.target.checked)} />
            <span className="text-emerald-300">转写 stt_stream</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-sm select-none">
            <input type="checkbox" className="accent-sky-500" checked={enableDiar} disabled={busy} onChange={(e) => setEnableDiar(e.target.checked)} />
            <span className="text-sky-300">说话人 diar_stream</span>
          </label>
          {fusion && <span className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300">融合模式:字幕按说话人着色标注</span>}
        </div>

        {/* models — BOTH selectors are ALWAYS rendered (mirrors TAB 1: fixed layout,
            no appear/disappear when a capability is toggled → no visual shift). The
            checkbox above governs whether the capability is actually invoked; a select
            for a disabled capability is dimmed but still pre-selectable. Defaults come
            ONLY from gateway-fetched models (never a guessed vendor name). */}
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <label className={`text-sm ${enableStt ? "" : "opacity-50"}`}>
            <span className="mb-1 block text-neutral-400">流式转写模型(mode=stt_stream)</span>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
              {streamModels.length === 0 && <option value="">(无 stt_stream 模型 — 先刷新)</option>}
              {streamModels.map((m) => (
                <option key={m.id || m.name} value={m.name}>
                  {m.name}{m.provider_name ? ` · ${m.provider_name}` : ""}
                </option>
              ))}
            </select>
            {streamModels.length === 0 && (
              <span className="mt-1 block text-xs text-amber-500">未在网关发现 stt_stream 模型;请先在『① Gateway 设置』刷新模型。</span>
            )}
          </label>
          <label className={`text-sm ${enableDiar ? "" : "opacity-50"}`}>
            <span className="mb-1 block text-neutral-400">流式说话人模型(mode=diar_stream)</span>
            <select className="input" value={diarModel} onChange={(e) => setDiarModel(e.target.value)} disabled={busy}>
              {diarModels.length === 0 && <option value="">(无 diar_stream 模型 — 先刷新)</option>}
              {diarModels.map((m) => (
                <option key={m.id || m.name} value={m.name}>
                  {m.name}{m.provider_name ? ` · ${m.provider_name}` : ""}
                </option>
              ))}
            </select>
            {diarModels.length === 0 && (
              <span className="mt-1 block text-xs text-amber-500">未在网关发现 diar_stream 模型;请先在『① Gateway 设置』刷新模型。</span>
            )}
          </label>
        </div>

        {/* source */}
        <div className="mb-3 text-sm">
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

        {/* controls */}
        {source === "file" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <input type="file" accept="audio/*,video/*" className="text-sm" disabled={busy}
                onChange={(e) => onPickFile(e.target.files?.[0] || null)} />
              {!busy ? (
                <button className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40" onClick={startFile} disabled={!file || (!enableStt && !enableDiar)}>▶ 开始(边放边出)</button>
              ) : (
                <button className="rounded-md bg-neutral-700 px-4 py-1.5 text-sm text-neutral-100 hover:bg-neutral-600" onClick={stopFile}>■ 停止</button>
              )}
            </div>

            {mediaUrl && isVideo && (
              <div className="relative overflow-hidden rounded-lg bg-black">
                <video ref={(el) => { mediaRef.current = el; }} src={mediaUrl} className="max-h-[46vh] w-full" playsInline controls onSeeked={onSeeked} />
                {(currentCaption || (enableDiar && nowSpeaker)) && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center px-4">
                    <span className="flex max-w-[92%] items-center gap-2 rounded bg-black/70 px-3 py-1 text-center text-lg font-medium leading-snug text-white shadow-lg">
                      {enableDiar && (currentLineSpeaker || nowSpeaker) && <SpeakerChip spk={currentLineSpeaker || nowSpeaker} />}
                      {currentCaption && <span>{currentCaption}</span>}
                    </span>
                  </div>
                )}
              </div>
            )}
            {mediaUrl && !isVideo && (
              <div className="rounded-lg border border-neutral-800 bg-black/30 p-3">
                <audio ref={(el) => { mediaRef.current = el; }} src={mediaUrl} className="w-full" controls onSeeked={onSeeked} />
                <p className="mt-2 flex min-h-[1.75rem] items-center justify-center gap-2 text-center text-lg font-medium leading-snug text-white">
                  {enableDiar && (currentLineSpeaker || nowSpeaker) && <SpeakerChip spk={currentLineSpeaker || nowSpeaker} />}
                  {currentCaption ? <span>{currentCaption}</span> : (!enableStt && enableDiar ? <span className="text-neutral-500 text-sm">识别说话人中…</span> : <span className="text-neutral-600 text-sm">字幕将随播放实时出现…</span>)}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {!busy ? (
              <button className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40" onClick={startMic} disabled={!enableStt && !enableDiar}>🎙 开始说话</button>
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
          {enableDiar && <span>🗣 {speakers.length} 位说话人</span>}
          <div className="flex items-center gap-1">
            <span>音量</span>
            <div className="h-2 w-28 overflow-hidden rounded bg-neutral-800">
              <div className="h-full bg-emerald-500 transition-[width] duration-100" style={{ width: `${Math.min(100, level * 140)}%` }} />
            </div>
          </div>
          <label className={`ml-auto flex items-center gap-1.5 select-none ${enableDiar ? "opacity-60" : "cursor-pointer"}`} title={enableDiar ? "融合说话人需要时间轴,已强制开启" : "给每句已定字幕加上 mm:ss 时间码"}>
            <input type="checkbox" className="accent-emerald-500" checked={showTimecode} disabled={enableDiar} onChange={(e) => setShowTimecode(e.target.checked)} />
            <span>时间码字幕{enableDiar ? "(融合已强制)" : ""}</span>
          </label>
        </div>

        {err && <p className="mt-3 rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</p>}
      </div>

      {/* rolling subtitles — shown whenever STT is active. Placed FIRST because the
          fused subtitles (text + speaker) are what users most want to see; the raw
          speaker timeline is a secondary detail panel below. */}
      {enableStt && (
        <div className="rounded-lg border border-neutral-800 bg-black/40 p-4">
          <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
            <span>实时字幕{fusion ? "(含说话人)" : ""}</span>
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
                {fusion && (lineSpeakers[i]
                  ? <span className="shrink-0 pt-px"><SpeakerChip spk={lineSpeakers[i]} /></span>
                  : <span className="shrink-0 whitespace-nowrap rounded border border-neutral-700 px-1.5 py-px text-[11px] leading-none text-neutral-500" title="等待说话人识别覆盖此处">识别中…</span>)}
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
                  const line = (l: string, i: number) => {
                    const tc = showTimecode ? `[${fmtTC(capTimes[i] ?? 0)}] ` : "";
                    const spk = fusion && lineSpeakers[i] ? `${spkLabel(lineSpeakers[i])}: ` : "";
                    return `${tc}${spk}${l}`;
                  };
                  const body = committed.map(line).join("\n") + (interim ? `\n${interim}` : "");
                  navigator.clipboard?.writeText(body);
                }}
              >复制全文</button>
            </div>
          )}
        </div>
      )}

      {/* standalone speaker timeline — secondary detail, below the fused subtitles */}
      {enableDiar && (
        <div className="rounded-lg border border-neutral-800 bg-black/40 p-4">
          <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
            <span>说话人时间线 · diar_stream</span>
            <span>{speakers.length} 位 · {mergedSegs.length} 段{nowSpeaker ? " · 当前 " + spkLabel(nowSpeaker) : ""}</span>
          </div>
          {speakers.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {speakers.map((s) => <SpeakerChip key={s} spk={s} />)}
            </div>
          )}
          <div className="max-h-[30vh] space-y-1.5 overflow-y-auto pr-1">
            {mergedSegs.length === 0 && (
              <p className="text-sm text-neutral-600">{busy ? "识别说话人中…" : "开始后,这里会实时显示谁在什么时间说话。"}</p>
            )}
            {mergedSegs.map((s, i) => {
              const active = nowSpeaker === s.speaker && audioClock() >= s.start && audioClock() <= s.end;
              return (
                <div key={i} className={`flex items-center gap-2 rounded px-2 py-1 text-sm ${active ? "bg-neutral-800/70" : ""}`}>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-500">
                    {fmtTC(s.start)}–{fmtTC(s.end)}
                  </span>
                  <SpeakerChip spk={s.speaker} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
