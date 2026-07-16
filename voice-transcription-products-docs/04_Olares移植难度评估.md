# Olares 移植难度评估

> 以 `whisperwebuiv2` 已上架为参考基线，对样本盘点中所有"理论可移植到 Olares"的项目做横向难度评估。**最终得出 5 个推荐移植目标和 3 个明确不推荐的目标**。

---

## 一、8 维度评估打分表

> 每个维度 1-5 分，**分数越高 = 移植越容易**。综合分 = 8 维度平均。

| 维度 | 1 分 | 3 分 | 5 分 |
|---|---|---|---|
| **1. headless server** | 紧耦合 GUI，无服务端模式 | 可改造分离 | 已有官方 headless |
| **2. 容器化成熟度** | 无任何容器；自己写 Dockerfile | 社区 Dockerfile 可用 | 官方 Docker image + Helm |
| **3. GPU 依赖** | 必须 GPU；CPU 不可用 | GPU 可选；CPU 慢但能跑 | CPU 完全够用 |
| **4. 持久化需求** | 复杂多表 DB + 状态 | DB + 文件存储 | 仅模型缓存 |
| **5. 对象存储** | 必须 S3 兼容 | 大文件需 hostPath PVC | 流式不存大文件 |
| **6. 长任务调度** | 必须 K8s Job + 队列 | 自带 Celery/RQ | 同步阻塞即可 |
| **7. OpenAI 兼容** | 自家私有协议 | 部分兼容 | 完全兼容 `/v1/audio/transcriptions` |
| **8. 与 Olares 既有应用复用** | 必须重新装一整套 | 可部分复用 | 完全复用 `whisperwebuiv2` / `speaches` / `ollamav2` |

---

## 二、`whisperwebuiv2` 基线（参考点）

> 这个分数是"基准 4.0"，所有其它候选与之对比。

| 维度 | 得分 | 说明 |
|---|---|---|
| 1 headless server | 4 | 上游 `jhj0517/Whisper-WebUI` 有 `/backend` REST API，但默认是 Gradio GUI |
| 2 容器化 | 5 | Olares 团队已封装 Helm chart（subChart `whisperwebuiv2server` + `whisperwebuiv2`） |
| 3 GPU 依赖 | 3 | 可 CPU 跑但实际不可用；admin 模式要 8 GiB GPU |
| 4 持久化 | 4 | 仅模型缓存 + 转录历史；hostPath PVC 即可 |
| 5 对象存储 | 5 | hostPath 内即可，不需 S3 |
| 6 长任务 | 3 | Gradio 内部队列；长任务超时是已知风险 |
| 7 OpenAI 兼容 | 2 | 不是 OpenAI 兼容；自家 Gradio API |
| 8 既有应用复用 | 5 | 自身就是基线 |
| **综合** | **3.875** | **基准** |

---

## 三、候选项目逐一打分（按"综合分"降序）

### 3.1 极易移植（综合 ≥ 4.0）

#### `speaches`（已上架，参考）
- **综合：4.875**（OpenAI 兼容 + GPU 可选 + 单容器 + 模型缓存）
- 已上 Olares Market，本项为对比参考。

#### `ahmetoner/whisper-asr-webservice`
- **综合：4.5**
- 1=5（官方 headless）｜2=5（官方 Docker image）｜3=4（GPU 可选）｜4=5（仅模型缓存）｜5=5（流式不存）｜6=3（同步为主，长任务有风险）｜7=4（asr 接口语义接近 OpenAI）｜8=5
- **推荐**：可作为 `speaches` 的"重型替代品"——`speaches` 是 small 模型默认，这个可跑 large-v3。

#### `QuentinFuxa/WhisperLiveKit`
- **综合：4.25**
- 1=5｜2=5｜3=4｜4=5｜5=5｜6=3｜7=5（`/v1/audio/transcriptions` 完全兼容）｜8=4
- **推荐**：含流式 WebSocket，可补 `speaches` 不做流式的短板。

#### `pavelzbornik/whisperX-FastAPI`
- **综合：4.125**
- 1=5｜2=4｜3=2（GPU 强需求）｜4=4｜5=4｜6=4（异步任务）｜7=4｜8=5
- **推荐**：把 `whisperwebuiv2` 内的 WhisperX 提取成独立 endpoint，供任意客户端用。

