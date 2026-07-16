# Whisper STT 优化工作日志 & 英文测试待办

> 创建日期：2026-05-11
> 状态：等待英文实测完成后统一更新

---

## 一、2026-05-11 工作记录

### 今天做了什么

#### 1. STT 质量参数调优（API + WebUI）

在 `whisperwebuiv2server/templates/api-proxy-configmap.yaml` 中实现了一套质量优化参数：

- `condition_on_previous_text=False`：切断段间错误传播，防止幻觉循环
- `hallucination_silence_threshold=2`：2 秒静音即跳过，拦截单 segment 幻觉
- VAD 启用 + 参数调优：`vad_filter=True`、`min_silence_duration_ms=500`、`min_speech_duration_ms=250`
- API 层自动语言检测（置信度 ≥ 0.8）+ 按语言自动注入 `initial_prompt`
- 启动时自动 patch WebUI 的 `default_parameters.yaml`，使 WebUI 和 API 共享同一套质量参数

#### 2. API 全参数暴露

将 faster-whisper 几乎所有可调参数（55 个）暴露到 `/v1/audio/transcriptions` 端点：
- 解码策略、质量阈值、VAD、时间戳、语言检测、Token 控制等全部开放
- 新增 `hotwords` 参数
- 新增 BGM 分离（UVR-MDX-NET）和说话人分离（pyannote）集成
- 新增 `/v1/audio/translations` 翻译端点
- 新增 `lrc` 输出格式
- 修复了 `prepend_punctuations`/`append_punctuations` 中非 ASCII 字符导致的 `SyntaxError`（改为运行时 `chr()` 构造）

#### 3. 中文标点与 hotwords 深度调试

花了大量时间排查"中文标点消失"问题，最终定位到 hotwords 机制：

**关键发现链**：
1. 最初怀疑 `condition_on_previous_text=False` 导致标点消失 → **排除**（改回 True 无效）
2. 怀疑 `prepend_punctuations`/`append_punctuations` 被改坏 → **排除**（用户粘贴 WebUI 实际值，与上游一致）
3. 用户发现：**关掉 hotwords 后标点恢复** → 确认 hotwords 是罪魁祸首
4. 测试了多种 hotwords 格式：
   - 空格分隔 → 标点完全消失
   - 中文逗号分隔 + 末尾句号 → 句号恢复为中文"。"，但逗号仍为 ASCII ","
   - 末尾追加"？"等额外标点 → 输出严重恶化（异常 Unicode 字符、碎片化）
5. hotwords 词数过多（23 个）→ 约 30% 原文内容丢失

**根因分析**：faster-whisper 将 hotwords 编码为 token 序列放入每个 segment 的解码 prompt（`sot_prev` 之后）。模型会模仿 hotwords 的文本风格（包括标点风格）来生成输出。无标点的词列表 → 无标点的输出。

#### 4. 文档编写

- 编写了完整的 `Whisper-WebUI_STT质量优化与API完整使用指南.md`（~590 行）
- 编写了 `generate_docx.py` 生成对应 DOCX 版本
- 文档涵盖：自动生效优化（含原理）、用户操作优化、hotwords 详细用法与陷阱、中文标点行为、API 全参数表、测试用例集、已知问题与优化限制

### 得到的关键经验

#### 经验 1：hotwords 不是"词级加权"，是"上下文注入"
faster-whisper 的 hotwords 实现和直觉完全不同。它不是给特定词加权，而是把 hotwords 字符串当作前文上下文放入 prompt。这导致模型会"学习" hotwords 的格式风格（有无标点、分隔方式等）。

#### 经验 2：hotwords 中文最佳格式唯一解
只有 `关键词A，关键词B，关键词C。`（中文逗号分隔 + 末尾中文句号）这一种格式能保留句号。逗号和问号仍然是 ASCII，无法通过 hotwords 解决。

#### 经验 3：hotwords 有严格词数限制
不超过 10 个词。23 个词实测丢失 30% 内容。

#### 经验 4：hotwords 是双刃剑
能修复"小星老师→小青老师"、"巨峰→飓风"等错误，但可能把"聚变"搞成"巨变"，且会消除引号。不是万能药。

