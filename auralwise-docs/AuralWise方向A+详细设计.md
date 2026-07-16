# AuralWise 方向 A+ 详细设计：自托管模型 + AuralWise 兼容 REST 外壳

> 目标：在工作区 `app-zips/` 内新增 4 个 Helm chart（其中 1 个复用已有 `speaches`），构成一套**对外接口和 AuralWise 完全同形、但完全跑在自家集群内**的语音理解 API。客户端代码可以照着 AuralWise 官方文档写，**任何时候要切回 AuralWise 只改 baseURL**；反之亦然。
>
> 本文是设计稿，不是逐字代码。所有代码片段都是骨架级的，意在锚定每个文件的职责和外部行为；落地时 LOC 会比骨架多 30-50%（错误处理、日志、配置加载、metrics 等周边）。

---

## 0. 设计目标与边界

### 0.1 做什么

| 项 | 含义 |
| --- | --- |
| 接口对齐 | shim 暴露 `/v1/tasks`、`/v1/tasks/:id`、`/v1/tasks/:id/result`、`/v1/audio-event-classes` 等，**字段名、HTTP code、错误格式全部按 AuralWise 文档照抄** |
| 异步任务模型 | 提交立即返回 task_id；轮询；处理完成后取结果。状态机 `queued → processing → done / failed` 与 AuralWise 完全一致 |
| 双引擎路由 | `optimize_zh=true` + 中文 → 走 funasr-server；其它情况走 speaches。语言检测 = 先短窗口预判 |
| 三能力开关 | `enable_asr / enable_diarize / enable_audio_events` 与 AuralWise 同语义 |
| 单独 chart 化 | 每个能力一个 Helm chart，能单独升级、单独 scale、单独换实现 |

### 0.2 不做什么（明确跳过）

| 跳过项 | 为什么 |
| --- | --- |
| 多租户 / 用户系统 / API Key 管理 | 单租户场景。可选**一个全局 static bearer token**做最低限度访问控制 |
| 计费 / 充值 / 账单流水 | 没有商业模式 → `GET /v1/billing/transactions` 直接返回空数组（保兼容） |
| Webhook 签名重发体系 | 内部调用方一般直接轮询；如需 webhook，预留 100 行加进去 |
| 阿里云验证码 / 注册流程 | 同上 |
| JWT 体系 | 同上 |
| 多 GPU 节点调度 | 默认单 GPU；多 GPU 通过 K8s `nvidia.com/gpu` requests + nodeAffinity 简单分配 |

### 0.3 与现有工作区的关系

| 现有 chart | 在 A+ 里的角色 |
| --- | --- |
| `speaches-1.0.x.tgz` | **复用**，承担标准模式 ASR（faster-whisper + Silero VAD + 词级时间戳）。只需调一下 values 把模型从 small 换成 large-v3 |
| `whisperwebuiv2-1.0.x.tgz` | **不参与运行时**，已有大量 STT 测试脚本可以用作 A+ 上线后的回归验收 |
| `auralwise-docs/` | 本文及其 v 系列分析文档 |

新建 chart：

```
app-zips/
├── speaches-1.0.x.tgz                  (已有)
├── funasr-server-1.0.0.tgz             (新)  ← Chinese ASR + 说话人分离
├── yamnet-server-1.0.0.tgz             (新)  ← 521 类声音事件
└── auralwise-shim-1.0.0.tgz            (新)  ← Go API 网关
```

---

## 1. 总体架构

```
                       Customer / 内部应用 / Notebook
                       (调用 AuralWise-shaped REST API)
                                    │
                                    │ HTTP
                                    ▼
              ┌────────────────────────────────────────────┐
              │  auralwise-shim   (Go, 1 replica)          │
              │  ──────────────────────────────────────────│
              │  - POST /v1/tasks  / GET /v1/tasks/:id     │
              │  - Static bearer token (可选)              │
              │  - SQLite (任务状态+元数据)                 │
              │  - hostPath 卷 (音频 + 结果 JSON)           │
              │  - 内置 dispatcher goroutine 拉队列         │
              │  - 路由+聚合 3 个下游模型服务的结果         │
              └────┬──────────┬──────────┬─────────────────┘
                   │          │          │
        (POST /v1  │          │          │  (POST /transcribe |
         /audio/   │          │          │   POST /diarize)
         transcrip-│          │          │
         tions)    │          │          │  (POST /detect)
                   ▼          ▼          ▼
       ┌───────────────┐ ┌──────────────────┐ ┌────────────────┐
       │ speaches      │ │ funasr-server    │ │ yamnet-server  │
       │ (existing)    │ │ (new)            │ │ (new)          │
       │ ───────────── │ │ ──────────────── │ │ ────────────── │
       │ faster-whisper│ │ SenseVoiceSmall  │ │ YAMNet 521 类  │
       │ Whisper-large │ │ + fsmn-vad       │ │ from TF Hub    │
       │ -v3           │ │ + CAM++ 192-dim  │ │                │
       │ Silero VAD    │ │ + AHC + Silhouet.│ │ 0.48s hop      │
       │ 词级时间戳    │ │ 段级时间戳       │ │ 聚到 1s 桶     │
       └───────────────┘ └──────────────────┘ └────────────────┘
            (GPU 1)            (GPU 1)              (CPU 即可)
```

### 1.1 数据流（提交一个任务的完整路径）

```
1. Client → POST /v1/tasks {audio_url, options}
2. shim:
     - 校验 options 互斥规则（与 AuralWise 同）
     - 生成 task_id (UUID v4)
     - 写 SQLite: status=queued
     - 立即返回 201 {id, status=processing, ...}
3. shim dispatcher goroutine:
     - 拉到 queued 任务
     - 下载 audio_url 到 hostPath /var/auralwise/audio/<id>.<ext>
     - 用 ffmpeg 转 16kHz mono wav → /var/auralwise/audio/<id>.wav
     - 用 ffprobe 拿 audio_duration
     - 短窗口语言检测 (复用 speaches 第一次调用的 language_probability)
     - Router:
         IF optimize_zh && lang==zh:
            POST funasr-server:/transcribe (file=<wav>, language=zh)
               → segments[] (无 words)
         ELSE:
            POST speaches:/v1/audio/transcriptions
               (file=<wav>, response_format=verbose_json,
                timestamp_granularities=[word])
               → segments[] (带 words)
     - IF enable_diarize:
         POST funasr-server:/diarize (file=<wav>, segments=<上一步段>)
            → speaker_embeddings[] (192-d) + diarize_segments[]
         合并 speaker 字段到每个 segment
     - IF enable_audio_events:
         POST yamnet-server:/detect (file=<wav>,
                threshold, classes_filter)
            → audio_events[]
     - 把全部结果合并成 AuralWise 文档里那个 JSON 形状
     - 写 /var/auralwise/result/<id>.json
     - SQLite: status=done, finished_at=now
4. Client → GET /v1/tasks/:id → 看到 status=done
5. Client → GET /v1/tasks/:id/result → shim 把磁盘 JSON 读出来回传
```

