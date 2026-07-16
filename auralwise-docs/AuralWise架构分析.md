# AuralWise（auralwise.cn）架构反推分析

> 外部技术分析，仅基于公开网页 + REST API 文档 + 主动 HTTP 探测的反推，未与平台方接触确认。所有结论的置信度按 **[高] / [中] / [推测]** 三档标注；文末单列一节专门审视每条结论可能错在哪里、可以用什么实验进一步验证或推翻。

---

## 0. 一句话结论

**[高]** AuralWise 是一款部署在阿里云边缘上的中文优先音频理解 API；后端用 Go 写、模型层基本对应 `faster-whisper + SenseVoice-Small + 类 CAM++ 192 维声纹 + YAMNet`；对外只暴露异步任务 + Webhook + 计费三大操作面，**完全不暴露任何 LLM 端点**。**[中]** 归属于天津吾安技术服务有限公司，与"一万个放心 / 朱峰 / 津津乐道"播客生态处于同一公司主体名下。**[推测]** 商业逻辑上像是把声湃 WavPub 自用多年的内部音频管线 API 化对外卖，但产品具体团队 / 负责人未直接验证。

---

## 1. 公开身份与归属

### 1.1 已确认事实 **[高]**

| 项 | 内容 |
| --- | --- |
| 主域名 | auralwise.cn |
| API 域名 | api.auralwise.cn |
| TLS 证书 CN | **auralwise.com**（说明 .com 也是其域名，可能做出海/品牌占位） |
| ICP 备案 | 津 ICP 备 2024013846 号-5 |
| 备案主体 | 天津吾安技术服务有限公司 |
| 备案时间 | 2025-08-18 至 2026-05-13 |
| Slogan | 让声音成为可理解、可检索、可调用的数据资产 |
| 站点形态 | Vite SPA，根 / pricing / about / blog 全部 fallback 同一份 HTML，无独立公司介绍/团队/Blog 页 |

### 1.2 与"津津乐道/朱峰/一万个放心"生态共主体 **[高 → 中]**

事实部分 **[高]**：

- 同一 ICP 备案号 `津 ICP 备 2024013846` 下还有子号 -1 = `yiwan.xin`（"一万个放心"，2024-03 备案）
- `yiwan.xin` 首页明文：源自津津乐道播客网络，朱峰为津津乐道创始人/产品及技术专家
- 第三方资料：声湃 WavPub（wav.pub / dao.fm）是朱峰旗下的播客托管平台，已自带 "ASR + 自动断句打点 + 情绪标记 + 字幕生成" AI 工作流

推断部分 **[中]**：

AuralWise 与"一万个放心 / 朱峰 / 津津乐道 / 声湃 WavPub"处于同一公司主体名下。**但未直接验证 AuralWise 这条新产品线（2025-08 才备案）的产品负责人是否就是朱峰本人**——他可能只是这家公司里"一万个放心"那块品牌的创始人，AuralWise 完全可能是公司里另一拨人在做的独立项目。

### 1.3 商业逻辑（**[推测]**，仅供参考）

若 1.2 的同主体推断成立，那 AuralWise 最自然的商业逻辑是**把声湃 WavPub 自用多年的内部音频管线 API 化对外卖**。这能解释：

- 定价能压低到 ¥0.50/小时（GPU 是自用沉没成本，外卖纯增量）
- Chinese-first 设计（服务自家中文播客）
- 暴露 192 维声纹（嘉宾跨期识别是真实痛点）
- 521 类音事件（章节分割、广告片段、笑声/掌声检测的天然落点）
- 无团队页 / Blog / 公众号（副线产品，无强 PR 动机）

但这仅是"如果归属关系成立则商业逻辑这样最顺"，**仍是推测，不是确凿事实**。

---

## 2. API 表面读出的能力切片（事实）

文档明面的能力：

- **ASR**（语音转写，99 种语言，标准模式词级 ~10ms 时间戳）
- **Diarization**（说话人分离，输出 192 维声纹 + Silhouette Score 单说话人判定）
- **AED / SED**（声音事件检测，521 类，±1s 精度）
- 异步任务 + 轮询 / Webhook（HMAC-SHA256 签名）
- 按"标准转写分钟数"扣费

