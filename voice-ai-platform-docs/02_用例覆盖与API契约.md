# 用例覆盖与 API 契约

> 本文回答：**核心应用对外暴露哪些 API 端点 / 支持哪些用例 / 每个端点依赖哪些模型层组件**。
> 上游文档 = `00_产品愿景与总体架构.md` 和 `01_独立模型应用清单与配置层.md`。

---

## 一、用例总览

把"语音 AI 平台"应该覆盖的能力按 6 大类组织。**前 3 类是核心**，后 3 类是辅助 / 进阶能力。

| 大类 | 用例数 | 主要价值 |
|---|---|---|
| **A. 转录类** | 5 | 把声音变成文字（文件 / 流式 / 实时）|
| **B. 生成类** | 5 | 把文字变成声音 / 把声音变成另一段内容（TTS / 播客 / 翻译 / 字幕 / 摘要）|
| **C. 会话 / 任务类** | 3 | 端到端任务（会议、长音频、笔记问答）|
| **D. 辅助识别类** | 5 | 单一信号识别（VAD / diarization / 语种 / 关键词 / 对齐）|
| **E. 音频处理类** | 3 | 信号处理（降噪 / 分离 / 嵌入）|
| **F. 配置 / 管理类** | 5 | 用户配置、词典、声纹、模型、历史 |

合计 **26 个用例**。每个用例对应至少一个 API 端点；端点设计在第三章。

---

## 二、用例详表（按大类）

### 2.1 A. 转录类（5）

| # | 用例 | 输入 | 输出 | 任务模式 | 模型层依赖 |
|---|---|---|---|---|---|
| A-1 | **文件转录** | 音频 / 视频文件（最长 3h，<= 2GB）| 文本 + 句级时间戳 + 可选词级 + 可选 diarization | 异步长任务 | STT + 可选 diarization |
| A-2 | **音频翻译** | 同上 + 目标语种 | 目标语种文本 + 时间戳 | 异步长任务 | STT + 翻译（或 LLM）|
| A-3 | **流式 STT** | WebSocket 音频流（PCM/Opus）| 增量文本流 + 最终结果 | WebSocket | 流式 STT（远程 Deepgram / 本地 WhisperLiveKit）|
| A-4 | **实时语音录入**（dictate）| WebSocket 音频流，短句 | 当前一句的最终文本（含标点 / 数字 / 大小写恢复）| WebSocket | 流式 STT + 后处理 LLM 修订（可选）|
| A-5 | **YouTube / URL 转录** | 视频 URL | 同 A-1 | 异步长任务 | yt-dlp 抽音 → STT |

### 2.2 B. 生成类（5）

| # | 用例 | 输入 | 输出 | 任务模式 | 模型层依赖 |
|---|---|---|---|---|---|
| B-1 | **基础 TTS** | 文本 + voice ID + 语种 | 音频文件（mp3/wav/opus）| 同步短任务 | TTS（自家 `voice-tts-kokoro-82m-v2` / 远程 ElevenLabs / OpenAI 等）|
| B-2 | **声音克隆 TTS**（已决策做）| 文本 + 参考音频片段（或已注册 voice_id）| 模仿参考声音的音频 | 同步 / 异步 | TTS 含克隆能力（自家 `voice-tts-cosyvoice-2-v2` / `voice-tts-openvoice-v2-v2` / `voice-tts-spark-tts-v2` / 远程 ElevenLabs / 火山豆包）；与 F-3 声纹注册耦合 |
| B-3 | **多角色播客生成** | 文本稿 / 大纲 + 角色配置（每角色一个 voice_id）| 多角色对话音频 + 章节标记 | 异步长任务 | **主路径** ⭐：自家 `voice-tts-dialogue-moss-ttsd-v1-0-v2`（MOSS-TTSD 一步直出多角色对话音频）；**fallback**：LLM（生成对话）+ TTS 多 voice（含克隆 voice）两步走 |
| B-4 | **字幕生成** | 音视频文件 + 目标语种 | SRT / VTT / TTML 字幕文件 | 异步长任务 | STT + 翻译 + 字幕格式化 |
| B-5 | **AI 摘要 / 章节 / Action Items** | 转录文本（或文件 + 自动转录）| 摘要 + 章节列表 + Action Items + 关键点 | 异步 | LLM（本地 `ollamav2` Qwen / 远程 GPT-4o）；**音频原生路径**走 Audio-LLM（自家 `voice-audio-llm-moss-audio-8b-thinking-v2` ⭐，保留 prosody / 情绪 / 背景声线索）|

