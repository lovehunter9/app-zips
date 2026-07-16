# Podcast TTS Patches — STAGED (NOT applied)

> Status: **drafted, removed from `templates/deployment.yaml` pending evidence**.
> Reason for removal: the original "32/55 clips were 0-byte" failure (2026-04-23)
> coincided with using an **English voice (`af_*`) on Chinese transcript text**.
> Speaches/Kokoro returns HTTP 200 with an empty body when the configured voice
> cannot speak the input language. After switching the speaker profile's voice
> to a matching `zf_*` Chinese voice (Speaches model
> `speaches-ai/Kokoro-82M-v1.0-ONNX` exposes 8 of them), upstream behaviour
> needs to be re-validated before re-applying any of these patches.
>
> Re-apply if and only if any of these are observed in the wild *with a
> language-matched voice*:
>   - `combine_audio_files: Error loading audio clip ... Format mp3 detected
>     only with low score of 1` (i.e. ffmpeg refuses a TTS clip)
>   - 0-byte `.mp3` files in `/app/data/podcasts/episodes/<id>/clips/`
>   - LangGraph node `generate_all_audio` aborting an entire episode because
>     a single clip's `@tts_retry` exhausted attempts

## Diagnostic shortcut (skip the rest if these come back clean)

```bash
# In the opennotebook pod
ls -la /app/data/podcasts/episodes/<id>/clips/ | awk '{print $5, $9}' | sort -n | head
# 0-byte rows = empty TTS responses; non-zero only = TTS healthy
```

```bash
# Speaches voice list — confirm a voice in the right language exists
curl -s 'http://<speaches>/v1/models' | python3 -c "
import json, sys
d = json.load(sys.stdin)
langs = {}
for m in d['data']:
    for v in m.get('voices', []):
        langs.setdefault(v['language'], []).append(v['id'])
for lang, ids in sorted(langs.items()):
    print(f'{lang}: {len(ids)} voices: {ids}')
"
```

## Background

`podcast_creator` (the `lfnovo/podcast-creator` PyPI package, v0.12.0 as
shipped in `lfnovo/open_notebook:1.8.5`) does **not** validate the audio file
written by `esperanto.AIFactory.create_text_to_speech(...).agenerate_speech()`.
If the TTS backend returns HTTP 200 with an empty body (or any non-audio
content), the file lands at 0 bytes, the function logs `Generated audio clip:
...` and returns success. The failure only surfaces much later in
`combine_audio_files` when ffmpeg/MoviePy tries to decode the clips —
producing the misleading error chain:

```
combine_audio_files: Error loading audio clip ...
[mp3 @ ...] Format mp3 detected only with low score of 1, misdetection possible!
[mp3 @ ...] Failed to find two consecutive MPEG audio frames.
[in#0 @ ...] Error opening input: Invalid data found when processing input
```

Additionally, `generate_all_audio_node` calls
`asyncio.gather(*batch_tasks)` without `return_exceptions=True`, so any
single clip whose `@tts_retry` exhausts attempts kills the entire episode.

## Diff candidate 1 — TTS clip output validation (force retry on bad write)

Location: `/app/.venv/lib/python*/site-packages/podcast_creator/nodes.py`,
inside `async def generate_single_audio_clip(...)`.

```diff
     # Generate audio
     await tts_model.agenerate_speech(
         text=dialogue.dialogue, voice=voices[dialogue.speaker], output_file=clip_path
     )

+    # OLARES HOTFIX: validate TTS clip output
+    try:
+        _olares_size = clip_path.stat().st_size if clip_path.exists() else 0
+    except Exception:
+        _olares_size = 0
+    _olares_head = b""
+    if _olares_size > 0:
+        try:
+            with open(clip_path, "rb") as _olares_fh:
+                _olares_head = _olares_fh.read(4)
+        except Exception:
+            _olares_head = b""
+    _olares_ok = (
+        _olares_size >= 200
+        and (
+            _olares_head[:3] == b"ID3"
+            or (len(_olares_head) >= 2 and _olares_head[0] == 0xFF and (_olares_head[1] & 0xE0) == 0xE0)
+            or _olares_head[:4] == b"RIFF"
+            or _olares_head[:4] == b"OggS"
+            or _olares_head[:4] == b"fLaC"
+        )
+    )
+    if not _olares_ok:
+        try:
+            if clip_path.exists():
+                clip_path.unlink()
+        except Exception:
+            pass
+        raise RuntimeError(
+            f"Olares TTS validation: clip {index:04d} invalid "
+            f"(size={_olares_size}, head={_olares_head!r}); forcing retry"
+        )
+
     logger.info(f"Generated audio clip: {clip_path}")
```

Idempotency marker: `# OLARES HOTFIX: validate TTS clip output`.

