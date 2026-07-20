# llm-init 改动方案（audiobase 分支）

> 只读探查 `~/beclab/llm-init` 源码后整理，**尚未改任何 llm-init 代码**（工作区外写入需你授权）。
> 目标镜像：`docker.io/lovehunter9/llm-init:v1.3.2-audiobase1`。

---

## 基线（已定）：基于 main 干净重写

- 分支 `feat/audio-base` 基于 `main`。**不基于** `feat/stt-relative`(PR#44) 改写——干净重写是本次的初衷。
- `feat/stt-relative`(PR#44) 的音频代理（`ENGINE_KIND=audio` 反代 `/v1/*`、`/v1/models` 合成、WS 透传、按-mode 端点目录）**仅作参考**，按需借鉴其做法，不合并、不 rebase。
- support 键用**裸键**（`stt` / `stt_stream` / `align` …），不加 `supports_` 前缀。chart 已按裸键接好。

---

## 一、config 层（已精确定位，改动小）

文件：`internal/config/config_enums.go`、`config_load_model.go`、`modelspec.go`

1. **新增 `MODEL_MODE=audio`**：
   - `config_enums.go`：`ModelType` 加 `ModelAudio ModelType = "audio"`；`allowedModelType` 从 `{chat, embedding}` 扩为 `{chat, embedding, audio}`。
   - 影响：`loadSpec()` 里 `parseEnum("MODEL_MODE", v, allowedModelType)` 才会放行 audio。

2. **`MODEL_SUPPORTS` 机制已存在，直接复用**：
   - `config_load_model.go` 的 `parseSupportsCSV()` 已解析 CSV 且**未知键 fail-fast**（正好符合"未知词拒绝"决策）。
   - `modelspec.go` 的 `knownSupports` = gateway `AllSupports` 的镜像（全是 `supports_*` 键）。
   - **需新增音频能力键**（见下"support 词表"），加进 `knownSupports`（= gateway `AllSupports` 也要同步，见线 C）。

3. **support 键命名（已定：裸键）**：
   - 音频 supports 用裸键 `stt` / `stt_stream` / `align` …（不加 `supports_` 前缀），自成一类"端点门控"，与 LLM 的 `supports_*` feature flag 分开。
   - chart 已按裸键接好（engine 容器与 llm-init 容器都传裸 `MODEL_SUPPORTS`），llm-init 无需展开。
   - 干净重写时：给音频建一套独立的 `knownAudioSupports`（裸键集合）供 `parseSupportsCSV` 在 `MODEL_MODE=audio` 时校验，不必混进 LLM 的 `knownSupports`(`supports_*`)。

## 二、数据面 / 端点门控（在 PR#44 音频代理基础上改）

文件：`internal/adapter/proxy/adapter.go`、`internal/controlplane/endpoints.go`、`controlplane/modelspec.go`

4. **端点暴露：从"按 MODEL_MODE"改成"按 MODEL_SUPPORTS"**：
   - PR#44 现在是 `ENGINE_KIND=audio` 按单一 `MODEL_MODE` 放行一组 `/v1/audio/*`。
   - 改为：遍历 `Spec.Supports`，对每个开启的能力放行其对应端点（一实例可多端点并存）。
   - support → 端点映射（内置表）：

     | support | 端点 |
     |---|---|
     | stt | `POST /v1/audio/transcriptions` `/translations` |
     | stt_stream | `WS /v1/audio/stream` |
     | vad | `POST /v1/audio/vad` |
     | diar | `POST /v1/audio/diarization` |
     | diar_stream | `WS /v1/audio/diarize/stream` |
     | align | `POST /v1/audio/align`(+`/v1/align`) |
     | enhance | `POST /v1/audio/enhance` |
     | speaker_embed | `POST /v1/audio/embeddings` |
     | tts / tts_clone / tts_dialogue / audio_llm / audio_s2s / sound_fx | 词表登记，暂无引擎、不放行 |

5. **`/v1/models` 合成**（`controlplane/modelspec.go`）：自报 `mode=audio` + `supports` 列表。

6. **dashboard/端点目录**（`endpoints.go`）：从"按 mode 显示"改成"遍历 supports 显示"。

## 三、HF 元数据预检（下载前，几秒内 fail-fast）

现成基础：`internal/adapter/hfwrap/`（`classify.go` / `refs_reader.go` / `scanner.go`）已能读 HF 仓库元数据。

7. 新增预检：下载大权重**前**，拉 `config.json`/文件清单/model card，推断 `arch/model_type → 可支持能力 + 适配引擎`；
   - `MODEL_SUPPORTS` 与推断不符（如 Whisper 架构却勾了 `stt_stream`）→ readyz fail + 明确报错；
   - 模型格式与本 base 引擎不符（如 ct2 模型进 vLLM base）→ 同样 fail；
   - 推断不了的回落到"声明 + load 时兜底"。

## 四、support 词表（= 音频 mode 全表，embed→speaker_embed）
`stt / stt_stream / vad / diar / diar_stream / align / enhance / speaker_embed / tts / tts_clone / tts_dialogue / audio_llm / audio_s2s / sound_fx`

> `translate`（文字→文字翻译）**不在音频词表**，由文字模型侧负责。

## 五、验收
- `go build ./... && go test ./internal/config/... ./internal/adapter/proxy/... ./internal/controlplane/...`
- 构建镜像 `lovehunter9/llm-init:v1.3.2-audiobase1`（人工/你侧）。
