#!/usr/bin/env bash
# 1_run_short_audio_test.sh
#
# 短音频实测：对 10 个 clip（5 时长档 × 2 语种）各跑 batched=true / batched=false，
# 共 20 次调用，对比速度、段数、文本差异。生成 results/short_audio_<ts>/report.md。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BUNDLE_ROOT"

source "$SCRIPT_DIR/lib/_common.sh"

# ── 输出目录 ───────────────────────────────────────────────────
TS=$(date +%Y%m%d_%H%M%S)
OUT="results/short_audio_${TS}"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.tsv"
printf 'step\tendpoint\tmethod\thttp\telapsed_ms\tnotes\n' > "$SUMMARY"

echo "==============================================="
echo " 短音频实测  →  $OUT"
echo "==============================================="
echo ""

need_clips
smoke_check
warmup_engine "audio/clips/en_10s.wav"
echo ""

# ── 测试矩阵 ──────────────────────────────────────────────────
# (label, duration_seconds, lang_iso639_1_code)
# 使用 ISO 639-1 二字母码（zh / en）作为基础用例，与 STT 指南 §2 主示例对齐
# 也与 OpenAI Audio API 标准一致；本项目 API 同时兼容 English/Chinese 全名，
# 但测试覆盖以最小依赖的形式为准。
CASES=(
  "zh_10s:10:zh"
  "zh_30s:30:zh"
  "zh_1min:60:zh"
  "zh_3min:180:zh"
  "zh_5min:300:zh"
  "en_10s:10:en"
  "en_30s:30:en"
  "en_1min:60:en"
  "en_3min:180:en"
  "en_5min:300:en"
)

run_one() {
  local CLIP="$1"      # zh_10s
  local LANG_HINT="$2" # Chinese / English
  local BATCHED="$3"   # true / false
  local CLIP_PATH="audio/clips/${CLIP}.wav"
  local MODE
  if [ "$BATCHED" = "true" ]; then MODE="batched"; else MODE="buffered"; fi
  local OUT_FILE="$OUT/${CLIP}_${MODE}.json"

  if [ ! -f "$CLIP_PATH" ]; then
    echo "  [SKIP] $CLIP_PATH 不存在"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${CLIP}_${MODE}" "/v1/audio/transcriptions" "POST" "SKIP" "0" "MISSING_CLIP" >> "$SUMMARY"
    return
  fi

  call "${CLIP}_${MODE}" POST /v1/audio/transcriptions "$OUT_FILE" \
    -F "file=@${CLIP_PATH}" \
    -F "model=large-v2" \
    -F "language=${LANG_HINT}" \
    -F "response_format=verbose_json" \
    -F "batched=${BATCHED}" \
    -F "text_cleaning=false" \
    -F "segment_merging=false" \
    -F "_diag=true"
}

echo "[short] 跑 20 次调用（每个 clip × 2 模式）..."
for spec in "${CASES[@]}"; do
  IFS=':' read -r CLIP DUR LANG_HINT <<< "$spec"
  echo ""
  echo "── $CLIP (${DUR}s) [${LANG_HINT}] ──"
  run_one "$CLIP" "$LANG_HINT" "true"
  run_one "$CLIP" "$LANG_HINT" "false"
done

echo ""
echo "[short] 全部调用完成，开始分析..."

python3 "$SCRIPT_DIR/lib/analyze_short_audio.py" "$OUT" > "$OUT/report.md"
cp "$OUT/report.md" "$OUT/report.txt"

echo ""
echo "==============================================="
echo " 完成 ✓"
echo "==============================================="
echo "  原始响应: $OUT/*.json"
echo "  汇总表  : $OUT/summary.tsv"
echo "  分析报告: $OUT/report.md  +  $OUT/report.txt"
echo "  → 把 $OUT/report.txt 内容贴给我（避免 markdown 渲染）"
echo ""
echo "── report.txt 完整内容 ─────────────────────────"
cat "$OUT/report.txt"
