# Olares 语音输入产品综合报告

> **一句话**：要让 Olares / LarePass 用户用上"按一下键就把声音变成文字"的能力，**五条候选方案**都可走、可组合；强推"**集群侧统一语音后端 + 桌面客户端 LarePass 感知 + Android 后台服务**"三件套，约 **8–10 人月**可上线第一波。

---

## 一、五条候选方案一览

> 命名是 **方案一 ~ 方案五**，本文之后一律使用此命名。

| 方案 | 一句话定位 | 用户视角效果 | 工程投入 | 受益用户面 |
|---|---|---|---|---|
| **方案一：系统输入法兼容** | 不开发任何东西，整理一份"哪个输入法装上语音键能在 LarePass 输入框里直接用"的官方推荐清单 + 设置教程 | 用户自己选 IME，体感取决于第三方 | **零** | 全平台移动端通吃，~95% |
| **方案二：自研完整移动输入法** | 发布"Olares 输入法 APK"，自带键盘 UI、本地引擎和远端可选后端 | 用户切到 Olares 自家键盘，全程一致 | **高（6–8 人月）** | 安卓中文用户为主 ~35% |
| **方案三：自研移动语音后台服务** | 发布"Olares 语音引擎 APK"，不带键盘 UI；用户保留原有 IME，把麦克风键调到本服务 | 用户不换 IME，但点麦克风时由 Olares 接管 | **中（3–5 人月）** | 安卓所有支持第三方语音的 IME 用户 ~70% |
| **方案四：集群侧统一语音后端** | 在 Olares 集群里跑一个 OpenAI 兼容 STT/TTS/LLM endpoint，所有上层客户端复用 | 用户无感，桌面 / 移动客户端都通过它说话 | **短期零工程（已成品）→ 中期 2–3 人月（中文增强）** | 间接服务所有人 |
| **方案五：桌面端 LarePass 感知集成** | 让 Type4Me / Handy / VoiceInk / CapsWriter 等已有桌面客户端发现并自动用 Olares 集群语音服务 | 用户在 Mac/Win 上装客户端，登录 LarePass 即"一键就接上自家 Olares" | **轻量版 1 人月 / 完整版 4–6.5 人月（mac+win）** | 桌面用户 ~60% |

---

## 二、默认推荐

**三件套组合**：

1. **方案四（集群侧统一语音后端）** — 短期复用 Olares Market 上已发布的 `speaches` 应用（OpenAI 兼容、内置 faster-whisper），无需新工程；中期扩展中文引擎（fork `speaches` 加 `sherpa-onnx` 后端，加 SenseVoice / Paraformer）。约 **2–3 人月**。
2. **方案五（桌面端 LarePass 感知集成）** — 短期先发"轻量版 adapter daemon"（1 人月，让用户已装的 Type4Me/Handy/CapsWriter 一键接上集群）；中期推出"完整版自研 Tauri 客户端"（macOS + Windows，推荐 fork MIT 协议的 `Handy` 作基线）。约 **5–7 人月**。
3. **方案三（Android 后台语音服务）** — 比方案二投入减半；发布 Android `RecognitionService` APK，用户在原 Gboard / HeliBoard 等 IME 上点麦克风键即可调到本服务。约 **3–5 人月**。

**预算与节奏**：合计约 **8–10 人月**（含文档），分三阶段约 **6–9 个月**内全部上线；预计覆盖 **65% Olares 用户**。

**为什么不推荐其它组合**：

- 方案一 单独作为兜底永远存在，但**不能作为唯一方案**——"让用户自己装第三方输入法"在国产 ROM 上充满坑（VIVO 默认放回讯飞；MIUI 默认放回搜狗；HarmonyOS 应用商店里 WhisperIME / FUTO 缺席）。
- 方案二（完整自研 IME）比方案三投入翻倍，但用户净增益有限：用户已有偏好的 IME，重训用户习惯成本高，且 iOS 自定义键盘无法访问麦克风（Apple 政策硬约束）。
- 方案四 单独跑没有客户端配套也用不起来；必须搭配方案三 / 方案五。

---

## 三、三阶段路线

