# LarePass 源码考察【内部调研档案】

> **本文定位**：报告**早期调研过程**的产物，对外读者无需阅读。这里把 LarePass 客户端的真实源码事实（仓库位置、技术栈、目录结构）落地，作为后续设计的协议背景。
>
> **结论已合并**：本文的关键事实（如 LarePass 当前没有任何语音输入相关代码、技术栈是 Quasar+Vue3+Capacitor+Electron）已在 `README.md` 与 `08_选型推荐与落地路线.md` 引用；对外读者直接看那两份即可。
>
> **本文已失效部分**：§四原"如何 fork/PR LarePass 客户端"的设计推论已废弃——课题最终定型为**不动 LarePass 任何代码**。

> 调查方法：直接读 `beclab/Olares` 主仓的 `apps/` 子目录全部 `package.json`、`README.md`、目录结构与 build 脚本（通过 GitHub Contents API + Raw 下载，未本地 clone）。读取时间：2026‑05‑26。

调查方法：直接读 `beclab/Olares` 主仓的 `apps/` 子目录全部 `package.json`、`README.md`、目录结构与 build 脚本（通过 GitHub Contents API + Raw 下载，未本地 clone）。读取时间：2026‑05‑26。

---

## 一、仓库定位与边界

### 1.1 LarePass 当前源码真实位置

| 维度 | 事实 | 置信度 |
|---|---|---|
| 主仓库 | `github.com/beclab/Olares`（4.5k★，主语言 Go） | `[高]` 来自 GitHub 主页 |
| LarePass 源码位置 | `beclab/Olares/apps/` 目录（Lerna 单仓库，6 个子包） | `[高]` 来自 `apps/README.md`："*This directory contains the code for system applications, primarily for LarePass.*" |
| 旧仓库 `beclab/TermiPass` | 仍存在，最后版本 `v1.2.17`（2024‑06‑17），现已不再更新 | `[高]` |
| `beclab/apps`（另一个独立仓库） | 是 Olares Market 的应用集合（Helm chart + `OlaresManifest.yaml`），与 LarePass 客户端**无关** | `[高]` 来自该仓 README |
| 主仓许可证 | AGPL‑3.0 | `[高]` |
| `apps/` 子目录许可证 | `apps/package.json` 标 `GPL-3.0`；`apps/packages/server/package.json` 标 `GPLv3`；`apps/packages/app/package.json` 未显式标 license（继承上层） | `[高]` |

### 1.2 npm scope 与代号

LarePass 的 npm scope 是 **`@didvault`** —— 这是项目的内部代号（DIDvault，意指"DID 身份钱包"）。所有 6 个子包都以 `@didvault/` 命名：

```
@didvault/admin       管理后台
@didvault/app         核心客户端（一份代码 build 出 14 个 entry）
@didvault/core        共享 core 库
@didvault/mockbfl     本地开发用 mock backend (BFL = Backend For Larepass / Frontend Layer)
@didvault/sdk         共享 SDK
@didvault/server      Node.js 后端
```

> 同名干扰：另有一个完全无关的 `LaraPass`（PHP/Laravel 密码管理器，`larapass/larapass-v1`）和一个无关的 `alibori/larapass`（Laravel + Livewire + NativePHP），两者都跟 beclab 的 LarePass 没有关系。`[高]` ── 由命名空间、维护组织、技术栈三重不重合证实。

---

## 二、技术栈事实清单

### 2.1 顶层（`apps/`）

| 字段 | 值 |
|---|---|
| Monorepo 管理 | **Lerna v9** (`apps/lerna.json` → `packages/*`, `version: 0.1.0`, `exact: true`) |
| Node 引擎要求 | `>= 19.8.1`, npm `>= 10.9.3` |
| 主语言 | TypeScript 4.4.3（顶层 devDep） |
| Lint / Format | ESLint 8 + Prettier 2 + Husky + lint‑staged |
| 顶层 dependencies | `axios`, `clipboard`, `lodash.throttle`, `node-forge`, `utif` |
| Author | "Peng Peng" |
| License | GPL‑3.0 |

`[高]` 全部来自 `apps/package.json`。

### 2.2 客户端 `@didvault/app`（`apps/packages/app/`）

**框架与构建**：