ASR 有两条互斥的引擎，由 `optimize_zh` + 语言检测自动路由：

- **中文精简模式**：批量推理、比标准模式快 10–30 倍、只有段级时间戳无 words 字段、仅中文。
- **标准模式**：`beam_size / temperature / best_of / hotwords / initial_prompt / word_timestamps`，覆盖 99 种语言。

---

## 3. 大模型架构反推

### 3.1 标准 ASR = faster-whisper + Whisper-large-v3(-turbo) **[高]**

参数 1:1 对应：

| API 字段 | faster-whisper 实参 |
| --- | --- |
| `asr_language` (null 自动检测) | `language=None` |
| `asr_beam_size` 默认 5 | `beam_size=5` |
| `asr_temperature` 默认 0.0 | `temperature=0` |
| `asr_best_of` 1–20 仅在 T>0 生效 | `best_of` |
| `hotwords` | faster-whisper 1.x 起新增的同名参数（原版 Whisper / WhisperX / transformers Whisper 都没有这个） |
| `initial_prompt` | 同名参数 |
| 99 种语言 | Whisper 训练支持的语言数刚好 99 种 |
| 词级 ~10ms 时间戳 | faster-whisper `word_timestamps=True` 的 cross-attention 对齐精度 |

`hotwords` 是 faster-whisper 1.x 的独占参数，是把推断从"模仿 faster-whisper 接口"锁定到"就是 faster-whisper"的关键证据。**模型具体版本（large-v3 vs large-v3-turbo）未直接验证**，按"做中文不重训"的常规选择推断。

### 3.2 中文精简 ASR = SenseVoice-Small **[高，但含同代候选 Paraformer]**

每条性质都与 SenseVoice-Small 官方对得上：

| API 描述 | SenseVoice-Small |
| --- | --- |
| 比标准模式快 10–30 倍 | "15× faster than Whisper-Large"（不同硬件 10×–30× 都常见） |
| 批量推理 | 非自回归 NAR，天然支持 `batch_size_s=60` 动态 batching |
| 仅段级时间戳，无 words | NAR 模型无 token-级 attention，词级要后挂 CTC forced alignment |
| 仅中文，非中文回退标准 | 中/粤强、其它语种弱于 Whisper-Large，只暴露中文路径是合理的产品决策 |
| 计费远低于标准模式 | 推理成本约为 Whisper-Large 的 1/15，定价分级必然 |

**但**：FunASR 生态内的另一个候选 **Paraformer-Large** 同样是 NAR / batch / Chinese-strong，性质相似，**从公开 API 行为无法完全排除**。SenseVoice 是更新更强的同代后继，做新 SaaS 选它更合理。

### 3.3 VAD：双管线 **[标准模式高 / 中文模式中]**

- **标准模式 VAD = Silero VAD（faster-whisper 内置版）[高]**
  
  ```
  vad_threshold = 0.35
  vad_min_speech_ms = 250
  vad_min_silence_ms = 100
  vad_speech_pad_ms = 30
  ```
  
  这四个参数的名字、单位、默认数量级完全是 faster-whisper `VadOptions` 字段集。`vad_threshold=0.35` 那条注释"对背景音乐场景友好"也是社区调 Silero 的典型经验值。
  
- **中文精简模式 VAD = fsmn-vad（FunASR 默认搭配）[中]**

  这是行业默认推断——FunASR 官方 SenseVoice 示例就是 `vad_model="fsmn-vad"`。但 **API 不暴露中文路径用了哪一家 VAD**，没有直接行为证据，因此置信度只到"中"。

### 3.4 说话人分离 **[多档置信，需分项看]**

| 子项 | 内容 | 置信 | 依据 |
| --- | --- | --- | --- |
| 输出 192 维声纹 | 事实 | 高 | API 直接字段 |
| 单说话人靠 Silhouette Score 阈值回退 | 事实 | 高 | `diarize_single_speaker_threshold = 0.05` 字段命名 |
| 模型 = CAM++ (3D-Speaker zh_en common) | 推断 | 中 | 192 维是 CAM++ 招牌，**但 ECAPA-TDNN 也是 192 维**，从数字无法唯一锁定；中文场景 + 同生态 (FunASR 也含 CAM++) → CAM++ 概率最高，ECAPA 不能排除 |
| 聚类算法 (AHC / 谱聚类 / UMAP+HDBSCAN) | 推测 | 推测 | API 看不出来；"clustering-based diarization + Silhouette 回退"是工业常见模式 |
| 非端到端 EEND，复用 ASR 段边界 | 推断 | 高 | "diarize 需要同时启用 ASR"、"diarize_segments 直接使用 VAD 段边界" 两条文档表述指向 clustering-based |

