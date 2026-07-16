# Opencode Chart — 里程碑记录 2026-04-20

> 深夜备忘。明早（或下次上班）从"下一步"接着干。

## 这次解决了什么

一次性解决用户遇到的 4 类问题，全部在 `opencode` chart 里收口：

1. **Web preview 打不开** — `Blocked request` / 404 / 截图黑屏 / 时钟不出来
2. **OMO 版本失控** — 之前 `npm install -g oh-my-opencode` 不锁版本，升级意外发生
3. **nginx 大 cookie 返 400** — `Request Header Or Cookie Too Large`
4. **Web 服务"启动后秒死"** — agent 经常忘了 `nohup`；就算用了 `nohup &` opencode 的 Bash tool 也会在 turn 结束时把后台进程清掉。新增 `webstart`/`webstop`/`weblist` 三件套封装 `setsid + nohup + 全 stdio 脱钩`，并把 SKILL 改成强制只用 `webstart`。
5. **workspace.json 残留旧 LEGACY 字面值清不掉**（在 4 之前修） — 这个应用从加插件以来还没正式上线，**所有现存用户的 workspace 级 `~/workspace/opencode.json`** 都是早期 chart 版本残留下来的，里面装着字面字符串：
   - 版本 A：`"You have special skills. Before ANY web development task..."` + `"NEVER use sudo, apt, or apk directly. Use pkg-install instead."` + `"NEVER show localhost URLs. Dev servers are accessed via /__preview/<port>/..."`
   - 版本 B/C：`"CRITICAL: You have special skills. ALWAYS run /skill load web-preview..."` + 同上 pkg-install 一句
   迁移逻辑（`new_inst = [x for x in winst if x not in LEGACY]`）只能识别 `LEGACY = {LEGACY_S1, LEGACY_S2, LEGACY_S3}` 当前版本的字面值。下面 6 把 LEGACY_S1/S2 改成 webstart 新规则后，旧字面值就识别不到 → 用户 workspace.json 里的旧指令永远清不掉，会和新 baseline 同时进系统提示，给模型矛盾信号（旧版还在劝它 `/skill load`，新版已经直接下硬规则）。
   **修复**：在 `LEGACY` 定义旁加 `OBSOLETE_LEGACY` 集合，把所有历史字面值一次列全，`LEGACY = {LEGACY_S1, LEGACY_S2, LEGACY_S3} | OBSOLETE_LEGACY`。同时在 OBSOLETE_LEGACY 上方加 IMPORTANT 注释：每次改 LEGACY_S1/S2/S3 字面值，必须先把旧值搬进 OBSOLETE_LEGACY，再改新值。

6. **弱模型完全无视 SKILL** — 14B 本地模型干脆不发起 `/skill load`，SKILL body 永远进不了它的 context。修复方向是**别再依赖懒加载**：
   - 把 webstart 的最小硬规则**直接写进 `olares-baseline-instructions.md`**（即 `LEGACY_S1`）。这个文件通过全局 `opencode.json` 的 `instructions` 字段被注入系统提示，**永远在 context 里**，不需要模型主动 load。
   - 新版 baseline 里包括：webstart 用法 + 三个例子（vite/uvicorn/npm run dev）+ "禁止"姿势对照表（`nohup &` / `& disown` / 前台都会死）+ 管理命令（weblist / webstop / webstop --prefix / webstop --all）+ Vite 6+ host check 提示 + preview URL 模板 + 引导细节去 `/skill load web-preview`。
   - SKILL TL;DR + 描述强化保留作为强模型的"细节版"。
   > **绝不动系统二进制**：曾设想 `/usr/local/bin/nohup` 自动路由到 webstart，已放弃——会污染所有依赖标准 nohup 的脚本/工具。本仓库**不接管 `/usr/bin/*`**。Weak model 的兼容性走系统提示侧 + 模型选型解决。

---

## 改了哪些文件

