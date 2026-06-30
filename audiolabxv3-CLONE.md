# audiolabxv3 — Clone 参数 & 验证速查

> Greenfield 音频基座 `audiolabxv3`。chart 包:`audiolabxv3-1.0.0.tgz`。clone 时用 4 个 env 决定服务能力。

## 一、前置(各能力一次性准备)

> **引擎镜像(2026-06-26)**:
> - `beclab/vllm-vllm-openai:v0.23.0-cu129` —— **stt** vLLM 引擎(Whisper / Qwen3-ASR)。
> - `beclab/harveyff-whisper-webui:v1.0.7` —— **stt** `faster-whisper` 引擎(`MODEL_ENGINE=faster-whisper`,见引擎 C)。
> - `beclab/maximsachs-pyannote_fastapi:4.0.4` —— **vad / diar / translate / embed / enhance**(wrapper 脚本,首次加载按需 pip 补依赖)。
>
> 关于 STT 引擎选择(2026-06-26 关键结论):**vLLM 的 Whisper/Qwen3-ASR 是自回归**(每 token 一次 CUDA sync),在 olares **时分 vGPU** 的中心锁下被节流约 **10x**(实测 4 分钟音频:时分 79s+ vs 独占 8s)。`faster-whisper`(ctranslate2)每秒 CUDA 调用极少,**在时分下依然快**(harveyff Whisper-WebUI 同卡同 HAMI 实测"起飞")。故 Whisper 默认建议走引擎 C(`faster-whisper`)。原 `fedirz-faster-whisper-server`(CUDA 12.6,无 sm_120 kernel,float16 静默退回 CPU)已弃用;harveyff 镜像里的 ctranslate2 是 **Blackwell 编译可用** 的那一份,wrapper 只取它的 ct2/faster_whisper,**不跑** 其 Gradio WebUI。

| 能力 | 引擎镜像 | 模型门禁 |
|---|---|---|
| STT(Whisper / Qwen3-ASR,vLLM) | `beclab/vllm-vllm-openai:v0.23.0-cu129` | 无 |
| STT(faster-whisper) | `beclab/harveyff-whisper-webui:v1.0.7`(wrapper `/wrappers/stt_fw.py`) | 无 |
| VAD | `beclab/maximsachs-pyannote_fastapi:4.0.4`(wrapper + `silero-vad`) | 无 |
| Translate | `beclab/maximsachs-pyannote_fastapi:4.0.4`(wrapper + CPU ctranslate2/tokenizers) | 无 |
| Diarize / Embed / Enhance | `beclab/maximsachs-pyannote_fastapi:4.0.4` | Diar 需 HF token + 网页同意条款 |

Diarize 门禁: Olares 账号设置 → Hugging Face token + 同意 `pyannote/speaker-diarization-community-1` 条款。

## 二、Clone 命令模板

**单入口**(openresty `audiolabxv3ingress` 合流):llm-init 控制面/下载面在 `/`,
官方引擎推理在 `/v1/*`,对外只有一个 public URL。单 entrance 不需 `--entrance-title`。

```bash
olares-cli market clone audiolabxv3 -s upload \
  --title "Audio Lab X V3 STT" \
  --env MODEL_SOURCE=hf://openai/whisper-large-v3 \
  --env MODEL_NAME=openai/whisper-large-v3 \
  --env MODEL_MODE=stt \
  --env AUDIO_REQUIRED_GPU_MEMORY=8Gi \
  --watch
```

### STT（引擎 A：Whisper on vLLM，默认）
> `vllm serve openai/whisper-large-v3`,原生 `/v1/audio/transcriptions`（含 `verbose_json` 段级时间戳）。Whisper 是小窗 encoder-decoder（max_model_len 448），**不要**加 `--max-model-len`，vLLM 会自动设。

