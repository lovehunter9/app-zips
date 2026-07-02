# audiolabxv3 · `diar_stream`（流式说话人分离）能力选型调研

> 调研日期：2026-07-02。
> 背景：老板 15 个 `MODEL_CAPABILITY` 清单里有 **`diar_stream`**（流式/在线说话人分离）。刚完成 `stt_stream`（流式 ASR）后，用户敏锐指出「实时会议记录/实时字幕」不止需要 stt_stream——还需要 diar_stream 回答**「谁在说」**。本文横评主流流式分离方案，确定首个范例模型，并厘清与 stt_stream 的**融合（时间轴）**这一硬前提。

---

## 一、先厘清概念：`diar`（离线）≠ `diar_stream`（在线）

| | `diar`（已集成） | `diar_stream`（本次） |
|---|---|---|
| 处理方式 | **离线批处理**：看完整段音频再做全局聚类/重排 | **在线流式**：音频边到边判，恒定延迟、无未来上下文 |
| 说话人标签 | 全局最优、事后可重排 | 必须**跨块保持一致**（同一人始终同一标签） |
| 典型精度 | 基准 SOTA（DER 低） | 天生更难：**流式 DER 通常比离线差 5–15 个百分点** |
| 已有实现 | `diar.py` + `pyannote/speaker-diarization-community-1`（复用 pyannote 镜像） | 需要**在线聚类 / 说话人缓存**机制，另起 mode |
| 场景 | 会议录音事后成纪要 | **实时会议字幕、直播、语音助手** |

结论：diar_stream 是**独立能力/独立 `MODEL_MODE`**，不是 diar 加个参数——在线一致性 + 恒定延迟是全新工程约束。

---

## 二、主流流式分离方案横评（只保留能"在线"的；纯离线的 pyannote 3.1/NeMo offline 已排除）

重点看：**流式精度（DER）**、**说话人上限/重叠处理**、**时间戳**、**许可**、**与我们平台范式契合度**（HF download-only + 复用镜像 + Blackwell GPU + 一能力一 app）。

| 方案 | 内核 | 流式精度 | 说话人/重叠 | 时间戳 | 许可 | 与平台契合 | 备注 |
|---|---|---|---|---|---|---|---|
| **NVIDIA Streaming Sortformer**（`nvidia/diar_streaming_sortformer_4spk-v2.1`） | **端到端模型**（Fast-Conformer/NEST + Transformer + Arrival-Order Speaker Cache），能力 100% 在权重 | **流式 SOTA**（DIHARD-III eval DER≈18.9；AOSC 保跨块一致） | **≤4 人**，端到端**重叠感知** | **帧级精确时间戳**（原生） | **NVIDIA Open Model License**（自定义"开放模型"许可，非 CC-BY；商用可但需读条款） | **中**：需 **NeMo 运行时** → **要新镜像**（不复用现有 pyannote 镜像）；HF 门控需 token；延迟可调 1.04s→30s，RTF 极低（0.002–0.093） | 官方定位就是"实时会议/呼叫中心/语音助手说话人识别"；英语最优，中文 meeting/非英 CALLHOME 也低 DER |
| **diart**（`juanmc2005/diart`，**MIT**）+ pyannote 模型 | **模型 + 算法框架**：pyannote `segmentation-3.0` + `embedding` 段级模型 + **增量聚类**（500ms 滚动缓冲） | 中：随对话进行渐准；起步几句标签可能抖动/重排 | 不定人数（聚类）；重叠靠 pyannote powerset 段级 | 段级（对齐到滚动缓冲） | MIT（底层 pyannote 模型 MIT，门控需接受 HF 条款——我们 diar 已在做） | **最佳**：**复用现有 diar.py 的 pyannote/torch 镜像**，`pip install diart` 即可；**自带 WebSocket 服务** | 官方 recipe 就是 diart + Whisper 出"说话人上色字幕"；建议 `pyannote.audio<3.1` 复现其指标——与我们 pyannote 4(community-1) 镜像有**版本张力**，需验证 |
| pyannoteAI Streaming API（`precision-2`，beta） | 托管服务（WS，emits speaker_start/stop 事件；可选加 whisper/parakeet 出说话人转写） | 高（商用托管） | ≤8 人 | 事件级 | **闭源 SaaS / 付费** | **差**：外部 API，违背"本地/自托管 + 下模型起引擎"范式 | 只作能力天花板参照，不作落地 |
| WhisperX + pyannote | 离线管线（Whisper 词级 + pyannote 段级对齐） | — | — | 词级（离线） | 各异 | 差：**纯离线**，不满足"流式" | 是**离线 stt+diar 融合**范本，其 `assign_word_speakers` 逻辑可复用到我们的融合层 |
| Deepgram Nova-3 / AssemblyAI / Soniox 流式 | 闭源 SaaS | 高 | 多 | 有 | 闭源付费 | 差：外部 API | 商用参照 |