### 3.5 声音事件 = YAMNet **[高]**

最稳的一个指纹：

- "支持 **521 类**" —— AudioSet 原始 527 类，**砍掉 6 类（Male/Female × Speech/Singing + Battle cry + Funny music）后正好是 521**。这是 **YAMNet 独有的剪裁**（Google Research 出于 Fairness 决定），其它候选（PANNs/AST/CED/EAT/PaSST）全部仍是 527 类。
- API 返回的 `mid` 字段（如 `/m/09x0r` = Speech、`/m/01b_21` = Cough）就是 YAMNet `yamnet_class_map.csv` 里的 Machine ID 原样字段。
- "8 大类（人声/动物/音乐/自然/交通/家居/电子/环境）"是 YAMNet/AudioSet ontology 常见的 8-group 中文化分类。
- "精度 ~±1s" —— YAMNet 原生 frame 是 0.96s/帧、0.48s hop，文档把它向上简化到秒粒度。

**理论上**有人可以用别的底模 + 借用 YAMNet 标签集做对外接口，但这种"借标签集"很罕见。

### 3.6 大语言模型 **[高，含一处边界]**

**[高] 对外 API 完全没有 LLM 端点**：没有 Summarize、Chat、Embedding for Search、Q&A 等。所谓"可理解、可检索、可调用"的 slogan 实际靠"输出结构化 JSON + 192 维声纹 + 时间戳"间接达成。

**[边界]** 不能排除内部用 LLM 做后处理（如标点恢复、ITN、热词扩展），这部分从外部完全看不到。

### 3.7 综合矩阵

| 能力 | 推断的开源模型 | 置信 |
| --- | --- | --- |
| 标准 ASR | Whisper-large-v3(-turbo) on faster-whisper / CTranslate2 | 高（模型版本未验证） |
| 中文精简 ASR | SenseVoice-Small（或同代 Paraformer-Large） | 高（含同代候选） |
| 标准模式 VAD | Silero VAD | 高 |
| 中文模式 VAD | fsmn-vad | 中（行业默认） |
| 说话人声纹 | CAM++ 或 ECAPA-TDNN（均 192-dim），中文场景下 CAM++ 更可能 | 中 |
| 说话人聚类 | Silhouette 阈值回退 [高] + AHC/谱聚类 [推测] | 阈值高 / 算法推测 |
| 声音事件 | YAMNet (521 类) | 高 |
| 大语言模型 | 对外无 [高]；内部存在与否未知 | 高（仅对外） |

---

## 4. 后端 / 基础设施

### 4.1 后端语言 = Go **[高]**

两条独立指纹联合（实测 curl 原文见下）：

| 证据 | 含义 |
| --- | --- |
| 404 路径返回 `404 page not found` 纯文本 + `Content-Type: text/plain` | Go 标准库 `http.NotFound` 的字面默认输出（写 plaintext "404 page not found\n"）。Tengine 自带 404 是 HTML，不是这个；Python/Node/Rust 默认都不写成这串 |
| 错误 JSON 中 `<` 被转义成 `\u003c` | Go `encoding/json` 默认 `HTMLEscape(true)`。Python `json.dumps`、Node `JSON.stringify` 默认不做此转义；**Java Gson 默认也会做**（HTMLEscape），所以这一条单独不能完全排除 Java/Kotlin |

**结论**：单独看任一条还不算排他，**两条联合**几乎只能是 Go——因为 Java/Kotlin 后端要恰好同时做出"输出 exact `404 page not found` 字符串"+"用 Gson 默认转义"两件事的概率极低。框架风格猜 Chi / Gin / Echo 中间件层级。

实测原文：

```
$ curl https://api.auralwise.cn/v1/nonexistent
404 page not found

$ curl https://api.auralwise.cn/v1/tasks
{"error":"authentication required: provide Authorization: Bearer \u003ctoken\u003e or X-API-Key"}
```

