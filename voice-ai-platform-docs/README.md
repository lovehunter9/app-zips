# Olares 统一语音 AI 平台 · 综合调研（初稿）

> 这是承接"语音输入法"与"语音转录"两份独立课题、按新产品愿景**统一规划**的总报告。
> 两份原课题文档保留作为该用例的"市场全景 + 技术细节 + 模型对比 + 风险"详细参考，不作废。

---

## 一、一句话结论

> **做"一个核心应用 `voice-ai-hub`"对外暴露统一 API（OpenAI 兼容 + 扩展），让用户通过它跑转录 / 实时听写 / 会议记录 / 音频翻译 / TTS / 声音克隆 / 播客生成 / 字幕 / 笔记问答 / 音频问答（2026-04 audio-llm 能力域）/ 真正 S2S 对话（2026-05 audio-s2s）/ 文生音效（2026-05 sound-fx）等 26+ 用例；底层模型全部"可配置"——主力是自家规划的 ~74 个 voice-* model app（**1 app = 1 个具体模型变体**，按 ollama* 系列 v2 范式 1:1 对齐，用户体验完全统一；含 6 个 OpenMOSS MOSS-Audio + 5 个 MOSS-TTS + 1 个 MOSS-TTSD + 1 个 MOSS-Transcribe-Diarize + 2 个 MOSS-Speech + 3 个 Qwen3-ASR + 1 个 Streaming Sortformer 等 2026-05 月度扫描新增），靠一个 `beclab/voice-model-puller` 镜像服务全部 app；门禁模型走 OlaresManifest `envs.HF_TOKEN` 标准机制保持同一范式；短期借力现有 `speaches` / `whisperwebuiv2` / `ollamav2` 作为现成 provider；远程 BYOK 中国内以 Qwen 系列最优先；本平台不在任何现有应用上扩展新功能。M0 + 第一 + 第二阶段约 14–20 人月、7–10 个月即可上线 Auralwise 形态的最小可用版（含 ~54 个 P0+P1 voice-* app）。**

---

## 二、产品愿景四条原则 + 独立模型应用 UX 契约

### 2.1 四条原则

1. **模型可配置、双形态供给**
   - 本地形态：~74 个 voice-* model app（与 `ollama*` 系列同级；待新建）
   - 远程形态：用户 BYOK（OpenAI / Deepgram / 火山豆包 / 阿里 NLS / …）

2. **核心 = API，界面是可选**
   - 主要提供一套接口（类 Auralwise 形态）
   - 自带轻量 Web UI 作为配置中心 + 用例演示

3. **质量优先级：英文 → 中文 → 实时性**
   - 英文优先；中文不影响英文前提下越高越好；实时性越高越好

4. **核心应用独立存在；自家模型应用矩阵独立规划；现有应用不被扩展**
   - 是一个**新** Olares 应用（暂名 `voice-ai-hub`）
   - 模型层主力 = **自家 ~74 个 voice-* model app 矩阵**（待新建，详 `01_独立模型应用清单与配置层.md`）
   - `whisperwebuiv2` / `speaches` / `ollamav2` 短期借力 + 长期解耦，**本平台不在它们上扩展任何新功能**

### 2.2 独立模型应用 UX 契约（与 ollama* 系列 1:1 对齐）

> 详 `00_产品愿景与总体架构.md` §1.5。

1. **1 app = 1 个具体模型变体（含量化档位）**——不是"1 app + 一堆下拉菜单"
2. **App Store 安装条覆盖"镜像 + 模型下载"**——pod readiness 阻塞到模型就绪；不允许"装完打开还要再等"
3. **装完用户立刻能拿到 (BASE_URL, MODEL_NAME) 两个值**就能粘到任何其它应用里用
4. **v2 拆分 server/client**——管理员装 server 一份，普通用户装 client 引用同一个 server

**唯一允许的偏离**：HuggingFace 门禁模型（如 `pyannote-3.1`）需要用户在 App 详情页粘一次 `HF_TOKEN`。**这是仅有的"用户视角"差异**，且仅出现在门禁模型上。

为了让 ~74 个 app 在用户视角"完全相同"，做一个 `beclab/voice-model-puller` 镜像（对照 ollama* 系列里的 `harveyff-olares-ollama` API 容器），由它统一处理：CDN 拉模型 / HF 拉模型 / 门禁 token 等待 / 反代上游引擎。**这是 M0 关键件**（详 `03_落地路线与工作量.md` §二）。

