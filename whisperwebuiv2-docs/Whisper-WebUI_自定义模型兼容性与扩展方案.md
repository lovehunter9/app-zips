# Whisper-WebUI 自定义模型兼容性与扩展方案

> 适用范围：`beclab/harveyff-whisper-webui:v1.0.7` 基础镜像与上游 `jhj0517/Whisper-WebUI` 同等架构  
> 适用对象：希望在 WebUI 模型框里直接输入 HuggingFace 模型 ID 加载自定义模型，结果遇到 `Unable to open file 'model.bin'` 之类报错的用户与运维人员
>
> **版本说明**：本文讨论的是 Whisper-WebUI 后端的架构约束，与具体版本无关——Olares 商店当前上线的 `whisperwebuiv2 v1.0.7`（基线）与本开发版的相关行为完全一致。`v1.0.7` 是本文唯一会提及的版本号。

---

## 目录

- [一、典型报错与根因](#一典型报错与根因)
- [二、Whisper-WebUI 的架构约束](#二whisper-webui-的架构约束)
- [三、可以支持的模型](#三可以支持的模型)
- [四、不能支持的模型（含原因）](#四不能支持的模型含原因)
- [五、正确加载自定义微调 Whisper 的操作步骤](#五正确加载自定义微调-whisper-的操作步骤)
- [六、突破限制的三个方案方向](#六突破限制的三个方案方向)
- [七、用户层面的简易解释](#七用户层面的简易解释)
- [八、参考链接](#八参考链接)

---

## 一、典型报错与根因

### 1.1 典型报错示例

用户在 WebUI 的模型框里输入 `Qwen/Qwen3-ASR-1.7B` 下载并尝试转录，得到：

```
File "/Whisper-WebUI/modules/whisper/faster_whisper_inference.py", line 159, in update_model
    self.model = faster_whisper.WhisperModel(...)
File ".../faster_whisper/transcribe.py", line 647, in __init__
    self.model = ctranslate2.models.Whisper(...)
RuntimeError: Unable to open file 'model.bin' in model
    '/Whisper-WebUI/models/Whisper/faster-whisper/Qwen--Qwen3-ASR-1.7B'
```

### 1.2 根因

**用户下载的不是 Whisper，而 Whisper-WebUI 只懂 Whisper。**

`ctranslate2.models.Whisper` 是为 OpenAI Whisper 这一种特定模型架构编写的 C++ 推理类，启动时硬找名为 `model.bin` 的二进制文件（CTranslate2 转换格式）。Qwen3-ASR 仓库里发布的是 `safetensors` 分片权重（约 4.7 GB），文件名不同、内部张量布局不同、词表也不同。错误是必然的——这不是文件损坏、不是路径问题，而是文件**根本不该在那个目录里**。

参考：[Qwen/Qwen3-ASR-1.7B HuggingFace 仓库](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)；[Qwen3-ASR 技术报告 arXiv:2601.21337](https://arxiv.org/pdf/2601.21337)

---

## 二、Whisper-WebUI 的架构约束

### 2.1 三个可选后端，全部只懂 Whisper 架构

Whisper-WebUI 通过命令行参数 `--whisper_type` 切换三个推理后端：

| `--whisper_type` | 加载机制 | 期望文件格式 | 来源 |
|---|---|---|---|
| `faster-whisper`（默认，我们使用）| `faster_whisper.WhisperModel(dir)` → 内部调 `ctranslate2.models.Whisper` | `model.bin` + `config.json` + `tokenizer.json` + `vocabulary.json`（CTranslate2 转换产物） | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| `openai-whisper` | `whisper.load_model()` | 单个 `.pt` 文件（OpenAI 原版权重） | [openai/whisper](https://github.com/openai/whisper) |
| `insanely-fast-whisper` | HF `pipeline("automatic-speech-recognition", model=...)` | HF transformers 格式（`pytorch_model.bin` 或 `model.safetensors` + Whisper 架构 `config.json`，`model_type: whisper`） | [Vaibhavs10/insanely-fast-whisper](https://github.com/Vaibhavs10/insanely-fast-whisper) |

来源：[Whisper-WebUI README](https://github.com/jhj0517/Whisper-WebUI/blob/master/README.md)、[Wiki: Command Line Arguments](https://github.com/jhj0517/Whisper-WebUI/wiki/Command-Line-Arguments)

### 2.2 三个后端的共同硬约束

三个后端的代码路径都假设传入的是**OpenAI Whisper 架构**——固定 30 秒输入窗、log-Mel 80 通道梅尔谱、Whisper 自家的 BPE 词表、encoder-decoder Transformer 拓扑、控制 token（`<|transcribe|>`、`<|translate|>`、`<|startoftranscript|>` 等）。

> 任何**改了架构**的模型（哪怕它声称"也是做 ASR"），都不能被这三个后端加载。**Whisper-WebUI 没有"切换到非 Whisper 模型"的开关**。

---

## 三、可以支持的模型

凡是**只动 Whisper 权重、不动架构**的模型，理论上都可以工作。

### 3.1 开箱即用（HF 仓库里已经有 `model.bin`）

可以直接在 WebUI 模型框里输入 HF ID 下载并使用：

| HuggingFace ID | 说明 |
|---|---|
| `openai/whisper-large-v3` | OpenAI 官方 v3，HF transformers 格式（需要 WebUI 自动转换 / 或用 openai-whisper 后端） |
| `Systran/faster-whisper-large-v3` | 官方维护的 CT2 转换版本，**最稳推荐** |
| `Systran/faster-whisper-large-v3-turbo` | 蒸馏版，speed-accuracy 平衡 |
| `Systran/faster-distil-whisper-large-v3` | Distil-Whisper 的 CT2 版本 |
| `deepdml/faster-whisper-large-v3-turbo-ct2` | 社区维护的 turbo CT2 |
| `mukowaty/faster-whisper-int8` | INT8 量化 CT2 |

特点：仓库里直接有 `model.bin`，CTranslate2 / faster-whisper 拿过来不用转换。

### 3.2 需要手动转换 CTranslate2 格式

凡是 HF 上以 `pytorch_model.bin` / `model.safetensors` 形式发布的、**Whisper 架构**的 fine-tuned 模型，都需要一次 `ct2-transformers-converter` 转换才能给 faster-whisper 后端使用：

| HuggingFace ID | 说明 |
|---|---|
| `distil-whisper/distil-large-v3.5` | HF 蒸馏版，多语种英文小模型 |
| `nyrahealth/CrisperWhisper` | Whisper fine-tune，单词级时间戳更精确 |
| `BELLE-2/Belle-distilwhisper-large-v2-zh` | 中文 fine-tune（链家） |
| 各类医疗/法律/客服领域 fine-tuned Whisper | 社区有上千个变种 |

参考：[CTranslate2 Whisper 转换指南](https://gist.github.com/AmgadHasan/389ca9772e4d505a0d1e9be693064b2e)；[Medium: Converting Fine-Tuned Whisper](https://medium.com/%40balaragavesh/converting-your-fine-tuned-whisper-model-to-faster-whisper-using-ctranslate2-b272063d3204)

操作步骤见本文 [§5](#五正确加载自定义微调-whisper-的操作步骤)。

---

## 四、不能支持的模型（含原因）

凡是改了架构的模型，**三个后端全部不支持**。下表按"为什么不能"分类列出：

### 4.1 LLM-based ASR 家族（解码器换成通用大模型）

| 模型 | 架构特征 | 不能支持的原因 |
|---|---|---|
| **Qwen/Qwen3-ASR-1.7B & 0.6B** | Audio Transformer (AuT) + Projector + **Qwen3 LLM decoder** | 解码器是通用 LLM，词表/层结构/前向逻辑与 Whisper 完全不同；`model_type: qwen3_asr`；CT2 中无对应模型类 |
| Alibaba **FunAudio-ASR** / FunAudio-ASR-nano | Audio encoder + Adaptor + CTC decoder + **LLM decoder** | 同上，是阿里 Tongyi Lab 专属架构 |
| ByteDance **Seed-ASR** | ASR + LLM 联合训练 | 闭源 |
| Xiaomi **FireRedASR** | LLM-based ASR | 专属架构 |
| Moonshot **Kimi-Audio** | 音频原生多模态 | 专属架构 |
| **NVIDIA Canary-Qwen-2.5B** | FastConformer encoder + Qwen 解码器 | NeMo 框架专属 |

参考：[Qwen3-ASR Technical Report, arXiv:2601.21337](https://arxiv.org/pdf/2601.21337)；[FunAudio-ASR Technical Report, arXiv:2509.12508](https://arxiv.org/html/2509.12508v1)；[Open ASR Leaderboard 趋势分析](https://huggingface.co/blog/open-asr-leaderboard)

### 4.2 Transducer 家族（RNN-T / TDT 解码器，非 attention decoder）

| 模型 | 架构特征 | 不能支持的原因 |
|---|---|---|
| **NVIDIA Parakeet TDT 0.6B v2 / v3** | FastConformer + Token-and-Duration Transducer | Transducer 解码器，无 attention cross-attention；faster-whisper / CTranslate2 完全没这个推理类 |
| **NVIDIA Canary-1B-v2** | FastConformer + RNN-T | 同上，需 NeMo |
| **AssemblyAI Conformer-2 / Universal-1 / Universal-2** | Conformer + RNN-T | 商业闭源，不开权重 |

参考：[NVIDIA Parakeet TDT v3 模型卡](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)；[Canary-1B-v2 & Parakeet-TDT-0.6B-v3 论文 arXiv:2509.14128](https://arxiv.org/pdf/2509.14128)；[AssemblyAI Universal-2 研究页](https://assemblyai.com/research/universal-2)

### 4.3 非自回归 / CTC-only 家族

| 模型 | 架构特征 | 不能支持的原因 |
|---|---|---|
| Alibaba **Paraformer** / Paraformer-v2 / paraformer-zh-streaming | 非自回归 + CTC | FunASR 框架专属，运行时不同 |
| Alibaba **SenseVoice** | AED + CTC 混合 | 同上 |
| Meta **Wav2Vec2** / HuBERT / WavLM | CTC encoder-only | 完全不同范式，无 decoder |
| Meta **MMS** / Omnilingual ASR | Wav2Vec2 派生 | 同上 |
| **Whisper-CD** 等改训练目标的变种 | 改解码策略 | 部分还能加载但行为偏离 |

参考：[FunASR GitHub](https://github.com/alibaba-damo-academy/FunASR)；[Alibaba Cloud FunASR 文档](https://www.alibabacloud.com/help/en/model-studio/recording-file-recognition)

### 4.4 闭源商业模型（不开权重）

| 模型 | 不能支持的原因 |
|---|---|
| OpenAI `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` | 仅 API 访问，未开权重 |
| ElevenLabs Scribe v1 | 商业闭源 |
| RevAI Fusion | 商业闭源 |
| 飞书妙记 / 阿里听悟 / 讯飞听见 内部模型 | 商业闭源 |

### 4.5 灰色地带

| 模型 | 说明 |
|---|---|
| `openai/whisper-large-v3-turbo` | 是 Whisper 架构但去掉了部分 decoder 层。**新版** faster-whisper 已支持；老版 faster-whisper / 旧的 CTranslate2 不支持。如遇加载失败先尝试升级依赖 |
| 任意"声称是 Whisper 衍生"的模型 | 不要靠名字猜测，必须验证 `config.json` 里 `model_type` 是否为 `whisper`。**这是唯一可靠判据。** |

---

## 五、正确加载自定义微调 Whisper 的操作步骤

以下步骤适用于：HF 仓库里发布的是 transformers 格式（`safetensors` 或 `pytorch_model.bin`）、且 `config.json` 中 `model_type` 为 `whisper` 的模型。

### 5.1 判断模型是否可支持（必做的预检）

下载前先查 HF 模型卡：

```bash
curl -s https://huggingface.co/<owner>/<model>/raw/main/config.json | grep model_type
```

- 输出 `"model_type": "whisper"` → 可以走 [§5.2](#52-方式-a直接使用已转换好的-ct2-版本最简) 或 [§5.3](#53-方式-b手动转换-hf-transformers-格式到-ct2)
- 输出其他（如 `qwen3_asr`、`paraformer`、`canary`、`wav2vec2`）→ 不能用，参见 [§4](#四不能支持的模型含原因) 和 [§6](#六突破限制的三个方案方向)

### 5.2 方式 A：直接使用已转换好的 CT2 版本（最简）

如果有人已经在 HF 上发布了对应模型的 `Systran/faster-whisper-*` 或 `<owner>-ct2` 版本，**优先使用这个**——仓库里直接有 `model.bin`，开箱即用。

WebUI 模型框里直接输入完整 HF ID 即可。

### 5.3 方式 B：手动转换 HF transformers 格式到 CT2

需要在 Pod 内或本地执行一次转换：

```bash
pip install -U ctranslate2 transformers

ct2-transformers-converter \
  --model <owner>/<model-id-or-local-path> \
  --output_dir /Whisper-WebUI/models/Whisper/faster-whisper/<your-display-name> \
  --copy_files tokenizer.json preprocessor_config.json \
  --quantization float16
```

- `--quantization` 可选：`float16`（推荐 GPU）/ `int8_float16`（混合精度）/ `int8`（纯 INT8）
- 转换完成后 `<your-display-name>` 目录里会出现 `model.bin`，此时 WebUI 即可加载

转换原理：CTranslate2 不改变权重和架构，**只是把权重重排成它自己的内存友好布局并融合算子**。Whisper 架构本身完全保留。

参考：[CTranslate2 转换文档](https://opennmt.net/CTranslate2/guides/transformers.html)

### 5.4 验证加载成功

加载新模型后，转录任意一段短音频，确认：
- WebUI 控制台无 `Unable to open file 'model.bin'` 错
- 输出文本符合预期（中文音频出中文，英文出英文）
- 时间戳与音频时长合理

---

## 六、突破限制的三个方案方向

如果业务上确实需要 Qwen3-ASR、Parakeet TDT、FunASR 等非 Whisper 架构模型，**只有改造的路**。按工作量从轻到重列出：

### 6.1 方向 1：旁路引擎（最轻，推荐起步）

不动 Whisper-WebUI 任何代码，**在同一个 Pod 里多起一个推理服务**，让用户通过 API 选择走哪个引擎。

以 Qwen3-ASR 为例：

```bash
pip install -U qwen-asr        # 或 qwen-asr[vllm] 启用 vLLM 后端
```

```python
from qwen_asr import QwenAsrModel
model = QwenAsrModel.from_pretrained("Qwen/Qwen3-ASR-1.7B")
result = model.transcribe(audio_path)
```

参考：[Qwen3-ASR 官方 README Quickstart](https://huggingface.co/Qwen/Qwen3-ASR-1.7B/blob/main/README.md)

#### 实施改造点

- `deployment.yaml`：增加新进程或 sidecar 容器
- `api-proxy-configmap.yaml`：在我们的 OpenAI 兼容 API 层增加一个分支，根据请求参数（例如 `model="qwen3-asr"`）路由到对应引擎
- WebUI 那侧不动，或在前端加一个 dropdown 让用户选择引擎

#### 工作量

约 1 周。主要消耗在 deployment 重写 + 依赖装包（`qwen-asr[vllm]` 拖来 PyTorch + vLLM ≈ 数 GB 镜像膨胀）+ 资源声明上调。

#### 收益与代价

- **收益**：Qwen3-ASR-1.7B 在 [Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard) 上 Mean WER **5.76**、TED-LIUM **2.28**（排名第 1）、GigaSpeech **8.74**（排名第 1）、22 种汉语方言原生支持。详见[官方 eval results](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)
- **代价**：vLLM 后端需要 GPU 与较大显存；单文件长度上限 1200 秒（20 分钟），超过需自己做 VAD 切片；单独维护一个推理服务

### 6.2 方向 2：fork Whisper-WebUI 增加第 4 个 backend

新增 `--whisper_type qwen3_asr` 选项，在 `modules/whisper/` 下新增 `qwen3_asr_inference.py`，继承 `BaseTranscriptionPipeline`，实现 `update_model` 和 `transcribe`。

参考：[app.py backend 选择逻辑](https://github.com/jhj0517/Whisper-WebUI/blob/master/app.py)

#### 实施改造点

- 写新的 inference class
- 在 `app.py` 里注册到 `whisper_type` 选项
- 改 `available_models` 让 UI 下拉框列出 Qwen3-ASR
- 适配 Qwen3-ASR 的参数体系（接受 `do_sample` / `top_p` 等 LLM 解码参数，而非 Whisper 的 `temperature` / `condition_on_previous_text`）
- Gradio UI 高级参数面板需要重做（Whisper 的不适用）

#### 工作量

2-3 周。

#### 代价

与上游分叉，每次合并都很疼；后续每加一个非 Whisper 引擎都要重复一遍同样的工作。

### 6.3 方向 3：多引擎应用重写（最重，长期方向）

把 Whisper-WebUI 当成 UI 壳子，底层抽象 `ASREngine` 接口：

```python
class ASREngine(ABC):
    @abstractmethod
    def transcribe(self, audio, **kwargs) -> Transcription: ...

class WhisperEngine(ASREngine): ...       # 现有 faster-whisper
class Qwen3ASREngine(ASREngine): ...      # qwen-asr
class ParakeetEngine(ASREngine): ...      # NVIDIA NeMo
class FunASREngine(ASREngine): ...        # 阿里 FunASR
```

按音频语言自动路由（中文 → FunASR/Qwen3-ASR；英文 → Parakeet/Whisper；其他 → Whisper-large-v3 兜底）。

#### 工作量

1-2 个月，且需要 UI 大幅改造。

#### 触发条件

只在以下情况启动：

1. 业务方明确要求"商业级会议纪要"场景（多人、说话人分离、长录音）
2. 方向 1 旁路方案验证后体验良好，决定全面深耕
3. 有足够时间窗口做较大版本迭代

### 6.4 方向选择决策表

| 业务目标 | 建议方向 |
|---|---|
| 只想用某个 Whisper fine-tune | 不需要任何改造，按 [§5](#五正确加载自定义微调-whisper-的操作步骤) 操作即可 |
| 想用 Qwen3-ASR 改善中文识别质量 | **方向 1**（旁路） |
| 想完全替换为 Qwen3-ASR | **方向 2**（fork） |
| 想做多引擎统一会议纪要产品 | **方向 3**（重写） |

---

## 七、用户层面的简易解释

如果有最终用户也问"为什么模型 ID 框输入 Qwen3-ASR / Parakeet / SenseVoice 就报错"，可以这样讲：

> Whisper-WebUI 的模型框相当于"在 Whisper 模型库里搜一个名字"。库里只放 Whisper 这一族（OpenAI Whisper 和它的官方衍生品、社区在 Whisper 上做的微调）。你输入的 Qwen3-ASR、Parakeet、SenseVoice 等是另外的物种——它们也做语音识别，但内部结构和 Whisper 完全不同，就像在猫粮店输入"狗粮"。
>
> 想用这些模型，需要换一家"店"（不同的推理引擎和应用）。目前 Whisper-WebUI 暂不支持。

---

## 八、参考链接

### Whisper-WebUI 与后端

- [jhj0517/Whisper-WebUI README](https://github.com/jhj0517/Whisper-WebUI/blob/master/README.md)
- [Whisper-WebUI Wiki: Command Line Arguments](https://github.com/jhj0517/Whisper-WebUI/wiki/Command-Line-Arguments)
- [Whisper-WebUI Issue #222: How do I apply fine-tuned models?](https://github.com/jhj0517/Whisper-WebUI/issues/222)
- [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [openai/whisper](https://github.com/openai/whisper)
- [Vaibhavs10/insanely-fast-whisper](https://github.com/Vaibhavs10/insanely-fast-whisper)

### CTranslate2 转换

- [OpenNMT CTranslate2 transformers 转换文档](https://opennmt.net/CTranslate2/guides/transformers.html)
- [Gist: Convert Whisper from HF to CT2](https://gist.github.com/AmgadHasan/389ca9772e4d505a0d1e9be693064b2e)
- [Medium: Converting Fine-Tuned Whisper to Faster-Whisper](https://medium.com/%40balaragavesh/converting-your-fine-tuned-whisper-model-to-faster-whisper-using-ctranslate2-b272063d3204)

### 各模型族官方文档

- [Qwen/Qwen3-ASR-1.7B HuggingFace](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)
- [Qwen3-ASR 技术报告 arXiv:2601.21337](https://arxiv.org/pdf/2601.21337)
- [Qwen3-ASR 介绍页](https://qwen-ai.com/qwen-asr/)
- [QwenLM/Qwen3-ASR-Toolkit](https://github.com/QwenLM/Qwen3-ASR-Toolkit)
- [NVIDIA Parakeet TDT v3 模型卡](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [Canary-1B-v2 & Parakeet-TDT-0.6B-v3 论文 arXiv:2509.14128](https://arxiv.org/pdf/2509.14128)
- [FunAudio-ASR Technical Report arXiv:2509.12508](https://arxiv.org/html/2509.12508v1)
- [Alibaba FunASR GitHub](https://github.com/alibaba-damo-academy/FunASR)
- [Alibaba Cloud FunASR/Paraformer 文档](https://www.alibabacloud.com/help/en/model-studio/recording-file-recognition)
- [AssemblyAI Universal-2 研究页](https://assemblyai.com/research/universal-2)

### 排行榜与对比

- [Hugging Face Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard)
- [Open ASR Leaderboard 趋势分析（HF Blog, 2025-11）](https://huggingface.co/blog/open-asr-leaderboard)