### 2.3 C. 会话 / 任务类（3）

| # | 用例 | 输入 | 输出 | 任务模式 | 模型层依赖 |
|---|---|---|---|---|---|
| C-1 | **会议记录会话** | WebSocket 实时音频 OR 上传完整录音 | 实时增量字幕 + 说话人 + 结束后摘要 + Action Items + 章节 | 流式 + 持久化 | 流式 STT + diarization（在线增量）+ LLM 摘要 |
| C-2 | **长音频整理**（个人脑暴 / 日记 / 课堂） | 音频文件 | 转录 + 摘要 + 标签 + 跨笔记搜索索引 | 异步长任务 | STT + LLM + 嵌入 |
| C-3 | **笔记问答（跨笔记 RAG）** | 用户问句 | 答案 + 引用片段 | 同步 | 嵌入检索 + LLM |

### 2.4 D. 辅助识别类（5）

| # | 用例 | 输入 | 输出 | 任务模式 | 模型层依赖 |
|---|---|---|---|---|---|
| D-1 | **VAD（语音活动检测）** | 音频文件或流 | 语音段时间戳 | 流式 / 同步 | VAD（Silero）|
| D-2 | **说话人分离** | 音频文件 | 每段的 speaker label + 时间戳 | 异步 | Diarization（pyannote 等）|
| D-3 | **语种识别** | 音频文件 | top-K 语种 + 置信度 | 同步 | Whisper 或专用语种识别 |
| D-4 | **关键词 / 热词检测** | 音频文件 + 关键词列表 | 命中时间戳 | 异步 | STT + 关键词匹配；或专用 KWS 模型 |
| D-5 | **强制对齐（词级时间戳）** | 音频 + 已知文本 | 每个词的时间戳 | 异步 | wav2vec2 forced alignment |

### 2.5 E. 音频处理类（3）

| # | 用例 | 输入 | 输出 | 任务模式 | 模型层依赖 |
|---|---|---|---|---|---|
| E-1 | **音频降噪 / 增强** | 含噪音频 | 增强后音频 | 异步 | DeepFilterNet / Demucs 等 |
| E-2 | **BGM / 人声分离** | 含背景音音频 | 人声轨 + BGM 轨 | 异步 | UVR / Demucs |
| E-3 | **音频嵌入** | 音频片段 | 向量（用于检索 / 跨笔记 RAG）| 同步 | whisper-encoder / NV-Embed 等 |

### 2.6 F. 配置 / 管理类（5）

| # | 用例 | 输入 | 输出 |
|---|---|---|---|
| F-1 | **配置管理** | 用户配置变更 | 当前生效配置 |
| F-2 | **自定义 ASR 词典** | 术语列表 / 行业词典 | 应用于后续转录 |
| F-3 | **声纹注册 / 管理** | 参考音频 + label | 注册 voice ID（供 B-2 / C-1 用）|
| F-4 | **模型可用性查询** | — | 当前用户可调的所有 (provider, model) |
| F-5 | **任务历史 / 状态** | task_id 或 query | 历史任务列表 + 文稿 + 输出文件 |

---

## 三、完整 API 端点设计

> 全部 OpenAI 兼容部分严格对齐 OpenAI 协议；扩展端点用清晰命名空间。
> 所有响应统一 envelope：`{"status": "ok|error", "data": {...}, "error": {...}}`（OpenAI 兼容端点除外，保持原始格式）。

### 3.1 OpenAI 兼容端点（最大化生态复用）

| 方法 | 路径 | 用例 | 备注 |
|---|---|---|---|
| POST | `/v1/audio/transcriptions` | A-1 | OpenAI Whisper 兼容；扩展字段：`provider`、`enable_diarization`、`word_timestamps`、`output_formats: ["srt","vtt","json"]` |
| POST | `/v1/audio/translations` | A-2 | 同上；翻译路径走 OpenAI 兼容的 "transcribe-then-translate" 风格 |
| POST | `/v1/audio/speech` | B-1 | OpenAI TTS 兼容；扩展字段：`provider`、`voice_id`（声纹库）、`output_format`、`speed` |
| WS | `/v1/audio/realtime` | A-3, A-4, C-1 部分 | 与 OpenAI Realtime API 对齐；按会话 ID 管理 |
| POST | `/v1/audio/voices` / `voices/{id}` | F-3 | OpenAI 风格 voice 管理 |

