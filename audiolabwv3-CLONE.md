# audiolabwv3 — Clone 参数 & 验证速查

> DEV 临时名 `audiolabwv3`(= Audio Lab Workshop V3 for test)。一个基座,clone 时用 4 个
> env 决定服务哪个音频模型。chart 包:`audiolabwv3-1.0.0.tgz`。

## 一、前置(各能力一次性准备)

| 能力 | 需要 mirror 的镜像 | 模型门禁 |
|---|---|---|
| STT | 无(复用已转 `beclab/fedirz-faster-whisper-server:0.6.0-rc.3-cuda`) | 无 |
| VAD | 无(复用上面的 whisper 镜像) | 无 |
| Diarize | `beclab/maximsachs-pyannote_fastapi:4.0.4`（amd64+GPU；mirror 自 `ghcr.io/maximsachs/pyannote_fastapi:4.0.4`） | **有**:HF 账号配 token + 网页同意条款 |

Diarize 门禁两步(缺一不可):
1. Olares 账号设置 → Hugging Face → 填 read token(自动注入 `HF_TOKEN`)。
2. 浏览器同意 `https://huggingface.co/pyannote/speaker-diarization-community-1` 条款。

> 注意:`AUDIO_REQUIRED_GPU_MEMORY=0` = 纯 CPU(不申请 GPU);非 0(如 `8Gi`/`4Gi`)= 申请该额度 GPU。

## 二、Clone 参数(其余 env 全留默认)

### STT(离线转写,faster-whisper)
| Env | 值 |
|---|---|
| `MODEL_SOURCE` | `hf://Systran/faster-whisper-large-v3` |
| `MODEL_NAME` | `Systran/faster-whisper-large-v3` |
| `MODEL_MODE` | STT |
| `AUDIO_REQUIRED_GPU_MEMORY` | `8Gi` |

### VAD(Silero,纯 CPU,复用 whisper 镜像自带 silero)
| Env | 值 |
|---|---|
| `MODEL_SOURCE` | `hf://onnx-community/silero-vad` |
| `MODEL_NAME` | `silero-v5` |
| `MODEL_MODE` | VAD |
| `AUDIO_REQUIRED_GPU_MEMORY` | `0` |

### Diarize(pyannote community-1,门禁)
| Env | 值 |
|---|---|
| `MODEL_SOURCE` | `hf://pyannote/speaker-diarization-community-1` |
| `MODEL_NAME` | `pyannote-community-1` |
| `MODEL_MODE` | Diarize |
| `AUDIO_REQUIRED_GPU_MEMORY` | `4Gi` |

## 三、列出 / 区分所有实例

容器名已带 mode+模型(如 `audio-stt-systran-faster-whisper-large-v3`),Browse 的 Containers 面板一眼可分。命令行:

```bash
# mode 一列
kubectl get deploy -A -l io.kompose.service=audio-engine -L audio.mode

# mode + 模型
kubectl get deploy -A -l io.kompose.service=audio-engine \
  -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,MODE:.metadata.labels.audio\.mode,MODEL:.metadata.annotations.audio\.bytetrade\.io/model'
```

## 四、验证(在引擎容器内打样本音频)

每段自带 `NS`/`DEPLOY` 与自动取容器名 `$CN`(容器名随能力+模型变),改掉头两行的 NS/DEPLOY 即可直接跑。
`NS`=实例命名空间(`<release>-shared`),`DEPLOY`=实例名(`<release>`)。用 `kubectl get deploy -A -l io.kompose.service=audio-engine -L audio.mode` 查当前值。

> 当前实例(每次重新 clone 会变,仅供本轮参考;2026-06-22):
> | 能力 | NS | DEPLOY |
> |---|---|---|
> | STT | `audiolabwv304708e-shared` | `audiolabwv304708e` |
> | VAD | `audiolabwv32d0079-shared` | `audiolabwv32d0079` |
> | Diarize | `audiolabwv3e65afc-shared` | `audiolabwv3e65afc` |

### 验 STT → `/v1/audio/transcriptions`
```bash
NS=audiolabwv31be0a8-shared; DEPLOY=audiolabwv31be0a8
CN=$(kubectl -n "$NS" get pod -l io.kompose.service=audio-engine -o jsonpath='{.items[0].spec.containers[0].name}'); echo "CN=$CN"
kubectl -n "$NS" exec -i deploy/"$DEPLOY" -c "$CN" -- python3 - <<'PY'
import urllib.request, urllib.error, uuid
base="http://localhost:8000"
URL="https://github.com/ggerganov/whisper.cpp/raw/master/samples/jfk.wav"
wav=urllib.request.urlopen(URL,timeout=60).read()
b=uuid.uuid4().hex
def f(n,v): return (f'--{b}\r\nContent-Disposition: form-data; name="{n}"\r\n\r\n{v}\r\n').encode()
body =(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
       f'Content-Type: audio/wav\r\n\r\n').encode()+wav+b"\r\n"
body+=f("model","Systran/faster-whisper-large-v3")+f("language","en")+f'--{b}--\r\n'.encode()
req=urllib.request.Request(base+"/v1/audio/transcriptions",data=body,
      headers={"Content-Type":f"multipart/form-data; boundary={b}"})
try: print("[stt]", urllib.request.urlopen(req,timeout=300).read().decode())
except urllib.error.HTTPError as e: print("[stt-error]", e.code, e.read().decode()[:2000])
PY
```
预期:jfk 演讲那句 "...ask not what your country can do for you...".

