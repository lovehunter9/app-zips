# syntax=docker/dockerfile:1
#
# Forked & "baked" OpenCode image for Olares.
# ------------------------------------------------------------------------------
# Goal: move everything the chart's init containers used to download at RUNTIME
# (apk packages, glibc, glibc opencode binary, global npm tools, the OMO plugin
# cache) into BUILD TIME, so first-boot init becomes a local copy (seconds, zero
# network) instead of a minutes-long networked install.
#
# This does NOT extend the official 18-line Dockerfile: that one `COPY dist/...`
# from an artifact produced by opencode's own CI, which we do not have. We
# rebuild a self-contained image that fetches the opencode binary from the
# GitHub release (glibc build on x86_64 to avoid the documented musl segfault;
# musl build on arm64, matching the official base image).
#
# Multi-arch build (amd64 + arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t beclab/anomalyco-opencode:1.16.0-olares1 --push opencode-docker/
#
# IMPORTANT runtime contract (unchanged from today):
#   - /home/opencode  is a hostPath (appData) that OVERLAYS this image at runtime.
#   - /usr /lib /bin … are overlaid by the .pkg-root hostPath snapshot.
#   Therefore anything that must be visible at runtime under those paths is NOT
#   consumed directly from this image; the chart's init seeds it from neutral,
#   non-overlaid staging dirs baked here:
#       /opt/olares-bake/opencode-cache/   -> seeded into ~/.cache/opencode (OMO)
#   and the base rootfs is snapshotted by init into .pkg-root as before.
# ------------------------------------------------------------------------------

ARG OPENCODE_VERSION=1.16.0
ARG OMO_VERSION=4.7.5
ARG GLIBC_VERSION=2.35-r1

# ==============================================================================
# base: official base deps + our full toolchain (was: chart init-packages apk)
# ==============================================================================
FROM alpine AS base

# Match official image: disable bun's runtime transpiler cache in containers.
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}

# libgcc/libstdc++/ripgrep = official base deps.
# The rest = the exact BASE_PKGS the chart's init-packages used to `apk add`.
RUN apk add --no-cache \
      libgcc libstdc++ ripgrep \
      python3 py3-pip git curl wget bash openssh-client \
      nodejs npm go rust cargo iproute2 \
      zip unzip gzip bzip2 xz tar zstd

# PEP 668: let pip / venv work (was: chart `rm -f .../EXTERNALLY-MANAGED`).
RUN rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED

# Sanity: node must be >= 20 (OMO 4.x transitive deps require it).
RUN node --version && node -e 'process.exit(parseInt(process.versions.node)>=20?0:1)'

# ==============================================================================
# build-amd64: glibc + glibc opencode binary (x86_64)
# ==============================================================================
FROM base AS build-amd64
ARG OPENCODE_VERSION
ARG GLIBC_VERSION

# Embed the sgerrand signing key (same key the chart uses) and install glibc,
# so the glibc opencode build runs without the musl segfault (issues #3876/#14867).
RUN printf '%s' "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlJQklqQU5CZ2txaGtpRzl3MEJBUUVGQUFPQ0FROEFNSUlCQ2dLQ0FRRUFwWjJ1MUtKS1V1L2ZXNEEyNXk5bQp5NzBBR0VhL0ozV2k1aWJOVkdObjFnVDFyMFZmZ2VXZDBwVXliUzRVbWNIZGlOenhKUGdvV1FoVjJTU1cxSll1CnRPcUtaRjVRU042WDkzN1BUVXBOQmpVdkx0VFExdmUxZnAzOXVmL2xFWFBwRnBPUEw4OExLbkRCZ2JoN3drQ3AKbTJLekxWR0NoZjgzTVMwU2hMNkc5RVFJQVV4TG05OVZwZ1Jqd3FUUS9LZnpHdHBrZTF3cXdzNGF1MEFiNHFQWQpLWHZNTFNQTFVwN2NmdWxXdmhtWlNlZ3I1QWRoTnc1S05pelBxQ0pUOFpyR3ZnSHlwWHlpRnZ2QUg1WVJ0U3NjClp2bzlHSTJlMk1hWnlvOS9sdmIrTGJMRUpaS0VRY2txUmo0UDI2Z21BU3JaRVBTdHdjK3lxeTFTaEhMQTBqNm0KMVFJREFRQUIKLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tCg==" \
      | base64 -d > /etc/apk/keys/sgerrand.rsa.pub \
 && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/glibc.apk \
      "https://github.com/sgerrand/alpine-pkg-glibc/releases/download/${GLIBC_VERSION}/glibc-${GLIBC_VERSION}.apk" \
 && (apk del libc6-compat gcompat 2>/dev/null || true) \
 && apk add --no-cache --force-overwrite /tmp/glibc.apk libstdc++ \
 && mkdir -p /lib64 \
 && ln -sf /usr/glibc-compat/lib/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2 \
 && rm -f /tmp/glibc.apk

