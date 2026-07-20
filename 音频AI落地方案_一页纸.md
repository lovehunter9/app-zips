# 音频 AI 能力落地方案 · 一页纸

> 一句话定位：本次 llm-init / llm-gateway / audiolabx2v3 / audiominutesxdemo 的工作，是把
> **《音频模型和场景》里的「基本思路」**完整落地——模型托管与应用调用分开，逐类标准化、网关聚合、olares-cli 为一等居民。

---

## 一、思路是怎么一步步成形的

音频任务天生是"多模型组合"（一个转录任务就要 VAD + STT + Diar + Translate，且每类还有多种选型）。围绕"怎么把这堆能力做成产品"，经历了三个阶段：

1. **探索期 —— voice-ai-hub（Opus，仅供参考）**
   价值：第一次把"完成一个 audio pipeline 需要哪些能力"彻底拆清楚，沉淀出统一的**能力词表**
   （stt / stt_stream / tts / tts_clone / tts_dialogue / vad / diar / diar_stream / translate / enhance / embed / align / audio_llm / audio_s2s / sound_fx）。
   形态：设想成**一个单体应用**，内部编排 + 对外统一 audio API。

2. **成形期 —— 《音频模型和场景》的「基本思路」**
   在 voice-ai-hub 的能力拆分基础上，进一步明确了**两条更根本的原则**：
   - **模型的托管** 和 **应用的调用** 要**分开**；
   - 优先复用平台既有底座（LLM-INIT + LLM Gateway + olares-cli），保持轻量集成。
   于是"统一"的落点从"单体 hub"迁移到了"**网关聚合层**"：能力仍按类型拆开托管，统一体现在接入与纳管。

3. **落地期 —— 本次工作**
   把成形期的架构真正实现出来，并用一个真实场景（妙记复刻 audiominutesxdemo）跑通验证。

> 关键：能力拆分的成果被**完整保留并沿用**（能力词表一字未改）；变化的只是"对外怎么暴露、在哪一层聚合"——从单体应用演进为"托管/调用分离 + 网关聚合"。

---

## 二、目标架构（基本思路）

```
 应用层    audiominutesxdemo（妙记复刻）等  ← 只负责业务与编排/分段
   │  OpenAI 兼容调用
 聚合层    LLM Gateway   ← 统一接入 / 鉴权 / 配额 / 计费 / 观测 / provider 纳管
   │
 托管层    LLM-INIT × 各音频模型（audiolabx2v3 …）
          每个模型 = 一个 provider，按能力类型暴露标准接口，保证 I/O 可组合
   │
 调用面    olares-cli 一等居民；UI 层主要看状态
```

---

## 三、本次落地 ↔ 基本思路 对照

| 基本思路 | 本次交付 | 说明 |
|---|---|---|
| ① LLM-INIT 托管 + 每类模型统一接口 + I/O 可组合 | **llm-init PR #44** | `ENGINE_KIND=audio`，按 `MODEL_MODE` 暴露该类能力的 `/v1/*`（stt/vad/diar/translate/enhance/align + 流式 WS），`/v1/models` 边缘合成 |
| ② LLM Gateway 聚合 | **llm-gateway PR #5** | audio/translate 复用既有 chat 数据面（dispatch→鉴权/配额→转发→计费→观测），扩 audio modes，加 `/v1/audio/*` 端点 + provider 自动纳管；"No new architecture" |
| 模型托管（把模型做成可安装的 app） | **audiolabx2v3**（本仓库） | 音频模型的 Olares chart；专门验证 llm-init「免 nginx 音频代理」路径（entrance 直指 `download-svc:8090`，无 openresty sidecar）。**已上线 12 个实例**，覆盖 10 类能力 |
| 应用与模型调用分离 | **audiominutesxdemo** | 妙记复刻，作为"应用"消费上面的能力（含智能摘要 / 智能问答），已部署验证 |

---

## 四、"统一"体现在哪一层

