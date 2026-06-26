# audiolabxv3 交接文档(给新对话的"我"接续用)

> 用途:在**新开的 Cursor 对话**里,先读这份文档接上下文。目标是**用 olares-cli + olares-skills 从零做一个音频基座 app `audiolabxv3`**,借此检验这套工具链能做到什么程度。
> 上一轮完整记录在 agent-transcripts 里;本文件是浓缩状态。

---

## 0. 一句话现状(更新于 2026-06-23 晚)

**M1(会议转录)已完全收尾 —— 引擎级 + Gateway 数据面全线打通。** 在 STT/VAD/Diar 之上,把 `translate`(文本机翻 NLLB,复用 whisper 镜像)、`word_timestamps`(stt 原生,零开发)、`embed`(说话人 512 维向量,复用 pyannote 镜像)、`enhance`(降噪,复用 pyannote 镜像 + SpeechBrain)四项跑通;三项新能力**全部零新镜像**(wrapper 注入 + 按需 pip 装依赖)。随后给 gateway 补了这三类的数据面、出 `v2.0.6-test5` 镜像,经网关端到端验证全部 `200`(详见 §8.5)。M1 七项能力(stt·vad·diar·translate·word_timestamps·embed·enhance)引擎 ✅ + Gateway ✅。详见 `audiolabxv3-docs/_internal/WORK_LOG_2026-06-23.md`、`WORK_LOG_2026-06-24.md` 与 `audiolabxv3-ROADMAP.md`。

**多引擎(2026-06-24):** STT 增加第二套官方引擎 `MODEL_ENGINE=qwen3-asr`(Qwen3-ASR-1.7B,**复用** vLLM 官方镜像 `beclab/vllm-vllm-openai:v0.23.0-cu129`,`vllm serve` 原生 `/v1/audio/transcriptions`)。实例 `audiolabxv3ad5667`(`53b75222...`),引擎级 + 网关 `mode=stt` provider 端到端 `200`。这验证了"一 mode 多引擎"(`MODEL_MODE` 定能力、`MODEL_ENGINE` 选引擎)架构。详见 §9。**下一步:M2 流式 ASR(stt_stream,需 WebSocket 透传)。**

---

## 0'. 上一句话现状(2026-06-23 下午:STT/VAD/Diar + Gateway)

**`audiolabxv3` 基座已从零做完、收敛为单 public 入口并端到端跑通;并已通过改造后的 LLM Gateway(`v2.0.6-test4`)把 STT/VAD/Diar 三能力全部接入、经网关数据面验证通过。**(2026-06-23 由 `audiolabx` 改名为 `audiolabxv3`,统一 v3 命名约定。)chart 在 `~/beclab/app-zips/audiolabxv3/`;版本**锁 `1.0.0`**(不许擅自升号),`audiolabxv3-1.0.0.tgz` 已 upload。clone 速查:`audiolabxv3-CLONE.md`。

当前三实例(单入口,全验证通过):STT `audiolabxv34b08b8`(`d9635122...`)、VAD `audiolabxv3aa0460`(`eba7446b...`)、Diar `audiolabxv34c7e4e`(`2803f5ae...`)。

**LLM Gateway 接入(2026-06-23,已打通,详见 §8):** 给 gateway 后端补了音频数据面(`/v1/audio/{transcriptions,vad,diarization}`),打镜像 `lovehunter9/llm-gateway-backend:v2.0.6-test4`(amd64,已推 Docker Hub),集群部署后手动把三实例注册成 `openai_compatible` provider+model,网关数据面三条全部 `200`。

**今天的关键改动:**
1. **单入口合流**:新增 `templates/ingress.yaml`(openresty 反代,命名仿 opencode/speaches:文件 `ingress.yaml`、Deployment/Service 叫 `audiolabxv3ingress`、ConfigMap `nginx-config`、镜像 `beclab/aboveos-bitnami-openresty:1.25.3-2`、探针 `startupProbe/livenessProbe tcpSocket`)。一个 public 入口分流:`/v1/*` → 官方音频引擎,`/`(含 `/readyz`、`/api/model-spec`、dashboard)→ llm-init。**llm-init 保持 download-only,未改;引擎未改。**
2. **`/v1/models` 500 修复**:faster-whisper-server 的 `/v1/models` 是去 HF 远端目录查 catalog(内网 mirror 401),没有离线"列已加载模型"接口。改为在 ingress 渲染期用 `MODEL_NAME` 合成标准 OpenAI 响应:精确匹配 `location = /v1/models` 直接 `return 200`,优先级高于 `location /v1/`,不影响 `/v1/audio/*` 透传。对 STT/VAD/Diar 全模式统一可用。