#### `pluja/whishper` (v3 / v4)
- **综合：4.0**
- 1=4｜2=5（官方 Docker Compose）｜3=3｜4=3（Mongo/MariaDB）｜5=3｜6=5（分布式 worker）｜7=2（自家 API）｜8=4
- **推荐 v4**：作为 `whisperwebuiv2` 之外的"重型"替代——更适合"多用户 + 大量长音频 + 字幕编辑"场景。

### 3.2 中等难度（综合 3.0-4.0）

#### `Nyralei/whisperx-api-server`
- **综合：3.75**
- 1=5｜2=4｜3=2｜4=3（Kafka）｜5=5（S3 集成）｜6=5（最重的分布式调度）｜7=3｜8=3
- **推荐**：长任务 + 对象存储路径的最优样本，但要先在 Olares 上跑通 Kafka 和 MinIO 之类 S3。

#### `pyannote/pyannote-audio` (作为独立服务)
- **综合：3.5**
- 1=3（需要写 server wrapper）｜2=3（社区 Docker）｜3=2｜4=5｜5=5｜6=3｜7=2｜8=4
- **推荐**：把"说话人分离"做成 Olares 独立 endpoint，供其它应用调用。

#### `MahmoudAshraf97/whisper-diarization`
- **综合：3.5**
- 与 pyannote-audio 类似但整合度更高（Whisper + NeMo）。

#### `Buzz` server 模式
- **综合：3.25**
- Buzz 主要是桌面 App，没有官方 server 模式；移植意义不大。

#### `tmoroney/auto-subs` server 化
- **综合：3.0**
- 主要是 DaVinci 插件，server 化路径不顺。

#### **OmniVoice Studio** server 模式
- **综合：3.75**
- 1=4（Tauri 桌面 + FastAPI 后端可拆）｜2=3（社区 Docker 雏形）｜3=3｜4=3（SQLite + 多模态）｜5=3｜6=4｜7=4（含 MCP Server）｜8=4
- **推荐评估**：如果其后端 FastAPI 部分能干净拆出来，可以做成"高级转录 + 配音 + 字幕"一体的 Olares 应用。但当前社区项目较新（2026-05），稳定性待验证。

### 3.3 不建议移植（综合 < 3.0 或定位冲突）

#### Otter / Fireflies / Read.ai / Granola / Fathom 等会议机器人
- **综合：1.5**
- 1=1（私有 SaaS，没 server 模式）｜2=1｜其它无关
- **结论**：纯 SaaS，不开源；无任何移植路径。
- **替代方案**：自托管开源会议机器人项目极少（Vexa.ai、CallAI 是个例外但生态早期）；本课题暂不建议在 Olares 上做"会议机器人"。

#### MacWhisper / Vibe / Buzz 桌面 App 类
- **综合：—**（不应移植）
- **结论**：流派 A 的桌面 App 本质上"不该上 Olares"。**正确做法**：让这些桌面 App 改接 Olares `speaches` 作为后端。

#### OpusClip / Submagic / Vidyo 等视频创作者
- **综合：—**（云端 SaaS，不开源）
- **结论**：闭源 + 重云端视频处理；任何"开源替代品"工程量巨大。

#### Nuance DAX / Suki / Abridge 等医疗
- **综合：1.0**
- 闭源 SaaS + 行业合规壁垒（HIPAA、FDA）；移植无意义。
- **替代方案**：Olares 上做"医疗转录"应专门构建（如基于 SenseVoice + Qwen3 + 医疗术语词典），而非移植现有产品。

#### Verbit / Rev 法律类
- **综合：1.0**
- 同上。

---

## 四、综合排序（仅含可移植项）

| 排名 | 项目 | 综合 | 状态 | 一句话 |
|---|---|---|---|---|
| 1 | `speaches` | 4.875 | **已上架** | OpenAI 兼容 STT/TTS |
| 2 | `whisper-asr-webservice` | 4.5 | 候选 | `speaches` 重型替代品 |
| 3 | `WhisperLiveKit` | 4.25 | 候选 | 补 `speaches` 不做流式的短板 |
| 4 | `whisperX-FastAPI` | 4.125 | 候选 | WhisperX 独立 endpoint |
| 5 | `whisperwebuiv2`（基线） | 3.875 | **已上架** | 通用文件转录 GUI |
| 6 | `whishper` (v4) | 4.0 | 候选 | 重型替代品（字幕编辑 + 分布式） |
| 7 | `whisperx-api-server` | 3.75 | 候选 | 长任务 + 对象存储样本 |
| 8 | OmniVoice Studio | 3.75 | 候选（早期） | 转录 + 配音 + 字幕一体 |
| 9 | `pyannote-audio` 独立服务 | 3.5 | 候选 | 独立 diarization endpoint |
| 10 | `whisper-diarization` | 3.5 | 候选 | 同上 |