→ 中文 ML 库主体在 Python，所以"**Go 写薄 API + Python 跑模型 worker**"是这种组合的常见分层。

### 4.2 边缘 = 阿里云 CDN + WAF + 验证码 **[高]**

| 证据 | 含义 |
| --- | --- |
| `Server: Tengine` | 阿里云专属 Nginx 分支（Taobao Tengine） |
| `Via: cache23.l2cn3163` / `kunlun6.cn6489` / `Ali-Swift-Global-Savetime` / `EagleId` | 阿里云 CDN 节点编号 |
| `X-WAF: true` + HTTP 468 challenge + `Set-Cookie: sl-session` | 阿里云 WAF |
| 首页 `<script src="...alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js">` | 阿里云验证码 2.0 SDK |
| TLS 证书 Subject CN = `auralwise.com`，签发 Let's Encrypt R13，90 天周期 | 自签自动续（Caddy / acme.sh / certbot 风格），未走阿里云证书产品 |

**重要边界 [中]**：以上**仅确定边缘（CDN + WAF + 验证码）用了阿里云**。源站具体云厂商（阿里云 ECS？腾讯云？AWS？裸金属？）**没有直接证据**，只能推测大概率仍是阿里云（与边缘同厂商集成最方便），但不能排除跨厂商部署。

### 4.3 前端 = Vite SPA **[高]**

```html
<script type="module" crossorigin src="/assets/index-B5AA80V5.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-CFd8DCOs.css">
```

`index-XXXXXXXX.{js,css}` 8 位 hash 是 Vite 默认产物命名。HTML 体积仅 1827 字节，整页都靠前端 JS 渲染。爬虫友好：手动加了 `<link rel="alternate" type="text/markdown" href="/api-docs.md">`，给爬虫/AI 提供纯文本版本。

### 4.4 公开 API 端点全集（实测） **[事实]**

| 路径 | 状态 | 说明 |
| --- | --- | --- |
| `POST /v1/tasks` | 401（缺 key 时） | 创建任务 |
| `GET /v1/tasks/:id` | 401 | 查询任务 |
| `GET /v1/tasks/:id/result` | 401 | 取结果 |
| `DELETE /v1/tasks/:id` | 401 | 删任务 |
| `GET /v1/audio-event-classes` | 401 | 声音事件类别（**需鉴权**，反爬倾向） |
| `GET /v1/billing/transactions` | 401 | 账单流水 |
| 其余 `/v1/login` `/v1/me` `/v1/users` `/v1/api-keys` `/v1/health` `/healthz` `/metrics` `/version` 等 | **全部 404** | 账户管理 API 完全不在公网 API tier |

两个推论：

- **[高]** CORS 允许的 `X-Node-Token` 头是一个非公开的内部 token 体系。最可能的用途是 worker → API 回写结果的共享密钥（"Go 薄 API + Python 厚 worker"分层的典型做法），但不能排除是 admin 内部 tool / cron job 等其他用途。
- **[高]** 账号管理 API 不在 `api.auralwise.cn` 暴露，应在 SPA 同源（`auralwise.cn`）的另一组路由上，与开发者 API tier 物理分离。

### 4.5 工程架构（**整体推测性骨架**，仅用于对照参考）

> **本节图示中除"Go API"、"独立 worker tier 通过 X-Node-Token 互信"、"边缘 = 阿里云" 这三点外，其余（队列实现 / 数据库选型 / 对象存储具体厂商 / 容器编排方式）都是基于行业常见模式的猜测，没有直接证据。**

