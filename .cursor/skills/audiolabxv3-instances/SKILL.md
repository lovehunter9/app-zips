---
name: audiolabxv3-instances
description: >-
  Live ledger + clone recipes for the audiolabxv3 audio-base instances (STT/VAD/
  Diar/Translate/Embed/Enhance) on this Olares, and the hard rule that an Olares
  cloned-app PUBLIC entrance URL is NOT discoverable via olares-cli and must be
  asked from the user. Use whenever working with audiolabxv3 clones, their
  public URLs, re-cloning an instance, or wiring an audiolabxv3 provider into the
  LLM Gateway.
---

# audiolabxv3 instances

## RULE 1 (IRON LAW) — olares-cli can NEVER edit in place: delete + reinstall, always

There is **no** in-place edit path for a deployed Olares app. Do **NOT** waste the
user's time/tokens looking for `kubectl edit` / configmap-patch / deployment-restart
/ `market upgrade` shortcuts — **none of them are usable here** and the user has
banned trying. Any change to chart templates, the `wrappers` ConfigMap, env, image,
or values requires the full cycle:

1. `market uninstall <instance>` (every affected clone)
2. `market delete audiolabxv3` (only possible once NO clones of it are installed)
3. `market upload audiolabxv3-1.0.0.tgz` (re-package first if templates changed)
4. `market clone audiolabxv3 -s upload --title "<EXACT TITLE>" --env ... --watch`

**Same-version (`1.0.0`) re-`upload` WITHOUT a prior `market delete` does NOT refresh
the manifest the market validates/serves** (confirmed 2026-06-26: new `MODEL_ENGINE`
option was rejected on clone until delete+upload). And `market delete` is **blocked
while any clone is installed** → so to push a chart change you must uninstall the
clones that block delete. Don't bump the chart version to dodge this without the
user's explicit OK (they want 1.0.0 kept).

Re-clone mints a **new** app-name hash → **new public URL** → the user must
re-register/re-point the Gateway provider. Tell them the new URL; never assume it
stayed.

## RULE 0 — what olares-cli CANNOT give you: ASK, never search

`olares-cli` does **NOT** return a cloned app's **public entrance URL**
(`https://<8hex>.olarestest003.olares.com`). Confirmed: both
`settings apps entrances list <app>` and its `-o json` return `"url": ""`.

So **never burn time/tokens searching transcripts or grepping for an instance's
public URL.** If you need a public URL you don't have in the ledger below, **ask
the user directly.** The user maintains these and will paste them.

Likewise, **always ask the user** for anything olares-cli can't surface:
- public entrance URL of any clone (the `<8hex>` host),
- the LLM Gateway URL + API Key,
- whether a Gateway provider still points at a given instance.

What you CAN read from olares-cli (do NOT ask the user for these):
- instance app name / state / title: `market list --mine -o json`
- per-instance model env (`MODEL_MODE/MODEL_NAME/MODEL_SOURCE`):
  `cluster container env <ns>/<pod>`
- pods / logs: `cluster pod list -n <ns>`, `cluster container logs <ns>/<pod>/<container>`

## Hash / URL stability

Re-cloning mints a **new** app-name hash and a **new** public URL. Observed: VAD
re-cloned with a *different* title (`Audio Lab X VAD` instead of the original
`Audio Lab X V3 VAD`) got a new hash (`aa0460` → `06a333`) and new URL. To
maximize the chance of reproducing the same hash/URL on re-clone, **reuse the
EXACT recorded title.** If the URL still changes, the user re-points the Gateway
provider manually — tell them the new URL.

## GOTCHA — OlaresManifest env `default` OVERRIDES the chart template default