| Env | 值 |
|---|---|
| `MODEL_SOURCE` | `hf://openai/whisper-large-v3` |
| `MODEL_NAME` | `openai/whisper-large-v3` |
| `MODEL_MODE` | `stt` |
| `AUDIO_REQUIRED_GPU_MEMORY` | `8Gi` |

### STT（引擎 B：`qwen3-asr` / vLLM）
同 `stt` mode，加 `MODEL_ENGINE=qwen3-asr` 切到 vLLM 官方引擎（镜像 `beclab/vllm-vllm-openai:v0.23.0-cu129`，启动按需补 librosa/soundfile，原生 `/v1/audio/transcriptions`）。

| Env | 值 |
|---|---|
| `MODEL_SOURCE` | `hf://Qwen/Qwen3-ASR-1.7B` |
| `MODEL_NAME` | `Qwen/Qwen3-ASR-1.7B` |
| `MODEL_MODE` | `stt` |
| `MODEL_ENGINE` | `qwen3-asr` |
| `AUDIO_REQUIRED_GPU_MEMORY` | `12Gi` |

```bash
olares-cli market clone audiolabxv3 -s upload \
  --title "Audio Lab X V3 Qwen3-ASR" \
  --env MODEL_SOURCE=hf://Qwen/Qwen3-ASR-1.7B \
  --env MODEL_NAME=Qwen/Qwen3-ASR-1.7B \
  --env MODEL_MODE=stt \
  --env MODEL_ENGINE=qwen3-asr \
  --env AUDIO_REQUIRED_GPU_MEMORY=12Gi
```

> 坑 1：vLLM cu129 镜像 ~10Gi，大权重文件下载偶遇 HF 网络抖动会让 llm-init 标记 `degraded`→自愈重建→从缓存续传（无需人工）。同版本 chart 重传务必**先 `market delete` 再 `upload`**，否则市场仍发旧 chart（实测：只 `upload` 不 `delete`，clone 出来的 deployment 仍是旧渲染）。
>
> 坑 2（GPU 配额下的 vLLM 两道内存关，2026-06-25 定位）：HAMI 只给 pod 12Gi 配额，但 vLLM 看到的是整张 24G 卡。
> - **第一关 分配 OOM**：`--gpu-memory-utilization` 是占「物理整卡」的比例，写死 0.8 会把 KV 缓存按 24G 算（~19G）→ 首次推理 OOM 重启。chart 已改为按配额动态算 `VLLM_GPU_UTIL`（12Gi/24454×0.85≈**0.43**，env 可用 `MODEL_GPU_MEM_UTIL` 覆盖）。
> - **第二关 KV 容量校验**：util 降到 0.43 后权重占 3.9G、KV 只剩 4.93G，而 Qwen3-ASR 默认 `max_model_len=65536` 单请求要 7G KV → vLLM 启动即 `ValueError` CrashLoop。chart 已加 `--max-model-len ${VLLM_MAX_LEN:-32768}`（ASR 音频分块，32768 足够；env 可用 `MODEL_MAX_LEN` 覆盖）。两处修好后引擎 1/1、`/v1/audio/transcriptions` jfk.wav 正确（2026-06-25）。

### STT（引擎 C：`faster-whisper`，时分下首选）
> ctranslate2/faster_whisper 跑 llm-init 下载的 CT2 权重(`Systran/faster-whisper-large-v3`)。wrapper `/wrappers/stt_fw.py` 复刻 vLLM 同款 OpenAI STT 契约,是 **drop-in**(gateway/Demo 不用改):`POST /v1/audio/transcriptions`、`POST /v1/audio/translations`(语音→英文)、`GET /v1/models`、`GET /health`(readinessProbe 用)。compute_type 默认 `float16`(`FW_COMPUTE_TYPE` 可覆盖);beam_size 默认 5(`FW_BEAM_SIZE`)。

