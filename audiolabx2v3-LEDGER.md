# audiolabx2v3 — llm-init audio-proxy validation chart (ledger)

Fork of `audiolabxv3` to validate the **NGINX-free** path: `llm-init` (ENGINE_KIND=audio)
downloads the model AND reverse-proxies the engine's OpenAI-compatible `/v1/*` (incl. WS)
directly. Entrance points at `download-svc:8090` (the llm-init console + data plane), no
openresty sidecar. RULE 0/1/2 are identical to audiolabxv3 — see
`.cursor/skills/audiolabxv3-instances/SKILL.md` (clone form = title + exactly 4 env; never
pass any other env).

## Current image / code (2026-07-17)

- llm-init image: `docker.io/lovehunter9/llm-init:v1.3.2-test3` (linux/amd64,
  manifest `sha256:80bb109783cf3baaf7be2cf166e342ae857bd0ed21df311773a67fa29a2b8ef6`).
  - **NEW in test3 — audio-aware endpoint catalog (`controlplane/endpoints.go`).** The
    dashboard "支持的端点 / API 格式" panel used to list the generic LLM surface
    (`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/responses`,
    OpenAI+Anthropic) for EVERY audio instance — wrong (audio-proxy never serves those).
    Now `ENGINE_KIND=audio` emits a per-`MODEL_MODE` **`data-plane-audio`** category and
    drops the LLM rows; dashboard.js gained an `Audio` format bucket (`data-plane-audio`).
    Mapping: stt→`/v1/audio/transcriptions`+`/translations`; stt_stream→WS `/v1/audio/stream`;
    diar→`/v1/audio/diarization`; diar_stream→WS `/v1/audio/diarize/stream`;
    vad→`/v1/audio/vad`; translate→`/v1/translate`; embed→`/v1/audio/embeddings`;
    enhance→`/v1/audio/enhance`; align→`/v1/audio/align`(+`/v1/align`); tts→`/v1/audio/speech`;
    all modes always keep GET `/v1/models`. Data plane / proxy behaviour UNCHANGED.
- llm-init image (prev): `docker.io/lovehunter9/llm-init:v1.3.2-test2` (linux/amd64).
- Branch `feat/stt-relative`:
  - `cb2c97e` feat: ENGINE_KIND=audio proxy adapter (synthesizes `/v1/models` at the edge,
    health probes `/healthz`→`/health`, ResponseHeaderTimeout 3600s for long transcriptions,
    upstream hardcoded `http://audio-engine:8000`, MODEL_MODE relaxed to all audio modes).
  - `ca35450` fix: pass Hijack/Flush/Unwrap through the dataplane metrics `statusRecorder`
    — WITHOUT this, WS upgrades (stt_stream/diar_stream) fail the reverse-proxy's
    http.Hijacker assertion with 502. This is the reason for the test2 rebuild.

## RULE-1 rebuild verified (2026-07-16)

Full cycle ran with test2: uninstall 10 → `market delete audiolabx2v3` → `market upload
audiolabx2v3-1.0.0.tgz` → re-clone 10 (title + 4 env only). **9/10 hashes reproduced
identically (URLs unchanged); only Enhance moved** (`8b99e4`→`0e4d03`) because it was
re-cloned with `AUDIO_REQUIRED_GPU_MEMORY=2Gi` (aligning to audiolabxv3; the prior x2v3
clone was almost certainly GPU=0). All 10 engines `1/1 ready`, restarts=0; all llm-init `1/1`.

WS e2e through the llm-init test2 proxy (public entrance, no auth needed):
- STT Stream `wss://.../v1/audio/stream`: HANDSHAKE OK 2.1s → ready + 11 partials + final
  `"Ask not what your country can do for you. Ask what you can do for your country."` (English). PASS.
- Diar Stream `wss://.../v1/audio/diarize/stream`: HANDSHAKE OK 1.4s → ready + partial + final
  (segments/speakers well-formed). PASS. (Short synthetic clip resolved 1 speaker — a known
  streaming-diar quality limit on synthetic audio, NOT a proxy issue.)

## Instance ledger (verify engine container name = real model, not the title)

