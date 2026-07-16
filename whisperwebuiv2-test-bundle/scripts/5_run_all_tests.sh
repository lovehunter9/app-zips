#!/usr/bin/env bash
# 5_run_all_tests.sh
#
# 总验证：一水跑 Script 1 / 1b / 2 / 3 / 4，最后把每个子报告合并到一份
# OVERALL_REPORT.txt，方便单一报告交付（你只贴这一份给我）。
#
# 用法：
#   bash scripts/5_run_all_tests.sh                  # 全跑（短+受控+API+长，约 25-50 分钟）
#   SKIP_LONG=1 bash scripts/5_run_all_tests.sh      # 跳过长音频（约 15-20 分钟）
#   SKIP=1,4 bash scripts/5_run_all_tests.sh         # 自定义跳过 1 和 4（用 1b/2/3 跑）
#   SKIP=1b bash scripts/5_run_all_tests.sh          # 单跳 1b
#
# 设计要点：
#   1. 失败不中断：任何子脚本失败，剩下的继续跑，最后摘要表里标 ❌
#   2. 退出码透传：全部成功 → exit 0；任一失败 → exit 1
#   3. 一份报告：把 1, 1b, 2, 3, 4 的 report.md 拼到 OVERALL_REPORT.md/.txt
#   4. 子脚本结果目录自动定位：通过 results/<prefix>_<timestamp>/ 取最新一个

set -uo pipefail   # 注意不带 -e —— 子脚本失败我们要继续

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BUNDLE_ROOT"

# ── 解析 SKIP 设置 ────────────────────────────────────────────
SKIP_LIST="${SKIP:-}"
if [ "${SKIP_LONG:-0}" = "1" ]; then
  if [ -z "$SKIP_LIST" ]; then
    SKIP_LIST="4"
  else
    SKIP_LIST="${SKIP_LIST},4"
  fi
fi

should_skip() {
  local id="$1"
  case ",${SKIP_LIST}," in
    *",${id},"*) return 0 ;;
  esac
  return 1
}

# ── 输出目录 ───────────────────────────────────────────────────
TS=$(date +%Y%m%d_%H%M%S)
TOTAL_OUT="results/overall_${TS}"
mkdir -p "$TOTAL_OUT"
OVERALL_MD="$TOTAL_OUT/OVERALL_REPORT.md"
OVERALL_TXT="$TOTAL_OUT/OVERALL_REPORT.txt"

# ── 步骤定义（id : 脚本文件 : 结果目录前缀 : 标签）────────────
STEP_SPECS=(
  "1:1_run_short_audio_test.sh:short_audio:短音频实测 (10 clip × 2 模式)"
  "1b:1b_run_controlled_verification.sh:controlled_verify:受控可观测性验证 (7 组合)"
  "2:2_run_api_test_positive.sh:api_positive:API happy path (11 端点 + _meta)"
  "3:3_run_api_test_negative.sh:api_negative:API 错误响应 + DeepL 连通性 (13 用例)"
  "4:4_run_long_audio_test.sh:long_audio:长音频实测 (zh+en × 2 模式)"
)

# ── 状态追踪（并行数组，bash 3.x 兼容）─────────────────────────
STEP_IDS=()
STEP_LABELS=()
STEP_RESULTS=()   # OK / SKIP / FAIL(exit=N)
STEP_PATHS=()
STEP_DURATIONS=()
TOTAL_FAIL=0

# ── 一次跑一个子脚本 ──────────────────────────────────────────
run_step() {
  local id="$1"
  local script="$2"
  local prefix="$3"
  local label="$4"

  STEP_IDS+=("$id")
  STEP_LABELS+=("$label")

  if should_skip "$id"; then
    echo ""
    echo "==============================================="
    echo " ⏭️  Script $id 跳过 ($label)"
    echo "==============================================="
    STEP_RESULTS+=("SKIP")
    STEP_PATHS+=("")
    STEP_DURATIONS+=("0")
    return
  fi

  echo ""
  echo "==============================================="
  echo " ▶ Script $id: $label"
  echo "==============================================="
  echo ""

  local start_ts end_ts elapsed exit_code
  start_ts=$(date +%s)
  exit_code=0
  bash "$SCRIPT_DIR/$script" || exit_code=$?
  end_ts=$(date +%s)
  elapsed=$((end_ts - start_ts))

  local latest_dir
  latest_dir=$(ls -1dt "results/${prefix}_"*/ 2>/dev/null | head -1 || true)
  latest_dir="${latest_dir%/}"

  STEP_PATHS+=("$latest_dir")
  STEP_DURATIONS+=("$elapsed")

  if [ "$exit_code" -eq 0 ]; then
    STEP_RESULTS+=("OK")
    echo ""
    echo "── ✅ Script $id 完成（exit=0, 耗时 ${elapsed}s）──"
  else
    STEP_RESULTS+=("FAIL(exit=${exit_code})")
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    echo ""
    echo "── ❌ Script $id 失败（exit=${exit_code}, 耗时 ${elapsed}s）──"
  fi
}

# ── 头部 ───────────────────────────────────────────────────────
echo "==============================================="
echo " Whisper-WebUI 测试套件总验证"
echo "==============================================="
echo " 时间戳    : $TS"
echo " 输出目录  : $TOTAL_OUT"
echo " 跳过列表  : ${SKIP_LIST:-(无)}"
echo " 总报告    : $OVERALL_TXT（跑完贴这份给我）"
echo "==============================================="