| 字段 | 值 | 置信度 |
|---|---|---|
| 主框架 | **Quasar v2**（`@quasar/app-webpack` v3，`quasar.config.js` 存在） | `[高]` |
| 视图层 | **Vue 3**（`vue ^3.0.0`, `vue-router ^4`, `vue-i18n ^9.2.2`, `pinia ^2`） | `[高]` |
| 桌面壳 | **Electron 39**（`electron ^39.8.1`, `electron-builder 26`, `electron-updater`, `electron-store`, `electron-log`, `update-electron-app`） | `[高]` |
| 移动壳 | **Capacitor 7**（`@capacitor/core ^7.6.2`, `@capacitor/cli ^7.6.1`, + 15 个 Capacitor 插件） | `[高]` |
| UI 组件库 | **Element Plus** ^2.9.7（Vue 3） + `@quasar/extras` | `[高]` |
| 构建系统 | webpack 5 + Babel 7 + Sass + PostCSS 8 | `[高]` |
| 浏览器目标 | 现代浏览器 + Safari ≥15 + iOS ≥14 + Android ≥7 + ChromeAndroid ≥75 | `[高]` |

**Capacitor 插件清单**（决定移动端能力面）：

- `@capacitor-community/bluetooth-le ^7.1.1`
- `@capacitor-community/fcm ^7.1.1`（Firebase Cloud Messaging）
- `@capacitor/app, browser, camera, clipboard, device, filesystem, network, push-notifications, screen-orientation, status-bar`
- `@capacitor/barcode-scanner 2.2.6`
- `@capgo/capacitor-native-biometric 7.6.0`（指纹/Face ID）
- `@capgo/capacitor-social-login 7.17.0`
- `@ionic/pwa-elements ^3.1.1`

> **关键观察**：当前 Capacitor 插件清单里**没有** `voice-recorder` / `microphone` / `speech-recognition` / `media-recorder` 这类语音相关插件。`[高]`

**加密与身份**：
- `@trustwallet/wallet-core 3.3.3`（多链钱包内核）
- `ethers ^6.8.0`、`bip39 ^3.1.0`、`@noble/ed25519 1.7.1`
- `jsencrypt`, `node-rsa`, `crypto-js`, `crypto-browserify`, `js-base64`, `js-md5`, `hi-base32`
- `multiformats 9.6.4`（IPFS 风格的多格式编码）

**富文本 / 阅读 / 编辑器**：
- `@tiptap/core 2.0.0-beta.182` + `@tiptap/starter-kit`
- `monaco-editor ^0.52.2` + `monaco-yaml ^5.4.0` + `@guolao/vue-monaco-editor`（VSCode 同款编辑器）
- `ace-builds ^1.4.7` + `vue3-ace-editor`
- `markdown-it 14`、`marked 4`、`turndown 7.2.2`（HTML→Markdown）
- `pdfh5 1.4.2`、`pdfvuer ^2.0.1`、`epubjs ^0.3.93`
- `video.js 8.10.0`
- `heic2any ^0.0.4`
- `@vue-office/docx`、`@vue-office/excel`

**终端 / 开发者工具**（这是少见的客户端能力）：
- `@xterm/xterm ^5.5.0` + `@xterm/addon-attach`、`@xterm/addon-fit`、`@xterm/addon-web-links`
- `@icebergtsn/k8s-resources ^0.1.6`（K8s 资源类型）

**数据 / 网络**：
- `@sqlite.org/sqlite-wasm ^3.49.1`（浏览器内 SQLite）
- `dexie ^4.0.8`（IndexedDB ORM）
- `localforage 1.9.0`
- `webdav ^5.9.0`
- `axios 1.15.2`、`reconnecting-websocket ^4.4.0`、`vue-native-websocket-vue3`
- `@microsoft/fetch-event-source 2.0.1`（SSE 流）

**14 个 build target**（一份 Vue3+Quasar 代码 build 出 14 个不同 entry）：

