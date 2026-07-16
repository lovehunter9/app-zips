# Whisper-WebUI STT 质量优化与 API 完整使用指南

> 部署目标：Helm Chart `whisperwebuiv2`（本开发版，**尚未发布到 Olares 商店**）  
> 上游基础镜像：`beclab/harveyff-whisper-webui:v1.0.7`
>
> **版本说明**：本文仅涉及两个状态——
> - **基线版本**：Olares 商店当前上线的 `whisperwebuiv2 v1.0.7`（本开发版改造的起点，仅含 Whisper-WebUI 上游原生能力，无质量层与 API 层增强）  
> - **本开发版**：在基线之上叠加了质量层改造（Batched + 引擎 Monkey-Patch + UI 持久化）与 API 层扩展（11 个端点）两部分增强，**当前仅在开发/测试环境，未发版到商店**  
>
> 文中所有"基线 → 本开发版"的对比都指这两个状态间的差异；改造过程中的内部迭代不作为独立版本呈现，**`v1.0.7` 是本文唯一会提及的版本号**。

## 本开发版核心能力速览

相对基线版本（vanilla Whisper-WebUI），本开发版叠加了两类增强：

### A. 质量层（引擎与持久化改造）

- **Batched Inference Pipeline**（WhisperX 风格 VAD Cut & Merge + 批量并行）：根治长音频后半崩坏，64 min 英文样本 4m11s → **55s**（加速 **4.57×**），4 类引擎级灾难性失败（跨语言污染 / 整段编造 / 段内重复 / 单词丢失）在实测中全部消失。详见 1.1.2 节。
- **引擎级 Monkey-Patch（4 项）**：在 `_patch_whisper_engine()` 中包装 `WhisperModel.transcribe`，同时作用于 WebUI 与 API：
  1. Batched 路由开关（决定走 Batched 还是 Buffered）
  2. 温度回退列表（恢复 Whisper 原生 5 档回退机制，绕开 Gradio Slider 只能给单值的限制）
  3. 自动 Initial Prompt 注入（用户不填时按语言自动注入风格提示）
  4. 后处理流水线（Text Cleaning 重复循环去除 + 中文标点全角化 / Segment Merging 短段合并）
- **三个用户可勾选开关**：`Batched Inference`（默认开）+ `Text Cleaning`（默认开）+ `Segment Merging`（默认开）。三个开关均跨 Pod 重启、跨 Chart 升级、跨浏览器刷新持久化。
- **基础设施稳定性修复**：
  - GPU 显存累积泄漏：`BatchedInferencePipeline` 缓存改单槽 + 显式 `gc.collect()` + `torch.cuda.empty_cache()`，根治"连续转录数次后 OOM"
  - 浏览器刷新 UI rehydrate：`demo.load()` 每次刷新按最新 yaml 重新 hydrate 所有 pipeline 组件
  - yaml 并发读写竞态：`threading.Lock` + dict 类型校验，根治快速勾选 checkbox 引发的 `TypeError`

### B. API 层（OpenAI 兼容 API 全量开放）

- **端点从 4 个扩到 11 个**：覆盖上游 Whisper-WebUI 全部可用能力。详见 §2.3：
  - **音频转录** `POST /v1/audio/transcriptions`：基线已有，本开发版补全到 59 个 Form 参数（含 OpenAI 官方兼容字段 `timestamp_granularities[]`）
  - **YouTube URL 转录** `POST /v1/audio/transcriptions/youtube` + `GET /v1/youtube/metadata`：直接传链接，服务端 `pytubefix` 抓音频
  - **音频翻译** `POST /v1/audio/translations`：基线只暴露 OpenAI 公开的 5 个字段，本开发版**对齐转录端点的 59 个参数**（内部强制 `task=translate`），长音频翻译可与转录一致地调优 Batched / VAD / Diarize
  - **NLLB 文本/字幕翻译** `POST /v1/text/translations/nllb` + models + languages：Facebook NLLB-200 在本地 GPU 翻译，支持约 200 种语言
  - **DeepL 文本/字幕翻译** `POST /v1/text/translations/deepl` + languages：转发到 DeepL 云端 API（调用方携带 `auth_key`，服务端不落盘）
- **内部重构**：抽出 `_do_transcribe` 共享引擎驱动 + `_transcribe_form_params` Depends 依赖，三个音频端点（上传转录 / YouTube 转录 / 上传翻译）共享同一份参数签名与流水线代码，杜绝行为漂移。

> 改造过程中曾尝试 LLM 后处理校对（Qwen2.5-3B GGUF），实测中文 11× 耗时 + 5+ 事实幻觉、英文 8.6× 耗时 + 30+ 处元评论泄漏，已在改造期间撤回并删除相关代码与依赖。详情见配套报告。

---

## 一、STT 质量优化

### 1.1 已自动生效的优化（部署即生效）

我们通过两层机制优化 WebUI 和 API 的转录质量：

1. **`_QUALITY_OVERRIDES` PATCH**（6 个参数）：写入 `default_parameters.yaml`，修改 WebUI 的默认配置
2. **`_patch_whisper_engine()` 引擎级 Monkey-Patch**（**4 项**）：直接包装 `WhisperModel.transcribe`，对 WebUI 和 API **同时生效**
   - **★ Batched Inference Pipeline（WhisperX 式 VAD Cut & Merge）**：把长音频用 VAD 切成独立 chunk 后批量并行解码——根治"长音频后半崩坏"的引擎层问题，3-5× 加速
   - **温度回退列表**：将用户填写的单一温度值自动扩展为回退列表，恢复 Whisper 原生的反循环机制
   - **自动 Initial Prompt 注入**：根据语言自动注入合适的提示词（用户已填写时跳过）
   - **段落后处理流水线**（默认开，可勾选关闭）：`Text Cleaning`（重复循环去除 + 中文标点全角化）+ `Segment Merging`（短段/不完整段合并）

以下分四部分说明：
- **1.1.1** — PATCH 修改的 6 个参数
- **1.1.2** — 引擎级 Monkey-Patch 的 4 项增强（Batched 路由 + 温度回退 + 自动 Prompt + 后处理流水线）
- **1.1.3** — 与质量密切相关但保持镜像默认值的参数
- **1.1.4** — API 层独有的自动语言检测 + 智能提示词

#### 1.1.1 PATCH 修改的参数（6 个）

修改原则：**只在基础官方镜像默认值确实不适合的地方动手，其余全部保持镜像默认值。**

以下"镜像默认值"均指 `configs_default/default_parameters.yaml`（即 Whisper-WebUI 官方镜像内置的原始配置）。

##### `temperature = 0.2`（镜像默认：`0`）

**作用**：解码采样温度。`0` 表示纯贪心解码（永远选概率最高的 token），> 0 引入随机性。

**为什么从 0 改为 0.2**：

镜像默认的 `temperature=0` 在长音频上几乎必然触发**灾难性重复循环**——15 轮实测中 #1 / #2（中文）、#8（英文）均复现，模型在某一 segment 卡死，反复输出同一句话直到截断。原因是贪心解码遇到模型不确定的位置时，会反复选同一个 "最稳" 的 token，循环就形成了。

`0.2` 是经实测验证的最低安全温度，足以打破循环但**不引入可感知的随机性**：

| 温度 | 中文（流浪地球）| 英文（福尔摩斯）|
|---|---|---|
| `0` | ❌ 2 处灾难循环 | ❌ 6 处灾难循环 |
| `0.2`（当前值） | ✅ 无循环、质量最佳 | ✅ 无循环、质量良好 |
| `0.4` | ✅ 无循环，但巨峰→飓风等错误回归 | ❌ 2 处超长循环 + 幻觉、耗时 ×3 |
| `1.0` | 随机性过高，无意义 | 同左 |

**与引擎级温度回退的协同**：PATCH 把 Slider 初始值设为 `0.2`，**引擎级 Monkey-Patch** 进一步在调用时将其自动展开为回退列表 `[0.2, 0.4, 0.6, 0.8, 1.0]`（详见 1.1.2 节）。也就是说：
- 首轮采样用 `0.2`（即"几乎贪心 + 极小扰动"）
- 如果输出未通过质量检查（`compression_ratio_threshold` 或 `log_prob_threshold`），自动升温重试

如果用户手动把 Slider 拉到 `0`，引擎级 patch 会展开为 `[0, 0.2, 0.4, ...]`——首轮仍是贪心，但有完整的回退兜底；本质行为接近 OpenAI 官方推荐值。

> **WebUI 对应设置**：Whisper 区域 → Temperature → 保持 `0.2`（PATCH 默认值）

##### `condition_on_previous_text = False`（镜像默认：`True`）

**作用**：控制是否将前一个 segment 的转写文本作为下一个 segment 的解码上下文。

**为什么改为 False**：

作为 PATCH 默认值，False 是对中英文两种语言的**折中安全选择**。详细的语言差异如下：

**中文实测（流浪地球有声书）**：

| condition | temperature | 结果 |
|---|---|---|
| True | 0 | 两处灾难循环（与 temperature=0 共同导致） |
| True | 0.2 | **中文最佳**——无循环、文风一致、专有名词稳定 |
| False | 0.2 + rep=1.1 + ngram=5 | 极度碎片化、繁简混用、人名不一致 |

中文场景下 `True` 配合 `temperature=0.2` 是最佳选择。True 提供的跨 segment 上下文帮助模型保持专有名词一致性（如始终输出"小星老师"而非交替出现"小星/小青"）和文风连贯性。

**英文实测（福尔摩斯有声书，1 小时）**：

| condition | temperature | 其他参数 | 结果 |
|---|---|---|---|
| True | 0.2 | 无 prompt | 无循环但**全大写**——音频开头的标题朗读 "THE ADVENTURES OF..." 的大写风格被 True 传播到全文 |
| True | 0.2 | 英文 initial_prompt | "The E-G." ×1000+ 灾难循环，耗时 19m53s |
| False | 0.2 | 无 | 6 处灾难循环 |
| False | 0.2 | rep=1.1 + ngram=5 | **英文最佳**——无循环、大小写正常、全程完整 |

英文场景下 `True` 的**风格传播**特性是双刃剑——不仅传播错误，还会传播大写风格。英文更适合 `False`，但需要配合 `repetition_penalty` + `no_repeat_ngram_size` 防止循环。

**设为 False 的代价**：每个 segment 独立解码，段间文风一致性会稍差（如前后 segment 对同一专有名词可能有不同的拼写）。

**对标点的影响**：`condition_on_previous_text=False` 本身**不会导致中文标点消失**（中文实测验证）。中文标点消失是 hotwords 机制的问题（详见 1.3 节）。

**当前 PATCH 选择 False 的理由**：作为不区分语言的统一默认值，False 避免了 True 在英文场景下的全大写风格传播和跨 segment 错误传播问题。中文用户如果追求最佳效果，可以手动改回 True 并将 temperature 设为 0.2（详见下文 temperature 章节的实测数据）。

> **WebUI 对应设置**：Whisper 区域 → Condition on Previous Text → **取消勾选**（PATCH 默认值）
>
> **中文用户进阶建议**：如果主要处理中文音频，可以勾选此项（改为 True），但**务必同时将 Temperature 设为 0.2**。`True + temperature=0` 会导致灾难循环。

##### `hallucination_silence_threshold = 2`（镜像默认：`None`，即关闭）

**作用**：当模型检测到转写文本对应的音频区间中存在超过 N 秒的静音段时，判定为可能的幻觉输出，跳过该段。

**为什么设为 2**：

- **中文实测（流浪地球有声书、播客等）**：2 秒是在"误杀正常内容"和"放过幻觉"之间的最佳平衡点。有声书和播客中的自然停顿通常 < 2 秒，而幻觉对应的静音段通常 > 2 秒。
- **英文（福尔摩斯有声书）**：英文朗读的停顿模式类似，2 秒同样适用。

**与 `condition_on_previous_text=False` 配合**：这两个参数构成**双层防幻觉机制**——前者切断错误传播链，后者在单 segment 层面拦截幻觉输出。

**调整影响**：

| 值 | 效果 |
|---|---|
| **None / 0**（关闭） | 幻觉检测完全失效，静音段可能产生大量垃圾输出 |
| **< 1** | 过于灵敏，正常说话停顿可能被误判为幻觉，导致内容丢失 |
| **2**（当前值） | 平衡点。中英文有声书 / 播客场景实测最优 |
| **3 ~ 5** | 更宽容，仅拦截较长静音段的幻觉。对语速慢的演讲更友好，但会放过短静音段幻觉 |

> **WebUI 对应设置**：Whisper 区域 → Hallucination Silence Threshold → 填入 `2`

##### `vad_filter = True`（镜像默认：`False`）

**作用**：启用 Silero VAD（Voice Activity Detection），在送入 Whisper 前先对音频做语音 / 非语音分段，只有检测到语音的片段才会被转录。

**为什么开启**：

- 大幅减少模型在静音段产生幻觉的概率
- 跳过无语音片段，提升处理速度
- 对中英文均有正面效果，无明显副作用

**如果关闭**：Whisper 会对整段音频（含静音）做转录，静音段容易产生幻觉文本（如反复输出"谢谢收看"、"Thanks for watching"之类的无中生有内容）。

> **WebUI 对应设置**：VAD 区域 → VAD Filter → **勾选**

##### `min_silence_duration_ms = 500`（镜像默认：`1000`）

**作用**：VAD 检测到多长的静音即视为"断句点"，将前后音频切分为不同 segment。

**为什么从 1000 改为 500**：

- 镜像默认 1000ms 偏长，会把多个短句合并成一大段，导致 segment 过长
- 500ms 能在自然断句处切分，生成的 segment 长度更合理，字幕效果更好
- 中英文均适用

**调整影响**：

| 值 | 效果 |
|---|---|
| **< 300** | 过于灵敏，可能在句内自然停顿处误切，导致 segment 碎片化 |
| **500**（当前值） | 适合大多数有声书 / 播客 / 会议场景 |
| **1000 ~ 2000** | 切分更保守，segment 较长。适合语速慢、停顿长的演讲 |
| **> 2000** | 极少切分，segment 可能非常长 |

> **WebUI 对应设置**：VAD 区域 → Min Silence Duration (ms) → 填入 `500`

##### `speech_pad_ms = 400`（镜像默认：`100`）

**作用**：VAD 切分语音段后，在每段语音的前后各扩展 N 毫秒的音频填充，避免语音起止被截断。

**为什么从 100 改为 400**：

- 镜像默认 100ms 过短，可能导致句首和句尾的音被截断，影响转录完整性
- 400ms 能确保自然语音的起止过渡被完整保留，不影响转录质量

**调整影响**：

| 值 | 效果 |
|---|---|
| **< 100** | 填充过少，语音首尾可能被截断，丢失起止音节 |
| **100**（镜像默认） | 对快语速基本够用，但慢语速或带气息的开头可能被截 |
| **400**（当前值） | 充分保留语音起止，适合大多数场景 |
| **> 600** | 填充过多，可能引入相邻段的噪声或语音片段 |

> **WebUI 对应设置**：VAD 区域 → Speech Pad (ms) → 填入 `400`

#### 1.1.2 引擎级 Monkey-Patch（4 项，WebUI + API 同时生效）

通过 `_patch_whisper_engine()` 直接包装 `WhisperModel.transcribe`，在引擎层面增强转录质量。由于 WebUI 和 API 共享同一个模型实例，这些增强对两个入口**同时生效**。

##### ★ Batched Inference Pipeline（WhisperX 式 VAD Cut & Merge）

> **中英 6 轮对照测试已确认**：这是当前应用对长音频质量的**最大单一改进**。详细对照数据见附录 A.2。

**它解决的问题**：

Whisper 原生使用 30 秒滑动 buffer 处理长音频——每段转录的结果会作为下段的解码上下文（`condition_on_previous_text=True`）。在长音频（> 30 分钟）上这会导致**累积性后半崩坏**：

- 某一段输出污染（误识别、幻觉、跨语言字符）会被传播给下一段作为 prompt
- 下一段继续放大该污染，直到模型完全失控
- 实测在 64 分钟英文有声书上后半段出现**整段编造对话、韩/日/中/西语字符混入、现代俚语和脏话**

**关掉 `condition_on_previous_text`（设为 False）治标不治本**：模型仍会在 30s buffer 内不断"看到自己之前 5-25 秒的解码结果"，且失去了上下文反而更容易循环。15 轮中英文实测中 `False + temperature=0.2` 仍出现 6 处灾难循环（详见附录 A.1 #8）。

**正确解法（WhisperX 路线）**：

1. **先用 Silero VAD 把整段音频切分成独立 chunk**（按真实的句子边界，不是 30s 硬切）
2. **每个 chunk 独立、并行解码**（GPU batch_size=16，速度 3-5× 提升）
3. **chunk 之间无上下文传递**——污染无法跨 chunk 累积

**实现**：直接接入 `faster-whisper` 官方的 `BatchedInferencePipeline`（这是 faster-whisper 内置的 WhisperX 等价实现）。检测到 Batched 模式时，把所有调用转发给 `BatchedInferencePipeline.transcribe()`。

**实测对照（64 分钟英文福尔摩斯有声书）**：

| 配置 | 耗时 | RTFx | 后半崩坏 | 跨语言污染 | 整段编造 |
|---|---|---|---|---|---|
| Buffered + 全后处理（旧默认）| 4m 11s | 15.3× | ❌ 严重 | ❌ 韩/中/日/西语 + 脏话 | ❌ 至少 4 处 |
| **Batched + 全后处理（新默认）** | **55s** | **70×** | ✅ 无 | ✅ 无 | ✅ 无 |

**速度提升 4.57×**，且**质量从灾难变可用**。中文 12 分钟样本同测试加速 2.9×（音频太短，VAD/Silero 启动开销占比偏高）。

**短音频规律实测（收尾验证套件 / 关后处理对照）**：

为补齐"短音频是否退步"这一原计划但未完成的实验项，本开发版收尾阶段跑了 10s / 30s / 1min / 3min / 5min × 中英文一共 10 个 clip × Batched/Buffered = 20 次受控对照（`text_cleaning=false` + `segment_merging=false`，只看引擎层差异）。结论清晰：

| 时长 | 中文 加速比 (Buf/Bat) | 英文 加速比 (Buf/Bat) |
|---:|---:|---:|
| 10 s | 0.77× ⚠️ | 0.99× |
| 30 s | 1.04× | 1.14× |
| 1 min | 1.26× | 1.48× |
| 3 min | 1.75× | 2.02× |
| 5 min | 1.85× | 2.09× |

**规律**：

- **< 30 s 短音频**：Batched 的 Silero VAD 启动 + Pipeline 构建固定开销 ≈ 100-200 ms，对极短 clip 来说占比过高，**反而比 Buffered 慢**——10 秒中文样本上 Batched 慢了 30%。
- **30 s 持平、1 min 起反超**：30 秒是分水岭；1 分钟起 Batched 收益开始显著（1.26-1.48×）。
- **3-5 分钟后收益饱和到 ~2×**：受限于 16 GiB GPU 的 batch_size=16；论文里大显存 + batch=32 可逼近 11.8×。

**何时不要开 Batched（明确建议）**：

- 处理大量 30 秒以内的短 clip 时（如对话系统的实时回应、短录音批处理）——建议显式 `batched=false`，省那 30% 启动开销
- 单次仅处理 1 个 < 30 s 的片段且关注延迟——同上
- 本节后文还会提到的几个场景（专有名词跨片漂移敏感、需要 `prefix`/`clip_timestamps` 等）

**长音频复测（同期收尾验证，关后处理，引擎层纯对照）**：

为复测 `clip_timestamps` 修复后 Batched 路径在真实长样本上是否仍按预期工作，跑了：

| 音频 | 时长 | Buffered | Batched | 加速比 | `_meta.path` |
|---|---:|---:|---:|---:|---|
| 流浪地球02·中文 | ~14 min | 27.6 s | 14.8 s | **1.87×** 🚀 | `batched` ✓ |
| 福尔摩斯·英文 | ~59 min | 2 m 00 s | 60.0 s | **2.01×** 🚀 | `batched` ✓ |

加速比看起来比主体实测（英文 64 min 4.57×、中文 12 min 2.9×）低，是因为：

1. **该复测关掉了后处理**（`text_cleaning=false` + `segment_merging=false`），只看引擎层差异；主体实测是含后处理的端到端对照
2. **该复测的 Buffered 路径"运气好"**——没遇到主体实测在 64 min 英文上观察到的 4 类灾难性失败（跨语言污染 / 整段编造 / 段内重复 / 单词丢失）；那些灾难发生时 Buffered 会大量在 hallucination loop 上耗时，让 4.57× 这个比值看起来格外悬殊

两组数据**互不冲突**：4.57× 是"灾难场景下"的端到端用户视角；2.01× 是"幸运场景下"的纯引擎对照。Batched 在长音频上稳定 2× 起跳，遇到 Buffered 灾难场景能拉到 4×，这是它的真实价值面。