### 1.2 失败 / 重试 / 终态

```
status 流转:
  queued → processing → done       (成功)
                      → failed     (本次失败但保留任务，可重试)
                      → abandoned  (重试 ≥ 3 次后放弃)

shim dispatcher:
  - 每次失败把 retry_count++ 并把 status 退回 queued
  - retry_count >= max_retries 后 status=abandoned
  - 与 AuralWise 完全一致
```

### 1.3 部署拓扑（K8s）

| 资源 | 数量 | 关键约束 |
| --- | --- | --- |
| `auralwise-shim` Deployment | 1 replica（必须，SQLite 单写） | 无需 GPU；要 PVC 或 hostPath |
| `speaches` Deployment | 1 replica per GPU | `nvidia.com/gpu: 1`、显存 ≥ 8 GB |
| `funasr-server` Deployment | 1 replica per GPU | `nvidia.com/gpu: 1`、显存 ≥ 4 GB（SenseVoice 220M + CAM++ 7.2M 都很小） |
| `yamnet-server` Deployment | 1 replica，CPU 即可（YAMNet ~3.7M 参数） | request 2 CPU / 2 GiB |
| `Service` × 3 | ClusterIP | 三个模型服务只对集群内可见 |
| `Service` × 1 for shim | ClusterIP 或 LoadBalancer 看部署形态 | 对外端口 |
| `Ingress` for shim | 可选 | 如果需要 TLS / 域名 |

**单机最小配置**：一台带 1 张 GPU（如 RTX 3090 24GB / 4090 24GB）的机器 → 把 speaches 和 funasr-server 都调度到同一节点共享 GPU；shim 和 yamnet-server 跑 CPU。这样 1 台机器跑完整 A+ 完全可行。

---

## 2. 4 个 Helm Chart 总览

### 2.1 chart 间的契约（API 矩阵）

| 下游 | 端口 | 端点 | 用途 |
| --- | --- | --- | --- |
| `speaches` | 8000 | `POST /v1/audio/transcriptions` | 标准 ASR + 词级时间戳（OpenAI 兼容） |
| `funasr-server` | 8000 | `POST /transcribe` | 中文 ASR 段级 |
| `funasr-server` | 8000 | `POST /diarize` | 说话人分离 + 192 维声纹 |
| `yamnet-server` | 8000 | `POST /detect` | 521 类音事件 |
| `yamnet-server` | 8000 | `GET /classes` | 521 类清单 |

shim 通过 ClusterIP DNS 调用，URL 通过 values 配置（见 5.3 节）。

### 2.2 共享约定

- 所有模型 chart 都暴露 `/healthz`（返回 `200 ok`），shim 启动时 health-check 一遍。
- 所有模型 chart 接受**通用上传格式**：`multipart/form-data` 的 `file` 字段（wav，16kHz mono），方便 shim 用一份 ffmpeg pipeline 喂三家。
- 错误体统一 `{"error": "..."}` 风格（与 AuralWise 一致）。

---

## 3. funasr-server chart 详细设计

### 3.1 选型

| 模型 | 来源 | 大小 | 用途 |
| --- | --- | --- | --- |
| `iic/SenseVoiceSmall` | FunASR / ModelScope | 220M | 中文 ASR 主模型 |
| `damo/speech_fsmn_vad_zh-cn-16k-common-pytorch` | FunASR | 0.4M | VAD |
| `damo/speech_campplus_sv_zh-cn_16k-common` | 3D-Speaker / ModelScope | 7.2M | 192 维声纹 |

所有模型都在 funasr SDK 内置，一行 `AutoModel` 就能拉起。

### 3.2 容器层

**Dockerfile**：

```dockerfile
FROM nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04

ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    MODELSCOPE_CACHE=/models \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y python3.10 python3-pip ffmpeg && \
    rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir \
    "funasr>=1.1.0" \
    "modelscope" \
    "torch==2.1.0" \
    "torchaudio==2.1.0" \
    "fastapi" "uvicorn[standard]" "python-multipart" \
    "scikit-learn"      # for AHC + silhouette

COPY server.py /app/server.py
COPY warmup.py /app/warmup.py
WORKDIR /app

# 镜像层预热下载模型，启动时直接命中缓存
RUN python3 warmup.py

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
```

**`warmup.py`**：

```python
from funasr import AutoModel
print("Downloading SenseVoiceSmall + fsmn-vad ...")
_ = AutoModel(
    model="iic/SenseVoiceSmall",
    vad_model="fsmn-vad",
    vad_kwargs={"max_single_segment_time": 30000},
    device="cpu",
)
print("Downloading CAM++ ...")
_ = AutoModel(model="iic/speech_campplus_sv_zh-cn_16k-common", device="cpu")
print("Done.")
```

### 3.3 服务层（`server.py`，约 200 行）

