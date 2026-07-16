# 语音转录产品综合调研 · 一页纸结论与阅读导览

> 这是与"语音输入法产品综合调研"并行的旁路课题。两条课题的边界在 [00 立项](./00_课题立项与样本初稿.md) 第一节明示，本文只看本课题的结论。

---

## 一、一句话结论

> **Olares 在"语音转录"赛道上不必从零起步**——`whisperwebuiv2` 已经覆盖了通用文件转录 GUI 的 70% 需求，`speaches` 已经覆盖了 OpenAI 兼容 STT endpoint。**新增价值应该锁定在两个方向**：（1）给集群侧补几个 headless 引擎，让长音频 + 高精度 + 流式都能用；（2）**自研一个"AI 语音笔记本"应用**，这是 Olares "个人云" 定位最契合的形态。**会议机器人 / 闭源 SaaS 移植 / 行业垂直 SaaS 都不该做**。

---

## 二、市场全景一览

调研覆盖 **120+ 个端到端产品 + 20 个服务端引擎**，按 9 大类组织：

| 类别 | 代表（节选） | Olares 移植契合度 |
|---|---|---|
| 桌面端开源 App | **Vibe（5.8k★）、Buzz（19k★）**、MacWhisper、Petal、OmniVoice | ★（不该移植，应改接 Olares 后端） |
| 商业 Web SaaS | Otter、Fireflies、Rev、Sonix、Notta、TurboScribe、Trint、Sonix | ★（闭源） |
| 会议机器人 | Read.ai、Granola、Fathom、tl;dv、Jamie、Spinach、Gong、Chorus | ★（强烈不建议） |
| 视频字幕 / 创作者 | OpusClip、Submagic、CapCut、Captions、Riverside、Descript | ★★★（轻量字幕 OK） |
| AI 笔记本 / 长音频整理 | NotebookLM、AudioPen、Voicenotes、AudioNotes、Cleft、Plaud Note | **★★★★★（旗舰方向）** |
| 国内大厂转录 | 通义听悟、飞书妙记、腾讯会议 AI、讯飞听见 | ★（闭源 SaaS） |
| 医疗垂直 | Nuance DAX、Suki、Nabla、Abridge、DeepScribe | ★（闭源 + 合规） |
| 法律垂直 | Verbit、Rev、Beey、Speechmatics、Voci | ★（同上） |
| 自托管服务端引擎 | whisperX、Whishper、Whisper-WebUI、speaches、WhisperLiveKit | **★★★★★（直接候选）** |

---

## 三、6 大架构流派 → 对照 Olares 应只在 3 个上发力

| 流派 | 代表 | Olares 应否投入 |
|---|---|---|
| A 单进程桌面 App | Vibe、Buzz、MacWhisper | ❌（让桌面端改接 `speaches`） |
| **B 自托管 Web 全栈** | Whisper-WebUI、Whishper、Anysub | ✅（已有 `whisperwebuiv2`，可扩展） |
| **C OpenAI 兼容 API** | speaches、whisper-asr-webservice、WhisperLiveKit、whisperX-FastAPI | ✅（已有 `speaches`，可扩展） |
| D 会议机器人云 | Otter、Fireflies、Read.ai、Granola | ❌（公网账号门槛 + SaaS 闭源） |
| E 视频创作者重型 | OpusClip、Submagic、Captions | △（只做轻量字幕导出） |
| **F AI 笔记本** | NotebookLM、AudioPen、Voicenotes、Plaud Note | ✅（**最值得自研**） |

---

## 四、5 条候选移植路径

| 路径 | 内容 | 优先级 | 工作量 |
|---|---|---|---|
| **甲** 扩展 `whisperwebuiv2` | 补 AI 摘要、字幕编辑器、任务队列 | ★★★★★ | 0.5-1.5 人月 |
| **乙** 上架 `whisperX-FastAPI` | 高精度长音频 + diarization endpoint | ★★★★ | 0.5-1 人月 |
| **丙** 上架 `WhisperLiveKit` | 流式 WebSocket endpoint（补 `speaches` 短板）| ★★★ | 0.3-0.8 人月 |
| **丁** 自研"AI 语音笔记本" | 复用 `speaches` + `ollamav2` 做端到端笔记本 | ★★★★★ **旗舰** | 2-4 人月 |
| **戊** 上架 `Anysub`（whishper v4）| 路径甲的重型替代（多用户 + 字幕编辑器 + 分布式） | ★★★ | 1-2 人月 |

详细设计见 [05 候选移植路径设计](./05_候选移植路径设计.md)。

---

## 五、三阶段推荐路线

```
[第一阶段：补全集群侧底座] 1-2 个月
    ├── 上架 whisperX-FastAPI（路径乙）
    ├── （可选）上架 WhisperLiveKit（路径丙）
    └── 给 whisperwebuiv2 补 AI 摘要 + 字幕编辑器（路径甲最小集）

[第二阶段：自研旗舰应用] 2-3 个月
    ├── "AI 语音笔记本" MVP（路径丁第一阶段）
    └── 增强：RAG + 标签 + 导出（路径丁第二阶段）

[第三阶段：移动端 + 升级] 1-2 个月
    ├── AI 语音笔记本 PWA / LarePass 内嵌
    └── （可选）评估 Anysub 是否替代 whisperwebuiv2（路径戊）
```