| Env | 值 |
|---|---|
| `MODEL_SOURCE` | `hf://Systran/faster-whisper-large-v3` |
| `MODEL_NAME` | `Systran/faster-whisper-large-v3` |
| `MODEL_MODE` | `stt` |
| `MODEL_ENGINE` | `faster-whisper` |
| `AUDIO_REQUIRED_GPU_MEMORY` | `6Gi` |

```bash
olares-cli market clone audiolabxv3 -s upload \
  --title "Audio Lab X V3 STT" \
  --env MODEL_SOURCE=hf://Systran/faster-whisper-large-v3 \
  --env MODEL_NAME=Systran/faster-whisper-large-v3 \
  --env MODEL_MODE=stt \
  --env MODEL_ENGINE=faster-whisper \
  --env AUDIO_REQUIRED_GPU_MEMORY=6Gi \
  --watch
```
> 复用旧 Whisper STT 的 title `Audio Lab X V3 STT` → hash/URL 不变(仍 `da6625d5`),只是引擎换成 faster-whisper。务必**先 `market delete` 旧实例 + 删市场旧 chart,再 `upload` 新 tgz,再 clone**。

### VAD
| Env | 值 |
|---|---|
| `MODEL_SOURCE` | `hf://onnx-community/silero-vad` |
| `MODEL_NAME` | `silero-v5` |
| `MODEL_MODE` | `vad` |
| `AUDIO_REQUIRED_GPU_MEMORY` | `0` |

### Diarize
| Env | 值 |
|---|---|
| `MODEL_SOURCE` | `hf://pyannote/speaker-diarization-community-1` |
| `MODEL_NAME` | `pyannote-community-1` |
| `MODEL_MODE` | `diar` |
| `AUDIO_REQUIRED_GPU_MEMORY` | `4Gi` |

### Enhance（2026-06-29 起上 GPU）
> `enhance.py` 已做**服务端内部分块**（滑窗逐块 + overlap-add 交叉淡入，`ENHANCE_CHUNK_S` 默认 120s、`ENHANCE_OVERLAP_S` 默认 1s），长音频峰值显存只受单窗约束 → Demo 端不再分块、整段一次调用即可。模型 `mtl-mimic-voicebank` 很小，给 `2Gi` 足够（实测 `loaded as 'waveform' on cuda:0`）。GPU 引擎的 `GPU_CORE_UTILIZATION_POLICY=disable` 由 chart 自动写死，无需传。

| Env | 值 |
|---|---|
| `MODEL_SOURCE` | `hf://speechbrain/mtl-mimic-voicebank` |
| `MODEL_NAME` | `mtl-mimic-voicebank` |
| `MODEL_MODE` | `enhance` |
| `AUDIO_REQUIRED_GPU_MEMORY` | `2Gi`（周五是 CPU `0`；要省卡可改回 `0`） |

> **GPU 配额提醒**：整卡 ~24Gi。当前 GPU 实例 = Qwen 12 + STT-fw 6 + Diar 4 + Enhance 2 = **24Gi 刚好顶满**。再要给别的音频实例上 GPU 得先腾。

## 三、当前实例台账(单入口版)

> **重要:实例 public URL 用 `olares-cli` 查不到**(`settings apps entrances list` 的 `url` 字段恒为空),只能问用户/查本表。**别再空搜**。详见 skill `.cursor/skills/audiolabxv3-instances/`。
>
> **title 是 hash 的关键输入**:重 clone 时 title 一变 hash/URL 就变(实测 VAD 用 `Audio Lab X VAD` 而非原 `Audio Lab X V3 VAD`,得到新 id `06a333`/新 URL)。重建务必照抄下表 **title** 那一列。

