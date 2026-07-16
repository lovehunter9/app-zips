# OpenCode chart 重启工作清单（基于完全回退后重做）

> 写于 2026-04-21。用户决定完全回退这两天对 `opencode/` 的修改，本文档作为重新实现的输入。
> 回退之后照着这份清单按"优先级"分阶段做，每完成一阶段先停下来让用户验证，再做下一阶段。

---

## A. 用户已经明确的硬性约束（必须遵守）

1. **绝不修改任何系统标准二进制**。不能动 `/usr/bin/nohup`、`/usr/bin/disown` 等。所有自定义工具只能是新名字放 `/usr/local/bin/`。
2. **`webstart` 必须自动按端口加后缀**给 NAME（避免并发实例冲突）。`webstart` / `webstop` 是 agent 用的，`weblist` 是用户用的。
3. **`webstop` 必须三段式安全语义**：精确名命中 → 唯一前缀命中 → 多前缀命中**拒绝**（不允许默默批量杀）。批量必须显式 `--prefix`。
4. **不能依赖 SKILL 的懒加载**。弱模型（如 cogito-14b）不会主动 `/skill load`，关键硬规则必须放进 `olares-baseline-instructions.md`（通过 `opencode.json` 的 `instructions` 字段进系统提示，永远在 context）。
5. **角色 A / 角色 B 严格解耦**（这是这次回退的根本原因）：
   - **角色 A**：从 `~/workspace/opencode.json` 清理历史残留字面字符串。这部分代码 **冻结，永不修改**。`LEGACY_S1/S2/S3` 是 chart 历史上真的写过的字面值，集合固定。
   - **角色 B**：往 `olares-baseline-instructions.md` 写最新内容。用独立变量 `BASELINE_WEB/BASELINE_PKG/BASELINE_URL`，可以自由更新。
   - **不能让 `LEGACY_S*` 同时承担两个角色**。这是设计 bug，会让"改 baseline 内容"反过来打破"清理路径"。
6. **OMO 必须锁具体 semver**，禁用 `latest`/dist-tag。版本号通过 Olares UI 可配（`OPENCODE_OMO_VERSION`），改了自动重启。
7. **OMO 不能在每次重启都重装**。安装到持久化 hostPath 卷 `/home/opencode/.npm-global/lib/node_modules/oh-my-opencode`，重启时检 `package.json` 的 `version` 字段，相等即跳过。

---

## B. 这两天解决的 4 类问题（重做时按顺序逐个落实）

### B1. OMO 版本锁（独立、最稳，先做）

**问题**：之前 `npm install -g oh-my-opencode` 不锁版本，每次重启可能装不同版本；有时还重复安装。

**改的文件**：
- `opencode/OlaresManifest.yaml`：新增 env `OPENCODE_OMO_VERSION`
- `opencode/templates/opencode.yaml`：Helm 顶部 `$omoVersion`、init-setup 导出 `OLARES_OMO_VERSION`、`olares_run_omo()` 函数

**关键代码点**：

1. **OlaresManifest.yaml** 新增 env 块（放在已有的 `OPENCODE_OMO` 后面）：
   ```yaml
   - envName: OPENCODE_OMO_VERSION
     required: false
     applyOnChange: true
     type: string
     editable: true
     default: "3.17.4"
     description: "Pin the oh-my-opencode (OMO) npm package version installed at container startup. ALWAYS use a concrete semver (e.g. '3.17.4', '3.18.0'). DO NOT use 'latest' or other npm dist-tags — they cannot be compared as strings, so the init container will reinstall OMO on EVERY pod restart, adding 30-60s of startup time and consuming bandwidth. Find published versions at https://www.npmjs.com/package/oh-my-opencode. On change, the init container detects the mismatch and reinstalls automatically."
   ```

2. **opencode.yaml 顶部** 添加 Helm 变量：
   ```
   {{- $omoVersion := index $env "OPENCODE_OMO_VERSION" | default "3.17.4" }}
   ```

