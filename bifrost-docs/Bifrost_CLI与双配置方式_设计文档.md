# Bifrost「CLI / 双配置方式 / 持久化」设计文档

> 状态：调研 + 方案阶段（未改代码）
> 当前线上：chart 1.0.7 / appVersion 1.4.10（镜像 `docker.io/beclab/maximhq-bifrost:v1.4.10`）
> 本次目标：① 借机把网关升级到最新稳定版 **v1.5.10**；② 落地产品经理的「file 式配置 + UI 也在 + 加 Terminal/CLI」路子；③ 厘清用户数据持久化。
> 初稿：2026-06-05 ／ 重大更新：2026-06-11

---

## 更新记录（2026-06-11，重要）

这次复核 + 搜索后，**有三个结论直接改变了原方案的前提**：

1. **官方现在真有 CLI 了**（推翻初稿第 0 节的判断）。`@maximhq/bifrost-cli` 是一个**客户端交互式终端工具**，把 Claude Code / Codex / Gemini / **Opencode** 连到正在运行的 Bifrost 网关；它**不要求网关切到 file 模式**。→ 产品经理「cli 必须用 file 模式」是误解。
2. **「纯 file 模式 + governance」在我们当前 1.4.10 以及最新 v1.5.x 上都会启动崩溃**，且官方修复 PR（#3299）已关闭未合并（Issue #1912 / #3298）。→ 想要「allow 模型列表」这类治理能力，就**必须开 `config_store`**，也就是只能走 bootstrap（半 DB）变体，不能走纯 file。
3. **升级到最新版不会让产品经理的路子「更容易」，机制完全一样**；但 v1.5.0 引入了 `allowed_models` **deny-by-default** 破坏性变更（见第 7 节），升级本身要单独处理迁移。

结论：产品经理的两个诉求都能满足，但**实现形态是「config_store 开启 + 可写持久化 config.json（bootstrap 变体）」，不是「纯 file 模式」**；CLI 那条与配置模式解耦、可独立做、风险低。

---

## 0. 一个必须先对齐的歧义：「Bifrost 加 CLI」指什么（已澄清）

Bifrost 的分发本身是 CLI 启动（`npx -y @maximhq/bifrost` 或我们用的 Docker 镜像）。但**除了网关本体，官方现在另有一个独立的 CLI 客户端**：

| 名称 | 是什么 | 与本需求的关系 |
|---|---|---|
| `@maximhq/bifrost` | **网关本体**的启动器（下载并跑 HTTP transport 二进制）。flag：`-port`/`-host`/`-app-dir`/`-log-level`/`-log-style` | 我们部署的就是它（镜像形态） |
| `@maximhq/bifrost-cli` | **客户端交互式 TUI**：把 Claude Code / Codex / Gemini / **Opencode** 连到一个**正在运行的网关**，自动配 base_url/key/模型 | **这才是「加 CLI」最可能指的东西** |

`@maximhq/bifrost-cli` 的关键事实（来源：官方 CLI 文档）：
- 需要：Node 18+ ＋ **一个运行中的网关** ＋ 可选 virtual key。
- 从网关 **`GET /v1/models`** 拉可用模型列表给用户选（带 VK 时只列该 VK 允许的模型）。
- 自己的配置在 `~/.bifrost/config.json`（`base_url`/`default_harness`/`default_model`）；VK 存进系统 keyring，不落明文。
- **不要求网关是 file 模式**——它只认网关 URL + VK。
- 原生支持 opencode harness（和自家 opencode 能直接串）。

→ 所以「加个 Terminal 用 CLI」= 给用户一个终端入口跑 `npx -y @maximhq/bifrost-cli`，base_url 指向本应用网关即可，**与网关配置模式无关**。

---

## 1. Bifrost 的「两种配置方式」（官方机制，最新版未变）

官方明确：**两种模式互斥，不能同时跑**。判定依据是 `config.json` 里有没有启用 `config_store`。

| 模式 | 触发条件 | 行为 |
|---|---|---|
| **方式 A：Web UI + 数据库** | 没有 `config.json`，**或** `config.json` 里 `config_store` 开启 | UI 可用；配置存进 SQLite / Postgres；UI/API 改动**立即持久化**，重启不丢 |
| **方式 B：文件式（config.json）** | 有 `config.json` 且 **`config_store` 关闭 / 缺省** | **UI 被禁用**；启动时整份配置读进内存；改配置必须**改文件 + 重启**；文件本身只读、不被回写 |