| 能力 | title(照抄) | clone 名 | NS | public URL |
|---|---|---|---|---|
| STT(**faster-whisper**) | `Audio Lab X V3 STT` | `audiolabxv3b2b539` | `audiolabxv3b2b539-shared` | **(待用户提供)** |
| STT(qwen3-asr/vLLM) | `Audio Lab X V3 Qwen3-ASR` | `audiolabxv3a0bbb6` | `audiolabxv3a0bbb6-shared` | **(待用户提供)** |
| Diar | `Audio Lab X V3 Diar` | `audiolabxv34c7e4e` | `audiolabxv34c7e4e-shared` | **(待用户提供)** |
| VAD | `Audio Lab X VAD` | `audiolabxv306a333` | `audiolabxv306a333-shared` | **(待用户提供)** |
| Translate | `Audio Lab X V3 Translate` | `audiolabxv38ab6b2` | `audiolabxv38ab6b2-shared` | **(待用户提供)** |
| Embed | `Audio Lab X V3 Embed` | `audiolabxv35db0f3` | `audiolabxv35db0f3-shared` | **(待用户提供)** |
| Enhance | `AudioLabX Enhance` | `audiolabxv3d616f5`（原 `1c4d10`） | `audiolabxv3d616f5-shared` | **(新→待用户提供)** |

> 2026-06-29（translate.py 按句切分，再次全量重建）：`translate.py` 改为整段输入**非AI按句切分 → ctranslate2 批量翻译 → 拼回**（修 NLLB 句子级模型对整段只翻第一句的"截断"问题；接口不变）。按老规矩全量重建一遍——**7 个 title+env 全未变（Enhance 仍 2Gi），7 个 clone 名/URL 全部原样复现，网关零改动**（VAD `06a333`、Translate `8ab6b2`、Embed `5db0f3`、STT `b2b539`、Diar `4c7e4e`、Enhance `d616f5`、Qwen `a0bbb6`）。再次印证：title+env 不变 ⇒ URL 不变。

> 2026-06-29（enhance.py 服务端分块 + Enhance 上 GPU，全量重建）：因改了 `enhance.py`（服务端滑窗分块），按老规矩**卸载全部 7 实例 → 删 chart 1.0.0 → 重传新 tgz → 7 个全部重新 clone（title 照抄）**。**重大发现：title + env 完全一致 ⇒ clone 名/hash 完全复现**——本轮 6 个能力（VAD `06a333`、Translate `8ab6b2`、Embed `5db0f3`、STT `b2b539`、Diar `4c7e4e`、Qwen `a0bbb6`）名字**一字不差地复现**，所以这 6 个的 public URL 不变、网关 provider 无需动；**只有 Enhance 因把 `AUDIO_REQUIRED_GPU_MEMORY` 从 `0` 改成 `2Gi`（env 变了），hash 从 `1c4d10` 变成 `d616f5`** → 仅 Enhance 需要新 URL + 网关重注册。结论修正：以前"同 title 也变 URL"是因为当时连带改了 env/chart 内容；**只要 title 与 env 都不动，URL 就能保持不变**。

> 2026-06-26（周五收尾）：clone 了 Translate(`8ab6b2`)、Embed(`5db0f3`)、Enhance(`1c4d10`)、VAD(`06a333`) 四个（均 `AUDIO_REQUIRED_GPU_MEMORY=0` → CPU）。**7 个实例已全部齐**。VAD 中文歌曲分段质量差，silero 参数留待周一调（调好需先删后 clone，URL 会变）。四个新实例的 base_url 待网关手动注册。Demo 镜像同时升到 `lovehunter9/audiostudioxdemo:1.0.1`（去 MP3 转码保护 + DIAR 整段化）。

> 2026-06-26（chart 改动后重建）：MODEL_ENGINE 改为**按模型名自动选**(不再传 `--env MODEL_ENGINE`)、`GPU_CORE_UTILIZATION_POLICY=disable` 写死(不再传)。删除 `CUDA_DEVICE_SM_LIMIT`/`CUDA_DISABLE_CONTROL`。同版本 chart 删后重传重 clone，**clone 名/URL 又变了**(STT `0b0d85`→`b2b539`、Qwen `2124b8`→`a0bbb6`)→ 网关 provider 的 base_url 需手动更新。新建 DIAR `4c7e4e`(GPU 4Gi，pod 内已确认带 disable)。

