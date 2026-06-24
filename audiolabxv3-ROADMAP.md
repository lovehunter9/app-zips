# audiolabxv3 能力路线图（M1 → M4）

> **架构**：一个 Chart 基座（`audiolabxv3`，`templateOnly`），按模型种类（`MODEL_MODE`）切换引擎镜像。统一范式 = `llm-init` download-only 从 HF 下模型 + 启动该模型对应的官方引擎；对外一个 public 入口（ingress），再由 LLM Gateway 转发。能复用镜像就复用，不打多余镜像。
>
> **图例** ｜ 状态：✅ 已验证 · 🟡 进行中 · ⬜ 计划 ｜ 复用：`基准`=该镜像首发能力 · ♻️=复用已有镜像 · 🆕=需新镜像 ｜ Gateway：✅ 已接 · ⏳ 引擎已通待接 · ⬜ 随能力一并计划

---

## 核心基石：ASR（语音识别 / STT）✅

**ASR（自动语音识别）与 STT（Speech-to-Text）在业界通用为同义**，均指把语音转成文字；本文档统一以 `stt` mode 表示。它是整条音频能力线的地基与公共入口，故置于所有阶段之前。

- **贯穿三阶段**：M1 以它为主轴（diar / word_timestamps / translate 都基于转写结果）；M2 Typeless 是它的流式形态（`stt_stream`）；M3 本地化 `ASR → translate → tts` 的第一步也是它。
- **现状（两套引擎，同 `stt` mode，均 ✅ 已验证 + 接入 Gateway）**：
  - 引擎 A `faster-whisper`：范例 `Systran/faster-whisper-large-v3`，引擎 faster-whisper-server（CTranslate2），附带 word_timestamps。
  - 引擎 B `qwen3-asr`（2026-06-24 验证）：范例 `Qwen/Qwen3-ASR-1.7B`，仍是 download-only + 官方引擎，**复用** 官方 vLLM 镜像 `beclab/vllm-vllm-openai:v0.23.0-cu129`（v0.23.0 原生支持 Qwen3-ASR，`vllm serve` 直接暴露 `/v1/audio/transcriptions`；cu129 匹配集群 5090 驱动），启动时按需 `pip install librosa soundfile`。通过 chart 的 `MODEL_ENGINE=qwen3-asr` 选择，验证 jfk.wav 引擎级 + 网关数据面端到端 200。
- **多引擎架构要点**：`MODEL_MODE` 定能力、`MODEL_ENGINE` 在同一 mode 下选官方引擎（"一 mode 多引擎"），互不影响地各自注册成 Gateway 的 `mode=stt` provider。

---

## 总览

| 阶段 | 版本 | 场景 | 本阶段能力 |
|---|---|---|---|
| M1 | 1.12.7 | 会议转录 | stt · vad · diar · translate · word_timestamps · embed · enhance |
| M2 | 1.12.8 | Typeless 语音输入 | stt_stream（流式 ASR） |
| M3 | 1.12.9 | YouTube / 播客本地化 | tts · tts_clone（translate 已于 M1 落地） |
| M4 | 1.12.10 | 数字人 | 待确认（audio_s2s / tts_dialogue / diar_stream 等） |

---

## M1（1.12.7）会议转录

**场景**：把多人、多语种、带噪的会议录音，变成带时间轴、分说话人、可读可翻译的纪要。流水线：降噪（enhance）→ 切音（vad）→ 转写（stt）→ 词级时间（word_timestamps）→ 分说话人（diar）→ 声纹（embed）→ 翻译（translate）。

| 能力 | 范例模型 | 驱动引擎 | 复用 | 状态 | Gateway | 下一个范例 |
|---|---|---|---|---|---|---|
| **stt** 离线转写（引擎 A） | `Systran/faster-whisper-large-v3` | faster-whisper-server（CTranslate2） | 基准 whisper | ✅ | ✅ | — |
| **stt** 离线转写（引擎 B `qwen3-asr`） | `Qwen/Qwen3-ASR-1.7B` | vLLM（`vllm serve`，原生 `/v1/audio/transcriptions`） | ♻️ vllm-openai | ✅ | ✅ | `Qwen/Qwen3-ASR-0.6B`（轻量） |
| **vad** 人声检测 | `onnx-community/silero-vad` | `/wrappers/vad.py`（whisper 自带 Silero+解码器） | ♻️ whisper | ✅ | ✅ | `pyannote/voice-activity-detection` |
| **diar** 说话人分离 | `pyannote/speaker-diarization-community-1` | pyannote.audio，`/wrappers/diar.py` | 基准 pyannote | ✅ | ✅ | `pyannote/speaker-diarization-3.1` / NeMo Sortformer |
| **translate** 文本机翻 | `entai2965/nllb-200-distilled-600M-ctranslate2` | `/wrappers/translate.py`（whisper 自带 ctranslate2+tokenizers） | ♻️ whisper | ✅ | ✅ | NLLB-1.3B / MADLAD-400 / SeamlessM4T |
| **word_timestamps** 词级时间 | 随 stt 模型 | stt 原生 `verbose_json + word`，非独立 mode | — | ✅ | ✅ | WhisperX（更精对齐） |
| **embed** 说话人向量 | `pyannote/embedding`（512 维） | `/wrappers/embed.py`（首次按需补 `omegaconf`） | ♻️ pyannote | ✅ | ✅ | wespeaker / ECAPA / TitaNet |
| **enhance** 降噪增强 | `speechbrain/mtl-mimic-voicebank`（apache-2.0） | `/wrappers/enhance.py`（pyannote 自带 torch；首次按需补 speechbrain，自动探测增强类） | ♻️ pyannote | ✅ | ✅ | `speechbrain/sepformer-wham16k-enhancement` / DeepFilterNet3 / resemble-enhance |