### 3.2 扩展端点（本平台特有）

#### A 转录类

```
POST   /v1/audio/url-transcribe         # A-5  YouTube / URL 转录
       body: { url, provider?, ... }
       resp: { task_id, status }

GET    /v1/tasks/{task_id}              # 通用任务状态查询
GET    /v1/tasks/{task_id}/result       # 完成后拉结果
```

#### B 生成类

```
POST   /v1/audio/clone                  # B-2  声音克隆 TTS
       body: { text, reference_audio_url, ... }
       
POST   /v1/podcast/generate             # B-3  多角色播客生成
       body: { script | outline, voices: [{role, voice_id}], ... }
       resp: { task_id }

POST   /v1/subtitles/generate           # B-4  字幕生成
       body: { audio_url | file, languages: ["zh","en"], format: "srt" }
       
POST   /v1/analyze/summary              # B-5  摘要 / 章节 / Action Items（文本路径）
       body: { text | task_id, llm_provider?, options: { chapters: true, actions: true } }

POST   /v1/audio/qa                     # ⭐ Audio-LLM 直接喂音频 + prompt（保留 prosody / 情绪 / 背景声）
       body: { audio_url | file, prompt, model? }
POST   /v1/audio/understand             # ⭐ Audio-LLM 音频理解（场景 / 事件 / 音乐 / 复杂推理）
       body: { audio_url | file, task: "scene"|"event"|"music"|"reason", model? }

POST   /v1/audio/dialogue               # ⭐ 2026-05 新增 多角色对话式 TTS（MOSS-TTSD 一步出）
       body: { dialogue: [{role, text}], voices: [{role, voice_id}], model? }
WS     /v1/audio/conversations          # ⭐ 2026-05 新增 真正 S2S（无文本中介，MOSS-Speech 等）
       events: client→server audio chunks; server→client audio + transcript
POST   /v1/audio/soundfx                # ⭐ 2026-05 新增 文生音效（MOSS-SoundEffect 等弱档候选）
       body: { text, duration_s?, model? }
       resp: audio/wav | audio/mp3
```

#### C 会话 / 任务类

```
POST   /v1/meeting/sessions             # C-1  开始会议会话
       resp: { session_id, ws_url }
       
WS     /v1/meeting/sessions/{id}/stream # C-1  会议实时音频流
       
POST   /v1/meeting/sessions/{id}/end    # C-1  结束会议
       resp: { transcript, summary, actions, chapters }

POST   /v1/notes/ingest                 # C-2  长音频整理入库
POST   /v1/notes/qa                     # C-3  跨笔记问答
       body: { query, scope: { tags?, time_range? } }
```

#### D 辅助识别类

```
POST   /v1/audio/vad                    # D-1
POST   /v1/audio/diarize                # D-2
POST   /v1/audio/detect-language        # D-3
POST   /v1/audio/keywords               # D-4
POST   /v1/audio/align                  # D-5
```

#### E 音频处理类

```
POST   /v1/audio/denoise                # E-1
POST   /v1/audio/separate               # E-2
POST   /v1/audio/embeddings             # E-3
```

#### F 配置 / 管理类

```
GET    /v1/config                       # F-1
PUT    /v1/config/providers
PUT    /v1/config/models/{usecase}
PUT    /v1/config/preferences
POST   /v1/providers/test/{provider}

GET    /v1/dictionaries                 # F-2
POST   /v1/dictionaries
DELETE /v1/dictionaries/{id}

GET    /v1/voices                       # F-3 （也归 OpenAI 兼容）
POST   /v1/voices
DELETE /v1/voices/{id}

GET    /v1/models/available             # F-4
GET    /v1/tasks                        # F-5  任务历史列表
GET    /v1/tasks/{id}/logs
```

### 3.3 通用请求格式约定

- 所有 STT 端点都支持以下**三种音频输入方式**：
  - `multipart/form-data` 上传文件
  - JSON body 里给 URL（`audio_url`）
  - JSON body 里给 base64（不推荐，仅短音频）
- 所有端点都支持 **per-call provider override**：在 body / header 里加 `provider` 和 `model`
- 长任务端点都返回 `task_id`，统一在 `/v1/tasks/...` 下查状态
- Webhook：用户可配 `webhook_url`，任务完成时回调

