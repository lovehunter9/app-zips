# audiolabxv3 · `align`（强制对齐）能力选型调研

> 调研日期：2026-06-30。
> 背景：老板的能力清单里有 **`align`**（强制对齐），而我们路线图早期自造了一个 `word_timestamps`。经核实二者**不是一回事**，本次决定：**彻底删除自造的 `word_timestamps`**，把 **`align` 正式提为独立能力（独立 `MODEL_MODE`）**，并全面横评后确定首个范例模型。

---

## 一、先厘清概念：`align` ≠ `word_timestamps`

| | `word_timestamps`（已删除的自造项） | `align` / 强制对齐（老板清单里的真能力） |
|---|---|---|
| 本质 | STT 的一个**输出特性**，不是独立模型 | 一类**独立能力 / 独立模型** |
| 输入 | 只有音频（就是 STT 自己） | **音频 + 一段给定文本** |
| 输出 | STT 对**自己转写结果**附带的词级时间（Whisper 内部 cross-attention/DTW 近似） | 把**任意给定文本**逐词/逐字精确对齐到音频 |
| 能否对齐「别人的文本」 | ❌ 只能标自己转的字 | ✅ 可对齐任意文本 |
| 处置 | **删除**（Whisper 自带词级时间戳作为 stt 的原生输出保留，不单列能力） | **提为独立 mode `align`** |

---

## 二、强制对齐主流模型/工具横评（不局限 Qwen）

数据来源见文末。重点看**精度（AAS/边界误差，越低越好）**、**语种覆盖（尤其中文）**、**许可**、**与我们平台范式契合度**（HF download-only + 复用镜像 + Blackwell GPU）。

| 方案 | 类型 | 精度 | 语种 | 许可 | 与我们平台契合 | 备注 |
|---|---|---|---|---|---|---|
| **Qwen3-ForcedAligner-0.6B** | LLM-based NAR（slot-filling 时间戳） | **最高**：MFA-Raw 平均 AAS **42.9ms**（中文 33.1ms），远低于 NFA 129.8 / WhisperX 133.2 / Monotonic 161.1；长音频(300s)优势更大 | 11 种（含中/英/粤/日/韩/法/德/意/葡/俄/西） | **Apache-2.0** ✅ | **最佳**：与已集成的 Qwen3-ASR 同族同工具包，**复用 vLLM cu129 镜像**，Blackwell 已验证 | 单段 ≤5min（长音频需分段）；词/句/段多粒度；流式 STT 不出时间戳，正好靠它补 |
| **Montreal Forced Aligner (MFA) 3.x** | HMM-GMM（传统） | 学术界**边界精度 SOTA**（WBE ~18ms） | 多（需逐语言声学模型+发音词典） | MIT（模型各异） | **差**：Kaldi/conda 生态，非 HF download-only，CPU、需按语言装词典，难塞进我们范式 | 精度标杆，但工程化代价高 |
| **ctc-forced-aligner（MMS-300M）** | wav2vec2 CTC | 中（WBE ~27ms） | **158 语种**（单模型） | ⚠️ **MMS 为 CC-BY-NC-4.0（非商用，需复核）** | 中：可复用 pyannote/torch 镜像 + pip 包 | 语种最广，但**NC 许可对产品是硬伤**；中文需先做词切分（字级可免） |
| **torchaudio MMS_FA / Wav2Vec2FABundle** | wav2vec2 CTC | 同上 | 同 MMS | ⚠️ 同 MMS（NC） | 中：torchaudio 原生 | 同上，NC 问题相同 |
| **NeMo Forced Aligner (NFA)** | CTC 副产物 | 较低（AAS ~130ms） | 14+（需逐语言 CTC 模型） | 各异 | 差：需 NeMo 运行时（新镜像）、仅 CTC 模型 | NeMo 生态内才划算 |
| **WhisperX aligner** | 按语言 wav2vec2 CTC | 西欧语尚可，**非西欧语严重退化**（韩语近乎失效） | 需逐语言切模型 | 各异 | 中：pipeline | 多语种弱、要切模型，淘汰 |
| **Seamless（Meta）对齐** | NAR T2U + 时长预测 | 独立横评**整体最稳**（9 语 6 胜） | 固定 38 语 | ⚠️ 许可需复核 | 较重：SeamlessM4T 体量大 | 强力候选，但集成更重 |

> 独立第三方横评（iyakovlev, 2026-04）补充：Seamless 整体最稳；Qwen3-ForcedAligner 在西欧语稳居第 2，但**韩/日因形态切分偏弱、且只支持 11 语**；WhisperX 出西欧语即崩。

---

## 三、决策：首个范例模型 = **`Qwen/Qwen3-ForcedAligner-0.6B`**

理由（按权重）：
1. **精度最高，且中文最佳**（33.1ms）。我们的首要场景是会议转录，中/英为主 → 正中靶心。
2. **许可干净（Apache-2.0）**。MMS 系（ctc-forced-aligner / torchaudio MMS_FA）是 **CC-BY-NC**，产品化受限，直接出局首选。
3. **零新镜像、最低边际成本**：它是已集成 Qwen3-ASR 家族的一员，**复用现有 `beclab/vllm-vllm-openai:v0.23.0-cu129`**，`pip install qwen-asr`（可选 flash-attn 提速对齐器），Blackwell 已验证。
4. **完美契合「一能力一 app / 接口归本源」**：独立 0.6B 模型 → 独立 `MODEL_MODE=align` 实例；对外语义照搬官方工具包 `Qwen3ForcedAligner.align(audio, text, language)`。
5. **正是之前 Demo 反复纠结的「第二个模型」的官方 AI 解**：Qwen STT（整段/流式）不出时间戳，过去在 Demo 里用 ffmpeg silencedetect 等非 AI 手段硬凑；`align` 就是把它做对的标准答案，且本就该是独立 app。