| Build target | 命令 | Quasar 模式 | 端口（dev） |
|---|---|---|---|
| Vault | `build:vault` | `APPLICATION=VAULT PLATFORM=WEB` | 8090 |
| Mobile | `build:mobile` | `PLATFORM=MOBILE` | — |
| Files | `build:files` | `APPLICATION=FILES` | 5090 |
| Share | `build:share` | `APPLICATION=SHARE` | 5070 |
| Wise | `build:wise` | `APPLICATION=WISE` | 8100 |
| Settings | `build:settings` | `APPLICATION=SETTINGS` | 9000 |
| Editor（Profile） | `build:editor` | `APPLICATION=EDITOR` | 9100 |
| Preview（Profile） | `build:preview` | `APPLICATION=PREVIEW` | 9001 |
| Market | `build:market` | `APPLICATION=MARKET` | 8080 |
| Login | `build:login` | `APPLICATION=LOGIN` | 3090 |
| Wizard | `build:wizard` | `APPLICATION=WIZARD` | 2090 |
| Desktop | `build:desktop` | `APPLICATION=DESKTOP quasar build -m pwa` | 1090 |
| Dashboard | `build:dashboard` | `APPLICATION=DASHBOARD` | 9003 |
| Control Hub | `build:hub` | `APPLICATION=CONTROL_HUB` | 9002 |
| Studio | `build:studio` | `APPLICATION=STUDIO` | 9001 |

> 这意味着 LarePass 不是一个单体应用，而是"一份 Vue 3 代码 + 14 个 entry 模板 + 4 个壳（Web/PWA/Electron/Capacitor）" 的组合。任何"加一个语音输入功能"的设计都必须回答：**到底加在 14 个 entry 的哪一个里 / 或加成共享组件让多个 entry 复用 / 或加成一个独立 entry**。`[高]`

**src/ 目录结构**（截至 main 分支当天快照）：

```
apps/packages/app/src/
├── App.vue                     根组件
├── api/                        HTTP API 客户端
├── application/                14 个 entry 各自的入口逻辑
├── apps/                       app 概念模块
├── assets/
├── auth/                       认证
├── boot/                       Quasar boot 文件
├── components/                 共享组件
├── composables/                Vue 3 composables
├── constant/, containers/, core/, css/
├── did/                        DID（去中心化身份）模块
├── directives/
├── env.d.ts, globals.ts, quasar.d.ts, shims-vue.d.ts
├── headscale/                  Headscale VPN 集成（Tailscale 自托管开源版）
├── i18n/                       国际化
├── index.template.*.html       14 个 HTML 入口模板
├── jose/                       JWE/JWS JSON Web Tokens
├── layouts/, pages/
├── passphrase/                 助记词管理
├── payment/                    支付（Stripe）
├── platform/                   平台抽象层（Web/Electron/Capacitor switch，推测）
├── plugins/
├── router/
├── services/
├── stores/                     Pinia stores
├── test/, types/, utils/
├── wallet.ts                   钱包
└── websocket/                  WebSocket 客户端
```

> **关键空白**：`src/` 下**没有** `audio/` / `microphone/` / `voice/` / `whisper/` / `asr/` / `speech/` 任何目录。这表明 LarePass 当前**完全没有任何语音输入相关代码**。`[高]` ── 来自 `src/` 完整顶层目录列表。

### 2.3 后端 `@didvault/server`（`apps/packages/server/`）

| 字段 | 值 |
|---|---|
| 运行时 | Node.js 16.13.1（`engines`） |
| 主框架 | TypeScript + ts‑node + ts‑node‑dev（无显式 web 框架，可能基于 SDK 包内置 koa/express） |
| 数据存储 | **LevelDB**（`level 7.0.0`）+ **PostgreSQL**（`pg 8.7.1`）双栈 |
| 密码哈希 | `bcrypt 6.0.0` |
| 支付 | `stripe 8.212.0` |
| 分析 | `mixpanel 0.13.0` |
| IP 地理 | `maxmind 4.3.2` |
| 构建 | webpack 5 + ts‑loader |
| 与 BFL 关系 | `dev` 脚本设置 `BFL=http://localhost:5010` —— 表示 server 上游还有一个 BFL（Backend For Larepass）服务，由 Olares 集群提供 |

`[高]` 来自 `apps/packages/server/package.json`。

### 2.4 本地开发依赖（来自 `apps/README.md`）

- 本地 hosts 改 `127.0.0.1 test.xxx.olares.com`
- 设 `.env`：`ACCOUNT_DOMAIN=xxx.olares.com`、`DEV_DOMAIN=test.xxx.olares.com`
- `npm install` → `npm run dev:<project>` 启动单一 entry，HTTPS 自签证书
- 14 个 entry 各自有独立的 dev 命令、独立端口、独立 dev 域名（`test.xxx.olares.com:<port>`）

---

## 三、与"语音输入集成"相关的关键接口/集成点

