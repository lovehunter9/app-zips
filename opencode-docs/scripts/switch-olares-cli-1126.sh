#!/usr/bin/env bash
# 在不改镜像的前提下，把当前 opencode（旧镜像）的 olares-cli 切到 1.12.6-cli.2（二进制自报 1.12.6），
# 装到自定义 prefix 并把其 bin 放到 PATH 最前 + 写入 ~/.bashrc 固化（扛重启/新终端）。
# 回退用同目录的 revert-olares-cli.sh。
#
# 用法:  bash switch-olares-cli-1126.sh
# 环境变量(可选):
#   OLARES_CLI_DOWNLOAD_MIRROR=https://<可达镜像>   # npm postinstall 下载走该镜像
set -euo pipefail

VER="1.12.6-cli.2"
PFX="$HOME/.olares-cli"
LINE='export PATH="$HOME/.olares-cli/bin:$PATH"'
EXPECT_COMMIT="d30eca705df2fb614bf2bbea95daa2e6998adeeb"

echo "[*] 目标: @olares/cli@$VER  ->  $PFX"
echo "[*] 现状: $(command -v olares-cli || echo '(none)')  =>  $(olares-cli --version 2>/dev/null | head -1 || echo 'n/a')"

installed=0

# 首选: npm wrapper 安装到独立 prefix（postinstall 自动下 vendor 二进制，GitHub 404 时自动落 CDN）
if command -v npm >/dev/null 2>&1; then
  echo "[*] 用 npm 安装到独立 prefix ..."
  if npm install -g "@olares/cli@$VER" --prefix "$PFX"; then
    installed=1
  else
    echo "[!] npm 安装失败，回退到直连 CDN 下载二进制 ..."
  fi
fi

# 兜底: 直连 CDN 下载对应架构的 Go 二进制，手动放到 $PFX/bin
if [ "$installed" != 1 ]; then
  case "$(uname -m)" in
    x86_64|amd64)  ARCH="linux_amd64" ;;
    aarch64|arm64) ARCH="linux_arm64" ;;
    armv7l|arm)    ARCH="linux_arm" ;;
    *) echo "[x] 未知架构: $(uname -m)"; exit 1 ;;
  esac
  MIRROR="${OLARES_CLI_DOWNLOAD_MIRROR:-https://cdn.olares.com}"
  URL="${MIRROR%/}/olares-cli-v${VER}_${ARCH}.tar.gz"
  echo "[*] 下载 $URL"
  mkdir -p "$PFX/bin"
  tmp="$(mktemp -d)"
  curl -fsSL --max-time 120 "$URL" -o "$tmp/ocli.tgz"
  tar xzf "$tmp/ocli.tgz" -C "$tmp"
  bin="$(find "$tmp" -type f -name olares-cli | head -1)"
  [ -n "$bin" ] || { echo "[x] 解压后未找到 olares-cli"; exit 1; }
  install -m 0755 "$bin" "$PFX/bin/olares-cli"
  rm -rf "$tmp"
fi

# 固化 PATH
grep -qF "$LINE" "$HOME/.bashrc" 2>/dev/null || echo "$LINE" >> "$HOME/.bashrc"

# 当前会话立即生效
export PATH="$PFX/bin:$PATH"
hash -r 2>/dev/null || true

echo
echo "[*] which: $(command -v olares-cli)"
VER_OUT="$(olares-cli --version 2>&1 || true)"
echo "$VER_OUT"
if echo "$VER_OUT" | grep -q "$EXPECT_COMMIT"; then
  echo "[✓] 校验通过：commit $EXPECT_COMMIT（真 1.12.6）"
else
  echo "[!] 未匹配到期望 commit（$EXPECT_COMMIT）。若显示 1.12.6 且能用，多为构建元信息差异；否则检查下载来源。"
fi
echo "[i] 已固化到 ~/.bashrc；新终端自动生效，本终端已生效。回退请运行 revert-olares-cli.sh"