3. **init-setup container** 在已有的 `export OLARES_OC_DOMAIN`、`export OLARES_ENABLE_OMO` 后加：
   ```
   export OLARES_OMO_VERSION="{{ $omoVersion }}"
   ```

4. **`olares_run_omo()` 函数** 完全重写（关键设计点）：
   - 读 `OMO_WANT_VERSION="${OLARES_OMO_VERSION:-{{ $omoVersion }}}"`
   - semver 校验：`case "$OMO_WANT_VERSION" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "WARNING ..." ;; esac`（仅警告不阻塞）
   - 安装目标：`OMO_HOME_PREFIX="/home/opencode/.npm-global"`，`OMO_HOME_DIR="${OMO_HOME_PREFIX}/lib/node_modules/oh-my-opencode"`
   - 扫描顺序（找已安装版本）：先 `$OMO_HOME_DIR`（持久化主路径），再 legacy `/usr/lib/node_modules/...`、`/usr/local/lib/node_modules/...`、`$PKG/usr/lib/...`、`$PKG/usr/local/lib/...`
   - 用 `sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$d/package.json" | head -n1` 抓 version
   - **找到 + 版本相等** → 打 "already installed, skipping" + return 0；如在 legacy 路径 → 一次性 mirror 到 `$OMO_HOME_DIR`，让下次直接命中主路径
   - **找到 + 版本不等** → `rm -rf` 旧路径 + 继续走 install 路径
   - **install** → `apk add --no-cache nodejs npm`、CN mirror（如果 `USE_CN_MIRROR=true`）、`mkdir -p` 目标 prefix、`npm install -g --ignore-scripts --prefix "${OMO_HOME_PREFIX}" "oh-my-opencode@${OMO_WANT_VERSION}"`
   - 安装后验证 `[ -d "$OMO_HOME_DIR" ] && [ -f "$OMO_HOME_DIR/package.json" ]`
   - `chown -R 1000:1000 "${OMO_HOME_PREFIX}"` 和 `/home/opencode/.local`
   - **不要再做 "snapshot patch dance"**（往 `$PKG/usr/lib/node_modules` 复制）。`/home/opencode/.npm-global` 是 hostPath 持久化卷，本身就跨重启。

**踩过的坑**：
- 旧代码用 `cp -a ... 2>/dev/null` 把 OMO 从 ephemeral `/usr` 拷进 `$PKG/usr` snapshot，错误被吞掉，导致每次重启都重装。**不要再加 `2>/dev/null` 屏蔽 cp/install 错误**。
- 旧代码默认值是 `latest` → 字符串比较永远不等 → 永远重装。新版本默认 `"3.17.4"`，用户在 Olares UI 可改。

---

### B2. Ingress cookie/header buffer（独立、最简单，第二做）

**问题**：登录会话大 cookie 触发 `400 Bad Request - Request Header Or Cookie Too Large`。

**改的文件**：`opencode/templates/ingress.yaml`

**改动**：两个 server 块（8080 主入口 + 8081 terminal 入口）都加：
```nginx
client_header_buffer_size 16k;
large_client_header_buffers 8 32k;
```
放在已有的 `client_max_body_size 100m;` 后面即可。

**安全性**：完全向后兼容。每连接最多多消耗 256KB（仅在收到大 header 时实际分配）。

---

### B3. webstart / webstop / weblist 三件套（最复杂，第三做）

**问题**：opencode 的 shell tool 在 turn 结束时会 reap 后台进程，agent 用 `nohup &` 启动的服务会秒死。

**改的文件**：`opencode/templates/opencode.yaml` init-setup 容器内（在 `pkg-install` 之后），新增三个 `/usr/local/bin/` 脚本。

