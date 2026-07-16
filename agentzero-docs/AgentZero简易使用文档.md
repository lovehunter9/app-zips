# Agent Zero 简易使用文档

> 适用版本: Agent Zero v1.15 / Olares chart 1.0.4 及以上

本文介绍 Agent Zero 在 Olares 上的初次配置、模型选型、与其他应用通过 MCP 集成的方式，以及常见问题的判定与处理。

---

## 目录

1. [本次升级要点](#一本次升级要点)
2. [模型配置（v1.15 简化为 3 个角色）](#二模型配置v115-简化为-3-个角色)
3. [与其他 Olares 应用集成（MCP）](#三与其他-olares-应用集成mcp)
4. [常见问题与解决建议](#四常见问题与解决建议)
5. [其他建议](#五其他建议)
6. [参考链接](#六参考链接)

---

## 一、本次升级要点

Agent Zero 从 v0.9.x 跨越到 v1.15，跳过了 v1.0 - v1.14 之间所有中间版本。主要变化如下：

### 1.1 模型配置从 4 个角色简化为 3 个

| v0.9.x | v1.15 |
|---|---|
| Chat Model | **Main** |
| Utility Model | **Utility** |
| Embedding Model | **Embedding** |
| ~~Browser Model~~（单独配置） | （并入 Main，Browser 工具按需复用） |

不再为 Browser 工具单独配模型。3 个角色的具体职责与选型建议见下一节。

### 1.2 内置 MCP 服务端

Agent Zero 自身可以作为 **MCP 服务端**，把它的所有能力（代码执行、文件操作、浏览器、记忆、子代理等）通过 `agent-zero_send_message` 这一类 tool 暴露给任何兼容 MCP 的客户端（例如 OpenCode）。详见"三、与其他 Olares 应用集成"。

### 1.3 桌面 / 办公文档能力拆为可选插件

LibreOffice、Desktop、Browser 等重量级能力从主镜像里抽出来，作为可加载的插件由 Settings → Plugins 管理。镜像更小、启动更快；需要时再装。

### 1.4 其他变化

- 修复了 Markdown 渲染的一个 XSS 漏洞；对话里的代码块和外链更安全
- 健康检查端点统一调整为 `/api/health`
- v0.9.x 的老用户数据（`/usr/_office`、`/usr/_desktop` 等）首次启动会自动迁移到 `/usr/plugins/` 下
- 引入 **persistent chat**：通过 MCP 调用 Agent Zero 时返回一个 chat ID，下次调用透传即可延续上下文

---

## 二、模型配置（v1.15 简化为 3 个角色）

Agent Zero 自身**不带任何模型**，所有对话与推理都委托给外部 LLM（Ollama / OpenAI / Anthropic / OpenAI-compatible 等）。打开 **Settings → Agent Settings → Models** 进行配置。

### 2.1 3 个角色的职责

| 角色 | 谁会触发 | 任务复杂度 | 调用频率 |
|---|---|---|---|
| **Main** | 主对话、决策、生成回复、调用 tool | 高 | 每条用户消息 1 次 |
| **Utility** | 内部杂事：memory 检索改写、相关性判断、提示词整理 | 低（基本是 prompt 改写） | 每条消息 2–3 次（启用 memory 时） |
| **Embedding** | 把文本转向量，用于 memory 检索与知识库 | 极低（不生成文本，只算向量） | memory 与知识库读写都会触发 |

### 2.2 选型核心原则

**原则 1：3 个角色分到 3 个独立的模型实例**

如果 3 个角色都指向同一个 Ollama 实例（典型如同一个 `qwen3:14b` Ollama 服务），并发请求会在这个实例里排队，触发 Ollama 服务端超时与 client 端 retry，整个 agent 会陷入"看起来卡住、实际队列堆死"的状态（具体表现见 4.2）。

**原则 2：Embedding 必须用真正的 embedding 模型**

绝对不能拿任意 chat LLM（如 `qwen3:14b`、`llama3:8b`）当 embedding 用。chat 模型可以"凑合"工作，但每次向量化要跑一整轮文本生成，速度比专用 embed 模型慢上百倍。这是 Agent Zero 触发 `Memory consolidation timeout` 错误最常见的根因。

推荐的 embedding 模型：

- `qwen3-embedding:0.6b`（推荐，专为 embedding 设计，速度极快）
- `nomic-embed-text`
- `bge-large` / `bge-base`
- OpenAI `text-embedding-3-small` / `text-embedding-3-large`

**原则 3：Main 要选 tool calling 能力强的模型**

Main 是真正与用户对话、调用工具的角色。**tool calling 能力**比模型参数大小更重要：

- ✅ 推荐：`qwen3:14b`（dense，tool calling 稳）、`qwen2.5:14b/32b`、GPT-4o / GPT-4o-mini、Claude 3.5 Sonnet
- ⚠️ 注意：部分 MoE 模型（如 `qwen3:30b-a3b`、`mixtral`）tool calling 不太稳定，用之前要测，否则会出现"明明配了 tool 却不调"或"调错参数"的现象
- ❌ 避免：< 7B 的小模型基本无法可靠 tool calling

**原则 4：Utility 用速度优先的小模型**

Utility 的任务非常简单（prompt 改写、相关性判断），选小模型就行。不需要 tool calling，所以 MoE 也合适。**速度比质量重要**（每条消息都要调 2–3 次）：

- ✅ 推荐：3–9B 的 dense 模型，或者 MoE（实际激活 3–5B 的那种）

### 2.3 一组实测可行的组合

下面这组是我们在 Olares 上实际跑通并稳定使用过的配置，可以作为起点直接照抄：

| 角色 | 模型 |
|---|---|
| Main | `qwen3.5:9b` |
| Utility | `qwen3:30b-a3b`（MoE，实际激活约 3B，速度跟 9B dense 相近） |
| Embedding | `qwen3-embedding:0.6b` |

> 这只是**一组验证可行的方案**，并非"唯一最优"。你的硬件更强可以把 Main 换成 `qwen3:14b` 这类 dense 模型；更弱可以把 Utility 换成更小的 dense（如 `qwen3:4b`）。只要遵守上面第 2.2 节的四条原则 —— 尤其"3 角色 3 实例"和"Embedding 必须是真 embed 模型"—— 就不会踩坑。

### 2.4 每个角色的必填字段

| 字段 | 说明 |
|---|---|
| Provider | Ollama / OpenAI / Anthropic / OpenAI-compatible |
| Model name | 模型名（如 `qwen3:14b`） |
| **API Base URL** | **必填**。具体怎么填见 2.5 |
| API Key | 按 Provider 要求；Ollama 本地可留空 |

> ⚠️ **API Base URL 留空是最常见的配置错误**。它会让任何 tool 调用立刻报 `httpx.InvalidURL: /<模型名>/api/generate`，看起来像 MCP 或 agent 出问题，实际是模型这一层根本没连通。

### 2.5 在 Olares 上获取 Ollama 模型地址

每一个 Ollama 系列模型在 Olares 上都作为一个独立应用安装。打开对应应用，主界面会直接显示该模型的 API Base URL，形如：

```
https://<随机前缀>.<your-domain>.olares.com
```

把这条 URL 原样复制到 Agent Zero 的 Model API Base URL 字段即可。

> **OpenAI 兼容端点**：如果用 Provider 选 "OpenAI-compatible"（而不是 Ollama），需要在上面这条 URL 后面再加 `/v1`。Provider 选 "Ollama" 时则不用加。

---

## 三、与其他 Olares 应用集成（MCP）

Agent Zero v1.15 把自己作为一个 MCP 服务端暴露出来，任何兼容 MCP 的客户端都可以调用它。本节以 **OpenCode** 为例，介绍完整接入方法。其他兼容 MCP 的客户端配置格式略有不同，但 URL、token、原理完全一致。

### 3.1 启用 MCP Server

1. 打开 Agent Zero UI → **Settings → External Integrations → A0 MCP Server**
2. 打开 **Enable A0 MCP Server** 开关
3. 页面会显示该实例的**专属 token** 以及**两种连接 URL**：

```
https://<your-agentzero-domain>/mcp/t-<MCP_TOKEN>/sse    ← SSE，兼容较老的客户端
https://<your-agentzero-domain>/mcp/t-<MCP_TOKEN>/http   ← Streamable HTTP，推荐
```

token 是一段随机字符串（约 16 位左右），嵌在 URL 路径里。**不需要额外的 Authorization header**。

> **重置 token**：同一页面点 Regenerate。重置后所有客户端配置里 URL 中间的 `t-XXX` 段都必须同步更新，否则会立刻 403。

### 3.2 在 OpenCode 里配置

**先选好 OpenCode 这边的主模型**（重要，决定后续稳定性）：

1. **必须跟 AgentZero 的 Main 模型用不同的 Ollama 实例**。如果两边指向同一个 Ollama 服务，每条 MCP 调用都会在那个实例里跟 AgentZero 自己的推理抢资源，响应被拖慢甚至雪崩超时（具体原理见 4.1 / 4.2）。
2. **OpenCode 主模型的 tool calling 能力要强**，因为它需要主动调用 `agent-zero_send_message` 这个 tool。部分 MoE 模型（如 `qwen3:30b-a3b`）会出现"明明配了 tool 却不调"或"调错参数"的现象。

我们实测过一组可行的组合：

| 角色 | 模型 |
|---|---|
| OpenCode 主模型 | `qwen3:14b`（dense，tool calling 稳） |
| AgentZero Main | `qwen3.5:9b` |
| AgentZero Utility | `qwen3:30b-a3b` |
| AgentZero Embedding | `qwen3-embedding:0.6b` |

4 个角色对应到 4 个独立的 Ollama 应用实例，互不阻塞。**编辑配置之前请先确认你的模型分配满足"不同实例"这条**。

确认完模型分配后，编辑 OpenCode 的配置文件（一般位于 `~/.config/opencode/opencode.json` 或安装目录下同名文件），添加：

```jsonc
{
  "mcp": {
    "agent-zero": {
      "type": "remote",
      "url": "https://<your-agentzero-domain>/mcp/t-<MCP_TOKEN>/http",
      "enabled": true,
      "timeout": 300000
    }
  }
}
```

各字段说明：

| 字段 | 必要性 | 说明 |
|---|---|---|
| `type: "remote"` | ✅ | 用 OpenCode 内置的 streamable-HTTP 客户端，**不要**再套 `mcp-remote` 之类代理 |
| URL 末尾**不带** `/` | ✅ | 与 Agent Zero UI 复制出来的字符保持一致即可 |
| `timeout: 300000` | ✅✅ | **5 分钟**。OpenCode 默认 MCP 请求超时偏短（约 30–60 秒），Agent Zero 跑一次完整推理通常需要 20–60 秒，刚好踩边。给到 300 秒可避免误判超时（详见 4.1） |

保存后重启 OpenCode（或等其热加载），MCP 面板里 `agent-zero` 状态变绿即接入成功。

### 3.3 集群内访问（不走公网）

如果你的 MCP 客户端也跑在同一个 Olares 集群里（譬如同样部署在 Olares 上的 OpenCode 等），可以走集群内 Service DNS，省一次出公网往返，时延更低：

```
http://agentzero-mcp.agentzero-<username>/mcp/t-<MCP_TOKEN>/http
http://agentzero.agentzero-<username>/mcp/t-<MCP_TOKEN>/http
```

两条 URL 等价：

- `agentzero-mcp` 是专门为 MCP 用途取的别名 Service，命名更清晰，推荐用这条
- `agentzero` 是主 Web Service，同一个 Pod 也响应 MCP 请求

`<username>` 是你的 Olares 用户名。可用 `kubectl get ns | grep agentzero` 确认 namespace。

> **顺带一提**：如果你给 Agent Zero 配的 Ollama 模型也在同集群，除了 2.5 提到的公网 URL 之外，也可以用集群内 DNS（更省事）：用 `kubectl get svc -A | grep ollama` 找到对应模型的服务，Base URL 形如 `http://ollama.<那一行的 namespace>:11434`（Provider 选 "Ollama"；选 "OpenAI-compatible" 时同样要再补 `/v1`）。

### 3.4 在 OpenCode 里调用 Agent Zero

在 OpenCode 任一对话里这样说（**注意最后那句"只能调用一次"很重要**）：

```
请你调用 agent-zero MCP 服务器上的 agent-zero_send_message 工具，
把下面这段话原文转发给远程 Agent Zero 实例，然后把它返回给你的完整
回复原样贴回来。不要你自己回答，必须通过这个工具。
只能调用一次 agent-zero_send_message。如果一次没拿到完整结果，
再回头问我，不要自己重复调。

转发内容: "<你真正想问 Agent Zero 的话>"
```

"只能调用一次"是为了消除 OpenCode 这边 LLM 自作主张的 parallel tool call（详见 4.1）。

### 3.5 验收测试

短 prompt 先测通：

```
请用 agent-zero 发送消息 "say PONG"，把回复贴回来。
```

预期：

1. OpenCode 调用 `agent-zero_send_message` 工具
2. Agent Zero pod 日志里出现：
   ```
   MCP Chat message received
   User message: > say PONG
   MCP Chat message completed: PONG
   ```
3. OpenCode 收到包含 `PONG` 的回复，并显示一个 chat ID（如 `Y6SUHGZC`），可用于后续追加对话（见 5.3）

短 prompt 能通之后，再发实际的长 prompt 验证业务可用性。

---

## 四、常见问题与解决建议

### 4.1 OpenCode 报 `MCP error -32001 RequestTimeout`，或显示多次重复调用

**典型现象**：

- OpenCode UI 显示"已重试 N 次"
- 同一个用户问题，OpenCode 里显示调用了 `agent-zero_send_message` 好几次
- Agent Zero pod 日志在同一时段出现多个 `MCP Chat message received`

**根因**：两类行为叠加触发 ——

1. **OpenCode 客户端超时偏短**：默认 30–60 秒，但 Agent Zero 跑一次完整推理（特别是大模型 + 长 prompt）通常 20–60 秒，刚好踩边。一旦觉得超时，OpenCode 立刻 retry，没有 backoff
2. **OpenCode 这边 LLM 自作主张 parallel tool call**：很多 LLM 在使用 OpenAI tool calling 协议时，默认会并行调多次同一个 tool 来"加快"或"对照"。每次都会打一遍 Agent Zero

两者叠加，单条用户消息可能在 Agent Zero 这边触发 5–10 次完整推理，每次都吃 LLM 资源，整体响应反而变慢，最终都被砍超时。

**解决**（按重要性排序）：

| 序号 | 操作 | 关键度 |
|---|---|---|
| 1 | 在 `opencode.json` 里给 agent-zero 加 `"timeout": 300000` | ✅✅✅ |
| 2 | 在 prompt 里明确加"只能调用一次 agent-zero_send_message" | ✅✅✅ |
| 3 | OpenCode 这边的主模型选 tool calling 能力强的（推荐 `qwen3:14b` dense、`gpt-4o-mini`、`claude-3-5-sonnet`） | ✅✅ |
| 4 | 不要让 OpenCode 和 Agent Zero 共享同一个 Ollama 实例（资源竞争会放大问题） | ✅ |

### 4.2 Agent Zero 日志反复出现 `Memory consolidation timeout` / `RuntimeError: Error parsing chunk`

**典型现象**：

- 日志出现 `Error: Memory consolidation timeout for area fragments`
- LiteLLM 抛 `aiohttp ... ClientPayloadError: Response payload is not completed`
- 同一条消息的输出被反复截断重写，Markdown 表头出现重复

**根因**：每条 MCP 消息触发的 memory 插件链路在抢同一个 LLM 实例 ——

```
1 条 MCP 消息 → 1 路 Main LLM 调用
              → 1–2 路 Utility LLM 调用（memory 改写、相关性判断）
              → 0+ 路 Embedding 调用
```

如果这些角色都指向**同一个**单实例 LLM 服务（典型如同一个 Ollama），它会排队，触发 30 秒的 server 端超时，进而引发 retry —— 整个 agent 进入"明明在跑、但永远不返回"的状态。

**解决**（按重要性排序）：

1. **3 个角色配到 3 个独立的模型实例**（见第二节原则 1）
2. **Embedding 必须用真 embedding 模型**（见第二节原则 2）
3. **如果用不到长期记忆，直接关闭 memory 插件**：
   - Settings → Plugins → 找到 memory 相关条目，全部 Disable
   - 这样每条 MCP 消息只剩 1 路 Main LLM 调用，雪崩根除
   - 代价：跨会话的长期记忆失效；但短会话内的上下文不受影响

> **强烈建议**：如果你的 Agent Zero 主要用途是被其他应用通过 MCP 调用（而不是日常长期对话），直接关掉 memory 插件，稳定性提升最明显。

### 4.3 任何 tool 调用立刻报 `httpx.InvalidURL: /<模型名>/api/generate`

**根因**：对应角色（Main / Utility / Embedding）的 **API Base URL 没填**。

**解决**：Settings → Agent Settings → Models → Configure Models，把每个用到的角色的 API Base URL 填完整（带 `http://` 或 `https://` 和端口）。

### 4.4 MCP 工具能列出，但调用都失败 / 报 403

**根因**：MCP token 变了（重置 / 卸装重装 / 点了 Regenerate）。

**解决**：回 Agent Zero UI 复制最新 token，更新所有客户端配置里 URL 中间的 `t-XXX` 段。

### 4.5 客户端那边 MCP 状态一直红

**可能原因 + 排查**：

1. A0 MCP Server 开关没开 → 回 Settings 检查
2. URL 或 token 拼错 → 用 curl 验证 URL 可达：
   ```bash
   curl -i -X POST "https://<your-agentzero-domain>/mcp/t-<MCP_TOKEN>/http" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -H "MCP-Protocol-Version: 2025-03-26" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"diag","version":"1"}}}'
   ```
   期望返回 200 + 一行 `mcp-session-id: ...`
3. 客户端版本太老 → 升级；或试用其他兼容 MCP 的客户端

### 4.6 Olares 后台显示 Application `notReady`，但 UI 与 MCP 都能用

**根因**：Olares 控制器对慢启动应用的已知行为（启动期一次 503/403 后状态会被锁定一段时间）。

**解决**：不影响功能，可忽略。等几分钟或重启 pod 后通常会恢复 `running`。

### 4.7 速查表

| 现象 | 第一步排查 |
|---|---|
| `httpx.InvalidURL` | 对应模型角色的 API Base URL 没填 |
| `-32001 RequestTimeout` + 多次重复调用 | OpenCode 配 `"timeout": 300000` + prompt 加"只能调用一次" |
| `Memory consolidation timeout` / 日志混乱 | 3 角色 3 模型 3 pod，或直接关 memory 插件 |
| `403` / `404` | token 变了，复制最新 token 更新客户端 |
| MCP 状态红 | A0 MCP Server 开关 + URL 是否能 curl 通 |
| Application notReady | 大概率无害，忽略 |

---

## 五、其他建议

### 5.1 v0.9.x → v1.15 数据自动迁移

第一次启动 v1.15，老版本的 `/usr/_office`、`/usr/_desktop` 等目录会被自动迁移到 `/usr/plugins/<对应插件>` 下。**首次启动可能多花 10–60 秒**，是正常的，pod 日志里会看到 `Checking for data migration...` 字样。迁移失败会保留原目录并提示具体错误，不会丢数据。

### 5.2 插件管理

Settings → Plugins 里可以按需装/卸：

- LibreOffice Writer / Calc / Impress / Desktop
- Memory（如不需要长期记忆建议关，见 4.2）
- Browser
- Subagents / Skills 等

每个插件首次启用会在 pod 启动时下载相应组件，多占些磁盘和内存。

### 5.3 通过 MCP 调用时使用 persistent chat 延续上下文

MCP 客户端第一次调用 `agent-zero_send_message` 时，Agent Zero 会返回一个 chat ID（如 `Y6SUHGZC`）。后续调用同一工具时把这个 ID 与 `persistent_chat: true` 一起传过去，就能延续会话上下文：

```jsonc
// 后续调用
{
  "name": "agent-zero_send_message",
  "arguments": {
    "message": "继续上面那个话题",
    "persistent_chat": true,
    "chat_id": "Y6SUHGZC"
  }
}
```

不传 `chat_id` 等价于每次都开新对话。

---

## 六、参考链接

- Agent Zero 官方文档：<https://www.agent-zero.ai/p/docs/>
- 上游仓库：<https://github.com/agent0ai/agent-zero>
- MCP 协议：<https://modelcontextprotocol.io/>
- Olares Apps 仓库：<https://github.com/beclab/apps>