**已验证(全走 public 单入口):** `GET /v1/models` → 200 OpenAI 形状;`POST /v1/audio/transcriptions`(jfk.wav)→ 200 正确转写;`GET /readyz` → `status:ready`;`GET /api/model-spec` → 200。

**进度更新(2026-06-23 上午):** VAD / Diar 已 clone 并走单入口验证通过 ——
- VAD `audiolabxc89438`(`7fc70673...`):`/v1/audio/vad` → 11s 全程语音 1 段。
- Diar `audiolabx07b185`(`06f03ae1...`):`/v1/audio/diarization` → 2 说话人/13 段/`device:cuda`(HF 门禁已通)。
- 三能力的 `/v1/models`(ingress 合成)/`/readyz`/`/api/model-spec` 均正常。**STT/VAD/Diar 全部端到端跑通。**

**下一步:** LLM Gateway 接入已打通(§8);剩 Diar 的 ARM64+GPU 多架构镜像(见 §7),以及把 gateway 改动从 `v2.0.6-test4` 测试镜像收敛成正式版/合入主线。

## 1. 算力模型(别再犯晕)

- `olares-cli` + skills 跑在**本地 Mac**,只是**遥控器**;真正的安装/跑 pod/模型下载/GPU 推理**全在那台 Olares 机器(olarestest003)上**。
- 唯一吃本地算力的是 `docker build`(造镜像)——但音频用的镜像(`beclab/*`)**早已造好**,这次**不用 build**。
- `chart from-compose / lint / package` 是本地操作、极轻、无需连机器。

## 2. 已搭好的环境(都验证过)

- **olares-cli(本地源码编译)**:二进制在 `~/beclab/Olares/cli/olares-cli`,已软链到 `/opt/homebrew/bin/olares-cli`(在 PATH)。
  - 编译:`cd ~/beclab/Olares/cli && go build -o olares-cli ./cmd/main.go`。本机 Go 1.23.3,但 `GOTOOLCHAIN=auto` 自动拉了 go1.24.11 编译,不用手动升级 Go。
  - Olares 仓库分支:`fix/files-v0.2.186`(非 main;能编。要最新 cli/skills 可考虑切 main 重编)。
  - 版本显示 `0.0.0-development`(源码编译占位,正常)。
- **登录**:`olares-cli profile login --olares-id olarestest003` 已成功。
  - profile=`olarestest003`,role=**Owner / Cluster Admin / host**,后端版本 **1.12.7-20260614**(≥1.12.6 移植基线 ✓)。token 在 macOS 钥匙串。
  - 验证命令:`olares-cli profile whoami` / `olares-cli profile list`(注意:**没有** `profile current` 子命令)。
- **skills(9 个,本地仓库版)**:已 `npx skills add "$(pwd)/skills" --skill '*' -a cursor -g -y` 装到 `~/.agents/skills/olares-*`。
  - 新对话里它们会**自动出现在可用技能清单**。
  - **怎么验证我在用 skill**:看我动手前有没有用 Read 工具读 `~/.agents/skills/olares-*/SKILL.md`(这个 Read 调用在对话里可见)。

## 3. 已定的决定

1. **从零(greenfield)**重做,不复用旧 chart——目的是检验 cli+skill。
2. 应用名 **`audiolabx`**(合法:`^[a-z][a-z0-9]{0,29}$`)。`metadata.name` / 文件夹名 / `Chart.yaml` name / `metadata.appid` 必须一致。
3. 能力范围:**STT + VAD + Diarize 三个都做**。但基座 chart 是**能力无关**的——能力只由 **clone 时的 env** 决定,所以先把基座做出来即可。
4. chart 放在工作区 `~/beclab/app-zips/audiolabxv3/`。