#### 经验 5：condition_on_previous_text=False 不影响标点
这是实测确认的。之前的错误怀疑浪费了排查时间。

#### 经验 6：Whisper 中文标点是混合风格
模型固有行为：句号=中文"。"、顿号=中文"、"、引号=中文""，但逗号/问号/感叹号/冒号都是 ASCII。`initial_prompt` 无法改变这个行为。

#### 经验 7：性别代词无解
"她/他"错误是声学信号无法区分的问题，hotwords 对代词无效。

#### 经验 8：同音字替换是中文 STT 的核心瓶颈
几乎所有错误都是完美同音替换（峰/风、刹/杀、聚/巨、极/急），声学层正确但语言模型选词错误，调参完全无法解决。只能靠后处理 LLM 纠错或换模型。

#### 经验 9：Python 文件中的非 ASCII 字符要小心
`Form()` 默认值中直接写 `¿` 等字符在某些编码环境下会导致 SyntaxError。改为 `None` + 运行时 `chr()` 构造最安全。

### 测试素材

- **中文**：《流浪地球》于和伟演播版有声书（第一部分，约 45 秒片段）
- **中文**：鲁迅《朝花夕拾》LibriVox 朗读（archive.org）
- **英文**：尚未测试

### 产出文件

| 文件 | 说明 |
|------|------|
| `whisperwebuiv2server/templates/api-proxy-configmap.yaml` | 核心代码修改（API + WebUI patch） |
| `whisperwebuiv2-docs/Whisper-WebUI_STT质量优化与API完整使用指南.md` | 完整教程 Markdown 版 |
| `whisperwebuiv2-docs/generate_docx.py` | DOCX 生成脚本 |
| `whisperwebuiv2-docs/Whisper-WebUI_STT质量优化与API完整使用指南.docx` | 完整教程 DOCX 版 |
| `whisperwebuiv2-docs/TODO_英文测试后更新.md` | 本文件 |

---

## 二、英文测试后待更新事项

### 背景

截至 2026-05-11，文档中的所有结论均基于**中文实测**。英文场景尚未系统测试。

## 英文测试完成后需要更新的内容

### 1. hotwords 对英文标点的影响
- 中文结论：hotwords（空格分隔）会完全消除中文标点
- 待验证：英文 hotwords 是否也会抑制英文标点（句号、逗号、问号等）？
- 如果影响不同，需要在 1.2.3 节分别描述中英文的 hotwords 最佳格式

### 2. hotwords 英文最佳格式
- 中文最佳格式：中文逗号分隔 + 末尾句号（`关键词A，关键词B。`）
- 待验证：英文 hotwords 用什么格式最好？空格？逗号？末尾要不要加句号？

### 3. condition_on_previous_text 对英文的影响
- 中文结论：False 不影响标点，且有效防幻觉
- 待验证：英文场景下 False 是否也是最优选择？对英文连贯性影响如何？

### 4. hallucination_silence_threshold = 2 对英文的效果
- 中文结论：2 秒是最佳平衡点
- 待验证：英文场景下 2 秒是否合适？英文语速通常更快，是否需要调整？

### 5. 英文 STT 已知问题
- 待收集：英文场景下有哪些常见错误模式？
- 专有名词识别质量如何？
- 长音频幻觉情况如何？

### 6. 英文标点默认行为
- 待验证：英文标点是否正常（句号、逗号、问号、引号等）？
- 是否有类似中文"标点不全角"的问题？

## 需要更新的文件

1. `Whisper-WebUI_STT质量优化与API完整使用指南.md` — 移除/修改所有"英文尚未测试"的标注，补充英文结论
2. `generate_docx.py` — 同步更新 DOCX 生成脚本
3. 重新生成 `Whisper-WebUI_STT质量优化与API完整使用指南.docx`

## 建议的英文测试素材

- TED Talks（标准演讲）
- LibriSpeech test-clean（基准测试集）
- Lex Fridman Podcast（长对话）
- LibriVox: The Great Gatsby（文学朗读）
