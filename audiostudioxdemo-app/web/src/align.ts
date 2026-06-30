// Non-AI timestamp post-processing (Demo-layer "beautification" only — NOT a platform
// capability/model). STT engines that return plain text without timestamps (e.g.
// Qwen3-ASR via vLLM's OpenAI transcription endpoint) are still used in their pure,
// native "whole-clip → text" form; here in the Demo we derive per-sentence timestamps
// so the rendered result resembles Whisper's verbose_json segments and can be fused
// with VAD/Diarize the same way. Pure string/arithmetic — no AI, no extra deps.
//
// Method (Tier 1): split the transcript into sentence-ish fragments, then spread them
// across a VOICED timeline proportionally to each fragment's spoken "weight". The
// voiced timeline comes from (in order of preference) Diarize segments (carry speaker),
// VAD segments, ffmpeg silencedetect speech runs, or — as a last resort — the whole
// clip as one run. Times are mapped through the voiced runs so they skip silences,
// which makes sentence boundaries land on real pauses, like Whisper does.

export interface Run {
  start: number;
  end: number;
  speaker?: string;
}

export interface AlignSeg {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// Sentence-ending marks (CJK + Latin) plus hard line breaks.
const SENT_END = /[。．.!?！？；;…\n]/;
// Closers that belong to the sentence they trail (quotes / brackets / spaces).
const TRAIL = /["'”’」』）)\]\s]/;
// Soft-break points for over-long fragments (commas / spaces) — concat-preserving.
const SOFT_BREAK = /[，,、;；\s]/;

// Split text into fragments such that joining them with "" reproduces the input exactly
// (no characters added or dropped). First by sentence punctuation, then long fragments
// are softly split at commas/spaces so no single segment is unreadably long.
export function splitSentences(text: string, maxLen = 48): string[] {
  const s = text || "";
  if (!s.trim()) return [];
  const pass1: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    buf += s[i];
    if (SENT_END.test(s[i])) {
      while (i + 1 < s.length && TRAIL.test(s[i + 1])) buf += s[++i];
      pass1.push(buf);
      buf = "";
    }
  }
  if (buf) pass1.push(buf);

  const out: string[] = [];
  for (const frag of pass1) {
    if (frag.length <= maxLen) {
      out.push(frag);
      continue;
    }
    let b = "";
    for (let i = 0; i < frag.length; i++) {
      b += frag[i];
      if (b.length >= maxLen && SOFT_BREAK.test(frag[i])) {
        out.push(b);
        b = "";
      }
    }
    if (b) out.push(b);
  }
  return out.filter((f) => f.length > 0);
}

// Rough "spoken length" of a fragment: CJK/Kana/Hangul glyphs ≈ one syllable each,
// Latin/digits are denser per syllable, punctuation barely takes time. Used only as
// relative weights for proportional spreading, so exact values don't matter.
export function spokenWeight(frag: string): number {
  let w = 0;
  for (const ch of frag) {
    if (/\s/.test(ch)) continue;
    if (/[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7A3]/.test(ch)) w += 1;
    else if (/[A-Za-z0-9]/.test(ch)) w += 0.45;
    else w += 0.2;
  }
  return Math.max(w, 0.1);
}

// Distribute `text` across the voiced `runs` proportionally to spoken weight, producing
// Whisper-verbose-like segments [{start,end,text,speaker?}]. Speaker (when runs carry it,
// i.e. Diarize) is taken from the run under each fragment's midpoint.
export function alignTextToTimeline(
  text: string,
  runs: Run[],
  totalDur: number
): AlignSeg[] {
  const frags = splitSentences(text);
  if (!frags.length) return [];

  let rs = (runs || [])
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (!rs.length) rs = [{ start: 0, end: Math.max(totalDur || 0, 0.1) }];
  const voiced = rs.reduce((n, r) => n + (r.end - r.start), 0) || 0.1;

  // Map a position along the concatenated voiced timeline to real seconds (skipping
  // the silent gaps between runs), and report which run (speaker) it falls in.
  const voicedToReal = (v: number): { t: number; speaker?: string } => {
    let acc = 0;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      const d = r.end - r.start;
      if (v <= acc + d || i === rs.length - 1) {
        return { t: r.start + Math.min(d, Math.max(0, v - acc)), speaker: r.speaker };
      }
      acc += d;
    }
    const last = rs[rs.length - 1];
    return { t: last.end, speaker: last.speaker };
  };