| Cap | Title | App name / NS | MODEL_SOURCE | MODEL_NAME | MODE | GPU | Public URL |
|---|---|---|---|---|---|---|---|
| STT faster-whisper | AudioX2 STT Whisper | `audiolabx2v30263ef` | `hf://Systran/faster-whisper-large-v3` | `Systran/faster-whisper-large-v3` | stt | 6Gi | ask user |
| STT Qwen3-ASR | AudioX2 STT Qwen3ASR | `audiolabx2v393e848` | `hf://Qwen/Qwen3-ASR-1.7B` | `Qwen/Qwen3-ASR-1.7B` | stt | 12Gi | ask user |
| STT Stream (WS) | AudioX2 STT Stream | `audiolabx2v3b0c2ed` | `hf://Qwen/Qwen3-ASR-1.7B` | `Qwen/Qwen3-ASR-1.7B` | stt_stream | 12Gi | https://2b852a1f.olarestest003.olares.com |
| Diar Stream (WS) | AudioX2 Diar Stream | `audiolabx2v39c4797` | `hf://nvidia/diar_streaming_sortformer_4spk-v2.1` | `diar-streaming-sortformer` | diar_stream | 6Gi | https://8121ae10.olarestest003.olares.com |
| Diar | AudioX2 Diar | `audiolabx2v3818606` | `hf://pyannote/speaker-diarization-community-1` | `pyannote-community-1` | diar | 4Gi | ask user |
| VAD | AudioX2 VAD Test | `audiolabx2v3dd1ed9` | `hf://onnx-community/silero-vad` | `silero-v5` | vad | 0 | ask user |
| Translate | AudioX2 Translate | `audiolabx2v353f4c2` | `hf://entai2965/nllb-200-distilled-600M-ctranslate2` | `nllb-200-distilled-600M` | translate | 0 | ask user |
| Embed | AudioX2 Embed | `audiolabx2v3cdcb44` | `hf://pyannote/embedding` | `pyannote-embedding` | embed | 0 | ask user |
| Enhance | AudioX2 Enhance | `audiolabx2v30e4d03` (was `8b99e4`) | `hf://speechbrain/mtl-mimic-voicebank` | `mtl-mimic-voicebank` | enhance | 2Gi | https://46c47e67.olarestest003.olares.com |
| Align | AudioX2 Align | `audiolabx2v3c84c8e` | `hf://Qwen/Qwen3-ForcedAligner-0.6B` | `Qwen/Qwen3-ForcedAligner-0.6B` | align | 4Gi | ask user |

Internal engine URL per instance: `http://audio-engine.<app>-shared:8000`. llm-init data
plane / console: entrance → `download-svc.<app>-shared:8090`.

## Second translation model — m2m100 (commercial default) — code staged 2026-07-16

Only NLLB-200 among all cloned models is non-commercial (CC-BY-NC); the rest are
MIT/Apache/NVIDIA-Open/CC-BY-4.0. Per the boss's "add, don't replace / self-adaptive /
keep NLLB opt-in-runnable" mandate, `translate.py` is now an **adapter architecture**
(commit staged in `audiolabx2v3/templates/wrappers.yaml`):

- External API is FIXED to FLORES-200 for ALL models (gateway/Demo unchanged).
- Adapter is auto-picked from `MODEL_NAME` (same idea as stt engine auto-select), so NO new
  clone-form env (RULE-2 intact — still title + 4 env). Advanced `TRANSLATE_ADAPTER` override
  exists via olaresEnv only, never in the clone form.
  - `m2m100` (MIT, COMMERCIAL default): `transformers` M2M100Tokenizer + sentencepiece;
    FLORES→ISO by 3-letter prefix (103 langs mapped); target model
    `entai2965/m2m100-1.2B-ctranslate2`.
  - `nllb` (default/back-compat, **byte-identical** to the old wrapper): `tokenizers` +
    tokenizer.json; NLLB codes ARE FLORES-200. Existing NLLB instance is UNAFFECTED and stays
    runnable for users who explicitly pick it (never offered by default).
- No `engine.yaml` change: both ride CPU ctranslate2 on the SAME pyannote image; m2m100
  pip-installs `transformers`+`sentencepiece` on first load (embed/enhance on-demand pattern).
- Validated: `helm template` renders clean; all 9 embedded wrappers `py_compile` OK.

**RULE-1 rebuild SHIPPED 2026-07-16.** Repackaged `audiolabx2v3-1.0.0.tgz` (m2m100 adapter
in `wrappers.yaml`) → uninstall 10 → `market delete` → `market upload` → re-clone 11. **All 10
originals reproduced their EXACT hashes → public URLs UNCHANGED, no provider re-pointing:**
0263ef / 93e848 / b0c2ed / 9c4797 / 818606 / dd1ed9 / 53f4c2 (NLLB) / cdcb44 / 0e4d03 / c84c8e.

NEW m2m100 instance (the commercial default translate):

| Cap | Title | App name / NS | MODEL_SOURCE | MODEL_NAME | MODE | GPU | Public URL |
|---|---|---|---|---|---|---|---|
| Translate m2m100 | AudioX2 Translate m2m100 | `audiolabx2v354d617` | `hf://entai2965/m2m100-1.2B-ctranslate2` | `m2m100-1.2B` | translate | 0 | ask user |