### 1. `opencode/OlaresManifest.yaml`

新增 Olares UI 环境变量：`OPENCODE_OMO_VERSION`（type: string, editable, default `"3.17.4"`）。

描述里**明确禁用** `latest` / dist-tag，只接受具体 semver（例：`3.17.4`, `3.18.0`），并解释为什么：
> 字符串比对不等 → init 容器每次重启都重装 OMO → 启动多 30-60s + 浪费带宽。

### 2. `opencode/templates/opencode.yaml`

#### OMO 版本锁

- 文件顶第 5 行加 Helm 变量：`$omoVersion := index $env "OPENCODE_OMO_VERSION" | default "3.17.4"`
- init-setup 第 52 行导出 `OLARES_OMO_VERSION` 给 shell
- `olares_run_omo()` 函数（约 717 行起）：
  - 开头加 `case` 校验：非 semver 就在日志里大字警告（但不阻塞安装）
  - 扫描列表新增 `/home/opencode/.npm-global/lib/node_modules/oh-my-opencode`（覆盖用户在终端里手动 npm install 的情况）
  - 版本不匹配时 `rm -rf` 旧目录 + `npm install -g oh-my-opencode@${OMO_WANT_VERSION}` + 复制到 `$PKG` snapshot

#### `webstart` / `webstop` / `weblist` 三件套（新）

在 init-setup 创建 `pkg-install` 之后立即创建 `/usr/local/bin/webstart` 等 3 个脚本。

- **`webstart BASE_NAME COMMAND [ARGS...]`**（agent 用）— `setsid + nohup env "$@" </dev/null > /tmp/web-NAME.log 2>&1 + disown` 完整脱钩；启动后 `sleep 2` 验进程仍在。**自动按端口加后缀**：先扫 CLI 参数找端口（`--port N`、`-p N`、`--port=N`、`PORT=N` 等），扫不到就在启动前后做 `ss` 端口快照取 diff，命中就把 NAME 改成 `<BASE>-<PORT>`，pid/log 文件名同步重命名。多端口并发的同种服务因此天然不冲突。最终同名（同 base 同 port）才进入 restart 模式。
- **`webstop NAME` / `webstop --prefix BASE` / `webstop --all`**（agent 用）— **三档安全语义**：
  1. 精确名 → 杀
  2. 唯一前缀匹配（只有一个 `<BASE>-*`）→ 杀（便利兜底）
  3. 多个前缀匹配 → **拒绝**（exit 2），列出候选并提示 agent 使用精确名或 `--prefix` 显式批量
  避免"想重启 vite-5173 误打成 webstop vite 顺手把 vite-6006 干掉"的脚枪。
- **`weblist`**（**用户面向**，read-only）— 列表头 `NAME / PID / PORT / COMMAND`；`PORT` 列会先查捕获到的 pid，再回退查它的直接子进程（`npx → node` 这类场景）。

加入 `verify_cache` 列表（`usr/local/bin/webstart webstop weblist`），保证缓存重启时这仨脚本必须存在，否则触发重装。

#### `web-preview` SKILL（这一段改动最大）

SKILL 从约 200 行增到约 350 行，结构整体重组。

**新增 `## Step 0 — pick the RIGHT dev server`（最顶部）**

- 强制 agent 先 `ls -la && cat package.json | head -40` 侦查
- 14 项标记文件 → 正确工具 的决策表
  - `package.json + scripts.dev` → **优先** `npm run dev`
  - `next.config.*` / `nuxt.config.*` / `angular.json` / `gatsby-config.*` / `astro.config.*` / `svelte.config.*` / `vite.config.*` → 各自段落
  - `app.py` (Flask/FastAPI) / Streamlit/Gradio/Dash
  - `Cargo.toml` / `go.mod` / `pom.xml` / `build.gradle`
  - 只有 `.html` 文件 → Vite
  - 都不认 → **停下来问用户**
