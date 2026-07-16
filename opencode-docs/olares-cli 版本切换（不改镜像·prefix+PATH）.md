# 在旧版 opencode 镜像里切换 olares-cli 版本（不改镜像 · prefix + PATH）

> 目的：在**不重建镜像**的前提下，让一台使用旧镜像的 opencode，在运行时真正用上
> `@olares/cli@1.12.6-cli.2`（二进制自报 `1.12.6`），并能随时**固化**（扛重启/新终端）
> 或**撤销固化**回到镜像自带的基础版 `1.12.5-cli.8`。

---

## 0. 背景与原理（先看懂，再动手）

### 两套版本号，别混
- `@olares/cli` 是一个 **npm 包装器（Node wrapper）**。它的 `postinstall` 会**按包版本**去下载
  对应架构的 **olares-cli Go 二进制**，解压到该包自己的 `vendor/` 目录。
- `olares-cli --version` 报的是**那个 Go 二进制的版本**，不是 npm 包版本。
- npm dist-tags 现状：
  - `latest = 1.12.5-cli.8`（正式版；二进制自报 `1.12.5-cli.8`）
  - `next   = 1.12.6-cli.2`（预发布；二进制自报 `1.12.6`）
- opencode 镜像构建时用的就是 `OLARES_CLI_NPM_VERSION=1.12.6-cli.2`
  （见 `opencode-docker/Dockerfile` / `build.sh`）。**新镜像**装出来的就是真 `1.12.6`。

### 真 1.12.6 二进制的指纹（用于校验）
```
olares-cli version 1.12.6
Git commit: d30eca705df2fb614bf2bbea95daa2e6998adeeb
Build time: 2026-07-06T06:33:00Z
```
`Git commit` 是编进二进制的，缓存/糊弄伪造不出来；**位对位同一构建即以此为准**。

### 为什么旧 pod 里 `npm install -g @olares/cli@1.12.6-cli.2` 不生效
- wrapper 把二进制放进**包自己的 `vendor/`**，PATH 上的 `olares-cli` 就是 exec 这个 vendor 二进制。
- 旧 pod 里你敲的 `olares-cli` 解析到的是**排在 PATH 更前面的旧二进制**（镜像自带的 1.12.5），
  npm 重装更新的是另一份 shim，你 shell 根本没用到它 → `--version` 不变。
- **对策**：装到**自定义 prefix**，把该 prefix 的 `bin` **放到 PATH 最前**，盖过旧的。

### 下载来源（会自动兜底）
`install.js` 依次尝试：
1. `https://github.com/beclab/Olares/releases/download/1.12.6-cli.2/olares-cli-v1.12.6-cli.2_<arch>.tar.gz`
   —— 该 tag 资产目前 **404**；
2. `https://cdn.olares.com/olares-cli-v1.12.6-cli.2_<arch>.tar.gz` —— **CDN 兜底**（实际生效的这条）。

`<arch>`：`linux_amd64` / `linux_arm64`（`uname -m`：`x86_64→amd64`，`aarch64→arm64`）。

---

## 1. 安装到自定义 prefix + PATH（临时生效，仅当前终端）

opencode 里 `$HOME=/home/opencode` 是持久化目录，装这里能扛重启。

```bash
PFX="$HOME/.olares-cli"

# 装进独立 prefix（-g + --prefix：装进 $PFX/lib，shim 落在 $PFX/bin，postinstall 自动下 vendor 二进制）
npm install -g @olares/cli@1.12.6-cli.2 --prefix "$PFX"

# 让这个 bin 抢在旧 olares-cli 前面
export PATH="$PFX/bin:$PATH"
hash -r 2>/dev/null || true       # 清掉 shell 对旧路径的缓存

# 校验：必须是 1.12.6 且 commit 一致
command -v olares-cli             # 应指向 $HOME/.olares-cli/bin/olares-cli
olares-cli --version             # -> 1.12.6 / Git commit d30eca705...
```

> 下载慢/被墙时，设镜像后重装：
> ```bash
> OLARES_CLI_DOWNLOAD_MIRROR="https://<你的可达镜像>" \
>   npm install -g @olares/cli@1.12.6-cli.2 --prefix "$PFX"
> ```

---

## 2. 固化（持久化 PATH，扛重启 / 新终端）

把 PATH 覆盖写进 shell 启动文件（同样在 `$HOME` 下，持久）：

```bash
LINE='export PATH="$HOME/.olares-cli/bin:$PATH"'
grep -qF "$LINE" "$HOME/.bashrc" 2>/dev/null || echo "$LINE" >> "$HOME/.bashrc"
# 若还用 zsh / 登录 shell，按需同样追加到 ~/.zshrc / ~/.profile
```

