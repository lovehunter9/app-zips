# Typeless 调研

> 收录 2026-05-25 的一次产品 + 公司 + 技术 + 竞品 + 隐私争议 + 开源仿制版的综合调研。

---

## 0. 同名歧义先理清

「Typeless」这个词在 2026 年至少指代三件不同的事物，搜索时要先分清：

| 指代 | 是什么 | 备注 |
| --- | --- | --- |
| **Typeless（typeless.com）** | AI 语音听写软件 / 语音键盘 | **本文主角**，2025 年底上线、2026 年快速走红 |
| **TypeLess（YC S22）** | YC Summer 2022 一家做「AI 消息 API」的小公司 | 创始人 Milad Morgan / Inaz Novin，**与上面那个完全无关**，名字撞车 |
| **OpenTypeless（github.com/tover0314-w/opentypeless）** | 上述 Typeless 的开源仿制 / 替代品 | Tauri + Rust + TS，MIT 协议，2026-02 建仓 |
| **typeless-sdk（npm）** | 把 OpenTypeless 的 STT+LLM pipeline 抽成 Node.js SDK | 同一作者发布 |

下文若不特别说明，「Typeless」=表中第一行那个。

---

## 1. 产品概览

| 维度 | 内容 |
| --- | --- |
| 一句话 | "Press Fn, speak, get polished text everywhere" — 全局快捷键 → 说话 → AI 把你的口语打磨成「像精心打字过的」文字，直接落到任何 App 的当前光标位置 |
| 类别 | AI Voice Dictation / Voice Keyboard，是 Wispr Flow / Superwhisper / Aqua Voice / Willow Voice 的同类 |
| 平台 | macOS、Windows、iOS、Android **4 平台俱全**（这个赛道里少有），Web 在 waitlist |
| 触发方式 | 桌面：`Fn` 键（可改）；移动：键盘上的 Speak 键 |
| 语种 | 100+ 种，自动识别、能多语混说 |
| 速度宣传 | 220 wpm（≈ 普通打字 4 倍） |
| 实测准确率 | 安静环境干净口音 ~95%；嘈杂 / 重口音 / 专业术语下明显下降 |
| 单次会话上限 | 6 分钟（5 分钟弹提示，对长录音不友好） |
| 三大模式 | **Dictate**（说→文本）、**Translate**（说一种语言→输出另一种）、**Ask anything**（选中文字 + 说指令 → 改写 / 摘要 / 翻译） |
| Product Hunt | 桌面版、移动版各拿过一次 **#1 Product of the Day** |

### 1.1 定价

| 套餐 | 价格 | 限制 |
| --- | --- | --- |
| Free | $0 | 4 000 词 / 周 |
| Pro（年付） | $12/月（一次 $144） | 不限词数、优先功能、团队管理 |
| Pro（月付） | $30/月 | 同上 |

**这是 2026 年同类产品里价位最贵的几款之一**。对比：

- BossAI $9.99/mo
- Aqua Voice $8/mo
- Voibe $7.50/mo 或 $149 终身
- Superwhisper $8.49/mo 或 $849 终身

月付 $30 被普遍认为偏贵；年付 $12 相对合理。

---

## 2. 公司与团队

| 维度 | 内容 | 信息源 |
| --- | --- | --- |
| 法律实体 | **Simply CA LLC**，Palo Alto, CA | typeless.com/about |
| 员工数 | LinkedIn 显示 3-5 人（US + UK） | LinkedIn 公司页 |
| 加速器 | **Stanford StartX**（Stanford 校友/师生专属加速器） | typeless.com/about |
| 机构投资人 | **真格基金（ZhenFund）** —— 合伙人 Anna Fang（方爱之） / 戴雨森 的被投名单里明确点名 Typeless，与 Manus、Momenta、Castbox、Macaron 并列 | zhenfund.com/team 中英文页 |
| 公开融资轮次 | **未披露具体金额** | Grokipedia / Crunchbase 都没数 |
| 时间线 | 见下方 |

### 2.1 时间线

```
2021-04   创始人开始 Stealth startup（原型期）
2024      Typeless 正式成立（Grokipedia 口径）
2025-07   创始人 LinkedIn 将 title 改为 Typeless CEO
2025-08   限量 beta，创始人 LinkedIn 公告
2025-11   Product Hunt 首发（桌面 macOS）
2025-12   macOS 正式版（typeless.com 公开下载）
2026-02   iOS 1.0 上架 App Store
2026-03   Windows 1.0 / HIPAA compliant 公告
2026-05   Android 1.0 上架 Google Play
```

