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

## SOP — the per-capability delivery pipeline (follow IN ORDER; do NOT skip ahead)

Every new capability ships through these steps, in this order. Each gate must pass
before the next starts — in particular the gateway/provider work (5–7) does NOT begin
until the clone itself is verified (4), and the clone (3) can't start until the engine
image exists (2). Don't "parallelize" downstream steps to save wall-clock while an
upstream gate is red; it just creates rework.

1. **选定能力 + 调研方案** — pick the capability, research engines/models, write the
   selection doc (e.g. `audiolabxv3-docs/<cap>能力_选型调研.md`).
2. **选引擎（可能转镜像）** — choose the engine; if it needs a new image, mirror it to
   `beclab/` via the image-locker and WAIT for `dstImageExist:true`. Reuse an existing
   image whenever possible (only diar_stream broke this, needing NeMo).
   → also write the chart SKELETON here: `engine.yaml` `$engines` entry + `wrappers/<cap>.py`
     + `OlaresManifest.yaml` MODEL_MODE enum. (Skeleton is pure-addition; verify with
     `helm template`/`lint` that existing modes render byte-identical.)
3. **CLONE** — `market clone audiolabxv3` with the capability's env set (per RULE 1 cycle
   if templates changed: uninstall clones → delete app → upload tgz → clone). The clone
   passes ONLY the 5 UI inputs (RULE 2): title + MODEL_SOURCE/NAME/MODE + AUDIO_REQUIRED_GPU_MEMORY.
   Gated repo? ensure the user's Olares HuggingFace integration token is set — it auto-injects
   as HF_TOKEN; NEVER `--env HF_TOKEN`.
4. **检验 CLONE 有效** — hit the clone's own entrance directly (engine `/v1/...`), confirm
   the model loads + the capability responds. GATE for step 5.
5. **改网关** — add the mode/route to the LLM Gateway (copy the closest existing mode).
6. **建 provider** — register the clone as a Gateway provider (ask user for the public
   URL + gateway key per RULE 0).
7. **检验网关有效** — same capability call, but THROUGH the gateway (auth + routing +
   metering). GATE for step 8.
8. **DEMO 新增能力演示** — add the capability's UI to `audiostudioxdemo`.
9. **联调 DEMO** — end-to-end through gateway; user tests.
10. **打 DEMO 镜像** — bump `audiostudioxdemo` Chart/values version, build+push image.
11. **选下一个能力** — pick the next capability, back to step 1.

### diar_stream — current position in the pipeline (2026-07-03)
- ✅ 1 研 (Sortformer 选定，`diar_stream能力_选型调研.md`)
- ✅ 2 选引擎 + 骨架 (engine.yaml/wrappers/manifest)。镜像 `docker.io/beclab/nvidia-nemo:26.02`.
- ✅ 3 CLONE — `audiolabxv3096764`, title `Audio Lab X V3 Diar Stream`, env
  `MODEL_SOURCE=hf://nvidia/diar_streaming_sortformer_4spk-v2.1 MODEL_NAME=diar-streaming-sortformer
  MODEL_MODE=diar_stream AUDIO_REQUIRED_GPU_MEMORY=6Gi`. Repo public/ungated.
- ✅ 4 验证 CLONE — direct WS PASSED (see NEMO PYTHON GOTCHA below; one fix iteration).
- ✅ 5 网关 route — `GET /v1/audio/diarize/stream` → `AudioDiarizeStreamHandler`
  (`audio_stream.go` refactored: `stt_stream`+`diar_stream` share `audioStreamProxy`;
  `spend.ModeDiarStream` added; `providers.ModeDiarStream` + DB CHECKs pre-existed). Backend
  `lovehunter9/llm-gateway-backend:v2.0.6-test8` built+pushed; chart bumped; user rolled it.
- ✅ 6 provider — `diar-stream-audiolabxv3` (base_url `https://20b7f5ba…/v1`, model
  `diar-streaming-sortformer`, mode `diar_stream`). Script `register-diar-stream-provider.js`.
- ✅ 7 验证网关 — WS e2e PASSED (`wss://<gw>/v1/audio/diarize/stream?model=diar-streaming-sortformer`,
  Bearer key + SSO cookie; 2 speakers, stable labels, native timestamps).