固化后：新开终端、pod 重启（`$HOME` 持久）都会优先用 `$HOME/.olares-cli/bin` 里的 1.12.6。

---

## 3. 撤销固化 / 回退到基础版 1.12.5-cli.8

基础版（镜像自带 `1.12.5-cli.8`）**一直没被改过**，只是被 PATH 盖住。回退 = 撤 PATH 覆盖 + 删自定义 prefix。

```bash
PFX="$HOME/.olares-cli"

# 1) 删掉写进启动文件的 PATH 覆盖行
grep -n 'olares-cli/bin' "$HOME/.bashrc"                                  # 先看一眼
sed -i '\#export PATH="$HOME/.olares-cli/bin:$PATH"#d' "$HOME/.bashrc"
#   如也写进了 ~/.zshrc / ~/.profile，同样删对应行

# 2) 删掉自定义 prefix（含 shim 与 vendor 二进制，彻底清除）
rm -rf "$PFX"

# 3) 让当前终端立刻回退：摘掉本会话 PATH 前缀 + 清缓存（或直接开新终端）
export PATH="$(echo "$PATH" | sed "s#$HOME/.olares-cli/bin:##g")"
hash -r 2>/dev/null || true

# 4) 验证已回到基础版
command -v olares-cli      # 不再指向 $HOME/.olares-cli/bin
olares-cli --version       # -> olares-cli version 1.12.5-cli.8
```

> 不需要 `npm uninstall`；装在独立 prefix，`rm -rf "$PFX"` 更干净。
> （若坚持用 npm：`npm uninstall -g @olares/cli --prefix "$PFX"`。）

---

## 4. 一键脚本（复制即用）

### 4.1 安装 + 固化：`switch-olares-cli-1126.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
PFX="$HOME/.olares-cli"
VER="1.12.6-cli.2"

echo "[*] installing @olares/cli@$VER into $PFX ..."
npm install -g "@olares/cli@$VER" --prefix "$PFX"

LINE='export PATH="$HOME/.olares-cli/bin:$PATH"'
grep -qF "$LINE" "$HOME/.bashrc" 2>/dev/null || echo "$LINE" >> "$HOME/.bashrc"

export PATH="$PFX/bin:$PATH"; hash -r 2>/dev/null || true
echo "[*] which: $(command -v olares-cli)"
olares-cli --version
echo "[✓] 期望：version 1.12.6 / Git commit d30eca705df2fb614bf2bbea95daa2e6998adeeb"
echo "[i] 新终端已固化；本终端已生效。"
```

### 4.2 撤销固化 + 回退：`revert-olares-cli.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
PFX="$HOME/.olares-cli"

sed -i '\#export PATH="$HOME/.olares-cli/bin:$PATH"#d' "$HOME/.bashrc" 2>/dev/null || true
rm -rf "$PFX"
export PATH="$(echo "$PATH" | sed "s#$HOME/.olares-cli/bin:##g")"; hash -r 2>/dev/null || true
echo "[*] which: $(command -v olares-cli || echo '(none)')"
olares-cli --version || true
echo "[✓] 期望回到基础版：olares-cli version 1.12.5-cli.8"
```

---

## 5. 常见坑

- **postinstall 下载**：GitHub 那条 404，会自动走 `cdn.olares.com`；都不通就用 `OLARES_CLI_DOWNLOAD_MIRROR`。
- **npm shim 带 `OLARES_CLI_REMOTE_ONLY=1`**（`bin/olares-cli.js` 写死）：只裁掉主机侧动作
  （uninstall/upgrade/node/os/gpu/disk/user/wizard/osinfo/amdgpu）；market/cluster/dashboard/
  files/settings/search 等远程动作照常，opencode 的 skills 用的正是这些，不受影响。
- **当前会话没变**：同一个终端里 `export PATH` 只在本会话有效；改完 rc 记得**开新终端**或按脚本摘/加前缀。
- **持久化位置**：务必装在 `$HOME`（opencode 的持久 hostPath）下；装到 `/usr/local` 等 rootfs 上层，
  pod 重启后会丢。

---

## 6. 一句话速记
- 装新版：`npm install -g @olares/cli@1.12.6-cli.2 --prefix "$HOME/.olares-cli"` + 把 `$HOME/.olares-cli/bin` 放 PATH 最前（写进 `~/.bashrc` 固化）。
- 回退：删 rc 里那行 + `rm -rf "$HOME/.olares-cli"` + 开新终端 → 自动回到 `1.12.5-cli.8`。
- 校验：`olares-cli --version` 看 `Git commit d30eca705...` 认准真 1.12.6。