---

## 三、架构速览

```
[消费方]
  Web UI（核心自带）/ 桌面 App / Android IME / LarePass 内嵌 / 其它应用 / 第三方
                ↓ HTTP / WebSocket / SSE
[核心应用 voice-ai-hub]
  API 网关（OpenAI 兼容 + 扩展端点 26 个用例）
  配置中心（用户挑 provider / 模型 / 偏好）
  任务编排（同步 / 异步 / 流式 / 持久化）
  Web UI（配置 + 演示 + 任务历史）
                ↓ 按用户配置路由
[可配置模型层]
  本地 Olares 应用：speaches、whisperwebuiv2、ollamav2 +（待新建）~74 个 voice-* model app（1 app = 1 model；详 §五）
  远程 BYOK：OpenAI / Anthropic / DeepSeek / Deepgram / AssemblyAI / Speechmatics / ElevenLabs / Groq / 阿里 NLS / 火山豆包 / 腾讯云 / 讯飞 / …
```

---

## 四、26 个用例速查

| 大类 | 用例 | 关键 API |
|---|---|---|
| **A 转录** | 文件转录 / 音频翻译 / 流式 STT / 实时听写 / URL 转录 | `/v1/audio/transcriptions`、`/translations`、`/realtime` |
| **B 生成** | 基础 TTS / 声音克隆 TTS / 播客生成 / 字幕生成 / AI 摘要章节 Action Items | `/v1/audio/speech`、`/clone`、`/podcast/generate`、`/subtitles/generate`、`/analyze/summary` |
| **C 会话** | 会议记录 / 长音频整理 / 跨笔记问答 RAG | `/v1/meeting/sessions`、`/notes/ingest`、`/notes/qa` |
| **D 辅助识别** | VAD / 说话人分离 / 语种识别 / 关键词检测 / 强制对齐 | `/v1/audio/vad`、`/diarize`、`/detect-language`、`/keywords`、`/align` |
| **E 音频处理** | 降噪增强 / BGM 分离 / 音频嵌入 | `/v1/audio/denoise`、`/separate`、`/embeddings` |
| **F 配置管理** | 配置 / ASR 词典 / 声纹注册 / 模型查询 / 任务历史 | `/v1/config/*`、`/dictionaries`、`/voices`、`/models/available`、`/tasks` |

完整 API 设计、输入输出、任务模式见 `02_用例覆盖与API契约.md`。

---

## 五、可配置模型层一览

### 5.1 本地（Olares Market 独立应用）

**自家 voice-* 矩阵（主力，待新建，1 app = 1 model）**

> 完整矩阵共 ~74 个 app，按 12 个能力域铺开（STT 离线 / STT 流式 / TTS（含 tts_dialogue）/ VAD / Diarize / Translate / Enhance / Embed / Align / **Audio-LLM** ⭐ 2026-04 / **Audio-S2S** ⭐ 2026-05 / **Sound-FX** ⭐ 2026-05）。完整清单 + 选型理由 + 资源需求详见 `01_独立模型应用清单与配置层.md` §1.2。这里给一个能力域 × 优先级的浓缩快照：