### 2.2 创始人 & CEO：Huang Song（@huang_song_）

| 履历 | 时间 |
| --- | --- |
| 武汉光电国家实验室 研究助理 | 早期 |
| SandForce VLSI 验证 / **Apple 硬件工程师** | 大约 2010 前后 |
| **Stanford EE 硕士** 研究生 | 2011-09 至 2013-06 |
| **LinkedIn 软件工程师** | 中间段 |
| **Google 软件工程师**（湾区，~3.5 年） | 2016 前后至 2020 |
| Stealth startup 创始人 | 2021-04 至 2025-07 |
| **Typeless Founder & CEO** | 2025-07 至今 |

旧账号显示他在 Stanford 期间是 **Stanford 中国学生学者联合会 公关副主席**（2012-2013），可判断是华人 Stanford 校友圈的圈内人。这也解释了为什么能拿到真格基金的天使投资。

---

## 3. 技术架构

### 3.1 官方口径（marketing）

- "**Zero data retention**" —— 录音 / 转录 / 编辑不存
- "**On-device history**" —— 历史记录只在你设备上
- "**Never trained on your data**" —— 不拿去训模型
- "**Private by design**"

### 3.2 独立研究者拆出来的真实情况

2025 年 11 月，X 用户 `@medmuspg` 发了一份对 macOS 客户端的**逆向分析**，在日本 Mac 圈 + 医疗 IT 圈引发了一波关注，结论被竞品 Voibe 整理成详细的 audit 报告。**以下条目是研究者声称、未被独立复核**，但与 Typeless 自家隐私政策的文字相互印证：

| 维度 | 实际情况 |
| --- | --- |
| **音频处理** | **不是端上跑**，发到 **AWS us-east-2（俄亥俄）** 进行转录，用完即丢 |
| **使用的第三方** | 隐私政策自承包含 "third-party LLM providers"（明确点了 **OpenAI**），还有 analytics provider、云厂商、通信服务商 |
| **额外采集** | 浏览器 URL（含 Gmail / Google Docs 内的页面）、聚焦的 App 名、窗口标题（通过 macOS Accessibility API） |
| **剪贴板** | 有访问权限 |
| **本地存储** | 历史在本地 SQLite **未加密、明文** |
| **请求权限** | 麦克风 + Accessibility（应该的）+ **Screen Recording / Camera / Bluetooth / Full Accessibility**（远超必要） |
| **法律透明度** | ToS 缺乏明确法人名、WHOIS 私密 |
| **HIPAA** | 2026-03 官方宣布 "HIPAA compliant"，但**不公开签 BAA**（Paubox 的合规评估特别提示这点） |

**关键认知裂缝**：

> "**On-device history**" ≠ "**On-device processing**"
>
> 前者只是说历史不上云，后者才是音频不出设备 —— Typeless 只做到了前者，但官方文案让用户感觉做到了后者。

### 3.3 推测的实际技术栈

虽然 Typeless 没说，但从「同类工具 + 自家政策点名 third-party LLM + 路由到 AWS us-east-2」可以推出：

```
你的麦克风
    ↓
本机 app（macOS Native / Tauri-like）
    ↓ HTTPS
AWS us-east-2（Typeless 自家网关）
    ↓
[STT 层]  Whisper / Deepgram / 自训 ASR     ← 最可能 OpenAI Whisper 或 Deepgram
    ↓
[LLM 抛光层]  OpenAI GPT-4 系列（政策明确点名）
              系统 prompt = "remove filler / fix grammar /
              adapt tone based on active app context"
    ↓
返回到本机 → 模拟键盘把文本敲进当前焦点
```

这个判断与 **OpenTypeless（开源仿制版）所采用的架构高度一致**（见 §5），属于反向交叉验证。

---

## 4. 竞品矩阵（2026 年口径）

