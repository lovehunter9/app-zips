# audiolabxv3 — Clone 参数 & 验证速查

> Greenfield 音频基座 `audiolabxv3`。chart 包:`audiolabxv3-1.0.0.tgz`。clone 时用 4 个 env 决定服务能力。

## 一、前置(各能力一次性准备)

> **整座基座只用 2 个引擎镜像**(2026-06-25 收敛):
> - `beclab/vllm-vllm-openai:v0.23.0-cu129` —— 所有 **stt**(Whisper / Qwen3-ASR)。
> - `beclab/maximsachs-pyannote_fastapi:4.0.4` —— **vad / diar / translate / embed / enhance**(wrapper 脚本,首次加载按需 pip 补依赖)。
> 原 `fedirz-faster-whisper-server`(ctranslate2/CUDA 12.6)已**彻底弃用**:在 Blackwell(RTX 5090,sm_120)上 cuBLAS 无 sm_120 kernel,float16 静默退回 CPU(0% GPU util),所以 Whisper 改到与 Qwen3-ASR 同一套 vLLM 引擎上跑。

| 能力 | 引擎镜像 | 模型门禁 |
|---|---|---|
| STT(Whisper / Qwen3-ASR) | `beclab/vllm-vllm-openai:v0.23.0-cu129` | 无 |
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

## 三、当前实例台账(单入口版)

> **重要:实例 public URL 用 `olares-cli` 查不到**(`settings apps entrances list` 的 `url` 字段恒为空),只能问用户/查本表。**别再空搜**。详见 skill `.cursor/skills/audiolabxv3-instances/`。
>
> **title 是 hash 的关键输入**:重 clone 时 title 一变 hash/URL 就变(实测 VAD 用 `Audio Lab X VAD` 而非原 `Audio Lab X V3 VAD`,得到新 id `06a333`/新 URL)。重建务必照抄下表 **title** 那一列。

| 能力 | title(照抄) | clone 名 | NS | public URL |
|---|---|---|---|---|
| STT(Whisper/vLLM) | `Audio Lab X V3 STT` | `audiolabxv39667b8` | `audiolabxv39667b8-shared` | `https://da6625d5.olarestest003.olares.com` |
| STT(qwen3-asr/vLLM) | `Audio Lab X V3 Qwen3-ASR` | `audiolabxv3ad5667` | `audiolabxv3ad5667-shared` | `https://53b75222.olarestest003.olares.com` |
| VAD | `Audio Lab X VAD` | `audiolabxv306a333` | `audiolabxv306a333-shared` | `https://694295f9.olarestest003.olares.com` |
| Diar | `Audio Lab X V3 Diar` | `audiolabxv34c7e4e` | `audiolabxv34c7e4e-shared` | `https://2803f5ae.olarestest003.olares.com` |
| Translate | `Audio Lab X V3 Translate` | `audiolabxv38ab6b2` | `audiolabxv38ab6b2-shared` | `https://95d80ca6.olarestest003.olares.com` |
| Embed | `Audio Lab X V3 Embed` | `audiolabxv35db0f3` | `audiolabxv35db0f3-shared` | `https://1cd82f01.olarestest003.olares.com` |
| Enhance | `AudioLabX Enhance` | `audiolabxv31c4d10` | `audiolabxv31c4d10-shared` | `https://2c7f7a17.olarestest003.olares.com` |

> 2026-06-26:VAD 由 `aa0460`(旧 URL `https://eba7446b...`)删除重建为 `06a333`(VAD 引擎 silero 参数调优:threshold 0.3 / min_silence 500ms / speech_pad 200ms,form 可覆盖)。**Gateway VAD provider 需手动改指向新 URL。**

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
