// Chinese word segmentation via jieba (compiled to WASM). ICU's built-in
// Intl.Segmenter over-splits many words (e.g. 天际 → 天 + 际); jieba ships a real
// dictionary and segments far better. The wasm (~4MB) is loaded lazily the first
// time the 词 (word) view needs it for a Chinese transcript, so it never costs
// anything for English-only content or the 字 view.
import initJieba, { tokenize } from "jieba-wasm/web";

export interface JToken {
  word: string;
  start: number; // char index (Unicode scalar), matches JS string.slice
  end: number;
}

type State = "idle" | "loading" | "ok" | "err";
let state: State = "idle";
let promise: Promise<void> | null = null;

export const jiebaState = (): State => state;

// Kick off (or reuse) the one-time wasm init. Safe to call repeatedly.
export function ensureJieba(): Promise<void> {
  if (!promise) {
    state = "loading";
    promise = initJieba()
      .then(() => { state = "ok"; })
      .catch((e) => { state = "err"; console.error("[jieba] wasm init failed", e); });
  }
  return promise;
}

// Tokenize Chinese text into words with char offsets. Returns [] when jieba isn't
// ready (callers then fall back to Intl.Segmenter).
export function jiebaCut(text: string): JToken[] {
  if (state !== "ok") return [];
  try {
    return tokenize(text, "default", true) as unknown as JToken[];
  } catch {
    return [];
  }
}
