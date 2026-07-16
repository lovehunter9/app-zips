# Audio Lab X / Demo — 周一(2026-06-29)接着干 待办

> 周五(06-26)晚收尾留的笔记。本周成果：Qwen 在时分 vGPU 下提速达标
> (`GPU_CORE_UTILIZATION_POLICY=disable` 写死)、Whisper 走 faster-whisper(harveyff 镜像)
> 时分下达标、STT 引擎按模型名自动选、chart 清理完 UI clone 字段。

---

## 0. 周五收尾已完成(给老板周末兜底)

- **clone 了 4 个能力实例**(都 CPU，`AUDIO_REQUIRED_GPU_MEMORY=0`)，7 个实例已全部齐：
  - Translate → `audiolabxv38ab6b2`(`nllb-200-distilled-600M`)
  - Embed → `audiolabxv35db0f3`(`pyannote-embedding`)
  - Enhance → `audiolabxv31c4d10`(`speechbrain/mtl-mimic-voicebank`)
  - VAD → `audiolabxv306a333`(`silero-v5`)
  - **URL 用户提供 → 网关手动注册 provider（base_url=各实例 `/v1`）。**
- **Demo 镜像升级 `lovehunter9/audiostudioxdemo:1.0.1`**(已 push，linux/amd64，manifest `sha256:6128bc64…`)：
  - 去掉 STT 的 **MP3 转码保护**：整段无 VAD/Diar 时直接把原始音频(mp3/m4a…)一次性送引擎
    (两个引擎都已能直接解码压缩音频)；只有超大 RAW-WAV(视频提取)才 edgeSafe 转 mp3 过边缘。
  - **DIAR 整段化**：去掉客户端分块+声纹拼接，始终整段一次 `POST /v1/audio/diarization`。
  - chart `values.yaml`/`Chart.yaml` 同步到 `1.0.1`。**用户手动把镜像替换上去。**
- 死代码(`windowSegs`/`diarizeChunked`/`embedClip`/`DIAR_*`/`STITCH_SIM`/`embedModel`)留在
  `App.tsx` 里没删(`noUnusedLocals:false`，vite tree-shake 掉)。周一确认新逻辑没问题后可清理。

> VAD 已 clone(`06a333`)，但中文歌曲分段质量差，silero 参数留待周一调(见 §4，调好需先删后 clone)。

---

## 1. Qwen3-ASR 时间戳(最高优先，决定融合质量)

- **结论**：标准 vLLM OpenAI 端点 `/v1/audio/transcriptions` 不吐时间戳(`verbose_json` → 400
  “do not support verbose_json for Qwen3-ASR”)。官方时间戳要靠 **第二个模型
  `Qwen/Qwen3-ForcedAligner-0.6B`** + `qwen-asr[vllm]` 库的 API。
- 现成参考：`qwen-asr-serve` / `qwen-asr-demo --backend vllm --aligner-checkpoint <forced-aligner>`。
- **要做**：评估在 STT(qwen3-asr)引擎里改 serving 方式——
  - 方案 A：在 wrapper 里起 `qwen-asr-serve`(带 aligner)复刻 `/v1/audio/transcriptions` 契约，
    让它返回 segments(start/end/text)。优点：Demo 不用改；缺点：要再下一个 0.6B 模型 + 库依赖。
  - 方案 B：保持纯 vLLM(无时间戳)，Demo 对 Qwen 走「DIAR/VAD 分段 → 逐段 STT」拿时间轴
    (现状就是这样)。
- 决定后若选 A：engine.yaml 的 qwen3-asr 分支要加第二模型下载 + 改启动命令。

## 2. DIAR 提速(同 4 分钟音频 3 次 DIAR 比转写还慢)

- pyannote 确认在 cuda(日志 `loaded on cuda`)，`GPU_CORE_UTILIZATION_POLICY=disable` 已生效，
  但仍慢：分段→嵌入→聚类多段式 + 时分争用。
- **要做**：`wrappers.yaml` 的 `diar.py` 调 pyannote pipeline 的 `batch_size`(segmentation /
  embedding 推理批大小)，减少 kernel launch 次数。
- Demo 已改整段 DIAR：**周一先测**长音频(15min / 1h5m)整段 DIAR 是否能在 600s 网关内返回；
  若超时再考虑把「整段」做成「引擎内部分块」(服务端切，而不是客户端切)。

## 3. 另外 4 能力的「整段化 + 提速 + 漂亮融合」(用户主线)

用户想法：DIAR / EMBED / TRANSLATE / ENHANCE 尽量都整段处理，融合结果做漂亮。
- **ENHANCE**：整段在长音频 OOM(speechbrain 把整条波形上 GPU，1h≈15GiB)。
  → 在 `enhance.py` wrapper **服务端内部分块**(滑窗 enhance 后拼接)，对外仍是「整段」一次调用。
  顺便给 enhance 引擎上 GPU + disable 提速(周五是 CPU 兜底)。
- **TRANSLATE**：`translate.py` 加 **批处理**(一次请求多行)，配合 STT 分段结果逐行翻译但少 RTT。
- **EMBED**：本就轻；按说话人代表片段整段处理即可。
- **融合**：STT(有时间戳:whisper / 待定:qwen) × DIAR(整段原生说话人) × TRANSLATE(逐行) 对齐到
  统一时间轴(`App.tsx` 的 `merged`/`FusionView` 已有按 overlap 对齐的骨架)。

## 4. VAD 质量(中文歌曲)

- 旧版对英文说话还行，对中文歌曲分段差。调 `vad.py` 的 silero 阈值
  (`threshold` / `min_silence_duration_ms` / `min_speech_duration_ms` / `speech_pad_ms`)。
- 调好后 **先删后 clone**(title 照抄 `Audio Lab X VAD`)，URL 会变 → 网关更新。

## 5. chart UI clone 字段审计(用户 06-26 提的规则)

> 规则：用户在界面 clone 时只能填 manifest 里 `required:true`/`default:none` 的 env，
> 超出的要么加成可填字段、要么 chart 写死，否则用户没法用。
- 已做：`MODEL_ENGINE` 自动按模型名选(不暴露)、`GPU_CORE_UTILIZATION_POLICY=disable` 写死、
  删 `CUDA_DEVICE_SM_LIMIT`/`CUDA_DISABLE_CONTROL`、保留 `ENGINE_IMAGE/PORT/HEALTH_PATH/ARGS`
  仅作 CLI 高级逃生口(commit `f9c155a`)。
- **待办**：再过一遍 `OlaresManifest.yaml` 全部 env，逐个确认「UI 能填 or 已写死」，
  把还需用户区分的(如 `MODEL_SOURCE`/`MODEL_NAME`/`MODEL_MODE`/`AUDIO_REQUIRED_GPU_MEMORY`)
  确认在 clone 对话框可见。

---

## 铁律备忘(别再踩)

- 同版本 chart 改了**必须先 `market delete` 再 `upload`**，否则市场仍发旧渲染。
- 删 chart 前**先卸载所有该 chart 的 clone 实例**，否则 `market delete` 被挡。
- 实例 public URL **查不到 → 直接问用户**(`settings apps entrances list` 的 url 恒空)。
- title 是 URL hash 的输入，但**实测 clone 名变 → URL 也变**；重建后 base_url 都要让用户手动更网关。
- 改 STT 引擎的实例、删除重建都按上面铁律走，别擅自让用户手动跑 clone。