---

## 五、与"语音输入法"课题的移植难度差异

| 维度 | 语音输入法（前课题） | 语音转录（本课题） |
|---|---|---|
| **集群侧自研难度** | 中（speaches 已覆盖 70%） | **低**（whisperwebuiv2 已覆盖 70% + speaches 覆盖 API） |
| **客户端难度** | **高**（每个 OS 一套，IME / 文本注入 / 全局热键） | 低（浏览器即可访问） |
| **网络模型** | 用户机器 → Olares（家用网络穿透） | 用户机器 → Olares（同上，且不要求超低延迟） |
| **音频上传带宽** | 短音频，几百 KB | **长音频，可达几百 MB / 几 GB** |
| **GPU 内存峰值** | 4-6 GiB（small/base） | **8-24 GiB**（large + diarization + 翻译 + LLM 并发） |
| **任务时长** | < 5 秒 | **可达 1-3 小时**（HTTP 长连接 / 任务队列） |
| **持久化** | 几乎无 | **核心需求**（转录历史 + 字幕版本 + 用户标注） |
| **多用户隔离** | 每用户独立实例（输入法本身私有） | **服务端共享 + 用户数据隔离**（更接近传统 SaaS） |

**关键结论**：
- 本课题在"客户端复杂度"上比语音输入法**低**（浏览器即可）；
- 但在"集群侧资源占用、长任务调度、对象存储、持久化"上**显著高**；
- "上传带宽 + GPU 内存峰值"是 Olares 集群规格的硬约束——大多数家用 Olares 集群没有 16+ GiB GPU，**会议机器人 + 长视频转录 + 高并发**这三件事在家用 Olares 上几乎跑不动。

---

## 六、Olares 集群侧的硬约束清单

### 6.1 GPU 内存

- `whisperwebuiv2` admin 模式：8 GiB（仅 large-v3 + pyannote）
- 加上字幕翻译（NLLB）：12 GiB
- 加上同时跑 LLM 摘要（Qwen3-14B）：22 GiB
- **结论**：要做"转录 + 摘要 + 翻译"全栈一体，**建议 RTX 4090（24 GiB）或同等**；家用 Olares 上**建议分流到不同请求时段**。

### 6.2 上传带宽

- 1 小时 WAV（16 kHz mono）：~115 MB
- 1 小时 MP3（128 kbps）：~58 MB
- 1 小时 MP4（720 p）：~600 MB-1 GB
- **结论**：上传 MP4 大视频是带宽瓶颈；**优先支持"音轨提取后上传"**（前端用 FFmpeg.wasm 提取音轨）。

### 6.3 长任务 HTTP 超时

- Nginx Ingress 默认 60 s 超时
- Olares 通常 3-5 分钟 timeout
- **必须**走"异步任务 + polling / SSE / WebSocket"模式

### 6.4 存储

- 上传文件：1-2 GB / 文件（音视频）
- 转录中间结果：JSON + SRT，几 KB
- 模型缓存：5-10 GB（Whisper large-v3 + pyannote + NLLB + Whisper distil）
- **结论**：hostPath PVC ≥ 50 GiB；如要持久保存原始视频，加对象存储应用（如 MinIO）。

### 6.5 推理并发

- Whisper large-v3 占用 GPU 时长 = 音频时长 / 模型速度（×60 = 1 min/h）
- 多用户并发会撞 GPU 队列
- **必须**做"任务队列 + 优先级 + 限流"

---

## 七、本章结论

1. **移植难度上，本课题比"语音输入法"集群侧更容易（自托管 WebUI 路径成熟），客户端侧也更简单（浏览器即可）**。
2. **但资源占用显著更高**：GPU 内存峰值、长任务调度、对象存储、上传带宽——这四件事是 Olares 集群规格的硬约束。
3. **`whisperwebuiv2` 已覆盖 70% 的"通用文件转录"需求**——新增价值必须在它之外。
4. **5 个最值得候选移植的服务端引擎**：`speaches`（已上）、`whisperwebuiv2`（已上）、`WhisperLiveKit`、`whisperX-FastAPI`、`whishper-v4`/`Anysub`（任选其一作为重型替代）。
5. **3 个明确不推荐**：会议机器人（SaaS 不开源 + 公网账号门槛）、桌面 App 类（不该上服务端）、行业垂直 SaaS（医疗/法律）（闭源 + 合规壁垒）。