| 工具 | 处理位置 | 定价 | 平台 | 核心定位 / 注脚 |
| --- | --- | --- | --- | --- |
| **Typeless** | 云（AWS us-east-2） | $12-30/mo | Mac/Win/iOS/Android | 4 平台全覆盖 + 强 AI 改写，**贵 + 隐私争议** |
| **Wispr Flow** | 云 | $15/mo（年付） | Mac/Win/iOS/Android | 融资 $81M，**SOC 2 Type II + HIPAA**，企业级首选 |
| **Superwhisper** | **端**（带可选云模式） | $8.49/mo 或 $849 终身 | Mac/iOS | 跑本地 Whisper，**逐字转录、不改写** |
| **Aqua Voice** | 云 | $8/mo | Mac/Win | 自研 Avalon 模型，**技术词汇 / 代码场景**最强 |
| **Voibe** | **100% 端**（Apple Silicon） | $7.50/mo 或 $149 终身 | Mac | 隐私强硬派，**Developer Mode** 集成 Cursor / VS Code |
| **VoiceInk** | **100% 端** | **$39 一次性** | Mac | **开源、可审计**，隐私 + 省钱 |
| **Willow Voice** | 端（带云模式） | — | Mac | 语种较少、UI 老派 |
| **Apple Dictation** | 大部分端 | 免费 | Mac/iOS | 系统自带，无 AI 改写 |
| **Windows Voice Typing** | 端 | 免费 | Win | 系统自带，无 AI 改写 |
| **Dragon NaturallySpeaking**（Microsoft 2022 收购 Nuance） | 端 | $699 | Win | 老牌行业标准，企业医疗法律场景仍在用 |

**口碑共识**：

- 追多平台 + AI 自动改写 → **Wispr Flow / Typeless**
- 追隐私且只用 Mac → **Voibe / VoiceInk / Superwhisper（offline 模式）**

---

## 5. OpenTypeless（开源仿制版）

这是本次调研中最值得关注的衍生物，因为它把 Typeless 的工作机理几乎完整暴露了出来。

| 维度 | 内容 |
| --- | --- |
| 仓库 | https://github.com/tover0314-w/opentypeless |
| 创建 | 2026-02-26（**仅 3 个月**） |
| 最新 release | v0.1.24（2026-04-13） |
| Star / Fork | ~218 / 29 |
| 协议 | **MIT** |
| 语言 | TypeScript 60.8% + Rust 35.1% + CSS 3.3% |
| 框架 | **Tauri**（Rust 后端 + Web 前端），桌面跨平台 |
| 主页 | https://opentypeless.com |
| README | 中 / 日 / 英三语 |

### 5.1 架构

完全是 BYOK（Bring Your Own Key）模式，**6 家 STT + 11+ 家 LLM 任挑**：

```
audio（cpal 录制）→ STT 适配层 → LLM polish 层 → 输出适配层
                    │            │                │
                    ▼            ▼                ▼
                Deepgram      OpenAI            模拟键盘
                AssemblyAI    DeepSeek            /
                Whisper       Claude            剪贴板粘贴
                Groq Whisper  Gemini
                GLM-ASR       Moonshot
                SiliconFlow   Qwen
                              Zhipu GLM
                              Yi
                              Ollama（本地）
                              LM Studio（本地）
                              Groq
```

源码目录结构（出自 README）：

```
opentypeless/
├── audio/            # Audio capture via cpal
├── stt/              # STT 提供商适配（Deepgram、AssemblyAI、Whisper-compat、自家 Cloud）
├── llm/              # LLM 提供商适配（OpenAI-compat、自家 Cloud）
├── output/           # 文本输出（键盘模拟 / 剪贴板）
├── storage/          # 配置（tauri-plugin-store）+ 历史/词典（SQLite）
└── app_detector/     # 探测当前焦点 App
```

### 5.2 关键特性

- **可完全离线**：本地 Whisper + Ollama 本地 LLM → 整套不联网
- **流式输出**：LLM 边生成边「敲」键盘
- **Highlight before speak**：先选中一段文字，按热键说话，LLM 会拿这段做 context
- **Custom Dictionary**：注入领域词汇，强制拼对
- **6 大类对比表**：README 直接列出 OpenTypeless vs macOS Dictation vs Windows Voice Typing vs Whisper Desktop 的功能矩阵

### 5.3 附带的 SDK：typeless-sdk（npm 包）

Node.js ≥ 18，零运行时依赖，把「上传音频 → STT → LLM 抛光」封装成几十行调用：

```js
const sdk = new VoiceTextSDK({
  stt: {
    endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
    apiKey: process.env.GROQ_API_KEY,
  },
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
  },
});

const { transcript, polishedText } = await sdk.process('meeting.m4a', {
  vocabulary: ['KPI', 'EBITDA'],
  language: 'zh',
  appType: 'document',
});
```

SDK 内置的 STT 适配表（截选）：