## 4. 架构事实(忠实参考旧的 audiolabwv3,已读其模板)

两容器模式 = **llm-init 下载器(download-only)+ 音频引擎**:

- **llm-init(download-only)**:镜像 `docker.io/beclab/llm-init:v1.2.4`,`ENGINE_KIND=""`(纯下载),端口 8090,`/readyz`。把 `MODEL_SOURCE` 下到**共享 HF 缓存** `appCommon/huggingface`(挂 `/cache/hf/hub`)。Service 名 `download-svc`。
  - 这正是 `olares-chart` 的 `llm-models.md` §8 官方点名给 **TTS/ASR/音频** 用的 download-only 模式。
- **audio-engine**:端口 8000;镜像**按 MODEL_MODE 选**(2026-06-25 收敛为 **2 个镜像**,弃用 faster-whisper,详见 `audiolabxv3-docs/_internal/WORK_LOG_2026-06-25.md`):
  - `stt`(Whisper 默认 + `MODEL_ENGINE=qwen3-asr`)→ `docker.io/beclab/vllm-vllm-openai:v0.23.0-cu129`(`vllm serve`,原生 `/v1/audio/transcriptions`)。
  - `vad` / `diar` / `translate` / `embed` / `enhance` → `docker.io/beclab/maximsachs-pyannote_fastapi:4.0.4`(仅 amd64+GPU)。
  - 非 stt 能力**复用 pyannote 镜像 + 命令覆盖**跑 wrapper 脚本(`/wrappers/{vad,diar,translate,embed,enhance}.py`,来自 ConfigMap `audio-wrappers`;首次加载按需 pip 补依赖)。
  - ⚠️ 旧 `fedirz-faster-whisper-server:0.6.0-rc.3-cuda`(ctranslate2/CUDA 12.6)在 Blackwell sm_120 上吃不到 GPU(静默退 CPU),已彻底弃用,Whisper 改到 vLLM。
  - initContainer `wait-models` 阻塞直到 `download-svc:8090/readyz` 通,再启引擎。
  - 引擎从共享 HF 缓存读模型(`HF_HUB_CACHE=/cache/hf/hub`)。
  - Service `audio-engine:8000`(内部)。
- **audiolabxv3ingress(单入口反代,2026-06-22 新增)**:openresty,Deployment/Service 名 `audiolabxv3ingress`,监听 8080,是**唯一 public 入口**。配置在 ConfigMap `nginx-config`。分流:`location = /v1/models` → 渲染期合成 OpenAI 响应;`location /v1/` → `audio-engine:8000`;`location /` → `download-svc:8090`(llm-init 控制面/dashboard)。
- **端点**:`POST /v1/audio/transcriptions`(STT)、`/v1/audio/vad`(VAD)、`/v1/audio/diarization`(Diarize)。引擎内网址 `http://audio-engine.<ns>:8000`;对外统一走 `audiolabxv3ingress:8080`。

### clone 时 4 个 env(其余默认)
| 能力 | MODEL_SOURCE | MODEL_NAME | MODEL_MODE | AUDIO_REQUIRED_GPU_MEMORY |
|---|---|---|---|---|
| STT(Whisper,默认) | `hf://openai/whisper-large-v3` | `openai/whisper-large-v3` | `stt` | `8Gi` |
| STT(Qwen3-ASR) | `hf://Qwen/Qwen3-ASR-1.7B` | `Qwen/Qwen3-ASR-1.7B` | `stt`(+`MODEL_ENGINE=qwen3-asr`) | `12Gi` |
| VAD | `hf://onnx-community/silero-vad` | `silero-v5` | `vad` | `0`(纯CPU) |
| Diarize | `hf://pyannote/speaker-diarization-community-1` | `pyannote-community-1` | `diar` | `4Gi` |

> Diarize 门禁(必须先做,否则 llm-init 下载 401、卡 `wait-models`):① Olares 账号设置→Hugging Face 填 read token(自动注入 HF_TOKEN);② 浏览器同意 `huggingface.co/pyannote/speaker-diarization-community-1` 条款。

## 5. 已完成