**已知取舍 / 待办**：
- 单段 ≤5min → 长会议音频需**分段对齐**（沿用我们既有分块范式）。
- 仅 11 语 → 语种更广的需求留作**下一个范例**：优先考虑 **MFA**（精度，但工程重）或 **Seamless**（多语种），**避开 NC 许可的 MMS 系**用于商用。
- 对外接口：强制对齐**业界无 OpenAI 标准端点**（WhisperX 等也是自定义）。拟新增 `/v1/align`（入参 audio+text+language → 出 words/chars 带 start/end），语义=官方 `.align()`。需老板就「接口归本源」口径拍一下板（本源即官方工具包 `.align()`）。

**范例登记（写入 ROADMAP）**：
- 能力：`align` 强制对齐（音频+文本 → 词/字级时间）
- 范例模型：`Qwen/Qwen3-ForcedAligner-0.6B`（Apache-2.0）
- 驱动引擎：qwen-asr 工具包（NAR 对齐），`/wrappers/align.py`，**复用 vLLM cu129 镜像**
- 归属里程碑：**M1（会议转录）**——精确时间轴是会议纪要刚需
- 下一个范例：MFA（精度 SOTA）· Seamless（多语种）；MMS/ctc-forced-aligner 因 NC 许可仅作非商用备选

---

## 四、补充辨析（决定性依据，2026-06-30）

### 4.1 `align` 语义是否一定是「强制对齐」？——多义，但按「单模型」一筛即收敛
`align` 在语音 ML 里是多义词。把候选含义按「能否由单模型端到端完成」（我们大方案只关心模型）筛选：

| 含义 | 能否单模型 | 范例单模型 | 接口（本源语义） | 处置 |
|---|---|---|---|---|
| **A. 强制对齐**（音频+文本→时间戳） | ✅ 最干净 | `Qwen/Qwen3-ForcedAligner-0.6B` | `align(audio,text,lang)→[{text,start,end}]` | **首发** |
| B-1. 口型/音驱视频（lip-sync） | ✅ | Wav2Lip / LatentSync / MuseTalk | `align(audio, video|image)→video` | 属数字人(M4)，后续候选 |
| B-2. 配音时长对齐(isochrony) | ❌ 管线非单模型 | — | — | 被「只关心模型」筛掉 |
| C. 跨模态音文对齐(CLAP) | ✅ | laion-CLAP / MS-CLAP | `embed(audio)/embed(text)→同空间向量` | 与现有 `embed` 重叠 |
| D. 文本词对齐 | ✅ | awesome-align(mBERT) | `align(src,tgt)→词对` | 纯文本，贴 `translate` |
| E. 模型对齐(RLHF) | — | — | — | 非音频能力，排除 |

结论：即便不纠结确切定义，用「单模型」一筛，**首发仍落在 A=强制对齐=Qwen3-ForcedAligner**；B-1/C/D 作为同 mode 下「按接口区分」的后续候选登记。**当前按 A 推进，待老板有空再确认口径（若为 B-1 等，模型/接口/里程碑会变）。**

### 4.2 内核 = 纯模型 vs 模型+外挂算法（强化选型）
强制对齐 = 声学模型(出概率) + 对齐算法(把概率变时间戳)。差别在「打时间戳的智能」在模型里还是库代码里：

| 方案 | 内核 | 时间戳来源 | 纯模型? |
|---|---|---|---|
| **Qwen3-ForcedAligner** | **端到端模型**(LLM NAR 直接预测时间戳) | **模型自己吐** | ✅ 唯一 |
| ctc-forced-aligner / torchaudio MMS / WhisperX / NFA | wav2vec2/CTC 声学模型 + **CTC Viterbi 算法** | 库里的算法 | ⚠️ 半模型 |
| MFA | HMM-GMM + 发音词典（非神经网络） | 经典 Viterbi | ❌ 非模型 |

我们范式是「下载模型+起官方引擎，能力在模型里」。只有 Qwen3-ForcedAligner 把对齐智能 100% 封装在权重内（`.align()` 直接出 `{text,start,end}`），**不需我们维护任何对齐算法资产**——这是「只关心模型」下的决定性优势。

## 五、来源
- 综述与基准：arXiv 2606.18466《MFA and the state of speech-to-text alignment in 2026》；`lifeiteng/Aligner-SUPERB`（UBE/WBE 基准）；iyakovlev.dev 2026-04-07《We benchmarked 4 neural forced aligners》（Seamless/WhisperX/Qwen3/Cloud 横评）。
- Qwen3-ForcedAligner：`github.com/QwenLM/Qwen3-ASR`（README 含 Forced Alignment Benchmarks 表 + ForcedAligner Usage）；Qwen3-ASR Technical Report (arXiv 2601.21337)；Alibaba Cloud 博客《Qwen3-ASR & Qwen3-ForcedAligner Now Open Sourced》；HF `Qwen/Qwen3-ForcedAligner-0.6B`（Apache-2.0）。
- MMS / CTC 系：`pytorch/audio` MMS_FA 教程（torchaudio.pipelines.MMS_FA）；`ctc-forced-aligner` / `mms-300m-1130-forced-aligner`（158 语，CC-BY-NC 待复核）。
- NFA：NVIDIA NeMo Forced Aligner 文档（仅 CTC/Hybrid-CTC 模型）。
- 其它范式：LLM-ForcedAligner (arXiv 2601.18220)。