### 3.4 错误码

按 OpenAI 风格 `error.type`：
- `invalid_request_error`（400）
- `authentication_error`（401，BYOK key 错）
- `permission_denied`（403）
- `not_found`（404）
- `rate_limit_exceeded`（429）
- `provider_error`（502，远程 API 出错）
- `provider_unavailable`（503，本地模型应用未启动）
- `task_too_large`（413）

---

## 四、英文/中文/实时性的端点级落实

按愿景的"英文 → 中文 → 实时性"优先级，**每个端点的默认模型**预填如下（用户可在配置中心覆盖）：

| 端点 | 默认 primary（英文最佳）| 默认 fallback | 中文增强默认（已决策）|
|---|---|---|---|
| `/v1/audio/transcriptions` | 自家 `voice-stt-whisperx-large-v3-v2`（WhisperX large-v3）| 现有 `speaches`（faster-whisper-small）→ OpenAI Whisper API | 自家 `voice-stt-sensevoice-small-zh-v2`（SenseVoice）→ **Qwen3-ASR 远程** |
| `/v1/audio/translations` | 自家 `voice-stt-whisperx-large-v3-v2` + 自家 `voice-translate-madlad-400-3b-v2`（主翻译路径走 `ollamav2` LLM）| OpenAI / DeepL | 自家 + **Qwen3 LLM 翻译** |
| `/v1/audio/realtime` | Deepgram Nova-3 远程 | 自家 `voice-stt-live-voxtral-realtime-3b-v2` / `voice-stt-live-whisperlive-large-v3-turbo-v2` | **Qwen3-ASR 流式** → 火山豆包 → 阿里 NLS |
| `/v1/audio/speech` | 自家 `voice-tts-kokoro-82m-v2` | OpenAI TTS | 火山豆包 TTS / 阿里 TTS |
| `/v1/audio/clone` (B-2 声音克隆) | 自家 `voice-tts-cosyvoice-2-v2` | 远程 ElevenLabs | 自家 `voice-tts-openvoice-v2-v2` / `voice-tts-spark-tts-v2` / 远程火山豆包 |
| `/v1/audio/diarize` | 自家 `voice-diar-pyannote-community-1-v2`（pyannote community-1，开源默认）| 现有 `whisperwebuiv2`（pyannote 3.1）/ 自家 `voice-diar-pyannote-3-1-v2` ⚠ 需 HF_TOKEN | 自家 `voice-diar-3dspeaker-eres2net-v2`（中文友好）|
| `/v1/analyze/summary` | 本地 `ollamav2`（Qwen3-14B）| OpenAI / DeepSeek | Qwen3 中文加强 |
| `/v1/audio/qa` / `/v1/audio/understand` ⭐ Audio-LLM | 自家 `voice-audio-llm-moss-audio-8b-thinking-v2` / `voice-audio-llm-moss-audio-8b-instruct-v2` | 自家 `voice-audio-llm-moss-audio-4b-{thinking,instruct}-v2` / `voice-audio-llm-moss-music-8b-*` / `voice-audio-llm-audio-flamingo-next-8b-v2` / `voice-audio-llm-step-audio-r1-1-v2` | 远程 Qwen3-Omni / Gemini-3-Pro audio / GPT-4o Audio / 闭源 Qwen3.5-Omni Plus/Flash/Light |
| `/v1/audio/dialogue` ⭐ 2026-05 多角色对话 TTS | 自家 `voice-tts-dialogue-moss-ttsd-v1-0-v2`（一步直出）| 退化为 LLM 生成对话 → 多 voice TTS 拼接两步走 | 远程 NotebookLM 等 |
| `/v1/audio/conversations` ⭐ 2026-05 真正 S2S（WS）| 自家 `voice-audio-s2s-moss-speech-v2`（OpenMOSS True S2S，无文本中介）| `voice-audio-s2s-moss-speech-codec-v2`（codec 配对）| 远程 OpenAI gpt-realtime-2 / Step-Audio 2.5 Realtime / 闭源 Qwen3.5-Omni Realtime |
| `/v1/audio/soundfx` ⭐ 2026-05 文生音效 | 自家 `voice-soundfx-moss-soundeffect-v2-0-v2`（弱档候选）| — | 远程 ElevenLabs Sound Effects / Stable Audio |