| 能力域 | P0 优先批 | P1 批次 | P2 |
|---|---|---|---|
| **STT 离线** | `voice-stt-whisperx-large-v3-v2` / `voice-stt-whisperx-large-v3-turbo-v2` / `voice-stt-whisper-large-v3-v2` / `voice-stt-whisper-large-v3-turbo-v2` / `voice-stt-parakeet-tdt-06b-v3-v2` / `voice-stt-sensevoice-small-zh-v2` / **`voice-stt-moss-audio-8b-instruct-v2`** ⭐ / ⭐⭐ **`voice-stt-qwen3-asr-1-7b-v2`** / ⭐⭐ **`voice-stt-moss-transcribe-diarize-v2`**（ASR+Diar 一步出）| `voice-stt-whisper-medium-v2` / `voice-stt-whisper-small-v2` / `voice-stt-distilwhisper-large-v3-v2` / `voice-stt-canary-1b-flash-v2` / `voice-stt-paraformer-large-zh-v2` / `voice-stt-moss-audio-4b-instruct-v2` / `voice-stt-qwen3-asr-0-6b-v2` | `voice-stt-distilwhisper-medium-en-v2` / `voice-stt-fireredasr-aed-l-v2` / `voice-stt-dolphin-base-v2` |
| **STT 流式** | `voice-stt-live-whisperlive-large-v3-turbo-v2` / `voice-stt-live-whisperlive-distil-small-v2` / `voice-stt-live-voxtral-realtime-3b-v2` | `voice-stt-live-voxtral-realtime-v2` / `voice-stt-live-paraformer-large-zh-streaming-v2` | `voice-stt-live-sensevoice-streaming-v2` |
| **TTS** | `voice-tts-kokoro-82m-v2` / `voice-tts-cosyvoice-2-v2` | `voice-tts-cosyvoice-2-instruct-v2` / `voice-tts-chattts-v2` / `voice-tts-openvoice-v2-v2` / `voice-tts-spark-tts-v2` / ⭐ `voice-tts-moss-tts-v1-5-v2` / ⭐ `voice-tts-moss-tts-realtime-v2` / ⭐ `voice-tts-moss-tts-nano-100m-v2` / `voice-tts-dialogue-moss-ttsd-v1-0-v2`（多角色对话 TTS）| `voice-tts-melotts-v2` / `voice-tts-styletts2-v2` / `voice-tts-fishspeech-1-5-v2` ⚠ / `voice-tts-xtts-v2-v2` ⚠ / `voice-tts-moss-tts-base-v2` / `voice-tts-moss-tts-local-transformer-v2` / `voice-tts-cosyvoice-3-v2` / `voice-tts-f5-tts-v1-1-v2` / `voice-tts-indextts-2-5-v2` / `voice-tts-higgs-audio-2-5-v2` |
| **VAD** | `voice-vad-silero-v5-v2` | `voice-vad-webrtc-v2` | `voice-vad-ten-vad-v2` ⚠ 非竞争条款 |
| **Diarize** | `voice-diar-pyannote-community-1-v2` | `voice-diar-pyannote-3-1-v2` ⚠ 需 HF_TOKEN / `voice-diar-3dspeaker-eres2net-v2` / ⭐ `voice-diar-streaming-sortformer-v2`（流式）| `voice-diar-nemo-titanet-v2` |
| **Translate** | `voice-translate-madlad-400-3b-v2` | `voice-translate-opusmt-multi-v2` / `voice-translate-m2m-100-v2` | `voice-translate-nllb-200-distilled-600m-v2` ⚠ |
| **Enhance** | `voice-enhance-demucs-v2` / `voice-enhance-resemble-enhance-v2` | `voice-enhance-clearvoice-v2` | `voice-enhance-frcrn-v2` |
| **Embed** | `voice-embed-wavlm-base-plus-v2` / `voice-embed-ecapa-tdnn-v2` | `voice-embed-3dspeaker-eres2net-v2` | `voice-embed-pyannote-embedding-v2` ⚠ 需 HF_TOKEN |
| **Align** | `voice-align-wav2vec2-large-xlsr-v2` | ⭐ `voice-align-qwen3-forcedaligner-0-6b-v2` | `voice-align-mms-1b-all-v2` ⚠ |
| **Audio-LLM** ⭐ 2026-04 新增 | `voice-audio-llm-moss-audio-8b-thinking-v2` | `voice-audio-llm-moss-audio-8b-instruct-v2` / `voice-audio-llm-moss-audio-4b-thinking-v2` / ⭐ `voice-audio-llm-moss-music-8b-thinking-v2` | `voice-audio-llm-moss-audio-4b-instruct-v2` / `voice-audio-llm-moss-music-8b-instruct-v2` / `voice-audio-llm-audio-flamingo-next-8b-v2` / `voice-audio-llm-step-audio-r1-1-v2` / `voice-audio-llm-qwen3-omni-30b-a3b-captioner-v2` |
| **Audio-S2S** ⭐ 2026-05 新增 | — | ⭐ `voice-audio-s2s-moss-speech-v2`（无文本中介 S2S）| `voice-audio-s2s-moss-speech-codec-v2` |
| **Sound-FX** ⭐ 2026-05 新增 | — | — | `voice-soundfx-moss-soundeffect-v2-0-v2`（弱档候选）|

⚠ = 门禁（需 HF_TOKEN）/ 非商用 license / 非竞争条款。详 `01_独立模型应用清单与配置层.md` §1.2.14 优先级路线 + §1.4 OlaresManifest 范型。

**关键件**：所有 ~74 个 app 共用一个 `beclab/voice-model-puller` 镜像（M0），新增 voice-* app 只需写 OlaresManifest + 改 ConfigMap 三个值。详 `技术设计文档.md` §7.1 / `03_落地路线与工作量.md` §二。