```python
import os, tempfile, uuid
import numpy as np
from fastapi import FastAPI, UploadFile, Form, HTTPException
from funasr import AutoModel
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import silhouette_score

DEVICE = os.environ.get("FUNASR_DEVICE", "cuda:0")

app = FastAPI()

asr = AutoModel(
    model="iic/SenseVoiceSmall",
    vad_model="fsmn-vad",
    vad_kwargs={"max_single_segment_time": 30000},
    device=DEVICE,
)
sv = AutoModel(model="iic/speech_campplus_sv_zh-cn_16k-common", device=DEVICE)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile,
    language: str = Form("auto"),
    batch_size_s: int = Form(60),
):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(await file.read())
        path = f.name
    try:
        result = asr.generate(
            input=path,
            cache={},
            language=language,
            use_itn=True,
            batch_size_s=batch_size_s,
            merge_vad=True,
            merge_length_s=15,
        )
        # funasr 返回 [{text, key, ...}]；要解析 SenseVoice 富文本
        from funasr.utils.postprocess_utils import rich_transcription_postprocess
        text = rich_transcription_postprocess(result[0]["text"])

        # 用 fsmn-vad 段做时间戳（SenseVoice 段级）
        segments = []
        for i, seg in enumerate(result[0].get("timestamp", [])):
            segments.append({
                "id": i,
                "start": seg[0] / 1000.0,
                "end": seg[1] / 1000.0,
                "text": seg[2] if len(seg) > 2 else "",
            })
        return {
            "language": "zh",  # SenseVoice 内部 LID 也可以拿出来
            "language_probability": 0.99,
            "segments": segments,
            "full_text": text,
        }
    finally:
        os.unlink(path)


@app.post("/diarize")
async def diarize(
    file: UploadFile,
    segments_json: str = Form(...),    # JSON [{start, end}, ...]
    min_speakers: int = Form(1),
    max_speakers: int = Form(10),
    num_speakers: int = Form(None),     # 强制说话人数，None 自动
    single_speaker_threshold: float = Form(0.05),
    diarize_min_segment_sec: float = Form(0.5),
):
    import json, soundfile as sf
    segs = json.loads(segments_json)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(await file.read())
        path = f.name
    try:
        wav, sr = sf.read(path)
        # 提取每段 embedding
        embs, valid_idx = [], []
        for i, s in enumerate(segs):
            if s["end"] - s["start"] < diarize_min_segment_sec:
                continue
            chunk = wav[int(s["start"] * sr): int(s["end"] * sr)]
            # 写临时小 wav 喂 sv 模型
            tmp = path + f".{i}.wav"
            sf.write(tmp, chunk, sr)
            emb = sv.generate(input=tmp)[0]["spk_embedding"]
            os.unlink(tmp)
            embs.append(np.asarray(emb).flatten())
            valid_idx.append(i)

        if len(embs) == 0:
            return {"num_speakers": 0, "speaker_embeddings": [], "diarize_segments": []}

        X = np.vstack(embs)

        # 决定说话人数
        if num_speakers and num_speakers > 0:
            n = num_speakers
        else:
            # 简化：用 silhouette 在 [min_speakers..max_speakers] 里挑
            best_k, best_s = 1, -1
            for k in range(max(2, min_speakers), min(max_speakers, len(X)) + 1):
                labels = AgglomerativeClustering(n_clusters=k).fit_predict(X)
                if len(set(labels)) < 2:
                    continue
                s = silhouette_score(X, labels)
                if s > best_s:
                    best_k, best_s = k, s
            n = best_k if best_s >= single_speaker_threshold else 1

        if n == 1:
            labels = np.zeros(len(X), dtype=int)
        else:
            labels = AgglomerativeClustering(n_clusters=n).fit_predict(X)

        # 输出 diarize_segments
        diarize_segments = []
        for src_i, lbl in zip(valid_idx, labels):
            s = segs[src_i]
            diarize_segments.append({
                "start": s["start"],
                "end": s["end"],
                "speaker": f"SPEAKER_{lbl}",
            })

        # 输出 speaker_embeddings (按 speaker 取均值)
        speaker_embeddings = []
        for spk_id in range(n):
            mask = labels == spk_id
            mean_emb = X[mask].mean(axis=0)
            speaker_embeddings.append({
                "speaker_id": f"SPEAKER_{spk_id}",
                "embedding": mean_emb.tolist(),
                "segment_count": int(mask.sum()),
            })

        return {
            "num_speakers": n,
            "speaker_embeddings": speaker_embeddings,
            "diarize_segments": diarize_segments,
        }
    finally:
        os.unlink(path)
```

### 3.4 chart 关键 values

```yaml
# charts/funasr-server/values.yaml
image:
  repository: myreg/funasr-server
  tag: "1.0.0"
  pullPolicy: IfNotPresent

resources:
  requests:
    cpu: "2"
    memory: "8Gi"
    nvidia.com/gpu: "1"
  limits:
    cpu: "8"
    memory: "16Gi"
    nvidia.com/gpu: "1"

env:
  FUNASR_DEVICE: "cuda:0"

# 模型缓存盘（避免 pod 重启重新下载 ~1GB 模型）
persistence:
  enabled: true
  size: 10Gi
  mountPath: /models

service:
  type: ClusterIP
  port: 8000

nodeSelector:
  gpu.present: "true"
```

---

## 4. yamnet-server chart 详细设计

### 4.1 选型

- 模型：YAMNet（Google Research，AudioSet 521 类）
- 推理引擎：TensorFlow Hub 原版（或 ONNX 移植，但 TF 原版最稳）
- 521 类清单：模型仓库自带 `yamnet_class_map.csv`，运行时直接读

### 4.2 容器层

```dockerfile
FROM python:3.10-slim
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir \
    "tensorflow==2.15.*" \
    "tensorflow-hub" \
    "fastapi" "uvicorn[standard]" "python-multipart" \
    "soundfile" "numpy<2"

COPY server.py /app/server.py
COPY zh_translation.json /app/zh_translation.json  # 521 类中文名 + 8 大类
COPY warmup.py /app/warmup.py
WORKDIR /app

RUN python3 warmup.py

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
```

`warmup.py`：

```python
import tensorflow_hub as hub
print("Pre-downloading YAMNet to local cache...")
_ = hub.load("https://tfhub.dev/google/yamnet/1")
print("Done.")
```

### 4.3 服务层（`server.py`，约 120 行）