| 阶段 | 时间 | 范围 | 工作量 |
|---|---|---|---|
| **短期阶段** | 立项后 2 个月内 | 方案四"已成品"（`speaches` 直接上架文档化）+ 方案五 桌面客户端 PoC（macOS） + 方案三 Android PoC | ~2 人月 |
| **中期阶段** | 立项后 3–5 个月 | 方案四 中文扩展（fork `speaches` 加 sherpa-onnx + SenseVoice/Paraformer） + 方案五 双平台正式版（Mac/Win） + 方案三 正式版上架 F-Droid | ~5 人月 |
| **长期阶段** | 立项后 6–8 个月 | 方案四 高端 GPU 模型可选（Parakeet TDT v3 + Voxtral）+ 方案五 增强（多模型并行、跨语种）+ 方案二 试点（如有需要） | ~3 人月 |

> 关键里程碑：
> - 第 1 周：跑通 fork `speaches` 加 sherpa-onnx 的最小 PoC（约 200 行 Python）
> - 第 1 个月：方案五 桌面客户端可一键发现集群侧 endpoint
> - 第 3 个月：方案四 上 Olares Market 中文扩展版；方案五 双平台正式版
> - 第 6 个月：方案三 上 F-Droid / Google Play

---

## 四、关键事实（已查证）

- **`speaches` 应用已上 Olares Market**（当前版本 1.0.12），暴露 OpenAI 兼容 STT/TTS endpoint，内置 `faster-whisper-small`（英文）+ `Kokoro-82M` TTS，GPU 加速、CPU 兜底；**方案四 短期阶段实际上是零工程**。
- **LarePass 客户端没有任何语音输入相关代码**（确认其源码位于 `beclab/Olares/apps/`，是 Quasar + Vue 3 + Capacitor 7 + Electron 39 单仓库 14 entry 巨型工程）；我们的策略是**不动它**，只让外部应用接入它。
- **国内可用性已查证**：ModelScope 不登录可直接下 SenseVoice / Paraformer；HuggingFace 走 hf-mirror.com 兜底；Whisper / Parakeet / Voxtral 均能在国内一致拉到。
- **CapsWriter Server 已有第三方容器化 fork**（`DF-wu/CapsWriter-Offline-Container`），证明 Python multiprocessing 路径在 K8s 内不会塌——但接口非 OpenAI 兼容（自定义 protobuf over WebSocket），需要在方案四集群侧用 sherpa-onnx 替代。
- **桌面端 fork 基线推荐**：`Handy`（**22.2k★**、MIT、Tauri 2 + Rust + whisper-rs + transcribe-rs（Parakeet V3）+ Silero VAD，工程最干净）；`Type4Me`（中文 + 双引擎样板）。**避开 `FluidVoice`**（许可证 BSL/AGPL 反复）和 `Voquill`（AGPL 传染性强）。
- **Android 推荐路径是方案三 + RecognitionService**，最佳样板是 FUTO 的 `voice-input` APK。

---

## 五、风险摘要（按严重度）

| 风险 | 影响 | 缓解 |
|---|---|---|
| **LarePass 还没有 Service Provider SDK** —— 方案五客户端"识别 LarePass 登录态"目前缺协议 | 阻塞方案五落地 | 立项前与 LarePass team 对齐 SDK；中期可先做"读 LarePass 本地配置"的过渡方案 |
| **NVIDIA Parakeet 模型 CC-BY-4.0 attribution** | 必须显式署名 | OlaresManifest `license` + 客户端"关于"页统一展示 attribution |
| **Cohere 商用本地部署不友好** | 仅影响方案四加 Cohere 引擎的情况 | 默认不部署 Cohere；如要用先走法务咨询 |
| **`whisperwebuiv2` 已存在 Olares Market** | 与方案四方向重叠 | 立项前与 whisperwebuiv2 团队对齐：合并、替代还是平行 |
| **国产 Android ROM 对第三方 RecognitionService 限制** | 方案三在国内 ROM 实际可达用户面收窄 | 立项时实测 MIUI / HarmonyOS / ColorOS 等 5 家；写入兼容性说明 |
| **iOS 第三方键盘无麦克风权限**（Apple 政策硬约束） | iOS 端方案二 / 方案三 不可行 | iOS 端只走方案一（Apple Dictation）+ 方案五（桌面端覆盖） |
| **F-Droid reproducible build 与上架流程没实测过** | 方案二 / 方案三 发布延迟 | 立项第一周走完 PoC 流程 |
| **FluidVoice 许可证从 BSL 改回又改回 AGPL** | 不影响默认路径（不 fork 它），但需保持警觉 | 持续跟踪上游许可证变更 |

