# Multi-arch (amd64 + arm64) CPU engine for pyannote speaker diarization.
# Olares One is amd64; DGX Spark (GB10 Grace) is arm64 — both must run, so this
# image is built for both with `docker buildx --platform linux/amd64,linux/arm64`.
#
# It only PROVIDES the deps (torch CPU + pyannote.audio 4 + FastAPI); the actual
# server (diar.py) is injected at runtime from the chart ConfigMap via a command
# override, matching the VAD pattern. GPU acceleration (Blackwell/arm64 CUDA) is a
# later, separate image — this one is CPU-only and portable.
FROM python:3.11-slim

# ffmpeg: torchcodec (pyannote.audio 4 decoder) needs it. libsndfile: soundfile.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# CPU torch trio from the PyTorch CPU index (small, multi-arch manylinux wheels:
# x86_64 + aarch64). Pinned-but-floating-minor to stay compatible with pyannote 4.
RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      torch torchaudio torchcodec

# pyannote.audio 4 (required by speaker-diarization-community-1) + the web stack.
# torch is already satisfied above, so this won't pull a CUDA build from PyPI.
RUN pip install --no-cache-dir \
      "pyannote.audio==4.0.4" \
      fastapi "uvicorn[standard]" python-multipart soundfile

ENV HF_HUB_DISABLE_TELEMETRY=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

# Placeholder: the chart overrides this with `python /wrappers/diar.py`.
CMD ["python", "-c", "print('voice-engine-pyannote: run /wrappers/diar.py via the chart command override')"]
