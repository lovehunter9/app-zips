// Audio Minutes X Demo — Feishu-Minutes-style app.
//   • Library ("我的内容"): upload audio/video, server transcribes asynchronously,
//     cards show 处理中 N% and survive refresh.
//   • Record detail: media player <-> word-level transcript two-way sync. Playback
//     highlights the current word and auto-scrolls; click a word to seek there.
//   • Settings: LLM Gateway address + which STT/align/diar models to use (chosen
//     from what the gateway actually serves). Missing a required model => the app
//     tells you it cannot transcribe.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GatewayConfig, ModelOpt, RecordFull, RecordSummary, Segment } from "./types";
import * as api from "./api";

// ---- small helpers ----
function fmtTC(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(ss).padStart(2, "0")}`;
}
function fmtDur(sec: number | null): string {
  if (!sec && sec !== 0) return "";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h} 时 ${m} 分`;
  if (m > 0) return `${m} 分 ${ss} 秒`;
  return `${ss} 秒`;
}
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
  return m ? `说话人 ${parseInt(m[1], 10) + 1}` : spk || "说话人";
}

function SpeakerChip({ spk }: { spk: string }) {
  const c = spkColor(spk);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium leading-none"
      style={{ color: c, backgroundColor: c + "22", border: `1px solid ${c}55` }}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: c }} />
      {spkLabel(spk)}
    </span>
  );
}

function statusText(r: RecordSummary): string {
  if (r.status === "processing") return `处理中 ${r.progress}%${r.phase ? " · " + r.phase : ""}`;
  if (r.status === "uploaded") return "待转录";
  if (r.status === "done") return "已完成";
  if (r.status === "error") return "失败";
  return r.status;
}

