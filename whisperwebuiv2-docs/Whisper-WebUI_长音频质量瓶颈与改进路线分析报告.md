# Whisper-WebUI 长音频质量瓶颈与改进路线分析报告

> 部署目标：Helm Chart `whisperwebuiv2`（本开发版，**尚未发布到 Olares 商店**）  
> 上游基础镜像：`beclab/harveyff-whisper-webui:v1.0.7`  
> 写作动机：基线版本下，即便经过 15 轮参数测试 + 引擎级 Monkey-Patch + LLM 后处理校对实验，30 分钟以上的长音频质量仍然在后程明显劣化（中英文均出现循环、碎片化、漂移）。本报告论证这是 Whisper 架构层面的天花板，并给出短期改造（方向 A）与长期路线（方向 B）。方向 A 已在本开发版中落地并完成 6 轮中英对照实测，详见 §3.9。
>
> **§3.9 实测落地与结果验证**：方向 A 已在本开发版中以 `BatchedInferencePipeline` 落地，64 min 英文 Buffered → Batched 加速 4.57×，且根治了跨语言污染、整段编造、段内重复、单词丢失四类引擎层崩坏。
>
> **API 层扩展的上下文说明**：本开发版同时包含 API 全量开放（端点从基线的 4 个扩到 11 个、翻译端点参数对齐转录），但这部分**不修改任何长音频处理逻辑**，本报告的所有理论分析、实测数据、改进路线结论均保持不变。新增的 API 端点（`/v1/audio/transcriptions/youtube`、`/v1/audio/translations` 等）通过共享的 `_do_transcribe` 入口走同一条 Batched 路径，§3.9 的实测加速比与质量结论直接迁移。
>
> **版本说明**：本文仅涉及两个状态——
> - **基线版本**：Olares 商店当前上线的 `whisperwebuiv2 v1.0.7`（本开发版改造的起点，仅含 Whisper-WebUI 上游原生能力）  
> - **本开发版**：在基线之上叠加方向 A 的 `BatchedInferencePipeline` 与配套基础设施修复，**当前仅在开发/测试环境，未发版到商店**  
>
> 文中所有"基线 → 本开发版"的对比都指这两个状态间的差异；改造过程中的内部迭代不作为独立版本呈现，**`v1.0.7` 是本文唯一会提及的版本号**。

---

## 目录

