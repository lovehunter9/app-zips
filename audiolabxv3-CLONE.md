# audiolabxv3 — Clone 参数 & 验证速查

> Greenfield 音频基座 `audiolabxv3`。chart 包:`audiolabxv3-1.0.0.tgz`。clone 时用 4 个 env 决定服务能力。

## 一、前置(各能力一次性准备)

| 能力 | 需要 mirror 的镜像 | 模型门禁 |
|---|---|---|
| STT | 无 | 无 |
| VAD | 无(复用 whisper 镜像) | 无 |
| Diarize | `beclab/maximsachs-pyannote_fastapi:4.0.4` | HF token + 网页同意条款 |

Diarize 门禁: Olares 账号设置 → Hugging Face token + 同意 `pyannote/speaker-diarization-community-1` 条款。

## 二、Clone 命令模板

**单入口**(openresty `audiolabxv3ingress` 合流):llm-init 控制面/下载面在 `/`,
官方引擎推理在 `/v1/*`,对外只有一个 public URL。单 entrance 不需 `--entrance-title`。

```bash
olares-cli market clone audiolabxv3 -s upload \
  --title "Audio Lab X V3 STT" \
  --env MODEL_SOURCE=hf://Systran/faster-whisper-large-v3 \
  --env MODEL_NAME=Systran/faster-whisper-large-v3 \
  --env MODEL_MODE=stt \
  --env AUDIO_REQUIRED_GPU_MEMORY=8Gi \
  --watch
```

### STT（引擎 A：faster-whisper，默认）
| Env | 值 |
|---|---|
| `MODEL_SOURCE` | `hf://Systran/faster-whisper-large-v3` |
| `MODEL_NAME` | `Systran/faster-whisper-large-v3` |
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

> 坑：vLLM cu129 镜像 ~10Gi，大权重文件下载偶遇 HF 网络抖动会让 llm-init 标记 `degraded`→自愈重建→从缓存续传（无需人工）。同版本 chart 重传务必**先 `market delete` 再 `upload`**，否则市场仍校验旧 `MODEL_ENGINE` 枚举。

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

## 三、当前实例(单入口版)

| 能力 | clone 名 | NS | 单入口 URL | 验证结果 |
|---|---|---|---|---|
| STT(faster-whisper) | `audiolabxv34b08b8` | `audiolabxv34b08b8-shared` | `https://d9635122.olarestest003.olares.com` | jfk.wav 转写正确 |
| STT(qwen3-asr/vLLM) | `audiolabxv3ad5667` | `audiolabxv3ad5667-shared` | `https://53b75222.olarestest003.olares.com` | jfk.wav 转写正确(2026-06-24) |
| VAD | `audiolabxv3aa0460` | `audiolabxv3aa0460-shared` | `https://eba7446b.olarestest003.olares.com` | 11s 全程语音 1 段 |
| Diar | `audiolabxv34c7e4e` | `audiolabxv34c7e4e-shared` | `https://2803f5ae.olarestest003.olares.com` | 2 说话人/13 段/`device:cuda` |

Pod:`llminit-*`(下载面)、`audiolabxv3*`(官方引擎)、`audiolabxv3ingress-*`(openresty 合流)。

## 四、验证(全部走 public 单入口)

控制面(→ llm-init,download-only):
- `GET /` → 200(dashboard)
- `GET /readyz` → `{"engine":"","model":...,"status":"ready"}`
- `GET /api/model-spec` → `{"name":...,"mode":...}`

推理面(→ 官方引擎 `/v1/*`):
- STT:`POST /v1/audio/transcriptions`(file/model/language)→ `{"text": ...}` ✅ 已验(jfk.wav 正确转写)
- VAD:`POST /v1/audio/vad`
- Diarize:`POST /v1/audio/diarization`

> `GET /v1/models` 返回 500 是 faster-whisper-server 自身去查 HF 目录(401)的固有行为,非分流问题;引擎 `/health` 为 200。

示例(STT,公网):
```bash
U=https://64fa903d.olarestest003.olares.com
curl -sk -X POST "$U/v1/audio/transcriptions" \
  -F "file=@jfk.wav;type=audio/wav" \
  -F "model=Systran/faster-whisper-large-v3" -F "language=en"
```

引擎集群内地址:`http://audio-engine.<NS>.svc.cluster.local:8000`;合流入口:`audiolabxv3ingress:8080`。

## 五、经 LLM Gateway 消费(2026-06-23 已打通)

需 gateway 后端 ≥ `lovehunter9/llm-gateway-backend:v2.0.6-test5`(补了全部音频数据面)。手动把各实例注册成 `openai_compatible` provider+model(base_url=各实例 `/v1`,mode 对应),再用 gateway API Key 调:
- `POST <gateway>/v1/audio/transcriptions`(model=`Systran/faster-whisper-large-v3` 或 `Qwen/Qwen3-ASR-1.7B`)
- `POST <gateway>/v1/audio/vad`(model=`silero-v5`)
- `POST <gateway>/v1/audio/diarization`(model=`pyannote-community-1`)
- `POST <gateway>/v1/translate`、`/v1/audio/embeddings`、`/v1/audio/enhance`(translate/embed/enhance)

Qwen3-ASR 注册(2026-06-24,全 `200`):provider `audiolabxv3-qwen3asr`(openai_compatible,base_url=`https://53b75222.olarestest003.olares.com/v1`)+ model `Qwen/Qwen3-ASR-1.7B`(mode=stt);经网关 `POST /v1/audio/transcriptions` jfk.wav → 转写正确。

入口是 internal SSO,外部 curl 会 303;注册+验证走**浏览器 DevTools 同源 `fetch`**(同源自动带 SSO cookie 过入口 + `Authorization: Bearer <key>` 过网关鉴权)。注意 console API 需在已登录 gateway 控制台页执行;拉测试音频用 CORS 友好的 `https://cdn.jsdelivr.net/gh/ggerganov/whisper.cpp@master/samples/jfk.wav`(github raw 会被 CORS 拦)。完整记录见 `audiolabxv3-HANDOFF.md` §8。
