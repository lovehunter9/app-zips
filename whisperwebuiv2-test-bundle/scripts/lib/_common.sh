# Shared bash helpers for all test scripts.
# Source this file via: source "$SCRIPT_DIR/lib/_common.sh"

# Default API endpoint (Pod-internal). Override via env: API=http://<host>:8082
: "${API:=http://localhost:8000}"

# ── 通用 smoke check ──────────────────────────────────────────
# 注意：本开发版 /healthz 的 "ok" 条件是「模型已加载」，而模型只在首次 transcribe
# 调用时才会加载。因此 "loading" 是合法的初始状态，并不代表服务不可用——
# 只要 /healthz 能拿到 2xx 响应，就说明 FastAPI 进程在跑、路由可达。
# 真正的"引擎就绪"由 warmup_engine() 通过一次实际的 transcribe 调用来验证。
smoke_check() {
  echo "[common] Smoke check: GET $API/healthz"
  local resp http_code
  resp=$(curl -sS -m 5 -w "\n__HTTP__%{http_code}" "$API/healthz" 2>&1 || echo $'\n__HTTP__000')
  http_code="${resp##*__HTTP__}"
  resp="${resp%$'\n__HTTP__'*}"
  echo "  → HTTP $http_code  body=$resp"
  case "$http_code" in
    2*)
      case "$resp" in
        *'"status":"ok"'*)     echo "  ✓ 引擎已就绪（status=ok）" ;;
        *'"status":"loading"'*) echo "  ✓ FastAPI 进程活着（status=loading 属正常初始态，将由 warmup 触发模型加载）" ;;
        *)                      echo "  ✓ FastAPI 进程活着（响应：$resp）" ;;
      esac
      ;;
    *)
      echo "  ❌ /healthz 不可达（HTTP $http_code），请确认 Pod Ready、API 端口正确；中止。"
      exit 1
      ;;
  esac
}

# ── Warmup：用最短的 clip 触发模型加载（首次 30-60s 是正常的）─────
# 等价于 STT 指南里第一次 transcribe 调用——一旦成功，后续调用都是热路径。
# 若 30 秒短音频用例都凑不出来，则跳过 warmup（脚本里自行兜底）。
warmup_engine() {
  local CLIP="${1:-audio/clips/en_10s.wav}"
  if [ ! -f "$CLIP" ]; then
    echo "[common] Warmup 跳过：未找到 $CLIP"
    return 0
  fi
  echo "[common] Warmup: 用 $CLIP 触发首次模型加载（可能 30-90s）..."
  local START_NS END_NS ELAPSED_MS HTTP_CODE TMP
  TMP=$(mktemp)
  START_NS=$(date +%s%N)
  HTTP_CODE=$(curl -sS -m 300 -o "$TMP" -w "%{http_code}" \
    -X POST "$API/v1/audio/transcriptions" \
    -F "file=@${CLIP}" \
    -F "model=large-v2" \
    -F "language=en" \
    -F "response_format=json" || echo "000")
  END_NS=$(date +%s%N)
  ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
  echo "  → HTTP $HTTP_CODE  ${ELAPSED_MS}ms"

  case "$HTTP_CODE" in
    2*)
      echo "  ✓ 模型加载成功，引擎已就绪"
      # 二次 healthz 确认
      local h
      h=$(curl -sS -m 5 "$API/healthz" 2>/dev/null || echo "")
      echo "  → 二次 /healthz: $h"
      rm -f "$TMP"
      ;;
    *)
      echo "  ❌ Warmup 转录失败（HTTP $HTTP_CODE）。响应前 300 字："
      head -c 300 "$TMP"
      echo ""
      echo ""
      echo "  可能原因：1) 模型权重未下载完整；2) GPU 不可用；3) 镜像/PVC 异常。"
      echo "  中止：后续测试无意义。"
      rm -f "$TMP"
      exit 1
      ;;
  esac
}

# ── 通用 curl 包装：捕获 HTTP code + 耗时（毫秒）─────────────────
# call <step_id> <method> <path> <out_file> [curl extra args...]
# 写入 SUMMARY 一行：step\tendpoint\tmethod\thttp\telapsed_ms\tnotes
call() {
  local STEP="$1"; shift
  local METHOD="$1"; shift
  local URL_PATH="$1"; shift
  local OUT_FILE="$1"; shift

  echo "  [$STEP] $METHOD $URL_PATH"
  local START_NS END_NS ELAPSED_MS HTTP_CODE
  START_NS=$(date +%s%N)
  HTTP_CODE=$(curl -sS -m 180 -o "$OUT_FILE" -w "%{http_code}" \
                   -X "$METHOD" "${API}${URL_PATH}" "$@" 2>&1 || echo "000")
  END_NS=$(date +%s%N)
  ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))

  local NOTES=""
  case "$HTTP_CODE" in
    2*) ;;
    000) NOTES="CURL_FAIL" ;;
    *)   NOTES="HTTP_${HTTP_CODE}" ;;
  esac

  echo "      → HTTP $HTTP_CODE  ${ELAPSED_MS}ms  ${NOTES}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$STEP" "$URL_PATH" "$METHOD" "$HTTP_CODE" "$ELAPSED_MS" "$NOTES" >> "$SUMMARY"
}

# ── 长音频用的 curl 包装：超时拉到 45 分钟 ────────────────────────
# call_long <step_id> <method> <path> <out_file> [curl extra args...]
# 同 call()，区别只是 -m 2700 而非 -m 180；用于直接转录原始长音频文件
# （单文件 25~45 分钟、large-v2 GPU 也要几分钟到十几分钟）。
call_long() {
  local STEP="$1"; shift
  local METHOD="$1"; shift
  local URL_PATH="$1"; shift
  local OUT_FILE="$1"; shift

  echo "  [$STEP] $METHOD $URL_PATH (long-audio timeout=2700s)"
  local START_NS END_NS ELAPSED_MS HTTP_CODE
  START_NS=$(date +%s%N)
  HTTP_CODE=$(curl -sS -m 2700 -o "$OUT_FILE" -w "%{http_code}" \
                   -X "$METHOD" "${API}${URL_PATH}" "$@" 2>&1 || echo "000")
  END_NS=$(date +%s%N)
  ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))

  local NOTES=""
  case "$HTTP_CODE" in
    2*) ;;
    000) NOTES="CURL_FAIL_OR_TIMEOUT" ;;
    *)   NOTES="HTTP_${HTTP_CODE}" ;;
  esac

  echo "      → HTTP $HTTP_CODE  ${ELAPSED_MS}ms  ${NOTES}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$STEP" "$URL_PATH" "$METHOD" "$HTTP_CODE" "$ELAPSED_MS" "$NOTES" >> "$SUMMARY"
}

# ── 文件存在性兜底 ──────────────────────────────────────────────
need_clips() {
  local CLIPS_COUNT
  CLIPS_COUNT=$(ls audio/clips/*.wav 2>/dev/null | wc -l | tr -d ' ')
  if [ "$CLIPS_COUNT" -lt 1 ]; then
    echo "ERROR: audio/clips/ 为空，请先运行 bash scripts/prepare_audio.sh" >&2
    exit 1
  fi
}