```python
import csv, json, os, tempfile, io
import numpy as np
import soundfile as sf
import tensorflow as tf
import tensorflow_hub as hub
from fastapi import FastAPI, UploadFile, Form

app = FastAPI()
model = hub.load("https://tfhub.dev/google/yamnet/1")
class_map_path = model.class_map_path().numpy().decode("utf-8")

# 加载 521 类清单
CLASSES = []
with tf.io.gfile.GFile(class_map_path, "r") as f:
    reader = csv.reader(f)
    next(reader)  # header
    for i, row in enumerate(reader):
        # row: index, mid, display_name
        CLASSES.append({
            "index": int(row[0]),
            "mid": row[1],
            "display_name": row[2],
        })

# 中文翻译 & 8 大类映射
with open("zh_translation.json", "r", encoding="utf-8") as f:
    ZH = json.load(f)  # {mid -> {zh_name, category, category_zh}}
for c in CLASSES:
    extra = ZH.get(c["mid"], {})
    c["zh_name"] = extra.get("zh_name", c["display_name"])
    c["category"] = extra.get("category", "")
    c["category_zh"] = extra.get("category_zh", "")


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/classes")
def list_classes():
    return CLASSES


@app.post("/detect")
async def detect(
    file: UploadFile,
    threshold: float = Form(0.3),
    classes_filter: str = Form(""),   # 逗号分隔的 class display_name 或 mid；空 = 全部
):
    raw = await file.read()
    wav, sr = sf.read(io.BytesIO(raw), dtype="float32")
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    if sr != 16000:
        # YAMNet 强制 16kHz；调用方应已 ffmpeg 转好
        raise ValueError("audio must be 16kHz mono")

    scores, embeddings, log_mel = model(wav)
    scores = scores.numpy()          # (num_frames, 521)，每 0.48s 一帧

    # 聚到 1s 桶 (每 ~2 帧合 1 桶)
    bucket_hz = int(round(1.0 / 0.48))  # 约 2 帧每秒
    bucketed_max = []
    for t in range(0, scores.shape[0], bucket_hz):
        chunk = scores[t:t + bucket_hz]
        bucketed_max.append(chunk.max(axis=0))
    bucketed_max = np.array(bucketed_max)  # (num_seconds, 521)

    # 可选 class filter
    if classes_filter:
        wanted = set(s.strip() for s in classes_filter.split(",") if s.strip())
        keep_idx = [c["index"] for c in CLASSES
                    if c["display_name"] in wanted or c["mid"] in wanted]
    else:
        keep_idx = [c["index"] for c in CLASSES]

    events = []
    for sec, frame in enumerate(bucketed_max):
        for ci in keep_idx:
            conf = float(frame[ci])
            if conf >= threshold:
                events.append({
                    "start": float(sec),
                    "end": float(sec + 1),
                    "class": CLASSES[ci]["display_name"],
                    "confidence": conf,
                })
    # 同 class 相邻秒合并
    events.sort(key=lambda e: (e["class"], e["start"]))
    merged = []
    for e in events:
        if merged and merged[-1]["class"] == e["class"] and merged[-1]["end"] >= e["start"]:
            merged[-1]["end"] = e["end"]
            merged[-1]["confidence"] = max(merged[-1]["confidence"], e["confidence"])
        else:
            merged.append(e)
    merged.sort(key=lambda e: e["start"])
    return {"events": merged}
```

### 4.4 chart values

```yaml
# charts/yamnet-server/values.yaml
image:
  repository: myreg/yamnet-server
  tag: "1.0.0"

resources:
  requests:
    cpu: "1"
    memory: "2Gi"
  limits:
    cpu: "4"
    memory: "4Gi"
  # 不要 GPU

service:
  type: ClusterIP
  port: 8000

persistence:
  enabled: true
  size: 1Gi
  mountPath: /root/.cache    # TF Hub 缓存
```

---

## 5. auralwise-shim chart 详细设计（核心）

### 5.1 Go 项目目录结构

```
auralwise-shim/
├── cmd/server/
│   └── main.go                  ~50 行  (引导 + 配置)
├── internal/
│   ├── api/
│   │   ├── router.go            ~80 行  (路由 + 中间件链)
│   │   ├── handlers.go          ~180 行 (各 endpoint handler)
│   │   ├── auth.go              ~30 行  (单 token 校验)
│   │   └── types.go             ~100 行 (Request/Response struct, AuralWise JSON 形状)
│   ├── db/
│   │   ├── sqlite.go            ~120 行 (open/migrate/CRUD)
│   │   └── models.go            ~40 行
│   ├── dispatcher/
│   │   ├── dispatcher.go        ~150 行 (后台 worker goroutine)
│   │   ├── pipeline.go          ~200 行 (router + 聚合逻辑)
│   │   └── clients.go           ~180 行 (3 个下游 HTTP client)
│   ├── audio/
│   │   ├── source.go            ~80 行  (audio_url 下载 / base64 解码)
│   │   └── ffmpeg.go            ~50 行  (转 16kHz mono wav, ffprobe duration)
│   └── ontology/
│       └── yamnet_521.go        ~30 行  (静态 521 类清单 fallback)
├── pkg/auralwise/
│   └── schema.go                ~80 行  (公开的对外 JSON schema 定义)
├── go.mod / go.sum
├── Dockerfile
└── chart/
    ├── Chart.yaml
    ├── values.yaml
    └── templates/
        ├── deployment.yaml
        ├── service.yaml
        ├── pvc.yaml
        ├── configmap.yaml
        └── ingress.yaml
```

总计约 **~1400 行 Go**（含错误处理、日志、配置加载）。我在《复刻方向对比》里给的"300 行"估算只算了纯路由+聚合的核心逻辑，**这里给一份更诚实的估算 ~1400 行**。

### 5.2 SQLite schema

```sql
-- migrations/001_init.sql
CREATE TABLE IF NOT EXISTS tasks (
    id                  TEXT PRIMARY KEY,         -- UUID
    status              TEXT NOT NULL,            -- queued|processing|done|failed|abandoned
    audio_filename      TEXT,
    audio_source_type   TEXT,                     -- url|base64
    audio_size          INTEGER,
    audio_path          TEXT,                     -- 落盘绝对路径
    options             TEXT NOT NULL,            -- JSON
    result_path         TEXT,                     -- 结果 JSON 落盘
    error_message       TEXT,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    callback_url        TEXT,
    callback_secret     TEXT,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at         TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
```

### 5.3 关键代码骨架

#### `cmd/server/main.go`

