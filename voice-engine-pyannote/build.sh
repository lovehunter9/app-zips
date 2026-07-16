#!/usr/bin/env bash
# Build + push the multi-arch (amd64 + arm64) pyannote diarization engine.
# Requires: docker buildx + QEMU (for cross-arch), and `docker login` to push to beclab.
#
#   ./build.sh                 # builds & pushes docker.io/beclab/voice-engine-pyannote:1.0.0
#   IMAGE=... ./build.sh       # override the target tag
set -euo pipefail

IMAGE="${IMAGE:-docker.io/beclab/voice-engine-pyannote:1.0.0}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
cd "$(dirname "$0")"

# Ensure a buildx builder exists (with QEMU emulation for the non-host arch).
docker buildx inspect vep-builder >/dev/null 2>&1 || docker buildx create --name vep-builder --use
docker buildx use vep-builder

echo "[build] $IMAGE for $PLATFORMS"
docker buildx build \
  --platform "$PLATFORMS" \
  -t "$IMAGE" \
  --push \
  .

echo "[done] pushed $IMAGE"
echo "[verify] docker buildx imagetools inspect $IMAGE   # should list amd64 + arm64"
