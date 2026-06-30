# audiolabxv3 · M2（1.12.8）流式 STT 调研与方案

> 归属：本文档是 `audiolabxv3-ROADMAP.md` 中 **M2（1.12.8）Typeless 语音输入 / `stt_stream`** 一行的深化与修正。
> 调研日期：2026-06-30。
> 一句话结论：**「流式 STT」不是一个统一开关，而是按模型架构分三类**；Whisper 系与 Qwen 系恰好落在两个不同类里，支持方案完全不同。路线图里原先把 `stt_stream` 范例写成「sherpa-onnx 流式 / faster-whisper 增量」，本调研把它细化为按家族区分的具体路径。

---

## 一、核心认知：流式按架构分三类（决定方案）

| 类别 | 代表模型 | 是否原生流式 | 机理 | 对我们的意义 |
|---|---|---|---|---|
| **因果 / 流式原生 LLM-ASR** | **Qwen3-ASR**、Voxtral-Realtime | ✅ 原生 | 动态注意力窗（1~8s），逐 token 吐字 | **复用现有 vLLM 镜像**，最省、最契合「接口归本源」 |
| **编码器-解码器 30s 窗** | **Whisper** 全系 | ❌ 非原生 | 固定 30s 块，必须靠「缓冲 + LocalAgreement」外壳模拟流式 | 需引入 WhisperLive 类引擎；有 Blackwell GPU 退化坑 |
| **Transducer / RNNT 缓存感知** | NVIDIA Parakeet/Nemotron、sherpa Zipformer、FunASR Paraformer | ✅ 原生（最强） | 逐帧增量、缓存复用，真正低延迟 | 真流式 SOTA，但需新镜像/新运行时，列后续梯队 |

> 关键推论：Whisper 与 Qwen 之所以方案不同，根因在架构，而非「谁支持谁不支持」这么简单。

---

## 二、协议格局（决定网关与客户端怎么说话）

- **vLLM 已原生支持 OpenAI Realtime WebSocket API**（`/v1/realtime`，2026-01 合入，blog 2026-01-31，PR #33187）。
  - 事件流是标准 OpenAI Realtime：`session.created` → `session.update`（选模型）→ `input_audio_buffer.append`（base64 PCM16@16k 分块）→ `input_audio_buffer.commit`（可带 `final=true`）→ 服务端回 `transcription.delta`（增量）/ `transcription.done`（终稿+用量）。
  - **限制：vLLM 明确写「realtime 只服务架构上因果的模型」**（参考实现是 Mistral `Voxtral-Mini-*-Realtime`）。**Whisper 是编码器-解码器，上不了 `/v1/realtime`**。
- **WhisperLive（Collabora）** 是 Whisper 系的事实标准：faster-whisper 后端 + 自有 WebSocket 流式协议 + VAD（Silero），并同时暴露 OpenAI 兼容的 `/v1/audio/transcriptions`（REST 批量）。后端可选 `faster_whisper` / `tensorrt` / `openvino`。
- **FunASR / 阿里云 DashScope 实时协议**：阿里自家流式（Paraformer-streaming 2-pass，在线/离线），CPU 友好、带**句级时间戳**。

> **平台协议建议**：把基座流式对外**统一收敛到 OpenAI Realtime WS**（它是真标准、OpenAI 兼容、vLLM 原生）；对不原生说这套协议的引擎（如 Whisper/WhisperLive），在其前面加一层薄 WS wrapper 翻译协议——沿用我们「wrapper 复用镜像」的一贯范式。

---

## 三、两系的落地方案

### Qwen3-ASR（0.6B / 1.7B）——复用现有 vLLM 镜像（推荐第一波）
- 流式**仅限 vLLM 后端**；官方 `qwen-asr[vllm]` 工具包提供 `init_streaming_state` / `streaming_transcribe`（范例：2s 块、`unfixed_chunk_num=2`、`unfixed_token_num=5`，保留末几块不固定）。
- 网络化两条路：
  - **(a) `vllm serve … /v1/realtime`**：若该 vLLM 版本 + Qwen3-ASR 被 realtime 服务识别为「可流式模型」，则零 wrapper 直通（最干净，**待验证**；vLLM blog 致谢里有「Tao He, Alibaba Qwen」做 streaming input，方向乐观但未实锤 serve 端）。
  - **(b) 薄 WS wrapper**：在我们镜像里 `pip install qwen-asr[vllm]`，wrapper 跑官方工具包的 `streaming_transcribe`，对外暴露 OpenAI Realtime WS（思路同社区 `homorunner/Qwen3-ASR-Gateway`）。**最稳、最可控**。