**Batched 模式下哪些参数会被静默忽略**：

代码层（API 路径）实际丢弃的清单（来源：`api-proxy-configmap.yaml` 的 `_BATCHED_DROPPED_KWARGS` frozenset，以及 `_patched_transcribe` 内对 `temperature` 列表的折叠）：

| 参数 | Batched 模式下 | 备注 |
|---|---|---|
| `condition_on_previous_text` | **强制 `False`**（被 drop）| 设计决定，chunk 间无上下文。响应 `_meta.batched_dropped_kwargs` 里能验证到 |
| `prompt_reset_on_temperature` | **忽略**（被 drop）| 无温度回退机制 |
| `hallucination_silence_threshold` | **忽略**（被 drop）| 由 VAD 切片代替 |
| `vad_filter` | **忽略**（被 drop）| 替换为 BatchedInferencePipeline 内部自带的 Silero VAD |
| `vad_parameters` | **忽略**（被 drop）| 同上——**用户传入的 VAD 阈值/min_silence 等 7 个字段都不会生效** |
| `temperature`（列表）| **取第一个值** | Batched 不做回退；列表 `[0.2, 0.4, ...]` 收敛到标量 `0.2` |
| `initial_prompt` | ✅ 仍生效 | 用作每个 chunk 的初始 prompt |
| `hotwords` | ✅ 仍生效 | 同上 |
| `beam_size` / `best_of` / `patience` / `length_penalty` / `repetition_penalty` / `no_repeat_ngram_size` / 各阈值 | ✅ 仍生效 | 各 chunk 内部仍走 beam search + 质量阈值 |
| `prefix` | ⚠️ 透传给 `BatchedInferencePipeline.transcribe()` | 不在 `_BATCHED_DROPPED_KWARGS` 里——但 BatchedInferencePipeline 内部的 chunk 独立解码语义与 `prefix` 设计意图（强制开头）有冲突，实际效果以 faster-whisper 内部行为为准；不建议依赖 |
| `clip_timestamps` | ⚠️ 透传（已由 API 层 normalize 为 list[float]）| 收尾修复前会导致 `TypeError: string indices must be integers, not 'str'` → Batched 静默 fallback 到 Buffered，现已修复。详见附录 A.3 |

**Batched 副作用**：

- ❌ **跨 chunk 专有名词漂移**：同一专有名词在不同 chunk 各自被模型独立猜测一遍，可能出现 `Armstein / Armstrong` 两种写法。但代价远小于 Buffered 模式的整段崩坏。
- ❌ **静默 chunk 的 YouTube boilerplate 幻觉**：演讲/朗读的长气声/段落转换处若被 VAD 切成内容近静音的 chunk，模型可能回退到训练集偏置输出（`Thank you for watching` / `Please subscribe`）。实测 64 min 英文音频出现 1 处。

→ **缓解方案**：用 `initial_prompt` / `hotwords` 注入专有名词列表能直接救掉跨 chunk 漂移（详见 1.2.2 / 1.2.3 节）；boilerplate 幻觉计划在后续版本通过黑名单消除。

> **WebUI 对应设置**：高级参数区底部 → **Batched Inference (WhisperX-style)** 复选框 → **默认勾选**
>
> **API 对应参数**：`/v1/audio/transcriptions` 传 `batched=true` / `batched=false`（默认值跟随 WebUI 当前勾选状态；可 per-request 覆盖且不影响持久化）
>
> **何时关掉 Batched**：
> - 你需要 segment 之间的语义连贯性（如有声书人物名一致性）超过短期速度收益——但代价是接受长音频后半崩坏风险
> - 你需要传 `prefix` / `clip_timestamps` 等 Batched 不支持的参数
> - 在排查问题时想要切回 Whisper 经典行为做对照
>
> 关闭 Batched 后会自动回到 Buffered 路径，且温度回退、自动 Prompt、后处理流水线**全部仍然生效**——三者是独立维度。

##### 温度回退列表（Temperature Fallback）

**解决的问题**：WebUI 的 Gradio Slider 只能接受单个浮点数，导致 Whisper 原生的温度回退机制失效。`temperature=0` 在长音频上几乎必然触发灾难性重复循环（15 轮实测确认）。

**实现方式**：拦截传给 `WhisperModel.transcribe` 的 `temperature` 参数。如果是单个浮点数，自动扩展为以该值为起点的回退列表：

| 用户设置 | 实际传给引擎的值 |
|----------|----------------|
| `0` | `[0, 0.2, 0.4, 0.6, 0.8, 1.0]`（完整 Whisper 默认） |
| `0.2`（PATCH 默认 Slider 值） | `[0.2, 0.4, 0.6, 0.8, 1.0]` |
| `0.5` | `[0.6, 0.8, 1.0]`（外加 `0.5` 起点） |
| `1.0` | `[1.0]`（无回退） |
| API 传入的列表 | 原样传递（不修改） |

**效果**：Whisper 先用列表中第一个温度转录每个 segment；如果输出未通过质量检查（`compression_ratio_threshold` 或 `log_prob_threshold`），自动用下一个温度重试。这是 Whisper 设计的核心反循环机制，现在 WebUI 也能完整使用。

> **用户操作**：Temperature 滑块保持 PATCH 默认 `0.2` 即可（已通过 1.1.1 节的 PATCH 写入 yaml）。想要更随机的输出可以拖高；想要更"贪心"的首轮采样可以拉到 `0`，回退列表仍会兜底。

##### 自动 Initial Prompt 注入

**解决的问题**：API 端有自动语言检测 + `initial_prompt` 注入（`_LANG_PROMPTS`），但 WebUI 用户不填 prompt 时什么引导都没有，影响输出质量（尤其英文会出现全大写等风格问题）。

**实现方式**：在引擎层检查 `initial_prompt`——如果未提供且 `language` 已指定，自动注入对应语言的提示词。

| 场景 | 行为 |
|------|------|
| 用户在 WebUI 选了语言但没填 Initial Prompt | 自动注入（如英文注入 "The following is a conversation in English with proper punctuation."） |
| 用户填了自己的 Initial Prompt | 跳过，尊重用户填写 |
| API 调用已设置 prompt | 跳过（API 端点在调用 transcribe 前已经设置了 initial_prompt） |

##### 段落后处理流水线

Whisper 吐出来的 segment 在送给用户前会经过一个**流式两阶段后处理流水线**（`_text_clean_segments` → `_merge_short_segments`），每个 segment 处理完立即向下游产出，不会阻塞 UI 的进度条。

两个阶段是**独立可控**的后处理开关，对应 WebUI 高级参数区的两个复选框、以及 API 的两个 Form 参数。

| 阶段 | WebUI 复选框 | API 参数 | 默认值 | 关掉的代价 |
|------|--------------|---------|--------|-----------|
| 文本清洗（阶段 1+2） | `Text Cleaning` | `text_cleaning` | **开** | 中文输出会混入 ASCII 半角逗号 / 问号；偶发的短语重复循环不再兜底 |
| 段合并（阶段 3） | `Segment Merging` | `segment_merging` | **开** | 字幕段数变多、单段更短，碎句更多但时间戳保持原始切分 |

> **WebUI 上一共三个用户勾选项**：本节的两个后处理开关 + 前文 §1.1.2 开篇介绍的引擎路径开关 `Batched Inference`。注意 **Batched 属于引擎层路由（决定 Whisper 内部如何处理音频），不属于后处理**；本节这两个开关才是文本输出的后处理。三个开关均**会自动持久化**——每次切换都会立即写入 `default_parameters.yaml` 的 `_post_processing` 节（命名上沿用了"post processing" 历史 key，实际包含 Batched 在内的所有 3 个 UI 勾选项的状态），重启 Pod / 升级 Chart / 浏览器刷新都会保留你的选择（详见 2.2 节）。API per-request 传参则只影响本次调用，不修改持久化状态。
>
> **何时关掉**：
> - **Batched Inference**（引擎路径，前文 §1.1.2 介绍）—— 需要 segment 间语义连贯性（如有声书人物名一致性）超过速度收益时，或排查问题时切回 Whisper 经典行为做对照。关掉后回到 Buffered 路径，本节两个后处理开关仍然独立生效。
> - **文本清洗**（后处理） —— 几乎不需要关。如果你的下游管线对 ASCII 半角标点有特殊依赖（罕见），或者你确实想看模型原始输出供研究 / 调试，可以关掉。
> - **段合并**（后处理） —— 偶尔有理由关。比如做词级别对齐研究、需要时间戳精确对应 Whisper 原始切分、或者后续要自己重新切分时。

**阶段 1：重复循环去除**（`_REPEAT_RE`，归 `Text Cleaning`）

正则检测并折叠连续重复 3 次以上的短语（如 "of the murder, of the murder, of the murder" → "of the murder,"）。这是温度回退之外的第二道安全网。

> **安全设计**：只折叠包含空格或标点的**短语级**重复循环（Whisper 的 bug 模式），不会误伤 "啦啦啦啦啦"、"哈哈哈哈" 等有意的单字重复。

**阶段 2：中文标点全角化**（`_ASCII_TO_FULLWIDTH`，归 `Text Cleaning`）

对包含 CJK 字符的文本，将 ASCII 标点转为全角：`,` → `，`、`?` → `？`、`!` → `！`、`:` → `：`。解决了 Whisper 对中文固有的混合标点问题。句号 `。` 和顿号 `、` 模型本就输出中文版，不需要替换；引号也通常正确。

**阶段 3：短段 / 不完整段合并**（`_merge_short_segments`，归 `Segment Merging`）

VAD 切分较细（`min_silence_duration_ms=500`）容易把一句话切成多个 segment，单看像 `we can` / `test this` / `to feed our call.`——这在字幕里很难读。合并逻辑会把满足以下三个条件的 segment 吸收进下一段：

- 当前 segment **太短**（< 2 秒 或 < 5 字符）**或**当前 segment **不是一个完整句子**（不以 `.!?。！？` 结尾——省略号 `…` / `...` 视为"句子未完"）
- 与下一段的间隔 < 1.0 秒
- 合并后**不会**超过硬上限（30 秒 / 300 字符）

第 3 条是关键的兜底：当 Whisper 偶尔吐出一长段没有标点的小写跑文（实测中出现过 400 字符的连续运行段），硬上限会阻止合并把数十段拼成一个不可读的怪物块。

> **两阶段均为确定性字符串操作 / 状态机**，零模型开销，零额外延迟。开 / 关只影响输出形态，不影响转写本身的耗时。
>
> **进度日志**：
> - 流水线每处理 25 个 segment 会输出一条 `Whisper progress: N segments produced so far`（Buffered）/ `Batched transcription started (batch_size=16)`（Batched）到 `kubectl logs`，便于在 UI 进度条没动的时候确认任务仍在跑。
> - 三个复选框的切换会各自写一条 `Batched Inference toggled: True/False` / `Text Cleaning toggled: True/False` / `Segment Merging toggled: True/False`，紧接着会有一条 `Post-processing state persisted: batched=..., text_cleaning=..., segment_merging=...` 确认状态已写入持久化 yaml（详见 2.2 节）。
> - Batched 模式下首次构建 Pipeline 时会打 `BatchedInferencePipeline created (model id=...)`；后续同 model 调用走缓存命中（不再打这条）。如出现 `BatchedInferencePipeline cache evicted (old ids=...); ran gc + cuda.empty_cache to free GPU memory before constructing new pipeline` 说明上一次 model 被 `update_model` / `offload` 重建过，触发了我们的单槽缓存淘汰逻辑——这是预期行为，无需告警。

#### 1.1.3 质量关键参数：镜像默认值为何已是最优

以下参数与转录质量密切相关。我们在**英文（福尔摩斯：波希米亚丑闻有声书）**和**中文（流浪地球有声书）**场景下进行了大量实测，最终确认镜像默认值已是最优选择，**不需要也不应该覆盖它们**。

以下"镜像默认值"均指 `configs_default/default_parameters.yaml`（即 Whisper-WebUI 官方镜像内置的原始配置）。

##### `beam_size = 5`，`best_of = 5`（镜像默认）

**机制说明**：`beam_size` 是波束搜索宽度（解码时同时保留 N 条最优候选路径）；`best_of` 是从多少个候选中选出最终结果。

**为什么 5 已经足够好**：

- 5 是 OpenAI 官方推荐值，也是 Whisper-WebUI 镜像的默认值，是质量与速度的最佳平衡
- 增大到 10：质量几乎无可感知的提升，但推理速度降低约 40%~50%
- 减小到 1：明显加快速度（约为 beam_size=5 的 2 倍），适合实时场景，但质量会有所下降

**对中英文的影响**：无差异，此参数与语言无关。

> **WebUI 对应设置**：Whisper 区域 → Beam Size / Best Of → 保持 `5`

##### `compression_ratio_threshold = 2.4`（镜像默认）

**机制说明**：对每个 segment 的输出文本计算压缩比（zlib 压缩后大小 ÷ 原始大小）。压缩比超过阈值说明文本高度重复（模型在"胡说"），此时触发温度回退重试。

**为什么 2.4 是对的**：

- 正常语音转录文本的压缩比通常在 1.0 ~ 2.0
- 2.4 留出了合理余量，不会误伤正常重复（如演讲中的排比句）
- 我们曾在英文实测中将此值降到 2.0，但**当时因 `temperature=0` 导致回退机制失效**，无论设为多少都不起作用。修复 `temperature`（改为回退列表）后，2.4 配合温度回退能正常运作

**调整影响**：

| 值 | 效果 |
|---|---|
| **< 2.0** | 过于严格，正常文本可能被误判，触发不必要的重试，降低速度和质量 |
| **2.4**（默认） | 平衡值，仅捕捉明显的重复 / 幻觉 |
| **> 3.0** | 过于宽松，可能放过明显的重复输出 |

##### `repetition_penalty = 1`（禁用，镜像默认），`no_repeat_ngram_size = 0`（禁用，镜像默认）

**这两个参数经过 15 轮中英文系统实测。结论：不存在同时适合中英文的统一配置，保持默认禁用是最安全的选择。**

**完整实测数据（英文：福尔摩斯有声书 1 小时 / 中文：流浪地球有声书 ~3 分钟）**：

| # | cond_prev | temp | rep_penalty | ngram | initial_prompt | 语言 | 循环 | 大写 | 碎片化 | 耗时 | 可用 |
|---|-----------|------|-------------|-------|----------------|------|------|------|--------|------|------|
| 4 | True | 0.2 | 1 | 0 | 中文 | 中文 | 无 | 正常 | 无 | 43s | **最佳** |
| 7 | True | 0.2 | 1 | 0 | 无 | 英文 | 无 | **全大写** | 无 | 6m20s | 否 |
| 8 | False | 0.2 | 1 | 0 | 无 | 英文 | **6处灾难循环** | 正常 | 无 | 6m49s | 否 |
| 9 | False | 0.4 | 1 | 0 | 无 | 英文 | **2处超长循环+幻觉** | 正常 | 无 | 19m53s | 否 |
| 10 | False | 0.2 | **1.1** | **5** | 无 | 英文 | **无** | 正常 | 无 | 3m46s | **最佳** |
| 11 | False | 0.2 | **1.1** | **5** | 中文 | 中文 | 无 | 正常 | **严重** | 39s | 否 |
| 13 | True | 0.2 | 1 | 0 | 英文 | 英文 | **"E-G"×1000+** | 正常 | 无 | 19m53s | 否 |
| 14 | True | 0.2 | **1.1** | 0 | 英文 | 英文 | 无 | 正常 | **后半段严重** | 4m34s | 半可用 |
| 15 | False | 0.2 | **1.1** | 0 | 英文 | 英文 | 无 | 正常 | **后半段** | 3m41s | 半可用 |

**关键发现**：

1. **`no_repeat_ngram_size=5` 对英文有效但毁灭中文**（#10 vs #11）：英文中 5-gram 约相当于 2-3 个词的精确重复限制，合理；但中文中 5 个 token 仅约 5 个字，"地球发动机""我们的"等短语天然高频重复，模型被迫用同义词替换（小星→小青）、繁简交替（机→機）、强行断句来绕过限制。

2. **`repetition_penalty=1.1` + `condition_on_previous_text=True` 在长音频上渐进碎片化**（#14）：True 把上一 segment 的输出作为上下文传递，而 repetition_penalty 惩罚已出现的 token。随着音频推进，越来越多的常用词（the, a, and, is, of...）在上下文中累积被惩罚，模型被迫输出更短的 segment → 碎片化正反馈循环。

3. **`repetition_penalty=1.1` + `False` 也会碎片化**（#15 vs #10）：去掉 `ngram=5` 后，仅靠 rep_penalty 不足以维持英文的句子完整性，后半段仍然退化。

4. **中英文最佳配置完全互斥**：
   - 中文最佳（#4）：`True + 0.2 + rep=1 + ngram=0` + 中文 prompt
   - 英文最佳（#10）：`False + 0.2 + rep=1.1 + ngram=5` + 无 prompt
   - 测试矩阵的 5 个变量（cond / temp / rep / ngram / prompt）中，4 个不同（只有 `temp` 相同，都是 0.2）

**为什么这两个参数不适合作为通用默认值**：

1. **`no_repeat_ngram_size`**：禁止输出中出现完全相同的 N 个连续 token。中文 token 粒度细（每字约 1 token），ngram=5 仅禁止 5 字精确重复，会破坏中文自然语言结构。英文 token 粒度粗（每词 1-3 token），同样的 ngram=5 效果截然不同。
2. **`repetition_penalty`**：与 `condition_on_previous_text=True` 组合使用时，惩罚会跨 segment 累积，导致长音频渐进碎片化。且标点符号（`"`, `.`, `,`）是高频复用 token——被惩罚后逐渐消失。

**正确的反重复策略**：依靠 `temperature` 回退机制 + `compression_ratio_threshold`，这是 Whisper 原生的反重复方案，在 segment 级别整体重试，不改变 token 级别的概率分布，对所有语言一视同仁。**此机制原本在 WebUI 中失效**（Gradio Slider 只能传单个浮点数），但已通过引擎级 Monkey-Patch 在 WebUI 和 API 中**同时恢复完整生效**（详见 1.1.2 温度回退章节）。

##### 其他阈值参数

| 参数 | 镜像默认值 | 说明 | 调整建议 |
|------|----------|------|---------|
| `log_prob_threshold` | `-1.0` | 平均 log 概率低于此值的 segment 触发温度回退 | 降低（如 -1.5）更宽容；升高（如 -0.5）更严格但可能导致过多重试 |
| `no_speech_threshold` | `0.6` | no_speech 概率超过此值且 log_prob < 阈值时，判定为无语音并跳过 | 升高：更倾向跳过可疑段；降低：更保守保留内容 |

这两个参数与 `compression_ratio_threshold` 和 `temperature` 回退序列共同构成 Whisper 的质量保障体系，均已在镜像中经过充分调优，不建议修改。

##### 其他 VAD 参数

以下 VAD 参数在 WebUI 中保持镜像默认值（我们不做覆盖）：

| 参数 | 镜像默认值 | 说明 |
|------|----------|------|
| `threshold` | `0.5` | VAD 灵敏度。降低会检测到更多语音（含噪声），升高会遗漏轻声 |
| `min_speech_duration_ms` | `250` | 最短语音段。250ms 可过滤气口和短噪声 |
| `max_speech_duration_s` | `9999` | 最长语音段。设为极大值避免长连续说话被强制切断 |

#### 1.1.4 API 层自动语言检测 + 智能提示词

API 层（端口 8000）内置了两阶段语言检测逻辑。**此功能仅在 API 调用时生效，不影响 WebUI**：

1. 如果调用方没传 `language` 参数，先用 Whisper 模型做一次轻量语言检测
2. 检测置信度 ≥ 0.8 时采用检测结果，否则不设语言（由模型自行判断）
3. 确定语言后，如果调用方没传 `prompt`，自动注入对应语言的 `initial_prompt`：

| 语言 | 自动注入的 initial_prompt |
|------|--------------------------|
| 中文（zh） | 以下是普通话的句子，使用简体中文标点符号。 |
| 英文（en） | The following is a conversation in English with proper punctuation. |
| 日文（ja） | 以下は日本語の文章です。句読点を正しく使用してください。 |
| 韩文（ko） | 다음은 한국어 문장입니다. 올바른 구두점을 사용합니다. |
| 法/德/西/俄/葡 | 各自语言的等效提示 |

> **注意**：如果调用方自行传入了 `prompt` 或 `language`，将优先使用调用方提供的值。

### 1.2 需要用户操作的优化