- ✅ base 硬化 — 无限长 ROLLING WINDOW (见下方 2026-07-03 DIAR_STREAM UNBOUNDED 记录),直连 WS 已验。
- 🔶 8 DEMO — `stream.tsx` 重写:转写/说话人两个独立开关(可单开、可融合),双 WS 广播同一路 PCM,
  按音频时钟融合(每句字幕着色标注说话人)+ 独立说话人时间线面板。`npm run build` 通过;联调中。
- ⏳ 9–11 联调 DEMO / 打镜像 / 下一能力 — pending.

### NEMO PYTHON GOTCHA (cost one clone iteration, 2026-07-03) — diar_stream on /opt/venv, NOT /pydeps
The `beclab/nvidia-nemo:26.02` image keeps `nemo_toolkit` in its OWN venv **`/opt/venv`**
(a uv venv, python 3.12), separate from the base image's SYSTEM python
(`/usr/local/.../dist-packages`, where torch lives). The shared `$pydepsPrelude` builds
`/pydeps/venv` off the SYSTEM python with `--system-site-packages` → it sees torch but **never
nemo** (different venv, not on the base's site-packages). Result: the wrapper crashed
`ModuleNotFoundError: No module named 'nemo'` and sat 0/1 for 13h (app state `running`, engine
`/healthz` 503 — market list lies; check the engine pod READY). FIX (in `engine.yaml` diar_stream
cmd): run `/opt/venv/bin/python` directly, `export PYTHONPATH=/pydeps/diarstream-site` (RESET,
dropping the prelude's 3.12 path), and pip/uv `--target` fastapi/uvicorn/websockets there only if
an import-probe misses (they were already in /opt/venv, so nothing installed). Sentinel
`/pydeps/.diar_stream.ok` → restart re-installs nothing. LESSON for future NeMo/uv-based images:
NEVER assume `--system-site-packages` exposes the toolkit; find the interpreter that can
`import <pkg>` and use it directly.

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

## RULE 2 (IRON LAW) — the CLONE form is EXACTLY 5 inputs; NEVER `--env` anything else

The "创建新实例 / Create instance" UI exposes **exactly five** inputs, and a `market clone`
MUST pass **only** these (mirror the UI byte-for-byte — one extra `--env` is a violation):

1. **title** (`--title "<EXACT TITLE>"`) — the desktop/app title (hash input)
2. `--env MODEL_SOURCE=hf://<repo>`
3. `--env MODEL_NAME=<id>`
4. `--env MODEL_MODE=<mode>`
5. `--env AUDIO_REQUIRED_GPU_MEMORY=<n>Gi|0`

That is the WHOLE allowed set. **Do NOT pass any other `--env`** — not `MODEL_ENGINE`,
not `HF_TOKEN`/`HF_ENDPOINT`, not `MODEL_MAX_AUDIO_MB`, not `ENGINE_IMAGE`, not
`AUDIO_*_REQUEST/LIMIT`, not `STREAM_*`/`DIAR_*`, nothing.

**Why exactly these five** (derivable from `OlaresManifest.yaml`): the clone form shows only
envs that are `required: true` AND have **no `default:`** AND **no `valueFrom:`**. Everything
else is one of:
- **auto-injected** via `valueFrom` — `HF_TOKEN` ← `OLARES_USER_HUGGINGFACE_TOKEN`,
  `HF_ENDPOINT` ← `OLARES_USER_HUGGINGFACE_SERVICE`. So a **gated repo** (pyannote diar/embed,
  NVIDIA Sortformer) needs the user's **Olares → Settings → Integrations → HuggingFace** token
  set (and its license/ToS accepted on HF); it then flows in automatically. **Never pass it at
  clone.** This is how diar/embed gated downloads have always worked.
- **has a `default:`** (e.g. `MODEL_ENGINE=""`, `AUDIO_CPU_REQUEST=500m`, `AUDIO_MEMORY_LIMIT`,
  `MODEL_MAX_AUDIO_MB`) — the chart resolves it; to change it you edit the manifest `default:`
  (chart content, hash-stable), NOT a per-clone `--env`.
- **`MODEL_ENGINE` is AUTO-SELECTED from `MODEL_NAME`** (qwen*→qwen3-asr, Systran/ct2→faster-whisper,
  else Whisper-on-vLLM). It is NOT a clone field even though it exists as an advanced option.

If a value truly must differ per-instance and isn't one of the 5, that's a chart/manifest change
(RULE 1 rebuild), not a clone `--env`.

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

> **2026-07-03 STATE (rebuild #3): 10/10 clones LIVE + healthy — b2b539 FIXED (P0 closed).**
> Third full RULE 1 rebuild shipped the `$pydepsPrelude` SELF-HEALING fix (see PYDEPS SELF-HEAL note
> below). All 10 hashes reproduced identically AGAIN → all public URLs unchanged → no Gateway
> re-pointing. Engine readiness after: diar_stream/stt_stream/qwen-offline/faster-whisper/vad/diar/
> translate/embed/enhance/align **all `1/1 ready restarts=0`** (rechecked +2min, all stable). The
> offline faster-whisper STT (`b2b539`) that CrashLoopBackOff'd on rebuild #2 now boots clean.
>
> **2026-07-03 PYDEPS SELF-HEAL (root cause + fix for the b2b539 P0) — engine.yaml `$pydepsPrelude`.**
> ROOT CAUSE: the persistent-venv prelude did `python3 -m venv --system-site-packages /pydeps/venv`
> then unconditionally prepended `/pydeps/venv/bin` to PATH. On the `harveyff-whisper-webui:v1.0.7`
> image that venv has **NO usable pip AND no `ensurepip`** — so once it was first on PATH, the
> faster-whisper cmd's `pip install fastapi uvicorn` died `No module named pip`, the `&& touch .fw.ok`
> short-circuited (so it retried+failed every boot, never persisting), and `stt_fw.py` crashed
> `ModuleNotFoundError: fastapi` → CrashLoopBackOff. The 9 other engines survived only because their
> images (cu129 / pyannote / nemo) happen to ship a venv with working pip. So the persistent-venv
> design (2026-07-01) had a latent image-specific hole; rebuild #2 just exposed it (this engine had
> not been re-tested since). This WAS a regression, not merely pre-existing — owned + fixed.
> FIX (backward-compatible, all modes): only ADOPT the venv after confirming `pip` works in it —
> `$VENV/bin/python -m pip --version || ensurepip --upgrade`; if pip STILL isn't available, DON'T put
> the venv on PATH, fall back to the image's SYSTEM python (which has a working pip; the tiny
> fastapi/uvicorn set installs ephemerally per restart — acceptable). Healthy images keep the venv
> exactly as before (pip --version succeeds → same PATH/PYTHONPATH). Also REPAIRS an already-broken
> /pydeps/venv on restart via ensurepip. VERIFIED from b2b539 boot logs: `[pydeps] venv has no pip;
> bootstrapping via ensurepip` → `[pydeps] venv pip unavailable (ensurepip missing in image); using
> system python` → `Application startup complete` / `Uvicorn running` → `/health` 200, ready=true,
> restarts=0. (This image has NEITHER venv pip NOR ensurepip, so the system-python fallback is the
> path that saved it.) LESSON: never assume `python -m venv` yields a working pip; gate PATH adoption
> on an actual `pip --version`.
>
> **2026-07-03 DIAR_STREAM UNBOUNDED LENGTH (rolling window) — chart change, verified.** Problem:
> the skeleton kept the WHOLE session in `buf` and re-ran `.diarize()` on it every 2s → O(n²) compute
> + unbounded RAM/GPU → a long meeting/audiobook falls behind real time and OOMs (worse than
> stt_stream's ~10min encoder ceiling). Fix in `diar_stream.py` (`wrappers.yaml`), same "roll instead
> of grow" idea as stream.py: only diarize the last `DIAR_STREAM_WINDOW_SEC` (default 60s) of audio,
> COMMIT older turns to a frozen list, carry a `DIAR_STREAM_OVERLAP_SEC` (default 12s) tail across
> each roll, and REMAP the new window's local speaker labels onto the previous window's by max time
> overlap on that tail (so spk_0/spk_1 stay stable across the seam — the thing stt_stream's reset
> didn't have to solve). Compute AND memory now bounded; lag bounded by the window (self-correcting).
> **VERIFIED direct WS** (`/tmp/diar_ws2.py`, `proxy=None` required per sandbox note) with a 95s
> two-speaker clip (`say` Daniel/Samantha, A,B,A,B,A): ran to FINAL, 0 drops, coverage grew 2→95.2s
> ACROSS the ~60s roll, speakers stayed stable (`spk_0[0-19.8] spk_1[19.8-37.8] spk_0[37.8-57.5]
> spk_1[57.5-75.6] spk_0[75.6-95.2]`), per-emit interval avg 1.08s / max 5.24s and NOT growing past
> the window. NeMo's `.diarize()` on streaming Sortformer already runs internal "Streaming Steps"
> (AOSC), so labels are stable within a window; the remap only bridges seams. Knobs: env
> `DIAR_STREAM_WINDOW_SEC` / `DIAR_STREAM_OVERLAP_SEC`. Future zero-recompute path documented in the
> wrapper header: `init_streaming_state`+`forward_streaming_step`+`streaming_feat_loader` (feed only
> new chunks) per NeMo's Streaming_Multitalker_ASR tutorial.

| Cap | Title (exact, hash input) | App name | Namespace | Public URL | Internal URL |
|---|---|---|---|---|---|
| **Diar Stream (Sortformer, WS)** | `Audio Lab X V3 Diar Stream` | `audiolabxv3096764` | `audiolabxv3096764-shared` | `https://20b7f5ba.olarestest003.olares.com` | `http://audio-engine.audiolabxv3096764-shared:8000` (WS `/v1/audio/diarize/stream`) |
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
> confirm with user per RULE 0). **URL confirmed unchanged by user 2026-07-01.**
>
> 2026-07-01 GATEWAY STT-STREAM WS ROUTE (in progress — see WORK_LOG_2026-07-01.md for full detail):
> added `GET /v1/audio/stream` to the gateway (mode=stt_stream) — a WebSocket proxy: resolve
> stt_stream provider (`?model=`, empty=default) → dial upstream `ws(s)://<base>/audio/stream` →
> pump frames both ways; meter by audio seconds. Decisions: gorilla/websocket, Bearer-header-only
> auth (browser WS can't set headers → e2e test needs a non-browser client), spend by audio_seconds.
> Backend image `lovehunter9/llm-gateway-backend:v2.0.6-test7` built+pushed, user rolled it live,
> provider registered (`stt-stream-audiolabxv3`, base_url `https://d123f7e6.../v1`, model
> `Qwen/Qwen3-ASR-1.7B`, mode stt_stream; via DevTools script `audiolabxv3-docs/register-stt-stream-provider.js`).
> **BLOCKED on a frontend-nginx bug:** the frontend `location /v1/` did NOT forward the WS
> `Upgrade/Connection` headers (only `/console/api/` did) → handshake 400 "Bad Request". Fixed in
> `llm-gateway/deploy/frontend.nginx.conf.template` (config is image-baked → needs a FRONTEND image
> rebuild). Next: build `lovehunter9/llm-gateway-frontend:v2.0.6-test1` (chart already bumped), roll
> it, then WS e2e test via `/tmp/ws_gw_client.py` (needs a fresh SSO cookie + gateway key). Gateway
> code (5 files + nginx template) is NOT committed yet ("试好了再说").
>
> 2026-07-02 GATEWAY STT-STREAM WS — **VERIFIED END-TO-END + COMMITTED**: built+pushed frontend
> image `lovehunter9/llm-gateway-frontend:v2.0.6-test1` (nginx `/v1/` now forwards WS
> `Upgrade/Connection`); user rolled frontend live (backend already `v2.0.6-test7`, provider
> `stt-stream-audiolabxv3` still in DB). WS e2e through the gateway PASSED on the English sample
> (`ready → partials → final`: "…ask not what your country can do for you; ask what you can do for
> your country."). First attempt hit a clean `502` because the stt_stream instance was paused —
> confirms the handler's "dial-upstream-first" design (paused/cold upstream → 502, not a hung
> upgrade). Resumed instance → passed. Gateway code committed as `llm-gateway` `aaa594e`
> (feat: stt_stream WebSocket data plane passthrough — the 5 backend files + nginx template).
> Test client rewritten to take `GW_URL/GW_KEY/GW_COOKIE` from env (no hard-coded creds):
> `GW_URL=… GW_KEY=… GW_COOKIE='auth_token=…' /tmp/wsvenv/bin/python /tmp/ws_gw_client.py /tmp/asr_en.wav`.
> NOTE: `/tmp` assets (venv/client/wav) are wiped on host reboot — recreate from this recipe.
> Client MUST pass `proxy=None` to `websockets.connect()` (sandbox injects `ALL_PROXY` → else
> `ImportError: ... requires python-socks`).
>
> 2026-07-02 LONG-STREAM HARDENING (implement B: rolling reset) — chart change, full rebuild,
> hash/URL stable (`audiolabxv30f9f88` / `https://d123f7e6…`, env unchanged). Problem: Qwen3-ASR
> streaming state accumulates audio context → vLLM encoder cache (budget **8192 tokens**, logged
> at boot) overflows after ~10min continuous stream → connection dies. Fix in `stream.py`
> (`wrappers.yaml`): (a) **proactive rolling reset** every `STREAM_ROLL_SEC` (default 240s) —
> `finish_streaming_transcribe` the current segment, fold its text into a committed `prefix`
> (keeps the emitted transcript monotonic across rolls via `_join`, ASCII-word-spaced only), then
> `init_streaming_state` a fresh state so encoder-cache usage resets to ~0; (b) a **backstop** that
> catches `encoder cache/exceeds/pre-allocated` exceptions, forces a roll, retries the chunk once;
> (c) inference already offloaded via `asyncio.to_thread` under a global `_infer_lock`. Also
> **disabled server WS keepalive** (`uvicorn.run(..., ws_ping_interval=None, ws_ping_timeout=None)`):
> under a bursty/flood feed the default 20s ping timeout dropped a healthy session with `CLOSE 1011
> keepalive ping timeout`; captioning is client-driven so we rely on WebSocketDisconnect/TCP reset.
> **VERIFIED** through the Gateway with a synthetic **720s (12min)** wav (JFK clip tiled, fed fast):
> before the keepalive fix it died at ~560s with 1011 (but NO encoder-cache error → roll worked);
> after the fix it ran **all 1443 partials → FINAL, zero errors** — i.e. cleanly past the old
> ~10min/600s crash point. Rolling proven at 300s (one roll) and 720s (three rolls). No `8192`/
> `encoder cache` overflow anywhere in engine logs.
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
  --env AUDIO_REQUIRED_GPU_MEMORY=<...> --watch
```

> **Exactly these 4 `--env` + `--title` — nothing else (see RULE 2).** No `MODEL_ENGINE`
> (auto-selected from MODEL_NAME: `qwen*`→qwen3-asr, `Systran/`/`*faster-whisper*`/
> `*ctranslate2*`→faster-whisper, else Whisper-on-vLLM), no `HF_TOKEN` (auto-injected from
> the user's Olares HuggingFace integration for gated repos), no other env.
> `GPU_CORE_UTILIZATION_POLICY=disable` is force-set for any GPU engine by the chart.

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
| Diar Stream (Sortformer, WS) | `hf://nvidia/diar_streaming_sortformer_4spk-v2.1` | `diar-streaming-sortformer` | `diar_stream` | `6Gi` | title `Audio Lab X V3 Diar Stream`; engine = nvidia-nemo:26.02 on **/opt/venv** python (see NEMO PYTHON GOTCHA); WS `/v1/audio/diarize/stream`; public/ungated |

## ConfigMap (wrapper) edits → delete + re-clone (see RULE 1)

`vad.py` / `stt_fw.py` etc. live in the `wrappers` ConfigMap, mounted at `/wrappers`,
run via `exec python3 /wrappers/<cap>.py`. There is **no** safe in-place way to push
a wrapper change to a running instance (no checksum annotation, no usable restart,
`market resume` 500s behind a UI dialog). Always: re-package tgz → uninstall →
delete chart → upload → re-clone. This is just RULE 1; stop looking for a shortcut.