### 5.1 基座(2026-06-22 上午/下午)
1. `audiolabx/docker-compose.yml` → `chart from-compose --new-schema` → refine(`engine.yaml`/`llm-init.yaml`/`wrappers.yaml`)。
2. `chart lint` OK → `chart package` → `market upload`。
3. STT/VAD/Diar 三个 clone 均 `running`,健康检查通过。

### 5.2 单入口 + /v1/models(2026-06-22 晚)
1. 删掉自起名的 `clientproxy.yaml`/`router.yaml`,按 opencode/speaches 惯例新建 `templates/ingress.yaml`(`audiolabxv3ingress` + `nginx-config` + openresty)。
2. 入口收敛为**一个 public 入口**(`OlaresManifest.yaml` entrances 只剩 `audiolabx` → host `audiolabxv3ingress`:8080,authLevel public);`workloadReplicas`/`values.yaml` 加 `audiolabxv3ingress`。
3. `/v1/models` 500 修复:ingress 渲染期合成 OpenAI 响应(见 §0)。
4. 全链路验证通过(见 §0)。
5. 误升过一次 1.0.1,已 `market delete --version 1.0.1`,**版本锁回 1.0.0**。

**坑/经验:**
- **版本号锁 1.0.0**,未经允许不要升号。同版本重传需先 `market delete audiolabx --version 1.0.0` 再 `upload`。
- **单 entrance** clone **不需要** `--entrance-title`(旧多入口才需要,已废弃)。
- `olares-cli cluster pod` **没有 exec 子命令**;验证用 public URL 直接 curl(入口 public 时)。
- faster-whisper-server 的 `/v1/models`、`/v1/models/{id}` 都查 HF 远端,内网必 500;别想着代理到它,要在 ingress 合成。

**下一步:** 见 §7 —— LLM Gateway 对接受平台/网关侧两处阻断,音频暂走 public 单入口直连。

## 6. 参考文件 / 已读资料

- 旧 chart(忠实参考,**不直接复用**):`~/beclab/app-zips/audiolabwv3/`(`templates/engine.yaml`、`llm-init.yaml`、`wrappers.yaml`、`OlaresManifest.yaml`)。
- clone 参数 + 验证脚本:`~/beclab/app-zips/audiolabwv3-CLONE.md`。
- 已读 skill:`olares-shared / market / cluster / chart / settings` 的 SKILL.md;`olares-chart` 的 `archetypes.md`、`compose.md`、`llm-models.md`。
- 官方 ports 参考库:`github.com/beclab/apps`(`gh search code --repo beclab/apps <keyword>`)。

## 7. 遗留/坑

- **LLM Gateway 自动同步仍未实现(平台侧,非本 app):** gateway 后端 `olares_provider_sync` 每 30s 打 `{market_url}/app-store/api/v2/llm-providers`(`market_url=http://appstore-svc.os-framework:81`),本环境真实 Market **未实现该 ADR-29 端点 → 持续 404**(自 gateway 安装起从未成功)。源码注释明说"the real Olares Market **once it implements the ADR-29 contract**"。**影响**:provider 无法自动发现,只能**手动注册**(已用 §8 的 DevTools 脚本绕过)。证据:`llm-gateway/backend/internal/providers/olares_sync.go`、`internal/olares/market_client.go`。
- **gateway 改动目前是测试镜像 `v2.0.6-test4`,未合主线**:音频数据面是在分支 `feat/market-real-llm-gateway-supported` 上加的(本地两个 commit,**未 push**)。要正式化需:push/PR、出正式 tag、把 `llmgatewayv3` 的 image 收敛到正式版。
- **ARM64+GPU 的 Diarize**:现 pyannote 镜像仅 amd64,DGX Spark(GB10/ARM64)跑不了;多架构 CPU 起点在旧仓库 `voice-engine-pyannote/`。先按 amd64 推进。
- 磁盘:本地 `~` 只剩 ~16Gi(97% 满),注意别让本地缓存撑爆。

## 8. LLM Gateway 接入(2026-06-23 打通)

