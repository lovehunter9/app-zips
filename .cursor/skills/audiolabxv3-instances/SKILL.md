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
| STT faster-whisper | `Audio Lab X V3 STT` | `audiolabxv30b0d85` | `audiolabxv30b0d85-shared` | `https://b7c85290.olarestest003.olares.com` | `http://audio-engine.audiolabxv30b0d85-shared:8000` |
| STT Qwen3-ASR | `Audio Lab X V3 Qwen3-ASR` | (待重建) | — | — | — |
| VAD | `Audio Lab X VAD` | (待重建) | — | — | — |
| Diar | `Audio Lab X V3 Diar` | (待重建) | — | — | — |
| Translate | `Audio Lab X V3 Translate` | (待重建) | — | — | — |
| Embed | `Audio Lab X V3 Embed` | (待重建) | — | — | — |
| Enhance | `AudioLabX Enhance` | (待重建) | — | — | — |

> 2026-06-26 RESET: all 7 instances uninstalled to swap the STT engine; only STT
> rebuilt so far, now on **faster-whisper** (`MODEL_ENGINE=faster-whisper`,
> `Systran/faster-whisper-large-v3`, harveyff image, BatchedInferencePipeline).
> URL changed to `b7c85290` even with the same title (clone name `0b0d85`); Gateway
> STT provider re-registered against it. Other 6 to be rebuilt after STT speed passes.

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

| Cap | MODEL_SOURCE | MODEL_NAME | MODEL_MODE | GPU mem | extra |
|---|---|---|---|---|---|
| STT faster-whisper | `hf://Systran/faster-whisper-large-v3` | `Systran/faster-whisper-large-v3` | `stt` | `6Gi` | `MODEL_ENGINE=faster-whisper` (BatchedInferencePipeline; fast under time-slicing) |
| STT Whisper (vLLM) | `hf://openai/whisper-large-v3` | `openai/whisper-large-v3` | `stt` | `8Gi` | slow under time-slicing |
| STT Qwen3-ASR | `hf://Qwen/Qwen3-ASR-1.7B` | `Qwen/Qwen3-ASR-1.7B` | `stt` | `12Gi` | `MODEL_ENGINE=qwen3-asr` |
| VAD | `hf://onnx-community/silero-vad` | `silero-v5` | `vad` | `0` | — |
| Diar | `hf://pyannote/speaker-diarization-community-1` | `pyannote-community-1` | `diar` | `4Gi` | HF token + ToS |
| Translate | `hf://entai2965/nllb-200-distilled-600M-ctranslate2` | `nllb-200-distilled-600M` | `translate` | `0` | — |
| Embed | `hf://pyannote/embedding` | `pyannote-embedding` | `embed` | `0` | — |
| Enhance | `hf://speechbrain/mtl-mimic-voicebank` | `mtl-mimic-voicebank` | `enhance` | `0` | — |

## ConfigMap (wrapper) edits → delete + re-clone (see RULE 1)

`vad.py` / `stt_fw.py` etc. live in the `wrappers` ConfigMap, mounted at `/wrappers`,
run via `exec python3 /wrappers/<cap>.py`. There is **no** safe in-place way to push
a wrapper change to a running instance (no checksum annotation, no usable restart,
`market resume` 500s behind a UI dialog). Always: re-package tgz → uninstall →
delete chart → upload → re-clone. This is just RULE 1; stop looking for a shortcut.
