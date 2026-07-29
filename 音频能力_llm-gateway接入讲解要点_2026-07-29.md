# 讲解要点：llm-gateway 要怎么改，才算"好好接住"音频模型

面向对象：接手 llm-gateway 改造的同事。
参考实现：`llm-gateway` 仓库两个分支——
- `feat/audio-base`：**最小可用面**（已出镜像 `v2.0.12-test1`，两个 DEMO 正跑在上面）
- `wip/audio-decap-full`：**完整去特殊化版**（capability 列 + catch-all 路由 + 前端能力槽位）

讲解主线一句话：**音频不是"再加一个 mode"**。它是「一个 mode=audio 的模型对外提供多个能力端点 +
长任务 + 二进制/双向流」，所以网关要动的是四个面：**转发面、建模面、时限体量面、计量发现面**。
不先讲清上游长什么样，后面每一条都会像是在给音频开特例。

---

## 0. 先讲上游：音频基座长什么样（5 分钟，不能省）

- 一个基座实例 = 一个模型 = 一块 GPU 配额；同一基座 clone 多份跑不同模型。
- 实例里 `llm-init` 是**纯反向代理**（不再有音频特判），引擎自报家门：
  `GET /v1/models` 回 `id / mode / supports / endpoints`，`GET /metrics` 回 `gpu_*`。
- 能力键是**裸键**，14 个：`stt / stt_stream / vad / diar / diar_stream / align / enhance /
  speaker_embed / tts / tts_clone / tts_dialogue / audio_llm / audio_s2s / sound_fx`
  （对应网关侧 `supports.AllAudioSupports`；`translate` 是文本侧能力，不在这套里）。
- 端点形态四种，都跟 chat 不一样：
  1. **multipart 上传**（整段音频一个 body）；
  2. **二进制响应**（`enhance` 直接回 wav/flac/ogg，不是 JSON）；
  3. **双向 WebSocket**（`stt_stream` / `diar_stream`）；
  4. **异步任务制**：POST 带 `async=1` → 202 + task id；再用
     `GET /v1/audio/tasks/:tid`（状态+进度）、`GET .../result`、`DELETE .../:tid`（取消）。
- **引擎会长新端点**：异步任务那四条就是上周才长出来的。这一点直接决定路由怎么写（见 §1）。

---

## 1. 转发面：一条 catch-all，逐字转发

**核心设计选择（最值得讲的一条）：按动词写 catch-all，别按端点写路由。**

```
POST   /v1/audio/*path   → 提交（可计费动词，同步/异步都走它）
GET    /v1/audio/*path   → 任务查询 / 结果读取；带 Upgrade 头则转成 WS 代理
DELETE /v1/audio/*path   → 取消
```

理由：引擎自报能力、llm-init 是纯反代，如果网关一条路由一个端点，**网关就成了"引擎每长一个
端点就得改代码发镜像"的那个组件**——异步任务 API 已经把这件事演示过一遍了。最小面分支就是
一条路由一个端点（9 条 + 4 条任务路由），完整版收成 3 条。

配套的三个原则：

- **逐字转发**：请求侧保留 `Content-Type`（含 multipart boundary）、query string、`Accept`；
  响应侧原样回 `Content-Type` / status code / body。网关**不解析音频、不重写 body**
  （唯一读的字段是 multipart 里的 `model`，还是有上限的 bounded read，4 KiB）。
- **能力→路径映射表只用于"空 model 解析默认模型"**：`transcriptions→stt`、`diarization→diar`……
  表里没有的路径**照样能转发**（只是必须显式传 `model`），这样引擎新增能力不需要网关发版。
- **任务 API 必须带 `?model=`，且不计费**：网关是无状态的，task id 本身不说明是哪台引擎持有它；
  另外每次轮询记一条 spend 会把账单表刷爆。

WS 那条另说，四个必须做对的点：nginx 要透传 `Upgrade`/`Connection`；**先 dial 上游再 upgrade
客户端**（冷引擎才能干净地回 HTTP 502 而不是挂住）；双向泵各自 goroutine、任一方向结束就双关；
单帧读上限（16 MiB）防疯狂 peer。

适配器侧：只有 `openai_compatible` 需要音频面（它挡在 Olares 基座前面），bespoke 适配器
（Anthropic / Gemini / Azure）返回 `ErrAudioUnsupported` → 422。完整版把任务读取做成**可选接口**
（调用点 type assert），免得每个适配器背一个空 stub。

---

## 2. 建模面：一个 coarse mode，能力另开一维（最容易做错的地方）

**决策一：mode 只加一个 `audio`，能力放 `model_spec.supports`。**
不要做 mode-per-capability——那意味着 14 个 mode 值、DB CHECK、分发器、控制台全要跟着展开。

**决策二：默认模型必须多一维 `capability`。**
一个 mode=audio 模型同时服务 stt / vad / diar / align…，每个端点都想有自己的默认模型。

- 最小面分支的做法：**把能力键塞进 `default_models.mode` 列**当伪 mode 用（能跑，但语义脏，
  `mode='stt'` 的行指向的其实是 `mode='audio'` 的模型）。
- 完整版的做法（**建议同事直接走这条**）：`system_default_models` / `tenant_default_models`
  加 `capability` 列，主键/唯一键扩成 `(mode, capability)` / `(user_id, mode, capability)`；
  代码里用 `defaults.Key{Mode, Capability}` 让两半永远一起走（单传 mode 去查音频槽位是
  静默错，这也正是当初把能力塞进 mode 列的后果）。