// ===========================================================================
// Settings modal
// ===========================================================================
function SettingsModal({
  config,
  onClose,
  onSaved,
}: {
  config: GatewayConfig;
  onClose: () => void;
  onSaved: (cfg: GatewayConfig) => void;
}) {
  const [base, setBase] = useState(config.base);
  const [key, setKey] = useState(config.key);
  const [cookie, setCookie] = useState(config.cookie);
  const [modes, setModes] = useState<Record<string, ModelOpt[]>>({});
  const [stt, setStt] = useState(config.models.stt);
  const [align, setAlign] = useState(config.models.align);
  const [diar, setDiar] = useState(config.models.diar);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const loadModels = useCallback(async () => {
    setErr(""); setMsg(""); setLoading(true);
    try {
      // Persist creds first so /api/models (server-side) can reach the gateway.
      await api.putConfig({ base, key, cookie });
      const m = await api.getModels();
      setModes(m.modes || {});
      const cnt = Object.values(m.modes || {}).reduce((n, a) => n + a.length, 0);
      setMsg(`已从网关发现 ${cnt} 个模型`);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setModes({});
    } finally {
      setLoading(false);
    }
  }, [base, key, cookie]);

  useEffect(() => {
    // If a gateway is already configured, load models on open.
    if (config.base) loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setErr(""); setLoading(true);
    try {
      const saved = await api.putConfig({ base, key, cookie, models: { stt, align, diar } });
      onSaved(saved);
      onClose();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  const ModelSelect = ({ label, mode, value, set }: { label: string; mode: string; value: string; set: (v: string) => void }) => {
    const opts = modes[mode] || [];
    return (
      <label className="block text-sm">
        <span className="mb-1 block text-neutral-400">{label}(mode={mode})</span>
        <select className="input" value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{opts.length ? "— 请选择 —" : "(网关无此模型)"}</option>
          {opts.map((o) => (
            <option key={o.id || o.name} value={o.name}>
              {o.name}{o.provider_name ? ` · ${o.provider_name}` : ""}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div className="mt-10 w-full max-w-xl card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">设置 · LLM Gateway</h2>
          <button className="btn-ghost" onClick={onClose}>关闭</button>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-400">网关地址(Base URL,含 /v1 前的根,如 https://xxx.olares.com)</span>
          <input className="input" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://<gateway-host>" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-400">API Key(数据面 Bearer)</span>
          <input className="input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-400">Olares Cookie(本地调试用,可选)</span>
          <input className="input" value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="auth_token=..." />
        </label>

        <div className="flex items-center gap-3">
          <button className="btn-ghost" onClick={loadModels} disabled={loading || !base}>
            {loading ? "加载中…" : "保存并加载模型"}
          </button>
          {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        </div>

        <div className="grid gap-3 border-t border-neutral-800 pt-3">
          <ModelSelect label="转写 STT" mode="stt" value={stt} set={setStt} />
          <ModelSelect label="强制对齐 Align(词级时间戳)" mode="align" value={align} set={setAlign} />
          <ModelSelect label="说话人分离 Diarize" mode="diar" value={diar} set={setDiar} />
        </div>

        {err && <p className="rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</p>}

        <div className="flex justify-end gap-2 border-t border-neutral-800 pt-3">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={save} disabled={loading}>保存</button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Record detail — player <-> word-level transcript sync
// ===========================================================================
interface FlatWord {
  gi: number;
  segIdx: number;
  text: string;
  start: number;
  end: number;
}

function RecordDetail({
  id,
  onBack,
  onChanged,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [rec, setRec] = useState<RecordFull | null>(null);
  const [err, setErr] = useState("");
  const [activeGi, setActiveGi] = useState<number>(-1);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try { setRec(await api.getRecord(id)); } catch (e: any) { setErr(String(e?.message || e)); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Poll while processing.
  useEffect(() => {
    if (!rec || (rec.status !== "processing" && rec.status !== "uploaded")) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [rec, load]);

  const segments: Segment[] = rec?.result?.segments || [];
  const flat: FlatWord[] = useMemo(() => {
    const out: FlatWord[] = [];
    let gi = 0;
    segments.forEach((s, si) => {
      (s.words || []).forEach((w) => out.push({ gi: gi++, segIdx: si, text: w.text, start: w.start, end: w.end }));
    });
    return out;
  }, [segments]);
  // Starting global word index of each segment, so per-word `gi` is O(1) in render.
  const segBase: number[] = useMemo(() => {
    const base: number[] = [];
    let acc = 0;
    for (const s of segments) { base.push(acc); acc += (s.words?.length || 0); }
    return base;
  }, [segments]);

  // Binary search the active word for a given time.
  const findWord = useCallback((t: number): number => {
    if (!flat.length) return -1;
    let lo = 0, hi = flat.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (flat[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // If we're clearly past the matched word's end and into a gap, still keep it
    // highlighted (reads better than flicker); the next word takes over at its start.
    return ans;
  }, [flat]);

  const onTimeUpdate = useCallback(() => {
    const m = mediaRef.current;
    if (!m) return;
    const gi = findWord(m.currentTime);
    setActiveGi((prev) => (prev === gi ? prev : gi));
  }, [findWord]);

  // Auto-scroll the active word into view.
  useEffect(() => {
    if (activeGi < 0) return;
    const el = scrollRef.current?.querySelector(`[data-gi="${activeGi}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeGi]);

  function seekTo(t: number) {
    const m = mediaRef.current;
    if (!m) return;
    m.currentTime = Math.max(0, t);
    m.play().catch(() => {});
  }

  async function doTranscribe() {
    try { await api.transcribeRecord(id); await load(); onChanged(); }
    catch (e: any) { setErr(String(e?.message || e)); }
  }
  async function doDelete() {
    if (!confirm("删除这条记录?")) return;
    try { await api.deleteRecord(id); onChanged(); onBack(); }
    catch (e: any) { setErr(String(e?.message || e)); }
  }

  if (!rec) {
    return (
      <div className="p-6 text-neutral-400">{err ? <span className="text-red-400">{err}</span> : "加载中…"}</div>
    );
  }

  const mediaSrc = `/api/records/${id}/media`;
  const activeSegIdx = activeGi >= 0 && flat[activeGi] ? flat[activeGi].segIdx : -1;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
        <button className="btn-ghost" onClick={onBack}>← 返回</button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{rec.title}</div>
          <div className="text-xs text-neutral-500">
            {fmtDur(rec.durationSec)} · {statusText(rec)}
            {rec.status === "done" ? ` · ${rec.speakers} 位说话人 · ${rec.segments} 段` : ""}
          </div>
        </div>
        {rec.status === "done" && <ExportButtons rec={rec} />}
        {(rec.status === "uploaded" || rec.status === "error") && (
          <button className="btn-primary" onClick={doTranscribe}>AI 转录</button>
        )}
        <button className="btn-ghost" onClick={doDelete}>删除</button>
      </div>

      {err && <p className="mx-4 mt-3 rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</p>}

      {rec.status !== "done" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          {rec.status === "processing" ? (
            <>
              <div className="text-lg text-neutral-200">处理中 {rec.progress}%</div>
              <div className="text-sm text-neutral-500">{rec.phase || "…"}</div>
              <div className="h-2 w-64 overflow-hidden rounded bg-neutral-800">
                <div className="h-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${rec.progress}%` }} />
              </div>
            </>
          ) : rec.status === "error" ? (
            <div className="text-red-400">{rec.error || "失败"}</div>
          ) : (
            <div className="text-neutral-400">尚未转录,点击右上角「AI 转录」。</div>
          )}
        </div>
      ) : (
        <div className="grid flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          {/* player */}
          <div className="flex flex-col gap-3">
            {rec.kind === "video" ? (
              <video ref={(el) => { mediaRef.current = el; }} src={mediaSrc} controls className="w-full rounded-lg bg-black" onTimeUpdate={onTimeUpdate} />
            ) : (
              <audio ref={(el) => { mediaRef.current = el; }} src={mediaSrc} controls className="w-full" onTimeUpdate={onTimeUpdate} />
            )}
            <div className="card text-xs text-neutral-400">
              <div className="mb-2 font-medium text-neutral-300">说话人</div>
              <div className="flex flex-wrap gap-2">
                {(rec.result?.speakers || []).map((s) => <SpeakerChip key={s} spk={s} />)}
              </div>
              <p className="mt-3 leading-relaxed">点击文字记录中的任意词可跳转播放;播放时会高亮当前词并自动滚动。</p>
            </div>
          </div>

          {/* transcript */}
          <div ref={scrollRef} className="overflow-y-auto rounded-lg border border-neutral-800 bg-black/30 p-4">
            {segments.length === 0 && <p className="text-sm text-neutral-600">(无转写内容)</p>}
            <div className="space-y-4">
              {segments.map((seg, si) => (
                <div key={si} className={`rounded-lg p-2 ${si === activeSegIdx ? "bg-neutral-800/40" : ""}`}>
                  <div className="mb-1 flex items-center gap-2">
                    <SpeakerChip spk={seg.speaker} />
                    <button className="font-mono text-xs tabular-nums text-neutral-500 hover:text-neutral-300" onClick={() => seekTo(seg.start)}>
                      {fmtTC(seg.start)}
                    </button>
                  </div>
                  <p className="text-[15px] leading-relaxed text-neutral-200">
                    {seg.words && seg.words.length
                      ? seg.words.map((w, wi) => {
                          const gi = segBase[si] + wi;
                          const active = gi === activeGi;
                          return (
                            <span
                              key={wi}
                              data-gi={gi}
                              onClick={() => seekTo(w.start)}
                              className={`cursor-pointer rounded px-px transition-colors ${active ? "bg-emerald-500/70 text-white" : "hover:bg-neutral-700/60"}`}
                            >
                              {w.text}
                            </span>
                          );
                        })
                      : <span className="text-neutral-400">{seg.text}</span>}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- export (TXT / SRT / JSON) ----
function download(name: string, text: string, type = "text/plain") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(mm, 3)}`;
}
function ExportButtons({ rec }: { rec: RecordFull }) {
  const segs = rec.result?.segments || [];
  const txt = () => download(`${rec.title}.txt`, segs.map((s) => `[${fmtTC(s.start)}] ${spkLabel(s.speaker)}: ${s.text}`).join("\n"));
  const srt = () => download(`${rec.title}.srt`, segs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${spkLabel(s.speaker)}: ${s.text}`).join("\n\n"), "application/x-subrip");
  const json = () => download(`${rec.title}.json`, JSON.stringify(rec.result, null, 2), "application/json");
  return (
    <div className="flex gap-1">
      <button className="btn-ghost" onClick={txt}>TXT</button>
      <button className="btn-ghost" onClick={srt}>SRT</button>
      <button className="btn-ghost" onClick={json}>JSON</button>
    </div>
  );
}

// ===========================================================================
// Library + shell
// ===========================================================================
export default function App() {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refreshRecords = useCallback(async () => {
    try { setRecords((await api.listRecords()).records); } catch (e: any) { setErr(String(e?.message || e)); }
  }, []);

  const retry = useCallback(async (id: string) => {
    setErr("");
    setBusyIds((s) => new Set(s).add(id));
    try {
      await api.transcribeRecord(id);
      await refreshRecords();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [refreshRecords]);

  const onDelete = useCallback(async (id: string) => {
    if (!confirm("删除这条记录?")) return;
    try { await api.deleteRecord(id); await refreshRecords(); } catch (e: any) { setErr(String(e?.message || e)); }
  }, [refreshRecords]);

  useEffect(() => {
    (async () => {
      try { setConfig(await api.getConfig()); } catch { /* ignore */ }
      refreshRecords();
    })();
  }, [refreshRecords]);

  // Poll the library while anything is processing.
  useEffect(() => {
    const anyBusy = records.some((r) => r.status === "processing");
    if (!anyBusy) return;
    const t = setInterval(refreshRecords, 2000);
    return () => clearInterval(t);
  }, [records, refreshRecords]);

  const ready = !!config?.ready;

  async function onUpload(f: File | null) {
    if (!f) return;
    setErr(""); setUploadPct(0);
    try {
      const rec = await api.uploadFile(f, (p) => setUploadPct(Math.round(p)));
      setUploadPct(null);
      await refreshRecords();
      if (ready) { await api.transcribeRecord(rec.id); await refreshRecords(); }
    } catch (e: any) {
      setErr(String(e?.message || e));
      setUploadPct(null);
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="mx-auto flex h-screen max-w-6xl flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-3">
        <h1 className="text-lg font-semibold">🎙 Audio Minutes <span className="text-neutral-500">X Demo</span></h1>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-ghost" onClick={() => setShowSettings(true)}>设置</button>
        </div>
      </header>

      {!ready && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-sm text-red-300">
          无法转录:缺少 {config?.missing?.join("、") || "网关配置"}。请点击右上角「设置」配置网关地址并选择 STT / Align / Diarize 模型。
        </div>
      )}

      {selectedId ? (
        <div className="flex-1 overflow-hidden">
          <RecordDetail id={selectedId} onBack={() => setSelectedId(null)} onChanged={refreshRecords} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-4 flex items-center gap-3">
            <h2 className="text-base font-semibold">我的内容</h2>
            <div className="ml-auto flex items-center gap-2">
              {uploadPct != null && <span className="text-xs text-neutral-400">上传中 {uploadPct}%</span>}
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,video/*"
                className="hidden"
                onChange={(e) => onUpload(e.target.files?.[0] || null)}
              />
              <button className="btn-primary" onClick={() => fileRef.current?.click()} disabled={uploadPct != null}>
                ＋ 上传并转录
              </button>
            </div>
          </div>

          {err && <p className="mb-3 rounded bg-red-950/60 px-3 py-2 text-sm text-red-300">{err}</p>}

          {records.length === 0 ? (
            <div className="card text-center text-sm text-neutral-500">
              还没有内容。点击「上传并转录」上传一段音频或视频。
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {records.map((r) => (
                <div
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className="card cursor-pointer text-left transition-colors hover:border-neutral-600"
                >
                  <div className="flex items-start gap-2">
                    <span className="text-2xl">{r.kind === "video" ? "🎬" : "🎧"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-neutral-100">{r.title}</div>
                      <div className="mt-0.5 text-xs text-neutral-500">
                        {fmtDur(r.durationSec)} · {new Date(r.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                      title="删除"
                      onClick={(e) => { e.stopPropagation(); onDelete(r.id); }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    {r.status === "processing" ? (
                      <div className="flex-1">
                        <div className="mb-1 text-xs text-amber-400">{statusText(r)}</div>
                        <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
                          <div className="h-full bg-amber-500 transition-[width] duration-500" style={{ width: `${r.progress}%` }} />
                        </div>
                      </div>
                    ) : r.status === "done" ? (
                      <span className="text-xs text-emerald-400">已完成 · {r.speakers} 位说话人</span>
                    ) : r.status === "error" ? (
                      <>
                        <span className="min-w-0 flex-1 truncate text-xs text-red-400" title={r.error}>失败:{r.error}</span>
                        <button
                          className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
                          disabled={!ready || busyIds.has(r.id)}
                          title={!ready ? "请先在设置里完成网关与模型配置" : "重新转录"}
                          onClick={(e) => { e.stopPropagation(); retry(r.id); }}
                        >
                          {busyIds.has(r.id) ? "…" : "重试"}
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 text-xs text-neutral-400">待转录</span>
                        <button
                          className="shrink-0 rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-40"
                          disabled={!ready || busyIds.has(r.id)}
                          title={!ready ? "请先在设置里完成网关与模型配置" : "开始转录"}
                          onClick={(e) => { e.stopPropagation(); retry(r.id); }}
                        >
                          {busyIds.has(r.id) ? "…" : "转录"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showSettings && config && (
        <SettingsModal
          config={config}
          onClose={() => setShowSettings(false)}
          onSaved={(cfg) => setConfig(cfg)}
        />
      )}
    </div>
  );
}