详细的 38 条风险清单见 `09_风险与开放问题.md`。

---

## 六、阅读路线（按角色）

| 角色 | 推荐阅读顺序 | 估计时间 |
|---|---|---|
| **决策者** | 本 `README.md` → `08_选型推荐与落地路线.md` → `09_风险与开放问题.md` §一/§九 | 15 分钟 |
| **产品 / PM** | 本 `README.md` → `08_选型推荐与落地路线.md` → `05_安装与生态.md` § 用户体验地图 | 30 分钟 |
| **后端 / DevOps** | `06_R4_集群侧设计.md` → `04_大模型架构对比.md` § Olares 集群可部署性 → `05_安装与生态.md` § 服务端安装 | 1 小时 |
| **桌面客户端开发** | `07_客户端设计.md` § 方案五 → `03_技术架构对比.md` → `05_安装与生态.md` § 桌面安装 | 1 小时 |
| **Android 开发** | `07_客户端设计.md` § 方案三 → `03_技术架构对比.md` § Android IME / RecognitionService → `05_安装与生态.md` § 移动安装 | 1 小时 |
| **模型 / 算法** | `04_大模型架构对比.md` 全文 → `06_R4_集群侧设计.md` § 引擎并存策略 | 1.5 小时 |
| **法务 / 合规** | `09_风险与开放问题.md` § 法律与许可证 → `04_大模型架构对比.md` § 许可证速查 | 30 分钟 |

---

## 七、与 Olares Team 应对齐的事项（决策前）

1. **LarePass 是否计划提供 Service Provider SDK** 用于第三方桌面/移动应用识别 LarePass 登录态与发现集群 sharedEntrance —— 这是方案五落地的核心依赖。
2. **`whisperwebuiv2` 是否会继续维护** —— 决定方案四是合并、替代还是平行。
3. **Olares Market 上架对带 Attribution 模型的态度** —— 决定 Parakeet / Voxtral 是否可走默认引擎。
4. **Olares Mobile / LarePass 移动端的 IME / Autofill 现状** —— 用户原话提到"LarePass 可能直接集成了所在系统输入法"，需要 LarePass team 给一个明确答案。
5. **集群侧 GPU 资源池现状** —— 决定方案四 长期阶段（Parakeet TDT v3 等大模型）是否可行。

完整 10 项沟通点见 `09_风险与开放问题.md` §十。

---

## 八、文件索引

| 文件 | 内容 | 对外性 |
|---|---|---|
| `README.md`（本文）| 一页纸结论 + 阅读导览 | 对外 |
| `00_报告范围与样本集规划.md` | 样本盘点（重点 10 个 + 横向对比 24 个 + 提名 24 个）、引擎清单、生态背景 | 对外 |
| `03_技术架构对比.md` | 七大架构维度横向对比，识别五大架构流派 | 对外 |
| `04_大模型架构对比.md` | ASR / TTS / LLM 模型与云 API 横向对比 + 国内可用性 + Olares 可部署性 | 对外 |
| `05_安装与生态.md` | 桌面 / 移动 / 服务端安装复杂度 + 模型分发 + 用户体验地图 | 对外 |
| `06_R4_集群侧设计.md` | 方案四 三阶段设计、Manifest 骨架、接口契约 | 对外 |
| `07_客户端设计.md` | 方案一 / 二 / 三 / 五 设计、API、工作量 | 对外 |
| `08_选型推荐与落地路线.md` | 用户群 × 方案 推荐矩阵 + 三阶段路线 + 工作量 + 五个预算档组合 | 对外 |
| `09_风险与开放问题.md` | 八大类 38 条风险 + 与 Olares Team 沟通点 + 立项前必做实测 | 对外 |
| `01_LarePass源码考察.md` | LarePass 源码与依赖事实清单 | **调研档案，对外读者无需阅读** |
| `02_课题方向修正.md` | 五条方案的推导过程 | **调研档案，对外读者无需阅读** |
| `_internal/WORK_LOG_2026-05-26.md` | 工作日志 | 内部 |

> 所有 `.md` 文件均有对应 `.docx`（编号一致）；`docx` 由 `generate_doc.py` 自动同步。