| Provider | endpoint | model |
| --- | --- | --- |
| OpenAI Whisper | `https://api.openai.com/v1/audio/transcriptions` | `whisper-1` |
| Groq | `https://api.groq.com/openai/v1/audio/transcriptions` | `whisper-large-v3-turbo` |
| GLM-ASR（智谱 AI） | `https://open.bigmodel.cn/api/paas/v4/audio/transcriptions` | `glm-asr-2512` |
| SiliconFlow | `https://api.siliconflow.cn/v1/audio/transcriptions` | `FunAudioLLM/SenseVoiceSmall` |

---

## 6. Reception / 用户口碑

| 来源 | 评价倾向 |
| --- | --- |
| Product Hunt | **5.0 / 6 评（iOS）**，反复获 "Product of the Day" |
| 安静环境实测准确率 | ~95% |
| Trustpilot / Product Hunt 用户**主要吐槽** | (1) 嘈杂 / 口音下掉准；(2) 长术语 / 专有名词易错；(3) 改写有时**改变原意**；(4) **没法按 App 分别配置 tone**，所有 App 共享一个风格；(5) 6 分钟单次上限 |
| 名人背书 | Robert Scoble、Linus Ekenstam、Andre Oliveira、Gideon Shalwick、Devv AI 创始人 Jiayuan Zhang 等 |
| 负面舆论 | 2025-11 日本社区因 @medmuspg 那份逆向分析有过一波「卸载并撤回先前推荐」的连锁反应 |

---

## 7. 调研中尚未确认 / 可能需要进一步验证

| 项 | 缺口 |
| --- | --- |
| 具体 STT 引擎 | 推测 Whisper 或 Deepgram，但 Typeless 没公开。可以通过 Charles / mitmproxy 抓包确认 |
| 具体 LLM 模型 | 隐私政策点名 OpenAI，但具体是 `gpt-4o` / `gpt-4o-mini` / `gpt-5` 还是别的，未确认 |
| 真格基金金额 | 真格官网只在被投名单中列名，未披露轮次或金额 |
| StartX 与 真格 同时存在的股权结构 | 不清楚是 StartX 给加速器股权 + 真格做天使、还是其它组合 |
| 中国市场策略 | 创始人是华人 + 真格背书 + 有日语版本，但**没有中文版本**；中国市场策略不明 |
| 单次 6 分钟上限的原因 | 是商业策略 / OpenAI Whisper API 输入长度限制 / 还是为了控成本，未公开 |
| `@medmuspg` 原帖 | 已多次被引用但原推 URL 没保留，独立复核需要重做逆向分析 |

---

## 8. 一句话总结

**Typeless 是 2025 年底冒头、2026 年迅速成为「AI 语音键盘」品类头部之一的一款产品**，由 Stanford 校友 / 前 Google 工程师 Huang Song 创立，拿了 Stanford StartX 加速器 + 真格基金天使，产品力（多平台 + AI 改写）和定价（贵）都站在头部，但因「on-device 营销 vs 云架构现实」的认知裂缝在 2025-11 引发过一轮隐私争议；其工作机理已被开源项目 OpenTypeless（MIT，Tauri + Rust）以 BYOK 形式几乎完整复刻，对应的 pipeline 也以 `typeless-sdk` 形式发到了 npm，**这个赛道的核心壁垒已经被验证是在产品 / 体验 / 平台覆盖，而不在底层模型**。

---

## 9. 参考来源

- 官方
    - https://www.typeless.com/
    - https://www.typeless.com/about
    - https://www.typeless.com/data-controls
    - https://www.typeless.com/help/quickstart/key-features
    - https://www.typeless.com/downloads
- 第三方评测
    - https://nubiapage.com/typeless-review-in-2026-app-pricing-ai-download-user-experience-and-faqs/
    - https://www.getvoibe.com/resources/typeless-privacy-issues/
    - https://wisprflow.ai/best-dictation-apps
- 维基 / 创始人
    - https://grokipedia.com/page/Typeless
    - https://arrfounder.com/@huang_song_
    - https://linkedin.com/in/huang-song-33122743
    - https://linkedin.com/company/typeless-hq
- 投资人
    - https://www.zhenfund.com/team
    - https://en.zhenfund.com/Team
    - https://en.zhenfund.com/portfolio
- 开源仿制
    - https://github.com/tover0314-w/opentypeless
    - https://www.opentypeless.com/sw/features
    - https://www.opentypeless.com/en/blog/choosing-stt-provider
    - https://npmx.dev/package/typeless-sdk
- 同名歧义
    - https://www.ycombinator.com/companies/typeless（YC S22 的 TypeLess，与本文主角无关）