**`webstart` 关键设计点**：
- 用法：`webstart <BASE_NAME> <COMMAND...>` —— BASE_NAME 是 agent 选的短名（如 `vite`、`api`），COMMAND 是前台命令本身（不要 `nohup`、不要 `&`、不要 `> log`）
- **NAME 自动按端口加后缀**：
  1. 先扫 `$@` 找 `--port N` / `-p N` / `--port=N` / `--server.port N` / `--server-port N` / `--listen-port N` / `PORT=N`，校验 `case "$HINT_PORT" in *[!0-9]*|"") HINT_PORT="" ;; esac`
  2. 没扫到 → 启动前 `ss -tlnH` 快照存到 `/tmp/web-snap.XXXXXX.before`，启动后存 `.after`，`comm -13` 取 diff，重试 5 次
  3. 命中 → `NAME=${BASE}-${PORT}`，pid/log 文件名同步重命名
- **同名同端口 = restart**：发现 `/tmp/web-${NAME}.pid` 已存活进程 → kill old + 重启
- **进程脱钩**：`setsid nohup env "$@" >"$LOG" 2>&1 </dev/null &`，然后 `disown $CHILD 2>/dev/null || true`
- **`env "$@"`** 处理 `PORT=3000 npm start` 这种环境前缀（不走 shell 也能识别）
- 启动后 `sleep 2` 验 `kill -0 $CHILD`，死了就 tail 30 行 log 报错
- **必须用临时文件**而不是 process substitution（`/bin/sh` 在 Alpine 是 busybox ash，不支持 `<(...)`）

**`webstop` 关键设计点**：
- 三段式：
  1. `webstop NAME`：`/tmp/web-${NAME}.pid` 存在 → 精确停
  2. `webstop NAME`：精确没命中，但 `web-${NAME}-*.pid` 唯一一个匹配 → 停那一个
  3. `webstop NAME`：精确没命中，前缀有多个匹配 → **拒绝执行**，list 出候选，提示用 exact name 或 `--prefix NAME`，exit code 2
- `--prefix BASE`：显式批量，停所有 `web-${BASE}-*` + 裸 `web-${BASE}`
- `--all`：全停
- prefix glob 防空展开：`for pf in /tmp/web-${_base}-*.pid; do; [ -f "$pf" ] || continue; done`
- 计数用 `wc -l | tr -d ' '`（去空格，BSD/Linux 兼容）

**`weblist` 关键设计点**：
- 表头 + 列对齐 `printf "$FMT" "$NAME" "$P" "${PORT:-?}" "$CMD"`，FMT = `'  %-22s %-7s %-7s %s\n'`
- **端口检测**：先用 captured PID 在 `ss -tlnp` 里找；找不到再 `ps -o pid,ppid` 扫直接子进程（处理 `npx` → `node` 这种间接启动）
- 清理 stale pid 文件（pid 已死 → `rm -f`）

**verify_cache 校验列表里要把这三个加进去**：
```
usr/local/bin/webstart usr/local/bin/webstop usr/local/bin/weblist
```

**已废弃的尝试（绝不能复活）**：
- 想替换 `/usr/bin/nohup` 为智能 wrapper 自动路由到 webstart → 用户明确否决，会污染所有依赖标准 nohup 的脚本/工具。

---

### B4. baseline-instructions.md 强化 + SKILL TL;DR（最后做，注意角色 A/B 解耦）

**问题**：弱模型（cogito-14b 等）不会主动 `/skill load`，SKILL body 进不了它的 context。

**核心方案**：把 webstart 等硬规则**直接写进** `olares-baseline-instructions.md`（这个文件被 `opencode.json` 的 `instructions` 字段引用，永远在系统提示里）。SKILL.md 里也加 TL;DR 作为强模型用的"细节版"。

**改的文件**：`opencode/templates/opencode.yaml` 两处：
- 第 60+ 行的 SKILL.md 写入（`printf '%s\n' '---' 'name: web-preview' ...`）
- 第 660+ 行的 Python 脚本（处理 baseline-md + global opencode.json + workspace cleanup）

#### B4.1 SKILL.md 改动（强模型 layer）

- frontmatter `description` 加强：
  ```
  description: "MANDATORY for ANY web server. Use ONLY: webstart <name> <command>. NEVER use nohup, &, disown, or run dev servers in foreground — they all DIE before the user sees them. Covers Vite, Next.js, Vue, Flask, FastAPI, etc. Load on: run, start, serve, preview, demo, test, launch, build, create site, create app, create page, show, make website."
  ```