> 行业基准（VexaScribe 2026-06 横评）佐证：**流式分离比离线难，DER 普遍差 5–15 点**；开源里 **diart（pyannote 系）** 与 **NeMo Sortformer** 是两条主线，Sortformer 端到端、重叠感知、在 AMI 上与 pyannote 竞争。

---

## 三、决策：首个范例模型 = **NVIDIA Streaming Sortformer（`diar_streaming_sortformer_4spk-v2.1`）**，diart 作为"零新镜像"备选

### 3.1 为什么主选 Sortformer（与 align 同一套判据）
1. **能力 100% 在模型里**（端到端）。我们做 align 时定的决定性判据就是"打标签的智能在模型里、而非库代码里"——Sortformer 是纯端到端模型（AOSC 保证跨块一致），diart 的一致性来自**外挂增量聚类算法**（属"半模型"，正如 align 里被降级的 CTC 系）。按我们自己的口径，Sortformer 是范式正解。
2. **流式精度 SOTA + 原生帧级精确时间戳**。会议纪要要的正是"谁在什么时间说"，精确时间戳还**直接解决与 stt_stream 融合的时间轴需求**（见 §4.2）。
3. **重叠感知 + 跨块标签稳定**（AOSC 按到达顺序编号），会议抢话场景更稳。
4. **官方定位精准命中**：NVIDIA 明说用于"实时转写/语音助手/会议分析的说话人识别"，且英/中 meeting 均低 DER。

**代价（如实说，需老板/用户拍板）**：
- **要新镜像**：Sortformer 是 `.nemo` checkpoint、`library_name: nemo`，须 **NeMo 运行时**——**打破我们"复用现成镜像"的省力路子**（前 8 个能力都靠复用）。要么用 `nvcr.io/nvidia/nemo` 大镜像、要么自建精简镜像并 mirror 到 `beclab/`。这是本能力最大的工程增量。
- **许可需复核**：**NVIDIA Open Model License**（非 CC-BY，也非 Apache）。一般允许商用，但有其条款，产品化前需读一遍确认无雷。
- **≤4 人**（v2.1）。多人会议（>4）超出上限；官方 roadmap 说要扩。

### 3.2 备选 diart：如果优先"零新镜像、最快落地"
- **复用现有 pyannote 镜像**（diar.py 那套），`pip install diart`，**自带 WebSocket**，MIT——边际成本几乎为零，和我们范式最贴。
- 代价：**"半模型"**（增量聚类是库代码）、流式 DER 偏高、起步标签可能抖动、且官方建议 `pyannote<3.1` 与我们 pyannote 4 镜像有版本张力（需实测能否在 community-1/4.x 上跑通，或单独装 <3.1 的分离栈）。
- 定位：**先跑通基础路径的最快选择**；若 Sortformer 的新镜像成本暂时不想付，可用 diart 先出 M2 的 diar_stream 雏形，后续再切 Sortformer。

> 建议：**主线走 Sortformer**（范式正、质量高、时间戳原生）；若本周要快速见效，**先用 diart 打通端到端 + 建 provider + 进 Demo**，再无缝替换为 Sortformer（对外 mode/接口不变）。

---

## 四、补充辨析（决定性依据）

### 4.1 diar_stream 是"独立能力"，融合是"编排层"
按老板"一能力一 mode / 接口归本源"，**diar_stream 本身只负责：音频流入 → 说话人转事件出**（`spk_id + start/end`，或帧级标签）。它**不内含转写**。把"说话人"和"文字"拼成「张三：…／李四：…」是**上层编排**（网关或客户端），不属于 diar_stream 能力本体。这样 scope 清晰：可**先独立做并验证 diar_stream**，融合作为后续。

### 4.2 融合的时间戳：**归消费层（DEMO/编排），基座不碰**（2026-07-02 定）
业界标准融合 = diar 段 + ASR 段**按时间戳重叠对齐**（WhisperX `assign_word_speakers`；pyannoteAI 也是先 diar 再和 ASR 时间戳对齐）。

