# Bifrost 双验收说明（UI 配置持久化 + 终端 CLI）

面向：PM / 验收
日期：2026-06-15
版本：Bifrost chart `1.0.8`（gateway `v1.5.11`，CLI sidecar `0.0.1-test2`）

---

## 一、需求与交付对照

| PM 需求 | 交付结果 | 状态 |
|---|---|---|
| Web UI 可用，且 UI 上配置的 provider/Key **跨卸载重装不丢** | UI 常驻；配置存 **SQLite**，落在持久卷 appData（`/app/data/config.db`） | ✅ |
| 应用内提供 **终端**，可跑 `bifrost` CLI 启动编码 agent | pod 内置 `cli` sidecar，in-app Terminal 直接进该容器 | ✅ |
| 终端里 `bifrost` 与常用 agent **开箱即用，不要每次下载/手装** | `bifrost` 真二进制烤进系统 PATH（零下载）；预装 5 个 agent | ✅ |

---

## 二、验收结论（已实测，2026-06-15）

实测环境：namespace `bifrost-demo0002`，已装/升级到 chart `1.0.8`。

### ① UI 配置持久化 — 通过
- 操作：UI 添加 provider（含 API Key）→ **保留数据卸载** → **重装** → 重开 UI。
- 结果：**provider 仍在**；后台可见配置库 `/app/data/config.db`（约 25 MB，位于持久卷 appData）。
- 说明：早期版本把配置存在中间件 Postgres，而 Olares 在「保留数据卸载+重装」时会清空应用的
  中间件 Postgres 数据，导致 provider 丢失。现改为 **SQLite 存在 appData**，appData 才是真正
  持久且会被备份的卷，因此重装后配置不丢。

### ② 终端 CLI — 通过
- `bifrost` 路径 = `/usr/local/bin/bifrost`（真二进制，非下载器外壳）。
- 运行 `bifrost`：**不再出现「Downloading Binary」**，秒起；零联网下载。
- 预装并可直接调用的 agent：`bifrost`、`claude`、`codex`、`gemini`、`opencode`、`qwen`。

---

## 三、用户怎么用

### 用 Web UI 配 provider
1. 打开 Bifrost 应用（Web UI）。
2. 在 UI 里添加 provider 并填入 API Key，保存即生效。
3. 配置会持久保存（重启、升级、保留数据卸载+重装均不丢）。
4. 若 provider 是**集群内私网地址 / Ollama**：在该 provider 的设置里打开
   **`allow_private_network`**。（Bifrost v1.5.9+ 默认有 SSRF 防护，会拦截到私网 IP 的连接；
   打开此项即放行。）

### 用应用内终端跑 CLI
1. 打开应用内 **Terminal**（直接落在 CLI 容器）。
2. 直接敲命令，无需安装：
   - `bifrost` —— 启动 Bifrost 交互式 CLI（经网关，base URL `http://localhost:8080`）。
     首次进入加 `-no-resume` 可跳过续接、直接进设置：`bifrost -no-resume`。
   - `claude` / `codex` / `gemini` / `opencode` / `qwen` —— 直接启动对应编码 agent。

> 备注：`bifrost` 没有 `--version` 参数；它的参数是 `-config / -no-resume / -worktree`。

---

## 四、当前限制 / 已知项
- `config.json` 由 chart 统一管理、**只读**挂载（保证 store 声明随版本更新、不被旧文件冻结），
  因此用户不通过编辑 `config.json` 来配置，而是走 **Web UI**。
- 私网 / Ollama provider 需手动打开 `allow_private_network`（见上）。
- 日志（logs_store）走中间件 Postgres、缓存（vector_store）走 Redis；这两类非用户配置，
  不影响「UI provider 持久化」。
