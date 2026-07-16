# AuralWise 复刻方向对比：自托管 vs 自建 SaaS vs A+

> 在反推得出 AuralWise 大概率为 Go 后端 + 部署在阿里云边缘、模型层很可能由 `faster-whisper + SenseVoice + 类 CAM++ 声纹 + YAMNet` 组成（详见《AuralWise架构反推分析》及其自我审视章节）之后，对"我们如何在自己工作区里复刻它"做一次方向对比。所有判断基于工作区已是 Helm chart 应用目录形态、已有 `speaches-*` 与 `whisperwebuiv2-*` chart 的前提。

---

## 0. 三个方向的一句话定义

- **方向 A**：把模型跑起来，自家用 SDK 调（最轻）。
- **方向 A+**：把模型跑起来，自家用一个"和 AuralWise 一模一样的 REST 接口"调（接口稳定 / 实现可换；本文重点推荐）。
- **方向 B**：把方向 A+ 再包成可对外卖的 SaaS（加多租户、计费、Webhook、合规、运维）。

---

## 1. 总对比表

| 维度 | 方向 A：自托管复刻 | 方向 A+：自托管 + AuralWise 兼容外壳 | 方向 B：自建 SaaS 后端 |
| --- | --- | --- | --- |
| 核心目标 | 自用 / 给同事用 / 内嵌自家产品 | 自用，但接口稳定可换实现 | 对外卖 API，多租户 |
| 最终形态 | 一两个 Helm chart | 多个模型 chart + 一个 ~300 行 Go shim chart | 完整后端（API + worker + DB + 队列 + 存储 + 计费 + Webhook） |
| 首次跑通时间 | 1–3 天（多数组件你工作区已有） | 1 周左右（多写一层 shim） | 4–8 周 |
| 代码量 | 200–500 行胶水 | + ~300 行 Go shim | 3,000–6,000 行（Go API ~1.5k + Python worker ~1.5k + 前端账户 UI 另算） |
| 硬件门槛 | 一张消费级 GPU（12GB 显存够用） | 同左 | 至少 2–3 张 GPU + 调度/数据库节点 |
| 能力覆盖度 | 8/8（ASR 标准、ASR 中文极速、VAD、说话人、声纹、AED、词级时间戳、段级时间戳） | 8/8 + 统一 REST 接口形状 | 8/8 + 多租户 + 计费 + Webhook + API Key 管理 + 私有化部署 |
| 是否需要计费 | 无 | 无 | 必须（账户余额、扣费流水、充值流水） |
| 是否需要 Webhook + HMAC | 无 | 可选（接口预留即可） | 必须（含 4 次重试调度） |
| 是否需要 API Key / JWT | 无 / 一个静态 Bearer 足够 | 一个静态 Bearer | 必须（asr_ 前缀、密钥轮换、按用户隔离） |
| 运维负担 | 一个 K8s namespace + GPU 节点亲和性 | 同 A，多一个 shim 服务 | 还要加 Postgres HA、Redis、对象存储、监控、备份、对账、客服工单 |
| 性能伸缩 | 垂直扩，受单机 GPU 限制；并发高了排队 | 同左；如果 shim 加上简易队列，可平稳排队 | 水平扩，多 worker 抢 Redis 队列，瓶颈在 GPU 而非调度 |
| 风险点 | FunASR / faster-whisper 升级时 API 变；YAMNet TF 兼容性偶尔坑 | 同左 | 计费对账错误、Webhook 漏发、API Key 泄露——任何一项都是用户级事故 |
| 数据合规 | 全程内网，最低风险 | 同左 | 客户音频要落自家对象存储，触发 GDPR / 个人信息保护法等合规义务 |
| 能否在 K8s 里跑 | 完全可以，与现有 chart 风格一致 | 完全可以，shim 与现有 chart 同形 | 也可以但要复杂得多（StatefulSet + PVC + Redis + Postgres） |

---

## 2. 用户画像 → 该选哪边

| 你的处境 | 推荐 |
| --- | --- |
| "我只是想给团队/自家产品提供一个能用的语音理解能力" | **方向 A**。1–3 天能跑通，FunASR + faster-whisper 都是熟栈。 |
| "我想验证一下技术可行性，将来可能产品化" | **方向 A+**。接口预留好就够，迁移路径平滑。 |
| "我想做一个像 AuralWise 一样对外卖 API 的产品" | **方向 B**。但先想清楚商业基础——AuralWise 之所以能跑通是因为有津津乐道+声湃做底，GPU 算力是沉没成本。从零做 SaaS，光是计费+对账+客服+合规就够耗一个小团队半年。 |
| "我维护的是一个 Helm 应用目录，希望统一接口" | **方向 A+ 是最佳匹配**——见下节。 |

---

## 3. 为什么单独推 A+（针对工作区现状）

工作区是 `app-zips/`，全是 Helm chart（speaches/whisperwebuiv2/opennotebook/agentzero/tensorzero/radicale 等）。这是一个**内部能力库**而不是商用 SaaS：

- **方向 A 的"裸自托管"** 缺一层统一的 task/result 模型，每个 chart 暴露的 API 形状都不同，调用方接起来很乱。
- **方向 B 的"完整 SaaS"** 浪费——你不需要计费，不需要多租户，不需要 Webhook 签名。

A+ 的做法：

1. **底层模型层**：每个能力打一个独立 Helm chart（参考你已有的 speaches-* 模式）
   - `funasr-server` — SenseVoice + fsmn-vad + CAM++ 三合一，funasr 一个 Python 进程
   - `speaches` — 你已有，faster-whisper + Silero VAD + 词级时间戳
   - `yamnet-server` — 一个极小的 Flask + TF Hub 包装，或 ONNX Runtime
2. **网关层**：写 ~300 行的 Go 服务 `auralwise-shim`，**完全照抄 AuralWise 的 REST 接口形状**——`POST /v1/tasks`、`GET /v1/tasks/:id/result` 等。它干的事就是：
   - 接收任务、存 SQLite（不需要 Postgres）
   - 路由到下游 chart 的内部 HTTP 端点
   - 把多个结果合成 AuralWise 文档里那个 JSON 形状
   - 跳过：计费、JWT、API Key、Webhook（除非真的需要）
3. **好处**：
   - 你工作区里现有的 chart 都能复用
   - 应用方代码可以直接参照 AuralWise 文档写，迁移成本 0
   - 哪天 AuralWise 涨价或下线，直接切自家 shim
   - 哪天真要做 SaaS，只要在 shim 上加计费/账户两层就升级到方向 B

---

## 4. 关键差异一句话

- **方向 A** = 把模型跑起来，自家用 SDK 调
- **方向 A+** = 把模型跑起来，自家用一个"和 AuralWise 一模一样的 REST 接口"调（接口稳定 / 实现可换）
- **方向 B** = 把方向 A+ 包成可对外卖的 SaaS（额外加多租户、计费、合规、运维）
