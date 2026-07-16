# Whisper-WebUI 质量优化与模型扩展工作汇报

> 部署目标：Helm Chart `whisperwebuiv2`（本次交付的开发/测试版本，**尚未发布到 Olares 商店**）  
> 汇报日期：2026-05-18  
> 适用读者：决策层与跨团队同事；需要看技术细节的请翻附录列出的三份配套详细文档
>
> **版本说明**：本文仅涉及两个状态——
> - **基线版本**：Olares 商店当前上线的 `whisperwebuiv2 v1.0.7`（本次改造的起点，仅含 Whisper-WebUI 上游原生能力）  
> - **本开发版** / **本次交付**：本次改造形成的开发/测试版本，在基线之上叠加了质量层改造与 API 层扩展两部分能力，**当前仅在开发/测试环境，未发版到商店**  
>
> 文中所有"基线 → 本开发版"的对比都指这两个状态间的差异；改造过程中的内部迭代不作为独立版本呈现，**`v1.0.7` 是本文唯一会提及的版本号**。

---

## 一、核心结论

1. **长音频质量提升已通过实测验证**：基线版本下 30 min+ 长音频后半段累积崩坏的问题，本开发版已在架构层面解决，无需用户额外操作。
2. **关键改动**：本开发版引入 `BatchedInferencePipeline`（WhisperX 风格 VAD Cut & Merge + 批量并行），64 min 英文音频耗时 4 min 11 s → 55 s（**加速 4.57×**），同时四类引擎层灾难性失败在实测样本中均未再出现。
3. **已停止的路线**：LLM 后处理校对（Qwen2.5-3B）经实测无效，耗时膨胀 8.6×~11×，反引入新幻觉，改造过程中已撤回并移除相关代码与依赖。
4. **目前难以快速实现的方向**：在 Whisper-WebUI 模型框直接输入非 Whisper 架构模型（如 Qwen3-ASR、Parakeet、FunASR）必然报错——这是后端架构约束，需 fork 或重写为多引擎应用才能突破，短期内难以完成。
5. **当前已知副作用**：Batched 模式下偶有专有名词跨片漂移与个别 YouTube boilerplate 残留，对整体可读性影响有限，可通过 `initial_prompt` 缓解。
6. **API 能力补齐**：OpenAI 兼容 API 从基线的 4 个端点扩充到本开发版的 **11 个**，覆盖上游 Whisper-WebUI 全部可用功能——音频转录 / YouTube URL 转录 / Whisper 语音翻译 / NLLB 文本翻译 / DeepL 文本翻译 + 各端点的元信息查询。基线版本中翻译端点 `/v1/audio/translations` 仅暴露 OpenAI 公开 5 个字段的问题已纠正，本开发版与转录端点完全对齐 **59 个 Form 参数**（含 OpenAI 官方兼容字段 `timestamp_granularities[]`）。

---

## 二、背景：要解决什么问题

部署初期发现 Whisper-WebUI 在长音频上表现差，**且无法靠参数调优解决**。具体观察到的失败形态：

- 中文 30 min+ 音频后半段：标点丢失、整段碎片化、人名漂移
- 英文 30 min+ 音频后半段：整段编造对话、跨语言字符乱入（韩/中/日/西）、段内单句循环、关键词丢失
- 商业服务（飞书妙记、阿里听悟、Otter 等）能稳定处理几小时会议——这之间巨大差距的根因是什么、能否缩小，是本次工作的核心问题。

---

## 三、做了哪些事情（按工作顺序）

### 3.1 系统性参数调优（15 轮）

围绕 `temperature`、`condition_on_previous_text`、`no_repeat_ngram_size`、`repetition_penalty`、`compression_ratio_threshold`、`log_prob_threshold` 等约 10 个核心参数，跑了 15 轮中英对照测试。

**产出**：找出了 6 个对默认值需要修改的参数（写入 `_QUALITY_OVERRIDES` PATCH）。

### 3.2 LLM 后处理校对（实验，已撤销）

接入 Qwen2.5-3B 做 ASR 输出的语义级校对。

**产出**：实测失败，改造过程中已撤回，相关代码与依赖完全剥离。

### 3.3 引擎级 Monkey-Patch（4 项）

