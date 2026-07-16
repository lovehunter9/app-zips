#!/usr/bin/env bash
# 3_run_api_test_negative.sh
#
# API 错误响应 + DeepL 无 key 连通性：验证 STT 使用指南文档里描述的错误矩阵与代码一致。
#
# 覆盖：
#   N1:  NLLB 不传 text 也不传 file              → 期望 400
#   N2:  NLLB 同时传 text + file                 → 期望 400
#   N3:  Transcribe 不传 file                    → 期望 422（FastAPI Form 必填）
#   N4:  YouTube metadata 传无效 URL             → 期望 400
#   N5:  DeepL 不传 auth_key                     → 期望 422
#   N6:  DeepL 传无效 auth_key                   → 期望 502（DeepL 上游返回 401/403，FastAPI 包装为 502）
#   C1:  DeepL languages 端点（无 key 可访问）   → 期望 200
#   N7:  batched 传非 bool 字符串                → 期望 422
#   N8:  text_cleaning 传非 bool                 → 期望 422
#   N9:  segment_merging 传非 bool               → 期望 422
#   N10: language 传未知值                       → 期望 400（来自 _normalize_language）
#   N11: DeepL src_lang 传未知值                 → 期望 400（来自 _normalise_deepl_lang，对称于 N12）
#   N12: NLLB src_lang 传未知值                  → 期望 400（来自 _normalise_nllb_lang，对称于 N11）
#   N13: YouTube transcribe 不传 youtube_url     → 期望 422（FastAPI Form 必填，对称于 N3）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BUNDLE_ROOT"

source "$SCRIPT_DIR/lib/_common.sh"

TS=$(date +%Y%m%d_%H%M%S)
OUT="results/api_negative_${TS}"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.tsv"
printf 'step\tendpoint\tmethod\thttp\telapsed_ms\tnotes\n' > "$SUMMARY"

echo "==============================================="
echo " API 错误响应 + DeepL 连通性  →  $OUT"
echo "==============================================="
echo ""

smoke_check
echo ""

# ── N1: NLLB 不传 text 也不传 file ─────────────────────────────
# 关键：src_lang/tgt_lang 必须传齐，否则 FastAPI 422 会先于业务 400 触发
echo "── N1: NLLB 不传 text 也不传 file（期望 400）──"
call N1_nllb_missing POST /v1/text/translations/nllb "$OUT/n1.json" \
  -F "src_lang=eng_Latn" \
  -F "tgt_lang=zho_Hans"

# ── N2: NLLB 同时传 text + file ────────────────────────────────
echo ""
echo "── N2: NLLB 同时传 text 和 file（期望 400）──"
echo "Hello" > "$OUT/_tmp_n2.txt"
call N2_nllb_conflict POST /v1/text/translations/nllb "$OUT/n2.json" \
  -F "text=Hello" \
  -F "file=@${OUT}/_tmp_n2.txt" \
  -F "src_lang=eng_Latn" \
  -F "tgt_lang=zho_Hans"

# ── N3: Transcribe 不传 file ───────────────────────────────────
echo ""
echo "── N3: Transcribe 不传 file（期望 422）──"
call N3_transcribe_no_file POST /v1/audio/transcriptions "$OUT/n3.json" \
  -F "model=large-v2"

# ── N4: YouTube metadata 无效 URL ──────────────────────────────
echo ""
echo "── N4: YouTube metadata 无效 URL（期望 400）──"
# 注意：实际端点是 GET /v1/youtube/metadata
call N4_youtube_bad_url GET /v1/youtube/metadata "$OUT/n4.json" \
  -G --data-urlencode "url=https://not-a-youtube-url.example.com/foo"

# ── N5: DeepL 不传 auth_key ────────────────────────────────────
echo ""
echo "── N5: DeepL 不传 auth_key（期望 422）──"
# 字段名是 src_lang / tgt_lang
call N5_deepl_no_key POST /v1/text/translations/deepl "$OUT/n5.json" \
  -F "text=Hello" \
  -F "src_lang=EN" \
  -F "tgt_lang=ZH"

# ── N6: DeepL 传无效 auth_key（验证上游连通性 + 502 包装）──────
# 用一个明显的假 key，让 DeepL 返回 401，FastAPI 应包装为 502。
echo ""
echo "── N6: DeepL 传无效 auth_key（期望 502，验证 DeepL 上游可达 + 错误包装）──"
call N6_deepl_bad_key POST /v1/text/translations/deepl "$OUT/n6.json" \
  -F "text=Hello" \
  -F "src_lang=EN" \
  -F "tgt_lang=ZH" \
  -F "auth_key=FAKE_INVALID_KEY_FOR_CONNECTIVITY_TEST"