> **收尾（已完成）**：M1 七项能力引擎级 + Gateway 数据面已全部验证通过。translate / embed / enhance 经 gateway `v2.0.6-test5` 接入（新增 `/v1/translate` JSON 透传 + `/v1/audio/{embeddings,enhance}`，enhance 音频出），端到端 200。Whisper 自带的语音→英文 `translations` 接口随 stt 暴露，不占 `translate` mode（`translate` 专指文本→文本机翻）。

---

## M2（1.12.8）Typeless 语音输入

**场景**："边说边出字"的实时输入，要的是低延迟、增量返回。离线 stt（录完再转）满足不了，需流式 `stt_stream`：音频分块上行、文字增量下行（依赖 WebSocket，见末尾结构性①）。

| 能力 | 范例模型 | 驱动引擎 | 复用 | 状态 | Gateway | 下一个范例 |
|---|---|---|---|---|---|---|
| **stt_stream** 流式转写 | sherpa-onnx 流式 / faster-whisper 增量 | 流式 ASR 服务 | 🆕 | ⬜ | ⬜ | FunASR / SenseVoice 流式 |

---

## M3（1.12.9）YouTube / 播客本地化

**场景**：把外语视频/播客变成"能用母语听"——流水线 `stt → translate → tts`（前两步 M1 已具备）。若要保留原说话人音色，再加声音克隆（tts_clone）。

| 能力 | 范例模型 | 驱动引擎 | 复用 | 状态 | Gateway | 下一个范例 |
|---|---|---|---|---|---|---|
| **tts** 文本→语音 | `hexgrad/Kokoro-82M` | kokoro 推理服务 | 🆕 | ⬜ | ⬜ | Piper / XTTS-v2 |
| **tts_clone** 声音克隆 | `FunAudioLLM/CosyVoice2-0.5B` | CosyVoice 推理服务 | 🆕 | ⬜ | ⬜ | F5-TTS / GPT-SoVITS |

---

## M4（1.12.10）数字人

**场景**：可实时对话的数字人，音频侧诉求是端到端低延迟与自然多轮。覆盖哪些 mode 待确认，候选方向：

| 能力（候选） | 说明 | 范例模型 | 状态 |
|---|---|---|---|
| **audio_s2s** 语音→语音端到端 | 直接听音频、出音频，省去转文字时延 | `Qwen2.5-Omni` / Moshi | ⬜ 待确认 |
| **tts_dialogue** 多角色对话合成 | 多说话人/带情感的对话式合成 | 待定 | ⬜ 待确认 |
| **diar_stream** 流式说话人分离 | 实时区分谁在说 | 待定 | ⬜ 待确认 |

---

## 附：引擎镜像清单

| 镜像 | 技术栈 | 服务能力 |
|---|---|---|
| `beclab/fedirz-faster-whisper-server:0.6.0-rc.3-cuda` | CTranslate2 / faster-whisper | stt（原生）· vad · translate · word_timestamps |
| `beclab/maximsachs-pyannote_fastapi:4.0.4` | PyTorch / pyannote.audio（embed 首次补 omegaconf、enhance 首次补 speechbrain） | diar（原生）· embed · enhance |
| `beclab/vllm-vllm-openai:v0.23.0-cu129` | vLLM（`vllm serve`，首次补 librosa/soundfile） | stt（`MODEL_ENGINE=qwen3-asr`，原生 `/v1/audio/transcriptions`） |
| 待转/待建 | 流式 ASR / kokoro / CosyVoice / 语音对话 | stt_stream · tts · tts_clone · audio_s2s |

## 附：横向事项

- **M5**：每类移植后，同一 mode 接入更多模型，在 Gateway 形成多 provider 备选。
- **M6**：每类移植后，支持公有云同类模型（BYOK 远程 provider）。
- **结构性（贯穿）**：① ingress + Gateway 增加 WebSocket 透传（M2 流式依赖）；② Gateway audio handler 放开 JSON 入 / 音频出（translate 接入与 M3 的 tts 依赖）。test5 镜像承载这些 Gateway 侧改动。