```go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "auralwise-shim/internal/api"
    "auralwise-shim/internal/db"
    "auralwise-shim/internal/dispatcher"
)

func main() {
    cfg := loadConfig()
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    sqlite, err := db.Open(cfg.DBPath)
    if err != nil {
        logger.Error("db open", "err", err); os.Exit(1)
    }
    defer sqlite.Close()

    if err := db.Migrate(sqlite); err != nil {
        logger.Error("db migrate", "err", err); os.Exit(1)
    }

    disp := dispatcher.New(dispatcher.Config{
        DB:              sqlite,
        AudioDir:        cfg.AudioDir,
        ResultDir:       cfg.ResultDir,
        SpeachesURL:     cfg.SpeachesURL,
        FunasrURL:       cfg.FunasrURL,
        YamnetURL:       cfg.YamnetURL,
        MaxConcurrent:   cfg.MaxConcurrentTasks,
        MaxRetries:      cfg.MaxRetries,
        Logger:          logger,
    })

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    go disp.Run(ctx)

    srv := api.NewServer(api.Config{
        DB:            sqlite,
        AudioDir:      cfg.AudioDir,
        ResultDir:     cfg.ResultDir,
        BearerToken:   cfg.BearerToken,
        Logger:        logger,
    })

    // 注册关停信号
    stop := make(chan os.Signal, 1)
    signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        if err := srv.ListenAndServe(":" + cfg.Port); err != nil {
            logger.Error("server", "err", err)
            stop <- syscall.SIGTERM
        }
    }()
    logger.Info("shim started", "port", cfg.Port)
    <-stop
    logger.Info("shutting down")
    srv.Shutdown(ctx)
}
```

#### `internal/api/handlers.go`（核心两个 handler）

```go
package api

import (
    "encoding/base64"
    "encoding/json"
    "io"
    "net/http"
    "os"
    "path/filepath"
    "time"

    "github.com/google/uuid"
    "auralwise-shim/internal/db"
    "auralwise-shim/pkg/auralwise"
)

// POST /v1/tasks
func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
    var req auralwise.CreateTaskRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
        return
    }
    if err := req.Validate(); err != nil {  // options 互斥规则在 schema 里
        writeError(w, http.StatusBadRequest, err.Error())
        return
    }

    id := uuid.NewString()

    // 落盘音频
    audioPath, srcType, size, fname, err := s.materializeAudio(id, &req)
    if err != nil {
        writeError(w, http.StatusBadRequest, "cannot read audio: "+err.Error())
        return
    }

    optionsJSON, _ := json.Marshal(req.Options)

    task := &db.Task{
        ID:                id,
        Status:            "queued",
        AudioFilename:     fname,
        AudioSourceType:   srcType,
        AudioSize:         size,
        AudioPath:         audioPath,
        Options:           string(optionsJSON),
        CallbackURL:       req.CallbackURL,
        CallbackSecret:    req.CallbackSecret,
        CreatedAt:         time.Now(),
        UpdatedAt:         time.Now(),
    }
    if err := db.InsertTask(s.cfg.DB, task); err != nil {
        writeError(w, http.StatusInternalServerError, err.Error())
        return
    }

    // 与 AuralWise 一致：立即返回 processing
    resp := auralwise.TaskResponse{
        ID:               id,
        Status:           "processing",
        AudioFilename:    fname,
        AudioSourceType:  srcType,
        AudioSize:        size,
        Options:          req.Options,
        CreatedAt:        task.CreatedAt,
        UpdatedAt:        task.UpdatedAt,
    }
    writeJSON(w, http.StatusCreated, resp)
}

// GET /v1/tasks/:id/result
func (s *Server) handleGetResult(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    task, err := db.GetTask(s.cfg.DB, id)
    if err != nil { writeError(w, http.StatusNotFound, "task not found"); return }

    if task.Status != "done" {
        // 与 AuralWise 一致：未完成返回 404
        writeError(w, http.StatusNotFound, "task not yet completed")
        return
    }

    b, err := os.ReadFile(task.ResultPath)
    if err != nil { writeError(w, http.StatusInternalServerError, err.Error()); return }

    w.Header().Set("Content-Type", "application/json; charset=utf-8")
    w.WriteHeader(http.StatusOK)
    w.Write(b)
}

func (s *Server) materializeAudio(id string, req *auralwise.CreateTaskRequest) (path, srcType string, size int64, fname string, err error) {
    audioDir := s.cfg.AudioDir
    if err := os.MkdirAll(audioDir, 0o755); err != nil {
        return "", "", 0, "", err
    }
    fname = req.AudioFilename
    if req.AudioURL != "" {
        srcType = "url"
        path = filepath.Join(audioDir, id+"_"+fname)
        resp, err := http.Get(req.AudioURL)
        if err != nil { return "", "", 0, "", err }
        defer resp.Body.Close()
        f, _ := os.Create(path)
        defer f.Close()
        size, err = io.Copy(f, resp.Body)
        return path, srcType, size, fname, err
    }
    if req.AudioBase64 != "" {
        srcType = "base64"
        raw, err := base64.StdEncoding.DecodeString(req.AudioBase64)
        if err != nil { return "", "", 0, "", err }
        path = filepath.Join(audioDir, id+"_"+fname)
        if err := os.WriteFile(path, raw, 0o644); err != nil { return "", "", 0, "", err }
        size = int64(len(raw))
        return path, srcType, size, fname, nil
    }
    return "", "", 0, "", errExpectAudio
}
```

#### `internal/dispatcher/pipeline.go`（路由聚合逻辑骨架）