以下都是基于上面客观事实的**推断**（未读到接口具体实现，只读到入口与依赖）：

### 3.1 客户端可挂接位置（命题 B 的落地点）

| 集成点 | 落点位置 | 难度 | 推断依据 |
|---|---|---|---|
| 全局热键 → 录音 → 文本注入 active 输入框 | `apps/packages/app/src/plugins/` 新增一个 plugin，结合 `hotkeys-js 3.13` 在 Electron 主进程注册全局快捷键；走 Pinia store；用 `clipboard 2.0.4` 或 Capacitor `clipboard` 写回 | 中 | 已有 `hotkeys-js` 和 `clipboard` 依赖 |
| Vault / Wise / Files 等内嵌"按住说话" UI 按钮 | 在对应 entry 的 `pages/` / `components/` 内加 Vue 组件，调浏览器 `MediaRecorder` 或 Capacitor 自研插件 | 中 | 14 个 entry 复用一份代码，可在 `components/` 共享 |
| WebSocket 实时流式 ASR | `src/websocket/` 已有 WS 基础设施，可直接复用 | 低 | 已有 `vue-native-websocket-vue3` 和 `reconnecting-websocket` |
| 调用 Olares 集群内 ASR 服务 | 走 `headscale/` 提供的 VPN 通道访问 `{route-ID}.shared.olares.com`（即 Olares 共享入口） | 低 | 已有 Headscale 客户端 |
| 移动端原生音频采集 | 需要新增一个 **自研 Capacitor 插件**（Swift + Kotlin），或选用社区插件 `capacitor-voice-recorder`、`@capacitor-community/speech-recognition` | 中‑高 | 当前未引入任何语音相关 Capacitor 插件 |
| Desktop（Electron）端本地 Whisper 推理 | 可走 `node-gyp-build`（已有）和 `ffi-rs`（已有）→ 加载 `whisper.cpp` so/dll；或起一个 sidecar 进程 | 高 | 已有 ffi-rs 和 sudo-prompt（需要 Accessibility 权限） |

### 3.2 服务端可挂接位置（仅作 P‑A/P‑B 共享后端的候选）

`@didvault/server` 是 LarePass 自家的后端，不太适合塞 ASR（依赖 LevelDB/Postgres、面向账户与文件）。更合理的做法是 ASR 后端独立部署在 Olares 集群内，LarePass 客户端走 sharedEntrances 调用。`[推测]`

### 3.3 Olares 平台层接口（命题 A 的落地点）

| 入口类型 | 用法 | 说明 |
|---|---|---|
| `entrances:` | HTTP 端口 + `authLevel: private/public/internal` | 适合给"浏览器 / 桌面 / 移动端用户"直接访问的 ASR 单体 |
| `sharedEntrances:` (v0.11+) | 集群内 `{route-ID}.shared.olares.com` | 适合 headless 服务（funasr-server / Speaches / faster-whisper-server / sherpa-onnx-server），由 重点 / 横向对比项目 端到端语音输入产品通过自定义 baseURL 调用 |
| `provider:` + `permission.provider:` (v0.10+) | App→App RPC，envoy sidecar 注入 | 适合"语音输入 ASR 服务"被其它 Olares 应用（如 Wise/Files 自身的笔记功能）程序化调用 |

---

## 四、对集成路径 P‑A / P‑B / P‑C / P‑D 的影响

| 路径 | 关键事实变化（基于源码） | 修订后的难度评估 |
|---|---|---|
| **P‑A（移植到 Olares）** | 与 LarePass 客户端正交，仅依赖 Olares Helm + `OlaresManifest`。重点 / 横向对比项目 中已有 OpenAI 兼容服务端的项目（Speaches / WhisperLiveKit / whisperX‑FastAPI）可"零改造打 chart"；其余需要先抽出 server | **低‑中**（与 LarePass 客户端无关，工程量在 Olares 一侧） |
| **P‑B（原生集成 LarePass 客户端）** | 必须在 **Vue 3 + Quasar 2 + Capacitor 7 + Electron 39 + Pinia + Vue i18n + 14 entry** 这一栈上落地。客户端目前无任何语音相关代码，需新增组件、Pinia store、plugin、Capacitor 原生插件（Swift+Kotlin）、Electron 主进程逻辑、i18n 词条。PR 到 AGPL/GPL‑3 主仓 | **中‑高**（栈成熟但表面积大；14 entry 要决定挂哪个；移动端原生插件是硬骨头） |
| **P‑C（第三方桌面客户端 LarePass‑aware）** | 只需让 Type4Me / Handy / VoiceInk 这类客户端在"自定义 endpoint"配置里识别 LarePass VPN 状态并自动填充集群内 ASR 地址。Headscale 客户端是公开协议（Tailscale 兼容），第三方可自行集成 | **低**（不需要 LarePass 改一行代码） |
| **P‑D（Android IME 与 LarePass 共生）** | LarePass 移动端是 Capacitor 7 单 APK，不是 IME；要做"兄弟 IME"，可参考 WhisperIME / Kaiboard / VoxPen / Sayboard 的形态。共享 LarePass 同一身份的最自然做法是 Android 的 Intent / ContentProvider / Account Manager，但 LarePass 目前未公开此类 SDK | **高**（需要 LarePass 先暴露 SDK，否则只能"独立 IME + 用户重新登录"） |