- ⚠️ 官方明确：**流式模式不返回时间戳、不支持 batch**。
- 镜像：仍是 `beclab/vllm-vllm-openai:v0.23.0-cu129`（与 M1 的 Qwen3-ASR 同一个），按需补 `qwen-asr`。

### Whisper（建议 large-v3-turbo / small）——引入 WhisperLive 引擎（第二波）
- 非原生，必须 WhisperLive 这类**缓冲流式**服务，WS + VAD，顺带 OpenAI REST。
- ⚠️ **Blackwell（sm_120）坑**：faster-whisper 的 ct2 在 RTX 5090 上拿不到 GPU（同 M1 已踩，见 WORK_LOG_2026-06-25）→ 退化 CPU 速度。
  - 流式小模型 / turbo 在 CPU 上一般能跟上准实时；
  - 要 GPU，则上 WhisperLive 的 **TensorRT** 后端（更多构建工作）。
- 协议：WhisperLive 自有 WS；若要并入平台统一的 OpenAI Realtime WS，需 wrapper 翻译。

---

## 四、值得标注的「第三系」（后续梯队，真流式 SOTA）
- **NVIDIA Nemotron-Speech-Streaming / Parakeet**（缓存感知 FastConformer-RNNT）：0.6B、40 语种、延迟 **80ms~1.12s 可调（推理时选点，无需重训）**、Blackwell 原生支持、并发远超缓冲式。代价：**NeMo 运行时 = 新镜像 + 较大工作量**。
- **sherpa-onnx（Next-gen Kaldi，Zipformer transducer）**：ONNX、CPU 极轻、可跑 NeMo 导出的 checkpoint，适合边缘/无 GPU。
- **FunASR Paraformer-streaming**：与 Qwen 同厂的 CPU 方案，带句级时间戳。

---

## 五、⚠️ 结构性阻塞项与已定决策

- **路线图结构性事项①**：ingress + Gateway 增加 WebSocket 透传（M2 流式硬依赖）。
- **现状**：`llmgatewayv3` 是纯 HTTP 反代（provider 路由 + 超时/熔断那套，`configmap.yaml` 里 `read_timeout/timeout` 等），**没有 WS 升级/透传**。
- **已拍板决策（2026-06-30，用户）**：**给 `llmgatewayv3` 加 WebSocket 透传**（`/v1/realtime` 直通到 audio-engine），流式与批量统一从网关进。
  - 实现待验证项：网关那个 Go 反代是否支持 WS upgrade；若不支持，需在网关侧加 WS 反代逻辑，或在网关 Pod 前置一个轻量 WS 代理。
- **Demo 影响**：Qwen3-ASR 流式不返时间戳，与现 Demo「VAD/DIAR 时间轴融合」冲突；流式视图需单独设计为**滚动增量字幕**，而非分段时间轴。

---

## 六、推荐路线（待用户最终确认开工）
1. **第一波：Qwen3-ASR 流式**——复用现有 vLLM 镜像、原生流式、最契合原则、成本最低。先做 PoC 验证 (a) `/v1/realtime` 直通是否可行，不行则落 (b) wrapper。
2. **第二波：Whisper 流式**——引入 WhisperLive，处理 Blackwell GPU 退化（CPU 小模型 or TensorRT）。
3. **后续梯队**：Nemotron/Parakeet（真流式 SOTA，新镜像）、sherpa-onnx（CPU 轻量）、FunASR（阿里 CPU + 句级时间戳）。
4. 贯穿：网关 + ingress 的 WS 透传（结构性①），随第一波一并落。

> 当前状态：**仅调研落盘，未动手**（用户先消化）。网关策略已定（WS 透传）。

---

## 七、来源
- vLLM Realtime/Streaming：vLLM Blog《Streaming Requests & Realtime API in vLLM》(2026-01-31)；vLLM docs《Speech to Text APIs》；PR vllm-project/vllm#33187。
- Qwen3-ASR：`github.com/QwenLM/Qwen3-ASR`（README + `examples/example_qwen3_asr_vllm_streaming.py`）；Qwen3-ASR Technical Report (arXiv 2601.21337)；`homorunner/Qwen3-ASR-Gateway`；`DingPengfei/streamASR-api`。
- Whisper 流式：`collabora/WhisperLive`；`hwdsl2/docker-whisper-live`；`QuentinFuxa/WhisperLiveKit`。
- 第三系：`NVIDIA-NeMo/Speech`；`nvidia/nemotron-speech-streaming-en-0.6b`、`nvidia/nemotron-3.5-asr-streaming-0.6b`、`nvidia/parakeet-unified-en-0.6b`；arXiv 2604.14493《Pushing the Limits of On-Device Streaming ASR》。