```go
package dispatcher

import (
    "context"
    "encoding/json"
    "os"
    "path/filepath"

    "auralwise-shim/internal/audio"
    "auralwise-shim/internal/db"
    "auralwise-shim/pkg/auralwise"
)

func (d *Dispatcher) processTask(ctx context.Context, t *db.Task) error {
    var opts auralwise.TaskOptions
    _ = json.Unmarshal([]byte(t.Options), &opts)

    // 1. 归一化为 16kHz mono wav
    wav, err := audio.NormalizeTo16kMono(t.AudioPath)
    if err != nil { return err }
    duration, _ := audio.ProbeDuration(wav)

    result := auralwise.Result{TaskID: t.ID, AudioDuration: duration}

    // 2. ASR (含语言检测)
    var (
        segments []auralwise.Segment
        vadSegs  []auralwise.VADSegment
        lang     string
        langProb float64
    )

    // 先做语言检测（用 speaches 的 detect-language 或 funasr 都行；
    // 此处图简化：先把开头 30s 喂 speaches）
    detected, dp := d.clients.SpeachesDetectLanguage(ctx, wav)
    lang, langProb = detected, dp

    if opts.EnableASR {
        if opts.OptimizeZH && lang == "zh" {
            segments, vadSegs, _ = d.clients.FunasrTranscribe(ctx, wav, "zh")
        } else {
            segments, vadSegs, _ = d.clients.SpeachesTranscribe(ctx, wav, lang)
        }
        result.Language = &lang
        result.LanguageProbability = &langProb
        result.Segments = segments
        result.VADSegments = vadSegs
    }

    // 3. Diarization
    if opts.EnableDiarize && opts.EnableASR {
        diar, err := d.clients.FunasrDiarize(ctx, wav, vadSegs, opts.NumSpeakers, opts.MinSpeakers, opts.MaxSpeakers, opts.DiarizeSingleSpeakerThreshold)
        if err == nil {
            result.NumSpeakers = &diar.NumSpeakers
            result.SpeakerEmbeddings = diar.SpeakerEmbeddings
            result.DiarizeSegments = diar.Segments
            // 把 speaker 字段写回 segments
            for i, seg := range result.Segments {
                if i < len(diar.Segments) {
                    result.Segments[i] = seg
                    result.Segments[i].Speaker = &diar.Segments[i].Speaker
                }
            }
        }
    }

    // 4. AED
    if opts.EnableAudioEvents {
        events, err := d.clients.YamnetDetect(ctx, wav, opts.AudioEventsThreshold, opts.AudioEventsClasses)
        if err == nil {
            result.AudioEvents = events
        }
    }

    // 5. 持久化
    resultPath := filepath.Join(d.cfg.ResultDir, t.ID+".json")
    b, _ := json.MarshalIndent(result, "", "  ")
    if err := os.WriteFile(resultPath, b, 0o644); err != nil { return err }
    t.ResultPath = resultPath

    return nil
}
```

#### `internal/dispatcher/clients.go`（下游 HTTP 客户端骨架，仅示一个）

```go
package dispatcher

import (
    "bytes"
    "context"
    "encoding/json"
    "io"
    "mime/multipart"
    "net/http"
    "os"

    "auralwise-shim/pkg/auralwise"
)

type funasrTranscribeResp struct {
    Language            string                  `json:"language"`
    LanguageProbability float64                 `json:"language_probability"`
    Segments            []auralwise.Segment     `json:"segments"`
    FullText            string                  `json:"full_text"`
}

func (c *Clients) FunasrTranscribe(ctx context.Context, wavPath, lang string) ([]auralwise.Segment, []auralwise.VADSegment, error) {
    body, contentType, err := buildMultipart("file", wavPath, map[string]string{
        "language":     lang,
        "batch_size_s": "60",
    })
    if err != nil { return nil, nil, err }

    req, _ := http.NewRequestWithContext(ctx, "POST", c.funasrURL+"/transcribe", body)
    req.Header.Set("Content-Type", contentType)

    resp, err := http.DefaultClient.Do(req)
    if err != nil { return nil, nil, err }
    defer resp.Body.Close()

    var fr funasrTranscribeResp
    if err := json.NewDecoder(resp.Body).Decode(&fr); err != nil { return nil, nil, err }

    // funasr 段也直接当 vad_segments 用
    var vadSegs []auralwise.VADSegment
    for _, s := range fr.Segments {
        vadSegs = append(vadSegs, auralwise.VADSegment{Start: s.Start, End: s.End})
    }
    return fr.Segments, vadSegs, nil
}

func buildMultipart(fileFieldName, path string, fields map[string]string) (io.Reader, string, error) {
    body := &bytes.Buffer{}
    w := multipart.NewWriter(body)
    for k, v := range fields {
        _ = w.WriteField(k, v)
    }
    f, err := os.Open(path)
    if err != nil { return nil, "", err }
    defer f.Close()
    fw, _ := w.CreateFormFile(fileFieldName, path)
    if _, err := io.Copy(fw, f); err != nil { return nil, "", err }
    _ = w.Close()
    return body, w.FormDataContentType(), nil
}
```

### 5.4 chart values

```yaml
# charts/auralwise-shim/values.yaml
image:
  repository: myreg/auralwise-shim
  tag: "1.0.0"

replicaCount: 1   # 必须 1（SQLite 单写）

resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "2"
    memory: "2Gi"

persistence:
  audio:
    size: 100Gi
    mountPath: /var/auralwise/audio
  result:
    size: 20Gi
    mountPath: /var/auralwise/result
  db:
    size: 1Gi
    mountPath: /var/auralwise/db

env:
  PORT: "8000"
  DB_PATH: "/var/auralwise/db/shim.db"
  AUDIO_DIR: "/var/auralwise/audio"
  RESULT_DIR: "/var/auralwise/result"
  MAX_CONCURRENT_TASKS: "2"
  MAX_RETRIES: "3"
  BEARER_TOKEN: ""  # 留空 = 不校验；非空 = 单 token 模式

models:
  speaches:
    url: "http://speaches.audio.svc.cluster.local:8000"
  funasr:
    url: "http://funasr-server.audio.svc.cluster.local:8000"
  yamnet:
    url: "http://yamnet-server.audio.svc.cluster.local:8000"

service:
  type: ClusterIP
  port: 8000

ingress:
  enabled: false   # 内网用可关；如要对外开启 + 给个域名
```

---

## 6. API 字段映射全表（每个 AuralWise 字段 → A+ 来源）

