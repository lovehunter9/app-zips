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

## Live ledger (update after any re-clone)

| Cap | Title (exact, hash input) | App name | Namespace | Public URL | Internal URL |
|---|---|---|---|---|---|
| STT faster-whisper | `Audio Lab X V3 STT` | `audiolabxv3b2b539` | `audiolabxv3b2b539-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv3b2b539-shared:8000` |
| STT Qwen3-ASR | `Audio Lab X V3 Qwen3-ASR` | `audiolabxv3a0bbb6` | `audiolabxv3a0bbb6-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv3a0bbb6-shared:8000` |
| VAD | `Audio Lab X VAD` | `audiolabxv306a333` | `audiolabxv306a333-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv306a333-shared:8000` |
| Diar | `Audio Lab X V3 Diar` | `audiolabxv34c7e4e` | `audiolabxv34c7e4e-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv34c7e4e-shared:8000` |
| Translate | `Audio Lab X V3 Translate` | `audiolabxv38ab6b2` | `audiolabxv38ab6b2-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv38ab6b2-shared:8000` |
| Embed | `Audio Lab X V3 Embed` | `audiolabxv35db0f3` | `audiolabxv35db0f3-shared` | (ask user — unchanged) | `http://audio-engine.audiolabxv35db0f3-shared:8000` |
| Enhance (GPU 2Gi) | `AudioLabX Enhance` | `audiolabxv3d616f5` (was `1c4d10`) | `audiolabxv3d616f5-shared` | **NEW → ask user** | `http://audio-engine.audiolabxv3d616f5-shared:8000` |
| Align (GPU 4Gi) | `Audio Lab X V3 Align` | `audiolabxv3396efb` | `audiolabxv3396efb-shared` | `https://3276066a.olarestest003.olares.com` | `http://audio-engine.audiolabxv3396efb-shared:8000` |

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