Adapter auto-detects `m2m100` from MODEL_NAME → transformers/sentencepiece path (pip-installed
on first load). NLLB instance `53f4c2` uses the byte-identical `nllb` adapter. Verification of
m2m100 `/v1/translate` pending (engine still downloading model at handoff).

## RULE-1 rebuild for test3 (audio endpoint catalog) — SHIPPED 2026-07-17

Bumped chart image test2→test3, repackaged `audiolabx2v3-1.0.0.tgz`, ran the full cycle
(uninstall 11 → `market delete` → `market upload` → re-clone 11). **All 11 hashes reproduced
EXACTLY → public URLs UNCHANGED, no provider re-pointing:** 0263ef / 93e848 / b0c2ed / 9c4797
/ 818606 / dd1ed9 / 53f4c2 / cdcb44 / 0e4d03 / c84c8e / 54d617. All 11 `running` within ~1min
(models + engine images already cached). Clone form = title + 4 env only (RULE-2 intact).

**Verified the fix on the 3 instances with known public URLs** (`GET /api/endpoints`, no auth):
- STT Stream `b0c2ed` (`2b852a1f`): `engine_kind=audio`, audio rows = WS `/v1/audio/stream` +
  GET `/v1/models`; **no data-plane-openai / anthropic rows**. Correct.
- Diar Stream `9c4797` (`8121ae10`): WS `/v1/audio/diarize/stream` + `/v1/models`; no LLM leak.
- Enhance `0e4d03` (`46c47e67`): POST `/v1/audio/enhance` + `/v1/models`; no LLM leak.

Other 8 instances' per-mode rows are covered by `TestEndpoints_AudioModeRoutes`
(stt_stream/diar_stream/vad/diar/translate/embed/enhance/align) in llm-init.

## RULE-1 rebuild for engine "安装中→暂停" fix — SHIPPED 2026-07-17 (evening)

Root cause: `engine.yaml` had a blocking `wait-models` initContainer + a readinessProbe, so
the engine Pod stayed `Init:0/1` for the WHOLE model download → app never `running` → progress
page unreachable → market install watcher timed out to 暂停. Fix (mirrors llamacpp): moved the
sentinel wait INTO the engine container command (`$waitSentinel`, reads
`/run/llm-init/model_download_finish`), dropped the initContainer AND the readinessProbe, mounted
`run-state` (ro) in the main container. Pod is Ready instantly → app `running` in seconds while the
model downloads; engine-not-ready still 503-gated by llm-init's NotReadyGuard.

**RULE-1 executed correctly this time** (chart source = `upload`, so `clone` needs `-s upload`;
`uninstall` is ASYNC — must wait for all rows to disappear before `market delete`). Full cycle:
uninstall 11 → wait → `market delete` → `market upload audiolabx2v3-1.0.0.tgz` → re-clone 11 `-s upload`
+ 1 NEW validation model. **All 11 original hashes reproduced EXACTLY → public URLs UNCHANGED, no
provider re-pointing:** 0263ef / 93e848 / b0c2ed / 9c4797 / 818606 / dd1ed9 / 53f4c2 / cdcb44 /
0e4d03 / c84c8e / 54d617.

NEW validation instance (a model we'd never used, so its weights actually download):

| Cap | Title | App name / NS | MODEL_SOURCE | MODEL_NAME | MODE | GPU | Public URL |
|---|---|---|---|---|---|---|---|
| STT Whisper (OpenAI/vLLM) | AudioX2 STT WhisperOpenAI | `audiolabx2v3f90455` | `hf://openai/whisper-large-v3` | `openai/whisper-large-v3` | stt | 8Gi | ask user |

**Fix VERIFIED:** `f90455` reached `state=running` within ~1min while the ~3GB model was still
downloading (engine image cached from Qwen3-ASR's vLLM). i.e. app is `running` + llm-init progress
page reachable DURING download — the exact behaviour that used to hang 安装中→暂停. All 12 `running`.

> **`olares-cli market clone` gotcha:** default source is `market.olares`; our chart lives in
> `upload`, so clone MUST pass `-s upload` or it fails `app '<x>' not found in source 'market.olares'`.
> `market uninstall` is async ("uninstall requested"); poll `market list --mine` until the rows are
> gone before `market delete`, else delete fails "still installing/running".

## WS test recipe (no gateway, no auth on these entrances)

`/tmp/wsx` venv (`websockets soundfile numpy`); client `/tmp/ws_test.py` (MUST pass
`proxy=None`). Protocol: `{"type":"start","sample_rate":16000[,"step_ms":500]}` → PCM16LE
16k mono binary chunks → `{"type":"stop"}`; read `ready`/`partial`/`final`.