| AuralWise 字段 | 来源 | 备注 |
| --- | --- | --- |
| `task_id` | shim 生成 UUID v4 | |
| `audio_duration` | shim 用 ffprobe 量 | |
| `language` | speaches 返回的 LID / funasr 返回的 LID | 标准路径走 speaches |
| `language_probability` | 同上 | funasr 在中文路径下硬编码 0.99（SenseVoice 不暴露准确 LID 置信） |
| `segments[].id/start/end/text` | speaches 或 funasr-server | 二选一按路由 |
| `segments[].speaker` | funasr-server `/diarize` 回写 | enable_diarize 时 |
| `segments[].words[]` | **仅 speaches**（标准模式） | funasr 路径下永远缺这字段，与 AuralWise 一致 |
| `segments[].words[].probability` | speaches `verbose_json` 的 `probability` | OpenAI 兼容 |
| `vad_segments[]` | shim 从 segments 推 | 简化：直接用每个 segment 的 start/end 当 VAD 段 |
| `num_speakers` | funasr-server `/diarize` | |
| `speaker_embeddings[].embedding` | funasr-server CAM++ 192-d | |
| `speaker_embeddings[].segment_count` | shim 用 labels 统计 | |
| `diarize_segments[]` | funasr-server `/diarize` | |
| `audio_events[]` | yamnet-server `/detect` | |
| `audio_events[].class` | YAMNet display_name | |
| `audio_events[].confidence` | YAMNet score 聚到 1s 桶后的最大值 | |
| `GET /v1/audio-event-classes` | shim 把 yamnet-server `/classes` 透传，**或** 用本地静态拷贝 | |
| `Webhook` | **不实现**；如需要：shim 加一个 ~80 行的 `webhook.go` 模块 | |
| `GET /v1/billing/transactions` | shim **返回空数组**：`{"transactions": [], "total": 0, "page": 1, "page_size": 20}` | 保兼容 |
| `X-API-Key`/`Bearer` 鉴权 | shim 单 token 校验（env `BEARER_TOKEN`），与 AuralWise 字段名一致；多租户**不做** | |
| `batch_mode=true` | shim 把任务的 `priority` 字段标低，dispatcher 队列里高优先级先做 | 简易实现 |

---

## 7. 部署 step-by-step

假设你已经有：

- 一台 K8s 节点带 NVIDIA GPU（≥ 16GB 显存）
- 一个内部镜像仓库 `myreg`（如阿里云 ACR、本地 Harbor）
- `kubectl` 和 `helm` 配好

### 7.1 构建并推送 3 个新镜像

```bash
# 在 app-zips/ 目录之外另起一个仓库放镜像源
mkdir -p auralwise-images/{funasr-server,yamnet-server,auralwise-shim}
# 把 3.2 / 4.2 / 5.3 节的 Dockerfile + 代码放进去

cd auralwise-images/funasr-server
docker buildx build --platform linux/amd64 -t myreg/funasr-server:1.0.0 . --push

cd ../yamnet-server
docker buildx build --platform linux/amd64 -t myreg/yamnet-server:1.0.0 . --push

cd ../auralwise-shim
docker buildx build --platform linux/amd64 -t myreg/auralwise-shim:1.0.0 . --push
```

### 7.2 打 3 个新 chart 包

```bash
cd app-zips/

helm package charts/funasr-server -d .         # → funasr-server-1.0.0.tgz
helm package charts/yamnet-server -d .         # → yamnet-server-1.0.0.tgz
helm package charts/auralwise-shim -d .        # → auralwise-shim-1.0.0.tgz
```

### 7.3 部署到集群（建议顺序）

```bash
kubectl create namespace audio

# (1) 模型先起，等他们 ready 再起 shim
helm install yamnet-server   ./yamnet-server-1.0.0.tgz   -n audio
helm install funasr-server   ./funasr-server-1.0.0.tgz   -n audio
helm install speaches        ./speaches-1.0.18.tgz       -n audio \
    --set whisperModel=Systran/faster-whisper-large-v3   # 切到大模型

# 等 ready
kubectl -n audio wait --for=condition=ready pod -l app=funasr-server  --timeout=10m
kubectl -n audio wait --for=condition=ready pod -l app=yamnet-server  --timeout=5m
kubectl -n audio wait --for=condition=ready pod -l app=speaches        --timeout=10m

# (2) shim 最后
helm install auralwise-shim ./auralwise-shim-1.0.0.tgz -n audio \
    --set models.speaches.url=http://speaches.audio.svc.cluster.local:8000 \
    --set models.funasr.url=http://funasr-server.audio.svc.cluster.local:8000 \
    --set models.yamnet.url=http://yamnet-server.audio.svc.cluster.local:8000
```

### 7.4 端到端冒烟测试

```bash
# port-forward 把 shim 8000 端口暴露到本机
kubectl -n audio port-forward svc/auralwise-shim 8000:8000 &

# 提交一个任务
TASK_ID=$(curl -s -X POST http://localhost:8000/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "audio_url": "https://example.com/sample.mp3",
    "audio_filename": "sample.mp3",
    "options": {
      "enable_asr": true,
      "enable_diarize": true,
      "enable_audio_events": true,
      "optimize_zh": true
    }
  }' | jq -r .id)
echo "Task ID: $TASK_ID"

# 轮询
while true; do
  STATUS=$(curl -s http://localhost:8000/v1/tasks/$TASK_ID | jq -r .status)
  echo "Status: $STATUS"
  [ "$STATUS" = "done" ] && break
  [ "$STATUS" = "abandoned" ] && exit 1
  sleep 3
done

# 取结果，期望和 AuralWise 文档里的 JSON shape 完全一致
curl -s http://localhost:8000/v1/tasks/$TASK_ID/result | jq .
```

---

## 8. 验收清单

每条都跑通才能认为 A+ 落地完成：

- [ ] **接口形状对齐**：上面 7.4 的 jq 输出与 AuralWise 文档 § 获取任务结果 完全同构（字段名、类型、嵌套层级）
- [ ] **三能力开关独立工作**：
    - [ ] 只 `enable_asr` → 只有 segments、language、vad_segments；无 speaker_* 无 audio_events
    - [ ] `enable_diarize=true && enable_asr=false` → 返回 400（与 AuralWise 一致）
    - [ ] 三项全 false → 返回 400
- [ ] **`optimize_zh` 路由生效**：
    - [ ] 中文音频 + `optimize_zh=true` → segments 无 words 字段
    - [ ] 中文音频 + `optimize_zh=false` → segments 有 words 字段、有词级 start/end
    - [ ] 英文音频 + `optimize_zh=true` → 自动走标准模式，有 words
- [ ] **声纹维度**：`speaker_embeddings[].embedding` 长度 == 192
- [ ] **521 类**：`GET /v1/audio-event-classes` 返回 521 项
- [ ] **状态机**：杀掉 funasr-server pod，复活后失败的任务能在 max_retries 内恢复或转 abandoned
- [ ] **持久化**：删了 shim pod 重新拉起，已存在的任务状态/结果都还在
- [ ] **OpenAI 客户端兼容**（顺带）：直接用 OpenAI Python SDK 指向 speaches 也能跑通

