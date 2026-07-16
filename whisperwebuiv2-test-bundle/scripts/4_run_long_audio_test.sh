#!/usr/bin/env bash
# 4_run_long_audio_test.sh
#
# 长音频实测：直接用原始/完整音频文件做 Batched vs Buffered 对照。
#
# 短音频测试（Script 1）里 Batched 反而比 Buffered 慢——这是符合预期的：
# BatchedInferencePipeline 的 batch dispatch 开销在 30 秒以内基本吃满了
# Whisper 编码器的并行收益。Batched 真正发光的场景是 5 分钟以上的长音频
# （成倍的 VAD chunk 同时进 batch，单 GPU 吞吐量翻倍以上）。
#
# 这个脚本就是把 Batched 放到它该发挥的场景上测一次，同时也是本开发版
# clip_timestamps 修复后 Batched 路径首次"真的应该跑得起来"的样本。
#
# 用例矩阵：2 语种 × 2 模式 = 4 次调用
#   L1 zh Buffered
#   L2 zh Batched
#   L3 en Buffered
#   L4 en Batched
#
# 全部以 _diag=true 调用，响应里带 _meta.path，能直接看出 Batched 是否真跑。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BUNDLE_ROOT"

source "$SCRIPT_DIR/lib/_common.sh"

# ── 找长音频文件 ──────────────────────────────────────────────
# 接受三种摆法（任一都可）：
#   (1) audio/long/zh_long.{mp3,wav,m4a,flac}  ← 推荐：你重命名/软链到这里
#   (2) audio/source/流浪地球*.mp3
#   (3) audio/source/*.mp3（如果只有一个 mp3 就直接用）
find_long_audio() {
  local LANG=$1  # zh or en
  local pat
  # 推荐路径
  for ext in mp3 wav m4a flac; do
    if [ -f "audio/long/${LANG}_long.${ext}" ]; then
      echo "audio/long/${LANG}_long.${ext}"
      return 0
    fi
  done
  # source/ 兜底：按文件名特征匹配
  if [ "$LANG" = "zh" ]; then
    for f in audio/source/*流浪地球*.mp3 audio/source/*.mp3; do
      [ -f "$f" ] || continue
      # 跳过英文常见名（避免错把英文当中文）
      case "$(basename "$f")" in
        *adventureholmes*|*holmes*|*doyle*) continue ;;
      esac
      echo "$f"; return 0
    done
  else
    for f in audio/source/*adventureholmes*.mp3 audio/source/*holmes*.mp3 audio/source/*doyle*.mp3 audio/source/*.mp3; do
      [ -f "$f" ] || continue
      case "$(basename "$f")" in
        *流浪地球*|*于和伟*) continue ;;
      esac
      echo "$f"; return 0
    done
  fi
  return 1
}

# ── 输出目录 ───────────────────────────────────────────────────
TS=$(date +%Y%m%d_%H%M%S)
OUT="results/long_audio_${TS}"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.tsv"
printf 'step\tendpoint\tmethod\thttp\telapsed_ms\tnotes\n' > "$SUMMARY"

echo "==============================================="
echo " 长音频实测  →  $OUT"
echo "==============================================="
echo ""

smoke_check
warmup_engine "audio/clips/en_10s.wav"
echo ""

# ── 定位音频 ──────────────────────────────────────────────────
ZH_FILE=$(find_long_audio zh || true)
EN_FILE=$(find_long_audio en || true)

if [ -z "$ZH_FILE" ] && [ -z "$EN_FILE" ]; then
  echo "[FATAL] 找不到任何长音频文件。请把原始 mp3 放到以下任一位置："
  echo "  推荐：audio/long/zh_long.mp3  audio/long/en_long.mp3"
  echo "  或者：audio/source/流浪地球02：飞船派和地球派 于和伟演播.mp3"
  echo "         audio/source/adventureholmes_02_doyle_64kb.mp3"
  exit 1
fi

if [ -n "$ZH_FILE" ]; then
  ZH_SIZE_MB=$(du -m "$ZH_FILE" | cut -f1)
  echo "[long] 中文源: $ZH_FILE (${ZH_SIZE_MB} MB)"
else
  echo "[long] ⚠️ 中文音频未找到，将跳过 zh 用例"
fi
if [ -n "$EN_FILE" ]; then
  EN_SIZE_MB=$(du -m "$EN_FILE" | cut -f1)
  echo "[long] 英文源: $EN_FILE (${EN_SIZE_MB} MB)"
else
  echo "[long] ⚠️ 英文音频未找到，将跳过 en 用例"
fi
echo ""

# ── 用例 ───────────────────────────────────────────────────────
run_long_case() {
  local LABEL=$1; local FILE=$2; local LANG=$3; local BATCHED=$4
  local OUT_FILE="$OUT/${LABEL}.json"
  call_long "$LABEL" POST /v1/audio/transcriptions "$OUT_FILE" \
    -F "file=@${FILE}" \
    -F "model=large-v2" \
    -F "language=${LANG}" \
    -F "response_format=verbose_json" \
    -F "batched=${BATCHED}" \
    -F "text_cleaning=false" \
    -F "segment_merging=false" \
    -F "_diag=true"
}

if [ -n "$ZH_FILE" ]; then
  echo "── L1 中文 Buffered ──"
  run_long_case L1_zh_buffered "$ZH_FILE" zh false
  echo "── L2 中文 Batched ──"
  run_long_case L2_zh_batched "$ZH_FILE" zh true
fi
if [ -n "$EN_FILE" ]; then
  echo "── L3 英文 Buffered ──"
  run_long_case L3_en_buffered "$EN_FILE" en false
  echo "── L4 英文 Batched ──"
  run_long_case L4_en_batched "$EN_FILE" en true
fi

echo ""
echo "[long] 全部调用完成，开始分析..."

python3 "$SCRIPT_DIR/lib/analyze_long_audio.py" "$OUT" > "$OUT/report.md"
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