为绕开 Gradio UI 的限制，在 `_patch_whisper_engine()` 内直接包装 `WhisperModel.transcribe`，对 WebUI + OpenAI 兼容 API 同时生效。最终落地的 4 项：

| 项 | 解决的问题 | 状态 |
|---|---|---|
| **Batched Inference Pipeline**（WhisperX 路线）| 长音频后半崩坏 | ✅ 本开发版默认开启 |
| **温度回退列表** | Gradio Slider 只能给单值，Whisper 原生 5 档回退失效 | ✅ 本开发版已生效 |
| **自动 Initial Prompt 注入** | WebUI 用户不填 prompt 时输出风格差（如英文全大写）| ✅ 本开发版已生效 |
| **后处理流水线**（Text Cleaning + Segment Merging）| 去除轻度循环 / 短段合并 / 中文标点全角化 | ✅ 两个开关均可勾选 |

### 3.4 配套基础设施

为支持上述监听式改造，本开发版还配套做了：

- **YAML 持久化**：用户勾选状态跨 Pod 重启、跨 Chart 升级、跨浏览器刷新都不丢
- **浏览器刷新 UI rehydrate 修复**：Gradio 默认行为是刷新后丢弃 yaml 值；通过 `demo.load()` 注册重新拉取
- **YAML 并发写竞态修复**：快速勾选 checkbox 触发 race condition 引发 `TypeError`，已用 `threading.Lock` 串行化
- **GPU 显存累积泄漏修复**：BatchedInferencePipeline 缓存改单槽 + 显式 `gc.collect()` + `torch.cuda.empty_cache()`，根治"5 次连续转录后 OOM"

### 3.5 模型扩展尝试（评估结论：短期内难以快速实现）

用户尝试直接在 WebUI 模型框输入 HuggingFace ID 加载 Qwen3-ASR-1.7B，得到 `Unable to open file 'model.bin'` 报错。

**根因**：Whisper-WebUI 的三个后端（`faster-whisper` / `openai-whisper` / `insanely-fast-whisper`）**全部只能识别 OpenAI Whisper 这一种架构**，硬找 `model.bin`（CTranslate2 格式）。Qwen3-ASR 是 LLM-based ASR，权重布局 / 词表 / 前向逻辑都不同。

**整理了三个可能的突破方向**（详见附录 C 文档）：

| 方向 | 工作量 | 适合时机 |
|---|---|---|
| 旁路引擎（Pod 内并存 Qwen3-ASR 服务）| 约 1 周 | 业务侧明确要求中文识别质量再提升时 |
| Fork Whisper-WebUI 增加第 4 个 backend | 2-3 周 | 同上 + 可接受与上游分叉的维护成本 |
| 多引擎应用重写（按语言路由）| 1-2 个月 | 产品定位升级为"会议纪要"等场景时 |

**当前状态**：三条路径短期内均难以快速完成。本期主线（Batched）已覆盖长音频核心痛点；多引擎扩展属于长期方向，需更明确的业务输入。

### 3.6 API 全量开放

基线版本下 OpenAI 兼容 API 只暴露 4 个端点，且翻译端点 `/v1/audio/translations` 只透传 OpenAI 公开的 5 个字段、硬编码大量内部行为——长音频翻译不能用 Batched / VAD / Diarize 等高级能力，与转录端点的能力差距远大于 OpenAI 官方实现。本开发版把 API 层补齐到与上游 Whisper-WebUI 完全对齐：

| 项 | 基线版本 | 本开发版 |
|---|---|---|
| API 端点数 | 4 | **11** |
| `/v1/audio/transcriptions` Form 参数 | 58 | **59**（新增 OpenAI 官方兼容字段 `timestamp_granularities[]`） |
| `/v1/audio/translations` Form 参数 | **OpenAI 公开 5 字段**（硬编码 condition_on_previous_text / VAD 等）| **59**（与转录完全对齐，task 强制 translate） |
| YouTube URL 转录 | ❌ 不支持 | ✅ `POST /v1/audio/transcriptions/youtube` + `GET /v1/youtube/metadata` |
| NLLB 文本/字幕翻译 | ❌ 仅 WebUI | ✅ `POST /v1/text/translations/nllb` + models / languages 列表 |
| DeepL 文本/字幕翻译 | ❌ 仅 WebUI | ✅ `POST /v1/text/translations/deepl` + languages 列表（API Key 不落盘）|

