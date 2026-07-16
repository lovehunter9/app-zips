#!/usr/bin/env bash
# prepare_audio.sh
#
# Utility: 把 audio/source/ 下的 1 中 1 英源音频切成 5 个时长档（10s/30s/1min/3min/5min），
# 输出到 audio/clips/。用 Pod 内已有的 ffmpeg。
#
# 自动按文件名 CJK 字符识别中/英语种，避免硬编码具体文件名。

set -euo pipefail

# ── 路径切到 test_bundle 根目录 ───────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BUNDLE_ROOT"

SRC_DIR="audio/source"
OUT_DIR="audio/clips"
mkdir -p "$OUT_DIR"

# ── ffmpeg 兜底安装（若镜像偶然回归丢失） ────────────────────────
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[prepare] ffmpeg not found, installing..."
  apt-get update -qq && apt-get install -y -qq ffmpeg
fi

# ── Python 兜底（脚本里要用 Python 做文件名 CJK 检测） ──────────
if ! command -v python3 >/dev/null 2>&1; then
  echo "[prepare] ERROR: python3 not found in container" >&2
  exit 1
fi

# ── 扫描源目录，按 CJK 字符识别语种 ────────────────────────────
echo "[prepare] Scanning $SRC_DIR/ ..."

ZH_SRC=""
EN_SRC=""

# 用 Python 做扫描 + 分组（一次性输出 zh_path<TAB>en_path）
mapfile -t SRC_INFO < <(python3 - <<'PYEOF'
import os
import sys
import unicodedata
from pathlib import Path

SRC = Path("audio/source")
EXTS = {".mp3", ".wav", ".m4a", ".flac", ".webm", ".mp4"}

def is_zh(name: str) -> bool:
    """Detect Chinese filename by presence of CJK Unified Ideographs."""
    return any(0x4E00 <= ord(c) <= 0x9FFF for c in name)

zh_candidates = []
en_candidates = []

for f in sorted(SRC.iterdir()) if SRC.exists() else []:
    if not f.is_file() or f.suffix.lower() not in EXTS:
        continue
    if f.name.startswith("."):
        continue
    info = (f, f.stat().st_size)
    (zh_candidates if is_zh(f.name) else en_candidates).append(info)

# Pick the largest of each group (avoids accidentally using a fragment)
def pick_largest(lst):
    return max(lst, key=lambda x: x[1])[0] if lst else None

zh = pick_largest(zh_candidates)
en = pick_largest(en_candidates)

print(f"ZH\t{zh if zh else ''}")
print(f"EN\t{en if en else ''}")
print(f"ZH_CANDIDATES\t{len(zh_candidates)}")
print(f"EN_CANDIDATES\t{len(en_candidates)}")
PYEOF
)

for line in "${SRC_INFO[@]}"; do
  key="${line%%$'\t'*}"
  val="${line#*$'\t'}"
  case "$key" in
    ZH) ZH_SRC="$val" ;;
    EN) EN_SRC="$val" ;;
    ZH_CANDIDATES) ZH_COUNT="$val" ;;
    EN_CANDIDATES) EN_COUNT="$val" ;;
  esac
done

echo "[prepare] Found ${ZH_COUNT:-0} 中文候选 / ${EN_COUNT:-0} 英文候选"

if [ -z "$ZH_SRC" ] || [ -z "$EN_SRC" ]; then
  echo "" >&2
  echo "ERROR: 源音频不全。" >&2
  echo "  $SRC_DIR/ 当前内容：" >&2
  ls -la "$SRC_DIR/" >&2 || true
  echo "" >&2
  echo "需要至少 1 个含 CJK 字符的文件作为中文源，和 1 个纯 ASCII 文件名的文件作为英文源。" >&2
  echo "支持的扩展名：mp3 / wav / m4a / flac / webm / mp4" >&2
  exit 1
fi

echo "[prepare] 中文源: $ZH_SRC"
echo "[prepare] 英文源: $EN_SRC"
echo ""

# ── 切片：5 个时长档 × 2 语种 = 10 个 clip ──────────────────────
# 从第 30 秒开始切，避开常见的开场静音/片头音乐
SS=30

clip() {
  local src="$1" lang="$2" dur="$3" label="$4"
  local out="$OUT_DIR/${lang}_${label}.wav"
  printf "  %s -> %s ... " "$lang" "$label"
  # -ar 16000 -ac 1：转 16kHz 单声道（与 Whisper 训练分布对齐，且减小文件大小）
  if ffmpeg -y -hide_banner -loglevel error \
       -ss "$SS" -t "$dur" -i "$src" \
       -ar 16000 -ac 1 \
       "$out" 2>&1 | tail -3; then
    local sz
    sz=$(stat -c%s "$out" 2>/dev/null || stat -f%z "$out" 2>/dev/null || echo "?")
    echo "OK ($sz bytes)"
  else
    echo "FAILED"
    return 1
  fi
}

echo "[prepare] 切片中（从源音频第 ${SS}s 开始）..."
for spec in "10s:10" "30s:30" "1min:60" "3min:180" "5min:300"; do
  LABEL="${spec%:*}"
  DUR="${spec#*:}"
  clip "$ZH_SRC" zh "$DUR" "$LABEL"
  clip "$EN_SRC" en "$DUR" "$LABEL"
done

echo ""
echo "[prepare] ✓ 全部切片完成"
echo ""
echo "audio/clips/ 内容："
ls -la "$OUT_DIR/"