**决策三：capability 词表不要在网关白名单化。** 引擎自报能力，网关白名单 = 引擎每学一个新能力
就要发一次网关版。只校验"能进 URL 和 JSONB 的裸键"（小写字母/数字/下划线，长度上限）。
注意最小面分支为了 DB CHECK 反而把 14 个键写进了迁移里，完整版把这层去掉了。

**解析规则**：能力槽位的默认模型 = `mode='audio' AND model_spec->'supports' @> {"<cap>":true}`
（JSONB 包含判断），三层 fallback（user → system → 最老的活跃行）保持原样不动。

**自动注册（这条决定"装完基座能不能开箱可用"）**：Market `/llm-providers` 的
`sharedentrances_url` + `model_metadata`（`model_name` / `mode` / `supports`）→ 落成
provider + provider_models 行。我们的实现是 **additive、`ON CONFLICT DO NOTHING`**，
绝不覆盖运维手改过的 spec。**跨团队依赖**：Market 侧必须把 `mode=audio` 和 `supports`
原样带出来，否则网关这边只能靠人工建 provider。

**错误码分层**（应用要能区分"模型选错了"和"这台引擎没这个能力"）：
`audio_mode_mismatch`(422) / `capability_not_supported`(404) / `audio_unsupported_for_provider`(422)。

---

## 3. 时限与体量面：不改这块，音频在网关上必挂

三条硬线，讲的时候按顺序摆出来：

| 位置 | 限制 | 后果 |
|---|---|---|
| 平台 Envoy | `stream_idle_timeout` **300s** | 长音频同步请求过 5 分钟被切 |
| llm-init | `ResponseHeaderTimeout` **60s** | 引擎想久了就 504 |
| **网关自己出站** | `provider.timeout` **60s** / `read_timeout` **30s** | **同步音频先死在网关自己身上** |

最后一行是最容易被忽略的：这套默认值是照 chat 定的，音频一个 `enhance` 就能超。

- 结论：**异步任务制是主路径，不是优化**。网关只要把四条任务路由透传好，长任务三条线都碰不到。
- 同时建议给音频单独的出站超时档位（或 per-provider 覆盖），别继续挂在 chat 的 60s/30s 上。
- **体量**：nginx server 级 `client_max_body_size 32M` 是按聊天附件定的，**半小时 WAV 就超**。
  数据面提到 **256M** 并 `proxy_request_buffering off`（别让上传先落代理磁盘）。
  但真正的天花板在后端：**handler 把 body 整个读进内存再转发**，256M × 并发就是 RAM 账。
  想再高必须改成流式转发（把 `req.Body` 直接接到上游，或 `io.Pipe`）。
- 重试/熔断：POST 不会因读超时被重放（只有 connection refused 才重发），这点现状是安全的；
  但**冷启动/下模型期间 llm-init 会持续 503**，要确认这类 503 不会把 provider 熔断器打开
  （`breakerMinRequests 10 / failureRatio 0.5 / openSeconds 30s`）把整台引擎拉黑。

---

## 4. 计量面

- **POST 是计费动词**（提交，同步异步都算）；GET/DELETE 不计费。
- spend 按**能力键分桶**（`stt` / `vad` / `diar`…），不是笼统记成 `audio`。
- WS 按**音频秒**计量：嗅探首帧控制消息的 `sample_rate`，累加 PCM 字节，
  `seconds = pcmBytes / (sampleRate*2)`，打 tag `unit:audio_seconds`。
- **已知缺口（要产品/计费拍口径，不是技术难点）**：REST 音频响应里没有 `usage` 块，
  所以现在 spend 行是 0 token / 0 成本。音频要么按秒计价、要么按次计价，
  需要 pricing 单位 + quota 口径落地。

---

## 5. 发现面：目前对第三方应用最不友好的一块

- `GET /v1/models` 只回 `id / owned_by / qualified id`，**不带 mode 和 supports**
  → 应用在数据面**问不出"谁能做 STT"**。
- 我们两个 DEMO 只能绕到管理面：`/console/api/providers` 拉列表，再**逐个** provider detail
  才能拿到 `supports`（N+1 请求 + 需要管理员权限）。这明显不该是第三方应用的接入方式。
- 建议：`/v1/models` 带上 mode / capabilities，或支持 `?capability=stt` 过滤。
- **WS 鉴权**：浏览器 `WebSocket` API 不能设请求头 → 我们 DEMO 只好自建服务端 WS 代理，
  在 upgrade 时补上 key/cookie。建议网关支持 `?api_key=` 或一次性 ticket。

---

## 6. 落地顺序建议（讲完设计给条路线）

1. **DB**：`provider_models.mode` 加 `audio`；默认模型表加 `capability` 列（含回填）。
2. **数据面**：catch-all 三条路由 + 逐字转发 + WS 代理 + 任务透传。
3. **时限体量**：音频出站超时档位、nginx 256M、`proxy_request_buffering off`。
4. **自动注册**：Market `model_metadata` → provider_models 的 mode/supports 落库。
5. **控制台/前端**：按能力的默认模型槽位 UI。
6. **计量与发现**：音频 pricing 单位；`/v1/models` 带能力。

---

## 7. 三个"别踩"（收尾用，最有说服力）

1. **别按端点写路由**——引擎长一个端点，你就得发一次版。
2. **别把能力塞进 `mode` 列**——我们干过，最小面能跑，但语义脏、迁移还要多走一步。
3. **别把音频挂在 chat 的超时/体量参数上**——60s / 30s / 32M 三条会一次全踩。
