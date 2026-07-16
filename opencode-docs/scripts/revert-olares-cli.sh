#!/usr/bin/env bash
# 撤销 switch-olares-cli-1126.sh 的改动：删掉 ~/.bashrc 里的 PATH 覆盖行、删掉自定义 prefix，
# 让镜像自带的基础版 olares-cli(1.12.5-cli.8) 重新生效。
#
# 用法:  bash revert-olares-cli.sh
set -euo pipefail

PFX="$HOME/.olares-cli"

echo "[*] 回退前: $(command -v olares-cli || echo '(none)')  =>  $(olares-cli --version 2>/dev/null | head -1 || echo 'n/a')"

# 1) 删掉写进各 shell 启动文件的 PATH 覆盖行
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  [ -f "$rc" ] || continue
  sed -i '\#export PATH="$HOME/.olares-cli/bin:$PATH"#d' "$rc" 2>/dev/null || true
done

# 2) 删掉自定义 prefix（含 shim 与 vendor 二进制）
rm -rf "$PFX"

# 3) 当前会话立即回退：摘掉本会话 PATH 前缀 + 清缓存
export PATH="$(echo "$PATH" | sed "s#$HOME/.olares-cli/bin:##g")"
hash -r 2>/dev/null || true

echo
echo "[*] which: $(command -v olares-cli || echo '(none)')"
olares-cli --version 2>&1 | head -1 || true
echo "[✓] 期望回到基础版：olares-cli version 1.12.5-cli.8"
echo "[i] 若当前终端仍显示旧覆盖，开一个新终端即可彻底干净。"