---

## 9. 已知坑 / 取舍 / 未来扩展

### 9.1 已知取舍

| 取舍 | 原因 |
| --- | --- |
| SQLite 而不是 Postgres | 单租户低并发够用；shim 必须 1 replica；要多 replica 时改 Postgres |
| hostPath / PVC 而不是 MinIO | 同上；想要分布式存储再换 MinIO，pkg/audio 抽象层留好接口 |
| 用 ffmpeg 提前转 16kHz mono wav，三家共享同一个 wav | 节省解码耗时；坏处是 wav 比 mp3 大 ~10× 占盘 |
| 不做 Webhook | 内部调用方一般直接轮询；要加 ~80 行 |
| 不做计费 / 多租户 / API Key 管理 | 单租户场景不需要；升级路径见 9.3 |
| funasr-server 路径下 `language_probability` 硬编码 0.99 | SenseVoice 不暴露 LID 置信；如果重要可在前置 LID 用 speaches |
| 中文路径无 word-level 时间戳 | 与 AuralWise 行为一致（NAR 模型固有限制） |
| YAMNet 用 1s 聚桶 | 简化；如果要更细可改成 0.48s 步长输出 |

### 9.2 已知坑

| 坑 | 缓解 |
| --- | --- |
| SenseVoice + CAM++ 同时跑同一张 GPU 的显存峰值 | 两者都很小（合 < 4GB），4090 24GB 完全不挤；老 GPU 注意 |
| YAMNet TF 2.15 与 funasr 的 PyTorch 不在同一容器 | 我已经设计成 3 个独立容器，所以无冲突 |
| funasr-server 的 `/diarize` 把音频再切再写盘很慢 | 用 in-memory numpy chunk 直接喂 sv 模型，避免落盘；上面 server.py 是图清晰才那么写 |
| 长音频 (>1h) 在 shim 单 goroutine 内会阻塞队列 | 起 `MaxConcurrent` 个 worker goroutine（默认 2，按 GPU 数量调） |
| audio_url 下载失败 | shim 重试 3 次后转 abandoned；与 AuralWise 一致 |
| 模型首次启动加载慢（funasr 拉 ModelScope 几分钟） | warmup.py 在 Dockerfile 构建阶段就下载，运行时直接命中 cache；K8s 起的时候第一次启动也只需几秒加载到显存 |

### 9.3 升级路径（从 A+ → B SaaS）

如果未来真要做对外卖的 SaaS，shim 改造点（按工作量从小到大排）：

1. **多 Bearer token / API Key 表**：在 SQLite 加 `api_keys` 表 + 中间件查表。~50 行 Go。
2. **加 Webhook + 4 次重试**：`internal/webhook/sender.go` 一个 80 行的模块，dispatcher 完成任务后调用。
3. **加 Rate Limit**：`golang.org/x/time/rate` 中间件，按 API Key 配额。~30 行。
4. **加计费**：新建 `billing_transactions` 表 + 完成任务时扣费 trigger。~150 行。
5. **SQLite → Postgres**：换 DB driver 即可（写代码时用 `database/sql` 抽象层）；改约 100 行。
6. **加 Aliyun OSS / S3 兼容存储**：`internal/audio/source.go` 加 OSS 后端。~80 行。
7. **多租户隔离**：在所有任务表上加 `user_id` 索引。~60 行。
8. **shim 水平扩容**：把 dispatcher 从 in-process 改成读 Redis 队列，多 replica；这是从 SQLite 到分布式的真正改动，~300 行。

**关键设计决策让升级路径顺**：shim 的每一层（API / DB / Dispatcher / AudioSource / DownstreamClient）都用接口抽象。8 步加起来约 850 行新代码，**不需要重写任何已有逻辑**，全是新增。

### 9.4 未来扩展

- **加 ITN（Inverse Text Normalization）+ 标点恢复**：funasr 已经支持 `use_itn=True`，已经默认开。要更好的标点可以串个 `ct-punc` 进去。
- **加情绪识别 / 富文本**：SenseVoice 自带，response 里加一个 `emotion`/`event_tag` 字段即可——但这就**超出 AuralWise 兼容范围了**，要做可选扩展字段。
- **加端到端 EEND-VC（最新 SOTA 说话人分离）**：目前 CAM++ + AHC 是行业默认，将来可以替换底层而保持 shim 接口不变。
- **加 LLM 后处理（摘要 / 待办提取 / 标题生成）**：在 shim 加 `enable_summary` 选项，调一个外部 LLM Service。这一步就**显著超出 AuralWise 范围**，相当于做"音频 Agent"了，可以单独搞一个 `auralwise-plus` 接口（不破坏兼容）。

---

## 10. 实施排期建议

| 周次 | 任务 | 产物 |
| --- | --- | --- |
| 第 1 周 | yamnet-server 全栈（最简单，先 warm up） | chart + 镜像 + 521 类清单 |
| 第 1 周 | funasr-server 全栈 | chart + 镜像（含 SenseVoice + CAM++ 双管线） |
| 第 1-2 周 | auralwise-shim 骨架（cmd/api/db/dispatcher 全跑通空逻辑） | chart + 镜像 |
| 第 2 周 | shim 三能力的 client 接 + pipeline 聚合 + 字段映射 | 端到端 done |
| 第 3 周 | 验收清单逐条过 + 文档（API 示例、迁移指南） | A+ 上线 |

**实际单人开发预估：~3 周（160 小时）**。如果有现成 funasr 经验 / Go 后端经验，能压到 2 周。

---

## 11. 一句话总结

**A+ = `speaches`（你已有）+ `funasr-server`（200 行 Python）+ `yamnet-server`（120 行 Python）+ `auralwise-shim`（~1400 行 Go）**，4 个独立 Helm chart，单 GPU 单机即可承载，对外接口和 AuralWise **100% 字段同构**，跳过所有 SaaS 周边（计费 / Webhook / 多租户），任何时候只改 baseURL 就能在自托管和 AuralWise 之间无缝切换；升级到完整 SaaS（B 方向）的所有改动都是"加代码"而不是"改代码"。