- "统一"落在**接入与纳管层**：一套鉴权 / 配额 / 计费 / 展示，OpenAI 兼容路径让现成 SDK 零改造接入。
- **能力本身按类型拆开、逐类标准化**，从而做到"模型托管与应用调用分开、同类模型可互换、不同类型可串联"。
- 一句话：**拆分在托管层，统一在聚合层——同一思路里的分工。**

---

## 五、下一步 / 真正的难点

- **I/O 可组合性 + 分段策略**是质量关键：当前要做到转写/对齐/翻译质量好，仍需分段（且中英文选不同 STT），分段=多次调用、效率下降。
- 定位：**编排与分段放在应用层 / olares-cli 脚本**（符合"托管与调用分开"），托管层只保证每类接口标准、可串联；网关层负责聚合与计费。
- 待办：① 沉淀一套可复用的分段/选路策略；② 补齐能力词表里尚未移植的模型；③ 逐类支持公有云同类模型（BYOK）。

---

## 附一：已移植模型应用清单（audiolabx2v3，12 实例已上线）

每个实例 = 1 个具体模型，由 llm-init 以 provider 形态托管，按其 `MODE` 暴露对应的标准端点。

| 能力 MODE | 模型（MODEL_NAME） | 实例 | GPU | 对应端点 |
|---|---|---|---|---|
| stt（离线） | Systran/faster-whisper-large-v3 | 0263ef | 6Gi | `POST /v1/audio/transcriptions`·`/translations` |
| stt（离线） | Qwen/Qwen3-ASR-1.7B | 93e848 | 12Gi | 同上 |
| stt_stream（流式） | Qwen/Qwen3-ASR-1.7B | b0c2ed | 12Gi | `WS /v1/audio/stream` |
| vad | silero-v5 | dd1ed9 | CPU | `POST /v1/audio/vad` |
| diar | pyannote-community-1 | 818606 | 4Gi | `POST /v1/audio/diarization` |
| diar_stream（流式） | diar-streaming-sortformer | 9c4797 | 6Gi | `WS /v1/audio/diarize/stream` |
| align | Qwen/Qwen3-ForcedAligner-0.6B | c84c8e | 4Gi | `POST /v1/audio/align` |
| translate | m2m100-1.2B（**商用默认**） | 54d617 | CPU | `POST /v1/translate` |
| translate | nllb-200-distilled-600M | 53f4c2 | CPU | 同上 |
| translate | nllb-200-distilled-1.3B | 8e1b2f | CPU | 同上 |
| embed | pyannote-embedding | cdcb44 | CPU | `POST /v1/audio/embeddings` |
| enhance | mtl-mimic-voicebank | 0e4d03 | 2Gi | `POST /v1/audio/enhance` |

> 说明：所有实例统一走 `/v1/models` 做能力自述；同一能力可挂多个模型互换（如 STT 有 whisper/qwen 两种、translate 有 3 种）。
> 公网 URL 属于克隆 app 的私有信息，需逐个向用户确认，此处不列。

## 附二：对照「时间表」的覆盖度

| 业务场景（里程碑） | 所需能力 | 状态 |
|---|---|---|
| 会议转录（出门问问耳机 / Plaud，1.12.7） | stt 离线 + vad + diar | ✅ 已移植 |
| 语音输入（Typeless，1.12.8） | stt_stream | ✅ 已移植 |
| 视频/播客转录（Youtube，1.12.9） | translate（+ tts / tts_clone） | 🟡 translate 已移植；tts 系列待做 |
| 数字人（1.12.10） | tts_dialogue / audio_llm / audio_s2s / sound_fx | ⬜ 待做 |
| 附加：对齐/增强/向量 | align / enhance / embed | ✅ 已移植 |

尚未移植的能力（后续阶段）：`tts` / `tts_clone` / `tts_dialogue` / `audio_llm` / `audio_s2s` / `sound_fx`（生成与对话类，属 1.12.9/1.12.10）。