- Golden rules 4 条，其中关键：
  - `Blocked request` / `Invalid Host header` / `Disallowed Host` 一律是 host 白名单问题，按框架对症（Vite → `allowedHosts`, webpack → `allowedHosts: "all"`, CRA → `DANGEROUSLY_DISABLE_HOST_CHECK`, Angular → `--disable-host-check`, Django → `ALLOWED_HOSTS`）

**Vite 段落升级**

- 强制先写 `vite.config.js`，模板带 `base` + `server.allowedHosts: true` + `server.hmr.protocol: "wss"` + `server.hmr.clientPort: 443`
- 加了 `<PORT>` 占位符替换说明：`<PORT>` 要替换成实际端口；`clientPort: 443` 保留字面值（Olares 边缘端口）；`allowedHosts: true` 是字面 `true`

**新增框架段落（原来没有）**

- `## Nuxt (Nuxt 3)` — `app.baseURL` + `vite.server.allowedHosts/hmr`
- `## Angular (ng serve)` — `--base-href` + `--deploy-url` + `--disable-host-check`
- `## Create React App (CRA)` — `PUBLIC_URL` + `DANGEROUSLY_DISABLE_HOST_CHECK` + `WDS_SOCKET_*` 环境变量
- `## Gatsby` — `pathPrefix` + `--prefix-paths`
- `## Python dashboards (Streamlit / Gradio / Dash)` — 各自的 `baseUrlPath` / `root_path` / `requests_pathname_prefix`
- `## Java (Spring Boot)` — `server.servlet.context-path`

**Static HTML 段落重写**

- 禁用 `python3 -m http.server`（完全不能处理 URL 前缀）
- 三步走：写 `vite.config.js` → 确认 `index.html` 存在 → `nohup npx vite`

**CRITICAL rules 从 10 条扩到 13 条**

关键新增：
1. 第一条直接换成 **强制 `webstart`**：禁用裸 `nohup &`，原因是 opencode shell tool 会清后台进程
2. 先做 Step 0，别在错的框架用错的工具
3. 有 `scripts.dev` 时优先 `webstart <name> npm run dev`
5. preview prefix 按每个框架列清楚
8. "Blocked request" 等错误直接找框架 host-check 配置，不怀疑反代

**全文搜 `nohup ... &` 模式**：所有具体启动命令（Vite/Next/Nuxt/Angular/CRA/Gatsby/Flask/FastAPI/Streamlit/Spring Boot/Go/Rust 等）都改成 `webstart <NAME> <CMD>`。仅在"fallback"小节保留 `setsid nohup ... </dev/null &` 作为容器外参考。

### 3. `opencode/templates/ingress.yaml`

两个 server 块（`:8080` 和 `:8081`）都加：

```nginx
client_header_buffer_size 16k;
large_client_header_buffers 8 32k;
```

默认 1k / 4×8k 不够装 Olares 域名堆的 cookie，升到 16k / 8×32k，上限从 32KB 提到 256KB。已有的 `proxy_set_header Upgrade / Connection "upgrade"` 保持不动 —— HMR WebSocket 会用到。

---

## 下一步（从这里接着做）

### 立即要做：验证

用户当前**没有打包部署新版本**。验证路径有两条：

**路径 B（推荐）—— 先验 Vite 时钟的核心思路，不打包**

> 注意：`webstart` 是新增脚本，**老 chart 里没有**。验证时还得自己手敲 `nohup` 套路。等新 chart 部署后才能用 `webstart`。

进容器（opencode pod），去时钟 HTML 所在目录：