- 在原 `## How to preview` 之前**插入两个新 section**：
  - `## TL;DR (read this first, every time)` —— webstart 用法 + 错误姿势对照表（nohup &、& disown、前台都会死）+ "为什么"一句话 + 输出格式样例 + preview URL 模板（用 `'"$OC_DOMAIN"'` shell 插值，与已有第 500/503/506 行同款）
  - `## For Vite (most common case)` —— 完整 vite.config.js 模板（base、host、port、allowedHosts、hmr.protocol/clientPort）
- 后续保留**原有所有内容**（Step 0、framework table、各框架细节）

#### B4.2 baseline-instructions.md 强化（弱模型 layer）—— 角色 A/B 解耦

**Python 脚本第 660+ 行的关键结构**（重做时严格按此组织）：

```python
# ===== 已有不动的部分 =====
DOMAIN = os.environ.get("OLARES_OC_DOMAIN", "")
ENABLE_OMO = os.environ.get("OLARES_ENABLE_OMO", "0") == "1"
BASELINE_MD = Path("/home/opencode/.config/opencode/olares-baseline-instructions.md")
GLOBAL_JSON = Path("/home/opencode/.config/opencode/opencode.json")
WORKSPACE_JSON = Path("/home/opencode/workspace/opencode.json")
OLARES_REF = "/home/opencode/.config/opencode/olares-baseline-instructions.md"
PLUGIN_NPM = "oh-my-openagent"
STALE_PLUGIN_NPM = "oh-my-opencode"

# ===== ROLE A: workspace 清理 — 冻结，永不修改 =====
# 这三个字面值是 chart 历史上真的写过到 ~/workspace/opencode.json
# instructions 字段的字符串。下方清理循环识别它们并删除。
# 因为 app 未上线，残留集合固定且已知；编辑 LEGACY_S* 会让现存用户的
# 残留永远清不掉。要改"发给模型的内容"，编辑下面 ROLE B 的 BASELINE_*。
LEGACY_S1 = (
    "CRITICAL: You have special skills. ALWAYS run /skill load web-preview BEFORE any task involving "
    "web, server, preview, run, start, serve, build, create, demo, test, launch, deploy, site, app, page, "
    "website, frontend, backend, API, port, vite, react, next, vue, flask, go server, python server. "
    "ALWAYS run /skill load system-admin BEFORE installing ANY system package."
)
LEGACY_S2 = "NEVER use sudo, apt, or apk directly. Use pkg-install instead."
LEGACY_S3 = (
    f"NEVER show localhost URLs. The domain is {DOMAIN}. "
    f"Dev server preview URL format: https://{DOMAIN}/__preview/<port>/"
)
LEGACY = {LEGACY_S1, LEGACY_S2, LEGACY_S3}

# ===== ROLE B: baseline-instructions.md 内容 — 自由更新 =====
# 独立于 ROLE A。不接触 ~/workspace/opencode.json，只写持久化 md。
BASELINE_WEB = (
    "MANDATORY rules for ANY web/dev server task. Do NOT skip, do NOT substitute.\n\n"
    "1. Start every dev server with the `webstart` wrapper:\n"
    "       webstart <name> <command-exactly-as-you-would-type-it-foreground>\n"
    "   Examples:\n"
    "       webstart vite npx vite --port 4000 --host 0.0.0.0\n"
    "       webstart api  uvicorn app:app --host 0.0.0.0 --port 8000\n"
    "       webstart next npm run dev\n"
    "   webstart auto-suffixes the NAME with the listening port (e.g. vite-4000)\n"
    "   and uses setsid+nohup+stdio-detach so the process survives turn end.\n\n"
    "2. NEVER use any of these forms. The agent shell reaps background processes\n"
    "   at turn end, so the server dies before the user can reach the URL:\n"
    "       nohup vite ... &           dies\n"
    "       npx vite ... &             dies\n"
    "       npx vite ... & disown      dies\n"
    "       npx vite                   dies (foreground in agent shell)\n\n"
    "3. Manage running servers (always available):\n"
    "       weblist                    list all servers (also shown to the user)\n"
    "       webstop <name>             stop one by exact NAME (e.g. vite-4000)\n"
    "       webstop --prefix vite      stop every vite-* server\n"
    "       webstop --all              stop everything\n\n"
    "4. Vite 6+ blocks unknown hosts. BEFORE webstart, write vite.config.js with:\n"
    "       server.host: 0.0.0.0, server.port: <PORT>, server.allowedHosts: true,\n"
    "       server.hmr: { protocol: wss, clientPort: 443 },\n"
    "       base: /__preview/<PORT>/\n"
    "   The literal 443 stays 443. Replace <PORT> with your actual port number.\n\n"
    "5. Preview URL is always https://<DOMAIN>/__preview/<PORT>/ . NEVER show localhost.\n\n"
    "For per-framework details (Next.js, Flask, Django, Go, Rust, static, etc.) and\n"
    "the full vite.config.js template, run `/skill load web-preview`."
)
BASELINE_PKG = (
    "NEVER use `sudo`, `apt`, or `apk` directly. Use `pkg-install <pkg> [pkg ...]`\n"
    "which queues the install for the next pod restart and persists it via the\n"
    "package snapshot mechanism. Run `/skill load system-admin` for details."
)
BASELINE_URL = (
    f"NEVER show localhost URLs. The domain is {DOMAIN}. "
    f"Dev server preview URL format: https://{DOMAIN}/__preview/<port>/"
)

# ===== 写 baseline-md（用 BASELINE_*，不再用 LEGACY_*）=====
BASELINE_MD.parent.mkdir(parents=True, exist_ok=True)
md = (
    "<!-- olares-managed: baseline-instructions v1 (rewritten each pod start) -->\n\n"
    "# Olares environment baseline\n\n"
    "## Web preview and dev servers\n\n"
    + BASELINE_WEB
    + "\n\n## System packages\n\n"
    + BASELINE_PKG
    + "\n\n## URLs and domain\n\n"
    + BASELINE_URL
    + "\n"
)
BASELINE_MD.write_text(md, encoding="utf-8")

# ===== 全局 opencode.json：instructions 引用 OLARES_REF + plugin 列表 =====
# (这部分代码不需要改，原样保留)
# - cfg["instructions"] 加 OLARES_REF
# - plugins 处理：去掉 STALE_PLUGIN_NPM，按 ENABLE_OMO 决定是否加 PLUGIN_NPM

# ===== workspace.json 清理（原样保留，使用 LEGACY 集合）=====
# new_inst = [x for x in winst if x not in LEGACY]
# 如果 instructions 因此变空 → pop；如果整个 wcfg 只剩 $schema → unlink 文件
```

