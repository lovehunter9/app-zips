#!/usr/bin/env bash
# 1b_run_controlled_verification.sh
#
# 受控验证：用 7 组合证明（用响应 _meta 而非推断）：
#   1. Batched 路径是否真在跑（_meta.path = "batched" / "buffered" / "batched_fallback_to_buffered"）
#   2. text_cleaning / segment_merging 开关是否真生效
#   3. Batched 强制覆盖的几个 kwargs（_BATCHED_DROPPED_KWARGS）是否真被剥
#   4. 当调用方请求 condition_on_previous_text=true 时，Batched 路径是否仍把它强制为 false
#
# 所有断言基于响应里的 `_meta` 字段（非 OpenAI 标准字段，本开发版调试用），
# 这意味着结论是"可观测的事实"而不是任何推断。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BUNDLE_ROOT"

source "$SCRIPT_DIR/lib/_common.sh"

TS=$(date +%Y%m%d_%H%M%S)
OUT="results/controlled_verify_${TS}"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.tsv"
printf 'step\tendpoint\tmethod\thttp\telapsed_ms\tnotes\n' > "$SUMMARY"

echo "==============================================="
echo " 受控验证：Batched / Cleaning / Merging / 强制覆盖"
echo " → $OUT"
echo "==============================================="
echo ""

need_clips
smoke_check
warmup_engine "audio/clips/en_10s.wav"
echo ""

# 用 en_30s.wav：英文清晰、多段（约 5 段）、长度足以触发 merge 和 cleaning 都有事做
CLIP="audio/clips/en_30s.wav"
LANG="en"

run_case() {
  local LABEL="$1"; shift
  local OUT_FILE="$OUT/${LABEL}.json"
  local HEADERS_FILE="$OUT/${LABEL}.headers.txt"

  echo "── ${LABEL} ──"
  local START_NS END_NS ELAPSED_MS HTTP_CODE
  START_NS=$(date +%s%N)
  # -D 把响应头另存一份，方便非 verbose 格式取 X-Whisper-* 头
  HTTP_CODE=$(curl -sS -m 180 -D "$HEADERS_FILE" -o "$OUT_FILE" -w "%{http_code}" \
              -X POST "${API}/v1/audio/transcriptions" \
              -F "file=@${CLIP}" \
              -F "model=large-v2" \
              -F "language=${LANG}" \
              -F "response_format=verbose_json" \
              -F "_diag=true" \
              "$@" 2>&1 || echo "000")
  END_NS=$(date +%s%N)
  ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
  echo "    HTTP $HTTP_CODE  ${ELAPSED_MS}ms"

  local NOTES=""
  case "$HTTP_CODE" in
    2*) ;;
    *)  NOTES="HTTP_${HTTP_CODE}" ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$LABEL" "/v1/audio/transcriptions" "POST" "$HTTP_CODE" "$ELAPSED_MS" "$NOTES" >> "$SUMMARY"
}

# C1: 全关基线
run_case C1_buffered_no_postproc \
  -F "batched=false" \
  -F "text_cleaning=false" \
  -F "segment_merging=false" \
  -F "condition_on_previous_text=false"

# C2: 仅开 Batched（与 C1 同一 audio + 同 kwargs，区别只是 batched）
run_case C2_batched_no_postproc \
  -F "batched=true" \
  -F "text_cleaning=false" \
  -F "segment_merging=false" \
  -F "condition_on_previous_text=false"

# C3: 仅开 text_cleaning
run_case C3_buffered_cleaning_only \
  -F "batched=false" \
  -F "text_cleaning=true" \
  -F "segment_merging=false" \
  -F "condition_on_previous_text=false"

# C4: 仅开 segment_merging
run_case C4_buffered_merging_only \
  -F "batched=false" \
  -F "text_cleaning=false" \
  -F "segment_merging=true" \
  -F "condition_on_previous_text=false"

# C5: Buffered + 双后处理
run_case C5_buffered_both_postproc \
  -F "batched=false" \
  -F "text_cleaning=true" \
  -F "segment_merging=true" \
  -F "condition_on_previous_text=false"

# C6: Batched + 双后处理（全开）
run_case C6_batched_both_postproc \
  -F "batched=true" \
  -F "text_cleaning=true" \
  -F "segment_merging=true" \
  -F "condition_on_previous_text=false"

# C7: Batched + 故意传 condition_on_previous_text=true（应被强制剥成 False）
run_case C7_batched_with_condition_true \
  -F "batched=true" \
  -F "text_cleaning=false" \
  -F "segment_merging=false" \
  -F "condition_on_previous_text=true"

echo ""
echo "[1b] 全部 7 组完成，开始分析..."

python3 "$SCRIPT_DIR/lib/analyze_controlled_verify.py" "$OUT"

echo ""
echo "==============================================="
echo " 完成 ✓"
echo "==============================================="
echo "  原始响应: $OUT/*.json"
echo "  响应头  : $OUT/*.headers.txt"
echo "  汇总表  : $OUT/summary.tsv"
echo "  分析报告: $OUT/report.md  +  $OUT/report.txt"
echo ""
echo "── report.txt 完整内容（请整段贴给我）─────────────"
cat "$OUT/report.txt"