**思路:** 之前判断"gateway 没有音频路由、音频不该走 gateway"——已通过**给 gateway 补音频数据面**解决。gateway 仍是 OpenAI 兼容抽象,只是把 audio surface 也纳入。

### 8.1 代码改动(repo `~/beclab/llm-gateway`,分支 `feat/market-real-llm-gateway-supported`,未 push)
- `1a7572b`:保存在途改动(迁移改号 `000018→000019`、`backend.Dockerfile` 跨平台构建修复、lldap `go.sum`)。
- `e396226`:**音频数据面**。把适配器音频方法从 `AudioTranscriptions` 泛化为单个 `AudioPassthrough(ctx, op, contentType, rawBody)`,转发 multipart 到上游 `/audio/<op>`(op=`transcriptions|vad|diarization|...`,以后加音频 op 不用再动接口)。
  - `api/v1/router.go`:新增 `POST /v1/audio/vad`、`POST /v1/audio/diarization`(原有 `/v1/audio/transcriptions` 保留)。
  - `api/v1/audio.go`:三个 handler 共用一个 `audioPassthroughHandler` 核心(dispatch→mode 校验→quota→转发→spend)。
  - `spend`:新增 spend mode `vad`/`diar`;DB `mode` CHECK 由迁移 000019 放开,provider_models 可存 mode=vad/diar。
  - `openai_compatible` adapter 转发 `/audio/<op>`;anthropic/azure/gemini 返回 `ErrAudioUnsupported`。build/vet/test 全绿。

### 8.2 镜像
- `lovehunter9/llm-gateway-backend:v2.0.6-test4`(arch=amd64),已推 Docker Hub。
- 构建要点:`docker build --platform linux/amd64`(Dockerfile builder 跑在 `$BUILDPLATFORM` 原生、Go 交叉编译到 amd64;runtime 层跟随 `TARGETPLATFORM`,故必须带 `--platform linux/amd64` 才得到 amd64 镜像)。
- 集群把 `llmgatewayv3` backend 切到此镜像并重启后,vad/diar 路由与 mode 才生效。

### 8.3 手动注册三实例(自动同步 404,只能手动)
gateway 入口 `llmgatewayv3-frontend` 是 `authLevel: internal`(SSO),`olares-cli cluster` 又**没有 exec**,所以**在已登录的浏览器 DevTools 里同源操作**最干净:
1. 建 provider:`POST /console/api/providers`,body `{name, provider_type:"openai_compatible", base_url:"https://<实例>/v1", credentials:{api_key:"sk-noauth"}}`(manual 路径四字段必填,credentials 必须是 JSON 对象)。
2. 给 provider 挂 model:`POST /console/api/providers/:id/customizable-models`,body `{name:"<MODEL_NAME>", mode:"stt|vad|diar"}`。

注册结果(全 `200`):
| 能力 | provider | base_url | model | mode |
|---|---|---|---|---|
| STT | stt-audiolabxv3 | `https://da6625d5.olarestest003.olares.com/v1`(2026-06-25 重 clone,whisper→vLLM,id→`audiolabxv39667b8`;热 2.4s/11s) | `openai/whisper-large-v3` | stt |
| VAD | vad-audiolabxv3 | `https://eba7446b.olarestest003.olares.com/v1` | `silero-v5` | vad |
| Diar | diar-audiolabxv3 | `https://2803f5ae.olarestest003.olares.com/v1` | `pyannote-community-1` | diar |

### 8.4 验证(经 gateway 数据面,全 200)
入口是 internal SSO,外部 curl 会被 303 弹去登录;**在浏览器 DevTools 同源 fetch**(带 SSO cookie 过入口 + `Authorization: Bearer <gateway-key>` 过网关鉴权)即可。样本 jfk.wav:
- `POST /v1/audio/transcriptions`(model=openai/whisper-large-v3 或 Qwen/Qwen3-ASR-1.7B)→ 200,正确转写。
- `POST /v1/audio/vad`(model=silero-v5)→ 200,`num_segments:1` `0–11s`。
- `POST /v1/audio/diarization`(model=pyannote-community-1)→ 200,`device:cuda`,SPEAKER_00 / 5 段(jfk 单人)。