**现有 Olares 应用（短期借力 / 长期解耦；本平台不扩展）**

| 应用 | 状态 | 在平台中的角色 | 工作量 |
|---|---|---|---|
| `speaches` | ✅ 已上 v1.0.12 | 现成轻量 STT/TTS provider | 零（仅写适配） |
| `whisperwebuiv2` | ✅ 已上 v1.0.19 | 现成重型 STT GUI；**无 TTS；本平台不扩展** | 零（仅写适配；长期自家 `voice-stt-whisperx-large-v3-v2` 替代默认地位）|
| `ollamav2` | ✅ 已上 v1.0.18 | LLM 后处理（**长期保留**唯一 LLM 入口）| 零 |

### 5.2 远程（BYOK）

**国内 ASR 接入优先级**（已决策）：

> **1️⃣ 阿里 Qwen 系列**（Qwen3-ASR + 阿里云 NLS + 通义听悟）→ 2️⃣ 火山豆包 → 3️⃣ 讯飞 → 4️⃣ 腾讯云 → 5️⃣ 百度智能云

**全集**：

- **LLM**：OpenAI / Anthropic / Google / DeepSeek / Zhipu GLM / **Qwen API（与 Qwen3-ASR 同一通道）** / 火山方舟 / 腾讯混元 / Mistral / 百度文心
- **STT**：⭐ **Qwen3-ASR / 阿里云 NLS / 通义听悟**（国内最优先）/ 火山豆包 / 讯飞 / 腾讯 / 百度 / OpenAI / Deepgram / AssemblyAI / Speechmatics / ElevenLabs / Groq / Cohere / Soniox / Google / Azure / AWS
- **TTS**：OpenAI / ElevenLabs / Azure / Google / AWS Polly / 火山豆包 / 阿里 / 腾讯 / 讯飞
- **翻译**：DeepL / Google / 百度 / 腾讯 / 阿里

完整清单 + 配置 schema 见 `01_独立模型应用清单与配置层.md`。

---

## 六、三阶段七里程碑落地路线

```
[里程碑 0：voice-model-puller 镜像]    0.5 月     0.6–0.8 人月
└─ 自家模型矩阵的统一 API 容器；与第一阶段并行；M0 不通过则后续 ~74 个 voice-* app 全部受阻

[第一阶段：核心应用骨架]               1.5–2.5 月    2–3.5 人月
├─ 1.1  核心应用骨架（API + 配置 + 任务 + Web UI MVP）
├─ 1.2  接入本地 3 个已有应用（speaches/whisperwebuiv2/ollamav2）+
        voice-* / ollama-* 自动发现机制
└─ 1.3  接入 3 海外 BYOK（OpenAI / Deepgram / ElevenLabs）+ ⭐ 国内 Qwen 系列（Qwen3-ASR / 阿里云 NLS / 通义听悟 / Qwen LLM）

[第二阶段：自家模型矩阵 + 用例展开]    4–6 月       12–17 人月
├─ 2.0  ~25 个引擎 image 编写（含 voice-engine-mossaudio / qwenasr / mosstts / mossttsd / mossspeech / mossmusic / mosssoundfx / sortformer / audiollm-misc 等）
├─ 2.1  P0 优先批 ~18 个 voice-* app 上架
├─ 2.2  P1 批次 ~36 个 voice-* app 上架（含 voice-diar-pyannote-3-1-v2 门禁范型 + MOSS-TTS 全家族 + MOSS-TTSD + Streaming Sortformer 等 2026-05 新增 P1）
└─ 2.3  端到端用例：C-1 会议（含流式 diarization）/ B-2 声音克隆 / B-3 播客（含 MOSS-TTSD 一步出） / B-4 字幕 + 真正 S2S 对话（走 audio-s2s）+
        其余国内 4 家 provider（火山豆包 / 讯飞 / 腾讯 / 百度）

[第三阶段：客户端外壳 + 高级用例]      3–5 月（长期） 4–7 人月
├─ 3.1  桌面客户端 fork Handy（macOS / Win / Linux）
├─ 3.2  Android 后台语音服务（RecognitionService）
└─ 3.3  LarePass 内嵌 / 移动 PWA + 跨笔记 RAG
```

**M0 + 第一 + 第二阶段 = 14–20 人月、7–10 个月**就能上线"Auralwise 形态最小可用版（含 ~54 个 P0+P1 voice-* app）"。