**关键约束**：Qwen3-ASR **流式原生不出时间戳**（官方源码：*"Streaming ASR does NOT support timestamps"*；时间戳只在离线 `return_time_stamps=True` + `Qwen3-ForcedAligner` 或 Qwen Cloud `enable_words` 下有）。

**决策（遵循"接口归本源 / 能力在模型里"）**：**绝不**在基座 stt_stream 上凭空加一个官方没有的时间戳字段——否则用户直连该模型会看到"官方原生没有的怪字段"，破坏一致性。时间戳的派生**归消费层**：
- **基座 stt_stream**：只吐 Qwen 原生（累计文本 + language），保持本源。
- **基座 diar_stream**：Sortformer/diart 的说话人转**自带原生时间戳** → 留在基座（本源）。
- **DEMO/编排层**：它本就是**喂音频的一方**（文件按 `media.currentTime`、麦克风按实时），**自己握着音频时钟**；由它给收到的 ASR 文本派生段级时间戳，并把**同一条音频**同时喂给 stt_stream 与 diar_stream（都从 t=0 起，两条流时钟天然对齐），在此做时间重叠融合。派生时间戳是"应用便利"，不是"模型能力"。
- 精度：消费层派生为**段级近似**（流式前瞻 + 尾部可改窗 → 滞后约 1–2s）；要词级精确，消费层可对已定句调 **align**（已有能力），基座仍不变。

**落地拆解（修订）**：
1. **diar_stream 独立能力**：新 `MODEL_MODE=diar_stream`，WS 端点（入 PCM 流、出**原生带时间戳**的 speaker-turn 事件），Sortformer 或 diart 二选一。
2. **DEMO 派生 ASR 段时间戳**：demo 用自己的音频时钟给流式转写打段级时间（顺带可做"带时间码的字幕"这一独立展示价值）——**不改基座 stt_stream**。
3. **DEMO 融合**：按时间重叠合并 ASR 段 + diar 说话人转 → 说话人字幕（复用 WhisperX assign 逻辑）；词级精度可选 align 兜底。

### 4.3 接口设计（本源语义）
流式分离**无 OpenAI 标准端点**。参照 pyannoteAI 的事件流范式，拟新增 WS `GET /v1/audio/diarize/stream`：入 `start`(采样率) + 二进制 PCM 帧；出 JSON 事件 `{type: "speaker_turn", speaker: "spk_0", start, end}`（或帧级 `{t, active:[spk_0,...]}`）。语义 = Sortformer `forward_streaming_step` / diart online 输出。需老板就"接口归本源"口径确认（本源 = 官方流式推理 API）。

---

## 五、范例登记（拟写入 ROADMAP）
- 能力：`diar_stream` 流式说话人分离（音频流 → 实时说话人转事件）
- **首选范例（已定）**：`nvidia/diar_streaming_sortformer_4spk-v2.1`（端到端、重叠感知、帧级时间戳；≤4 人）
- **快速落地备选**：`diart`(MIT) + pyannote `segmentation-3.0`/`embedding`（**复用现有 pyannote 镜像**、自带 WS；半模型、DER 偏高、pyannote<3.1 版本张力）
- 驱动引擎：Sortformer→NeMo `SortformerEncLabelModel`；diart→`diart` 在线管线
- 归属里程碑：**M2（实时/流式）**——与 stt_stream 同场景，构成"实时会议字幕"闭环
- 依赖/后续：① **时间戳归 DEMO/编排层派生**（基座 stt_stream 保持本源、不动；diar 侧时间戳原生）；② 融合编排（demo 按时间重叠合并，复用 WhisperX assign 逻辑，词级可选 align 兜底）；③ Sortformer 许可（NVIDIA OML：可撤销+需兜底赔偿，逊于 diart 的 MIT）& 新镜像成本需拍板

---

## 七、落地记录（2026-07-02，骨架已进 chart）

### 7.1 镜像坐标（已发起转换）
- 源：`nvcr.io/nvidia/nemo:26.02`（NeMo Speech 仓库 README 钉的 speech 稳定版；多架构 arm64+amd64，压缩 ~23GB）
- 目标：`docker.io/beclab/nvidia-nemo:26.02`
- 这是全部能力里**唯一的新重镜像**——前 8 个都靠复用 pyannote/vLLM 轻镜像；Sortformer 是 `.nemo` checkpoint、`library_name: nemo`，无法复用，只能上 NeMo 运行时。