# ── C1: DeepL languages 端点（无 key 可访问）──────────────────
echo ""
echo "── C1: DeepL languages 端点（不需要 key，期望 200）──"
# 注意：DeepL languages 是 GET
call C1_deepl_langs GET /v1/translations/deepl/languages "$OUT/c1.json"

# ── N7~N9: WebUI 新增三参数的负面用例 ──────────────────────────
# 这些参数是 FastAPI 的 `bool = Form(...)` 字段，FastAPI 会接受
# `true/false/1/0/yes/no/on/off` 的字符串变体（不区分大小写）；其他值返回 422。
# 用 en_10s 作最小转录负载，response_format=text 避免大响应体。
echo ""
echo "── N7: batched 传非 bool 字符串（期望 422）──"
call N7_batched_invalid POST /v1/audio/transcriptions "$OUT/n7.json" \
  -F "file=@audio/clips/en_10s.wav" \
  -F "model=large-v2" \
  -F "language=en" \
  -F "response_format=text" \
  -F "batched=maybe"

echo ""
echo "── N8: text_cleaning 传非 bool（期望 422）──"
call N8_cleaning_invalid POST /v1/audio/transcriptions "$OUT/n8.json" \
  -F "file=@audio/clips/en_10s.wav" \
  -F "model=large-v2" \
  -F "language=en" \
  -F "response_format=text" \
  -F "text_cleaning=sometimes"

echo ""
echo "── N9: segment_merging 传非 bool（期望 422）──"
call N9_merging_invalid POST /v1/audio/transcriptions "$OUT/n9.json" \
  -F "file=@audio/clips/en_10s.wav" \
  -F "model=large-v2" \
  -F "language=en" \
  -F "response_format=text" \
  -F "segment_merging=invalid"

# ── N10: language 传不存在的语种（期望 400 来自 _normalize_language）──
echo ""
echo "── N10: language 传未知值（期望 400 + 列出可接受形式）──"
call N10_language_unknown POST /v1/audio/transcriptions "$OUT/n10.json" \
  -F "file=@audio/clips/en_10s.wav" \
  -F "model=large-v2" \
  -F "language=Klingon" \
  -F "response_format=text"

# ── N11: DeepL src_lang 传未知值（期望 400 来自 _normalise_deepl_lang）──
# 验证 DeepL 端的 name/code 兼容层在收到未知值时返回 400，而不是
# 透传给上游让它在 502 里抱怨。auth_key 仍传一个虚假但合法长度的串
# 以越过 422，让请求真正进到 normalise 路径。
echo ""
echo "── N11: DeepL src_lang 传未知值（期望 400 + 提示查 GET .../languages）──"
call N11_deepl_lang_unknown POST /v1/text/translations/deepl "$OUT/n11.json" \
  -F "text=Hello" \
  -F "src_lang=Klingon" \
  -F "tgt_lang=ZH" \
  -F "auth_key=FAKE_INVALID_KEY_FOR_NORMALISE_TEST"

# ── N12: NLLB src_lang 传未知值（期望 400 来自 _normalise_nllb_lang）──
# 对称于 N11——验证 NLLB 端的 name/code 兼容层在收到未知值时返回
# 400，而不是直接把 dict 索引的 KeyError 包成 500（修复前的真实行为）。
# tgt_lang 仍传一个合法的 NLLB code，让 src_lang 是唯一的 400 触发源。
echo ""
echo "── N12: NLLB src_lang 传未知值（期望 400 + 提示查 GET .../languages）──"
call N12_nllb_lang_unknown POST /v1/text/translations/nllb "$OUT/n12.json" \
  -F "text=Hello" \
  -F "src_lang=Klingon" \
  -F "tgt_lang=zho_Hans"

# ── N13: YouTube transcribe 不传 youtube_url（期望 422）─────────
# 对称于 N3（transcribe 不传 file → 422），验证 /v1/audio/transcriptions/youtube
# 的 youtube_url 字段确实是 FastAPI Form 必填。顺带卡住"用户拼错字段名（如
# 用 url= 而非 youtube_url=）"这种常见笔误——FastAPI 的 422 响应正文里会
# 直接点名缺失字段是 youtube_url，便于用户快速定位。
echo ""
echo "── N13: YouTube transcribe 不传 youtube_url（期望 422）──"
call N13_youtube_no_url POST /v1/audio/transcriptions/youtube "$OUT/n13.json" \
  -F "model=large-v2" \
  -F "response_format=text"

# ── 分析报告 ──────────────────────────────────────────────────
echo ""
echo "[negative] 全部调用完成，开始分析..."
python3 "$SCRIPT_DIR/lib/analyze_api_negative.py" "$OUT" > "$OUT/report.md"
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