> 默认配置在第一次启动时由核心应用自动写入；用户可改。
> "自家"指本平台规划的应用矩阵（待新建）；"现有"指 Olares 已上架应用（短期借力 / 长期解耦）；**"Qwen3-ASR / Qwen3 LLM 翻译"是国内 ASR / LLM 的最优先 BYOK 默认**。

---

## 五、与 OpenAI / Auralwise 的兼容性对照

**两套形态并存**（本平台 API 设计的关键决策，已据 2026-05 实际形态核校）：

- **OpenAI 兼容形态**（同步 / 流式 / 短任务）—— 对接已有 OpenAI 客户端代码。例：`POST /v1/audio/transcriptions`（同步返回文稿）、`WS /v1/realtime`（流式 voice agent）
- **AuralWise 风格异步任务形态**（长任务 / 批量 / 含说话人 / 含事件 / 含 LLM 后处理）—— 提交 → 拉取或 Webhook 回调。例：`POST /v1/tasks` → `GET /v1/tasks/{id}/result`

> AuralWise 实际形态（2026-05 核验，来源 `https://api.auralwise.cn/v1`）：
> - 基础 URL：`https://api.auralwise.cn/v1`，**纯异步任务模式**
> - 流程：`POST /tasks`（audio_url 或 audio_base64，含 options + callback_url + callback_secret + batch_mode）→ 返回 task_id → `GET /tasks/{id}` / `GET /tasks/{id}/result`
> - Webhook 签名：`X-Webhook-Signature: sha256=HMAC-SHA256(secret, body)`
> - 输入限制：audio_url 5h / 2GB；audio_base64 单次 20MB；支持 ASR / VAD / diarize / audio_events / 各类 options
>
> 本平台与之对齐的关键设计：① 任务模型同形；② Webhook 签名相同；③ `options` 字段统一在 body 里；④ 大文件用 audio_url；⑤ 额外提供 OpenAI 兼容路径作短任务出口。

| 兼容目标 | 本平台对应方式 |
|---|---|
| **OpenAI SDK 任何语言的 client** | 通过 `/v1/audio/transcriptions`、`/v1/audio/speech`、`/v1/audio/translations`、`/v1/audio/realtime` 直接对接，只需切 baseURL |
| **OpenAI Realtime API**（流式语音对话；2026-05-07 三模型大更新）| `/v1/realtime` WebSocket 对齐协议；并对齐 `gpt-realtime-2`（S2S）/ `gpt-realtime-whisper`（流式 ASR）/ `gpt-realtime-translate`（实时翻译）三个 model 标识 |
| **Auralwise 多用例 API** | 扩展端点 `/v1/meeting/*`、`/v1/podcast/*`、`/v1/subtitles/*`、`/v1/notes/*`；总线为 `POST /v1/tasks` + Webhook 回调（签名形式与 AuralWise 一致）|
| **Deepgram SDK**（如果用户已有 Deepgram 代码） | BYOK 直接转发；可选 "Deepgram 兼容路径" `/v1/listen`（Nova-3 协议）和 `/v2/listen`（Flux 协议），可后期加 |
| **AssemblyAI SDK**（如果用户已有 AssemblyAI 代码） | BYOK 转发；可选 `/v2/transcript` 兼容路径 |

---

## 六、安全 / 鉴权

| 主体 | 方式 |
|---|---|
| **Olares 用户登录态** | 通过 LarePass / Olares Auth；核心应用从 sharedEntrance 获取 `bfl.username` |
| **外部应用 / 客户端调 API** | OAuth 2.0 + 用户在核心 Web UI 里生成 personal access token |
| **OpenAI SDK 调用** | 沿用 OpenAI 风格的 `Authorization: Bearer <token>` |
| **远程 API key 存储** | Olares 集群密钥加密 + 不出集群 |

---

## 七、本章结论

1. **26 个用例**覆盖了从单点能力（VAD / TTS）到端到端任务（会议 / 播客 / 长音频整理）的全谱系。
2. **API 设计 = OpenAI 兼容为底 + 扩展端点为面**：任何 OpenAI SDK 都能直接接；同时不被 OpenAI 协议限制能力。
3. **默认配置 = 英文最优 + 中文可选增强 + 实时性优先**——与产品愿景对齐。
4. **per-call override + 配置中心**让用户可以在任何粒度切换 provider，不需要重启 / 重配。