### 7.2 已写入的骨架（纯加法，不动既有能力/引擎自动选择）
- `templates/engine.yaml` `$engines` 加 `diar_stream` 项 → 映射到 `beclab/nvidia-nemo:26.02`，`/wrappers/diar_stream.py`，`/healthz`，首启把 `fastapi uvicorn websockets` 装进 `/pydeps`（torch+nemo.asr 镜像自带）。基于模型名自动选引擎的逻辑只对 `stt` 生效，未触碰。
- `templates/wrappers.yaml` 新增 `diar_stream.py`：WS `GET /v1/audio/diarize/stream`（start / PCM16LE / stop → ready/partial/final/error），载入用**离线 `restore_from` 缓存 `.nemo`**（回退 `from_pretrained`），按卡片 low-latency 预设配 `sortformer_modules`（chunk_len=6…，env `DIAR_*` 可覆盖）。
- `OlaresManifest.yaml` `MODEL_MODE` 枚举加 `diar_stream`（title「Diarize Stream…」）+ 示例 clone 集（`AUDIO_REQUIRED_GPU_MEMORY=6Gi`）。**repo 实测 `gated:false`（公开、不门控），无需 HF_TOKEN**（此前误判为门控，已更正）。CLONE 只传 5 个 UI 字段（title + MODEL_SOURCE/NAME/MODE + GPU_MEM），详见 SKILL RULE 2。
- `helm template/lint` 通过；`audiolabxv3-1.0.0.tgz` 已重打（未 commit，待指令）。

### 7.3 骨架的关键工程取舍
- **在线标签一致性靠"累积缓冲重跑 `.diarize()`"**：Sortformer 用到达顺序编号，对同一音频**前缀确定性** → 缓冲增长时 spk_0/1/… 不抖动。用的是卡片**公开稳定 API**，不依赖随版本变化的私有 `forward_streaming_step` 签名。代价：整段重算 O(n²)，但 RTF 极低（0.002–0.09），会议时长可接受；超长会话后续可加窗/roll 或切真增量 step API（引擎镜像可 introspect 后再定）。
- WS keepalive 关闭（同 stream.py）：突发离线推理 + 客户端配速，避免 1011 误杀健康会话。

### 7.4 尚未做（后续里程碑，不在本次骨架内）
1. **网关路由**：LLM Gateway 加 `diar_stream` mode + WS 转发 `/v1/audio/diarize/stream`（照抄 stt_stream 的 `ModeSTTStream`/dispatcher/WS 代理 + 计量）。
2. **DEMO 融合**：把 diar_stream 的说话人转（原生时间戳）与 stt_stream 文本（demo 派生时间码，已做）按时间重叠合并成"说话人字幕"；勾 `diar_stream` 时强制开时间码（前端 §已埋开关）。
3. **首启验证**：镜像转好后需在真机 introspect：`nemo.collections.asr.SortformerEncLabelModel` 存在性、`.diarize(numpy, sample_rate=)` 返回格式（本骨架 `_parse_segments` 已容错 str/tuple/obj 三形态）、repo 下载（公开，无需 token）。

---

## 六、来源
- **Streaming Sortformer**：arXiv 2507.18446《Streaming Sortformer: Speaker Cache-Based Online Speaker Diarization with Arrival-Time Ordering》；HF `nvidia/diar_streaming_sortformer_4spk-v2.1`（license: nvidia-open-model-license，library: nemo；DIHARD-III eval DER≈18.9）；NVIDIA 技术博客《Identify Speakers in Meetings, Calls, and Voice Apps in Real-Time with NVIDIA Streaming Sortformer》；NeMo `examples/voice_agent`（Sortformer + streaming ASR 联动，2026-01 更新到 v2.1）。
- **diart**：`github.com/juanmc2005/diart`（MIT，pyannote `segmentation`/`segmentation-3.0`/`embedding`，500ms 滚动缓冲增量聚类，自带 websocket，延迟 0.5–5s 可调）；Better Programming《Color Your Captions: diart + Whisper 实时说话人上色字幕》。
- **融合**：pyannoteAI《How to merge Diarization and STT results》（WhisperX `assign_word_speakers` 段级对齐）、《STT Orchestration》（precision-2 + parakeet/whisper）、《Streaming Diarization》（WS 事件流、≤8 人、5h 上限）。
- **横评/基准**：VexaScribe《Best Speaker Diarization Tools 2026》（流式 vs 离线 DER 差 5–15 点；开源两主线 diart / NeMo Sortformer）；`pyannote-audio` 3.1.1 PyPI（依赖矩阵）。
