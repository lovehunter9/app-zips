# audiolabx2v3 — llm-init audio-proxy validation chart (ledger)

Fork of `audiolabxv3` to validate the **NGINX-free** path: `llm-init` (ENGINE_KIND=audio)
downloads the model AND reverse-proxies the engine's OpenAI-compatible `/v1/*` (incl. WS)
directly. Entrance points at `download-svc:8090` (the llm-init console + data plane), no
openresty sidecar. RULE 0/1/2 are identical to audiolabxv3 — see
`.cursor/skills/audiolabxv3-instances/SKILL.md` (clone form = title + exactly 4 env; never
pass any other env).

## Current image / code (2026-07-16)

- llm-init image: `docker.io/lovehunter9/llm-init:v1.3.2-test2` (linux/amd64).
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

## WS test recipe (no gateway, no auth on these entrances)

`/tmp/wsx` venv (`websockets soundfile numpy`); client `/tmp/ws_test.py` (MUST pass
`proxy=None`). Protocol: `{"type":"start","sample_rate":16000[,"step_ms":500]}` → PCM16LE
16k mono binary chunks → `{"type":"stop"}`; read `ready`/`partial`/`final`.