链路:**SSO 入口 → 前端 nginx → backend `/v1/audio/*`(Bearer Key)→ openai_compatible adapter → 各 `audiolabxv3` 实例 `/v1/audio/*`**,按 mode 分发到对应 provider。

## 8.5 M1 收尾:translate / embed / enhance 接入 Gateway(2026-06-24,test5 已打通)

**代码(repo `~/beclab/llm-gateway`,分支 `feat/market-real-llm-gateway-supported`,commit `cb6c51a`,未 push):**
- `embed`(mode=embed)/`enhance`(mode=enhance):直接复用现有 multipart `audioPassthroughHandler`。enhance 音频入/音频出——上游 `audio/wav` 的 Content-Type 经 `c.Data` 原样回写,无需特殊处理。新增路由 `POST /v1/audio/embeddings`、`POST /v1/audio/enhance`。
- `translate`(mode=translate):JSON 入/出。`ChatAdapter` 新增 `TextPassthrough(ctx, op, rawBody)`,openai_compatible 把 JSON POST 到 `<base_url>/<op>`(此处 `/translate`);anthropic/azure/gemini 返回 `ErrAudioUnsupported`。新增 `TranslateHandler`(仿 EmbeddingsHandler 的 dispatch),路由 `POST /v1/translate`。
- `spend` 加 `ModeTranslate/ModeEmbed/ModeEnhance` 常量。**无需新迁移**:`provider_models` mode CHECK 在 000019 已含这三种;`spend_logs.mode` 无 enum 约束。build/vet/test 全绿。

**镜像:** `lovehunter9/llm-gateway-backend:v2.0.6-test5`(amd64,已推 Docker Hub)。集群 backend 手动切到此镜像并重启。

**注册三实例(DevTools 同源脚本,自动同步仍 404 只能手动):**
| 能力 | provider | base_url | model | mode |
|---|---|---|---|---|
| Translate | translate-audiolabxv3 | `https://95d80ca6.olarestest003.olares.com/v1` | `nllb-200-distilled-600M` | translate |
| Embed | embed-audiolabxv3 | `https://1cd82f01.olarestest003.olares.com/v1` | `pyannote-embedding` | embed |
| Enhance | enhance-audiolabxv3 | `https://2c7f7a17.olarestest003.olares.com/v1` | `mtl-mimic-voicebank` | enhance |

**验证(经 gateway 数据面,全 200):** `POST /v1/translate`(EN→ZH)→ `你好,世界.`;`POST /v1/audio/embeddings`→ `dim=512`;`POST /v1/audio/enhance`→ `audio/wav` 31788 B。验证音频用浏览器内存合成的 1s/16k sine WAV,无需外部文件。

**遗留:** gateway 改动仍是测试镜像 `v2.0.6-test5`、未 push/未合主线(收敛成正式版见 §7);WebSocket 透传(M2 stt_stream 依赖)尚未做。

## 9. STT 多引擎:Qwen3-ASR / vLLM(2026-06-24,引擎级 + Gateway 全通)

**目标:** 同一 `stt` mode 下支持多个官方引擎,由 chart 的 `MODEL_ENGINE` 选择。Qwen 家族 ASR 作为第二套引擎落地,优先 1.7B(GPU 约束下不上 Qwen2-Audio-7B;Qwen2-Audio 相关代码已从 chart 移除、保留在 git 历史可找回)。

**镜像选择(踩坑记录):**
- 先试 `qwenllm/qwen3-asr` → Olares image-locker 报 `manifest schema unsupported`(单架构 manifest,locker 要多架构 index),**放弃**。
- 改用 vLLM 官方 `vllm/vllm-openai`(多架构 index,locker 兼容,且 v0.23.0 原生支持 Qwen3-ASR)。
- CUDA 版本:默认 `v0.23.0` 是 cu130,集群 5090(Blackwell)/现有 vllm 基座都是 **cu129**,故指定 `v0.23.0-cu129`。
- 镜像不带 `librosa`/`soundfile`,在 `engine.yaml` 的 qwen3-asr 命令里启动时 `pip install -q librosa soundfile || true` 按需补(沿用既有 wrapper 模式)。

