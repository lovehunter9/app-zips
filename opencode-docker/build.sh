#!/usr/bin/env bash
# Build the forked & baked OpenCode image (multi-arch).
#
# Usage:
#   ./build.sh                 # build both arches, load nothing (just validate)
#   PUSH=1 ./build.sh          # build + push to the registry
#   PLATFORMS=linux/amd64 ./build.sh   # single arch (native, fastest to test)
#
# Env knobs:
#   IMAGE      full image ref      (default beclab/anomalyco-opencode:1.16.0-olares1)
#   PLATFORMS  comma-sep platforms (default linux/amd64,linux/arm64)
#   PUSH       1 => --push, else --output type=image (no push)
#   OPENCODE_VERSION / OMO_VERSION / GLIBC_VERSION  override build args
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="${IMAGE:-beclab/anomalyco-opencode:1.16.0-olares1}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.16.0}"
OMO_VERSION="${OMO_VERSION:-4.7.5}"
GLIBC_VERSION="${GLIBC_VERSION:-2.35-r1}"

# A buildx builder that supports multi-arch (QEMU-backed). Create once.
BUILDER="${BUILDER:-olares-multiarch}"
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "=== Creating buildx builder '$BUILDER' ==="
  docker buildx create --name "$BUILDER" --driver docker-container --use
else
  docker buildx use "$BUILDER"
fi
# Register QEMU emulators for cross-arch (no-op if already installed).
docker run --rm --privileged tonistiigi/binfmt --install all >/dev/null 2>&1 || true

OUTPUT_ARG="--output=type=image"
[ "${PUSH:-0}" = "1" ] && OUTPUT_ARG="--push"

echo "=== Building $IMAGE ($PLATFORMS) ==="
echo "    opencode=$OPENCODE_VERSION omo=$OMO_VERSION glibc=$GLIBC_VERSION push=${PUSH:-0}"

docker buildx build \
  --platform "$PLATFORMS" \
  --build-arg "OPENCODE_VERSION=$OPENCODE_VERSION" \
  --build-arg "OMO_VERSION=$OMO_VERSION" \
  --build-arg "GLIBC_VERSION=$GLIBC_VERSION" \
  -t "$IMAGE" \
  $OUTPUT_ARG \
  .

echo "=== Done: $IMAGE ==="