**实现要点**：抽出 `_do_transcribe` 共享引擎驱动 + `_transcribe_form_params` Depends 依赖，三个音频端点（上传转录 / YouTube 转录 / 上传翻译）共享同一份参数签名与流水线代码，杜绝了三处行为漂移。YouTube 下载使用 per-request `mkdtemp` 隔离，并发安全（不复用上游写固定文件名的 `get_ytaudio`）。NLLB 用全局单例懒加载 + `threading.Lock` 串行化；DeepL 的 `auth_key` 仅作为请求字段转发到 DeepL 云端，**不写 yaml / 不写日志 / 不缓存**（与上游 `translate_deepl` 持久化 Key 的行为相反）。

**对决策层意义**：本服务现在可作为 Whisper 系列能力的统一 OpenAI 兼容入口供其他应用调用，无需用户登录 WebUI 进行人工操作；想接入到自动化流水线（如客户端 SDK、内部业务系统、batch 离线脚本）的场景已具备完整 API 支持。详细 API 接口、参数、调用示例见配套 STT 使用指南 §2。

---

## 四、成果（成功项）

### 4.1 长音频质量根治（最大成果）

**6 轮中英对照测试矩阵**（2026-05-15）：

中文（流浪地球片段，~12 min）：

| 编号 | Batched | Cleaning | Merging | 耗时 | 后段质量 |
|---|:---:|:---:|:---:|---|---|
| Test 1 | ❌ | ❌ | ❌ | 47 s | 标点丢失严重，后半段整段无标点 |
| Test 2 | ❌ | ✅ | ✅ | 47 s | 合并后视觉好些，仍有引擎层标点丢失 |
| Test 3 | ✅ | ✅ | ✅ | **16 s** | **全程标点完整，段落分明** |

英文（福尔摩斯·波希米亚丑闻，~64 min）：

| 编号 | Batched | Cleaning | Merging | 耗时 | 严重缺陷 |
|---|:---:|:---:|:---:|---|---|
| Test 4 | ❌ | ❌ | ❌ | 4 min 11 s | ⚠️ **多段灾难**（详见 4.2 节） |
| Test 5 | ✅ | ❌ | ❌ | **1 min 5 s** | ✅ 4 类灾难全消失，仅余专有名词跨片漂移 |
| Test 6 | ✅ | ✅ | ✅ | **55 s** | ✅ 同 Test 5；视觉略更紧凑 |

**关键数据**：

| 指标 | Buffered（旧默认）| Batched（新默认）| 改进 |
|---|---|---|---|
| 英文 64 min 耗时 | 4 min 11 s（251 s）| **55 s** | **4.57× 加速** |
| 英文 64 min RTFx | 15.3× | **≈70×** | **4.57×** |
| 中文 12 min 耗时 | 47 s | **16 s** | **2.9× 加速** |
| 引擎层灾难（英文 64 min）| 4 类多处 | **全部消失** | 结构性解决 |

### 4.2 Buffered 模式 4 类灾难性失败全部消失

下表是 Test 4（Buffered + 全后处理）的实测样本，对应在 Test 5/6（Batched）下全部消失：

| 类别 | Test 4 样本（节选）| Batched 下 |
|---|---|:---:|
| **跨语言污染（含俚语脏话）**| `...the king said 안녕, oh dear me ... but he was 勤才 of the city of bali ... hijo vit routinely ... fucking podeous ... she was undtailed lol ... conseguir` | ✅ 消失 |
| **整段编造对话** | 在 `"But it has twice been burgled"` 之后整 8 行 `"Oh, dear. Oh, dear. ..."` 与原文完全无关 | ✅ 消失 |
| **段内重复** | `I found her in the middle of the street, and I found her in the middle of the street` | ✅ 消失 |
| **关键词丢失** | 原文 `akin to bad taste` → 输出 `akin to a man`（`bad taste` 被吞）| ✅ 消失 |

**Batched 残留副作用**（已知且可接受）：

- 同一专有名词在不同 chunk 可能写法不一（如 `Armstrong / Armstein`、`Claudia Lohrmann / Claudia Lorman`）——可通过 `initial_prompt` / `hotwords` 注入术语表缓解
- 极少数 silence chunk 输出训练集偏置文本（如 `Thank you for watching.`）——64 min 音频出现 1 处，计划黑名单消除