```
                ┌─────────────────────────────────────────────────────────────┐
                │      Public Edge：阿里云 CDN (Tengine) + WAF [高]            │
                │          + 阿里云验证码 2.0（注册 / 防刷） [高]              │
                └────────────────────────────┬─────────────────────────────────┘
                                             │
                ┌────────────────────────────▼─────────────────────────────────┐
                │   API Gateway / Public REST API   ★ Go 后端 [高] ★            │
                │     Chi / Gin / Echo 风格中间件 [推测]                         │
                │  POST /v1/tasks  GET /v1/tasks/:id  /result  /billing        │
                │  X-API-Key (asr_ 前缀 44 字符) | JWT Bearer [事实]            │
                │  X-Node-Token (内部 worker 回调 [推断]) [高存在 / 用途推断]    │
                │                                                              │
                │  同一 Go 二进制（推测）在 auralwise.cn 域提供 SPA + 账号管理   │
                └────────────────┬────────────────────────┬────────────────────┘
                                 │ enqueue [推测]         │ query [推测]
                                 ▼                        ▼
                    ┌──────────────────────┐   ┌──────────────────────────┐
                    │ Job Queue [推测]      │   │ DB [推测]                 │
                    │ Redis / asynq / ...  │   │ Postgres 或 MySQL         │
                    │ batch_mode=true →    │   │ - users / api_keys        │
                    │ 低优先级队列         │   │ - tasks                   │
                    └──────────┬───────────┘   │ - speaker_embeds (192-d)  │
                               │               │ - billing_txn (numeric)   │
                               ▼               └──────────────────────────┘
              ┌──────────────────────────────────┐
              │  GPU Worker Pool (Python) [推断]  │
              │  ┌────────────────────────────┐  │       ┌────────────────┐
              │  │ ffmpeg 解码 → 16kHz mono   │──┼──────▶│  对象存储 [推测] │
              │  │ ↓                          │  │       │  原始音频       │
              │  │ Language Detect            │  │       │  + 结果 JSON    │
              │  │ ↓                          │  │       │ (阿里云 OSS 或   │
              │  │ Router (optimize_zh + zh?) │  │       │  MinIO 自托管？) │
              │  │   YES → funasr 管线：      │  │       └────────────────┘
              │  │     fsmn-vad → SenseVoice  │  │
              │  │     ↘ batch_size_s 动态批  │  │
              │  │   NO  → faster-whisper：   │  │
              │  │     Silero VAD → Whisper   │  │
              │  │     ↘ word_timestamps      │  │
              │  │ ↓                          │  │
              │  │ Diarize (if enabled):      │  │
              │  │   CAM++/ECAPA → 192-dim →  │  │
              │  │   聚类 → Silhouette 回退   │  │
              │  │   → speaker labels         │  │
              │  │ ↓                          │  │
              │  │ AED (if enabled):          │  │
              │  │   YAMNet 521 类 → 阈值过滤 │  │
              │  │ ↓                          │  │
              │  │ 结果 POST 回 API 主进程    │  │
              │  │ (用 X-Node-Token 鉴权)     │  │
              │  └────────────────────────────┘  │
              └────────────────┬─────────────────┘
                               │ webhook (HMAC-SHA256, 4 次重试 0/1/5/30s) [事实]
                               ▼
                       Customer's callback_url
```

---

## 5. 自我审视：每条结论可能错在哪里

按章节列出**所有非"高"置信项**，逐条说明可能的反假设、未验证项、以及可以用什么实验进一步证实或推翻。

### 5.1 与朱峰/津津乐道生态共主体 → 推产品负责人

| 当前结论 | 可能错处 | 验证手段 |
| --- | --- | --- |
| AuralWise 与朱峰/津津乐道/一万个放心共公司主体 | 朱峰可能只是"一万个放心"那块品牌的创始人/IP 顾问，并非天津吾安的法人代表 / 控股人 | 查工商系统看天津吾安的股东及法定代表人 |
| 商业逻辑：声湃 WavPub 内部管线 API 化 | AuralWise 可能是公司里另一拨人独立做的新项目，与播客业务无直接技术继承 | 联系 hi@yiwan.xin 求证；或比对 WavPub 已暴露的转写功能输出与 AuralWise 是否同构 |

### 5.2 中文精简 ASR = SenseVoice-Small

| 当前结论 | 可能错处 | 验证手段 |
| --- | --- | --- |
| SenseVoice-Small | 可能是 Paraformer-Large（同代 NAR，性质相似） | 观察转写输出是否包含 SenseVoice 独有的 emotion / SER token（如 `<\|HAPPY\|>`、`<\|NEUTRAL\|>`），或对完全静音段是否给出 `<\|nospeech\|>` 标志 |

### 5.3 中文模式 VAD = fsmn-vad