> **第一步：选定模型** — 调整下面任何参数之前，请先根据 [1.6 节 · 模型选择指南](#16-模型选择指南) 决定要用的 Whisper 模型。模型选择对最终质量的影响通常**大于**参数微调；选错模型再怎么调参也回不来。

#### 1.2.1 明确指定语言（最重要的单一参数）

如果你明确知道音频是什么语言，**务必手动指定**：
- WebUI：Language 下拉框选择 `Chinese`
- API：传 `language=zh`

自动检测对中英混杂、带背景音乐、或开头无语音的音频可能误判。一旦语言判错，整段转录质量会崩溃。

#### 1.2.2 使用 `initial_prompt` 引导内容

手动提供 prompt 比依赖自动 prompt 效果更好，尤其是专业领域：

```
# 科技播客
以下是关于人工智能的播客讨论，涉及 ChatGPT、Claude、Perplexity、Cursor、DeepSeek 等产品。

# 科幻有声书
以下是刘慈欣科幻小说《流浪地球》的朗读，涉及地球发动机、太阳氦闪、行星推进等概念。

# 医学会议
肿瘤免疫治疗学术报告。PD-1、PD-L1、CAR-T、EGFR、ALK 等专业术语。

# 英文有声书 / 演讲
The following is a conversation in English with proper punctuation.
```

> WebUI 对应设置：Whisper 区域 → **Initial Prompt** 输入框

##### 严重警告：不要把 Initial Prompt 填到 Prefix 里

WebUI 中 **Initial Prompt** 和 **Prefix** 是两个完全不同的参数，在界面上位置相近，极易混淆。**填错会导致 Pod 崩溃。**

| 参数 | 作用 | 填错后果 |
|------|------|---------|
| **Initial Prompt** | 给模型提供风格引导上下文，模型参考但**不会输出** | ✅ 正确用法 |
| **Prefix** | **强制**模型以此文字作为输出的开头，模型**必须先输出**这段文字 | ❌ 灾难 |

**实测灾难案例**：将 `"The following is a conversation in English with proper punctuation."` 填入 Prefix 后：

1. 每个 segment 都被迫以这句话开头，吃掉大量 token 预算
2. `condition_on_previous_text=True` 把上一段带前缀的输出作为下一段的上下文
3. Token 空间被前缀和上下文挤满，模型无法正常转写音频
4. 无限生成 → GPU 资源耗尽 → **Pod 被 OOM Kill，服务崩溃**

此问题已在实际测试中**两次触发 Pod 崩溃**（同一音频、同一参数，仅因填入 Prefix 而非 Initial Prompt）。将同一文本改填到 Initial Prompt 后一切正常。

> **记住**：Initial Prompt = 风格引导（安全），Prefix = 强制输出开头（危险，除非你明确知道自己在做什么）。

#### 1.2.3 使用 `hotwords` 提升特定词识别率

`hotwords` 可以提升特定词的识别概率，但 **使用方式有严格讲究**，用错会导致严重副作用。

> **⚠️ 范围说明**：以下关于 hotwords 抑制标点的所有结论均来自**中文实测**（测试素材：《流浪地球》于和伟演播版有声书）。英文场景下 hotwords 对标点的影响尚未测试，后续验证后补充。

##### hotwords 的实现原理

Whisper-WebUI 的 hotwords **并非传统的"词级加权"**。它的实现是将 hotwords 字符串编码为 token 序列，放入每个 segment 的解码 prompt 中（作为 `sot_prev` 之后的上下文）。这意味着模型会**模仿 hotwords 的文本风格**来生成输出——包括标点风格。

##### ⚠️ 关键发现：hotwords 会抑制中文标点

经实测验证，hotwords 的存在会**完全消除输出中的中文标点符号**。原因：

1. hotwords 被放入 `sot_prev` 之后作为"伪上下文"
2. 如果 hotwords 是一串没有标点的词（如 `"微信 ChatGPT 张三"`），模型"看到"的上下文就是一段无标点文本
3. 模型模仿这个风格，输出也不带标点
4. 在 `condition_on_previous_text=False` 时，从第二个 segment 开始，prompt 中**只有 hotwords**（`initial_prompt` 仅对第一个 segment 生效），所以标点抑制贯穿全文

##### hotwords 最佳格式（中文场景）

**中文场景下必须用中文逗号分隔 + 末尾加中文句号**：

```
刘慈欣，流浪地球，地球发动机，巨峰，巨殿，小星老师，光晕，聚变，舷窗，极地冰川。
```

**不要**这样写（标点会完全消失）：
```
刘慈欣 流浪地球 地球发动机 巨峰 巨殿 小星老师
```

##### hotwords 词数限制

建议 **不超过 10 个词**。hotwords token 占用解码 prompt 空间（上限约 `max_length // 2`），词太多会导致：
- 输出句子被截断、大段内容丢失
- 幻觉增加
- 实测：23 个词的 hotwords 导致约 30% 的原文内容丢失

##### hotwords 标点效果的局限

中文逗号分隔 + 末尾句号的 hotwords 格式，只能让输出中的**句号**变为中文 `。`，但逗号仍为 ASCII `,`，问号仍为 ASCII `?`。这是 Whisper 模型的固有行为。

**不要在 hotwords 末尾堆砌额外标点**（如 `，。？！`）：实测会导致输出严重恶化——出现异常 Unicode 字符（如 `﹐` U+FE50 SMALL COMMA）、文本极度碎片化、大段内容丢失。

##### hotwords 的 trade-off

hotwords 会修复某些词，但可能让另一些词变差。实测案例（《流浪地球》有声书）：

| 词 | 无 hotwords | 有 hotwords | 说明 |
|----|------------|-------------|------|
| 小星老师 | ❌ "小青老师" | ✅ 正确 | hotwords 修复 |
| 巨峰 | ❌ "飓风" | ✅ 正确 | hotwords 修复 |
| 极地冰川 | ❌ "几地冰川" | ✅ 正确 | hotwords 修复 |
| 聚变 | ✅ "重元素聚变" | ❌ "重元素巨变" | hotwords 反而搞坏 |
| 引号 | ✅ 出现 `"..."` | ❌ 消失 | hotwords 副作用 |
| 文本完整性 | ✅ 完整 | ⚠️ 偶有截断 | hotwords 副作用 |

##### 何时使用 / 何时不使用 hotwords

| 场景 | 建议 |
|------|------|
| 音频中有专有名词被反复识别错误 | ✅ 使用，只列最关键的几个（≤10） |
| 日常会议/播客，没有特殊术语 | ❌ 不使用，默认配置已足够 |
| 需要完整中文标点和引号 | ❌ 不使用，hotwords 会破坏标点 |
| 需要最高文本完整性（无截断、无幻觉） | ❌ 不使用 |

> **WebUI 对应设置**：Whisper 区域 → Hotwords 输入框

#### 1.2.4 处理带背景音乐的音频

对歌曲或带 BGM 的视频的完整说明（配置、效果与限制），请参见 **1.5 节**。

简要建议：
1. 开启 BGM 分离：`is_separate_bgm=true`
2. 手动指定语言
3. 提供歌名 / 关键词作为 prompt
4. **管理预期**：即使开启 BGM 分离，歌词转写质量仍然很差——Whisper 不是为歌词识别设计的

### 1.3 中文标点符号行为详解

> **⚠️ 范围说明**：本节所有结论均基于**中文实测**（测试素材：《流浪地球》于和伟演播版有声书，Whisper large-v2 / large-v3 + float16）。`large-v3` 行为相同。英文场景下的标点行为尚未系统测试，后续验证后补充。

Whisper 在中文场景下的标点行为比较特殊，以下是实测总结的规律。

#### 1.3.1 默认标点行为（模型固有 / 已自动修正）

在不使用 hotwords 的情况下，Whisper 对中文的**原始**标点输出模式如下；段落后处理 Monkey-Patch（详见 1.1.2 节）会把 ASCII 的逗号 / 问号 / 感叹号 / 冒号自动转为全角，所以**用户最终看到的输出已经是修正后的**：

| 标点 | Whisper 原始输出 | 自动修正后（最终输出）| 镜像默认 | 当前应用 |
|---|---|---|---|---|
| 句号 | `。` | `。` | ✅ | ✅ |
| 逗号 | `,`（ASCII）| `，` | ❌ | ✅ |
| 问号 | `?`（ASCII）| `？` | ❌ | ✅ |
| 感叹号 | `!`（ASCII）| `！` | ❌ | ✅ |
| 冒号 | `:`（ASCII）| `：` | ❌ | ✅ |
| 顿号 | `、` | `、` | ✅ | ✅ |
| 引号 | `"..."` | `"..."` | ✅ | ✅ |

ASCII 标点的来源是 Whisper 语言模型的**固有行为**——无论 `initial_prompt` 里是否使用了全角标点，模型仍然倾向于输出 ASCII 逗号和问号。我们通过段落后处理（1.1.2 节）做了透明的字符替换。

> **直接调用 faster-whisper（绕过我们的 API/WebUI）的用户请注意**：此修正是在我们的 API 层 / 引擎补丁里做的；如果你直接 import faster-whisper，仍然只会拿到 ASCII 标点。

#### 1.3.2 什么情况下标点会消失

以下表格描述的是 Whisper **原始输出**（在段落后处理修正之前）的标点表现。`hotwords` 的副作用导致整条 segment 没有任何标点 token 产生——这种情况段落后处理也救不回来（无中生有），所以 hotwords 的格式仍然要正确：

| 配置 | 原始标点表现 | 原因 |
|------|---------|------|
| 不用 hotwords，有 initial_prompt | ✅ 正常（句号中文，逗号/问号 ASCII，后处理统一转全角）| 模型默认行为 |
| hotwords 用**空格分隔** | ❌ **标点完全消失** | 模型模仿无标点的 hotwords 风格 |
| hotwords 用**中文逗号分隔 + 末尾句号** | ✅ 句号中文，逗号 ASCII（后处理统一转全角）| 模型从 hotwords 末尾的 `。` 学到了句号风格 |
| hotwords 末尾追加 `？` 等额外标点 | ❌ **输出严重恶化** | 异常字符 `﹐`、极度碎片化、大段丢失 |

#### 1.3.3 标点最佳实践

1. **如果不需要 hotwords**：只设 `initial_prompt`，标点会正常输出，段落后处理自动统一为全角。这是最稳定的配置。
2. **如果需要 hotwords**：务必使用中文逗号分隔并以句号结尾，如 `"关键词A，关键词B，关键词C。"`
3. **如果需要绕过我们的 API 直连 faster-whisper**：要自己做全角标点替换（`,` → `，`、`?` → `？` 等）；我们的 API/WebUI 已经包含这步。
4. **不要在 hotwords 末尾堆砌标点字符**：只加 `。` 即可

### 1.4 中文质量的其他建议

1. **始终指定 `language=zh`** — 不要依赖自动检测
2. **提供 `initial_prompt`** — 哪怕只写 "以下是普通话的句子"，也能帮助模型确定输出风格
3. **谨慎使用 `hotwords`** — 详见 1.2.3 节，有明显的 trade-off
4. **长音频（>1 小时）注意幻觉** — 我们的默认配置已大幅抑制（三层防护：`condition_on_previous_text=False` 切断跨段错误传播 + `hallucination_silence_threshold=2` 拦截静音段幻觉 + 引擎级温度回退列表 segment 级自救），但极端情况仍可能出现。可以尝试进一步调高 `hallucination_silence_threshold`（如 3 或 5）
5. **古典文学/文言文效果差** — Whisper 的中文训练数据以现代口语为主，对文言文覆盖严重不足
6. **同音字替换是核心瓶颈** — 几乎所有中文错误都是完美的同音/近音替换（如"峰/风"、"刹/杀"、"晕/运"、"极/急"、"聚/巨"），声学层面完全正确，是语言模型选词错误，调参无法解决
7. **性别代词（她/他）经常出错** — Whisper 无法从声学信号判断性别，hotwords 对代词无效

### 1.5 歌曲处理：配置、效果与限制

> 本节基于实际测试经验总结。Whisper 是一个**语音转录**模型，不是歌词识别模型，这一点是理解下文所有限制的前提。

#### 1.5.1 推荐配置

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| `is_separate_bgm` | `true` | **必须开启**。使用 UVR-MDX-NET 将人声与伴奏分离，否则伴奏会严重干扰转录 |
| `uvr_model_size` | `UVR-MDX-NET-Inst_HQ_4` | 默认模型，分离质量较好 |
| `language` | 明确指定（如 `zh`、`en`、`ja`） | 歌曲中语言自动检测准确率极低（旋律干扰），**务必手动指定** |
| `prompt` | 歌曲相关信息 | 提供歌名、歌手名、关键歌词片段作为提示（如 `"以下是周杰伦的《晴天》歌词。"` 或 `"Lyrics of 'Bohemian Rhapsody' by Queen."` ） |
| `vad_filter` | `true`（已默认开启） | 跳过纯伴奏 / 间奏段，减少幻觉 |
| `hallucination_silence_threshold` | `2`（已默认设置） | 帮助跳过间奏中的幻觉输出 |

**WebUI 操作**：勾选 BGM Separation → 选择语言 → 填写 prompt → 上传歌曲文件 → 开始转录

**API 调用示例**：
```bash
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@song.mp3 \
  -F language=zh \
  -F is_separate_bgm=true \
  -F prompt="以下是周杰伦的歌曲歌词。" \
  -F response_format=lrc
```

#### 1.5.2 实际效果

**BGM 分离效果**：UVR-MDX-NET 对大多数流行歌曲的人声分离效果不错，能有效去除伴奏。但有以下限制：
- 分离后人声仍可能残留部分伴奏，尤其是与人声频率接近的乐器（钢琴、弦乐）
- 分离过程本身会引入少量音质损失
- 和声 / 多人合唱部分分离效果较差

**转录质量（实事求是）**：

| 方面 | 纯语音 | 歌曲（开启 BGM 分离后） |
|------|--------|----------------------|
| 歌词文字准确率 | 90%+ | **30%~60%**（视歌曲风格而定） |
| 标点 | 基本正常 | 混乱或缺失 |
| 句子完整性 | 好 | 大量碎片、截断、漏句 |
| 幻觉 | 极少（已防护） | 仍然较多，尤其在间奏和尾奏 |
| 时间戳 | 较准确 | 偏差较大 |

**不同歌曲风格的差异**：

| 歌曲类型 | 转录质量 | 原因 |
|---------|---------|------|
| 清唱 / 民谣（伴奏少） | ★★★ 尚可 | 接近纯语音，BGM 分离负担小 |
| 流行（标准编曲） | ★★ 差 | 伴奏残留干扰、唱腔与说话差异大 |
| 摇滚 / 电子 / 说唱 | ★ 很差 | 重伴奏难分离、语速快或变调多 |
| 合唱 / 多声部 | ★ 很差 | 人声分离困难，多人声叠加 |

#### 1.5.3 为什么歌曲转录质量差

1. **Whisper 的训练数据几乎全是语音**：录音、播客、电话、会议等。模型从未（或极少）见过歌唱音频，不理解唱腔的音高变化、拉长音、颤音等
2. **歌唱的声学特征与说话截然不同**：同一个人唱歌和说话的发音差异巨大，Whisper 的声学编码器难以正确匹配
3. **BGM 分离不完美**：即使用了 UVR，残留伴奏仍会被模型当作"噪声中的语音"去解码，产生大量幻觉
4. **歌词结构与自然语言不同**：歌词有大量重复（如副歌重复多遍、"啦啦啦"叠词），这与模型的"重复 = 幻觉"检测机制冲突
5. **节奏切分与 VAD 不匹配**：歌曲中的节拍停顿不等于语句停顿，VAD 可能在不恰当的位置切分

#### 1.5.4 优化建议与替代方案

**在 Whisper 框架内能做的有限优化**：

1. **始终开启 BGM 分离**（`is_separate_bgm=true`）——这是最重要的一步
2. **提供尽可能详细的 prompt**——包含歌名、歌手、甚至部分歌词片段
3. **手动指定语言**——歌曲中的语言检测极不可靠
4. **对 LRC 格式输出做人工校对**——自动生成的时间轴仅供参考

**如果歌词识别是核心需求**，建议考虑专用方案：

| 方案 | 说明 |
|------|------|
| 歌词 API（如 Musixmatch、Genius） | 直接获取已有歌词数据库中的歌词，最准确 |
| 专用歌词识别模型（如 Whisper 微调版） | 社区有少量针对歌曲场景微调的 Whisper 变体 |
| 人工标注 | 对于少量高价值歌曲，人工标注仍是最可靠的方式 |

> **总结**：Whisper + BGM 分离对歌曲的转录可以作为"粗稿"参考，但不应期望达到语音转录的质量水平。如果业务场景需要高质量歌词识别，建议采用专用方案。

### 1.6 模型选择指南

Whisper 提供多个尺寸的模型，从 39M 参数的 `tiny` 到 1550M 参数的 `large-v3`。模型越大通常准确率越高，但所需显存和处理时间也更多。**模型选择对最终质量的影响通常大于参数微调**——在调整任何参数之前，应先选定合适的模型。

#### 1.6.1 推荐模型对照表

| 模型 | 参数量 | 磁盘占用 (float16) | 推理 VRAM (float16) | 处理 1 分钟音频耗时 | 适用语言 | 推荐场景 |
|------|--------|-------------------|---------------------|---------------------|---------|---------|
| `tiny` | 39M | ~75 MB | ~1 GB | ~0.2-0.4 s | 多语言 | 极快试跑、流程验证 |
| `base` | 74M | ~145 MB | ~1 GB | ~0.4-0.6 s | 多语言 | 极快试跑 |
| `small` | 244M | ~480 MB | ~2 GB | ~0.8-1.2 s | 多语言 | 速度敏感场景 |
| `medium` | 769M | ~1.5 GB | ~3 GB | ~2-3 s | 多语言 | 中等质量基线 |
| `large-v2` | 1550M | ~3.0 GB | ~5 GB | ~4-5 s | 多语言 | **当前应用默认**，兼容性最稳 |
| `large-v3` | 1550M | ~3.0 GB | ~5 GB | **~4.5 s（实测）** | 多语言 | **中文/多语言最佳质量** |
| `large-v3-turbo` | 809M | ~1.6 GB | ~3 GB | ~0.8-1.5 s | 多语言 | v3 质量约 80% + 速度约 4× |
| `distil-large-v3` | 756M | ~1.5 GB | ~3 GB | ~0.8-1.2 s | **仅英文** | 英文场景速度首选 |

> **数据说明**
> - **参数量 / 磁盘占用**：参考 SYSTRAN/faster-whisper 上游公开数据（CTranslate2 float16 格式）。
> - **推理 VRAM**：上游 benchmark 公开值，包含模型权重 + 解码 KV 缓存 + beam search 中间状态（`beam_size=5`）。开启 BGM 分离（UVR）会再额外占用约 2-3 GB，开启说话人分离（pyannote）会额外占用约 1-2 GB。
> - **处理速度**：`large-v3` 行为本环境实测值（HAMI vGPU 上跑 64 分钟英文有声书耗时 4m47s + 13 分钟中文有声书耗时 53s，平均约 4.5s/分钟音频）；**其他模型为按上游公开 RTF 比例换算的参考值**，实际速度受 GPU 型号、`beam_size`、音频特性（语速、静音占比）影响，可能有 ±50% 浮动。
> - **大文件时间估算**：1 小时音频按表中速度乘以 60，例如 `large-v3` 约 4.5 分钟、`large-v3-turbo` 约 1 分钟、`tiny` 约 20 秒。

#### 1.6.2 部署侧的 GPU 资源配置

当前 Helm Chart 默认配置：

| 资源 | 申请值（requested） | 上限（limited） |
|------|------------------|--------------|
| GPU 显存 | 8 GiB | 18 GiB |
| 内存 | 8 GiB | 22 GiB |
| CPU | 0.5 核 | 4 核 |

**含义**：
- 申请的 8 GiB GPU 显存对 `tiny` ~ `large-v3` 单模型推理均**绰绰有余**
- 上限 18 GiB 可容纳 `large-v3` + UVR + pyannote 同时常驻
- 如果你的实际部署环境 GPU 显存较紧张（< 4 GB），建议改用 `medium` 或更小模型；可以通过 WebUI 顶部的 `Compute Type` 切换到 `int8` 量化，把 `large-v3` 的显存占用压缩到约 2 GB（质量下降不显著）

#### 1.6.3 选什么——按场景

**质量优先（音频内容珍贵，时间充裕）**：

| 语言 | 首选 | 次选 |
|------|------|------|
| 中文 | `large-v3` | `large-v2` |
| 英文 | `large-v3` | `large-v2` |
| 多语言/混杂 | `large-v3` | — |

**速度优先（批量处理、长音频、对实时性敏感）**：

| 语言 | 首选 | 次选 |
|------|------|------|
| 中文 | `large-v3-turbo` | `medium` |
| 英文 | `distil-large-v3` | `large-v3-turbo` |
| 多语言/混杂 | `large-v3-turbo` | `medium` |

**资源受限（VRAM < 4 GB 或共享 GPU 紧张）**：
- `medium` 或 `small`，中英文均可
- 英文专属变体（`small.en`、`medium.en`）在英文场景下质量略优于同尺寸多语言版
- 或保持 `large-v3` 但切到 `int8` 量化（`Compute Type` 下拉框）

**纯试跑/调试**：
- `tiny` 或 `base`，仅用来快速验证流程或定位问题

#### 1.6.4 large-v2 vs large-v3 的实际差异

二者参数量完全相同（1550M），主要差异：

| 维度 | large-v2 | large-v3 |
|------|---------|---------|
| 训练数据 | 680k 小时弱监督 + 1M 小时伪标签 | 同 v2 基础上 + 额外 ~280 万小时无监督数据 |
| 中文 | 良好 | **明显更好**（实测有声书更稳定） |
| 英文 | 良好 | 良好（差异不显著） |
| 数字/单位 | 一般 | 略优 |
| 已知问题 | — | 极少数情况下输出多余空格 |
| 当前应用默认 | ✅ 当前默认 | 可手动切换 |

**实务建议**：
- 中文音频 → 切到 `large-v3`
- 英文音频 → 任选，差异不显著
- 多语言混杂 → `large-v3`

#### 1.6.5 如何切换模型

**WebUI 端**：

1. 顶部 `Model` 下拉框选择目标模型
2. 首次使用新模型时会自动下载到 `/Whisper-WebUI/models/`（需要外网或镜像缓存）
3. 切换模型可能需要 5-15 秒（释放旧模型 + 加载新模型）

**API 端**：

```bash
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@audio.wav \
  -F model=large-v3 \
  -F language=zh
```

`model` 参数接受任意 faster-whisper 支持的模型名（详见 `/v1/models` 端点返回值）。默认 `whisper-1` 表示采用 WebUI 当前配置的默认模型。

> **注意**：API 端切换模型同样会触发实际加载（首次使用时下载、之后切换时重新加载），所以同一会话内频繁切换模型成本较高。**建议固定一个主用模型**，仅在确有必要时切换。

---

## 二、Chart 包修改详情

### 2.1 修改的文件

主要修改了两个文件：
- `whisperwebuiv2server/templates/api-proxy-configmap.yaml`（FastAPI 应用主体，内嵌 Python 约 2700+ 行）
- `whisperwebuiv2server/templates/deployment.yaml`（pip install 行加入 `pytubefix` 防御性安装）

`api-proxy-configmap.yaml` 包含一个完整的 Python 脚本 `whisper_openai_api.py`，作为 ConfigMap 挂载到容器内。它实现了：

1. **FastAPI 服务**（端口 8000）：提供 OpenAI 兼容 API，本开发版共 **11 个端点**，覆盖音频转录 / YouTube URL 转录 / Whisper 语音翻译 / NLLB 文本翻译 / DeepL 文本翻译 / 元信息查询。完整端点表见 §2.3
2. **三个音频端点共享同一份 59 公开参数签名**（`_transcribe_form_params` Depends + `_do_transcribe` 共享引擎驱动），杜绝转录/翻译/YouTube 三路径的行为漂移
3. **WebUI 质量 patch**：启动时按版本号自动修改 Gradio WebUI（端口 7860）的 `default_parameters.yaml`，覆盖 6 个关键参数（`temperature`、`condition_on_previous_text`、`hallucination_silence_threshold`、`vad_filter`、`min_silence_duration_ms`、`speech_pad_ms`，详见 1.1.1 节）
4. **引擎级 Monkey-Patch**（4 项）：包装 `WhisperModel.transcribe`，为 WebUI 和 API 同时提供：
   - **Batched Inference Pipeline 路由**（WhisperX 式 VAD Cut & Merge + 批量并行，默认开，可勾选关闭，详见 1.1.2 节）
   - 温度回退列表
   - 自动 Initial Prompt 注入
   - 段落后处理流水线（`Text Cleaning` + `Segment Merging`）
5. **WebUI 复选框**：高级参数区注入**三个** `Batched Inference` / `Text Cleaning` / `Segment Merging` 复选框，与 API 的 `batched` / `text_cleaning` / `segment_merging` 参数同步控制
6. **浏览器刷新持久化**：通过 `_patch_app_persistence` 把 `demo.load()` 与 yaml 关联，每次浏览器刷新自动按 yaml 重 hydrate 所有 50 个 pipeline 组件，杜绝"刷新后选项被构造期默认值覆盖"的回归
7. **yaml 并发安全**：所有 yaml 读改写操作通过 `threading.Lock` 串行化，并对 `load_yaml` 返回 `None` 做 dict 类型校验防御，根治 Gradio 线程池 change 回调并发触发的 `TypeError: 'NoneType' object does not support item assignment`
8. **BatchedInferencePipeline 单槽缓存 + GC**：`id(model)` 不一致时立即 evict 旧 pipeline 并强制 `gc.collect()` + `torch.cuda.empty_cache()`，根治 Batched 初次集成时暴露的"5 次连续转录后 GPU OOM"显存泄漏
9. **NLLB / DeepL 懒加载单例**：`_nllb_inf` / `_deepl_api` 全局单例 + `threading.Lock` 双检；NLLB 推理串行化避免上游 `update_model` 多线程竞态；DeepL `auth_key` 仅在请求生命周期内停留，**不写入** `default_parameters.yaml`（与上游 `translate_deepl` 的关键差异）
10. **YouTube 并发安全**：使用 `pytubefix` 但**不复用**上游 `modules/yt_tmp.wav` 固定路径——每个请求各自 `mkdtemp` 隔离，结束后 `shutil.rmtree` 清理
11. **共享模型**：Whisper 引擎与 WebUI 共享同一个模型实例，零额外 GPU 内存；NLLB / DeepL 是独立模块（NLLB 按需下载到本地 GPU，DeepL 纯转发不占资源）

### 2.2 WebUI 配置持久化机制

WebUI 的所有参数存储在容器内的 `/Whisper-WebUI/configs/default_parameters.yaml`，该文件挂载在持久卷上，重启不丢失。

#### 配置生命周期

```
首次安装
  │
  ├─ init 容器：configs/ 目录为空
  │   └─ 从 configs_default/（镜像内原始默认值）拷贝全部文件到 configs/
  │
  └─ 主容器启动
      ├─ _patch_webui_config()           → 发现无 _patch_version → 写入 6 个推荐值 + 标记 _patch_version=1
      ├─ _load_post_processing_state()   → yaml 中无 _post_processing 节 → 写入默认值（三者均开），让该节从首次启动起就可见可改
      ├─ _patch_whisper_engine()         → 包装 WhisperModel.transcribe（Batched 路由 + 温度回退 + 自动 Prompt + 后处理流水线）
      ├─ _patch_gradio_ui()              → 在高级参数区注入 Batched Inference / Text Cleaning / Segment Merging 复选框（value=lambda 闭包，确保浏览器刷新时读最新 yaml）
      ├─ _patch_app_persistence()        → 注册 self.app.load() 回调，每次浏览器刷新按 yaml hydrate 全部 50 个 pipeline 组件
      └─ App(args)                       → 启动 WebUI + API
```

```
日常重启（含升级到同版本 Chart）
  │
  ├─ init 容器：configs/ 不为空 → 跳过
  │
  └─ 主容器启动
      ├─ _patch_webui_config()           → 发现 _patch_version=1 >= 1 → 跳过，不覆盖任何参数
      ├─ _load_post_processing_state()   → 从 _post_processing 节读出用户上次的勾选状态并恢复（含旧 yaml schema 自动升级，缺失 batched 字段时按 True 兜底）
      ├─ _patch_whisper_engine()         → 每次启动都重新包装（内存级，不持久化）
      ├─ _patch_gradio_ui()              → 重新注入复选框，初始值=刚加载的状态
      ├─ _patch_app_persistence()        → 注册刷新回调
      └─ ★ 用户在 WebUI 上做的所有持久化参数修改 + 三个复选框勾选均被保留
```

```
升级到新版 Chart（我们 bump 了 _PATCH_VERSION）
  │
  ├─ init 容器：configs/ 不为空 → 跳过
  │
  └─ 主容器启动
      ├─ _patch_webui_config()           → 发现 _patch_version < 新版本号 → 重新写入 6 个推荐值 + 更新版本号
      │   └─ ⚠️ 仅 6 个推荐参数被覆盖；_post_processing 节不在 _PATCH 范围内，用户勾选状态不受影响
      ├─ _load_post_processing_state()   → 同样从 _post_processing 节读出，保留用户选择（schema 升级路径同上）
      ├─ _patch_whisper_engine()         → 每次启动都重新包装
      ├─ _patch_gradio_ui()              → 重新注入复选框，沿用用户上次的选择
      └─ _patch_app_persistence()        → 注册刷新回调
```

> **复选框状态如何持久化**：`Batched Inference` / `Text Cleaning` / `Segment Merging` 三个复选框每次切换都会立即把新值写入 `default_parameters.yaml` 的 `_post_processing` 节（独立于 Whisper-WebUI 自身的参数节，避免污染上游 schema），所有 yaml 读写通过 `threading.Lock` 串行化、对返回 `None` 做 dict 类型校验防御。这意味着：
> - **首次安装即把默认值写入 yaml**——`_load_post_processing_state()` 发现该节不存在时会主动写入 `batched: true` + `text_cleaning: true` + `segment_merging: true`，从首次启动起 admin 就能在 yaml 里看到并直接编辑这三项（与 PATCH 6 个参数的行为对称）
> - **WebUI 勾选会跨 Pod 重启保留**——不需要额外操作
> - **浏览器刷新也会保留**——`_patch_app_persistence` 注册的 `demo.load()` 回调在每次刷新时按 yaml 重新 hydrate 所有 pipeline 组件；`gr.Checkbox(value=lambda: <global>)` 模式确保 Gradio 不会用构造期烤死的字面量覆盖最新值（这是本开发版基础设施修复的核心点之一）
> - **Chart 版本升级不会重置勾选**——`_post_processing` 节不归 `_PATCH_VERSION` 管，只有那 6 个推荐参数会在 patch version 提升时被覆盖
> - **旧 yaml schema 自动升级**：若 yaml 里只有 `text_cleaning` + `segment_merging` 两项（早期改造阶段的 schema），启动时发现缺失 `batched` 字段会自动补成 `true`，无需手动迁移
> - 如需在 API 调用中单次覆盖，仍可通过 `batched=false` / `text_cleaning=false` / `segment_merging=false` 临时改变本次行为，且**不会**修改持久化状态（持久化只由 WebUI 勾选触发）

#### 哪些参数会被自动管理？

**以下 6 个参数**由 PATCH 机制管理。在 Chart 版本升级时，它们会被重置为我们的推荐值：

| 参数 | 推荐值 | 镜像默认值 | 所在区域 |
|------|--------|----------|---------|
| `temperature` | `0.2` | `0` | Whisper |
| `condition_on_previous_text` | `False` | `True` | Whisper |
| `hallucination_silence_threshold` | `2` | `None` | Whisper |
| `vad_filter` | `True` | `False` | VAD |
| `min_silence_duration_ms` | `500` | `1000` | VAD |
| `speech_pad_ms` | `400` | `100` | VAD |

> **关于 `temperature` 的双重处理**：PATCH 把 Slider 初始值设为 `0.2`（避免 `0` 在长音频上的灾难循环），引擎级 Monkey-Patch 进一步把单个 Slider 值在运行时展开为回退列表 `[0.2, 0.4, 0.6, 0.8, 1.0]`（详见 1.1.2 节）。两层共同作用：用户在 UI 上看到一个合理的初始值，引擎拿到的是完整的反循环列表。

> **注意**：如果你手动修改了这 6 个参数中的某个，你的修改在**日常重启时会保留**，但在 **Chart 版本升级时会被覆盖**回推荐值。这是有意为之——当我们在新版本中调整推荐配置时，需要确保修改能推送到所有实例。

**`_post_processing` 节（独立持久化，不受 `_PATCH_VERSION` 管控）**：

| 参数 | 默认值 | 触发写入 | 触发读取 |
|------|--------|----------|----------|
| `_post_processing.batched` | `true` | WebUI 切换 `Batched Inference` 复选框 | 启动时 `_load_post_processing_state()` + 每次浏览器刷新 `demo.load()` |
| `_post_processing.text_cleaning` | `true` | WebUI 切换 `Text Cleaning` 复选框 | 同上 |
| `_post_processing.segment_merging` | `true` | WebUI 切换 `Segment Merging` 复选框 | 同上 |

> 这三项**永远不会**被 Chart 版本升级覆盖，因为 `_post_processing` 节不属于 `_QUALITY_OVERRIDES`。一次勾选 = 一次持久化，跨 Pod 重启、跨 Chart 升级、跨浏览器刷新均保留。

**除此之外的所有参数**（如 `beam_size`、`best_of`、`language` 等）完全由用户控制，任何修改永远不会被覆盖。

#### 如何恢复到初始状态

如果你想将 WebUI 的所有参数恢复为"镜像默认值 + 我们的 6 项推荐值"的干净状态：

```bash
# 方法：清空 configs 目录，然后重启 Pod
# 进入 Pod
kubectl exec -it <pod-name> -n <namespace> -- sh

# 清空配置（会在下次启动时自动重建）
rm -rf /Whisper-WebUI/configs/*

# 退出后删除 Pod，让 Deployment 自动重建
kubectl delete pod <pod-name> -n <namespace>
```

重启后：
1. init 容器发现 `configs/` 为空 → 从镜像内的 `configs_default/` 重新拷贝全部原始默认值
2. `_patch_webui_config()` 发现无 `_patch_version` → 写入 6 个推荐值 + 标记版本号
3. `_load_post_processing_state()` 发现无 `_post_processing` 节 → 写入默认值（三个复选框都开：`batched: true`、`text_cleaning: true`、`segment_merging: true`）到 yaml
4. `_patch_whisper_engine()` 重新包装引擎（温度回退 + 自动 Prompt + 后处理流水线）
5. `_patch_gradio_ui()` 重新注入复选框，两者回到默认开
6. 所有参数回到初始状态

> **⚠️ 注意**：此操作会重置 **所有** WebUI 设置（包括语言、模型选择等），不仅仅是转录参数。

### 2.3 API 端点总览

服务监听容器内 `0.0.0.0:8000`。在 Olares 体系下，API 通过 `whisperwebuiApi` entrance（端口 8082，`authLevel: internal` + `invisible: true`，仅集群内可访问）暴露。

| 类别 | 端点 | 方法 | 说明 |
|------|------|------|------|
| 运维 | `/healthz` | GET | 健康检查（模型加载完成返回 `ok`） |
| 模型 | `/v1/models` | GET | 可用 Whisper 模型列表（OpenAI 兼容） |
| **音频转录** | `/v1/audio/transcriptions` | POST | 语音转文字，上传音频文件，**59 个 Form 参数全开放**（含 OpenAI 兼容字段 `timestamp_granularities[]`，详见 2.4 节） |
| **音频转录** | `/v1/audio/transcriptions/youtube` | POST | 语音转文字，输入 YouTube URL（服务端用 pytubefix 抓音频，59 个 Form 参数同转录，详见 2.5 节） |
| **音频翻译** | `/v1/audio/translations` | POST | Whisper 内置语音翻译为英文，**与转录端点完全相同的 59 个 Form 参数**，内部强制 `task=translate`（详见 2.6 节） |
| YouTube 元信息 | `/v1/youtube/metadata` | GET | 查询 YouTube 视频的标题/作者/时长/封面，无下载（详见 2.5 节） |
| **NLLB 文本翻译** | `/v1/text/translations/nllb` | POST | Facebook NLLB-200 本地翻译，约 200 种语言，支持纯文本或字幕文件（详见 2.7 节） |
| NLLB 元信息 | `/v1/translations/nllb/models` | GET | 可用 NLLB 模型变体（`facebook/nllb-200-distilled-600M` / `facebook/nllb-200-1.3B` / `facebook/nllb-200-3.3B`） |
| NLLB 元信息 | `/v1/translations/nllb/languages` | GET | NLLB 支持的全部语言（名称↔代码映射） |
| **DeepL 文本翻译** | `/v1/text/translations/deepl` | POST | 转发到 DeepL 云端 API，调用方携带 `auth_key`，服务端不落盘（详见 2.8 节） |
| DeepL 元信息 | `/v1/translations/deepl/languages` | GET | DeepL 支持的源/目标语种列表 |

此外，FastAPI 自动生成两个文档端点：
- `GET /docs` — Swagger UI（浏览器打开可交互调试）
- `GET /openapi.json` — OpenAPI 3.x 规范，可导入 Postman / Insomnia 等工具

### 2.4 `/v1/audio/transcriptions` 完整参数表

> 总计 **59 个 Form 参数 + 1 个 `file` 字段**（59 = 58 个引擎/路由层字段 + 1 个 OpenAI 兼容字段 `timestamp_granularities[]`）。下面按功能分 11 组列出。
> Form 默认值列严格对应 `_transcribe_form_params(...)` Depends 声明；带「服务端实际默认」的说明表示该字段 Form 默认为 `None`，但请求未提供时引擎/路由会注入更有意义的默认。

#### OpenAI 兼容参数

| 参数 | 类型 | Form 默认值 | 说明 |
|------|------|--------|------|
| `file` | file | (必填) | 音频文件，支持 wav / mp3 / m4a / flac / webm / mp4（容器内由 ffmpeg 解码） |
| `model` | str | `whisper-1` | 模型名称。`whisper-1` 是别名，回退到 yaml 中配置的默认（通常 `large-v2`）。完整列表见 `GET /v1/models` |
| `language` | str | `null` | **基础形式：ISO 639-1 二字母码**（`zh` / `en` / `ja` …，与 OpenAI Audio API 一致）。不填则自动检测（详见 1.1.4 节）。详见下方「语种参数接受形式」 |
| `response_format` | str | `json` | 输出格式：`json` / `text` / `verbose_json` / `srt` / `vtt` / `lrc`（示例见 §2.9） |
| `prompt` | str | `null` | 引导提示词（映射到底层 `initial_prompt`）。不填且 `language` 已知时自动注入语种提示（见 1.1.2 节） |
| `temperature` | str | `"0,0.2,0.4,0.6,0.8,1.0"` | 逗号分隔的温度回退列表。从首值开始尝试，质量检测不通过时升温重试 |
| `task` | str | `transcribe` | `transcribe`（输出原语种）或 `translate`（翻译为英文）。`/v1/audio/translations` 端点强制 `translate` 并忽略本字段 |

> **语种参数接受形式**（适用于本节及 §2.5 / §2.6 的 `language`）：
> - **基础形式**（推荐）：ISO 639-1 二字母码，如 `en` / `zh` / `ja` / `ko` / `fr`。这与 OpenAI Audio API、`faster-whisper` 引擎、`verbose_json` 返回的 `language` 字段都保持一致，是**所有示例与测试覆盖的默认形式**。
> - **兼容形式**：本开发版 API 层额外接受 Whisper 标准的英文语种名（`English` / `Chinese` / `Japanese` / …，大小写不敏感）以及常见别名（如 `Mandarin` → `zh`、`Castilian` → `es`），由 API 入口处的归一化层自动转为 ISO 码后交给引擎。这是为兼容上游 Whisper-WebUI Gradio 下拉框习惯增加的；未知输入会返回 HTTP 400 并列出可接受值。
> - **不要混用**：返回值（如 `verbose_json` 的 `language`）始终是 ISO 码，与请求传的形式无关。脚本/SDK 若需对比，请始终以 ISO 码为准。

#### 模型管理

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `compute_type` | str | None | 计算精度：float16/int8/float32。不填使用配置默认值 |

#### 解码策略参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `beam_size` | int | 5 | 波束宽度 |
| `best_of` | int | 5 | 候选数量 |
| `patience` | float | 1 | beam search 耐心因子 |
| `length_penalty` | float | 1 | 长度惩罚 |
| `repetition_penalty` | float | 1 | 重复惩罚（>1 抑制重复） |
| `no_repeat_ngram_size` | int | 0 | n-gram 去重（>0 启用） |
| `hotwords` | str | None | 热词提示（⚠️ 格式有讲究，详见 1.2.3 节） |

#### 上下文与提示参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `condition_on_previous_text` | bool | **False** | 关闭上下文关联，防幻觉（详见 1.1.1） |
| `prompt_reset_on_temperature` | float | 0.5 | 温度超过此值时重置 prompt |
| `prefix` | str | None | 首窗口前缀 |

#### 质量阈值参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `hallucination_silence_threshold` | float | **2** | 幻觉检测静音阈值（秒），详见 1.1.1 |
| `compression_ratio_threshold` | float | 2.4 | 压缩比阈值 |
| `log_prob_threshold` | float | -1.0 | 对数概率阈值 |
| `no_speech_threshold` | float | 0.6 | 静音检测阈值 |

#### Token 控制参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `suppress_blank` | bool | True | 抑制空白输出 |
| `suppress_tokens` | str | `-1` | 逗号分隔的 token ID 列表，-1 为默认抑制集 |
| `max_new_tokens` | int | None | 最大生成 token 数 |

#### 时间戳参数

| 参数 | 类型 | Form 默认值 | 说明 |
|------|------|--------|------|
| `word_timestamps` | bool | `false` | 词级时间戳。当 `response_format` 为 `verbose_json` / `srt` / `vtt` / `lrc` 时引擎内部会强制开启以便切段，但响应里仍按本字段控制是否暴露 `words` |
| `timestamp_granularities[]` | str[] | `null` | **OpenAI 官方字段的兼容别名**。传 `timestamp_granularities[]=word` 等价于 `word_timestamps=true`；传 `timestamp_granularities[]=segment` 是默认行为（仅 verbose_json）。允许同时传两个值。这是 OpenAI Python SDK 的 `client.audio.transcriptions.create(...)` 调用的标准形态，无需改 SDK 代码即可拿到词级时间戳。未知值会被静默忽略以保持前向兼容。详见 §2.10.7 OpenAI 结构兼容性约定。 |
| `without_timestamps` | bool | `false` | 不生成段级时间戳（仅影响 segment 边界，不影响响应格式） |
| `max_initial_timestamp` | float | `1.0` | 第一个时间戳的最大值（秒） |
| `prepend_punctuations` | str | `null` | 前合并标点（仅 `word_timestamps=true` 时生效）。**未填时服务端注入默认值** `"'"¿([{-`（含 Unicode 左引号 `‘` `“`）|
| `append_punctuations` | str | `null` | 后合并标点（仅 `word_timestamps=true` 时生效）。**未填时服务端注入默认值** `"'.。,，!！?？:：")]}、`（含全角中文标点与右引号 `’` `”`）|

#### 语言检测参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `multilingual` | bool | False | 逐段语言检测 |
| `language_detection_threshold` | float | 0.5 | 语言检测置信度阈值 |
| `language_detection_segments` | int | 1 | 语言检测使用的段数 |

#### 音频分段参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `clip_timestamps` | str | `0` | 截取时间范围 |
| `chunk_length` | int | None | 音频分段长度（秒） |
| `log_progress` | bool | False | 显示进度 |

#### VAD 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `vad_filter` | bool | **True** | 启用 Silero VAD（详见 1.1.1） |
| `vad_threshold` | float | 0.5 | 语音检测阈值 |
| `vad_neg_threshold` | float | None | 静音结束阈值 |
| `vad_min_speech_duration_ms` | int | **250** | 最短语音段（ms），过滤噪声误检 |
| `vad_max_speech_duration_s` | float | **9999** | 最长语音段（秒），避免强制切断 |
| `vad_min_silence_duration_ms` | int | **500** | 最短分句静音（ms），控制断句灵敏度 |
| `vad_speech_pad_ms` | int | 400 | 语音前后填充（ms），防止起止被截断 |
| `vad_min_silence_at_max_speech` | int | 98 | 达到最大语音长度时的最短静音（ms） |
| `vad_use_max_poss_sil_at_max_speech` | bool | True | 是否在最大语音处使用最大可能静音 |

#### 引擎路径开关（Batched / Buffered）

| 参数 | 类型 | Form 默认值 | 说明 |
|------|------|--------|------|
| `batched` | bool | `null` | 是否走 WhisperX 式 Batched Inference Pipeline（VAD Cut & Merge + 批量并行）。**未填时跟随 WebUI 当前持久化勾选状态**（默认 `true`）。`true` / `false` 显式传入则只影响本次调用、不修改持久化（详见 1.1.2 Batched 小节）。**此参数是引擎层路由开关，决定 Whisper 内部如何处理音频，不属于后处理。** |
| `batch_size` | int | `null` | Batched 模式下 GPU batch_size。**未填时服务端默认为 16**。`batched=false` 时忽略。GPU 显存紧张时可降到 8 / 4 |

#### 后处理参数（对引擎输出文本的二次加工）

| 参数 | 类型 | Form 默认值 | 说明 |
|------|------|--------|------|
| `text_cleaning` | bool | `true` | 是否对每个 segment 跑"重复循环去除 + 中文标点全角化"（详见 1.1.2 节）。**Form 默认 `true`** — 与 `batched` 不同，本字段不读 yaml 全局，每个请求显式落值 |
| `segment_merging` | bool | `true` | 是否合并短 / 不完整的相邻 segment（受 30s / 300char 硬上限保护，详见 1.1.2 节）。**Form 默认 `true`** |

> **使用建议**：三个用户开关参数（`batched` / `text_cleaning` / `segment_merging`）默认都为 `true`，绝大多数场景保持默认即可。
> - 关闭 `batched`：回到 Whisper 经典 Buffered 路径——长音频后半崩坏风险大幅上升、速度降为 1/3~1/5。仅在需要 chunk 间语义连贯性（如有声书人物名一致性）或排查问题做对照时使用。
> - 关闭 `text_cleaning`：中文输出会保留 ASCII 半角逗号/问号，且不再有重复循环兜底——基本不建议关。
> - 关闭 `segment_merging`：输出会保留 Whisper 原始切分（更多更短的 segment）。适合做词级对齐、研究调试、或下游有自己切分逻辑的场景。
>
> 通过 WebUI 高级参数区的 `Batched Inference` / `Text Cleaning` / `Segment Merging` 复选框切换会改变全局默认（影响后续所有未传入对应参数的 API 调用），并**自动持久化**到 `default_parameters.yaml`（详见 2.2 节）。API 请求**显式传入**这三个参数则只影响本次调用，不修改持久化状态。
>
> **Batched 模式下的参数白名单/黑名单**：参见 1.1.2 节 Batched 小节的参数兼容矩阵。被代码层显式 drop 的 5 项是 `condition_on_previous_text` / `prompt_reset_on_temperature` / `hallucination_silence_threshold` / `vad_filter` / `vad_parameters`，全部对应 `_BATCHED_DROPPED_KWARGS`；`temperature` 列表会被收敛为标量首值。`prefix` 与 `clip_timestamps` 不在 drop 列表里、但与 Batched 的"chunk 独立解码 + VAD 自管切片"语义冲突，行为以 `BatchedInferencePipeline` 内部为准，**不建议在 Batched 模式下依赖**。诊断信息可通过 `_diag=true` 请求观察 `_meta.batched_dropped_kwargs` 字段。

#### BGM 分离参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `is_separate_bgm` | bool | False | 启用 UVR 背景音乐分离 |
| `uvr_model_size` | str | `UVR-MDX-NET-Inst_HQ_4` | UVR 模型 |
| `uvr_device` | str | None | 运行设备（默认 cuda） |
| `uvr_segment_size` | int | 256 | 分段大小 |
| `uvr_save_file` | bool | False | 保存分离后的音频文件 |
| `uvr_enable_offload` | bool | True | 完成后释放模型 |

#### 说话人分离参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `is_diarize` | bool | False | 启用说话人分离（pyannote） |
| `hf_token` | str | "" | HuggingFace Token（首次下载模型需要） |
| `diarization_device` | str | None | 运行设备（默认 cuda） |
| `diarization_enable_offload` | bool | True | 完成后释放模型 |

### 2.5 YouTube URL 转录端点

#### `POST /v1/audio/transcriptions/youtube`

直接传 YouTube 链接，服务端用 `pytubefix` 下载音频到临时目录，然后跑与 `/v1/audio/transcriptions` 完全相同的流水线。

**参数**：
- `youtube_url`（必填，str）：YouTube 视频完整 URL（支持 `https://www.youtube.com/watch?v=...` / `https://youtu.be/...` 两种标准形式）
- 其余 **59 个 Form 参数与 `/v1/audio/transcriptions` 完全一致**（详见 §2.4，含语言 / Batched / 后处理 / VAD / BGM / 说话人分离 / OpenAI 兼容 `timestamp_granularities[]` 等全部能力）。

**返回**：与 `/v1/audio/transcriptions` 完全相同（按 `response_format` 决定 json / verbose_json / srt / vtt / lrc / text）。

**错误响应**：

| HTTP 状态 | 触发情况 | 响应示例 |
|---|---|---|
| `400 Bad Request` | URL 无法被 pytubefix 解析（视频被删 / 私享 / 地区限制） | `{"detail":"Failed to download YouTube audio: <pytubefix 原始异常>"}` |
| `400 Bad Request` | 视频没有音频流（极少见，多见于失败的直播录像） | `{"detail":"Failed to download YouTube audio: no audio-only stream available for this video"}` |
| `500 Internal Server Error` | 镜像里没安装 `pytubefix` | `{"detail":"pytubefix is not installed inside the runtime image."}` |
| `500 Internal Server Error` | 下游 Whisper 引擎异常 | `{"detail":"<exception message>"}` |

**实现要点**：
- 不复用上游 `modules.utils.youtube_manager.get_ytaudio`，因为它会写到固定的 `modules/yt_tmp.wav`，**并发不安全**。我们每个请求各自 `mkdtemp(prefix="yt_")` 隔离，请求结束 `shutil.rmtree` 清理。
- `pytubefix` 已在 `deployment.yaml` 的 `pip install` 中显式声明（防御性装一遍，避免基础镜像回归）。
- pytubefix 偶尔因为 YouTube 后端变化失败，**建议先调一次 `/v1/youtube/metadata` 确认 URL 可解析**再启动长音频转录。

#### `GET /v1/youtube/metadata`

**查询参数**：`url`（必填，query string）— YouTube 视频 URL

**返回示例（成功）**：
```json
{
  "title": "Sample Video Title",
  "author": "Sample Channel",
  "description": "Full video description text here...",
  "thumbnail_url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  "length_seconds": 1234,
  "views": 567890,
  "publish_date": "2023-04-15T00:00:00",
  "channel_url": "https://www.youtube.com/channel/UCxxxxx"
}
```

**返回示例（失败）**：
```json
{"detail": "Failed to fetch YouTube metadata: <pytubefix exception>"}
```
HTTP 状态 `400`。

**用途**：
1. 转录前确认 URL 可解析（视频未被删 / 未被地区限制）
2. 根据 `length_seconds` 估算转录耗时（large-v2 + Batched 路径下，~70× 实时速度）
3. 把 `title` 当做后续保存字幕文件的命名提示

### 2.6 `/v1/audio/translations` 音频翻译端点

#### `POST /v1/audio/translations`

调用 Whisper 内置的 **`task=translate`** 功能，将任意语言的语音直接翻译为英文文本（注意：不是用 NLLB/DeepL，而是 Whisper 模型本身的 speech-to-text-translation 能力）。

**参数**：与 `/v1/audio/transcriptions` 完全相同的 **59 个 Form 参数 + 1 个 `file` 字段**（详见 §2.4），唯一差异是内部强制 `task=translate`，请求里传的 `task` 字段会被忽略。

**返回**：与 `/v1/audio/transcriptions` 同结构，仅 `verbose_json` 中的 `task` 字段固定为 `"translate"`，`language` 字段是源语言（不是目标英文）。

**与转录端点的差异速查**：

| 项 | `/v1/audio/transcriptions` | `/v1/audio/translations` |
|---|---|---|
| 内部 `task` | 用户可选 `transcribe` / `translate` | 强制 `translate` |
| 输出语言 | 与源语言相同（按 `language` 或自动检测） | **始终英文** |
| 参数全集 | 59 个 Form（与转录端点同） | **同 59 个 Form**（本开发版已对齐，含 OpenAI 兼容 `timestamp_granularities[]`）|
| 自动 prompt 注入 | 按 `language` 注入 `_LANG_PROMPTS` 提示 | 同左（按源语言注入） |
| Batched / Cleaning / Merging | 支持 | 支持 |
| BGM / Diarization / VAD | 支持 | 支持 |

> **相对基线版本的变更说明**：基线版本中此端点只暴露 OpenAI 公开的 5 个字段（`file` / `model` / `response_format` / `prompt` / `temperature`），且硬编码了 `condition_on_previous_text=False`、`vad_filter=True`、`vad_parameters={500, 400}` 等参数，不暴露 `batched` / `batch_size` / VAD / BGM / 说话人分离等开关。本开发版已对齐转录端点全量参数（59 个 Form 字段，含 `batched` / `batch_size` / `text_cleaning` / `segment_merging` 等本开发版新增能力）。

> **OpenAI SDK 兼容性**：调用 OpenAI Python SDK 的 `client.audio.translations.create(...)` 时只会传 `file` / `model` / `prompt` / `response_format` / `temperature` 这几个字段，与本端点子集完全兼容；想用 Batched 等高级参数需绕过 SDK 直接构造 HTTP 请求（见 §2.10.6）。

### 2.7 `/v1/text/translations/nllb` NLLB 文本翻译

#### `POST /v1/text/translations/nllb`

使用 Facebook 的 **NLLB-200（No Language Left Behind）** 模型在本地 GPU 上做文本翻译，覆盖约 200 种语言。模型首次使用时从 HuggingFace 下载到 `/Whisper-WebUI/models/NLLB`。

**Form 参数**：

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `src_lang` | str | (必填) | 源语言。可填**友好名称**（`English` / `Chinese (Simplified)`）或 **NLLB 代码**（`eng_Latn` / `zho_Hans`）。<br>⚠️ **不接受 ISO 639-1 两字母代码**（`EN` / `ZH`），与 DeepL 不同——NLLB 上游本身就没有 ISO 639-1 概念。传 `EN` 等会被本服务以 `400 Unknown NLLB source language 'EN'` 拒绝。完整 name/code 列表见 `GET /v1/translations/nllb/languages` |
| `tgt_lang` | str | (必填) | 目标语言，同 `src_lang` 的规则（含 ISO 639-1 不被接受的限制） |
| `model_size` | str | `facebook/nllb-200-distilled-600M` | 必须用完整 HF 模型路径，三选一：`facebook/nllb-200-distilled-600M`（默认，~2.4GB）/ `facebook/nllb-200-1.3B`（~5.2GB）/ `facebook/nllb-200-3.3B`（~13GB）。⚠️ 传短名（如 `distilled-600M`）会被上游 `update_model` 拒绝，可通过 `GET /v1/translations/nllb/models` 查询当前镜像支持的完整 ID 列表 |
| `max_length` | int | 200 | 每段译文最大 token 数（NLLB 用 SentencePiece 分词，约对应 100-150 个英文词） |
| `text` | str | None | 纯文本输入：单个字符串 **或** 一个 JSON 数组（如 `["hi", "world"]`）|
| `file` | file | None | 字幕文件上传：`.srt` 或 `.vtt`（与 `text` 二选一） |
| `response_format` | str | `json` | 文件模式可选：`json` / `text` / `srt` / `vtt` / `lrc`；文本模式可选 `json` / `text` |

**返回格式**：

| 输入 | response_format | 输出示例 |
|------|---|------|
| 单条文本 | `json`（默认） | `{"text": "翻译结果"}` |
| 文本数组 `["a","b"]` | `json`（默认） | `{"texts": ["a 的翻译", "b 的翻译"]}` |
| 文本（数组或单条） | `text` | 纯文本字符串（数组用 `\n` 拼接） |
| 字幕文件 | `json`（默认） | `{"text": "全文拼接", "segments": [{"start":0.0,"end":2.5,"text":"…"}, ...]}` |
| 字幕文件 | `srt` / `vtt` / `lrc` | 对应格式的纯文本响应（时间戳保持原样，`Content-Type: text/plain` 或 `text/vtt`） |
| 字幕文件 | `text` | 全文 `\n` 拼接的纯文本 |

**字幕文件 `json` 模式完整响应示例**（输入英文 SRT，目标中文）：

```json
{
  "text": "你好,世界。\n这是第二行。\n这是第三行。",
  "segments": [
    {"start": 0.0,  "end": 2.5,  "text": "你好,世界。"},
    {"start": 2.5,  "end": 5.0,  "text": "这是第二行。"},
    {"start": 5.0,  "end": 7.5,  "text": "这是第三行。"}
  ]
}
```

**实现要点**：
- 全局单例懒加载 + `threading.Lock` 串行化推理调用，避免上游 `update_model` 在多线程下的竞态。
- 字幕文件**完全在内存中**解析-翻译-重建，不写盘（不像上游 `translate_file` 会写到 `outputs/translations/`）。
- 每次请求都会调一次 `update_model(model_size, src_lang, tgt_lang)`，**不在 API 层缓存上一次的 (model, src, tgt) 三元组**。原因是同一个 `NLLBInference` 单例同时被 WebUI 的 NLLB 翻译 Tab 驱动——WebUI 可以在 API 调用之间改换 pipeline 的语言方向，若 API 层维护自己的缓存则可能错配方向、悄无声息地翻译错语种。代价仅为一次 dict 查表 + HF pipeline 重建（毫秒级），模型权重不会重下载。
- 同一 `model_size` 反复调用：模型已加载时 `update_model` 不会重下载，只重建一次 HF pipeline（毫秒级开销）。
- 跨 `model_size` 切换会重新下载/加载模型，**冷启动较慢**（`nllb-200-distilled-600M` 约 30 秒、`nllb-200-1.3B` 约 1 分钟、`nllb-200-3.3B` 约 3-5 分钟，取决于网络与磁盘）。

**错误响应**（与 §2.8 DeepL 对称）：

| HTTP 状态 | 触发情况 | 响应示例 |
|---|---|---|
| `400 Bad Request` | 既未传 `text` 也未传 `file`，或两个都传了 | `{"detail":"Provide either 'text' or 'file'"}` |
| `400 Bad Request` | 字幕解析后零段 | `{"detail":"No subtitle segments parsed from the uploaded file"}` |
| `400 Bad Request` | `src_lang` / `tgt_lang` 为空字符串或仅空白 | `{"detail":"NLLB source language is required"}` |
| `400 Bad Request` | `src_lang` / `tgt_lang` 既不是合法 friendly name 也不是合法 NLLB code（含传 ISO 639-1 两字母代码） | `{"detail":"Unknown NLLB source language 'EN'. Use the 'name' or 'code' from GET /v1/translations/nllb/languages."}` |
| `422 Unprocessable Entity` | `src_lang` / `tgt_lang` 未传 / `max_length` 不是整数之类的 FastAPI 校验错 | FastAPI 标准 `{"detail":[{"type":"missing","loc":["body","src_lang"],...}]}` |
| `500 Internal Server Error` | 上游 NLLB 模块不可用 / 模型加载失败（磁盘满 / HF 网络中断 / `model_size` 拼写错误） | `{"detail":"NLLB unavailable: <异常>"}` 或 `{"detail":"Failed to load NLLB model: <异常>"}` |

#### `GET /v1/translations/nllb/models`

返回三个可用模型：
```json
{"object": "list", "data": [
  {"id": "facebook/nllb-200-3.3B", "object": "model", "owned_by": "facebook", "created": 0},
  {"id": "facebook/nllb-200-1.3B", "object": "model", "owned_by": "facebook", "created": 0},
  {"id": "facebook/nllb-200-distilled-600M", "object": "model", "owned_by": "facebook", "created": 0}
]}
```

#### `GET /v1/translations/nllb/languages`

返回 NLLB-200 支持的全部语种（**约 200 个**），每个条目含友好名（`name`）和 NLLB 内部代码（`code`）。下面是截断示例：

```json
{"object": "list", "data": [
  {"name": "English",              "code": "eng_Latn"},
  {"name": "Chinese (Simplified)", "code": "zho_Hans"},
  {"name": "Chinese (Traditional)","code": "zho_Hant"},
  {"name": "Japanese",             "code": "jpn_Jpan"},
  {"name": "Korean",               "code": "kor_Hang"},
  {"name": "French",               "code": "fra_Latn"},
  {"name": "German",               "code": "deu_Latn"},
  {"name": "Spanish",              "code": "spa_Latn"},
  {"name": "Russian",              "code": "rus_Cyrl"},
  {"name": "Arabic",               "code": "arb_Arab"}
  /* ... 余下 ~190 项省略 ... */
]}
```

> **`code` 的命名约定**：`<ISO 639-3 三字母>_<ISO 15924 文字脚本>`，如 `zho_Hans` = 简体中文、`zho_Hant` = 繁体中文。translate 端点传 `src_lang` / `tgt_lang` 时既接受 `name`（更友好）也接受 `code`（更精确）。

### 2.8 `/v1/text/translations/deepl` DeepL 文本翻译

#### `POST /v1/text/translations/deepl`

将请求转发到 [DeepL 云端 API](https://www.deepl.com/pro-api)，由 DeepL 完成翻译。**调用方必须自带 DeepL API Key**（免费档或 Pro 档均可）。

**Form 参数**：

| 参数 | 类型 | Form 默认 | 说明 |
|------|------|------|------|
| `auth_key` | str | (必填) | DeepL API Key。免费档 Key 通常以 `:fx` 结尾。仅在本次请求中转发，**不落盘**（详见下方安全提示）|
| `src_lang` | str | (必填) | 源语言，DeepL 友好名（`English`）或代码（`EN`）。可填 `"Automatic Detection"` 让 DeepL 自动检测（此时内部映射为 `null`，DeepL 会从文本推断） |
| `tgt_lang` | str | (必填) | 目标语言，同上。常用：`English (American)`/`EN-US`、`English (British)`/`EN-GB`、`Chinese`/`ZH`、`Japanese`/`JA`、`German`/`DE`、`Portuguese (Brazilian)`/`PT-BR` |
| `is_pro` | bool | `false` | `true` → `https://api.deepl.com`（Pro 档）；`false` → `https://api-free.deepl.com`（Free 档）。**与 `auth_key` 必须匹配，否则 403** |
| `text` | str | `null` | 纯文本输入：单条字符串 OR JSON 数组（如 `["a","b"]`）。与 `file` **二选一** |
| `file` | file | `null` | 字幕文件上传：`.srt` / `.vtt`。与 `text` **二选一** |
| `response_format` | str | `json` | 同 NLLB 端点：`json` / `text` / `srt` / `vtt` / `lrc` |

**返回格式**：与 §2.7 NLLB 端点的返回结构完全一致（单文本 / 数组 / 字幕文件三种），只是翻译质量与可用语种由 DeepL 决定。

**关键安全提示**：
- 你的 `auth_key` 仅作为请求体的一个字段，由本服务原样转发到 DeepL，**不会写入 yaml / 不会写入日志 / 不会缓存**。这一点是相对于上游 Whisper-WebUI `translate_deepl` 的明显差异——上游会把 API Key 写到 `default_parameters.yaml` 里持久化。
- 字幕文件按 **50 行一批**转发给 DeepL（DeepL 公开 API 默认批大小）。任意一批失败整个请求返回 `502 Bad Gateway`，已成功翻译的批次会被丢弃（无部分成功语义）。

**错误响应**：

| HTTP 状态 | 触发情况 | 响应示例 |
|---|---|---|
| `400 Bad Request` | 既未传 `text` 也未传 `file`，或两个都传了 | `{"detail":"Provide either 'text' or 'file'"}` |
| `400 Bad Request` | 字幕解析后零段 | `{"detail":"No subtitle segments parsed from the uploaded file"}` |
| `400 Bad Request` | `src_lang` / `tgt_lang` 为空字符串或仅空白 | `{"detail":"DeepL source language is required"}` |
| `400 Bad Request` | `src_lang` / `tgt_lang` 既不是合法友好名也不是合法代码 | `{"detail":"Unknown DeepL source language 'Klingon'. Use the 'name' or 'code' from GET /v1/translations/deepl/languages."}` |
| `422 Unprocessable Entity` | `auth_key` 未传 / `is_pro` 不是布尔值之类的 FastAPI 校验错 | FastAPI 标准 `{"detail":[{"type":"missing","loc":["body","auth_key"],...}]}` |
| `502 Bad Gateway` | DeepL 拒绝（无效 Key / 配额超限 / 真实通过 DeepL 上游的语种问题） | `{"detail":"DeepL request failed: <上游异常>"}`（`auth_key` 已脱敏为 `***<末四位>`）|

#### `GET /v1/translations/deepl/languages`

返回 DeepL 支持的源/目标语种（**约 30+ 项**）。**`Automatic Detection` 的 `code` 字段为 JSON `null`**，调用 translate 时填字符串 `"Automatic Detection"` 即可，路由会处理：

```json
{
  "source": [
    {"name": "Automatic Detection", "code": null},
    {"name": "English",  "code": "EN"},
    {"name": "Chinese",  "code": "ZH"},
    {"name": "Japanese", "code": "JA"},
    {"name": "German",   "code": "DE"},
    {"name": "French",   "code": "FR"},
    {"name": "Spanish",  "code": "ES"},
    {"name": "Russian",  "code": "RU"}
    /* ... 余下约 24 项省略 ... */
  ],
  "target": [
    {"name": "English (American)",     "code": "EN-US"},
    {"name": "English (British)",      "code": "EN-GB"},
    {"name": "Chinese",                "code": "ZH"},
    {"name": "Japanese",               "code": "JA"},
    {"name": "Portuguese (European)",  "code": "PT-PT"},
    {"name": "Portuguese (Brazilian)", "code": "PT-BR"}
    /* ... 余下约 24 项省略 ... */
  ]
}
```

> **DeepL 源/目标语种的非对称**：源端 `English` 是单一 `EN`，但目标端必须明确选择 `EN-US` 或 `EN-GB`；`Portuguese` 同理（`PT-PT` / `PT-BR`）；中文目标端目前只有 `ZH`（不区分简繁）。

### 2.9 输出格式示例

适用于 `/v1/audio/transcriptions` / `/v1/audio/transcriptions/youtube` / `/v1/audio/translations` 三个音频端点；翻译端点的 `task` 字段固定为 `"translate"`、`language` 字段是源语言。

#### `json`（默认）

最精简，只含转录全文：
```json
{"text": "今天天气真好。"}
```

#### `verbose_json`

包含分段、置信度等丰富信息。下面的示例**同时包含 `speaker` 和 `words`** 两个条件字段：

```json
{
  "task": "transcribe",
  "language": "zh",
  "duration": 5.12,
  "text": "今天天气真好。",
  "segments": [
    {
      "id": 0,
      "start": 0.0,
      "end": 2.5,
      "text": "今天天气真好。",
      "speaker": "SPEAKER_00",
      "avg_logprob": -0.15,
      "compression_ratio": 1.2,
      "no_speech_prob": 0.01,
      "temperature": 0.0,
      "words": [
        {"word": "今天", "start": 0.0, "end": 0.5, "probability": 0.98},
        {"word": "天气", "start": 0.5, "end": 1.0, "probability": 0.97}
      ]
    }
  ]
}
```

**字段出现条件**：

| 字段 | 出现条件 | 备注 |
|---|---|---|
| 顶层 `task` / `language` / `duration` / `text` | 始终出现 | `language` 是引擎检测/确认的代码（如 `zh` / `en`） |
| `segments[].id` / `start` / `end` / `text` | 始终出现 | 时间戳单位为秒 |
| `segments[].avg_logprob` / `compression_ratio` / `no_speech_prob` / `temperature` | 始终出现 | 引擎质量信号，可用于过滤异常段 |
| `segments[].speaker` | **仅当 `is_diarize=true` 且 pyannote 成功运行时** | 形如 `SPEAKER_00` / `SPEAKER_01` ... |
| `segments[].words` | **仅当 `word_timestamps=true` 或 `timestamp_granularities[]=word`** | 注意 `srt`/`vtt`/`lrc` 这几个格式内部强制开启 word_timestamps 用于切段，但响应里只有显式传入 `word_timestamps=true` 或 OpenAI 兼容字段 `timestamp_granularities[]=word` 才会暴露此字段 |

#### `srt`

带行号、时间戳，`Content-Type: text/plain`：
```
1
00:00:00,000 --> 00:00:02,500
今天天气真好。

2
00:00:02,500 --> 00:00:05,120
明天去爬山。
```

#### `vtt`

WebVTT 字幕，`Content-Type: text/vtt`：
```
WEBVTT

00:00:00.000 --> 00:00:02.500
今天天气真好。

00:00:02.500 --> 00:00:05.120
明天去爬山。
```

#### `lrc`

歌词格式，时间戳精度到 0.01 秒，`Content-Type: text/plain`：
```
[00:00.00]今天天气真好。
[00:02.50]明天去爬山。
```

#### `text`

纯文本，`Content-Type: text/plain`，所有 segment text 按空格拼接：
```
今天天气真好。 明天去爬山。
```

### 2.10 API 调用示例

> 集群内访问基址：`http://whisperwebui-svc.whisperwebuiv2server-shared:8000`（Pod 内）或 `http://<host>:8082`（通过 nginx entrance 暴露）。下面示例统一用 `http://<host>:8000` 占位。
> 所有 11 个端点都暴露在 `/openapi.json`，浏览器打开 `/docs` 可交互调试（FastAPI 自带 Swagger UI）。

#### 2.10.0 运维与发现（健康检查 / 模型列表 / OpenAPI）

```bash
# 健康检查（模型加载完成返回 ok，加载中返回 loading）
curl http://<host>:8000/healthz
# → {"status":"ok"}

# Whisper 模型列表
curl http://<host>:8000/v1/models
# → {"object":"list","data":[{"id":"large-v2","object":"model","owned_by":"local","created":0}, ...]}

# Swagger UI（浏览器打开）
echo "http://<host>:8000/docs"

# 拿 OpenAPI 3.x 规范，可导入 Postman / Insomnia
curl http://<host>:8000/openapi.json -o openapi.json
```

#### 2.10.1 音频转录 `/v1/audio/transcriptions`

```bash
# 基础转写（自动语言检测 + 自动 initial_prompt）
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@audio.wav

# 中文最佳质量（指定语言 + 自定义 prompt，不用 hotwords）
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@audio.wav \
  -F language=zh \
  -F prompt="以下是一段中文会议录音，请保留完整标点符号。"

# 中文 + hotwords（注意格式：中文逗号分隔 + 末尾句号）
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@audiobook.wav \
  -F language=zh \
  -F prompt="以下是刘慈欣科幻小说的朗读。请保留完整标点符号。" \
  -F hotwords="刘慈欣，流浪地球，地球发动机，巨峰，巨殿，小星老师。"

# 带 BGM 分离 + SRT 字幕输出
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@song.mp3 \
  -F language=zh \
  -F is_separate_bgm=true \
  -F response_format=srt

# 说话人分离 + 详细 JSON
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@meeting.wav \
  -F language=zh \
  -F is_diarize=true \
  -F hf_token=hf_xxxxx \
  -F word_timestamps=true \
  -F response_format=verbose_json

# OpenAI 风格的词级时间戳调用（用 timestamp_granularities[] 这个 OpenAI 官方字段；
# OpenAI Python SDK 的 client.audio.transcriptions.create(timestamp_granularities=["word"], ...) 也会发出此请求）
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@audio.wav \
  -F response_format=verbose_json \
  -F "timestamp_granularities[]=word"

# 快速模式（牺牲质量换速度）
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@audio.wav \
  -F beam_size=1 \
  -F best_of=1 \
  -F temperature=0

# 关闭段合并 —— 获取 Whisper 原始切分（保留文本清洗 + Batched）
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@audio.wav \
  -F response_format=srt \
  -F segment_merging=false

# 完全关闭后处理 —— 获取 Whisper 最原始输出（仍走 Batched 路径）
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@audio.wav \
  -F text_cleaning=false \
  -F segment_merging=false

# 强制 Buffered 模式（对照实验 / 需要 chunk 间语义连贯性）
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@audio.wav \
  -F batched=false

# Batched 模式但缩小 batch_size 应对 GPU 显存紧张
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@long_audio.mp3 \
  -F batched=true \
  -F batch_size=8

# 完全关闭所有后处理 + 关闭 Batched —— 纯 Whisper 经典行为（调试用）
curl -X POST http://<host>:8000/v1/audio/transcriptions \
  -F file=@audio.wav \
  -F batched=false \
  -F text_cleaning=false \
  -F segment_merging=false
```

#### 2.10.2 YouTube URL 转录 `/v1/audio/transcriptions/youtube`

```bash
# 先用 metadata 端点确认 URL 可解析、时长合理
curl -G "http://<host>:8000/v1/youtube/metadata" \
  --data-urlencode "url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# 直接转 YouTube 视频为 SRT 字幕
curl -X POST http://<host>:8000/v1/audio/transcriptions/youtube \
  -F youtube_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" \
  -F language=en \
  -F response_format=srt

# YouTube 中文播客 + 自动检测 + 输出 verbose_json
curl -X POST http://<host>:8000/v1/audio/transcriptions/youtube \
  -F youtube_url="https://www.youtube.com/watch?v=..." \
  -F response_format=verbose_json

# YouTube 长视频 + 关 Cleaning（只想要 Whisper 原始输出）+ 增加 batch_size
curl -X POST http://<host>:8000/v1/audio/transcriptions/youtube \
  -F youtube_url="https://www.youtube.com/watch?v=..." \
  -F text_cleaning=false \
  -F segment_merging=false \
  -F batch_size=16
```

#### 2.10.3 语音翻译为英文 `/v1/audio/translations`

```bash
# 简单调用（OpenAI 兼容用法）
curl -X POST http://<host>:8000/v1/audio/translations \
  -F file=@chinese_audio.wav \
  -F response_format=text

# 长中文音频 → 英文字幕（VTT），开启 Batched + 后处理
curl -X POST http://<host>:8000/v1/audio/translations \
  -F file=@chinese_long.wav \
  -F batched=true \
  -F response_format=vtt

# 带说话人分离的会议翻译
curl -X POST http://<host>:8000/v1/audio/translations \
  -F file=@meeting_zh.wav \
  -F is_diarize=true \
  -F hf_token=hf_xxxxx \
  -F response_format=verbose_json
```

#### 2.10.4 NLLB 文本翻译 `/v1/text/translations/nllb`

> **本节示例统一使用 NLLB 规范代码**（`eng_Latn` / `zho_Hans` / `jpn_Jpan` …），与 `GET /v1/translations/nllb/languages` 返回的 `code` 字段一致，是模型原生形式。本端点的友好名（`English` / `Chinese (Simplified)`）作为内置别名也被接受，详见 §2.7 参数表与下方"友好名等价形式"小节。
>
> ⚠️ **NLLB 不接受 ISO 639-1 两字母代码**（`EN` / `ZH` / `JA` …），与 DeepL 不同——NLLB 上游 `NLLB_AVAILABLE_LANGS` 只有 friendly name 和 NLLB code（`<ISO 639-3>_<ISO 15924>` 格式）两种形式。若从 DeepL 习惯过来直接传 `EN`，会被本服务以 `400 Unknown NLLB source language 'EN'` 拒绝（并提示去查 `GET .../nllb/languages`）。

```bash
# 查询可用模型与语种
curl http://<host>:8000/v1/translations/nllb/models
curl http://<host>:8000/v1/translations/nllb/languages

# 单条文本翻译（英 → 简体中文）
curl -X POST http://<host>:8000/v1/text/translations/nllb \
  -F src_lang="eng_Latn" \
  -F tgt_lang="zho_Hans" \
  -F text="Hello, how are you today?"
# → {"text":"你好,今天好吗?"}

# 批量文本翻译（输入 JSON 数组）
curl -X POST http://<host>:8000/v1/text/translations/nllb \
  -F src_lang="eng_Latn" \
  -F tgt_lang="jpn_Jpan" \
  -F text='["Hello.", "How are you?", "Goodbye."]'
# → {"texts":["こんにちは。","お元気ですか?","さようなら。"]}

# 字幕文件翻译（SRT 输入 → SRT 输出，保留原时间戳）
curl -X POST http://<host>:8000/v1/text/translations/nllb \
  -F src_lang="eng_Latn" \
  -F tgt_lang="zho_Hans" \
  -F file=@english.srt \
  -F response_format=srt \
  -o chinese.srt

# 用更大的模型（13GB，需要更高显存）
curl -X POST http://<host>:8000/v1/text/translations/nllb \
  -F src_lang="eng_Latn" \
  -F tgt_lang="kor_Hang" \
  -F model_size="facebook/nllb-200-3.3B" \
  -F text="The quick brown fox jumps over the lazy dog."

# ── 友好名等价形式（兼容支持，与上面任一示例等价）─────────────
# API 入口处会把友好名转为 NLLB code 再交给模型。
curl -X POST http://<host>:8000/v1/text/translations/nllb \
  -F src_lang="English" \
  -F tgt_lang="Chinese (Simplified)" \
  -F text="Hello world"
```

#### 2.10.5 DeepL 文本翻译 `/v1/text/translations/deepl`

> **本节示例统一使用 DeepL 规范代码**（`EN` / `ZH` / `EN-US` / `PT-BR` …），与 `GET /v1/translations/deepl/languages` 返回的 `code` 字段一致，是 DeepL 上游 API 原生形式。本端点的友好名（`English` / `Chinese` / `English (American)`）作为内置别名也被接受，详见 §2.8 参数表与下方"友好名等价形式"小节。

```bash
# 查询 DeepL 支持的语种
curl http://<host>:8000/v1/translations/deepl/languages

# 单条文本（免费档 Key）
curl -X POST http://<host>:8000/v1/text/translations/deepl \
  -F auth_key="your-deepl-free-key:fx" \
  -F src_lang="EN" \
  -F tgt_lang="ZH" \
  -F text="Hello, world!"

# 使用 DeepL 自动语言检测（源语言为字符串 "Automatic Detection"，路由内部映射为 null）
curl -X POST http://<host>:8000/v1/text/translations/deepl \
  -F auth_key="your-deepl-free-key:fx" \
  -F src_lang="Automatic Detection" \
  -F tgt_lang="EN-US" \
  -F text="Bonjour, comment allez-vous?"

# Pro 档 Key + 批量翻译
curl -X POST http://<host>:8000/v1/text/translations/deepl \
  -F auth_key="your-deepl-pro-key" \
  -F is_pro=true \
  -F src_lang="EN" \
  -F tgt_lang="JA" \
  -F text='["Welcome.", "Please sign in.", "Thank you."]'

# ── 友好名等价形式（兼容支持，与上面任一示例等价）─────────────
# DeepL 友好名通过 src/tgt 端的语种字典映射到代码后转发。
curl -X POST http://<host>:8000/v1/text/translations/deepl \
  -F auth_key="your-deepl-free-key:fx" \
  -F src_lang="English" \
  -F tgt_lang="Chinese" \
  -F text="Hello, world!"

# 字幕文件翻译（VTT → VTT）
curl -X POST http://<host>:8000/v1/text/translations/deepl \
  -F auth_key="your-deepl-free-key:fx" \
  -F src_lang="EN" \
  -F tgt_lang="DE" \
  -F file=@subtitles.vtt \
  -F response_format=vtt \
  -o subtitles_de.vtt
```

#### 2.10.6 Python SDK 示例

```python
import os
import json
import requests

BASE = "http://whisperwebui-svc.whisperwebuiv2server-shared:8000"
# 集群外通过 nginx entrance：BASE = "http://<host>:8082"

# ── 0. 健康检查 + 模型列表 ──────────────────────────────────────
print(requests.get(f"{BASE}/healthz").json())            # → {"status":"ok"}
print(requests.get(f"{BASE}/v1/models").json())          # → {"object":"list","data":[...]}

# ── 1. YouTube 转字幕（先 metadata 探活，再启动长任务） ─────────
meta = requests.get(f"{BASE}/v1/youtube/metadata",
                    params={"url": "https://www.youtube.com/watch?v=..."}).json()
print(f"Video: {meta['title']}, {meta['length_seconds']}s")

r = requests.post(f"{BASE}/v1/audio/transcriptions/youtube",
                  data={"youtube_url": "https://www.youtube.com/watch?v=...",
                        "language": "en",
                        "response_format": "srt"})
with open("output.srt", "wb") as f:
    f.write(r.content)

# ── 2. 上传音频 → 中文转录 + 全开 Batched + 后处理 ─────────────
with open("audio.wav", "rb") as f:
    r = requests.post(f"{BASE}/v1/audio/transcriptions",
                      files={"file": ("audio.wav", f, "audio/wav")},
                      data={"language": "zh",
                            "response_format": "verbose_json",
                            "batched": "true",
                            "text_cleaning": "true",
                            "segment_merging": "true"})
data = r.json()
print(data["text"])
for seg in data["segments"]:
    print(seg["start"], "-", seg["end"], seg["text"])

# ── 3. Whisper 语音翻译为英文（全量参数可用） ──────────────────
with open("japanese_audio.wav", "rb") as f:
    r = requests.post(f"{BASE}/v1/audio/translations",
                      files={"file": ("japanese_audio.wav", f, "audio/wav")},
                      data={"response_format": "verbose_json",
                            "batched": "true",
                            "is_diarize": "false"})  # 也可叠加 BGM/Diarize 等
print(r.json()["text"])

# ── 4. NLLB 字幕翻译（SRT → SRT） ──────────────────────────────
with open("input.srt", "rb") as f:
    r = requests.post(f"{BASE}/v1/text/translations/nllb",
                      files={"file": ("input.srt", f, "application/x-subrip")},
                      data={"src_lang": "eng_Latn",
                            "tgt_lang": "zho_Hans",
                            "response_format": "srt"})
with open("output_zh.srt", "wb") as f:
    f.write(r.content)

# ── 5. NLLB 批量纯文本翻译（JSON 数组）─────────────────────────
r = requests.post(f"{BASE}/v1/text/translations/nllb",
                  data={"src_lang": "eng_Latn",
                        "tgt_lang": "jpn_Jpan",
                        "text": json.dumps(["Hello.", "Goodbye."])})
print(r.json()["texts"])

# ── 6. DeepL 批量文本翻译（带自动检测） ────────────────────────
# 注意：DeepL 自动检测的源端没有代码（/languages 返回 "code": null），
# 因此调用方必须传字符串 "Automatic Detection"，由路由内部映射为 null
# 再转发给 DeepL；这是接口对"自动检测"的唯一表达形式。
r = requests.post(f"{BASE}/v1/text/translations/deepl",
                  data={"auth_key": os.environ["DEEPL_KEY"],
                        "src_lang": "Automatic Detection",
                        "tgt_lang": "EN-US",
                        "text": json.dumps(["こんにちは", "안녕하세요", "你好"])})
print(r.json()["texts"])  # → ["Hello", "Hello", "Hello"]

# ── 7. OpenAI Python SDK 兼容用法（不需要改业务代码） ──────────
from openai import OpenAI
client = OpenAI(base_url=f"{BASE}/v1", api_key="not-used")

with open("audio.wav", "rb") as f:
    transcript = client.audio.transcriptions.create(
        model="whisper-1",
        file=f,
        language="zh",
        response_format="text",
    )
print(transcript)

# 翻译为英文（OpenAI SDK 兼容）
with open("french_audio.wav", "rb") as f:
    translation = client.audio.translations.create(
        model="whisper-1",
        file=f,
        response_format="text",
    )
print(translation)
```

> **注意**：OpenAI SDK 不会传我们扩展的 `batched` / `text_cleaning` / `language_detection_threshold` 等字段。要用这些高级参数，直接构造 `requests.post(...)` 即可（如上面 §2-4 所示），SDK 的便利性和扩展参数二选一。

#### 2.10.7 OpenAI Whisper API 兼容性约定（本开发版承诺）

本开发版的 transcribe / translate 端点对**不传扩展字段的调用**承诺与 OpenAI Whisper API 的请求/响应**结构兼容**：OpenAI SDK 标准调用方式无需任何代码改动即可对接，扩展字段不传则一律走合理默认。

**请求层**（OpenAI SDK 标准参数→本服务原生支持）：

| OpenAI 官方字段 | 本服务实现 | 等价表达 |
|---|---|---|
| `file` | ✓ | 同名 |
| `model` | ✓ | 同名（基线唯一暴露的是 `whisper-1`，本服务接受任何字符串） |
| `language` | ✓ | 同名（**额外接受**英文全名 `English` / `Chinese` 等，详见 §2.4 语言参数小节） |
| `prompt` | ✓ | 同名（等同 OpenAI 的 `initial_prompt` 语义） |
| `response_format` | ✓ | 同名（**额外支持** `lrc`） |
| `temperature` | ✓ | 同名（**额外支持**列表，触发 Whisper 内置温度回退） |
| `timestamp_granularities[]=word` | ✓ | 等价于 `word_timestamps=true`，**OpenAI SDK 标准调用方式直接可用** |
| `timestamp_granularities[]=segment` | ✓ | verbose_json 默认行为 |

**响应层**：

- `response_format=json`：响应体 `{"text": "..."}`，与 OpenAI 完全一致（无任何额外字段、无任何额外响应头）。
- `response_format=verbose_json`：响应体是 OpenAI 官方字段（`language` / `duration` / `text` / `segments[...]`）**的超集**——本服务在顶层会多附加一个 `task` 字段（取值 `"transcribe"` / `"translate"`，对应当次调用），既方便区分两个端点的响应、又被 OpenAI SDK 视为未知字段自动忽略。
- `response_format=text` / `srt` / `vtt` / `lrc`：纯文本响应，无 `_meta`、无 `X-Whisper-*` 头。
- 当且仅当显式传入 `_diag=true`（私有诊断字段，公开 SDK 不会传）时，verbose_json 响应才会出现 `_meta` 字段、其他格式才会出现 `X-Whisper-*` 头——这是收尾自动化测试套件用的内部接口，对外不暴露。

不在上面 OpenAI 字段表中、由本开发版增量暴露的所有字段（`batched` / `text_cleaning` / `segment_merging` / `is_diarize` / `is_separate_bgm` / `hotwords` / VAD 调优 / 等 50+ 个）都**有合理默认值**，OpenAI SDK 不传它们时一律走默认路径——所以同一段调用代码既可以对接官方 OpenAI 服务、也可以对接本服务，无需任何分支。

实测验证：本开发版收尾自动化测试套件里有一项专门的"默认响应零侵入自检"（详见 `whisperwebuiv2-test-bundle` Script 2 P1b），对 `response_format=verbose_json` 不传 `_diag` 的调用确认了响应里**不会**出现 `_meta` 字段、不会出现任何 `X-Whisper-*` 头。

---

## 三、测试用例集

### 3.1 中文测试音频

| 音频 | 下载链接 | 特点 | 难度 | 测试重点 |
|------|---------|------|------|---------|
| **鲁迅《朝花夕拾》** | [archive.org ZIP](https://archive.org/download/chao_hua_si_she_jl_librivox/chao_hua_si_she_jl_librivox_64kb_mp3.zip) | 专业朗读、标准普通话、无噪音、12 章节 | 中 | 文学用词、生僻词、长音频稳定性 |
| **LibriVox《聊斋志异》** | [librivox.org](https://librivox.org/liaozhai-zhiyi-by-pu-songling-0906/) | 古典文学朗读，用词更古雅 | 高 | 古文识别能力 |
| **标贝科技开源语音库** | [data-baker.com](http://www.data-baker.com/open_source.html) | 10000 句标准女声、48KHz、自带标注 | 低 | 标准普通话基线、可精确计算 CER |
| **OpenSLR Free ST 中文语料** | [openslr.org/38](https://www.openslr.org/38/) | 855 人手机录音、8.2GB、有转录文本 | 中 | 真实环境噪音、不同口音 |

**推荐测试流程**：
1. 先用标贝科技的短句测试基线准确率
2. 用朝花夕拾的第一章（狗·猫·鼠）测试长音频稳定性和文学用词
3. 自录一段 30 秒普通话测试最佳场景效果

### 3.2 英文测试音频

| 音频 | 下载方式 | 特点 | 难度 | 测试重点 |
|------|---------|------|------|---------|
| **TED Talks** | [ted.com](https://www.ted.com/talks) 每个 Talk 下方有 Download 按钮 | 标准演讲、有官方 transcript 逐字对比 | 低 | 英语基线（推荐 Simon Sinek、Tim Urban） |
| **Lex Fridman Podcast** | RSS: `lexfridman.com/feed/podcast/` | 2-4 小时深度对话、AI/科技话题 | 中 | 长音频稳定性、专有名词 |
| **LibriVox: The Great Gatsby** | [librivox.org](https://librivox.org/the-great-gatsby-by-f-scott-fitzgerald/) | 经典美国文学、专业朗读 | 低 | 对标朝花夕拾场景 |
| **LibriSpeech test-clean** | [openslr.org/12](https://www.openslr.org/12/) | 标准 ASR 基准测试集、有标注 | 低 | 精确 WER 量化 |

**对比测试建议**：

| 场景 | 中文测试 | 英文测试 |
|------|---------|---------|
| 标准朗读 | 朝花夕拾 | The Great Gatsby |
| 播客对话 | 硅谷101 / Steve说 | Lex Fridman |
| 正式演讲 | 央视新闻片段 | TED Talks |
| 基准量化 | 标贝科技 / AISHELL-1 | LibriSpeech test-clean |

---

## 四、已知问题与优化限制

### 4.1 已知问题

> **范围说明**：以下已知问题基于中文（流浪地球有声书 12 min）和英文（福尔摩斯波希米亚丑闻 64 min）系统实测。
> 通过 6 轮中英对照测试（附录 A.2）确认了多项之前的"已知问题"在 Batched 模式下已被**根治**——以下表格按"已根治 / 已大幅缓解 / 仍存在"三档重新分类。

#### 4.1.1 ✅ 已根治（本开发版 Batched Inference Pipeline 上线后）

| 问题 | 旧版表现 | 现状 |
|------|------|------|
| **长音频后半段累积崩坏** | Buffered 模式下 30 分钟以上音频后半段错误率显著上升、跨段错误传播 | Batched 路径切断 chunk 间上下文传递，64 min 英文实测后半段干净无崩坏 |
| **跨语言字符污染** | Buffered 在 silence/长气声处输出 `오` `勤才` `ったly` 等 CJK/日韩/西语字符混入英文 | Batched 路径下 64 min 英文样本完全未出现 |
| **整段编造对话** | Buffered 在长 silence 后凭空生成与原文无关的对话段落（含 `lol` / `fucking` / `30%` 等现代字符）| Batched 路径下 64 min 英文样本完全未出现 |
| **段内重复循环** | "I found her in the middle of the street, and I found her in the middle of the street" 段内重复 | Batched 各 chunk 独立解码 + `compression_ratio_threshold` + 后处理三层防护，未观察到 |

> 这些都是 Buffered 模式下 Whisper 引擎层面的崩坏，**后处理只能擦拭表面、无法修复根因**。Batched 是从架构层面解决问题。详细对照见附录 A.2 测试 Test 4 vs Test 5/6。

#### 4.1.2 ⚠️ 已大幅缓解但仍存在

| 问题 | 表现 | 影响范围 | 缓解措施 |
|------|------|---------|----------|
| **跨 chunk 专有名词漂移** | Batched 路径下同一专有名词在不同 chunk 各自被独立猜测一遍 | 长音频 + 罕见专有名词 | 用 `initial_prompt` / `hotwords` 注入专有名词列表（详见 1.2.2 / 1.2.3 节）。代价远小于旧 Buffered 模式的整段崩坏 |
| **静默 chunk 的 YouTube boilerplate 幻觉** | Batched 在演讲/朗读的长气声处偶发"Thank you for watching" / "Please subscribe" | 长音频（实测 64 min 出 1 处）| 计划在后续版本通过黑名单消除 |
| **英文 WebUI 重复循环** | Buffered 模式下 "The E-G." ×1000+、"of the murder..." ×数十次 | 关闭 Batched + 长英文音频 | 引擎级温度回退已修复 Buffered 路径的循环；Batched 路径根本不会触发 |
| **幻觉循环（已大幅抑制）** | 模型陷入重复输出同一句话 | 长音频（>30 分钟）| Batched 切断累积通道是最强防护；中文用 `temperature=0.2` 防贪心循环；API 通过温度回退列表防护。`temperature=0` **已确认**是循环的根本原因 |

#### 4.1.3 ❌ 仍存在（Whisper 模型本身的限制，与 Batched/Buffered 无关）

| 问题 | 表现 | 影响范围 | 示例 |
|------|------|---------|------|
| **同音/近音字替换** | 常用词被替换为同音词，声学完全正确但文字错误 | 中文高频 | "巨峰"→"飓风"、"刹住"→"杀住"、"寒战"→"喊着"、"极目"→"急目"、"嘤嘤"→"莺莺"、"聚变"→"巨变" |
| **中文标点不全角** | 逗号、问号、感叹号等输出为 ASCII 而非全角中文标点 | 所有中文 | `,` 而非 `，`、`?` 而非 `？`。**已通过段落后处理自动修正**（详见 1.1.2 节）|
| **hotwords 抑制标点** | 使用 hotwords 后标点完全消失或异常 | 使用 hotwords 时 | 空格分隔的 hotwords 导致全文无标点；追加标点字符导致输出恶化（详见 1.2.3 和 1.3 节） |
| **性别代词错误** | "她"被一致性地转为"他"（或反之） | 叙事性中文音频 | 女性角色的所有"她"被写成"他"，hotwords 对代词无效 |
| **罕见专有名词错** | 维多利亚时代英文专有名词识别差 | 英文文学/历史音频 | `Wedlock→Wetlock`、`Langham→Logram`、`Carte Blanche→Cote Blanche`、`Wallenstein→Wallstein`、`gasogene→guess-a-jean` |
| **英文品牌名在中文语境识别差** | 英文专有名词在中文语境下被误转 | 中英混杂场景 | "Cursor"→"科瑟"，"Perplexity" 被拆分 |
| **古典文学/文言文质量差** | 文言词汇几乎全部替换为现代口语 | 古文/文学朗读 | 古文成语、生僻词大量错误 |
| **歌曲歌词质量极差** | 旋律干扰导致大量幻觉输出 | 带 BGM 音频（中英文均确认） | 即使 BGM 分离后仍有明显错误（详见 1.5 节） |
| **Prefix 误填导致 Pod 崩溃** | 将 initial_prompt 内容填到 Prefix 字段，导致无限生成和资源耗尽 | 所有语言 | 已两次触发 Pod OOM Kill。详见 1.2.2 节的严重警告 |
| **中英文 Buffered 模式参数最优配置互斥** | Buffered 路径下不存在同时适合中英文的单一参数组合 | 仅 Buffered 模式 | 中文最佳需 `True+0.2+rep=1+ngram=0`，英文最佳需 `False+0.2+rep=1.1+ngram=5`。**Batched 模式下无此问题**（chunk 间无上下文传递）|
| **数字/单位混淆** | 数字和单位的听写容易出错 | 含大量数据的演讲 | "2024 年"→"二零二四年" 或反之 |

### 4.2 无法继续优化的根本原因

1. **训练数据偏差**：Whisper 的中文训练数据以现代口语为主，对书面语、文言文、文学用语覆盖不足
2. **词汇表限制**：BPE 分词器对中文的 token 覆盖有限，生僻字和专有名词容易被拆成多个 token 后重组出错
3. **英文为主的预训练**：Whisper 以英文为主要语言训练，中文语言模型能力天然弱于英文
4. **音乐场景非设计目标**：Whisper 设计用于语音转录，不是歌词识别
5. **Buffered 模式下中英文参数最优配置互斥**：经 15 轮系统测试，Buffered 路径下中英文的 token 粒度差异（中文每字约 1 token，英文每词 1-3 token）导致 `no_repeat_ngram_size`、`repetition_penalty` 等参数对两种语言的效果截然不同甚至相反。不存在同时适合中英文的单一参数集（详见附录 A.1 的完整测试矩阵）。**Batched 模式从架构层面绕过了这个问题——chunk 间无上下文传递，参数选择无需 trade-off**
6. **~~WebUI 缺失温度回退机制~~（已修复）**：已通过引擎级 Monkey-Patch 恢复完整的温度回退列表。WebUI 用户的 Slider 单值会自动扩展为回退列表（详见 1.1.2 节）
7. **~~中文标点混合 ASCII~~（已修复）**：Whisper 模型权重里硬编码的混合标点风格（ASCII 逗号/问号 + 中文句号），通过段落后处理 Monkey-Patch 已自动修正为全角（详见 1.1.2 节）
8. **~~长音频后半段累积崩坏~~（已根治）**：本开发版引入 Batched Inference Pipeline (WhisperX 式)，VAD 切分独立 chunk + 批量并行解码，切断了"上一段污染传播给下一段"的累积通道。64 min 英文实测从灾难变可用，速度 4.57× 提升（详见 1.1.2 节 + 附录 A.2）
9. **hotwords 机制设计缺陷**：Whisper-WebUI 将 hotwords 作为 `sot_prev` 后的上下文注入，模型会模仿其风格。纯词列表（无标点）导致输出丢失全部中文标点——这是底层实现的设计问题（英文场景下经实测同样会模仿但影响远小于中文）

### 4.3 如果一定要进一步优化的可能方案

| 方案 | 可行性 | 投入 | 效果预估 | 说明 |
|------|--------|------|---------|------|
| **中文标点后处理替换** | ★★★★★ | 极低 | 高（针对标点） | 在 API 输出层对 CJK 语言做 `,`→`，`、`?`→`？`、`!`→`！`、`:`→`：` 替换。最简单可靠 |
| **自定义 hotwords 词典** | ★★★ | 低 | 中 | 维护业务词典，按音频主题动态选取 hotwords。⚠️ hotwords 会抑制标点且有反向副作用，需谨慎 |
| **换用中文优化模型** | ★★★ | 中 | 高 | `belle-whisper-large-v3-zh`（Belle 中文微调版）或 `paraformer`（阿里达摩院中文专用）。需修改模型加载逻辑 |
| **Fine-tune Whisper** | ★★ | 高 | 高 | 用业务领域标注数据微调 Whisper。需 GPU 集群和标注数据 |
| **级联方案** | ★★★ | 中 | 高 | Whisper 初始转录 → 中文 ASR 专用模型（FunASR/Paraformer）二次校验 → 取优。架构复杂但效果好 |
| **多模型投票** | ★★ | 高 | 中-高 | 同一段音频多模型转录，取一致性最高结果。资源消耗大 |

**最推荐的路径**：短期保持 **中文标点后处理替换**（已默认生效）；中期考虑 **换用中文优化模型**。

---

## 附录 A：完整参数测试矩阵

> 本附录分三部分：
> - **A.1**：15 轮 Buffered 路径参数调优实测（用于回答"哪些参数应该是 PATCH 默认值"）
> - **A.2**：6 轮 Batched vs Buffered 中英对照实测（用于回答"Batched 路径是否真的根治了长音频崩坏"）
> - **A.3**：收尾验证套件（API 自动化测试）暴露并修复的 6 个真实 bug，全部严格 "API 层 only / WebUI 路径零侵入"

---

### A.1 完整参数测试矩阵（15 轮 Buffered 路径调优）

> 中文素材：《流浪地球》于和伟演播版有声书（约 3 分钟片段）  
> 英文素材：《福尔摩斯：波希米亚丑闻》LibriVox 有声书（约 1 小时 4 分钟）  
> 模型：Whisper large-v2, float16, beam_size=5, best_of=5  
> 环境：Olares / HAMI GPU 调度  
> **本轮测试所有 case 均为 Buffered 路径**（Batched Pipeline 尚未引入）

#### 参数说明

以下简写对应 WebUI 中的参数：
- **cond** = `condition_on_previous_text`（True/False）
- **temp** = `temperature`（0 / 0.2 / 0.4）
- **rep** = `repetition_penalty`（1 = 禁用，1.1 = 启用）
- **ngram** = `no_repeat_ngram_size`（0 = 禁用，3/5 = 启用）
- **prompt** = `initial_prompt` 内容

#### 测试结果

| # | cond | temp | rep | ngram | prompt | 语言 | 耗时 | 循环 | 大写 | 碎片化 | 总评 |
|---|------|------|-----|-------|--------|------|------|------|------|--------|------|
| 1 | True | 0 | 1 | 0 | 中文 | 中文 | 49s | ❌ 2处灾难循环 | 正常 | 无 | **不可用** |
| 2 | False | 0 | 1 | 0 | 中文 | 中文 | 52s | ❌ 2处循环（同#1） | 正常 | 无 | **不可用** |
| 3 | True | 0.4 | 1 | 0 | 中文 | 中文 | 43s | 无 | 正常 | 无 | 可用，略逊#4 |
| 4 | **True** | **0.2** | **1** | **0** | 中文 | 中文 | **43s** | ✅ 无 | ✅ 正常 | ✅ 无 | **中文最佳** |
| 5 | True | 0.2 | 1 | 0 | 中文 | 中文 | 43s | 无 | 正常 | 无 | ≈#4（验证复现） |
| 6 | False | 0.2 | 1 | 0 | 中文 | 中文 | 44s | 无 | 正常 | 无 | 可用，文风一致性略差 |
| 7 | True | 0.2 | 1 | 0 | 无 | 英文 | 6m20s | 无 | ❌ **全大写** | 无 | **不可用** |
| 8 | False | 0.2 | 1 | 0 | 无 | 英文 | 6m49s | ❌ 6处灾难循环 | 正常 | 无 | **不可用** |
| 9 | False | 0.4 | 1 | 0 | 无 | 英文 | 19m53s | ❌ 2处超长循环+幻觉 | 正常 | 无 | **不可用**（耗时×3） |
| 10 | **False** | **0.2** | **1.1** | **5** | 无 | 英文 | **3m46s** | ✅ 无 | ✅ 正常 | ✅ 无 | **英文最佳** |
| 11 | False | 0.2 | 1.1 | 5 | 中文 | 中文 | 39s | 无 | 正常 | ❌ **严重碎片化** | **不可用** |
| 12 | — | — | — | — | — | — | — | — | — | — | Prefix 误填导致 Pod 崩溃（详见 1.2.2 警告） |
| 13 | True | 0.2 | 1 | 0 | 英文 | 英文 | 19m53s | ❌ "The E-G." ×1000+ | 正常 | 无 | **不可用**（灾难循环） |
| 14 | True | 0.2 | 1.1 | 0 | 英文 | 英文 | 4m34s | 无 | 正常 | ⚠️ 后半段碎片化 | 半可用 |
| 15 | False | 0.2 | 1.1 | 0 | 英文 | 英文 | 3m41s | 无 | 正常 | ⚠️ 后半段碎片化 | 半可用 |

#### 核心结论

1. **`temperature=0` 是灾难循环的根本原因**（#1, #2 vs #4, #6），中英文均已复现，**必须改为至少 0.2**
2. **中英文最佳配置互斥**（#4 vs #10）——测试矩阵的 5 个变量中 4 个不同
3. **`no_repeat_ngram_size=5` 对英文有效但毁灭中文**（#10 vs #11），因中英文 token 粒度差异
4. **`repetition_penalty=1.1` 在长音频上导致渐进碎片化**（#14, #15），惩罚跨 segment 累积
5. **`condition_on_previous_text=True` 传播大写风格**（#7），英文标题朗读的全大写被传播到全文
6. **Prefix 误填是致命操作**（#12），填入 Initial Prompt 内容到 Prefix 导致 Pod 崩溃
7. **英文 initial_prompt + True 反而触发循环**（#13 vs #7），机制待进一步分析
8. **WebUI 缺失温度回退机制**是英文长音频质量问题的根本架构原因——**已通过引擎级 Monkey-Patch 修复**

#### 当前推荐配置（引擎级 Monkey-Patch 后）

引擎级 Monkey-Patch 实现后，WebUI 和 API 的差异大幅缩小。以下是统一推荐配置：

| 参数 | 推荐值 | 来源 | 说明 |
|------|--------|------|------|
| `temperature` | `0.2`（Slider 初始值） | PATCH + 引擎 Monkey-Patch | PATCH 写入 0.2；引擎在调用时再展开为 `[0.2, 0.4, 0.6, 0.8, 1.0]` 回退列表 |
| `condition_on_previous_text` | `False` | PATCH | 防止跨段错误传播 + 英文全大写问题 |
| `hallucination_silence_threshold` | `2` | PATCH | 捕获静音段幻觉 |
| `vad_filter` | `True` | PATCH | 跳过非语音段 |
| `min_silence_duration_ms` | `500` | PATCH | 合理断句 |
| `speech_pad_ms` | `400` | PATCH | 保留语音边界 |
| `repetition_penalty` | `1`（禁用） | 镜像默认 | 温度回退已处理循环，不需要此参数 |
| `no_repeat_ngram_size` | `0`（禁用） | 镜像默认 | 对中文有破坏性，禁用 |
| `initial_prompt` | 自动注入 | 引擎 Monkey-Patch | 根据语言自动注入提示词（用户已填写时跳过） |

> **用户操作**：保持所有默认值即可。WebUI 和 API 均自动获得完整的温度回退、语言提示词和段落后处理。
>
> **中文用户可选优化**：如果中文转录上下文连贯性不够，可以在 WebUI 中手动勾选 `condition_on_previous_text = True`。这对中文有轻微质量提升（利用上文语境），但对英文有全大写风格传播的风险。

---

### A.2 Batched vs Buffered 中英对照测试（6 轮）

> 中文素材：《流浪地球》第 01 集"刹车时代"于和伟演播（约 12 分 34 秒）  
> 英文素材：《福尔摩斯：波希米亚丑闻》LibriVox 有声书（**1 小时 04 分 31 秒**）  
> 模型：Whisper large-v2, float16, beam_size=5, best_of=5  
> 环境：Olares / HAMI GPU 调度（16 GiB GPU 限额）  
> 部署版本：本开发版（含 BatchedInferencePipeline + 三 Checkbox + 单槽缓存修复）

#### 测试矩阵

| # | 语言 | 音频时长 | Batched | Text Cleaning | Segment Merging | 耗时 | RTFx |
|---|---|---|---|---|---|---|---|
| 1 | 中 | 12:34 | ❌ | ✓ | ✓ | 47s | ~16× |
| 2 | 中 | 12:34 | ✓ | ❌ | ❌ | 22s | ~34× |
| 3 | 中 | 12:34 | ✓ | ✓ | ✓ | **16s** | **~47×** |
| 4 | 英 | 64:31 | ❌ | ✓ | ✓ | **4m 11s** | ~15.4× |
| 5 | 英 | 64:31 | ✓ | ❌ | ❌ | 1m 5s | ~59× |
| 6 | 英 | 64:31 | ✓ | ✓ | ✓ | **55s** | **~70×** |

**关键速度关系**：

- 中文 Buffered → Batched：47s → 16s = **2.9× 加速**
- 英文 Buffered → Batched：4m 11s → 55s = **4.57× 加速**

英文比中文加速更明显的原因：12 分钟音频太短，Silero VAD 启动开销占比偏高；64 分钟才是 Batched 加速效应的真实剂量，与 WhisperX 论文宣称的 3-5× 完全吻合。

#### Test 4 英文 Buffered 模式典型崩坏样本

> 这些是 64 min 英文 + Buffered + 全后处理（Test 4）的实际输出。Cleaning + Merging 两项后处理都开了，但仍然出现以下崩坏——证明**后处理只能擦拭表面，无法修复引擎层崩坏**。

##### 跨语言字符污染

> if your majesty would condescend to stay away from the man we have **오** but he was **勤才** of the city of bali...

韩文字符 `오`、中文字符 `勤才` 混入英文输出。这是 Whisper 在长 buffer 累积污染后语言识别完全错位的表现。

##### Spanish/Japanese/profanity 混入 + 整段编造

> but the coachman had counseled our lady and i continued on and **hijo** vit routinely to cajol my mother and being sniffed dearly for every**ったly**... when in fact she swore it was just as **fucking** podeous to keep the clip wicked... and she was undtailed **lol**... but the coachman had **conseguir**

西班牙语 `hijo` / `conseguir`、日文字符 `ったly`、现代俚语 `lol`、现代脏话 `fucking` 出现在 1891 年维多利亚小说里——是 Whisper 在 silence/长气声 buffer 区"自由发挥"产生的整段编造。

##### 段内重复

> In this case I found her **in the middle of the street, and I found her in the middle of the street.** I found sandwiched in between that of Hebrew rabbi

模型卡在 "I found her" 上循环，最后才硬接到正确句子。Cleaning 的 dedup 是相邻 segment 级别，对**段内重复**无效。

##### 整段 8 行凭空编造

原文应是 "But it has twice been **burgled**. Pshaw! They did not know how to look." Buffered 模式下输出：

> But it has twice been **burned**.（误听）
> Oh, she is old and fragile. She can not look.（编造）
> Oh, dear. Oh, dear. You know, I know.（编造）
> I have been invited to the commonwealth, and theazer on my way there will be a very good guest.（编造）
> She can be a great beauty, and I find her to be striking.（编造）
> I dare you not to fuss over a woman's duty, with such an **30%** of men.（编造，含数字"30%"凭空出现）
> No, sir, do not worry. I will not.（编造）
> No, sir. I am aware of the facts, and whet your self-esteem.（编造）
> carriage came round the curve of the avenue（才接回原文）

##### 关键单词丢失

与上面"乱加"相对的另一面——长句中部分关键词被 buffer 边界吞掉：

> His dress was rich with a richness which would, in England, be looked upon as akin to **a man**.

原文 *"akin to **bad taste**"* → `bad taste` 被吞了。后处理无法发现这种"少了什么"，因为输出本身在文本层合法。

#### Test 5/6（Batched 模式）的同段表现

同一段原文在 Test 5（Batched + 无后处理）和 Test 6（Batched + 全后处理）下：

- **没有跨语言字符污染**
- **没有整段编造对话**
- **没有段内重复**
- **没有单词丢失**
- 全文唯一可见副作用：Section 2 中段一处 `Thank you for watching.`（演讲长气声区域的训练集偏置回退输出）+ 专有名词跨 chunk 漂移（如 `Armstrong/Armstein`、`William Godstrich/Gottfried`）

#### Test 5 vs Test 6（Batched + 后处理双开 vs 裸 Batched）的边际对比

| 维度 | 中文（Test 2 vs Test 3）| 英文（Test 5 vs Test 6）|
|---|---|---|
| 标点 | Batched 裸输出常缺 CJK 标点，归一化收益大 | faster-whisper 英文标点本来就完整 |
| 段落 | Batched 裸输出 1-2 句一段，碎片化 | Batched 裸输出已 3-5 句一段 |
| 字面错误纠正 | 26 segments punct-fix | 0 字面变化（未触发清洗规则）|
| 视觉收益 | **可见** | **几乎不可见** |

**结论**：Cleaning + Merging 在中文场景明显增益、英文场景近 no-op。但保持双开默认合理——单向风险，且跨语言统一默认值比"按语言切换默认"简洁。

#### 六项最终结论（A.2 小结）

1. **Batched 路径根治了 Buffered 模式下长音频引擎层崩坏**——Test 4 vs Test 5/6 三组互斥证据
2. **后处理（Cleaning + Merging）无法替代 Batched**——Test 4 全开后处理仍崩坏，证明 Cleaning+Merging 只能擦拭表面、不能修复根因
3. **Batched 速度加速 3-5× 与 WhisperX 论文吻合**——长音频测试呈现 4.57× 加速
4. **`Batched=True / Cleaning=True / Merging=True` 是中英文统一最优默认**
5. **Batched 模式下中英文最优配置不再互斥**——架构上消除了"参数对中英文效果相反"的 trade-off（chunk 间无上下文传递、无 `no_repeat_ngram_size` 跨段累积惩罚问题）
6. **Batched 残留副作用仅 2 类**：跨 chunk 专有名词漂移（可通过 `initial_prompt` 注入救掉）+ silence chunk 的 YouTube boilerplate 幻觉（计划后续黑名单消除）

### A.3 收尾修复清单

本期收尾阶段通过完整自动化测试套件（详见 `whisperwebuiv2-test-bundle`）暴露并修复了 6 个真实 bug。每个修复都附实测复现与受控验证证据，并**严格遵循"API 层 only、WebUI 路径零侵入"**——`_patched_transcribe`（API 与 WebUI 共享的引擎包装层）不动，所有变更都落在 `_do_transcribe`（API 专属入口）或 form 字段层。

| # | 症状 | 根因 | 修复位置 | 测试证据 |
|---:|---|---|---|---|
| 1 | API 调用带较新 VAD 参数 → HTTP 500 `VadOptions.__init__() got an unexpected keyword argument 'min_silence_at_max_speech'` | 老版 faster-whisper 的 `VadOptions` 不认 `min_silence_at_max_speech` / `use_max_poss_sil_at_max_speech` 两个 1.1.x 字段，但本服务 Form 默认值带它们 | API 层 `_VAD_OPTIONS_FIELDS` introspect + 过滤，记录到 `_meta.vad_dropped_fields` | Script 1b / 4 中所有 Batched/Buffered 调用 `_meta.vad_dropped_fields` 都 ≤ 2 项，无 500 |
| 2 | `language=English` → HTTP 500 `'English' is not a valid language code` | faster-whisper 只接受 ISO 639-1 code（`en` / `zh`），但 OpenAI Whisper 文档约定接受英文全名 | API 层 `_normalize_language` 接受 code / 全名 / 别名（如 `Mandarin → zh`、`Castilian → es`、`Burmese → my`，详见 `_LANGUAGE_NAME_TO_ISO` 字典），大小写不敏感；未知值 raise 400 并列出可接受形式 | Script 2 P1a/P1b/P1c `language=en` + P2a/P2b `language=zh` 均 200（ISO 639-1 code 正向通路）；Script 3 N10 `language=Klingon` → 400 `Unknown language` |
| 3 | **API 路径下 Batched 永远 fallback 到 Buffered**——`_meta.path == "batched_fallback_to_buffered"`，错误 `TypeError: string indices must be integers, not 'str'` | Form 字段 `clip_timestamps` 默认值是字符串 `"0"`；老版 `WhisperModel.transcribe` 自己 parse 字符串，新版 `BatchedInferencePipeline` 直接 iterate 整数下标 → 炸 | API 层在 `_do_transcribe` 把字符串 normalize 为 `list[float]`（空 / `"0"` 时干脆不传），WebUI 路径完全不动 | Script 1b C2/C6/C7 + Script 4 中 Batched 调用 `_meta.path == "batched"`（非 fallback）；长音频 Script 4 复测中文 1.87× / 英文 2.01× 加速 |
| 4 | DeepL `src_lang=EN` → HTTP 502 `DeepL request failed: Source language EN is not supported` | 上游 `request_deepl_translate` 严格按 friendly name（如 `English`）查表，但本服务 `/v1/translations/deepl/languages` 同时 advertise `code` 字段，导致用户复制 `code` 调用会失败 | API 层 `_normalise_deepl_lang` 双向接受 name/code（不分大小写、含 `EN-US`/`PT-BR` 等带连字符 target code），未知值 raise 400；空字符串 / whitespace 同样 raise 400 `DeepL <what> language is required`，与 NLLB 端的"空值 400"对称 | Script 3 N6（`src_lang=EN`+`tgt_lang=ZH` + 假 key）→ 502：normalize 层放行 → 转发到上游 → 上游拒假 key 才回 502，**反过来证明 `EN`/`ZH` code 已经被 normalize 成功映射**（修复前 `EN` 会在 normalize 层就被上游 wrapper 抛 `ValueError` 包成 502）；Script 3 N11（`src_lang=Klingon`）→ 400 + `Unknown DeepL source language 'Klingon'`，证明未知值直接被 normalize 层拒掉 |
| 5 | OpenAI SDK 调 `client.audio.transcriptions.create(timestamp_granularities=["word"], ...)` 响应里没 `words` | 服务端只识别历史字段 `word_timestamps=true`，没识别 OpenAI 官方字段 `timestamp_granularities[]` | API 层 Form 字段加 `alias="timestamp_granularities[]"`，`_do_transcribe` 收到 `"word"` 时 flip `word_timestamps=True` | Script 2 P1b（唯一带 `-F "timestamp_granularities[]=word"` 的用例）verbose_json 响应里 `segments[*].words` 存在；分析器 `analyze_api_positive.py` 显式断言"首 3 段中至少 1 段含 `words`" |
| 6 | NLLB 传 `src_lang=eng_Latn` / `tgt_lang=zho_Hans`（即 endpoint 列表里 advertise 的 `code` 字段）会 HTTP 500——上游 `NLLB_AVAILABLE_LANGS[src_lang]` 是直接 dict 索引，传任何非 friendly name 都会 `KeyError`，被 wrapper 包成 `500 "Failed to load NLLB model: 'eng_Latn'"` | 上游 `NLLBInference.update_model` 直接做 `NLLB_AVAILABLE_LANGS[src_lang]`，只接受 friendly name（与 DeepL 一样）；但 `/v1/translations/nllb/languages` 同时 advertise `code`，导致用户复制 `code` 调用会 500。NLLB 也**不接受 ISO 639-1 两字母代码**（`EN`/`ZH`），与 DeepL 不对称 | API 层 `_normalise_nllb_lang` 双向接受 name/code（不分大小写），未知值 raise 400（与 `_normalise_deepl_lang` 行为对齐）| Script 2 P4c/d/e 用 `src=eng_Latn`+`tgt=zho_Hans` 全部 PASS（修复前同一调用 KeyError → 500）；Script 3 N12 `src=Klingon` → 400 + `Unknown NLLB source language 'Klingon'` |

**严格分层证据**：上述 6 项修复涉及到的代码变更均集中在以下文件 / 函数：

- `_do_transcribe`（API 入口）：4 项（#1 VAD filter / #2 language normalize 调用 / #3 clip_timestamps normalize / #5 timestamp_granularities shim）
- `_transcribe_form_params`（FastAPI Depends）：1 项（#5 form 字段定义）
- `_normalise_deepl_lang`（API 工具函数）：1 项（#4）
- `_normalise_nllb_lang`（API 工具函数）：1 项（#6）
- `_normalize_language`（API 工具函数）：1 项（#2）
- `_VAD_OPTIONS_FIELDS` / `_TRANSCRIBE_KWARGS`（API 启动期 introspect）：1 项（#1，复用既有机制）

`_patched_transcribe`（API/WebUI 共享引擎层）**没有任何与本期 6 项修复相关的逻辑改动**——所有变更都集中在 `_do_transcribe`（API 入口）、`_normalise_*` / `_normalize_*`（API 工具函数）、以及 `_transcribe_form_params`（FastAPI Form 字段定义）这些 **API 专属层**。WebUI 路径在本期改造前后保持**行为与日志双一致**（包括 `Whisper progress` / `Segment merge` / `Text clean` / `BatchedInferencePipeline created` / `Batched mode: silently dropped` / `Batched transcription started` / `Text cleaning disabled` / `Segment merging disabled` 等所有 Pod 日志条目，沿用基线版本的 INFO 级输出）。

**复测验证**：

- 短音频 20 次受控对照（10 个 clip × Buffered/Batched）：`_meta.path` 全部正确（10 个 batched / 10 个 buffered），无 fallback
- 长音频复测：中文 14 min + 英文 59 min 共 4 次调用，`_meta.path` 全部正确
- API happy path 11 个端点 + `_meta` 4 个验证：全部 PASS
- API negative path：全部 PASS（含 N11 DeepL unknown language → 400 与 N12 NLLB unknown language → 400 两个对称用例，以及 N13 YouTube transcribe 缺 `youtube_url` → 422 与 N3 file 缺失对称）

详细数据见 `whisperwebuiv2-test-bundle/results/overall_*/OVERALL_REPORT.md`（由 `scripts/5_run_all_tests.sh` 一键串跑 Script 1/1b/2/3/4 并聚合产出）。

---

## 附录 B：处理流水线架构

```
用户音频
  │
  ├─ [BGM Separation] ─ UVR-MDX-NET 去背景音乐（可选）
  │     └─ 输出：纯人声音频
  │
  ├─ [Language Detection] ─ 自动检测语言 + 注入 initial_prompt（仅 API）
  │
  ├─ [Transcription Router]  ★ _patch_whisper_engine() 根据 batched 标志 + 是否为内部短路调用决策
  │     │
  │     ├──────────────────────────────────────────────────────────────────────┐
  │     ↓                                                                      ↓
  │  [Batched Path] ★ batched=True（默认）                  [Buffered Path] ★ batched=False
  │     │                                                                      │
  │     │  faster_whisper.BatchedInferencePipeline                             │  WhisperModel.transcribe（原生）
  │     ├─ Silero VAD 把整段音频切成独立 chunk            ├─ 30 秒滑动 buffer 逐段解码
  │     │   （由 chunk 实际边界决定，不是 30s 硬切）       ├─ condition_on_previous_text 决定上下文传递
  │     ├─ chunk 之间独立、并行解码（GPU batch_size=16） ├─ 温度回退（0.2 → 0.4 → ... → 1.0）
  │     ├─ chunk 间无上下文传递（切断累积污染通道）        │   ★ WebUI + API 均生效
  │     ├─ 静默忽略 _BATCHED_DROPPED_KWARGS 5 项：        │   （PATCH 写入 0.2 + Monkey-Patch 展开为列表）
  │     │   condition_on_previous_text /                   ├─ 自动 Initial Prompt ★ 用户未填时按语言注入
  │     │   prompt_reset_on_temperature /                  ├─ VAD 过滤（Silero VAD, threshold=0.5,
  │     │   hallucination_silence_threshold /              │   min_silence=500ms, speech_pad=400ms）
  │     │   vad_filter / vad_parameters                    ├─ 防幻觉：
  │     │   prefix / clip_timestamps 透传但语义冲突        │     condition_on_previous_text=False
  │     ├─ 自动 Initial Prompt ★ 用户未填时按语言注入       │     hallucination_silence_threshold=2
  │     ├─ beam_size=5, best_of=5（镜像默认值）            └─ beam_size=5, best_of=5（镜像默认值）
  │     ├─ 单槽 BatchedInferencePipeline 缓存：
  │     │   id(model) 不同时立即 evict + gc.collect()
  │     │   + torch.cuda.empty_cache() 释放 GPU 显存
  │     └─ 进度日志：每 25 segment 一条                       进度日志：每 25 segment 一条
  │     │
  │     └──────────────────────────────────────────────────────────────────────┘
  │                                  ↓
  │                       segments（流式产出）
  │
  ├─ [Segment Post-Processing] ★ 引擎级 Monkey-Patch（流式，对两条路径都生效）
  │     ├─ [Text Cleaning]  ★ WebUI 复选框 / API text_cleaning，默认 True
  │     │     ├─ 1. 重复循环去除（正则检测 3+ 次连续重复短语，折叠为单次；保留有意单字重复）
  │     │     └─ 2. CJK 标点全角化（, → ， 等）
  │     └─ [Segment Merging] ★ WebUI 复选框 / API segment_merging，默认 True
  │           └─ 3. 短段/不完整段合并（短 < 2s 或 < 5 字符 或 不以 .!?。！？ 结尾 → 吸收进下一段；
  │                 硬上限 30s / 300 字符，防止跑文连锁合并）
  │
  ├─ [Diarization] ─ pyannote 说话人分离（可选）
  │     └─ 为每个 segment 标注 speaker 标签
  │
  └─ [Output Formatting]
        ├─ json / verbose_json
        ├─ text
        ├─ srt / vtt / lrc
        └─ 支持 word-level timestamps
```

> **三个独立勾选项的逻辑关系**：
> - `Batched Inference`：决定走上图哪条引擎路径（Batched / Buffered）
> - `Text Cleaning`：决定后处理流水线的"文本清洗阶段"是否生效
> - `Segment Merging`：决定后处理流水线的"段合并阶段"是否生效
>
> 三者互相独立，可任意组合（共 8 种排列）。所有组合均会在切换时立即写入 `default_parameters.yaml` 的 `_post_processing` 节并跨 Pod 重启 / Chart 升级 / 浏览器刷新保留（详见 2.2 节）。