方式 A 的「bootstrap（半 DB）」机制（**这是本方案的落点**）：`config.json` 里列了 providers/governance 又开了 `config_store` 时——
- **空库**：把 `config.json` 一次性灌进 DB，之后以 DB 为准；
- **已有数据**：按**每个实体的内容哈希**协调——哈希没变保留 DB 版本（UI 改动被尊重）；**改了文件里某实体的内容 → 文件版本覆盖 DB 那个实体**；只在 UI 里加、文件没有的实体永远保留。
- 文件**只读、永不被回写**（UI/API 改动只进 DB，不回写文件 → 文件与 DB 会逐渐分叉）。

三个存储分工：

| Store | 用途 | 后端 |
|---|---|---|
| `config_store` | provider 配置、虚拟 key、治理规则 | SQLite / **PostgreSQL**（UI 功能必需） |
| `logs_store` | UI 展示的请求/响应日志 | SQLite / PostgreSQL（+ 可选 S3/GCS） |
| `vector_store` | 语义缓存 | Redis / Valkey / Weaviate / Qdrant / Pinecone |

### ⚠️ 1.1 关键约束：纯 file 模式 + governance 会崩溃（最新版仍未修）
GitHub Issue [#1912](https://github.com/maximhq/bifrost/issues/1912) / [#3298](https://github.com/maximhq/bifrost/issues/3298)：在 `config_store.enabled=false` 且 `config.json` 里定义了 governance（`virtual_keys` / `rate_limits` / `model_configs`）时，**v1.4.10 与 v1.5.x 均启动崩溃**：

```
failed to initialize routes: failed to initialize governance handler: config store is required
```

原因：v1.4.10 起 governance 插件无条件加载，而 `RegisterAPIRoutes` 在 `ConfigStore == nil` 时硬失败。修复 PR #3299 已关闭未合并。官方维护者明确：**OSS 里要用 governance，就必须开 `config_store`，但让所有配置改动都走 `config.json`**（即 bootstrap 变体）。

→ 这条把方案彻底钉死在 bootstrap 变体上。

---

## 2. 现状盘点（当前 Olares 包）

当前是 **方式 A（Web UI + Postgres）**，带一个空 providers 的引导 config.json。

证据：
- `templates/configmap.yaml`：`config_store`=postgres `enabled:true`、`logs_store`=postgres、`vector_store`=redis、`providers` 为空对象。**未设 `encryption_key`**。`bifrost-env` ConfigMap 里 `OPENAI_API_KEY=""`。
- `templates/bifrost.yaml`：`config.json` 以 **只读 ConfigMap** 挂载（`mountPath:/app/data/config.json`、`readOnly:true`、`subPath:config.json`）→ 用户**无法在 Files 应用编辑**。
- 数据盘 `bifrost-data` 是 **hostPath，挂在 `userspace.appCache`**（不是 appData）。
- `OlaresManifest.yaml`：`permission.appData:true`、`appCache:true`、`userData:[Home]`；`middleware` 声明 redis + postgres（bifrostdb，带 vector 扩展）。

---

## 3. 用户数据持久化分析（本次新增重点）

### 3.1 现状：什么持久、什么不持久

| 数据 | 存在哪 | 重启 | 升级 | 备注 |
|---|---|---|---|---|
| provider / virtual key / 治理规则 | **Postgres**（Olares 中间件，持久 + 备份） | ✅ 不丢 | ✅ 不丢（同一中间件实例） | 真正的「用户配置」都在这 |
| 请求/响应日志 | **Postgres**（logs_store） | ✅ | ✅ | |
| 语义缓存 | **Redis** | ✅(取决于 redis 持久化) | 一般可重建 | 缓存性质 |
| API key 明文 | **Postgres**（因为**未设 encryption_key**） | ✅ | ✅ | ⚠️ 明文存储，安全隐患 |
| `config.json` | **只读 ConfigMap**（每次部署由 Helm 重新渲染） | 用户改不了 | 每次覆盖 | 当前只是空壳引导 |
| `/app/data`（logs 目录、未用到的 config.db 等） | **hostPath @ appCache** | ✅(只要 appCache 不清) | ⚠️ appCache 非持久承诺、**不备份** | 当前不放关键数据，影响小 |

**小结**：当前真正的用户配置在 Postgres，重启/升级是安全的。`config.json` 是只读空壳、`/app/data` 在 appCache——在「方式 A 现状」下问题不大。**但一旦要让用户编辑 config.json（产品经理路子），这两点都成了硬伤。**

### 3.2 `encryption_key` 的持久化含义（关键）
官方文档明确：
- **不设 key → 数据明文存 DB**（“not recommended for production”）。这正是我们现状：key 明文落在 Postgres，能跨重启，但不安全。
- **一旦设了 key 且库里有数据，不清库就改不了 key**（要换 key 得走 `encryptionmigration` 流程）。
- key 用 `env.BIFROST_ENCRYPTION_KEY` 引用，Argon2id 派生 AES-256。

**持久化风险点**：如果将来引入 `encryption_key`，它**必须来自一个稳定、持久的 secret**（跨重启/升级不变）。若每次部署随机生成 → 上次用旧 key 加密的 DB 数据**这次解不开 = 用户配置全废**。这是比「现状明文」更严重的潜在数据丢失风险，必须谨慎。

### 3.3 为产品经理路子需要做的持久化调整
要让用户「能编辑 config.json + UI 也在 + 数据不丢」，需改三处：

1. **config.json：只读 ConfigMap → 可写 + 持久（appData）**
   - 改挂载：从 ConfigMap 只读挂载改为挂在 **appData hostPath**（持久 + 备份）下的可写文件。
   - 首次安装由 **init 容器写入模板**，之后**不覆盖用户编辑**（参考 LibreSpeed `servers.json` 的「首次生成、之后不覆盖」做法）。
2. **`/app/data`：appCache → appData**
   - 让 config.json、（如改用 sqlite 时的）config.db、本地 logs 等落在持久 + 备份的 appData，而不是会被清且不备份的 appCache。
   - 注：config_store 仍用 Postgres 时 config.db 不产生，但数据盘归位到 appData 更稳妥、语义更正确。
3. **`encryption_key`：从稳定持久 secret 注入（或显式决定继续明文）**
   - 方案 a（推荐，新装场景）：首次安装生成一个持久化的 secret（chart 渲染一次、存 appData / k8s Secret），以 `env.BIFROST_ENCRYPTION_KEY` 注入，从第一天就加密。
   - 方案 b：维持现状明文（最简，但安全性差），仅在文档说明。
   - ⚠️ **对存量用户**：当前库里是明文，若升级时才加密，需走官方 `encryptionmigration` 流程，否则有解密失败风险——**默认先不动存量加密状态**，把它列为独立议题。

---

## 4. 核心关切：两种模式切换，数据能否无缝迁移

**结论：文件→数据库基本无缝；数据库→纯文件不无缝。**

- **B→A（文件→DB）✅ 基本无缝**：bootstrap，空库时把 `config.json` 灌进 DB。「先写文件、再开 UI」顺。
- **A→B（DB→纯文件）❌ 不无缝**：切纯文件（关 config_store）后 **Postgres 配置被忽略**，UI 里配的全等于丢（数据还在但不被读）；且**没有官方「DB 导出成 config.json」的 CLI/按钮**，只能走 REST API 自己拼或手抄。**而且纯文件 + governance 还会崩**（见 1.1）。

**隐藏坑（混合态）**：bootstrap 变体下，用户**改文件里某实体** → 可能**静默覆盖** UI 里的同名实体；UI 改动又不回写文件 → 文件与 DB 分叉。需在产品/文档上重点警示，避免让用户误以为「文件 = 当前真相」。

---

## 5. 方案（评审用）

### 方案一（推荐）：bootstrap 变体 + config.json 搬到可写持久盘 + 升级到 v1.5.10
- 保持 `config_store=postgres enabled:true`（UI 在、不崩）。
- config.json 改可写持久挂载（appData，init 首次写模板、不覆盖用户编辑），用户可在 Files 应用编辑 providers + 每个 key 的 **`models` 白名单**（解决「看不到有哪些模型」）。
- 数据盘 `/app/data` 从 appCache 挪到 appData。
- `encryption_key`：新装从持久 secret 注入；存量明文状态默认不动（单列议题）。
- 升级镜像到 `v1.5.10`（处理第 7 节破坏性变更）。
- 迁移承诺：只承诺 B→A 无缝；A→B 明确告知不无缝。

### 方案二（已落地）：方案一 + 内嵌 Terminal + bifrost-cli node sidecar
「加 Terminal」= 接入你们的标准 beclab Terminal 组件（`templates/terminal.yaml`：SA + `pods/exec` Role + terminal Deployment `beclab/terminal:v0.0.9` + Service），主 pod 打 `bytetrade.io/terminal: bifrost` 标签，OlaresManifest 加第二个 entrance（8081 "Bifrost Terminal"），ingress 加 `:8081` server 块反代 terminal 服务。

关键：terminal 是 **exec 进一个容器**的。`maximhq/bifrost` 官方镜像 = alpine 3.23.3，**有 shell 但无 node**，所以 exec 进它跑不了 `@maximhq/bifrost-cli`（A 方案不合格，已否决）。最终走 **B**：
- 自建一个小 node sidecar 镜像（`bifrost-cli-docker/Dockerfile`：node:22-alpine + 预装 `@maximhq/bifrost-cli` + 尽力预装 claude-code/codex/gemini-cli/opencode-ai），经 CI（`.github/workflows/build-bifrost-cli-image.yml`）打多架构，转换为 `docker.io/beclab/lovehunter9-bifrost-cli:<tag>`。
- bifrost pod 里加一个常驻 `cli` sidecar 用该镜像，`HOME=/app/data/.cli-home`（落 appData，CLI 配置持久），并共享 `/app/data`（同一终端也能改 config.json）。
- terminal `--container=cli --shell=bash`。用户点 "Bifrost Terminal" → 落到这个 sidecar → 直接 `bifrost` 启动 agent，base_url `http://localhost:8080`。
- use-time 联网下载 agent 是允许的（本 app 无离线约束）。

### 方案三：拆成两个应用（bifrost / bifrost-cli）
- 学 opencode / opencodetui 拆法。缺点：两套 chart、彼此无数据迁移。除非产品本就不要求迁移，否则不推荐。

---

## 6. 「为何一定要支持」的回答（老板会问）
- **真实痛点**是「UI 看不到/控制不了一个 provider 暴露哪些模型」。这个用 config.json 的显式 `models` 白名单 + `/v1/models` 就能解，**不需要「切模式」这种大动作**。
- **CLI** 官方现已提供（`@maximhq/bifrost-cli`），其作用恰是**把 Claude Code / Opencode 等 agent 接进网关**——与「希望用户都来用咱们 Gateway」的战略**完全同向**：CLI 是把流量导入网关的入口，不是偏离。所以「支持 CLI」≈「让用户更顺地把 agent 接到我们网关」，顺势而为。

---

## 7. 升级到 v1.5.10 的破坏性变更（必须处理）
v1.5.0 起的治理语义变更（对存量配置可能**静默改变行为**）：
- `allowed_models: []` 或省略 = **拒绝所有**（deny-by-default）。以前空 = 允许所有。→ 存量 VK 若依赖「空 = 全放」，升级后**全被拒**。必须给每个 provider_config 显式 `["*"]` 或列模型。
- provider key 的 `models: []` / 无 → 需补 `["*"]`。
- `allowed_keys` 字段重命名为 **`key_ids`**（空/省略现在 = 拒绝所有 key）。
- `provider_configs: []` 的 VK = 阻断所有流量。
- list 里不能混用 `"*"` 与具体值、不能有重复项，否则 HTTP 400。
- **v1.5.10 修复**：对目录无法枚举模型的 provider（vLLM/Ollama/SGL/自定义），`["*"]` 现在能正确放行（而非误拒）——所以选 v1.5.10 而不是更早的 v1.5.x。

升级动作清单：升级前盘点现有 VK/provider 配置，补齐 `["*"]` / `key_ids`，再升级镜像。

---

## 8. 评审前建议先验证的 spike
1. **可写挂载下 bootstrap 行为**：v1.5.10 下，config.json 改可写挂载后，是否真「只读不回写」、改文件某实体能否按哈希覆盖 DB。
2. **encryption_key 注入与持久**：从持久 secret 注入 key，重启/升级后 UI 存的 key 仍可解密；以及存量明文→加密的 migration 是否必要。
3. **A→B 导出可行性**：REST API 能否把当前 DB 配置导出成合法 config.json；key 是明文还是 `env.` 引用。
4. **CLI 入口形态**：终端跑 `@maximhq/bifrost-cli` 连本应用网关的可行性与产品形态。
5. **升级回归**：1.4.10→1.5.10，存量 Postgres 配置在 deny-by-default 下的实际表现。

---

## 9. 参考链接
- 两种模式 / bootstrap：https://docs.getbifrost.ai/quickstart/gateway/setting-up
- config.json 部署指南：https://docs.getbifrost.ai/deployment-guides/config-json
- Governance（virtual_keys / allowed_models）：https://docs.getbifrost.ai/deployment-guides/config-json/governance
- Provider Routing（allowed_models 行为）：https://docs.getbifrost.ai/providers/provider-routing
- Encryption Key：https://docs.getbifrost.ai/deployment-guides/config-json/client#encryption-key
- 官方 CLI（@maximhq/bifrost-cli）：https://docs.getbifrost.ai/quickstart/cli/getting-started
- 崩溃 Issue：https://github.com/maximhq/bifrost/issues/1912 ／ https://github.com/maximhq/bifrost/issues/3298
- v1.2 引入 configstore（含迁移）：https://github.com/maximhq/bifrost/discussions/385
- Releases（最新 v1.5.10）：https://github.com/maximhq/bifrost/releases