# ── 依次执行 ──────────────────────────────────────────────────
for spec in "${STEP_SPECS[@]}"; do
  IFS=':' read -r SID SSCRIPT SPREFIX SLABEL <<< "$spec"
  run_step "$SID" "$SSCRIPT" "$SPREFIX" "$SLABEL"
done

# ── 聚合 OVERALL_REPORT ───────────────────────────────────────
echo ""
echo "==============================================="
echo " 聚合总报告 → $OVERALL_MD"
echo "==============================================="

{
  echo "# Whisper-WebUI 测试套件总验证报告"
  echo ""
  echo "- **时间戳**: \`$TS\`"
  echo "- **输出目录**: \`$TOTAL_OUT\`"
  echo "- **步骤总数**: ${#STEP_IDS[@]}"
  if [ -n "$SKIP_LIST" ]; then
    echo "- **跳过列表**: \`$SKIP_LIST\`"
  fi
  echo ""

  # 执行摘要表
  echo "## 0. 执行摘要"
  echo ""
  echo "| Script | 用例 | 状态 | 耗时(s) | 结果目录 |"
  echo "|---|---|---|---:|---|"
  for i in "${!STEP_IDS[@]}"; do
    local_id="${STEP_IDS[$i]}"
    local_label="${STEP_LABELS[$i]}"
    local_result="${STEP_RESULTS[$i]}"
    local_path="${STEP_PATHS[$i]}"
    local_dur="${STEP_DURATIONS[$i]}"

    case "$local_result" in
      OK)    local_emoji="✅" ;;
      SKIP)  local_emoji="⏭️" ;;
      *)     local_emoji="❌" ;;
    esac
    printf "| %s | %s | %s %s | %s | \`%s\` |\n" \
      "$local_id" "$local_label" "$local_emoji" "$local_result" \
      "$local_dur" "${local_path:-(N/A)}"
  done
  echo ""

  ran_count=0
  ok_count=0
  for r in "${STEP_RESULTS[@]}"; do
    case "$r" in
      SKIP) ;;
      OK) ran_count=$((ran_count + 1)); ok_count=$((ok_count + 1)) ;;
      *) ran_count=$((ran_count + 1)) ;;
    esac
  done

  if [ "$TOTAL_FAIL" -gt 0 ]; then
    echo "**总结**: ❌ 已跑 $ran_count 个步骤，其中 $TOTAL_FAIL 个失败。详见各子报告。"
  elif [ "$ran_count" -eq 0 ]; then
    echo "**总结**: ⏭️ 全部步骤被跳过，无实际执行。"
  else
    echo "**总结**: ✅ 已跑 $ran_count 个步骤全部通过。"
  fi
  echo ""
  echo "---"
  echo ""

  # 子报告逐个 cat
  for i in "${!STEP_IDS[@]}"; do
    local_id="${STEP_IDS[$i]}"
    local_label="${STEP_LABELS[$i]}"
    local_result="${STEP_RESULTS[$i]}"
    local_path="${STEP_PATHS[$i]}"

    echo "# Script $local_id 子报告 — $local_label"
    echo ""

    case "$local_result" in
      SKIP)
        echo "_本步骤被跳过（SKIP 列表：\`$SKIP_LIST\`）_"
        ;;
      OK|FAIL*)
        if [ -n "$local_path" ] && [ -f "$local_path/report.md" ]; then
          if [[ "$local_result" == FAIL* ]]; then
            echo "> ⚠️ 本步骤退出码非 0 (\`$local_result\`)，下面仍贴出已生成的报告内容供分析。"
            echo ""
          fi
          cat "$local_path/report.md"
        else
          echo "_未找到 report.md（状态：\`$local_result\`，结果目录：\`${local_path:-无}\`）_"
        fi
        ;;
    esac

    echo ""
    echo "---"
    echo ""
  done

  echo ""
  echo "_由 \`scripts/5_run_all_tests.sh\` 聚合自上述 ${#STEP_IDS[@]} 个子报告_"
} > "$OVERALL_MD"

cp "$OVERALL_MD" "$OVERALL_TXT"

# ── 尾部输出 ───────────────────────────────────────────────────
echo ""
echo "==============================================="
if [ "$TOTAL_FAIL" -gt 0 ]; then
  echo " ❌ 总验证完成 — $TOTAL_FAIL 个步骤失败"
else
  echo " ✅ 总验证完成 — 全部通过"
fi
echo "==============================================="
echo "  总报告 (md) : $OVERALL_MD"
echo "  总报告 (txt): $OVERALL_TXT"
echo ""
echo "  → 把 $OVERALL_TXT 内容贴给我（避免 markdown 渲染）"
echo "    （较长，可能上千行；如果终端贴困难，下载 .txt 也行）"
echo ""

# 给出报告头预览，方便快速判断结果
echo "── 总报告摘要（前 ~40 行）─────────────────"
head -40 "$OVERALL_TXT"
echo "── ... 完整内容请看上面给出的 .txt 路径 ───────"

exit $([ "$TOTAL_FAIL" -gt 0 ] && echo 1 || echo 0)