# glibc opencode binary (the tarball extracts an `opencode` executable).
RUN curl -fsSL --retry 3 --retry-delay 2 -o /tmp/oc.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
 && tar -xzf /tmp/oc.tar.gz -C /usr/local/bin \
 && chmod +x /usr/local/bin/opencode \
 && rm -f /tmp/oc.tar.gz

# glibc loader path (mirrors the chart's runtime env on the opencode container).
ENV LD_LIBRARY_PATH=/usr/glibc-compat/lib

# ==============================================================================
# build-arm64: musl opencode binary (arm64 stays musl, like official base)
# ==============================================================================
FROM base AS build-arm64
ARG OPENCODE_VERSION

RUN curl -fsSL --retry 3 --retry-delay 2 -o /tmp/oc.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-arm64-musl.tar.gz" \
 && tar -xzf /tmp/oc.tar.gz -C /usr/local/bin \
 && chmod +x /usr/local/bin/opencode \
 && rm -f /tmp/oc.tar.gz

# ==============================================================================
# final: pick per-arch stage, bake global npm tools + OMO plugin cache
# ==============================================================================
ARG TARGETARCH
FROM build-${TARGETARCH} AS final
ARG OPENCODE_VERSION
ARG OMO_VERSION

# Verify the binary actually runs on this arch (under QEMU for the foreign arch).
RUN opencode --version

# Global npm tool (was: chart `npm install -g vite`).
RUN npm install -g --ignore-scripts vite

# ---- Bake the OMO plugin cache into a NEUTRAL staging dir --------------------
# opencode's plugin loader installs declared plugins into
#   $HOME/.cache/opencode/packages/<plugin-spec>/node_modules/
# At runtime $HOME=/home/opencode is a hostPath (appData) that OVERLAYS this
# image, so we must NOT bake into /home/opencode/.cache (it would be hidden).
# Instead: pre-warm under a throwaway HOME, then relocate the populated cache
# into /opt/olares-bake/opencode-cache/ (outside any runtime hostPath). The
# chart's init seeds it into the real ~/.cache on first boot (see design doc 9A).
#
# The pre-warm runs `opencode run` only to trigger plugin resolution/install,
# which completes at startup BEFORE any model call; we time-box it and then
# assert the cache dir exists so the build fails loudly if pre-warm did not
# populate it (e.g. QEMU could not execute the foreign-arch binary).
ENV OMO_SPEC="oh-my-openagent@${OMO_VERSION}"
RUN set -eu; \
    BAKE=/opt/olares-bake; \
    WARM_HOME="$BAKE/ochome"; \
    mkdir -p "$WARM_HOME/.config/opencode"; \
    printf '{ "$schema": "https://opencode.ai/config.json", "plugin": ["%s"] }\n' "$OMO_SPEC" \
      > "$WARM_HOME/.config/opencode/opencode.json"; \
    HOME="$WARM_HOME" timeout -s KILL 180 opencode run "noop" >/tmp/omo-warm.log 2>&1 || true; \
    if [ ! -d "$WARM_HOME/.cache/opencode/packages/$OMO_SPEC/node_modules" ]; then \
      echo "FATAL: OMO pre-warm did not populate cache for $OMO_SPEC"; \
      tail -40 /tmp/omo-warm.log || true; \
      exit 1; \
    fi; \
    mkdir -p "$BAKE/opencode-cache/packages"; \
    cp -a "$WARM_HOME/.cache/opencode/packages/$OMO_SPEC" "$BAKE/opencode-cache/packages/"; \
    rm -rf "$WARM_HOME" /tmp/omo-warm.log; \
    echo "Baked OMO cache: $(du -sh "$BAKE/opencode-cache/packages/$OMO_SPEC" | cut -f1)"

# Record what was baked so the chart/init can pin & seed deterministically.
RUN printf 'OPENCODE_VERSION=%s\nOMO_VERSION=%s\nOMO_SPEC=%s\n' \
      "${OPENCODE_VERSION}" "${OMO_VERSION}" "oh-my-openagent@${OMO_VERSION}" \
      > /opt/olares-bake/BAKE_MANIFEST

# Keep the official entrypoint so the image is still a drop-in `opencode`.
ENTRYPOINT ["opencode"]