> 2026-06-26（重置）:为换 STT 引擎,7 个旧实例全部卸载、chart 1.0.0 删后重传(同版本 upload 不刷新 manifest,实测确认),只先重建 STT。新 STT 走 **faster-whisper**(`MODEL_ENGINE=faster-whisper` + `Systran/faster-whisper-large-v3`,harveyff 镜像,cuda/float16 已确认)。clone 名变为 `0b0d85`(title 没变但 clone 名/URL 仍变了→**URL 用 clone 名 hash,不是 title**),新 URL 待用户提供。STT 速度达标后再逐个重建其余 6 个。

Pod:`llminit-*`(下载面)、`audiolabxv3*`(官方引擎)、`audiolabxv3ingress-*`(openresty 合流)。引擎集群内地址:`http://audio-engine.<NS>:8000`。

## 四、验证(全部走 public 单入口)

控制面(→ llm-init,download-only):
- `GET /` → 200(dashboard)
- `GET /readyz` → `{"engine":"","model":...,"status":"ready"}`
- `GET /api/model-spec` → `{"name":...,"mode":...}`

推理面(→ 官方引擎 `/v1/*`):
- STT:`POST /v1/audio/transcriptions`(file/model/language)→ `{"text": ...}` ✅ 已验(jfk.wav 正确转写)
- VAD:`POST /v1/audio/vad`
- Diarize:`POST /v1/audio/diarization`

> `GET /v1/models` 由 openresty 入口按安装期 `MODEL_NAME` 直接合成 200(`templates/ingress.yaml`),不依赖各引擎自身那条易 401/500 的 HF-目录路由;引擎 `/health` 为 200。

示例(STT,公网):
```bash
U=https://<stt-url>.olarestest003.olares.com
curl -sk -X POST "$U/v1/audio/transcriptions" \
  -F "file=@jfk.wav;type=audio/wav" \
  -F "model=openai/whisper-large-v3" -F "language=en"
```

引擎集群内地址:`http://audio-engine.<NS>.svc.cluster.local:8000`;合流入口:`audiolabxv3ingress:8080`。

## 五、经 LLM Gateway 消费(2026-06-23 已打通)

需 gateway 后端 ≥ `lovehunter9/llm-gateway-backend:v2.0.6-test5`(补了全部音频数据面)。手动把各实例注册成 `openai_compatible` provider+model(base_url=各实例 `/v1`,mode 对应),再用 gateway API Key 调:
- `POST <gateway>/v1/audio/transcriptions`(model=`openai/whisper-large-v3` 或 `Qwen/Qwen3-ASR-1.7B`)
- `POST <gateway>/v1/audio/vad`(model=`silero-v5`)
- `POST <gateway>/v1/audio/diarization`(model=`pyannote-community-1`)
- `POST <gateway>/v1/translate`、`/v1/audio/embeddings`、`/v1/audio/enhance`(translate/embed/enhance)

Qwen3-ASR 注册(2026-06-24,全 `200`):provider `audiolabxv3-qwen3asr`(openai_compatible,base_url=`https://53b75222.olarestest003.olares.com/v1`)+ model `Qwen/Qwen3-ASR-1.7B`(mode=stt);经网关 `POST /v1/audio/transcriptions` jfk.wav → 转写正确。

入口是 internal SSO,外部 curl 会 303;注册+验证走**浏览器 DevTools 同源 `fetch`**(同源自动带 SSO cookie 过入口 + `Authorization: Bearer <key>` 过网关鉴权)。注意 console API 需在已登录 gateway 控制台页执行;拉测试音频用 CORS 友好的 `https://cdn.jsdelivr.net/gh/ggerganov/whisper.cpp@master/samples/jfk.wav`(github raw 会被 CORS 拦)。完整记录见 `audiolabxv3-HANDOFF.md` §8。
