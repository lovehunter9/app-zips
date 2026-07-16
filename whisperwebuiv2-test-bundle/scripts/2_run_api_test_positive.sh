#!/usr/bin/env bash
# 2_run_api_test_positive.sh
#
# API Happy Path：按 STT 使用指南 §2.10 跑 11 个端点的正向调用，
# 验证响应结构、关键字段、返回格式。生成 results/api_positive_<ts>/report.md。
#
# 跳过：YouTube 真实转录（默认仅测 metadata，避免每次 30s+ 等待）。
#       想跑真实 YouTube 转录请：RUN_YT=1 bash scripts/2_run_api_test_positive.sh
# 跳过：DeepL 真实翻译（无 key，Script 3 会做无 key 的连通性 + 错误路径检查）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BUNDLE_ROOT"

source "$SCRIPT_DIR/lib/_common.sh"

# ── 输出目录 ───────────────────────────────────────────────────
TS=$(date +%Y%m%d_%H%M%S)
OUT="results/api_positive_${TS}"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.tsv"
printf 'step\tendpoint\tmethod\thttp\telapsed_ms\tnotes\n' > "$SUMMARY"

echo "==============================================="
echo " API Happy Path 实测  →  $OUT"
echo "==============================================="
echo ""

need_clips
smoke_check
warmup_engine "audio/clips/en_10s.wav"
echo ""

# 选 30s 的英文 clip 做最常用的转录测试（足够快、足够多段）
CLIP_EN="audio/clips/en_30s.wav"
CLIP_EN_SHORT="audio/clips/en_10s.wav"

# ── §2.10.0 运维与发现 ──────────────────────────────────────────
echo "── §2.10.0 运维与发现 ──"
call P0_healthz GET /healthz "$OUT/p0_healthz.json"
call P0_models  GET /v1/models "$OUT/p0_models.json"
call P0_openapi GET /openapi.json "$OUT/p0_openapi.json"

# ── §2.10.1 /v1/audio/transcriptions（OpenAI 兼容）─────────────
echo ""
echo "── §2.10.1 /v1/audio/transcriptions ──"
call P1a_transcribe_json POST /v1/audio/transcriptions "$OUT/p1a_transcribe_json.json" \
  -F "file=@${CLIP_EN}" \
  -F "model=large-v2" \
  -F "language=en" \
  -F "response_format=json"

call P1b_transcribe_verbose POST /v1/audio/transcriptions "$OUT/p1b_transcribe_verbose.json" \
  -F "file=@${CLIP_EN}" \
  -F "model=large-v2" \
  -F "language=en" \
  -F "response_format=verbose_json" \
  -F "timestamp_granularities[]=word"

call P1c_transcribe_srt POST /v1/audio/transcriptions "$OUT/p1c_transcribe_srt.srt" \
  -F "file=@${CLIP_EN}" \
  -F "model=large-v2" \
  -F "language=en" \
  -F "response_format=srt"

# ── §2.10.2 /v1/audio/translations（强制译英）──────────────────
echo ""
echo "── §2.10.2 /v1/audio/translations ──"
# 用中文 clip 测翻译效果（应输出英文）
CLIP_ZH="audio/clips/zh_30s.wav"
call P2a_translate_json POST /v1/audio/translations "$OUT/p2a_translate_json.json" \
  -F "file=@${CLIP_ZH}" \
  -F "model=large-v2" \
  -F "language=zh" \
  -F "response_format=json"

call P2b_translate_verbose POST /v1/audio/translations "$OUT/p2b_translate_verbose.json" \
  -F "file=@${CLIP_ZH}" \
  -F "model=large-v2" \
  -F "language=zh" \
  -F "response_format=verbose_json"

# ── §2.10.3 /v1/audio/transcriptions/youtube ──────────────────
echo ""
echo "── §2.10.3 /v1/audio/transcriptions/youtube ──"
# 用 metadata 探测（不真正下载/转录）
YT_URL="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
# 注意：metadata 端点是 GET /v1/youtube/metadata?url=...
# 不是 POST，也不在 /audio/transcriptions/ 路径下
call P3a_youtube_metadata GET /v1/youtube/metadata "$OUT/p3a_yt_metadata.json" \
  -G --data-urlencode "url=${YT_URL}"

if [ "${RUN_YT:-0}" = "1" ]; then
  echo "  RUN_YT=1 → 跑真实 YouTube 转录（可能需要 30-60s + 公网出站）..."
  call P3b_youtube_real POST /v1/audio/transcriptions/youtube "$OUT/p3b_yt_real.json" \
    -F "youtube_url=${YT_URL}" \
    -F "model=large-v2" \
    -F "response_format=verbose_json"
else
  echo "  [SKIP] 真实 YouTube 转录（设置 RUN_YT=1 启用）"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "P3b_youtube_real" "/v1/audio/transcriptions/youtube" "POST" "SKIP" "0" "RUN_YT_NOT_SET" >> "$SUMMARY"