**chart 改动(`audiolabxv3/`,版本仍锁 1.0.0):**
- `templates/engine.yaml`:`MODEL_ENGINE=qwen3-asr` 分支 → 镜像 `beclab/vllm-vllm-openai:v0.23.0-cu129`,命令 `export HF_HUB_OFFLINE=1; pip install -q librosa soundfile||true; exec vllm serve $MODEL_NAME --host 0.0.0.0 --port $WRAPPER_PORT --gpu-memory-utilization ${VLLM_GPU_UTIL:-0.45} --max-model-len ${VLLM_MAX_LEN:-32768}`(原 `0.8` 写死会 OOM,详见下「GPU 配额下两道内存关」)。
- `templates/wrappers.yaml`:删掉 `qwen_asr.py`(vLLM 原生 OpenAI 音频接口,无需 wrapper)。
- `OlaresManifest.yaml`:`MODEL_ENGINE` 选项/示例/GPU 需求(qwen3-asr=12Gi)。

**部署/验证:**
1. 镜像 `beclab/vllm-vllm-openai:v0.23.0-cu129` 已 mirror。
2. **同版本 chart 先 `market delete audiolabxv3` 再 `upload`**(否则市场仍校验旧 `MODEL_ENGINE` 枚举,clone 报 `Invalid values: MODEL_ENGINE`)。
3. clone(见 CLONE.md STT 引擎 B):实例 `audiolabxv3ad5667` / NS `audiolabxv3ad5667-shared` / 入口 `https://53b75222.olarestest003.olares.com`。
4. 大权重下载偶遇 HF 网络抖动 → llm-init `degraded` 自愈重建、从缓存续传(无需人工)。
5. 引擎级:`POST /v1/audio/transcriptions`(model=`Qwen/Qwen3-ASR-1.7B`)jfk.wav → 转写正确,`/v1/models` 返回 `mode:stt`。
6. Gateway:DevTools 同源脚本建 provider `audiolabxv3-qwen3asr`(openai_compatible,base_url=入口 `/v1`)+ model(mode=stt)+ 签 api-key,经网关 `POST /v1/audio/transcriptions` → `200` 正确转写。

**GPU 配额下 vLLM 两道内存关(2026-06-25 定位,务必牢记):** HAMI 只给 pod 12Gi 配额,但 vLLM 看到整张 24G 卡。
- **第一关 分配 OOM**:`--gpu-memory-utilization` 是占「物理整卡」比例,写死 0.8≈19G ≫ 12G → 首次推理 OOM 重启。改为按配额动态算 `VLLM_GPU_UTIL`=(gpumem/物理总 ×0.85),12288/24454→**0.43**;`AUDIO_GPU_TOTAL_MIB`(默认 24454)、`MODEL_GPU_MEM_UTIL` 可覆盖。
- **第二关 KV 容量校验**:util=0.43 后权重 3.9G、可用 KV 仅 4.93G,而 Qwen3-ASR 默认 `max_model_len=65536` 单请求需 7G KV → 启动即 `ValueError` CrashLoopBackOff(**非分配 OOM,是启动期断言**)。加 `--max-model-len ${VLLM_MAX_LEN:-32768}`(`MODEL_MAX_LEN` 可覆盖)。两处修好引擎 1/1、0 重启,jfk.wav 直连 public 正确转写。

**GPU 应用不能原地 upgrade:** `nvidia.com/gpu` 由 Olares gpu-inject webhook「安装时」注入(chart 只声明 `nvidia.com/gpumem`+`gpu-inject` 注解)。`market upgrade` 走 patch 不触发注入 → `resources.limits: Limit must be set for non overcommitable resources`。**改 GPU 应用 chart 必须:先删后传 chart → `uninstall` 实例 → 重 `clone`**。clone id 由 `--title` 哈希,同 title 必回同一 id/NS/URL → 网关 provider 无需重建。

**坑/经验补充:**
- 同版本 chart **先删后传**(只 upload 不 delete,clone 仍发旧渲染;已多次踩,务必记住)。
- DevTools 同源脚本拉测试音频用 `cdn.jsdelivr.net/gh/...`(github raw 会 CORS 拦)。
- api-key 明文只在创建时返回一次,重测要重新签发。