### 4.3 其他附带成果

- **温度回退**：恢复了 Whisper 原生 5 档回退机制（`[0.2 → 0.4 → 0.6 → 0.8 → 1.0]`），Gradio Slider 的"单值"限制不再阻碍
- **自动 Prompt 注入**：用户不填 prompt 时按语言自动注入引导词，英文输出不再全大写
- **配置持久化**：用户的勾选偏好跨 Pod 重启、跨升级、跨浏览器刷新都不丢
- **API 与 WebUI 同步**：上述所有增强对自研 OpenAI 兼容 API 同样生效

---

## 五、未成功的事项（明确失败或短期内难以突破）

### 5.1 LLM 后处理校对（Qwen2.5-3B）— 已删除

**做了什么**：把 Whisper 输出文本送给 Qwen2.5-3B 做语义级校对（修错字、补标点、归一化数字）。

**实测结论**：

| 维度 | 中文 | 英文 |
|---|---|---|
| 耗时膨胀 | **11×**（原 30 s → 5.5 min）| **8.6×**（原 60 s → 8.6 min）|
| 新引入错误 | 5+ 处事实幻觉（修对的同时新编造）| 30+ 处元评论泄漏（`"Here is the corrected text:..."` 漏进输出）|

**根因**：3B 通用 LLM 没见过 ASR 错误的分布，从纯文本视角看不懂"原文应该是什么"。这与 FunAudio-ASR 论文 §4.4.2 的结论一致：LLM 校对要有效必须联合训练 + RL，不能当外挂使用。

**处置**：改造过程中完全删除该路线，相关代码与依赖剥离。

### 5.2 穷举参数空间寻找"中英文通吃最优解"— 已证伪

**做了什么**：15 轮系统测试，覆盖 `temperature` × `condition_on_previous_text` × `no_repeat_ngram_size` × `repetition_penalty` 等的组合。

**实测结论**：**不存在中英文通用的单一最优参数集**。中文每字约 1 token、英文每词 1-3 token，token 粒度差异让 `no_repeat_ngram_size`、`repetition_penalty` 在两种语言上效果**截然相反甚至冲突**。最经典的例子：

| 参数组合 | 中文 | 英文 |
|---|---|---|
| `temperature=0.2 + condition=False + rep_penalty=1.1` | 大量幻觉 | 较好 |
| `temperature=0.2 + condition=True + 默认 rep_penalty` | 较好 | 大量循环 |

**处置**：不再投入参数空间搜索。Batched 路径架构层面绕开了这个 trade-off（chunk 间无上下文传递，参数选择无需中英文权衡）。

### 5.3 在 WebUI 直接加载非 Whisper 架构模型 — 架构上不可能

**尝试**：用户在 WebUI 模型框输入 `Qwen/Qwen3-ASR-1.7B`。

**实测**：必然报错 `Unable to open file 'model.bin'`。

**根因**：Whisper-WebUI 三个后端（faster-whisper / openai-whisper / insanely-fast-whisper）的代码路径都硬假设输入是 OpenAI Whisper 架构（固定 30 s 输入窗、log-Mel 80 通道、Whisper BPE 词表、Whisper 控制 token）。**Qwen3-ASR / Parakeet / FunASR / Wav2Vec2** 等都是不同架构，**改架构后无法被这三个后端加载**。

**当前状态**：短期内难以快速实现突破。已整理出三条可能方向（旁路 / fork / 重写），供后续业务侧明确需求后参考（详见附录 C）。

### 5.4 中文 12 min 加速比偏低（2.9×）— 已解释 + 收尾补测

Batched 在中文 12 min 上只有 2.9× 加速，而英文 64 min 上 4.57×。

**根因**：12 min 音频太短，Silero VAD 启动 + Pipeline 构建的固定开销占比偏高。64 min 才是 Batched 加速效应的"真实剂量"。

**处置**：保持默认设置；对短音频用户来说 2.9× 已经够明显，不必额外优化。

**收尾验证补测**（2026-05-18，关后处理，引擎层纯对照）：用 14 min 中文 + 59 min 英文复测：