**关键的踩坑教训**：
- **Python 字符串字面值里不能出现 single quote (apostrophe)**，因为外层 shell 是 single quote 包装。所有英文文案要避开 `it's`、`don't` 这种缩写。
- **`OBSOLETE_LEGACY` 兜底集合不需要做**，只要 `LEGACY_S*` 字面值始终保持 chart 历史真实写过的版本（即 CRITICAL 版本）就行。
- **`LEGACY_S2` 当前冻结的字面值是短句**：`"NEVER use sudo, apt, or apk directly. Use pkg-install instead."`，**不是**两段话的扩展版。`BASELINE_PKG` 才是新的扩展版。
- **`LEGACY_S3` 历史也有过一个无 DOMAIN 插值的版本**：`"NEVER show localhost URLs. Dev servers are accessed via /__preview/<port>/ path on the current domain."` —— 这个不在当前 LEGACY 集合里，**潜在残留 bug**（见下面 D 节"反对意见"）。

---

## C. milestone 文档

旧的 `MILESTONE_opencode_web-preview_2026-04-20.md` 在回退时也会一起回退。重做完成后，重写一份精简的 milestone（不要把所有调试过程都写进去，只记结果和决策）。

---

## D. 我保留的反对意见（你回退后请决定是否处理）

### D1. 历史 LEGACY_S1 还有一个更早的版本，当前 LEGACY 集合识别不到