## Diff candidate 2 — per-clip failure tolerance (silent placeholder)

Location: same file, inside `async def generate_all_audio_node(...)`,
inside the per-batch loop. **Only meaningful when paired with diff #1**, since
upstream itself never raises from a "successful" empty write — diff #1 is
what surfaces a failure as an exception in the first place.

```diff
         # Process this batch concurrently (but wait before next batch)
-        batch_clip_paths = await asyncio.gather(*batch_tasks)
-        all_clip_paths.extend(batch_clip_paths)
+        # OLARES HOTFIX: tolerate per-clip permanent failure
+        _olares_raw = await asyncio.gather(*batch_tasks, return_exceptions=True)
+        batch_clip_paths = []
+        for _olares_i, _olares_r in enumerate(_olares_raw):
+            if isinstance(_olares_r, BaseException):
+                _olares_idx = batch_start + _olares_i
+                logger.error(
+                    f"Clip {_olares_idx:04d} permanently failed after all retries "
+                    f"({type(_olares_r).__name__}: {_olares_r}); inserting 800ms "
+                    f"silent placeholder so the episode still completes"
+                )
+                _olares_silent_path = output_dir / "clips" / f"{_olares_idx:04d}.mp3"
+                _olares_silent_path.parent.mkdir(parents=True, exist_ok=True)
+                _olares_placeholder_ok = False
+                try:
+                    from pydub import AudioSegment as _OlaresSeg
+                    _OlaresSeg.silent(duration=800).export(str(_olares_silent_path), format="mp3")
+                    _olares_placeholder_ok = _olares_silent_path.exists() and _olares_silent_path.stat().st_size > 0
+                except Exception as _olares_e:
+                    logger.error(f"Clip {_olares_idx:04d} placeholder via pydub failed: {_olares_e!r}")
+                if not _olares_placeholder_ok:
+                    try:
+                        import subprocess as _olares_sp
+                        _olares_sp.run(
+                            ["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
+                             "-t", "0.8", "-c:a", "libmp3lame", "-b:a", "64k", str(_olares_silent_path)],
+                            check=True, capture_output=True, timeout=30,
+                        )
+                        _olares_placeholder_ok = _olares_silent_path.exists() and _olares_silent_path.stat().st_size > 0
+                    except Exception as _olares_e2:
+                        logger.error(f"Clip {_olares_idx:04d} placeholder via ffmpeg failed: {_olares_e2!r}; skipping clip")
+                if _olares_placeholder_ok:
+                    batch_clip_paths.append(_olares_silent_path)
+            else:
+                batch_clip_paths.append(_olares_r)
+        all_clip_paths.extend(batch_clip_paths)
```

Idempotency marker: `# OLARES HOTFIX: tolerate per-clip permanent failure`.

## Diff candidate 3 — concurrency throttle (env-only, no code change)

```yaml
        - name: TTS_BATCH_SIZE
          value: "1"
```

`podcast_creator/nodes.py:174` already reads `os.getenv("TTS_BATCH_SIZE", "5")`.
Setting `=1` forces sequential generation. Costs ~3-4× wall-clock time vs
default 5. **Never validated on its own merit** — was added defensively
during the original failed run alongside diff #1; in retrospect the failures
that motivated it may have been entirely caused by the voice/language
mismatch.

## Init-container glue (drop-in for `templates/deployment.yaml`)

If re-applying, paste the following inside the existing `python3 << 'PATCH_EOF'`
block in the opennotebook container's startup command, immediately after the
`# NOTE: STT httpx timeout is lifted via the env var ESPERANTO_STT_TIMEOUT`
comment block and before `if patched:`:

```python
import glob as _olares_glob
_olares_nodes = _olares_glob.glob(
    '/app/.venv/lib/python*/site-packages/podcast_creator/nodes.py'
)
if _olares_nodes:
    f = pathlib.Path(_olares_nodes[0])
    marker_pc = '# OLARES HOTFIX: validate TTS clip output'
    anchor_pc = (
        '    # Generate audio\n'
        '    await tts_model.agenerate_speech(\n'
        '        text=dialogue.dialogue, voice=voices[dialogue.speaker], output_file=clip_path\n'
        '    )\n'
        '\n'
        '    logger.info(f"Generated audio clip: {clip_path}")'
    )
    replacement_pc = (
        '    # Generate audio\n'
        '    await tts_model.agenerate_speech(\n'
        '        text=dialogue.dialogue, voice=voices[dialogue.speaker], output_file=clip_path\n'
        '    )\n'
        '\n'
        '    ' + marker_pc + '\n'
        '    try:\n'
        '        _olares_size = clip_path.stat().st_size if clip_path.exists() else 0\n'
        '    except Exception:\n'
        '        _olares_size = 0\n'
        '    _olares_head = b""\n'
        '    if _olares_size > 0:\n'
        '        try:\n'
        '            with open(clip_path, "rb") as _olares_fh:\n'
        '                _olares_head = _olares_fh.read(4)\n'
        '        except Exception:\n'
        '            _olares_head = b""\n'
        '    _olares_ok = (\n'
        '        _olares_size >= 200\n'
        '        and (\n'
        '            _olares_head[:3] == b"ID3"\n'
        '            or (len(_olares_head) >= 2 and _olares_head[0] == 0xFF and (_olares_head[1] & 0xE0) == 0xE0)\n'
        '            or _olares_head[:4] == b"RIFF"\n'
        '            or _olares_head[:4] == b"OggS"\n'
        '            or _olares_head[:4] == b"fLaC"\n'
        '        )\n'
        '    )\n'
        '    if not _olares_ok:\n'
        '        try:\n'
        '            if clip_path.exists():\n'
        '                clip_path.unlink()\n'
        '        except Exception:\n'
        '            pass\n'
        '        raise RuntimeError(\n'
        '            f"Olares TTS validation: clip {index:04d} invalid "\n'
        '            f"(size={_olares_size}, head={_olares_head!r}); forcing retry"\n'
        '        )\n'
        '\n'
        '    logger.info(f"Generated audio clip: {clip_path}")'
    )
    if f.exists():
        s = f.read_text()
        if marker_pc not in s and anchor_pc in s:
            f.write_text(s.replace(anchor_pc, replacement_pc))
            patched.append('podcast_creator/nodes.py (TTS clip validation)')

if _olares_nodes:
    f = pathlib.Path(_olares_nodes[0])
    marker_fb = '# OLARES HOTFIX: tolerate per-clip permanent failure'
    anchor_fb = (
        '        # Process this batch concurrently (but wait before next batch)\n'
        '        batch_clip_paths = await asyncio.gather(*batch_tasks)\n'
        '        all_clip_paths.extend(batch_clip_paths)'
    )
    replacement_fb = (
        '        # Process this batch concurrently (but wait before next batch)\n'
        '        ' + marker_fb + '\n'
        '        _olares_raw = await asyncio.gather(*batch_tasks, return_exceptions=True)\n'
        '        batch_clip_paths = []\n'
        '        for _olares_i, _olares_r in enumerate(_olares_raw):\n'
        '            if isinstance(_olares_r, BaseException):\n'
        '                _olares_idx = batch_start + _olares_i\n'
        '                logger.error(\n'
        '                    f"Clip {_olares_idx:04d} permanently failed after all retries "\n'
        '                    f"({type(_olares_r).__name__}: {_olares_r}); inserting 800ms "\n'
        '                    f"silent placeholder so the episode still completes"\n'
        '                )\n'
        '                _olares_silent_path = output_dir / "clips" / f"{_olares_idx:04d}.mp3"\n'
        '                _olares_silent_path.parent.mkdir(parents=True, exist_ok=True)\n'
        '                _olares_placeholder_ok = False\n'
        '                try:\n'
        '                    from pydub import AudioSegment as _OlaresSeg\n'
        '                    _OlaresSeg.silent(duration=800).export(str(_olares_silent_path), format="mp3")\n'
        '                    _olares_placeholder_ok = _olares_silent_path.exists() and _olares_silent_path.stat().st_size > 0\n'
        '                except Exception as _olares_e:\n'
        '                    logger.error(f"Clip {_olares_idx:04d} placeholder via pydub failed: {_olares_e!r}")\n'
        '                if not _olares_placeholder_ok:\n'
        '                    try:\n'
        '                        import subprocess as _olares_sp\n'
        '                        _olares_sp.run(\n'
        '                            ["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",\n'
        '                             "-t", "0.8", "-c:a", "libmp3lame", "-b:a", "64k", str(_olares_silent_path)],\n'
        '                            check=True, capture_output=True, timeout=30,\n'
        '                        )\n'
        '                        _olares_placeholder_ok = _olares_silent_path.exists() and _olares_silent_path.stat().st_size > 0\n'
        '                    except Exception as _olares_e2:\n'
        '                        logger.error(f"Clip {_olares_idx:04d} placeholder via ffmpeg failed: {_olares_e2!r}; skipping clip")\n'
        '                if _olares_placeholder_ok:\n'
        '                    batch_clip_paths.append(_olares_silent_path)\n'
        '            else:\n'
        '                batch_clip_paths.append(_olares_r)\n'
        '        all_clip_paths.extend(batch_clip_paths)'
    )
    if f.exists():
        s = f.read_text()
        if marker_fb not in s and anchor_fb in s:
            f.write_text(s.replace(anchor_fb, replacement_fb))
            patched.append('podcast_creator/nodes.py (per-clip failure tolerance)')
```