| 当前结论 | 可能错处 | 验证手段 |
| --- | --- | --- |
| fsmn-vad（FunASR 默认） | 可能自托管时统一用 Silero（工程师为减少依赖也会这么选），或自研 | 比对同一段音频在已知 fsmn-vad 实现和 AuralWise 两种引擎下的段边界差异 |

### 5.4 声纹模型 = CAM++

| 当前结论 | 可能错处 | 验证手段 |
| --- | --- | --- |
| 192-dim CAM++ | 可能是 ECAPA-TDNN（也是 192-dim） | 同一段音频做声纹后，与已知 CAM++ / ECAPA 模型分别比对**余弦相似度**——同源会接近 1，不同源会显著低（embedding 空间不通用） |
| 聚类用 AHC / 谱聚类 | 可能是 UMAP+HDBSCAN、Online clustering 等 | 构造对照样本（已知 2 说话人 / 3 说话人 / 单说话人），观察临界行为 |

### 5.5 后端 = Go

| 当前结论 | 可能错处 | 验证手段 |
| --- | --- | --- |
| Go | 理论上 Java / Kotlin（Gson 默认也会 HTMLEscape）+ 自定义 404 plaintext handler 也能做出同样响应——但要刚好同时复制 Go 标准库的 exact string `"404 page not found"` 几乎不可能 | 触发更多错误路径（method not allowed、payload too large、超时等），看错误格式风格是否一致；或观察服务重启行为的延迟特征 |

实际我评估"是 Go"的概率 > 95%，Java/Kotlin 概率 < 5%。

### 5.6 基础设施

| 当前结论 | 可能错处 | 验证手段 |
| --- | --- | --- |
| 边缘 = 阿里云 [高] | （这部分稳） | — |
| 源站云厂商 = 阿里云 [推测] | 源站可能在腾讯云 / AWS / GCP / 裸金属，仅 CDN+WAF+验证码用阿里云 | 解析阿里云 WAF 后端实际 IP（需访问权限）；或观察任务在不同地区的处理延迟特征 |
| 队列 = Redis / asynq | 可能是 RabbitMQ / NATS / SQS / Postgres-Listen | 无外部探测手段 |
| 数据库 = Postgres | 国内云更主流是 MySQL（阿里云 RDS 默认） | 无外部探测手段 |
| 对象存储 = 阿里云 OSS | 可能是 MinIO 自托管或腾讯云 COS | 无外部探测手段 |

→ **4.5 节那张架构图中除标 [高] 和 [事实] 的部分外，其它都仅是行业常见模式的猜测**。

### 5.7 工程架构具体实现

| 当前结论 | 可能错处 | 备注 |
| --- | --- | --- |
| X-Node-Token = worker→API 回写认证 | 可能是 admin/internal-tool 用，或健康检查/巡检用 | 头存在是事实，用途是推断 |
| 同一 Go 二进制按 vhost 分流 SPA 和 API | 可能是两个独立服务，前后端在 Nginx 层 path-based 路由 | 无外部探测手段 |
| 模型版本（large-v3 vs turbo 等） | 任何 fine-tune / 量化精度 / 模型版本细节 | 跑标准 benchmark 音频比对识别结果 |

### 5.8 内部是否使用 LLM

**[高] 对外 API 完全没有 LLM 端点**，这一条很稳。但**不能排除内部用 LLM 做后处理**（如标点恢复、ITN、热词扩展、说话人姓名 NER），这部分从外部完全看不到。

---

## 6. 一句话再总结

AuralWise 是一款部署在阿里云边缘上的 Go 写的中文优先音频 API，模型层把 `faster-whisper / SenseVoice-Small / 类 CAM++ 192 维声纹 / YAMNet` 这四个开源 SOTA 拼成异步管线对外卖；归属于天津吾安技术服务有限公司，与"一万个放心 / 朱峰 / 津津乐道"播客生态处于同一公司主体名下（但具体团队/负责人未直接验证）；自身完全不暴露 LLM 能力，定位是"音频结构化数据 API"而非"音频 Agent"。

技术上几乎可以理解为：**`speaches`（faster-whisper 服务化）+ `funasr` Docker + `cam++/yamnet` ONNX + Go 写的薄 API + Celery/asynq + DB + 对象存储**这套自托管组合的商业云端版本。