git history 显示有过两版 LEGACY_S1 字面值：
- **版本 A**（最早）：`"You have special skills. Before ANY web development task (create site, start server, preview), load the web-preview skill. Before installing ANY system package, load the system-admin skill."`
- **版本 B/C**（CRITICAL，当前 LEGACY_S1 里冻结的就是这个）

如果某些用户是在版本 A 时期第一次安装 chart，他们的 `~/workspace/opencode.json` 里残留的是版本 A 字面值。当前 `LEGACY = {LEGACY_S1(B/C), LEGACY_S2, LEGACY_S3}` 识别不到版本 A 残留 → 永远清不掉 → 旧版"/skill load"提示和新版 BASELINE_WEB 同时进系统提示，给模型矛盾信号。

### D2. LEGACY_S3 也有同样问题

git history 还显示版本 A 的 LEGACY_S3 是无 DOMAIN 插值的：
`"NEVER show localhost URLs. Dev servers are accessed via /__preview/<port>/ path on the current domain."`

同样不在当前 LEGACY 集合里。

### D3. 三种处理方式（你选）

1. **不管它**（最贴近你"清理代码冻结"的本意）：极少数用户受影响，他们的系统提示里多一两句旧"/skill load"指令，不致命。
2. **一次性补全 LEGACY**（解耦清晰）：在 `LEGACY_S1/S2/S3` 旁边再加一个 `EXTRA_LEGACY = { ...所有历史变体... }`，`LEGACY = {LEGACY_S1, LEGACY_S2, LEGACY_S3} | EXTRA_LEGACY`。这是冻结的兜底集合，定义之后也永不再动。
3. **手动清理**（最彻底）：让你或受影响用户进容器手动改 `~/workspace/opencode.json`，删掉残留行。

我建议 (2)。一次性写完，永久解决。代码量也就 5-8 行。

---

## E. 重做时的执行顺序（我会按这个顺序提交，每步停下来等你验证）

1. **B1 OMO 锁版本**（独立、最稳，先验证能拉起 pod 不重装 OMO）
2. **B2 Ingress buffer**（最简单，验证 pod 起来后大 cookie 不报 400）
3. **B3 webstart/webstop/weblist 三件套**（脚本独立验证，agent 跑 webstart 启动 vite 看是否保活、weblist 看输出、webstop 三段式覆盖）
4. **B4.1 SKILL TL;DR**（强模型先验证）
5. **B4.2 baseline-instructions 强化（角色 A 冻结 + 角色 B 解耦）**（弱模型层验证）
6. **D 节反对意见**：等你决定是否补 EXTRA_LEGACY

---

## F. 重做时**不要**做的事（这两天踩过的坑）

- ❌ 不要替换 `/usr/bin/nohup` 或任何系统命令的 wrapper
- ❌ 不要让 `LEGACY_S*` 同时承担"清理字面值"和"baseline-md 内容"两个角色
- ❌ 不要在 `cp -a`、`npm install` 等关键命令后用 `2>/dev/null` 屏蔽错误
- ❌ 不要在 OMO 安装后还做 "snapshot patch dance"（往 `$PKG/usr/lib/node_modules` 复制）
- ❌ 不要在 Python 字符串字面值里使用 single quote（apostrophe），会破坏外层 shell 的 single quote 包装
- ❌ 不要用 process substitution `<(...)`，busybox `ash` 不支持
- ❌ 不要用 `disown` 但又不加 `2>/dev/null || true`，busybox `ash` 没这个内置命令

---

## G. 这两天的另外两件未提交事项（不在回退范围，但相关）

1. **Open Notebook persistence + STT patch**（之前对话里提到，用户自己打包验证中）
2. **Opencode Write tool failure**（用户需手动改 `oh-my-openagent.json` 禁用某些 hooks，与本次回退无关）

回退后第一件事是**确认这两件事的代码不在 opencode chart 里**（应该是在 opennotebook chart 里），不要误回退。