- [一、问题陈述与动机](#一问题陈述与动机)
- [二、商业会议转写 vs Whisper：原理对比分析](#二商业会议转写-vs-whisper原理对比分析)
- [三、方向 A：WhisperX 风格 VAD Cut & Merge 改造（短期）](#三方向-awhisperx-风格-vad-cut--merge-改造短期)
  - [3.1 ~ 3.8 — 理论分析与改造路线](#31-当前-vad-配置-vs-whisperx-的本质差异)
  - [3.9 — 实测落地与结果验证](#39-实测落地与结果验证)
    - [3.9.1 ~ 3.9.6 — 主体实测](#391-实施工作量复盘-vs-36-预估)
    - [3.9.7 ~ 3.9.8 — 收尾验证](#397-短音频对照实测与中等长音频复测)
- [四、方向 B：多引擎应用（长期路线）](#四方向-b多引擎应用长期路线)
- [五、结论与后续可探索的方向](#五结论与后续可探索的方向)
- [六、参考链接](#六参考链接)

---

## 一、问题陈述与动机

### 1.1 已观察到的现象

在 15 轮参数测试与引擎级 Monkey-Patch（温度回退 + 自动 Initial Prompt + Text Cleaning + Segment Merging）全部落地后，**30 分钟以上长音频的后程仍然质量明显劣化**：

| 现象 | 出现位置 | 测试编号 |
|---|---|---|
| 中文重复循环（"眼睛一看 ×36+"）| 流浪地球音频末尾 | #2、#3 |
| 英文重复循环（"of the murder ×N"）| 福尔摩斯长音频段内 | #8 |
| 后程 segment 渐进碎片化 | 多轮英文测试后半段 | #7、#14、#15 |
| 后程标点全部丢失 | 英文长音频 30 分钟后 | #7 |
| 中英文最佳参数互斥 | 全部测试 | #4 中文 vs #10 英文 |

### 1.2 已验证无效的路径

- **纯参数调优**：15 轮测试穷举 `condition_on_previous_text` × `temperature` × `repetition_penalty` × `no_repeat_ngram_size` × `initial_prompt` 组合，结论是**不存在中英文通吃的单一参数组合**
- **LLM 后处理校对（Qwen2.5-3B）**：实测中文 11× 耗时 + 5+ 事实幻觉、英文 8.6× 耗时 + 30+ 处元评论泄漏，改造过程中已撤回并删除相关代码

### 1.3 本报告要回答的问题

1. 市面上做会议记录转写的产品（飞书妙记、阿里通义听悟、Otter.ai、Microsoft Teams、AssemblyAI 等）能做几小时录音 + 嘈杂环境 + 多人分离 + 自动纪要，**他们是怎么做到的**？
2. **Whisper 做不到这一点的难点在哪里**？这是工程问题还是架构问题？
3. 在不更换底层 ASR 模型的前提下，**有没有短期可落地的改造**能缓解长音频后程崩坏？
4. 如果要彻底逼近商业方案，**长期路线**应该怎么走？

---

## 二、商业会议转写 vs Whisper：原理对比分析

### 2.1 一句话总结

> 商业产品能做几小时录音 + 嘈杂环境 + 多人分离 + 自动纪要，**不是单靠"更好的 ASR 模型"**，而是一套端到端的工程系统：前端音频处理（多麦/降噪/AEC）+ 流式声学模型（Conformer/RNN-T/Fast Conformer）+ 独立的说话人分离模块（EEND/ECAPA-TDNN）+ 后处理与 LLM 摘要。
> 
> Whisper 是其中只覆盖"中间一段"的研究级模型，它的架构选择（30 秒固定窗、非因果编码器、attention-based AED + 缓冲转写）在出场设计时就**没打算覆盖**真正的长音频与实时场景。

### 2.2 Whisper 长音频失败的架构根因

#### 2.2.1 固定 30 秒窗口是硬约束

Whisper 原始论文明确写道：所有训练样本都被切成 30 秒，转成 80 通道 log-Mel 谱图（3000 帧 × 80），输入是固定 padding 到 30s 的张量。这不是实现细节，而是模型权重学到的输入形状。

> "All audio is re-sampled to 16,000 Hz, and an 80-channel log-magnitude Mel spectrogram representation is computed on 25-millisecond windows with a stride of 10 milliseconds"  
> —— [Radford et al., 2022, §2.2](https://cdn.openai.com/papers/whisper.pdf)

参考：
- ICML 2023 proceedings：[Radford et al., ICML 2023](https://proceedings.mlr.press/v202/radford23a/radford23a.pdf)
- arXiv：[arXiv:2212.04356](https://arxiv.org/pdf/2212.04356)
- 实现常量（硬编码）：[`whisper/audio.py`](https://github.com/openai/whisper/blob/main/whisper/audio.py) 里 `CHUNK_LENGTH = 30`、`N_SAMPLES = 480000`、`N_FRAMES = 3000`

#### 2.2.2 处理超过 30 秒只能"缓冲转写"，必然漂移

WhisperX 论文（Bain et al., INTERSPEECH 2023）直接点出了这一点：

> "Automatic Speech Recognition (ASR) models are typically trained on short audio segments (**30 seconds** for the case of Whisper) and the transformer architectures **prohibit transcription of arbitrarily long input audio due to memory constraints**. ... Whisper proposes a buffered transcription approach that relies on accurate timestamp prediction to determine the amount to shift the subsequent input window by. **Such a method is prone to severe drifting since timestamp inaccuracies in one window can accumulate to subsequent windows.**"  
> —— [arXiv:2303.00747 §1](https://arxiv.org/html/2303.00747)

这是项目"中文长音频后半段越来越烂、英文长段开始循环"的根因：每个 30 s 块的时间戳错一点点，错误会累积传播到后续所有窗口。

#### 2.2.3 三种典型故障模式

社区把 Whisper 长音频故障归纳成三类，且在论文里正式列出：

- **silence-region hallucination**（静音区幻觉，凭空捏造文字）
- **repetition loops**（重复循环，跨段边界持续）
- **content skips**（内容跳过）

参考：
- Whisper-CD 训练-free contrastive decoding 论文 [arXiv:2603.06193](https://www.arxiv.org/pdf/2603.06193)
- OpenAI 官方仓库讨论 [Discussion #679](https://github.com/openai/whisper/discussions/679)：直接讨论了 `condition_on_previous_text=True` 在长上下文里把错误传播下去的问题

这三种模式与项目内部 15 轮测试中观察到的现象**精确对应**。

#### 2.2.4 非因果编码器决定了"原生不能流式"

> "Its **non-causal encoder fundamentally constrains streaming capability**—it was not designed for streaming inference."  
> —— WhisperRT 论文 [arXiv:2508.12301](https://arxiv.org/html/2508.12301v2)

Whisper 的编码器对完整 30 秒做双向 self-attention，每一帧都"看到了未来"。这意味着真正的低延迟实时转写（< 1 秒）在不改架构的前提下做不到。要让 Whisper 流式化，必须改编码器或加两遍解码（[Adapting Whisper for Streaming, arXiv:2506.12154](https://arxiv.org/html/2506.12154v1)）。

#### 2.2.5 Encoder-Decoder（AED）vs Transducer（RNN-T/TDT）的本质差异

商业流式 ASR 几乎清一色用 RNN-T 或其变体（TDT），而不是 Whisper 这种 attention encoder-decoder：

- **RNN-T** 由 encoder + prediction network（充当内置语言模型）+ joint network 组成，**单调对齐**保证可以一个一个 token 增量输出，天然适合流式
- **AED** 默认不能流式，要靠 monotonic chunkwise attention 等改造才能近似流式

参考：[Streaming ASR 架构对比综述](https://transcriber.talkflowai.com/blog/voice-ai-deep-dive-streaming-asr-ctc-rnnt-attention)；[Li et al., A Comparison of End-to-End Models, arXiv:2005.14327](https://arxiv.org/pdf/2005.14327)

这是为什么 AssemblyAI 的 Universal-1/2 选了 RNN-T、NVIDIA Parakeet 选了 TDT —— 两者都是为长音频和流式优化的。

### 2.3 商业方案的四层流水线

会议转写不是一个模型，而是一条流水线：

```
[音频前端]        →  [ASR 声学模型]      →  [说话人分离]       →  [文本后处理/纪要]
 降噪/AEC            Conformer-RNN-T        EEND/ECAPA            Punctuation + LLM
 多麦阵列            长窗 + 流式            聚类/重叠检测          ITN + 摘要
```

#### 2.3.1 第一层：音频前端 —— Whisper 完全没有，商业产品花了大力气

**Microsoft Teams** 公开披露的会议音频管道里有四件事是 Whisper 完全没有的：

1. **AI 回声消除（AEC）**：神经网络模型代替传统 DSP 处理非线性失真
2. **去混响（De-reverberation）**：ML 模型把远场录音变成像近距离麦克风的效果
3. **全双工**：用约 30,000 小时语音训练，允许同时说同时听
4. **噪声抑制 + 回声合并模型**：比纯噪声抑制快 10%

参考：[Microsoft 365 Blog: How Microsoft Teams uses AI/ML to improve calls](https://www.microsoft.com/en-us/microsoft-365/blog/2022/06/13/how-microsoft-teams-uses-ai-and-machine-learning-to-improve-calls-and-meetings/)；[Microsoft Learn: Model-based echo cancellation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/audio-processing-model-based-echo-cancellation)

**多麦克风 beamforming** 也是会议室"嘈杂中精准识别"的关键。MSR 论文证明用多个异步分布式麦克风 + 盲波束成形能显著降低 WER：

- [Meeting Transcription Using Asynchronous Distant Microphones](https://www.microsoft.com/en-us/research/publication/meeting-transcription-using-asynchronous-distant-microphones/)
- ADL-MVDR 神经波束成形：[arXiv:2110.06428](http://arxiv.org/pdf/2110.06428v1)

开源对应物（单麦场景也能用）有：

- **DeepFilterNet3**：2.1M 参数、笔记本单核 CPU RTF 0.19、延迟 < 20 ms、48 kHz 全带宽。架构是 ERB 解码器 + 5-tap 复数滤波，比 RNNoise 泛化更好。[Interspeech 2023 论文](https://www.isca-archive.org/interspeech_2023/schroter23b_interspeech.pdf)；[GitHub](https://github.com/Rikorose/DeepFilterNet)
- **RNNoise**：CNN+RNN 混合，更轻量。[xiph/rnnoise](https://github.com/xiph/rnnoise)

> **结论**：商业产品在 ASR 之前已经把音频"洗干净"了；Whisper 拿到的输入是用户的原始音频，所以会议室那种回声 + 多人交叠 + 远场，它从一开始就吃亏。

#### 2.3.2 第二层：声学模型 —— 长窗 + 流式 + 噪声鲁棒

商业系统的核心模型分三类，都不是 Whisper 这种 30 s AED：

**(a) AssemblyAI Universal-1 / Universal-2（Otter.ai 等产品的同代竞品）**

- **架构**：600M 参数 Conformer + RNN-T 解码器
- **训练数据**：Universal-1 用 12.5M 小时多语音频；Conformer-2 用 1.1M 小时
- **关键设计**：把"转写"和"格式化"拆成两个模型，避免 Whisper 那种"模型既要转写又要标点还要补大小写"的混合负担
  - ASR 输出 spoken form
  - 独立的 Universal-2-TF（multi-objective token classifier + seq2seq）做 punctuation restoration、truecasing、inverse text normalization

参考：[Conformer-1](https://assemblyai.com/research/conformer-1)；[Conformer-2](https://assemblyai.com/research/conformer-2)；[Universal-1](https://assemblyai.com/research/universal-1)；[Universal-2-TF](https://assemblyai.com/research/universal-2)；[arXiv:2501.05948](https://arxiv.org/html/2501.05948v1)

**(b) NVIDIA Parakeet TDT（开源里目前最强的长音频/英文方案）**

- **架构**：FastConformer encoder + TDT（Token-and-Duration Transducer）decoder
- **长音频能力**：
  - v2 (0.6B)：单次前向 24 分钟音频（用 full attention 训练）
  - v3 (0.6B)：local attention 模式下支持 3 小时音频，25 种欧洲语言
- **吞吐量**：1 分钟音频约 1 秒处理完；HF-Open-ASR leaderboard RTFx = 3380（batch=128），排名第一
- **噪声鲁棒**：v3 在 clean 条件 WER 6.34%，0 dB SNR 仍能保持 11.66% WER

参考：[parakeet-tdt-0.6b-v2 模型卡](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)；[parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)；[Canary-1B-v2 & Parakeet-TDT-0.6B-v3 论文 arXiv:2509.14128](https://arxiv.org/pdf/2509.14128)

**(c) FunAudio-ASR（阿里通义听悟底层方案）**

国内会议转写最值得对照的近期论文。架构和 Whisper 完全不是一个东西：

> "FunAudio-ASR comprises four key components: (1) an audio encoder ... (2) an audio adaptor ... (3) **a CTC decoder** that is built upon the audio encoder to obtain the initial recognition hypothesis ... and (4) **an LLM-based decoder** that produces output based on the audio condition and CTC prediction."  
> —— [FunAudio-ASR Technical Report, arXiv:2509.12508 §2](https://arxiv.org/html/2509.12508v1)

关键工程细节：
- **数据规模**：预训练数据是"tens of millions of hours"（数千万小时），Whisper 是 68 万小时
- **长音频专项 RL 训练**：明确把 "Long-duration Samples"（> 20s）作为 GRPO 强化学习的独立子集
- **幻觉专项 RL**：另开一个"Hallucination-related Samples"子集
- **流式仿真训练数据**：把离线数据切成 chunk 模拟流式

阿里通义听悟产品级能力：单文件最长 12 小时 / 2 GB；并发上百路实时转写；支持说话人分离、敏感词过滤、word-level 时间戳、热词。

参考：[Alibaba Cloud: Audio Transcription with FunASR and Paraformer](https://www.alibabacloud.com/help/en/model-studio/recording-file-recognition)；[实时会议转写 API](https://help.aliyun.com/zh/tingwu/api-tingwu-2022-09-30-dir-real-time-meeting-transcription/)；[FunASR GitHub](https://github.com/alibaba-damo-academy/FunASR)

#### 2.3.3 第三层：说话人分离（Speaker Diarization）—— Whisper 完全没有

Whisper 完全不输出说话人。所有 "Whisper + 说话人" 方案都是外挂一个独立模型。

**主流技术路线**：

**(a) 嵌入 + 聚类（pyannote.audio / WhisperX 走的路线）**

- 用 x-vector 或 ECAPA-TDNN 提取每个语音帧的说话人嵌入向量
- ECAPA-TDNN 引入 channel/context-dependent attention、MFA 多层特征聚合、SE block，是当前说话人验证/分离 SOTA 嵌入
- 然后做聚类（AHC / spectral clustering）把帧聚到说话人

参考：[ECAPA-TDNN 在 diarization 应用 arXiv:2104.01466](https://arxiv.org/pdf/2104.01466)；[pyannote.audio 工具包论文 arXiv:1911.01255](https://arxiv.org/pdf/1911.01255)

**(b) 端到端神经分离（EEND）**

- 直接把分离当作 multi-label 分类，每帧每个说话人输出 0/1
- 原生支持 overlapping speech（多人同时说），用 permutation-free 目标函数避免标签置换问题

参考：[End-to-End Neural Speaker Diarization with Self-Attention, arXiv:2003.02966](https://arxiv.org/pdf/2003.02966)；[Hitachi EEND 开源](https://github.com/hitachi-speech/eend)

**(c) WhisperX 的 ASR + 分离拼接**

WhisperX 用 IntervalTree 做时间戳 → 说话人段的快速查找，对长音频内容可以做到 228× 加速。参考：[WhisperX 源码 diarize.py](https://github.com/m-bain/whisperX/blob/main/whisperx/diarize.py)

**(d) Otter.ai 的"软监督"模式**

> "Once you tag a speaker, Otter learns to recognize that voice in future conversations, reducing future tagging needs"  
> —— [Otter Speaker Identification Overview](https://help.otter.ai/hc/en-us/articles/21665587209367-Speaker-Identification-Overview)

用户每次手工标注会丰富一个跨会议的声纹库，本质上和 ECAPA-TDNN 说话人嵌入比对是一回事，只是把"无监督聚类"换成"半监督匹配"。

#### 2.3.4 第四层：后处理 / 纪要生成

这是 Whisper 完全没碰的：

- **AssemblyAI Universal-2-TF**：独立的 punctuation + truecasing + ITN 神经模型。[arXiv:2501.05948](https://arxiv.org/html/2501.05948v1)
- **飞书妙记**：从逐字转写升级为结构化纪要，自动提取核心结论、议程模块、关键人物、待办事项。底层是字节自有 AI 语音识别 + LLM。[飞书妙记产品页](https://www.feishu.cn/product/minutes)；[飞书官方介绍文章](https://www.feishu.cn/content/article/7589151449137827010)
- **讯飞听见**：宣传准确率 98%、说话人区分准确率 92%。[腾讯云开发者社区分析](https://cloud.tencent.cn/developer/article/2560595)

### 2.4 为什么这些事 Whisper 做不到（核心差异表）

| 维度 | 商业方案怎么做 | Whisper 的局限 | 证据 |
|---|---|---|---|
| 单次窗口长度 | Parakeet v2 训练时支持 24 min full attention；v3 支持 3 h local attention | 30 s 固定窗，硬编码在 `audio.py` | [Parakeet 模型卡](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)；[whisper/audio.py](https://github.com/openai/whisper/blob/main/whisper/audio.py) |
| 跨窗一致性 | RNN-T/TDT 用单调对齐 + prediction network 内置 LM，跨窗无漂移 | "Buffered transcription" 依赖时间戳预测，错误累积 | [WhisperX §1](https://arxiv.org/html/2303.00747) |
| 流式 | Universal-2 RNN-T 原生流式；FunAudio-ASR 专门做 streaming training | 非因果 encoder，原生不能流式 | [WhisperRT arXiv:2508.12301](https://arxiv.org/html/2508.12301v2) |
| 噪声鲁棒 | 前端 AEC/降噪/beamforming + 训练数据加噪 | 训练数据靠"网络弱监督"，没有显式噪声增强 | [Conformer-2](https://assemblyai.com/research/conformer-2)；[Microsoft Teams audio AI](https://www.microsoft.com/en-us/microsoft-365/blog/2022/06/13/how-microsoft-teams-uses-ai-and-machine-learning-to-improve-calls-and-meetings/) |
| 说话人分离 | 外挂 EEND/ECAPA-TDNN/pyannote | 完全不输出说话人 | [WhisperX diarize.py](https://github.com/m-bain/whisperX/blob/main/whisperx/diarize.py) |
| 训练数据量 | FunAudio-ASR "tens of millions of hours"；Universal-1 12.5M 小时 | 680K 小时 | [FunAudio §3.1](https://arxiv.org/html/2509.12508v1)；[Universal-1](https://assemblyai.com/research/universal-1) |
| 幻觉抑制 | FunAudio 专项 RL 子集 + Universal-2 独立格式化模型 | 默认 `condition_on_previous_text=True` 会传播错误 | [FunAudio §4.4.2](https://arxiv.org/html/2509.12508v1)；[OpenAI Discussion #679](https://github.com/openai/whisper/discussions/679) |
| 摘要 | LLM + 结构化模板 | 完全没有 | [飞书妙记产品页](https://www.feishu.cn/product/minutes) |

### 2.5 商业产品技术披露对照表

| 产品 | 公开的底层 ASR | 长音频策略 | 说话人 | 降噪 | 纪要 |
|---|---|---|---|---|---|
| AssemblyAI / 多数 SaaS | Universal-2 (Conformer + RNN-T, 600M) | RNN-T 流式 + 独立格式化 | 自有 diarization | Conformer-2 噪声增强 | — |
| NVIDIA Parakeet TDT v3 | FastConformer + TDT (0.6B) | local attention 3 h | 不带 | 训练加噪 | — |
| 阿里通义听悟 / FunAudio-ASR | Audio Encoder + LLM Decoder (7B / 0.8B) | streaming-aware + RL 长样本 | 自有 | 多阶段噪声鲁棒训练 | LLM 摘要 |
| 微软 Teams + Azure Speech | 自研 + 服务端 + Phi-4-Multimodal | 服务端缓冲 + 多麦阵列 | 自有 | AI AEC + de-reverb + full-duplex | Copilot 摘要 |
| Otter.ai | 未公开（疑似 AssemblyAI 系或自研） | 服务端缓冲 | 半监督声纹库 | 未公开 | 自有摘要 |
| 飞书妙记 | 未公开学术论文（字节自有） | 服务端 | 多人对话分离 | 未公开 | LLM 结构化纪要 |
| WhisperX（开源拼装） | Whisper + pyannote | VAD Cut & Merge → 30s chunks | pyannote | 不带 | 不带 |

### 2.6 Open ASR Leaderboard 的客观数据点（2025-11）

> "**Long-form: Closed-source systems still lead (for now 😉)**"
> 
> "Among open models, OpenAI's Whisper Large v3 performs the best. But for throughput, CTC-based Conformers shine. For example, NVIDIA's Parakeet CTC 1.1B achieves an RTFx of 2793.75, compared to 68.56 for Whisper Large v3, with only a moderate WER degradation (6.68 and 6.43 respectively)."  
> —— [Open ASR Leaderboard blog, Nov 21 2025](https://huggingface.co/blog/open-asr-leaderboard)

ElevenLabs Scribe v1 在长音频 WER 4.33%，RevAI Fusion 5.04%，均为闭源商业系统。参考：[The Decoder: Open ASR Leaderboard tests 60+ models](https://the-decoder.com/open-asr-leaderboard-tests-more-than-60-speech-recognition-models-for-accuracy-and-speed/)

### 2.7 对当前项目的实际启示

1. **当前所用的 faster-whisper 仍然是 Whisper-large-v3 的权重**，30 s 窗 + 缓冲转写的根本限制无法绕开。15 轮测试看到的"后段碎片化、重复循环、漂移"和 WhisperX 论文 §1 描述的现象完全一致。

2. **`condition_on_previous_text=False` 是治标**：能阻止跨窗错误传播，但代价是丢失上下文连贯性（标点跟读、代词指代）—— 这正是 05-12 测试里观察到的中英文不可调和矛盾的来源。

3. **要逼近商业方案的长音频质量，开源路径只剩三条**（不是参数调优能解决的）：
   - 换模型：英文 → Parakeet TDT v3；中文 → FunASR / Qwen3-ASR
   - 换流水线：保留 Whisper 但前置 WhisperX 的 VAD Cut & Merge
   - 前端音频增强：加 DeepFilterNet3 作为 pre-processor

4. **LLM 校对路线为什么彻底走死了**：FunAudio-ASR 论文 §1 也提到 "LLMs are prone to hallucination, which can significantly degrade user experience"。阿里的解法是联合训练 + RL 专项幻觉子集，**不是把 LLM 当后处理外挂**。项目用 Qwen2.5-3B 做事后校对就是踩了这个坑——3B 没见过 ASR 错误的分布，纯文本视角看不懂 Whisper 错在哪。

---

## 三、方向 A：WhisperX 风格 VAD Cut & Merge 改造（短期）

### 3.1 当前 VAD 配置 vs WhisperX 的本质差异

项目目前用的是 faster-whisper 内置的 Silero VAD（`vad_filter=True` + `min_silence_duration_ms=500` + `speech_pad_ms=400`）。它的工作方式：

```
原音频 → Silero VAD 标记静音段 → 跳过静音区
       → 剩下部分仍然喂给 Whisper 的 buffered transcription
         （30s 滑窗 + 时间戳推断下一窗位置）
```

**问题**：这只是"省去无意义的静音处理"，没有解决长音频的核心病——即论文里说的 "buffered transcription 依赖时间戳预测，错误会累积漂移"。30 分钟以上的后程崩坏，根因就在这里。

WhisperX 的 VAD Cut & Merge 是根本不同的策略：

```
原音频 → pyannote VAD 给出"语音活动概率曲线"
       → 在概率最低的位置做 min-cut 切片（保证不会切到说话中间）
       → 合并相邻短片段，让每片≈30s 但不超过 30s
       → 这些独立片段并行 batch 喂给 Whisper（强制 condition_on_previous_text=False）
       → 拼接结果
```

关键差异：

| 维度 | faster-whisper VAD filter（现状） | WhisperX VAD Cut & Merge |
|---|---|---|
| VAD 模型 | Silero | pyannote（默认）/ Silero（PR #888 支持） |
| 切片策略 | 跳过静音区 | 在静音最深处主动切，强制片长接近 30s |
| 跨片依赖 | 仍依赖 buffered transcription + 时间戳推断 | **完全独立**，每片单独跑 |
| `condition_on_previous_text` | 用户参数 | **强制 False**（无 inter-chunk 上下文，因此无漂移） |
| 并行性 | 顺序处理 | 可 batch 并行（论文报告 12 倍加速） |

参考：[WhisperX 论文 §2.1-2.3, arXiv:2303.00747](https://arxiv.org/html/2303.00747)；[faster-whisper Issue #477 - VAD 默认参数分析](https://github.com/SYSTRAN/faster-whisper/issues/477)

### 3.2 WhisperX 实测数据（论文 Table 2/3）

WhisperX 论文在 TED-LIUM（11 个 TED 演讲，每个约 20 分钟）和 Kincaid46（YouTube 视频集）上的实测：

| 模型 | TED-LIUM WER↓ | TED-LIUM 5-gram 重复数↓ | Kincaid46 WER↓ | Kincaid46 5-Dup↓ | 速度 |
|---|---|---|---|---|---|
| Whisper（原版 buffered）| 10.5 | 221 | 12.5 | 131 | 1.0× |
| WhisperX | **9.7** | **189** | **11.8** | **75** | **11.8×** |

参考：[arXiv:2303.00747, Table 2](https://arxiv.org/html/2303.00747)

更细致的消融实验（同论文 §3.4.2 Table 3）：

| 输入策略 | Batch | TED-LIUM WER↓ | 速度 |
|---|---|---|---|
| 完整音频喂 Whisper buffered | 1 | 10.52 | 1.0× |
| 完整音频强制 batched（无 VAD）| 32 | **78.78** | 7.1× |
| VAD-CM(τ=15s) | 1 | 9.72 | 2.1× |
| **VAD-CM(τ=30s)** | 1 | **9.70** | 2.7× |
| **VAD-CM(τ=30s)** | 32 | 9.70 | **11.8×** |

两个关键结论：

1. **τ=30s 是最优**——必须让 chunk 长度尽量逼近 Whisper 训练时见过的 30s 输入分布。"maximum context yields the most accurate transcription"。这反过来说明：项目当前 `Segment Merging` 后处理虽然合并了短段，但模型推理时看到的还是原始切碎的输入。
2. **重复/幻觉显著下降**——5-gram 重复数从 221 → 189（TED-LIUM），131 → 75（Kincaid46）。论文 §3.4.3 明确：
   > "WhisperX reports the lowest IER on the Kincaid46 and TED-LIUM benchmarks, confirming that the proposed VAD Cut & Merge operations **reduce hallucination** in Whisper. ... **WhisperX avoids repetitive transcription loops and hallucinating speech during inactive speech regions**."

   这是直接打在当前痛点上的——05-12 测试中"流浪地球眼睛一看 ×36+"、英文 "of the murder ×N" 的灾难循环，WhisperX 路线**架构上就避免了**。

### 3.3 三条实现路线对比

#### 路线 A1：切换到 faster-whisper 自带的 `BatchedInferencePipeline`（最轻，推荐）

**关键发现**：faster-whisper 1.0+ 版本内置了 `BatchedInferencePipeline`，**这个类就是把 WhisperX 思路移植到 faster-whisper 内部的官方实现**。

DeepWiki 对该 API 的核心描述：

> "Processes multiple audio chunks simultaneously using batch inference. **VAD filtering enabled by default to remove silence before batching.** Uses only the first temperature value (no temperature fallback mechanism). Optimized for GPU parallelism with configurable batch sizes."  
> —— [BatchedInferencePipeline API 文档](https://deepwiki.com/SYSTRAN/faster-whisper/9.2-batchedinferencepipeline-api)

用法非常简单：

```python
from faster_whisper import BatchedInferencePipeline, WhisperModel

model = WhisperModel("large-v3", device="cuda", compute_type="float16")
batched = BatchedInferencePipeline(model=model, use_vad_model=True,
                                    vad_onset=0.1, vad_offset=0.1)
segments, info = batched.transcribe("test.wav", batch_size=16,
                                     beam_size=5, word_timestamps=True)
```

参考：[faster-whisper Discussion #1057 用法示例](https://github.com/SYSTRAN/faster-whisper/discussions/1057)

| 项 | A1 |
|---|---|
| 优点 | 无新依赖；与 Whisper-WebUI 共存度高；可直接 monkey-patch；3-5× 速度提升 |
| 缺点 | **不支持温度回退**（当前 PATCH 1 失效）；只用 `first temperature`；Whisper-WebUI 原生路径可能没暴露这个接口，需要 patch 引擎层 |

**核心冲突点**：BatchedInferencePipeline 用的是单温度，不做回退。这意味着 05-12 测试证明的"temperature=0.2 防循环"还能保留，但 Whisper 原生的"贪心失败时升温重试"机制完全没有。**反过来说**：WhisperX 路线下，每个 chunk 独立 + `condition_on_previous_text=False`，循环失败模式本身就被大幅缓解，温度回退的必要性也变低。

#### 路线 A2：直接接入 WhisperX 库

**优点**：完整论文方案，包括 pyannote VAD（比 Silero 在复杂场景更鲁棒）+ 可选的 wav2vec2 强制对齐（word-level 时间戳）+ 可选的 pyannote 说话人分离。

**缺点**：
- 新增 pyannote.audio 依赖（拖来一堆 PyTorch 生态包 + torchaudio）
- pyannote 模型需要 HuggingFace token 才能下载（受限网络环境麻烦）
- Whisper-WebUI 的 UI/API 入口不知道怎么接进来，可能要平行实现一套
- 与 Whisper-WebUI 上游不可避免地分叉

参考：[WhisperX GitHub](https://github.com/m-bain/whisperX)

#### 路线 A3：保留 Whisper-WebUI 引擎，monkey-patch 自定义 VAD Cut & Merge

复用现有 Silero VAD（已经在依赖里），在引擎调用前手工切片，喂给 Whisper 时强制 `condition=False` 并 batch 化。

**优点**：完全可控；可以同时保留温度回退；与现有 PATCH 兼容。

**缺点**：要自己实现 min-cut + merge 的逻辑（虽然 WhisperX 论文 §2.2 给了完整 30 行伪代码），需要测试。

### 3.4 推荐方案与决策矩阵

**判断：路线 A1 是最佳起点**，理由有三：

1. **零新依赖，且核心机制完全一致**。faster-whisper 官方 `BatchedInferencePipeline` 实质上就是 WhisperX 的 in-library 实现，社区已经验证。
2. **温度回退的"损失"在新框架下意义降低**。WhisperX 路线 §2.3 明确：每个 chunk 独立 + `condition_on_previous_text=False` 本身就极大缓解循环。论文实测重复数减少 43%。
3. **如果 A1 实测仍不满意**，可以无缝升级到 A3（自定义 min-cut）或 A2（完整 WhisperX）。

### 3.5 关键决策点（部署测试需要回答）— ✅ 已全部实测回答

| 问题 | 验证方式 | 实测答案 |
|---|---|---|
| Whisper-WebUI 现在用的是 `WhisperModel.transcribe()` 还是 `BatchedInferencePipeline.transcribe()`？ | 看源码 | **`WhisperModel.transcribe()`**。已通过 `_patch_whisper_engine` 在本开发版中包装为可路由的双路径（Batched / Buffered 由 `batched` 标志决定）|
| 切换后，温度回退（PATCH 1）是真的不工作，还是只是不再触发？ | 实测 | Batched 模式下 `temperature` 列表会被取首元素（无回退）。**但因 chunk 独立 + condition_on_previous_text=False 大幅缓解循环，温度回退的必要性也降低**——Test 5/6 (64 min 英文) 全程未触发循环 |
| 30 分钟以上中文音频，A1 vs 现有方案的对比（WER + 后段是否仍碎片化 + 重复循环数） | 流浪地球完整版 | 中文 12 min Test 1（Buffered + 后处理）耗时 47s，输出后半段标点丢失、整段无标点；中文 Test 3（Batched + 后处理）耗时 16s 且全程标点完整、段落分明。**速度 2.9×，质量从碎片化变可读** |
| 内存/显存是否够（batched 并行需要更多显存） | `nvidia-smi` + 实测 | Batched 初次集成时因 `_batched_cache` 累积式泄漏，在 16 GiB GPU 上 5 次连续转录后 OOM（错误代码 `cuMemoryAllocate failed res=2`）。**已通过单槽缓存 + 显式 `gc.collect()` + `torch.cuda.empty_cache()` 修复**，详见 §3.9.4 |

### 3.6 实施工作量评估（A1）

如果 Whisper-WebUI 用的是 `WhisperModel.transcribe()`，monkey-patch 改造大概是：

- 修改 `_patch_whisper_engine`：把 `WhisperModel.transcribe` 包装从"调原 transcribe"改成"用 BatchedInferencePipeline 包装后再调"
- 移除或简化 `_build_temp_fallback`（不再相关）
- `_text_cleaning` / `_segment_merging` 后处理流水线不变，仍可叠加
- 可能要新增 `batch_size` 参数（高级选项）

**预估代码量**：~60 行新增，~50 行修改。比 PATCH 1 那次还小。

### 3.7 风险清单 — ✅ 已全部实测验证

1. **`BatchedInferencePipeline` 在 CPU-only 部署时性能可能反而下降** → 不适用。当前部署带 GPU 注入，实测 64 min 英文音频 RTFx 从 15.3× 升到 70×。
2. **Whisper-WebUI 的 Gradio UI 不知道 `batch_size` 这个参数** → 已解决。在 monkey-patch 里硬编码默认值 16；API 暴露 `batch_size` 可 per-request 覆盖。WebUI 不需要单独 UI 控件，因为 16 在 16 GiB GPU 上经实测无 OOM 风险（修复缓存泄漏后）。
3. **WhisperX 的英文最优配置（False + 0.2 + rep=1.1 + ngram=5）是否还成立** → **不再相关**。Batched 路径下 `condition_on_previous_text` 被强制 False，且各 chunk 独立解码，`repetition_penalty` 的 segment 内累积问题（碎片化原因）也不再适用。**Batched 模式下中英文最优配置不再互斥**——这是架构层面的解决，不再是参数 trade-off。
4. **中文长音频在 chunk 独立后是否会丢失跨段语义一致性** → ⚠️ **实测确认存在，但代价远小于 Buffered 副作用**。Test 5 (英文 64 min) 中出现 `Armstein / Armstrong` 等专有名词在不同 chunk 间漂移。但同步测出 Buffered 模式 (Test 4) 有**整段 8 行编造对话 + 韩/中/日/西语字符混入 + 现代俚语和脏话**——后者代价远大于专有名词漂移。详见 §3.9.3。
5. **新发现风险（Batched 初次集成时暴露）**：`_batched_cache` 与 Whisper-WebUI 的 `enable_offload=True` 配合时**显存累积泄漏**。Whisper-WebUI 每次转录后 `offload()` 删除 `self.model`，但下次 `update_model` 创建的新 `WhisperModel` 拥有新的 `id()`——按 id() 缓存的 pipeline 会无限累积，5 次后 OOM。**修复**：单槽缓存 + `id()` 变化时立即 `gc.collect()` + `torch.cuda.empty_cache()`（详见 §3.9.4）。

### 3.8 实测对比矩阵 — ✅ 已完成

原计划的 4 个实验，落地为 6 轮中英对照矩阵（Test 1-6）。完整数据与文字录见 §3.9.2、§3.9.3。

| 实验类别 | 计划用例 | 实际执行 | 结果状态 |
|---|---|---|---|
| 中文长音频 | 流浪地球 30+ 分钟 | Test 1-3：流浪地球 12 min × 3 种参数组合 | ✅ Batched 加速 2.9× 且后段不碎片化 |
| 英文长音频 | 福尔摩斯 60+ 分钟 | Test 4-6：福尔摩斯 64 min × 3 种参数组合 | ✅ Batched 加速 4.57× 且根治了 Buffered 模式的整段编造、跨语言污染、段内循环 |
| 短音频不退步 | 5 分钟 | 收尾验证补做：10 个 clip（5 时长 × 2 语种）× Batched/Buffered = 20 次受控对照 | ✅ 已补，详见 §3.9.7（30s 是分水岭，< 30s 反慢，3-5 min 起 ~2× 加速） |
| GPU 显存稳定 | `nvidia-smi` | Test 4 之前因缓存泄漏 OOM；修复后 Test 4-6 连续运行无 OOM | ✅ 已根治 |

### 3.9 实测落地与结果验证

#### 3.9.1 实施工作量复盘 vs §3.6 预估

| 项 | §3.6 预估 | 实际落地 |
|---|---|---|
| `_patch_whisper_engine` 改造 | 把 `WhisperModel.transcribe` 包装从"调原 transcribe"改成"用 BatchedInferencePipeline 包装后再调" | ✅ 完成，约 80 行新增（加 fallback + 缓存 + 参数丢弃逻辑） |
| 移除/简化 `_build_temp_fallback` | 计划简化 | 保留以兼容 Buffered 路径；Batched 路径下取 `temperatures[0]` |
| `_text_cleaning` / `_segment_merging` 不变 | 计划保留 | ✅ 保留，三者可任意组合勾选 |
| 新增 `batch_size` 参数 | 计划高级选项 | ✅ API 暴露 `batch_size`；UI 默认 16，不暴露控件 |
| **额外发现的工作量** | — | UI 持久化重写（`_patch_app_persistence`）+ 并发锁（`_yaml_lock`）+ OOM 缓存重设计 |
| **预估代码量** | ~60 行新增，~50 行修改 | 实际：新增约 200 行（含 OOM 修复、并发安全、UI 持久化补丁），原始 Batched 路由代码确实约 60 行 |

预估偏小约 3 倍，主要差异来自：实测过程中暴露了改造前已有但未发现的 UI 持久化 bug（与 Gradio 默认行为有关），以及 Batched 初次集成时的 GPU 显存泄漏。

#### 3.9.2 6 轮对照测试矩阵（核心结果）

测试条件：单卡 GPU（16 GiB 显存），`large-v2` 模型，温度回退列表 `[0.2, 0.4, 0.6, 0.8, 1.0]`（由引擎层 Monkey-Patch 从 Slider 初始值 `0.2` 自动展开；Buffered 路径生效，Batched 路径取首元素 `0.2`，详见 STT 主指南 §1.1.2 温度回退小节）。

中文音频（流浪地球片段，~12 min）：

| 编号 | Batched | Cleaning | Merging | 耗时 | 后段质量 |
|---|:---:|:---:|:---:|---|---|
| Test 1 | ❌ | ❌ | ❌ | 47s | 标点丢失严重，后半段整段无标点 |
| Test 2 | ❌ | ✅ | ✅ | 47s | 合并后视觉好些，但仍有原引擎丢标点问题 |
| Test 3 | ✅ | ✅ | ✅ | **16s** | **全程标点完整，段落分明** |

英文音频（福尔摩斯·波希米亚丑闻，~64 min）：

| 编号 | Batched | Cleaning | Merging | 耗时 | 严重缺陷 |
|---|:---:|:---:|:---:|---|---|
| Test 4 | ❌ | ❌ | ❌ | 4 min 11 s | ⚠️ **多段灾难**：跨语言污染（韩/中/日/西/俚语/脏话）；整段编造 8 行对话；段内重复 (`I found her in the middle of the street ×2`)；单词丢失 (`bad taste` → `a man`) |
| Test 5 | ✅ | ❌ | ❌ | **1 min 5 s** | ✅ 4 类灾难性失败全部消失；仅保留专有名词漂移（如 `Armstrong/Armstein`）+ 1 处 YouTube boilerplate 残留 |
| Test 6 | ✅ | ✅ | ✅ | **55 s** | ✅ 同 Test 5，叠加后处理后逐段更紧凑 |

**关键速度数据**：英文 64 min 音频 Buffered 251 s（Test 4）→ Batched 65 s（Test 5，**3.86× 加速**） / Batched + 后处理 55 s（Test 6，**4.57× 加速**）；RTFx 从 15.3× 升到 ≈70×。Test 6 比 Test 5 还快 10 s 看似反常，实际是 §3.9.4 描述的**单槽 Pipeline 缓存命中**——Test 6 跑在 Test 5 之后，`id(model)` 未变，Silero VAD + Pipeline 直接复用，省下了 Test 5 首次构建时的 ~10 s 启动开销。后处理本身耗时可忽略（毫秒级 segment 操作）。

#### 3.9.3 Buffered 模式 4 类灾难性失败的具体形态（Test 4 实测）

这些是论文里 §3.4.3 描述的"hallucination during inactive regions" 和"repetitive transcription loops"的真实形态。

1. **跨语言污染（含俚语/脏话乱入）**：Whisper 在长音频后段失去语言锁定，CJK 模型解码器输出韩/中/日/西字符混入英文，并伴随训练集污染——19 世纪维多利亚小说里冒出 `lol` / `fucking` / `30%` 等现代俚语和脏话。Test 4 样本："*the king said 안녕, oh dear me ... but he was 勤才 of the city of bali ...*"、"*hijo vit routinely to cajol my mother ... fucking podeous ... she was undtailed lol ... conseguir ...*"。
2. **整段编造对话**：在原音频低能量段，模型凭空生成与原文毫无关联的对话。Test 4 样本：在 *"But it has twice been burgled"* 之后整 8 行 *"Oh, dear. Oh, dear. You know, I know. I have been invited to the commonwealth..."* 跟原文完全无关，直到 *"carriage came round the curve"* 才接回。论文 §3.4.3 称为 *hallucinating speech during inactive speech regions*。
3. **段内重复**：`I found her in the middle of the street, and I found her in the middle of the street` 段内重复；类似 05-12 测试中文 "流浪地球眼睛一看 × 36+" 的英文版本。
4. **单词丢失**：与上面"乱加"相对的另一面——长句中部分关键词被 buffer 边界吞掉。Test 4 样本：原文 *"His dress was rich with a richness which would, in England, be looked upon as akin to **bad taste**"*，输出 *"...akin to **a man**"*，`bad taste` 被吞了。

**Test 5/6 (Batched) 全部消失**，因为：

- 每个 chunk 独立解码，无法跨片传播错误状态
- VAD 切片在静音处切，模型不会被喂入"长静音段"，所以 hallucination during inactive regions 几乎不发生
- `condition_on_previous_text=False` 强制，无法跨片 prompt 污染

代价：专有名词漂移（同一个名字在不同 chunk 可能不一致，如 `William Godstrich` ↔ `William Gottfried`、`Armstrong` ↔ `Armstein`、`Claudia Lohrmann` ↔ `Claudia Lorman`），以及偶尔的 YouTube boilerplate 残留（`Thank you for watching` 在 silence 段尾出现 1 次）。但与上述 4 类灾难相比，这是远小的代价。

#### 3.9.4 Batched 初次集成时的 GPU OOM 修复

**症状**：英文 64 min 音频第一次跑 Batched=True 时正常完成；第二次跑直接 `RuntimeError: CUDA failed with error out of memory`（错误码 `cuMemoryAllocate failed res=2`）。

**根因**：
1. `_batched_cache` 用 `id(model)` 作为 key 缓存 `BatchedInferencePipeline` 实例。
2. Whisper-WebUI 默认 `enable_offload=True`，每次转录结束后调用 `offload()` → `del self.model`。
3. 下次转录开始时 `update_model()` 创建一个**新的** `WhisperModel` 实例（新的 Python 对象 id）。
4. `_batched_cache` 按 id 索引，旧 pipeline + 旧 `WhisperModel`（约 3 GB 显存）**没被释放**——因为缓存里持有强引用。
5. 5 次循环后，16 GiB GPU 被 15 GB 旧模型占满，OOM。

**修复**（在 Batched 集成同期落地的内部 hotfix）：
- `_batched_cache` 从"按 id 多槽存储"改为"单槽"——任何 cache miss 触发先 evict 旧条目
- evict 时显式调用 `gc.collect()` + `_torch.cuda.empty_cache()` 释放显存
- 加日志记录 evict 的 model id，便于后续诊断

伪代码：

```python
_batched_cache = {}

def _get_or_create_batched(model):
    key = id(model)
    if key in _batched_cache:
        return _batched_cache[key]  # hot path
    
    # cold path: evict + GC before creating new pipeline
    if _batched_cache:
        _batched_cache.clear()
        gc.collect()
        if _torch.cuda.is_available():
            _torch.cuda.empty_cache()
    
    pipeline = BatchedInferencePipeline(model=model)
    _batched_cache[key] = pipeline
    return pipeline
```

修复后 Test 4-6 连续运行 + 多次重复测试，均未再出现 OOM。

#### 3.9.5 与论文 Table 2 的横向对照

| 指标 | 论文 WhisperX | 本开发版实测 (英文 64 min) | 备注 |
|---|---|---|---|
| 速度加速 | 11.8× | 4.57× | 我们没开 batch=32 并行，只用了 batch=16 + GPU 单卡 16 GiB；论文用了 32 batch + 单 A100 80 GiB |
| WER 改善 | 10.5 → 9.7 (-8%) | 未量化（无 ground truth 标注）| 但灾难性失败的消失是结构性改善 |
| 5-gram 重复数 | 221 → 189 | Test 4 多段 `of the murder` × N → Test 5/6 完全消失 | 结构性改善 |
| 跨片漂移 | 论文未具体讨论 | 专有名词漂移（如 `Armstrong/Armstein`）| WhisperX 路线的天然代价 |

实测速度比论文加速比小，是因为我们 GPU 显存有限（16 GiB vs A100 80 GiB），batch_size 只能开到 16。如果未来升级到大显存 GPU，理论上可进一步逼近论文的 11.8× 加速。

#### 3.9.6 Batched 同期落地的相关修复

为支持 Batched 路径稳定运行，本开发版还顺带修复了 3 个改造前就存在的旧问题：

1. **UI 浏览器刷新后选项丢失**：Gradio 在浏览器 F5 时会重发"最初构建 Blocks 时绑定的值"，导致 YAML 里的用户偏好被默认值覆盖。修复：用 `value=lambda: <global>` 让 Gradio 在每次 page load 时重新读 YAML；并新增 `_patch_app_persistence` 注册 `self.app.load()` 事件触发整体重灌。
2. **YAML 并发写竞态**：快速勾选多个 checkbox 时，多个 callback 几乎同时 `open('w')` truncate 文件 + 读 → 读到空内容 → `params["_post_processing"]` 抛 `TypeError: 'NoneType' object does not support item assignment`。修复：`threading.Lock()` 串行化 + `isinstance(params, dict)` 防御性检查 + `try/except` 包裹所有 callback。
3. **持久化 schema 升级**：早期改造阶段的 `_post_processing` 节缺失 `batched` 字段，本开发版加载时自动补默认值（`batched=True`），避免老 YAML 用户首次升级时 KeyError。

这些修复独立于方向 A 的主线，但它们的存在让 Batched 默认开启的体验稳定可用。

#### 3.9.7 短音频对照实测与中等长音频复测

§3.8 实测对比矩阵里"短音频不退步"原本标注"⚠️ 后续可补"。本开发版收尾阶段做了一次系统的受控实验把这一项闭环。同步进行了一组中等长音频复测，用来验证 Batched 路径在 `clip_timestamps` 修复之后还能不能稳定跑（详见 §3.9.8）——结果跟原 6 轮对照不矛盾、且补全了"短音频规律"这一块。

**1. 短音频对照（10 个 clip × 2 模式 = 20 次调用）**

| 时长 | 中文 Buffered (ms) | 中文 Batched (ms) | 中文加速比 | 英文 Buffered (ms) | 英文 Batched (ms) | 英文加速比 |
|---:|---:|---:|---:|---:|---:|---:|
| 10 s | 707 | 916 | **0.77×** ⚠️ | 612 | 618 | 0.99× |
| 30 s | 1418 | 1364 | 1.04× | 1258 | 1101 | 1.14× |
| 1 min | 2197 | 1741 | 1.26× | 2281 | 1543 | 1.48× |
| 3 min | 6305 | 3608 | **1.75×** | 6268 | 3106 | **2.02×** |
| 5 min | 9770 | 5283 | **1.85×** | 10005 | 4786 | **2.09×** |

测试条件：`text_cleaning=false` + `segment_merging=false`（只看引擎层差异）；每次调用都带 `_diag=true`，响应 `_meta.path` 全部为 `batched` / `buffered`（无 `batched_fallback_to_buffered`，确认 Batched 真路径跑通）。

**关键观察**：

- **30 s 是分水岭**：< 30 s 的短 clip 上 Batched 反而慢——VAD 启动 + Pipeline 构建固定开销 ≈ 100-200 ms 对极短调用占比过高。10 s 中文样本上 Batched 比 Buffered 慢 30%。
- **30 s ~ 1 min 持平到微反超**：开销渐摊薄，但收益尚未充分释放。
- **3 min 起稳定 ~2× 加速**：5 min 英文样本上 2.09×。
- **同步揭示中英文相似度规律**：中文 zh_30s/1min/3min/5min 上 Buffered vs Batched 全文相似度 0.748-0.774（低），而英文 en_30s/1min/3min/5min 是 0.882-0.934（高）。差异来自两条独立路径的叠加——(a) VAD 切片边界不同导致段划分不同；(b) Batched 强制 `condition_on_previous_text=False`，标点和措辞会更"碎"。英文音节边界比中文清晰，VAD 切片更一致，所以英文相似度高。这不是 bug，是预期内的"chunking 不同导致的合理变化"，与 §3.9.5 论文 Table 2 里 WhisperX 也观察到的"专有名词跨片漂移"同源。

**2. 文档使用建议（新增）**：

- **批量处理大量 < 30 s 的短 clip**（实时对话、短录音转写）→ 建议显式 `batched=false`，省那 30% 启动开销。
- **单次处理 < 30 s 且要低延迟**→ 同上。
- **任何 ≥ 1 min 的音频**→ 保持 Batched 默认开启，收益从 1.5× 起步。
- **长音频（≥ 5 min）**→ Batched 是必须开的，原 §3.9.2 / §3.9.3 已经证明在长样本上 Buffered 还会撞 4 类灾难，速度优势之外还有质量保障。

#### 3.9.8 中等长音频复测（同期收尾验证）

为复测 Batched 路径在 `clip_timestamps` 修复后是否仍按预期工作（修复前 Batched 路径会因 string 类型的 `clip_timestamps` 默认值悄无声息 fallback 到 Buffered，详见 STT 主指南 §A.3 收尾修复清单），本开发版跑了一组**关后处理的引擎层纯对照**：

| 音频 | 时长 | Buffered 耗时 | Batched 耗时 | 加速比 | `_meta.path` |
|---|---:|---:|---:|---:|---|
| 流浪地球02·中文 | ~14 min | 27.6 s | 14.8 s | **1.87×** 🚀 | `batched` ✓ |
| 福尔摩斯·英文 | ~59 min | 2 min 00 s | 60.0 s | **2.01×** 🚀 | `batched` ✓ |

`_meta.batched_dropped_kwargs` 在两次 Batched 调用上都包含完整的 5 项（`condition_on_previous_text`, `hallucination_silence_threshold`, `prompt_reset_on_temperature`, `vad_filter`, `vad_parameters`），证明 Batched 路径**真的在跑**——这是 `clip_timestamps` 修复后首次有响应级别的铁证表明 Batched 没 fallback。

**加速比看起来比原 §3.9.2 数据低，是预期内的两个原因**：

1. **该复测关掉了后处理**（Test 4-6 是带后处理的端到端用户对照）——后处理本身不耗时但能放大 Buffered 的 hallucination loop 时间
2. **该复测的 Buffered 路径"运气好"，没遇到 §3.9.3 的 4 类灾难性失败**——那些灾难发生时 Buffered 会大量在 hallucination loop 上耗时，让加速比看起来格外悬殊

**两组数据互补，不冲突**：

| 视角 | 数据来源 | 加速比 | 含义 |
|---|---|---:|---|
| 端到端用户视角（含后处理）+ 灾难命中 | §3.9.2 (Test 4 vs Test 6, 64 min 英文) | **4.57×** | "Batched 在灾难场景下的真实价值" |
| 引擎层纯比较（关后处理）+ 灾难未命中 | §3.9.8 (59 min 英文) | **2.01×** | "Batched 在幸运场景下的下限保证" |
| 中文中等长（含后处理）+ 无灾难 | §3.9.2 (Test 1 vs Test 3, 12 min 中文) | **2.9×** | "中文长样本的常规收益" |
| 中文中等长（关后处理）+ 无灾难 | §3.9.8 (14 min 中文) | **1.87×** | "中文 14 min 引擎层下限" |

可以总结成一句话：**Batched 在 ≥ 5 min 的真实音频上稳定 ≥ 2× 加速；遇到 Buffered 灾难场景时还能进一步拉到 4× 以上**。

---

## 四、方向 B：多引擎应用（长期路线）

### 4.1 核心架构

```
用户上传/直播音频
   ↓
[语言检测] (Whisper 自带的语言检测或 lid 模型)
   ↓
   ├─ 中文 → FunASR Paraformer-v2 / Qwen3-ASR
   ├─ 英文 → Parakeet TDT v3 (0.6B)
   └─ 其他语种 → Whisper-large-v3（兜底）
   ↓
[说话人分离] pyannote.audio (可选)
   ↓
[文本后处理] 标点 / ITN / 大小写
   ↓
[LLM 摘要] (可选)
```

### 4.2 模型选型证据

| 引擎 | 模型 | 长音频能力 | 许可证 | 来源 |
|---|---|---|---|---|
| 中文主力（路线 1）| FunASR / Paraformer-v2 | 单文件 12h 异步转写、12h/2GB 上限 | Apache-2.0 | [Alibaba Cloud 文档](https://www.alibabacloud.com/help/en/model-studio/recording-file-recognition)，[FunASR GitHub](https://github.com/alibaba-damo-academy/FunASR) |
| 中文主力（路线 2）| Qwen3-ASR-1.7B / 0.6B | 单次 1200 秒，52 语 + 22 中文方言 | Apache-2.0 | [Qwen/Qwen3-ASR-1.7B HF](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)，[技术报告 arXiv:2601.21337](https://arxiv.org/pdf/2601.21337) |
| 英文主力 | Parakeet TDT 0.6B v2 (英) / v3 (25 语) | v2 单次 24min，v3 local-attn 3h | CC-BY-4.0 | [HF v3 模型卡](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)，[arXiv:2509.14128](https://arxiv.org/pdf/2509.14128) |
| 多语兜底 | Whisper-large-v3 | 现有 | MIT | 沿用 |
| 说话人分离 | pyannote.audio 3.x EEND-based | 通用 | MIT (需 HF token 接受协议) | [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) |

### 4.3 关键工程考量

1. **多套 ASR 引擎并存** → Pod 镜像和模型存储显著膨胀。Parakeet 模型 0.6B (~2.4GB) + FunASR Paraformer-v2 (~1GB) + Qwen3-ASR-1.7B (~4.7GB) + 现有 Whisper-large-v3 (~3GB) ≈ +11GB 持久存储（视具体选择而定）。
2. **GPU 资源调度** → 各引擎不必同时驻留显存，可懒加载/按需切换，但首次冷启会慢。
3. **API 入口设计** → 沿用 OpenAI 兼容 API，但需要新增 `engine` 参数让用户显式选择，或自动按语言路由。
4. **说话人分离接入** → pyannote 需要 HuggingFace token，受限网络部署需要做好镜像预下载或本地权重打包。

### 4.4 投入产出的预判

- **如果只解决当前的痛点**（长音频质量），方向 A 投入产出比远高于 B
- **如果产品定位升级到"会议纪要"**，方向 B 是必经之路，A 只能是中间过渡
- **方向 B 的"非技术风险"更大**：模型许可证、生态绑定、多引擎运维复杂度

### 4.5 触发条件

只在以下情况启动 B：

1. 方向 A 实测后长音频质量仍不达期望
2. 业务方明确要求"会议室场景"（多人、说话人分离、长录音）
3. 有时间窗口做一次较大的版本迭代（不能在基线版本 `v1.0.7` 的小迭代内做）

---

## 五、结论与后续可探索的方向

### 5.1 核心结论（基于实测更新）

1. **长音频后程崩坏不是参数问题，是架构问题**。Whisper 的 30 秒固定窗 + buffered transcription + 时间戳漂移机制，是这一族模型的天花板，靠 monkey-patch 后处理无法根治。
2. **商业产品的强大不在于"换个更好的模型"，而在于完整工程系统**。前端音频处理、流式声学模型、独立说话人分离、后处理与摘要——四层缺一不可。Whisper 只覆盖中间一层。
3. **开源生态在 2025-2026 已经显著前移**：Parakeet TDT v3、Qwen3-ASR、FunAudio-ASR 等模型在长音频与噪声鲁棒上已经接近商业方案，且全部开源 Apache/CC 许可。
4. **方向 A 已落地并实测验证**：本开发版集成 `BatchedInferencePipeline`，**英文 64 min 音频加速 4.57×，且根治了 Buffered 模式的 4 类灾难（跨语言污染含俚语脏话、整段编造对话、段内重复、单词丢失）**。中文 12 min 音频加速 2.9×，标点丢失现象消失。代价是专有名词跨片漂移（远小于原 4 类灾难）。
5. **后处理（Cleaning / Merging）的角色重新定位**：在 Batched 路径下，引擎层已经不会输出严重失败，**后处理变成"锦上添花"而非"救命稻草"**。两者保留为用户可勾选，默认全部勾选。
6. **方向 B 尚不具备启动条件**：方向 A 实测结果已经达到"可用"门槛，业务侧目前未提出多人会议纪要等明确扩展需求，方向 B 短期内难以快速实现，归入长期备选。

### 5.2 实际执行轨迹（按时间）

| 阶段 | 时间窗口 | 实际工作 | 状态 |
|---|---|---|:---:|
| 第 1 步 | 立即 | 删除 LLM 校正 + 后处理用户可控 + yaml 持久化，完成基础回归测试 | ✅ 完成 |
| 第 2 步 | 第 1 步测试期间 | 翻 Whisper-WebUI 源码确认 `faster_whisper_inference.py` 的 ASR 调用栈，确定 A1 的 monkey-patch 切入点 | ✅ 完成 |
| 第 3 步 | 第 1 步测试完成后 | 实施 A1（`BatchedInferencePipeline` 集成）；按 §3.8 的对比矩阵实测长音频 | ✅ **完成（含 OOM hotfix）** |
| 第 4 步 | A1 验证完成后 | 评估方向 B 的启动条件是否具备 | ✅ 评估完成：当前业务尚未提出会议纪要等明确需求 |
| 第 5 步 | 业务需求出现时 | 规划并启动方向 B，按 §4 路线推进 | ⏸️ 短期内难以快速实现 |

### 5.3 已完成的实测验证

**主体实测**：

- ✅ 6 轮中英对照矩阵（Test 1-6），覆盖 Batched / Cleaning / Merging 三个独立维度的开关组合
- ✅ 64 min 英文长音频 Buffered → Batched 加速 4.57×（含后处理，端到端用户视角）
- ✅ Buffered 4 类灾难（跨语言污染 / 整段编造 / 段内重复 / 单词丢失）全部消失
- ✅ GPU 显存累积泄漏问题诊断 + 修复
- ✅ Gradio UI 刷新持久化问题修复
- ✅ YAML 并发写竞态修复

**收尾验证**：

- ✅ 短音频对照实测（10 个 clip × 2 模式 = 20 次，详见 §3.9.7）——补齐 §3.8 原标"⚠️ 后续可补"项；明确 30 s 是 Batched 反转分水岭
- ✅ 中等长音频复测（14 min 中文 1.87× + 59 min 英文 2.01×，关后处理，详见 §3.9.8）——验证 `clip_timestamps` 修复后 Batched 路径稳定可跑（`_meta.path == "batched"` 而非 fallback）
- ✅ Batched 路径不再悄无声息 fallback 到 Buffered（`clip_timestamps` 字符串默认值导致的 `TypeError: string indices must be integers, not 'str'` 已修复，详见 STT 主指南 §A.3 收尾修复清单）
- ✅ API 自动化测试套件 39 用例全绿（Script 2 happy path 19 用例覆盖 11 endpoints + 4 个 `_meta` 可观测性场景 + 4 个运维/列表元信息端点；Script 3 负面用例 13；Script 1b 受控开关组合 7），所有响应结构与错误响应矩阵与代码行为完全一致

### 5.4 已证伪的路线（重复尝试价值有限）

- **LLM 后处理校对**：改造过程中已撤回删除。本报告 §2.7.4 给了机制层面的解释——FunAudio-ASR 论文证实小 LLM 看不懂 ASR 错误。
- **穷举参数组合寻找中英文通用最优解**：15 轮测试已确认无解；方向 A 落地后，参数空间的中英文分裂矛盾从架构层面被消解。
- **越过方向 A 直接做方向 B**：方向 B 工作量约是 A 的 5-10 倍，且 A 的实测结果是判断"是否需要 B"的必要前提；当前实测显示 A 已经覆盖主要痛点。
- **取消 Batched 默认开启**：Test 4 实测证明 Buffered 在长音频上结构性不可靠——一旦遇到长静音、说话人切换、低能量段就可能引爆 4 类灾难。Batched 默认开启 + 用户可关闭的设计在质量、速度、可控性之间取得较好平衡。

### 5.5 后续可继续探索的方向（工作量小）

- **YouTube 模板黑名单**：Test 5 仍偶现 "Thanks for watching!" 等 YouTube 训练数据残留，可在 `_text_cleaning` 加正则黑名单。
- **`initial_prompt` 全局配置项**：当前 initial_prompt 只能通过 API 传入，可在 WebUI YAML 加全局默认值，方便用户为领域音频（医疗、法律）注入术语表。
- **大显存 GPU 升级后调大 batch_size**：当前 batch_size=16 受限于 16 GiB GPU。若升级到 24/40 GiB 显卡，可调到 32+ 进一步逼近论文 11.8× 加速。

---

## 六、参考链接

### Whisper 架构与长音频问题

- [Radford et al., 2022, Whisper paper (OpenAI PDF)](https://cdn.openai.com/papers/whisper.pdf)
- [Robust Speech Recognition via Large-Scale Weak Supervision, arXiv:2212.04356](https://arxiv.org/pdf/2212.04356)
- [Radford et al., ICML 2023 proceedings](https://proceedings.mlr.press/v202/radford23a/radford23a.pdf)
- [whisper/audio.py 实现常量](https://github.com/openai/whisper/blob/main/whisper/audio.py)
- [WhisperX: Time-Accurate Speech Transcription of Long-Form Audio, arXiv:2303.00747](https://arxiv.org/html/2303.00747)
- [WhisperX GitHub](https://github.com/m-bain/whisperX)
- [Whisper-CD contrastive decoding, arXiv:2603.06193](https://www.arxiv.org/pdf/2603.06193)
- [OpenAI whisper Discussion #679: hallucination solution](https://github.com/openai/whisper/discussions/679)
- [WhisperRT streaming, arXiv:2508.12301](https://arxiv.org/html/2508.12301v2)
- [Adapting Whisper for Streaming, arXiv:2506.12154](https://arxiv.org/html/2506.12154v1)
- [Turning Whisper into Real-Time Transcription, arXiv:2307.14743](https://arxiv.org/pdf/2307.14743)
- [A Comparison of End-to-End Models, arXiv:2005.14327](https://arxiv.org/pdf/2005.14327)
- [Streaming ASR 架构对比综述](https://transcriber.talkflowai.com/blog/voice-ai-deep-dive-streaming-asr-ctc-rnnt-attention)

### 商业 ASR 厂商

- [AssemblyAI Conformer-1](https://assemblyai.com/research/conformer-1)
- [AssemblyAI Conformer-2](https://assemblyai.com/research/conformer-2)
- [AssemblyAI Universal-1](https://assemblyai.com/research/universal-1)
- [AssemblyAI Universal-2-TF research](https://assemblyai.com/research/universal-2)
- [Universal-2-TF paper, arXiv:2501.05948](https://arxiv.org/html/2501.05948v1)
- [Otter Speaker Identification Overview](https://help.otter.ai/hc/en-us/articles/21665587209367-Speaker-Identification-Overview)
- [Otter Speech Accuracy FAQ](https://help.otter.ai/hc/en-us/articles/360048322533-Speech-transcription-accuracy-FAQ)
- [Microsoft Teams AI audio enhancements blog](https://www.microsoft.com/en-us/microsoft-365/blog/2022/06/13/how-microsoft-teams-uses-ai-and-machine-learning-to-improve-calls-and-meetings/)
- [Microsoft Learn: Model-based echo cancellation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/audio-processing-model-based-echo-cancellation)
- [Microsoft Research: Meeting Transcription using Asynchronous Distant Microphones](https://www.microsoft.com/en-us/research/publication/meeting-transcription-using-asynchronous-distant-microphones/)
- [ADL-MVDR 神经波束成形, arXiv:2110.06428](http://arxiv.org/pdf/2110.06428v1)

### 开源 ASR 模型

- [NVIDIA Parakeet TDT v2 模型卡](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)
- [NVIDIA Parakeet TDT v3 模型卡](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [Canary-1B-v2 & Parakeet-TDT-0.6B-v3 论文 arXiv:2509.14128](https://arxiv.org/pdf/2509.14128)
- [Qwen/Qwen3-ASR-1.7B HF](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)
- [Qwen3-ASR 技术报告 arXiv:2601.21337](https://arxiv.org/pdf/2601.21337)
- [FunAudio-ASR Technical Report arXiv:2509.12508](https://arxiv.org/html/2509.12508v1)
- [Alibaba FunASR GitHub](https://github.com/alibaba-damo-academy/FunASR)
- [Alibaba Cloud FunASR/Paraformer 文档](https://www.alibabacloud.com/help/en/model-studio/recording-file-recognition)
- [阿里通义听悟实时会议转写 API](https://help.aliyun.com/zh/tingwu/api-tingwu-2022-09-30-dir-real-time-meeting-transcription/)

### 说话人分离

- [End-to-End Neural Speaker Diarization with Self-Attention, arXiv:2003.02966](https://arxiv.org/pdf/2003.02966)
- [pyannote.audio: neural building blocks for diarization, arXiv:1911.01255](https://arxiv.org/pdf/1911.01255)
- [ECAPA-TDNN in diarization, arXiv:2104.01466](https://arxiv.org/pdf/2104.01466)
- [Hitachi EEND 开源](https://github.com/hitachi-speech/eend)
- [pyannote/speaker-diarization-3.1 HF](https://huggingface.co/pyannote/speaker-diarization-3.1)

### 语音增强 / 降噪前端

- [DeepFilterNet3 Interspeech 2023 论文](https://www.isca-archive.org/interspeech_2023/schroter23b_interspeech.pdf)
- [DeepFilterNet GitHub](https://github.com/Rikorose/DeepFilterNet)
- [RNNoise GitHub](https://github.com/xiph/rnnoise)

### faster-whisper / BatchedInferencePipeline

- [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [BatchedInferencePipeline API 文档（DeepWiki）](https://deepwiki.com/SYSTRAN/faster-whisper/9.2-batchedinferencepipeline-api)
- [BatchedInferencePipeline 用法示例 Discussion #1057](https://github.com/SYSTRAN/faster-whisper/discussions/1057)
- [Batched inference 性能讨论 Discussion #1089](https://github.com/SYSTRAN/faster-whisper/discussions/1089)
- [faster-whisper VAD 默认参数分析 Issue #477](https://github.com/SYSTRAN/faster-whisper/issues/477)

### 排行榜与对比

- [Hugging Face Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard)
- [Open ASR Leaderboard 趋势分析（HF Blog, 2025-11）](https://huggingface.co/blog/open-asr-leaderboard)
- [The Decoder: Open ASR Leaderboard tests 60+ models](https://the-decoder.com/open-asr-leaderboard-tests-more-than-60-speech-recognition-models-for-accuracy-and-speed/)

### 国内厂商技术披露

- [飞书妙记产品页](https://www.feishu.cn/product/minutes)
- [飞书妙记 AI 会议纪要文章](https://www.feishu.cn/content/article/7589151449137827010)
- [腾讯云：讯飞听见技术分析](https://cloud.tencent.cn/developer/article/2560595)
- [腾讯云：会议纪要中如何区分发言人](https://cloud.tencent.cn/developer/news/3174025)