详细里程碑、人员配置、决策点见 `03_落地路线与工作量.md`。

---

## 七、与两个原课题的关系

| 原课题 | 在统一平台下的角色 | 之前推荐方案的现状 |
|---|---|---|
| **语音输入法**（`voice-input-products-docs/`） | 用例 A-3 / A-4 / C-1 部分的实现路径 | 原"自研 IME APK / 移动输入法"**降级**为长期客户端外壳（第三阶段 3.2）|
| **语音转录**（`voice-transcription-products-docs/`） | 用例 A-1 / A-2 / A-5 / C-1 / C-2 的实现路径 | 原"自研 AI 语音笔记本"**降级**为"核心应用 Web UI 的笔记面板"或移动 PWA |

两份原报告作为该用例的**市场全景 / 技术细节 / 模型对比 / 风险参考**继续有效；只是产品形态从"独立 App 立项"变为"统一平台下的用例集"。

---

## 八、与"Auralwise 形态"的对照

| Auralwise | 本平台 |
|---|---|
| 统一 API + 多用例 | OpenAI 兼容 + 扩展端点 |
| 全云 SaaS | 自托管 Olares + 可选 BYOK |
| 模型对用户隐藏 | 模型可配置 / 用户可挑（核心差异） |
| 全栈托管模型 | 本地模型应用 + BYOK 双形态 |
| 多用户租户 | 单 Olares 多用户（`bfl.username`） |
| 配置隐藏（用 SaaS 默认） | 暴露 + 提供档位预设 |

---

## 九、风险摘要（TOP 10）

| 风险 | 影响 | 缓解 |
|---|---|---|
| **统一 provider 适配层复杂度** | 工作量易爆 | 第一阶段只支持 3 家；用 litellm 等成熟库 |
| **流式 WebSocket 协议碎片** | 对外协议统一难 | 对外只暴露 OpenAI Realtime 兼容；对内转译 |
| **远程 API key 安全** | 泄漏导致云账户被盗刷 | 集群密钥 + 字段加密 + log 脱敏 |
| **多用户 GPU 并发** | 本地大模型排队 | 任务队列 + 配额 + 自动 fallback 远程 |
| **流式中文 STT 质量** | 流式中文体验落差 | 中文流式默认推远程（火山豆包 / 阿里 NLS）|
| **配置选择困难症** | 26 用例 × N provider 让 UI 变迷宫 | 档位预设 + 按用例配置 + 高级模式 三层入口 |
| **与 Auralwise 差异化不清** | 用户问"为啥不直接用 Auralwise" | 自托管 / 数据不出家 + 模型可挑 + 本地+远程双形态 |
| **与 `whisperwebuiv2` 边界不清** | 用户分不清用哪个 | 文档明确：whisperwebuiv2 是"一次性文件 GUI"；核心应用是"全用例 API 平台" |
| **长任务 HTTP 超时** | 长音频跑不完 | 异步队列 + Webhook + polling |
| **LarePass Service Provider SDK 缺失** | 第三阶段桌面 / 移动自动发现失败 | 立项前对齐时间表；中期用"用户手填 baseURL"过渡 |

完整 44 条风险见 `04_风险与开放问题.md`。

---

## 十、关键决策（已锁定）+ 未决决策点

**已锁定（本轮决策）**

1. ✅ 核心应用命名 = `voice-ai-hub`（保持暂名）
2. ✅ 国内 ASR 接入优先级 = **Qwen 系列最优先**（Qwen3-ASR / 阿里云 NLS / 通义听悟）→ 火山豆包 → 讯飞 → 腾讯 → 百度
3. ✅ `whisperwebuiv2` 处置 = **短期借力 + 长期解耦**；**本平台不在其上扩展任何新功能**
4. ✅ **自家模型矩阵 = 1 app = 1 个具体模型变体**，按 ollama* 系列 v2 范式 1:1 对齐，目标用户视角完全统一（详 `00_产品愿景与总体架构.md` §1.5）
5. ✅ **门禁模型保留** + 走 OlaresManifest `envs.HF_TOKEN` 标准机制；用户视角差异仅"在 App 详情粘一次 token"
6. ✅ **M0 = `beclab/voice-model-puller` 镜像** + ~25 个引擎 image（含 2026-04 `voice-engine-mossaudio` + 2026-05 月度扫描新增 9 个：qwenasr / mosstranscribediarize / mosstts / mossttsd / mossspeech / mossmusic / mosssoundfx / sortformer / audiollm-misc）是矩阵成立的关键件（详 `技术设计文档.md` §7.1 + §7.4.2）
7. ✅ 声音克隆 TTS = **做**（声纹库归 voice-ai-hub，TTS app 永远无状态；用户协议 + 可选 AudioSeal 水印）