fi

# ── §2.10.4 NLLB 文本翻译 ─────────────────────────────────────
echo ""
echo "── §2.10.4 NLLB 文本翻译（首次 ~30s 加载模型）──"
# 注意：models / languages 是 GET，路径不含 /text/
call P4a_nllb_models GET /v1/translations/nllb/models "$OUT/p4a_nllb_models.json"

call P4b_nllb_languages GET /v1/translations/nllb/languages "$OUT/p4b_nllb_languages.json"

# 注意：字段名是 src_lang / tgt_lang（不是 source_lang/target_lang）
# 单条用 plain string；批量用 JSON-encoded list of strings
call P4c_nllb_text_single POST /v1/text/translations/nllb "$OUT/p4c_nllb_text_single.json" \
  -F "text=Hello, world! Whisper is a speech recognition model." \
  -F "src_lang=eng_Latn" \
  -F "tgt_lang=zho_Hans" \
  -F "model_size=facebook/nllb-200-distilled-600M"

call P4d_nllb_text_batch POST /v1/text/translations/nllb "$OUT/p4d_nllb_text_batch.json" \
  -F 'text=["Good morning.","How are you today?","Have a nice day."]' \
  -F "src_lang=eng_Latn" \
  -F "tgt_lang=zho_Hans"

# 文件路径走 NLLB 字幕翻译（先生成一个 srt）
TMP_SRT="$OUT/_tmp_subtitle.srt"
cat > "$TMP_SRT" <<'EOF'
1
00:00:00,000 --> 00:00:02,000
Hello, this is a subtitle test.

2
00:00:02,000 --> 00:00:04,000
The second line should also be translated.
EOF

call P4e_nllb_file POST /v1/text/translations/nllb "$OUT/p4e_nllb_file.json" \
  -F "file=@${TMP_SRT}" \
  -F "src_lang=eng_Latn" \
  -F "tgt_lang=zho_Hans"

# ── §2.10.5 DeepL languages（不需要 key，验证路由可达）─────────
echo ""
echo "── §2.10.5 DeepL languages（不需要 key）──"
# 注意：DeepL languages 是 GET（无副作用，无需 body）
call P5a_deepl_langs GET /v1/translations/deepl/languages "$OUT/p5a_deepl_langs.json"

# ── §2.10.X 引擎可观测性覆盖（_meta.path / batched / cleaning / merging）──
# 这部分针对 WebUI 新增的 batched / text_cleaning / segment_merging 三个开关，
# 验证它们的"开/关"是否真的体现在 _meta 字段里。
echo ""
echo "── §2.10.X 引擎可观测性覆盖（_meta 验证）──"

# 用最短的英文 clip（避免拉长 happy path 总时间），仍用 verbose_json 拿 _meta
META_CLIP="audio/clips/en_10s.wav"

call P6a_meta_buffered_no_postproc POST /v1/audio/transcriptions "$OUT/p6a_meta_buffered_no_postproc.json" \
  -F "file=@${META_CLIP}" \
  -F "model=large-v2" \
  -F "language=en" \
  -F "response_format=verbose_json" \
  -F "batched=false" \
  -F "text_cleaning=false" \
  -F "segment_merging=false" \
  -F "_diag=true"

call P6b_meta_batched_no_postproc POST /v1/audio/transcriptions "$OUT/p6b_meta_batched_no_postproc.json" \
  -F "file=@${META_CLIP}" \
  -F "model=large-v2" \
  -F "language=en" \
  -F "response_format=verbose_json" \
  -F "batched=true" \
  -F "text_cleaning=false" \
  -F "segment_merging=false" \
  -F "_diag=true"

call P6c_meta_buffered_both_postproc POST /v1/audio/transcriptions "$OUT/p6c_meta_buffered_both_postproc.json" \
  -F "file=@${META_CLIP}" \
  -F "model=large-v2" \
  -F "language=en" \
  -F "response_format=verbose_json" \
  -F "batched=false" \
  -F "text_cleaning=true" \
  -F "segment_merging=true" \
  -F "_diag=true"

call P6d_meta_batched_both_postproc POST /v1/audio/transcriptions "$OUT/p6d_meta_batched_both_postproc.json" \
  -F "file=@${META_CLIP}" \
  -F "model=large-v2" \
  -F "language=en" \
  -F "response_format=verbose_json" \
  -F "batched=true" \
  -F "text_cleaning=true" \
  -F "segment_merging=true" \
  -F "_diag=true"

# ── 分析报告 ──────────────────────────────────────────────────
echo ""
echo "[positive] 全部调用完成，开始分析..."
python3 "$SCRIPT_DIR/lib/analyze_api_positive.py" "$OUT" > "$OUT/report.md"
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