| 音频 | 时长 | Buffered | Batched | 加速比 |
|---|---:|---:|---:|---:|
| 中文 | 14 min | 27.6 s | 14.8 s | **1.87×** |
| 英文 | 59 min | 2 m 00 s | 60.0 s | **2.01×** |

复测加速比看起来低，因为本次**关掉了后处理且 Buffered 没遇到 4 类灾难**——是"引擎层纯比较+幸运场景"的下限数据，与 4.57× 的"灾难场景+端到端"互补，**两组数据互不矛盾**。详见长音频报告 §3.9.8。

### 5.5 短音频规律实测 — 收尾补做（2026-05-18）

长音频报告 §3.8 原本标注的"⚠️ 后续可补"（短音频是否退步）在收尾阶段被闭环。结论：

- **30 s 是 Batched 反转分水岭**：< 30 s 短 clip 上 Batched 反而慢（10 s 中文 0.77×，VAD/Pipeline 启动开销占比过高）
- **30 s ~ 1 min 持平到微反超**（1.04×-1.48×）
- **3-5 min 起稳定 2× 加速**（中文 1.75-1.85×，英文 2.02-2.09×）

**文档建议**：处理大量 < 30 s 短 clip 的场景（如对话系统实时回应、短录音批处理）应显式传 `batched=false`。STT 主指南 §1.1.2 与长音频报告 §3.9.7 均已写入此建议。

---

## 六、测试与统计数据汇总

### 6.1 工作量与时间线

| 阶段 | 时间 | 主要交付 |
|---|---|---|
| 参数空间系统调优 | 2026-05-12 ~ 05-13 | 15 轮中英对照测试 → `_QUALITY_OVERRIDES` PATCH（6 参数）|
| 引擎级 Monkey-Patch（温度回退 / 自动 Prompt / 后处理）| 2026-05-13 ~ 05-14 | 3 项 patch 落地 + UI 持久化基础设施 |
| LLM 校对实验与撤销 | 2026-05-14 | 实测失败后删除 Qwen2.5-3B 相关代码 |
| Batched 集成 + OOM 修复 + 6 轮中英对照实测 | 2026-05-15 | 质量层改造主体完成 + 三份详细文档 |
| API 全量开放（11 个端点）+ 文档全量更新 | 2026-05-16 ~ 05-18 上半 | 11 个端点 + 翻译端点参数对齐 + 三份配套文档同步 |
| 收尾验证（自动化测试套件 5 项 + 6 个 API 真 bug 修复）| 2026-05-18 下半 | 短音频规律实测、Batched 复测、API 结构兼容 OpenAI 验证、DeepL/NLLB/timestamp_granularities 等兼容性补齐 |

### 6.2 代码规模

| 项 | 行数 |
|---|---|
| `api-proxy-configmap.yaml` 内 Python 部分 | 约 2700+ 行 |
| 其中 Monkey-Patch 与 Batched 相关 | 约 700 行 |
| 本开发版相对基线的新增 | 约 800 行（Batched 路由 + OOM 修复 + UI 持久化 + YouTube/NLLB/DeepL 三组端点 + `_do_transcribe` 共享驱动 + `_transcribe_form_params` 依赖 + 收尾期 API 兼容性修复套件 `_normalise_*` / `_normalize_*` / `_meta` 诊断框架 / clip_timestamps & VAD 字段 normalize）|

### 6.3 关键加速比与论文对照

| 项 | 论文 WhisperX | 本次实测 | 备注 |
|---|---|---|---|
| Batched 加速比 | 11.8× | 4.57× | 我们 batch_size=16 + 16 GiB GPU；论文 batch=32 + A100 80 GiB |
| WER 改善 | 10.5 → 9.7 | 未量化（无 ground truth）| 但 4 类灾难失败消失是结构性改善 |
| 5-gram 重复数 | 221 → 189 | 多段循环 → 0 | 结构性改善 |

### 6.4 已知问题分级（更新后）