A clone-form env declared in `OlaresManifest.yaml` (`spec.options.appScope`/env list with
`default: "X"`) is **injected into `olaresEnv` at clone time**, so inside templates
`{{ $oe.FOO | default "Y" }}` sees the MANIFEST default "X", NOT the template default "Y".
Local `helm template` (which doesn't set `olaresEnv.FOO`) falls through to "Y" and **hides
the discrepancy**. So to change a resolved value you must edit BOTH the template default AND
the `OlaresManifest.yaml` `default:` (the manifest one is what actually lands). Confirmed
2026-07-01: bumping only the engine.yaml `AUDIO_MEMORY_LIMIT` template default 18Gi→24Gi
left the deployed pod at 18Gi because `OlaresManifest.yaml` still declared `default: "18Gi"`.
Editing a manifest `default:` is chart content ⇒ hash/URL stable on re-clone (same as a
template edit) — it does NOT count as a per-clone `--env` override.

## Live ledger (update after any re-clone)

> **2026-07-01 STATE: the 8 offline clones below are currently UNINSTALLED.** To ship the new
> `stt_stream` mode (a chart change) the full rebuild ran (uninstall all 8 → delete chart →
> upload → clone stt_stream). Only `stt_stream` is live now; the 8 are pending rebuild (their
> recipes below are unchanged, so re-clone reproduces the same hashes/URLs). Rebuild when the
> user says stt_stream is stable.

| Cap | Title (exact, hash input) | App name | Namespace | Public URL | Internal URL |
|---|---|---|---|---|---|
| **STT Stream (Qwen3-ASR, WS)** | `Audio Lab X V3 STT Stream` | `audiolabxv30f9f88` | `audiolabxv30f9f88-shared` | `https://d123f7e6.olarestest003.olares.com` | `http://audio-engine.audiolabxv30f9f88-shared:8000` (WS `/v1/audio/stream`) |
| STT faster-whisper | `Audio Lab X V3 STT` | `audiolabxv3b2b539` | `audiolabxv3b2b539-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv3b2b539-shared:8000` |
| STT Qwen3-ASR | `Audio Lab X V3 Qwen3-ASR` | `audiolabxv3a0bbb6` | `audiolabxv3a0bbb6-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv3a0bbb6-shared:8000` |
| VAD | `Audio Lab X VAD` | `audiolabxv306a333` | `audiolabxv306a333-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv306a333-shared:8000` |
| Diar | `Audio Lab X V3 Diar` | `audiolabxv34c7e4e` | `audiolabxv34c7e4e-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv34c7e4e-shared:8000` |
| Translate | `Audio Lab X V3 Translate` | `audiolabxv38ab6b2` | `audiolabxv38ab6b2-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv38ab6b2-shared:8000` |
| Embed | `Audio Lab X V3 Embed` | `audiolabxv35db0f3` | `audiolabxv35db0f3-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv35db0f3-shared:8000` |
| Enhance (GPU 2Gi) | `AudioLabX Enhance` | `audiolabxv3d616f5` (was `1c4d10`) | `audiolabxv3d616f5-shared` | **NEW → ask user** | `http://audio-engine.audiolabxv3d616f5-shared:8000` |
| Align (GPU 4Gi) | `Audio Lab X V3 Align` | `audiolabxv3396efb` | `audiolabxv3396efb-shared` | `https://3276066a.olarestest003.olares.com` | `http://audio-engine.audiolabxv3396efb-shared:8000` |

> 2026-07-01 STT STREAM (mode=stt_stream, Qwen3-ASR-1.7B, WebSocket): NEW capability, VERIFIED
> end-to-end via a WS client (中文 asr_zh.wav + 英文 asr_en.wav → correct incremental partials +
> final). Separate app clone (`Audio Lab X V3 STT Stream`, `audiolabxv30f9f88`,
> `https://d123f7e6.olarestest003.olares.com`), NOT merged with offline stt — Qwen streaming runs
> a DIFFERENT process (qwen-asr in-process vLLM) than offline `vllm serve`, so they can't share
> one instance. Engine = same **vLLM cu129** image, wrapper `/wrappers/stream.py` bridges
> qwen-asr's `Qwen3ASRModel.LLM` streaming API (`init_streaming_state` / `streaming_transcribe` /
> `finish_streaming_transcribe`) to a WebSocket `/v1/audio/stream` (simple JSON+PCM16 protocol:
> client sends `{"type":"start"}` + binary PCM16 16k mono + `{"type":"stop"}`; server sends
> `ready`/`partial`/`final`). Streaming returns NO timestamps (by design) → rolling-caption, not
> timeline. **Path decision:** `vllm serve` has NO realtime/WS endpoint for Qwen3-ASR (its serve
> = offline /v1/chat/completions + /v1/audio/transcriptions only); streaming ONLY lives in the
> qwen-asr package's in-process vLLM backend → the WS wrapper is the only path (confirmed from
> QwenLM/Qwen3-ASR README + example_qwen3_asr_vllm_streaming.py).
> **TWO install/config gotchas (cost 2 rebuild iterations, both fixed in the chart):**
> (1) **Do NOT `pip install qwen-asr[vllm]`** — the `[vllm]` extra makes pip re-resolve/redownload
>     the whole vLLM stack and HANGS the container (30min+, silent under `-q`). vLLM is ALREADY in
>     the cu129 image, so install PLAIN `qwen-asr` (align.py does the same). ~2min, reuses image vLLM.
> (2) **Must pass `max_model_len` to `Qwen3ASRModel.LLM(...)`** — Qwen3-ASR defaults to 65536 →
>     needs ~7GiB KV cache, but the 12Gi HAMI quota leaves only ~2.41GiB after weights → vLLM
>     `EngineCore` ValueError-crashes at init ("estimated maximum model length is 22544"). Wrapper
>     now passes `max_model_len=16384` (env `STREAM_MAX_LEN`; plenty for 2s streaming chunks; the
>     offline qwen serve does the equivalent via `--max-model-len`). `gpu_memory_utilization` +
>     `max_model_len` ARE forwarded by qwen-asr's LLM wrapper to vllm.LLM.
> **Startup visibility:** the wrapper block-loads the vLLM engine on the MAIN thread BEFORE uvicorn
> (vLLM `LLM()` needs the main thread for signal handlers), so /healthz 503s until ready and there
> is NO health during load. It prints `[stream] ...` breadcrumbs (pip → constructing LLM → READY)
> to stdout. When debugging a 0/1 pod, `container logs --tail 0` (default tail=200 gets buried by
> the 10s /healthz 503 spam). Cold start ≈ pip ~2.5min + vLLM load ~1.5min ≈ 4–5min to 1/1.
> **WS test recipe (no gateway needed — the openresty entrance already passes WS upgrades):**
> `venv: pip install websockets soundfile numpy`; connect `wss://<public>/v1/audio/stream`; send
> `{"type":"start","sample_rate":16000,"step_ms":500}` then PCM16LE 16k-mono chunks then
> `{"type":"stop"}`; read `partial`/`final`. Client script kept at `/tmp/ws_client.py`.
> NOTE: while the engine pod is 0/1 (loading/failed) the k8s Service excludes it → openresty
> `proxy_pass audio-engine:8000` returns **502** on the WS handshake (not the wrapper's error).
>
> 2026-07-01 PERSISTENT DEPS — restart never re-installs (engine.yaml, ALL modes): the base
> image is `latest`-tag-only + on-demand pip means a POD RESTART used to re-`pip install`
> everything into the ephemeral container FS (network-dead users hang; qwen-asr modes eat
> ~2.5min each restart). FIX (no new image, no llm-init change): all cmd/wrapper pip now
> installs into a **hostPath venv at `/pydeps`** (`appData/pydeps`, mounted `/pydeps`), created
> `python3 -m venv --system-site-packages` so the image's torch/vLLM/CUDA build is reused (only
> the missing extras — qwen-asr/librosa/silero-vad/speechbrain/ctranslate2/fastapi — land in the
> venv). `$pydepsPrelude` (prepended to EVERY engine cmd) makes/reuses the venv and prepends its
> bin to PATH, so the UNCHANGED cmds transparently use it: `python3`/`pip`→venv (installs persist,
> wrapper `try import` succeeds on restart → no pip), while `vllm` (system console script, not in
> venv bin) still runs the image build with venv audio-extras visible via PYTHONPATH. Cmd-level
> pip is gated by per-mode sentinels `/pydeps/.{stt,stt_stream,align,fw}.ok` → skipped entirely on
> restart (NO PyPI hit). Contract honored: **first install / uninstall+reinstall** repopulate
> (model download happens anyway); **restart re-installs NOTHING**. Falls back to ephemeral system
> installs if venv can't be created (no worse than before). `/pydeps` is per-instance (appData) so
> each clone downloads once on first start; not shared across clones (kept simple, race-free).
> **VERIFIED 2026-07-01** on the rebuilt stt_stream clone (`audiolabxv30f9f88`, re-uploaded new
> tgz + re-cloned): first install ran pip into the venv normally; a `cluster pod restart` then came
> back 1/1 with **ZERO pip activity** in logs (no Collecting/Downloading/Successfully installed, no
> "creating persistent venv") — first `[stream]` line post-restart was `constructing ...LLM`, i.e.
> sentinel `/pydeps/.stt_stream.ok` hit + venv reused, pip fully skipped. Restart→ready ≈ 1m46s of
> pure vLLM load (vs first install's +~2.5min pip). Re-clone reused the SAME hash
> `audiolabxv30f9f88` → public URL likely unchanged (`https://d123f7e6.olarestest003.olares.com`,
> confirm with user per RULE 0).
>
> 2026-07-01 Qwen3-ASR OOM FIX (full rebuild, all 8, URLs unchanged): Qwen3-ASR pod was
> periodically `OOMKilled` (exit 137) at the 18Gi container RAM limit → K8s restart → 502
> window (vLLM slow to boot). Root cause = host-RAM peak under concurrent long-audio load,
> NOT GPU VRAM (no CUDA error). Fix, all URL-stable (chart-content only, no clone-env change):
> (a) `AUDIO_MEMORY_LIMIT` default 18Gi→**24Gi** — in BOTH engine.yaml AND OlaresManifest.yaml
> (the manifest default is the one that lands; see GOTCHA above); (b) vLLM stt/qwen cmd adds
> `--mm-processor-cache-gb ${VLLM_MM_CACHE_GB:-1}` (caps the multimodal processor cache 4Gi→1Gi;
> the OLD `--disable-mm-preprocessor-cache` is REMOVED in vLLM ≥0.13, must use the new flag);
> (c) Demo lowers the Qwen fan-out default (def 4→2, max 8→6). Node has ~94GiB RAM, so 24Gi cap
> is cheap. Verified Qwen pod: 24Gi limit + mm-cache flag live + 1/1 Running. Two rebuild passes
> were needed (first pass only edited the engine.yaml default and silently kept 18Gi).

> 2026-06-30 ALIGN (forced alignment, Qwen3-ForcedAligner-0.6B): NEW capability. Wrapper
> `align.py` (qwen-asr `Qwen3ForcedAligner.align()`, end-to-end timestamps). Engine = reuses
> the **vLLM cu129** image (recent transformers + Blackwell torch), NOT pyannote. Engine cmd
> pip-installs qwen-asr on first load; needed `pip install --ignore-installed blinker` first
> (cu129 image ships a distutils blinker 1.4 pip refuses to uninstall → install aborted).
> Serves BOTH `/v1/align` (direct/contract) and `/v1/audio/align` (the path the Gateway uses,
> same multipart family as vad/diar/embed/enhance). **Verified** direct curl: 13/13 Chinese
> chars with monotonic per-char timestamps, ~5s on GPU. Gateway route `/v1/audio/align`
> (AudioAlignHandler + spend.ModeAlign) added in backend image `v2.0.6-test6` — needs the live
> backend bumped to test6 + a provider registered (base_url `<public>/v1`, model
> `Qwen/Qwen3-ForcedAligner-0.6B`, mode `align`).

> 2026-06-29 FULL REBUILD (enhance.py server-side chunking + Enhance → GPU): changed
> `enhance.py` so per RULE 1 all 7 were uninstalled → chart 1.0.0 deleted → new tgz
> re-uploaded → all 7 re-cloned with EXACT titles. **KEY FINDING that corrects the old
> "URL always changes" claim: identical title + identical env reproduces the SAME
> clone-name/hash.** 6 of 7 reproduced byte-identical app names (URLs unchanged, Gateway
> providers untouched); **only Enhance changed** (`1c4d10` → `d616f5`) **because its env
> changed** (`AUDIO_REQUIRED_GPU_MEMORY` 0 → 2Gi). So the URL only moves when the title
> OR an env actually changes — reuse both verbatim to keep it stable. Enhance verified
> `loaded as 'waveform' on cuda:0`. Only the Enhance Gateway provider needs re-pointing.

## Re-clone recipes

Base chart `audiolabxv3` (source `upload`), single entrance ⇒ `--title` only.
Follow RULE 1: uninstall clones → `market delete audiolabxv3` → `market upload
audiolabxv3-1.0.0.tgz` → clone. (`market upgrade` is also blocked by the GPU webhook
for GPU instances, and same-version upload alone does not refresh the manifest.)

```bash
olares-cli market clone audiolabxv3 -s upload --title "<EXACT TITLE>" \
  --env MODEL_SOURCE=<...> --env MODEL_NAME=<...> --env MODEL_MODE=<...> \
  --env AUDIO_REQUIRED_GPU_MEMORY=<...> [--env MODEL_ENGINE=qwen3-asr] --watch
```

> **Do NOT pass `MODEL_ENGINE`** — the chart auto-selects the stt engine from MODEL_NAME
> (`qwen*`→qwen3-asr, `Systran/`/`*faster-whisper*`/`*ctranslate2*`→faster-whisper, else
> Whisper-on-vLLM). And `GPU_CORE_UTILIZATION_POLICY=disable` is force-set for any GPU
> engine by the chart. So the only clone-form envs are the 4 below.

| Cap | MODEL_SOURCE | MODEL_NAME | MODEL_MODE | GPU mem | extra |
|---|---|---|---|---|---|
| STT faster-whisper | `hf://Systran/faster-whisper-large-v3` | `Systran/faster-whisper-large-v3` | `stt` | `6Gi` | engine auto = faster-whisper (fast under time-slicing) |
| STT Whisper (vLLM) | `hf://openai/whisper-large-v3` | `openai/whisper-large-v3` | `stt` | `8Gi` | engine auto = vLLM Whisper (slow under time-slicing) |
| STT Qwen3-ASR | `hf://Qwen/Qwen3-ASR-1.7B` | `Qwen/Qwen3-ASR-1.7B` | `stt` | `12Gi` | engine auto = qwen3-asr (vLLM) |
| STT Stream (Qwen3-ASR, WS) | `hf://Qwen/Qwen3-ASR-1.7B` | `Qwen/Qwen3-ASR-1.7B` | `stt_stream` | `12Gi` | title `Audio Lab X V3 STT Stream`; WS `/v1/audio/stream`; wrapper stream.py |
| VAD | `hf://onnx-community/silero-vad` | `silero-v5` | `vad` | `0` | — |
| Diar | `hf://pyannote/speaker-diarization-community-1` | `pyannote-community-1` | `diar` | `4Gi` | HF token + ToS |
| Translate | `hf://entai2965/nllb-200-distilled-600M-ctranslate2` | `nllb-200-distilled-600M` | `translate` | `0` | — |
| Embed | `hf://pyannote/embedding` | `pyannote-embedding` | `embed` | `0` | — |
| Enhance | `hf://speechbrain/mtl-mimic-voicebank` | `mtl-mimic-voicebank` | `enhance` | `2Gi` (server-side chunking bounds VRAM; `0`=CPU still works) | — |
| Align | `hf://Qwen/Qwen3-ForcedAligner-0.6B` | `Qwen/Qwen3-ForcedAligner-0.6B` | `align` | `4Gi` | engine = vLLM cu129 (NOT pyannote); needs forced text |

## ConfigMap (wrapper) edits → delete + re-clone (see RULE 1)

`vad.py` / `stt_fw.py` etc. live in the `wrappers` ConfigMap, mounted at `/wrappers`,
run via `exec python3 /wrappers/<cap>.py`. There is **no** safe in-place way to push
a wrapper change to a running instance (no checksum annotation, no usable restart,
`market resume` 500s behind a UI dialog). Always: re-package tgz → uninstall →
delete chart → upload → re-clone. This is just RULE 1; stop looking for a shortcut.