**总计 4-7 人月**。

---

## 六、为什么本课题比"语音输入法"轻得多

| 维度 | 语音输入法（已交付）| 语音转录（本课题）|
|---|---|---|
| 客户端复杂度 | **高**（每个 OS 一套 IME / 文本注入 / 全局热键）| **低**（浏览器即可）|
| 集群侧覆盖度 | speaches 覆盖 ~50% | **whisperwebuiv2 + speaches 覆盖 ~80%** |
| 资源占用 | 中（small/base 模型，4-6 GiB GPU）| **高**（large 模型 + diarization + 翻译 + LLM，8-24 GiB）|
| 实时性要求 | **极高**（< 500 ms）| 低（异步可接受）|
| 推荐工作量 | 旗舰约 4-6 人月 | **旗舰约 2-4 人月** |

**简言之**：客户端工作大幅减少，集群侧增量小，但单次任务资源占用增大——属于"短期可见进展"赛道。

---

## 七、关键事实速查

- **`whisperwebuiv2` 当前 v1.0.19**，cluster-scoped，sharedEntrance `sharedentrances-whisperwebui`，admin 模式 8 GiB GPU + 6.5 GiB 内存；后端 = faster-whisper（默认） / openai-whisper / insanely-fast-whisper + pyannote + UVR + NLLB + DeepL
- **`speaches` 当前 v1.0.12**，cluster-scoped，sharedEntrance `sharedentrances-speaches`，OpenAI 兼容 STT + Kokoro TTS
- **`ollamav2` 当前 v1.0.18**，cluster-scoped，OpenAI 兼容 LLM，可直接做摘要后处理
- **WhisperX 70× 实时**（RTX 4090 large-v3-turbo）+ pyannote 3.1 **DER ~12-15%**（事实 SOTA）
- **本地化中文首选 ASR**: SenseVoice-Small（Apache-2, 234 M，含情感标签），Paraformer-Large
- **本地化中文首选 LLM 摘要**: Qwen3-14B（OK 内存）或 Qwen3-32B（高端 GPU）

---

## 八、风险摘要

- **GPU 内存峰值** ＝ Whisper-large + pyannote + 翻译 + LLM 摘要可超 22 GiB；家用集群难承受全栈并发
- **长任务 HTTP 超时**：Olares Nginx 3-5 min 超时；1 h 音频必须走异步
- **上传带宽**：1 h MP4 ~1 GB，移动端体验差；客户端先抽音轨
- **pyannote token + NLLB CC-BY-NC**：合规需文档化
- **与现有 `whisperwebuiv2` 边界不清**：自研笔记本必须明确定位"持续个人笔记 + 搜索"，而非"再写一个转录 GUI"

完整 30+ 条风险见 [06 风险与开放问题](./06_风险与开放问题.md)。

---

## 九、文件索引

| 文件 | 主题 |
|---|---|
| [`README.md`](./README.md) | 本文，一页纸结论 + 导览 |
| [`00_课题立项与样本初稿.md`](./00_课题立项与样本初稿.md) | 课题边界、与"语音输入法"关系、研究方法 |
| [`01_市场全景与样本盘点.md`](./01_市场全景与样本盘点.md) | 120+ 端到端产品 + 20+ 服务端引擎完整盘点 |
| [`02_技术架构对比.md`](./02_技术架构对比.md) | 6 大架构流派 + 横向技术矩阵 |
| [`03_大模型与引擎对比.md`](./03_大模型与引擎对比.md) | ASR 主干 + diarization + 翻译 + LLM 后处理 + 四套模型预设 |
| [`04_Olares移植难度评估.md`](./04_Olares移植难度评估.md) | 8 维度打分 + 5 个推荐 + 3 个不推荐 |
| [`05_候选移植路径设计.md`](./05_候选移植路径设计.md) | 5 条路径 + 三阶段推荐路线 + 工作量估算 |
| [`06_风险与开放问题.md`](./06_风险与开放问题.md) | 30+ 风险（技术 / 产品 / 合规 / 运营 / UX）+ 10 个开放决策 |

每个 `.md` 都有对应 `.docx`（用 `generate_doc.py` 生成）。

---

## 十、按角色的阅读路径

- **产品 / 决策者**：本 README → §07 关键事实速查 → §08 风险摘要 → 完
- **架构师 / 技术决策者**：本 README → [02](./02_技术架构对比.md) → [04](./04_Olares移植难度评估.md) → [05](./05_候选移植路径设计.md)
- **开发负责人**：本 README → [05](./05_候选移植路径设计.md) → [03](./03_大模型与引擎对比.md) → [06](./06_风险与开放问题.md)
- **市场 / 产品调研**：本 README → [01](./01_市场全景与样本盘点.md) → [02](./02_技术架构对比.md)
- **追溯研究方法**：[00](./00_课题立项与样本初稿.md)