### 验 VAD → `/v1/audio/vad`
```bash
NS=audiolabwv3ef4e70-shared; DEPLOY=audiolabwv3ef4e70
CN=$(kubectl -n "$NS" get pod -l io.kompose.service=audio-engine -o jsonpath='{.items[0].spec.containers[0].name}'); echo "CN=$CN"
kubectl -n "$NS" exec -i deploy/"$DEPLOY" -c "$CN" -- python3 - <<'PY'
import urllib.request, urllib.error, uuid
base="http://localhost:8000"
print("[models]", urllib.request.urlopen(base+"/v1/models", timeout=30).read().decode())
URL="https://github.com/ggerganov/whisper.cpp/raw/master/samples/jfk.wav"
wav=urllib.request.urlopen(URL,timeout=60).read()
b=uuid.uuid4().hex
body=(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
      f'Content-Type: audio/wav\r\n\r\n').encode()+wav+f"\r\n--{b}--\r\n".encode()
req=urllib.request.Request(base+"/v1/audio/vad",data=body,
      headers={"Content-Type":f"multipart/form-data; boundary={b}"})
try: print("[vad]", urllib.request.urlopen(req,timeout=120).read().decode())
except urllib.error.HTTPError as e: print("[vad-error]", e.code, e.read().decode()[:2000])
PY
```
预期:返回 `segments`(jfk.wav 接近全程语音)。

### 验 Diarize → `/v1/audio/diarization`
```bash
NS=audiolabwv31f768b-shared; DEPLOY=audiolabwv31f768b
CN=$(kubectl -n "$NS" get pod -l io.kompose.service=audio-engine -o jsonpath='{.items[0].spec.containers[0].name}'); echo "CN=$CN"
kubectl -n "$NS" exec -i deploy/"$DEPLOY" -c "$CN" -- python3 - <<'PY'
import urllib.request, urllib.error, uuid
base="http://localhost:8000"
print("[health]", urllib.request.urlopen(base+"/healthz", timeout=30).read().decode())
URL="https://github.com/pyannote/pyannote-audio/raw/develop/tutorials/assets/sample.wav"
wav=urllib.request.urlopen(URL,timeout=60).read()
b=uuid.uuid4().hex
body=(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
      f'Content-Type: audio/wav\r\n\r\n').encode()+wav+f"\r\n--{b}--\r\n".encode()
req=urllib.request.Request(base+"/v1/audio/diarization",data=body,
      headers={"Content-Type":f"multipart/form-data; boundary={b}"})
try: print("[diar]", urllib.request.urlopen(req,timeout=600).read().decode())
except urllib.error.HTTPError as e: print("[diar-error]", e.code, e.read().decode()[:2000])
PY
```
预期:`device:"cuda"`、`num_speakers>=2`、各段带 `speaker`。

## 五、端点形状(给 LLM Gateway 对接用)

| 能力 | 端点 | 入参(multipart) | 返回要点 |
|---|---|---|---|
| STT | `POST /v1/audio/transcriptions` | `file`, `model`, `language` | `{"text": ...}` |
| VAD | `POST /v1/audio/vad` | `file`[, `threshold`] | `segments[{start,end}]`, `speech_seconds` |
| Diarize | `POST /v1/audio/diarization` | `file`[, `num_speakers`/`min_speakers`/`max_speakers`] | `segments[{start,end,speaker}]`, `num_speakers` |

引擎集群内地址:`http://audio-engine.<实例NS>.svc.cluster.local:8000`。

## 六、Backlog / 注意

- **ARM64+GPU 的 Diarize**:现用 pyannote 镜像仅 amd64,DGX Spark(GB10/ARM64)跑不了。多架构起点见 `voice-engine-pyannote/`(Dockerfile+build.sh,CPU 版);打多架构 GPU 镜像时把 ffmpeg/torchcodec 装齐,可去掉 diar.py 里的自解码 workaround。
- **门禁模型**:必须先配账号 HF token + 同意条款,否则 llm-init 下载 401、实例卡 `wait-models` 最终 Stopped。
- 改 wrapper 脚本(vad.py/diar.py)只需改 chart 的 ConfigMap、重新上传 + 重装,无需重打镜像。