```bash
# 1. 写 vite.config.js
cat > vite.config.js <<'EOF'
import { defineConfig } from "vite";
export default defineConfig({
  base: "/__preview/4000/",
  server: {
    host: "0.0.0.0",
    port: 4000,
    allowedHosts: true,
    strictPort: true,
    hmr: { protocol: "wss", clientPort: 443 },
  },
});
EOF

# 2. 确保有 index.html（没有就 cp clock.html index.html）
ls index.html || cp clock.html index.html

# 3. kill 旧 http.server / vite
pkill -f "http.server" 2>/dev/null
pkill -f "vite" 2>/dev/null

# 4. 启 vite —— 用完全脱钩的方式（webstart 等价手敲版）
setsid nohup npx vite > /tmp/vite.log 2>&1 < /dev/null &
disown
sleep 3
ss -tlnp | grep 4000

# 5. 浏览器访问 https://<域名>/__preview/4000/
```

**预期**：时钟直接出现，无 `Blocked request`，改 clock.html 保存后浏览器自动刷新（HMR 工作）。

**额外验证（部署新 chart 后）**：让 agent 跑同样任务，看 Bash 命令是否变成 `webstart vite npx vite`，并且 turn 结束后 `weblist` 仍能看到该服务。

**路径 A** —— 手动改 chart 版本号 + 打包部署，一次性验证 OMO 锁 + ingress buffer + SKILL

只有 B 通过了再做 A。

### 如果 B 验证通过后

1. `opencode/Chart.yaml` 升版本号（当前最新 tgz 是 `opencode-1.0.39.tgz`，下一个就是 `1.0.40`）
2. `helm package opencode/ .` 生成 `opencode-1.0.40.tgz`
3. 推到 Olares market / 部署验证
4. 让 agent 再跑一次时钟任务，观察它**自动**按 SKILL 流程走（应该是：侦查 → 选 Vite → 写 vite.config.js → `nohup npx vite` → 给 `/__preview/4000/` URL）

### 如果 B 验证失败（时钟还是不出来）

可能的原因，按概率排：
1. nginx 没重载 header buffer 配置 → `kubectl exec` 进 openresty 容器 `nginx -s reload`
2. 浏览器 cookie 没清（旧 cookie 仍然触发 400）→ 清 cookie / 无痕窗口再试
3. `/__preview/4000/clock.html` 写错大小写或路径
4. Vite 依赖未装好 → `/tmp/vite.log` 看具体报错

---

## 遗留问题 / 暂不处理

1. **OMO 版本锁的 `latest` 语义**：文档已强烈不推荐，运行时也会日志警告，但没有硬阻塞。用户如坚持用 `latest`，每次重启多 30-60s 是可接受代价。
2. **SKILL 没覆盖的框架**：Ruby on Rails、Django（只在 Golden rule 里提 `ALLOWED_HOSTS`，没独立段落）、Vue CLI、WordPress/PHP。Django 用户较多，后续要不要加独立段落待定。
3. **opencode Write 工具 Qwen 序列化 bug**：上轮对话提到过，让用户尝试关掉 OMO 的 `write-existing-file-guard` / `comment-checker` 等 hook + 切换模型。**用户未回报结果**，下次见面要问一下。
4. **Open Notebook 持久化 + STT patch**：早前对话里的遗留，用户要打包部署后验证。这次没碰。

---

## 相关历史

- OMO 版本锁初次实现 + ingress buffer 16k/32k：已经在 git 提交 `dd66bc6 opencode lock omo version=3.17.4`
- 今天新增的 OMO 扫描路径 + 版本字符串校验 + SKILL 大改（Step 0、新框架段落、CRITICAL rules 扩充）：**还在工作区未提交**

---

## 工作区状态快照（明早继续时参考）

当前 `git status` 未提交改动（只列本次相关）：
- `opencode/OlaresManifest.yaml` — `OPENCODE_OMO_VERSION` 描述强硬化
- `opencode/templates/opencode.yaml` — OMO `olares_run_omo()` 扩展 + SKILL 大改（文件总行数 ~1550）
- `opencode/templates/ingress.yaml` — 这个已经在上次提交里了，**此次未再动**

记得起来先 `git diff opencode/` 看一遍再决定下一步。

祝睡好。