  const weights = frags.map(spokenWeight);
  const W = weights.reduce((a, b) => a + b, 0) || 1;

  const segs: AlignSeg[] = [];
  let cum = 0;
  for (let i = 0; i < frags.length; i++) {
    const vStart = (cum / W) * voiced;
    cum += weights[i];
    const vEnd = (cum / W) * voiced;
    const a = voicedToReal(vStart);
    const b = voicedToReal(vEnd);
    const mid = voicedToReal((vStart + vEnd) / 2);
    const start = a.t;
    const end = Math.max(b.t, start + 0.05);
    segs.push({ start: round3(start), end: round3(end), text: frags[i], speaker: mid.speaker });
  }
  return segs;
}

// Distribute a whole-clip transcript across EXPLICIT segmentation runs (VAD / Diarize):
// exactly one output segment per run, the text sliced in order proportionally to each
// run's duration. Unlike alignTextToTimeline this does NOT need sentence punctuation
// (faster-whisper's Chinese output has none), so it's the path used whenever VAD/Diarize
// is on — the run timeline drives the fused segmentation for EVERY engine, which is what
// makes VAD/Diarize actually change the STT result. Diarize speaker rides along per run.
export function distributeTextOverRuns(text: string, runs: Run[]): AlignSeg[] {
  const rs = (runs || [])
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (!rs.length) return [];
  const chars = Array.from((text || "").trim());
  const N = chars.length;
  if (!N) return rs.map((r) => ({ start: round3(r.start), end: round3(r.end), text: "", speaker: r.speaker }));

  const durs = rs.map((r) => r.end - r.start);
  const totDur = durs.reduce((a, b) => a + b, 0) || 1;

  const SNAP = 6; // chars: nudge a cut onto a nearby sentence/comma break for readability
  const segs: AlignSeg[] = [];
  let idx = 0;
  let acc = 0;
  for (let i = 0; i < rs.length; i++) {
    acc += durs[i];
    let target = i === rs.length - 1 ? N : Math.round((acc / totDur) * N);
    target = Math.max(idx, Math.min(N, target));
    // Snap the cut to a nearby break, preferring sentence-end over a soft (comma) break,
    // staying strictly within (idx, N] so no run steals another's or empties wrongly.
    if (target > idx && target < N) {
      let best = -1;
      let bestKind = 0;
      let bestDist = SNAP + 1;
      const lo = Math.max(idx + 1, target - SNAP);
      const hi = Math.min(N, target + SNAP);
      for (let k = lo; k <= hi; k++) {
        const c = chars[k - 1]; // the break char ends the slice [idx, k)
        const kind = SENT_END.test(c) ? 2 : SOFT_BREAK.test(c) ? 1 : 0;
        if (!kind) continue;
        const dist = Math.abs(k - target);
        if (kind > bestKind || (kind === bestKind && dist < bestDist)) {
          best = k;
          bestKind = kind;
          bestDist = dist;
        }
      }
      if (best > idx) target = best;
    }
    const slice = chars.slice(idx, target).join("").trim();
    idx = target;
    segs.push({ start: round3(rs[i].start), end: round3(rs[i].end), text: slice, speaker: rs[i].speaker });
  }
  // Append any leftover (rounding remainder) to the last segment that has text.
  if (idx < N) {
    const tail = chars.slice(idx).join("");
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].text || i === 0) {
        segs[i].text = (segs[i].text + tail).trim();
        break;
      }
    }
  }
  // Drop runs that ended up with no text so the fused view isn't padded with empties.
  return segs.filter((s) => s.text);
}