**未决**

8. 是否在第一阶段就上 Web UI（建议：是）
9. 其它 9 项开放问题见 `04_风险与开放问题.md` §七。

---

## 十一、文件索引

| 文件 | 内容 | 用途 |
|---|---|---|
| **`调研总报告.md`** ⭐ | **纯调研、无设计**：输入法 / 转录 / AuralWise 三类产品现状 + 通用架构 + 大模型架构演进 + 三类统一架构试图。结论先行，全表/图。| **首次了解领域 / 给老板速览** |
| **`概要设计.md`** ⭐ | **纯设计、比技术设计文档更精简**：系统总图 + 模型层选型 + voice-* 统一范式 + voice-ai-hub 模块 + API 速览 + 关键流程图。无代码、无工期。| **决策者 / 架构师速读** |
| `综合调研结论_精简版.md` | 一篇读完即拿到调研 + 设计全貌（含工作内容，不含工期）| 进一步细化时的中间档 |
| `README.md`（本文）| 一页纸总览 + UX 契约 + 三阶段七里程碑路线 + 风险 + 决策点 | 快速复盘 |
| `00_产品愿景与总体架构.md` | 4 条愿景原则 + **§1.5 独立模型应用 UX 契约** + 整体架构图 + 4 大模块 + 命名建议 | 架构师 |
| `01_独立模型应用清单与配置层.md` | 现有 3 + 自家矩阵 ~74 个 app（按 12 能力域铺开，含 audio-llm + audio-s2s + sound-fx）+ §1.4 一非门禁一门禁 OlaresManifest 范型 + §1.5 voice-model-puller 设计 + 远程供应商 + 配置 schema + §1.2.13 待评估候选清单 | 工程 / 模型团队 |
| `02_用例覆盖与API契约.md` | 26 用例 + 完整 API 端点 + 兼容性对照 + 安全鉴权 | 后端 / 产品 |
| `03_落地路线与工作量.md` | 三阶段七里程碑（含 M0 voice-model-puller）+ 工作量明细 + 人员配置（**含工期**）| 项目管理 |
| `04_风险与开放问题.md` | 44 风险（6 类，含 OpenMOSS license / TEN-VAD 非竞争 / 月度扫描机制） + 决策 + 与原课题关系 | 决策 / 风控 |
| `技术设计文档.md` | 完整 voice-ai-hub 技术设计 + **§七 自家模型矩阵实施细节**（含 voice-model-puller 镜像 + 一非门禁一门禁完整 chart 范型）+ §八 Olares 集成 + §十四 Dockerfile | 工程负责人 |

> 同目录所有 `.md` 都有对应 `.docx`（同名，由 `generate_doc.py` 自动同步）。

---

## 十二、按角色的阅读路径

| 角色 | 推荐阅读 | 时间 |
|---|---|---|
| **首次了解领域** | `调研总报告.md`（纯事实，结论先行） | 15 分钟 |
| **决策者 / 老板速览** | `调研总报告.md` → `概要设计.md` → `04_风险与开放问题.md` §七 + §八 | 30 分钟 |
| **调研人员（深一档）** | `综合调研结论_精简版.md` | 20 分钟 |
| **产品 / PM** | `调研总报告.md` → `概要设计.md` → `02_用例覆盖与API契约.md` | 1 小时 |
| **架构师** | `概要设计.md` → `00_产品愿景与总体架构.md` → `02_用例覆盖与API契约.md` → `01_独立模型应用清单与配置层.md` | 1.5 小时 |
| **开发负责人** | `概要设计.md` → `03_落地路线与工作量.md` → `01_独立模型应用清单与配置层.md` → `技术设计文档.md` §七 | 2 小时 |
| **模型应用工程师**（要新增 voice-* app）| `00_产品愿景与总体架构.md` §1.5 → `技术设计文档.md` §七.0 → §七.1（puller）→ §七.2 / §七.3 范型 → §七.4.3 7 步指引 | 1 小时 |
| **想看具体用例** | 本 README §七 → 跳到对应原课题文档 | 30 分钟 |