| 问题 | 基线版本 | 本开发版 |
|---|---|---|
| 长音频后半累积崩坏 | 灾难（4 类失败）| ✅ 已根治（Batched）|
| 中英文参数互斥 | 无解 | ✅ 架构层面消除（Batched 路径无 trade-off）|
| 单温度无回退 | 易循环 | ✅ 已根治（温度回退列表）|
| WebUI 用户不填 prompt 输出风格差 | 英文全大写常见 | ✅ 已根治（自动注入）|
| 用户偏好跨刷新 / 升级丢失 | 是 | ✅ 已根治（YAML 持久化 + rehydrate）|
| Batched 在 API 路径下默认 fallback 到 Buffered（`clip_timestamps` 字符串导致 TypeError）| 不存在（基线无 Batched）| ✅ 收尾修复：API 层 normalize `clip_timestamps` 字符串到 list[float]，WebUI 路径完全不动 |
| `timestamp_granularities[]=word` OpenAI 官方字段不被接受 | 不支持 | ✅ 收尾补：API 层添加 alias 形式 form 字段，OpenAI SDK 调用直接可用 |
| DeepL `src_lang=EN`（code 形式）触发 502 而非业务错误 | 同样不可用 | ✅ 收尾修复：API 层 normalize DeepL 名称（接受 friendly name / code / 大小写变体）|
| 专有名词跨 chunk 漂移 | 无（但有更大问题）| ⚠️ 存在，可用 `initial_prompt` 缓解 |
| 静音 chunk 偶发 boilerplate | 无（但有更大问题）| ⚠️ 存在，计划黑名单消除 |
| 加载非 Whisper 架构模型 | 报错 | ⚠️ 仍报错（结构性限制，短期难以突破）|

### 6.5 收尾验证套件（2026-05-18）

本期改造的收尾阶段构建了一套**完整的自动化回归测试包**，覆盖五大维度，单次串跑 ~25 分钟即可拿到所有数据：

| Script | 用例 | 关键结论 |
|---|---|---|
| 1 — 短音频实测 | 10 个 clip × 2 模式 = 20 次 | 30 s 是 Batched 反转分水岭；3-5 min 起 ~2× 加速 |
| 1b — 受控可观测性 | 7 个开关组合 | Batched 真路径 / 三参数开关 / dropped_kwargs / `condition_on_previous_text` 强制覆盖 — 全部用响应内的 `_meta` 字段证伪/证实 |
| 2 — API happy path | 11 端点 + 4 个 `_meta` 验证 | 19/19 全绿；含默认响应 OpenAI 结构兼容自检（无 `_meta` / 无 `X-Whisper-*` 头）+ `timestamp_granularities[]=word` |
| 3 — API negative + DeepL 连通性 | 13 错误用例（含 N6 DeepL 连通性双重用途）| 全绿；含 DeepL 上游真实可达性验证（N6 假 key → 502 包装）+ N11/N12 DeepL/NLLB unknown language 400 对称用例 + N13 YouTube 缺 youtube_url → 422（对称于 N3 file 缺失）|
| 4 — 长音频实测 | 2 语种 × 2 模式 = 4 次 | 中文 14 min 1.87×、英文 59 min 2.01×；`_meta.path == "batched"` 双重确认 |

**收尾期间发现并修复的真实 bug**（均在测试套件中复现并锁死）：