---

## 五、已知盲点

1. **`platform/` 子目录的真实内容**未读，只能根据命名推断"Web / Electron / Capacitor 三栈适配层"——`[推测]`。若有显式的 `MicrophoneProvider` / `AudioCaptureProvider` 抽象，会大幅简化集成。
2. **`apps/packages/admin`、`mockbfl`、`sdk`、`core` 四个子包未深入**。本次仅确认其存在与命名（来自 `apps/package.json` 的 npm scripts 引用），未读 `package.json`。如后续 P‑A/P‑B 设计需要，可再补一轮。
3. **`apps/docker/`** 子目录未读，估计是 LarePass 后端（`@didvault/server`）的 Dockerfile / docker-compose，与桌面/移动客户端无关。
4. **Electron 主进程入口文件**未读（`apps/packages/app/` 里有 `electron-builder` 和 `update-electron-app` 但未看到 `electron/main.js`），需到 `apps/packages/app/build/` 或 `quasar.config.js` 里找。
5. **Capacitor 原生工程**（iOS Xcode project / Android Gradle project）应该在 `apps/packages/app/` 下的 `ios/` 和 `android/` 子目录（Capacitor 默认结构），未在本次 src 列表中显示——可能是因为它们在 `.gitignore` 或在 build 阶段才生成。
6. **LarePass 桌面客户端在 macOS / Windows / Linux 的麦克风权限申请**：理论上要在 `Info.plist`（NSMicrophoneUsageDescription）/ Windows 的 capability 声明 / Linux 的 PortalAPI 里加；当前未读到。
7. **LarePass 客户端是否已支持 Olares 上"调用其它应用"**（即作为 Service Provider 协议的"消费方"）需读 `apps/packages/app/src/api/` 和 `apps/packages/sdk` 才能确认。`[推测]` 应该已支持，因为客户端需要调 Files/Wise 等服务。

---

## 六、本节为后续 step 准备的"证据清单"

后续撰写 `06_集成LarePass可行性.md` 时可直接引用以下文件位置：

```
apps/lerna.json                                # 单仓库结构
apps/package.json                              # 顶层工具链 + 14 个 build script
apps/README.md                                 # 14 个 app 名单 + dev 端口表
apps/packages/app/package.json                 # 客户端全部 200+ 依赖
apps/packages/app/README.md                    # Quasar 项目模板说明
apps/packages/app/quasar.config.js             # Quasar 配置（本次未拉到内容，下次需补）
apps/packages/app/src/                         # 顶层目录结构
apps/packages/server/package.json              # 后端依赖
docs.olares.com/developer/develop/package/manifest.html  # OlaresManifest v0.11
docs.olares.com/manual/larepass/               # LarePass 用户视角文档
docs.olares.com/developer/concepts/architecture.html      # BEC 架构
```

---

## 七、本节结论（一句话）

> LarePass 客户端是基于 **Quasar 2 + Vue 3 + Capacitor 7 + Electron 39 + TypeScript + Lerna 单仓库** 的"14 entry 多形态"巨型工程，**当前完全没有任何语音输入相关代码**，集成需要在 Vue 3 + Capacitor 原生插件 + Electron 主进程三个层面同时铺路；而"移植到 Olares 部署 ASR 服务"则与 LarePass 客户端正交，只在 Olares Helm + `OlaresManifest` 一侧落地。两件事的工程边界是清晰可分的。