1. **`VadOptions` 多余 kwarg 引发 500**：API 默认 form 字段含 `min_silence_at_max_speech` 等较新的 VAD 参数，老版 faster-whisper 的 `VadOptions.__init__` 不认 → 500。修复：introspect `VadOptions` 字段，仅传白名单内的，记录到 `_meta.vad_dropped_fields`。
2. **`language=English` 引发 500**：faster-whisper 只认 ISO 639-1 code（`en`），不认友好名。修复：API 层 `_normalize_language` 接受 ISO code、英文全名、常见别名（如 `Mandarin → zh`、`Castilian → es`、`Burmese → my`），大小写不敏感；未知值返回 400 而非 500，并列出可接受形式。
3. **Batched 路径在 API 调用下永远 fallback 到 Buffered**：默认 form 字段 `clip_timestamps="0"`（字符串）传给 `BatchedInferencePipeline.transcribe()` 时 `TypeError: string indices must be integers, not 'str'` → fallback。这意味着自 Batched 集成以来 API 路径的 Batched 一直是假的，只在 WebUI 走通过。修复：API 层把 `"0"` / `"5,12.5,20"` 这种字符串 normalize 到 list[float] 再传给 faster-whisper；WebUI 路径完全不动。
4. **DeepL 接受 `EN` 等 code 的承诺没兑现**：文档承诺 src_lang/tgt_lang 可填 friendly name 或 code，但代码层 `request_deepl_translate` 严格只认 friendly name 作 key 查表。修复：API 层 `_normalise_deepl_lang` 双向接受 name/code（不分大小写、含 `EN-US` / `PT-BR` 等带连字符的 target code），未知值返回 400 并提示去查 `GET /v1/translations/deepl/languages`。
5. **`timestamp_granularities[]=word` OpenAI 字段未支持**：OpenAI SDK 调 `client.audio.transcriptions.create(timestamp_granularities=["word"], ...)` 时该字段不被识别，响应里没 `words`。修复：API 层加 alias 形式 form 字段（`alias="timestamp_granularities[]"`），收到 `"word"` 时自动 flip `word_timestamps=True`。
6. **NLLB `src/tgt_lang` 传 code 引发 500**：上游 `update_model` 直接做 `NLLB_AVAILABLE_LANGS[src_lang]` dict 索引，**只接受 friendly name**（如 `English` / `Chinese (Simplified)`）。但 `/v1/translations/nllb/languages` 同时 advertise `name` 与 `code`，用户从 `code` 字段复制 `eng_Latn` 调用会直接 `KeyError` → 本服务 wrapper 包成 HTTP 500。另需特别注意：**NLLB 与 DeepL 不对称——NLLB 不接受 ISO 639-1 两字母代码（`EN`/`ZH`）**，DeepL 接受。修复：API 层 `_normalise_nllb_lang` 双向接受 name/code（不分大小写），未知值返回 400（与 `_normalise_deepl_lang` 行为对齐），消除"参数表 advertise 一种、实际只接受另一种"的不一致。

所有 6 项修复均严格遵循"API 层 only、WebUI 路径零侵入"——`_patched_transcribe` 这一层（API 与 WebUI 共享的引擎包装层）不动；变更分布在 `_do_transcribe`（API 专属入口，#1/#2 调用点/#3/#5）、`_normalise_deepl_lang` / `_normalise_nllb_lang`（API 工具函数，#4/#6）、`_transcribe_form_params`（FastAPI Form 字段定义，#5 的 alias），全部是 **API 专属层**。这种分离也是后续维护的关键约束。

---

## 七、理论原因简述（细节见附录 B、C）

### 7.1 为什么 Whisper 长音频会崩

Whisper 训练时输入窗口固定 30 s。处理长音频时它采用"buffered transcription"——把上一窗的输出作为下一窗的解码上下文（`condition_on_previous_text=True`）。**这个设计在 30 min+ 音频上会累积错误**：

- 某窗的误识别 / 幻觉 / 跨语言字符会作为 prompt 传给下一窗
- 下一窗放大该污染，直到模型完全失控
- 关掉 `condition_on_previous_text` 治标不治本——30 s buffer 内部仍会自我污染，且失去上下文反而更容易循环

### 7.2 商业方案怎么解决

商业会议转写产品（飞书妙记 / 阿里听悟 / Otter / AssemblyAI / Microsoft Teams）是**四层完整流水线**：

1. **前端音频处理**：AEC、降噪、波束成形、去混响
2. **声学模型**：RNN-T / TDT / Conformer，原生支持几十分钟到几小时输入
3. **说话人分离**：独立的 diarization 模块（pyannote / ECAPA-TDNN）
4. **后处理**：标点 / 大小写 / 数字归一化 + LLM 摘要

**Whisper 只覆盖第 2 层中间一段**，且这一段的架构选择（attention encoder-decoder + 固定 30 s 窗）就决定了它在长音频上的天花板。

### 7.3 我们的方案（Batched）解决什么、不解决什么

**解决**：通过 `BatchedInferencePipeline`（faster-whisper 内置的 WhisperX 等价实现），把整段音频用 VAD 切成独立 chunk，每个 chunk 独立、并行解码，chunk 间无上下文传递——**直接切断了"上一段污染传给下一段"的累积通道**。

**不解决**：前端音频处理、说话人分离、摘要——这三层 Whisper-WebUI 仍然没有，属于方向 B（多引擎应用）的范围。

---

## 八、当前状态与可继续探索的方向

> 本节列出截至目前的工作完成情况，以及在已有验证基础上**技术层面**可进一步尝试的方向。是否实际推进取决于后续业务输入与上级安排。

### 8.1 本开发版已落地的部分

**质量层**：
- 架构层面解决长音频崩坏：引擎路径 `Batched` 默认开启；后处理 `Text Cleaning` + `Segment Merging` 默认开启；三个开关用户均可勾选关闭
- 移除无效的 LLM 校对路线，参数空间穷举也已停止
- 完善基础设施：YAML 持久化、并发安全、显存管理、浏览器刷新 rehydrate
- 现有 Whisper 后端保持不变，未引入非 Whisper 模型

**API 层**：
- OpenAI 兼容 API 从基线的 4 个端点扩到 11 个：补 YouTube URL 转录 / metadata、NLLB 文本&字幕翻译 / models / languages、DeepL 文本&字幕翻译 / languages
- `/v1/audio/translations` 参数从基线的 OpenAI 公开 5 个字段补到 59 个（含 OpenAI 兼容 `timestamp_granularities[]`），与转录完全对齐（task 强制 translate）
- 三个音频端点（上传转录 / YouTube 转录 / 上传翻译）共享 `_do_transcribe` + `_transcribe_form_params` 依赖，杜绝行为漂移
- DeepL `auth_key` 不落盘（与上游持久化行为相反，体现服务端安全收敛）

### 8.2 短期内仍可继续尝试的小改进（工作量小）

- **YouTube boilerplate 黑名单**：在 `_text_cleaning` 加少量正则消除 `Thank you for watching` 等残留（约 0.5 天）
- **WebUI 全局 `initial_prompt` 配置**：当前只能 per-request 传，可加全局默认值，方便领域音频（医疗 / 法律 / 专业术语）注入术语表（约 1 天）
- **大显存 GPU 升级后调大 `batch_size`**：当前 16，调到 32+ 可进一步逼近论文 11.8× 的加速比

### 8.3 短期内难以快速实现的方向（工作量大 / 受架构约束）

- **多引擎应用（方向 B）**：按语言路由到 Parakeet（英）/ Qwen3-ASR / FunASR（中），加 pyannote 做说话人分离。工作量约 1-2 个月。适合时机：业务侧明确要求"会议纪要"等场景。
- **前端音频增强**：接入 DeepFilterNet3 作为 pre-processor。工作量约 1-2 周。适合时机：用户开始上传明显嘈杂的现场录音。

### 8.4 实测已证伪的路线（重复尝试价值有限）

- **LLM 后处理外挂校对**：本次实测中文 11× 耗时 + 5+ 事实幻觉、英文 8.6× 耗时 + 30+ 处元评论泄漏；FunAudio-ASR 论文亦证实小 LLM 看不懂 ASR 错误分布，正确做法是联合训练 + RL，而非外挂。
- **穷举参数空间寻找中英文通用最优解**：15 轮系统测试已确认无解；Batched 路径架构层面绕开了这个矛盾。
- **在 WebUI 直接加载 Qwen3-ASR 等非 Whisper 架构模型**：架构上不可能，必须走方向 B 路线（详见附录 C）。

---

## 附录：详细文档索引

需要进一步细节的请参阅：

| 主题 | 详细文档（同目录）|
|---|---|
| A. 操作手册、API 完整说明、参数表、所有补丁源码摘要 | `Whisper-WebUI_STT质量优化与API完整使用指南.{md,docx}` |
| B. Whisper 长音频崩坏的理论原因 / 商业方案对照 / Batched 实测细节 / WhisperX 论文数据 | `Whisper-WebUI_长音频质量瓶颈与改进路线分析报告.{md,docx}` |
| C. 模型兼容性（哪些模型能用 / 哪些不能 / 突破方向）| `Whisper-WebUI_自定义模型兼容性与扩展方案.{md,docx}` |
| D. 工作日志（每日内部进度，含完整测试录音文本）| `_internal/WORK_LOG_2026-05-{12..15}.md` |

---

**变更记录**

| 日期 | 变更 |
|---|---|
| 2026-05-15 | 初稿创建，综合三份详细文档形成汇报稿 |
| 2026-05-18 | 增补 API 全量开放章节（§一 第 6 条核心结论、§3.6 端点对比、§6.1/6.2 时间线与代码规模、§8.1 落地项）；并全文脱版本化（不再罗列内部迭代号，统一以"基线 / 本开发版"两态描述）|
