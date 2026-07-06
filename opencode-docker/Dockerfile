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
#     -t docker.io/beclab/lovehunter9-anomalyco-opencode:1.17.0.0 --push opencode-docker/
#
# IMPORTANT runtime contract:
#   - /home/opencode is a hostPath (appData) that OVERLAYS this image at runtime,
#     so anything that must live under $HOME is NOT consumed directly from this
#     image; the chart's init seeds it from neutral, non-overlaid staging dirs
#     baked here:
#       /opt/olares-bake/opencode-cache/    -> seeded into ~/.cache/opencode (OMO)
#       /opt/olares-bake/opencode-skills/   -> seeded into ~/.config/opencode/skills (Olares Agent Skills)
#   - /usr /lib /bin /sbin /lib64 are served at runtime via an OverlayFS whose
#     read-only LOWER layer is THIS image's rootfs (zero copy) and whose small
#     persistent UPPER layer (on the appData hostPath) holds only user-installed
#     package deltas; the upper is never reset, so user packages persist across
#     upgrades with zero reinstall. Anything baked into the rootfs here (vite,
#     the olares-cli binary in the npm global prefix, bash, glibc, opencode)
#     therefore shows through the overlay lower automatically -- no $HOME seeding
#     and no snapshot copy needed. (A one-time, offline init migration imports any
#     packages a user installed under the legacy .pkg-root design into the upper.)
# ------------------------------------------------------------------------------

ARG OPENCODE_VERSION=1.17.13
ARG OMO_VERSION=4.8.1
ARG GLIBC_VERSION=2.35-r1
# Olares CLI npm version to bake. Its postinstall downloads the arch-specific Go
# vendor binary. Handled exactly like OPENCODE_VERSION / OMO_VERSION: a build-arg
# with a default here, overridable from build.sh and the GitHub CI workflow input.
ARG OLARES_CLI_NPM_VERSION=1.12.6-cli.2
# Pinned Alpine MINOR (vs the rolling `alpine` tag). The chart NEVER resets the
# OverlayFS upper, so the user's installed packages persist across upgrades with
# zero reinstall; pinning the minor keeps the base libs they link against
# ABI-stable while the upper is kept. Bump this only deliberately (and rarely).
# NOTE: pkg-manager.sh hardcodes the v3.23 mirror path for use-time installs;
# keep it in sync if this is bumped.
ARG ALPINE_TAG=3.23
# Single source of truth for the base apk package set (also keeps the package
# list out of the long RUN line below).
ARG BASE_PKGS="libgcc libstdc++ ripgrep python3 py3-pip git curl wget bash openssh-client nodejs npm go rust cargo iproute2 zip unzip gzip bzip2 xz tar zstd"

# ==============================================================================
# base: official base deps + our full toolchain (was: chart init-packages apk)
# ==============================================================================
FROM alpine:${ALPINE_TAG} AS base

# Match official image: disable bun's runtime transpiler cache in containers.
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}

# libgcc/libstdc++/ripgrep = official base deps; the rest = the exact base set
# the chart's init-packages used to `apk add` at runtime. List lives in the ARG
# above as a single source of truth.
ARG BASE_PKGS
RUN apk add --no-cache $BASE_PKGS

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
ARG OLARES_CLI_NPM_VERSION

# Verify the binary actually runs on this arch (under QEMU for the foreign arch).
RUN opencode --version

# Global npm tool (was: chart `npm install -g vite`).
RUN npm install -g --ignore-scripts vite

# ---- Olares CLI (was: user runs `npx @olares/cli@latest install`) -----------
# The wizard's first step is just `npm install -g @olares/cli`; its postinstall
# downloads an arch-specific Go binary into the package's vendor/ dir. Both the
# JS shim and the Go binary land under the npm GLOBAL PREFIX (rootfs), so they
# persist exactly like vite via the chart's .pkg-root snapshot -- no $HOME seed
# needed. We MUST do this in the per-arch `final` stage so the postinstall picks
# the matching binary (linux_amd64 / linux_arm64). Version is pinned via the
# OLARES_CLI_NPM_VERSION build-arg; `--version` asserts the vendor binary runs.
RUN npm install -g @olares/cli@${OLARES_CLI_NPM_VERSION} \
 && olares-cli --version

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

# ---- Bake the Olares Agent Skills into a NEUTRAL staging dir -----------------
# The wizard's second step is `npx skills add beclab/Olares -y -g`. We scope it
# to the opencode agent + all skills under a throwaway HOME. NOTE: the exact
# directory the `skills` tool writes to varies by tool version (older versions
# used ~/.config/opencode/skills; current ones use ~/.agents/skills), so we do
# NOT hardcode it -- we collect every installed skill dir by locating its
# SKILL.md, wherever it landed, and relocate those into the staging dir.
# At runtime opencode reads GLOBAL skills from ~/.config/opencode/skills/<name>/
# (this is where the chart already writes its own web-preview/system-admin
# skills), and /home/opencode is the appData hostPath that OVERLAYS this image,
# so the chart's init seeds these from staging into that dir on first boot
# (see design doc 9A). Asserts at least one SKILL.md so the build fails loudly
# if the skills repo clone/selection produced nothing.
RUN set -eu; \
    BAKE=/opt/olares-bake; \
    SKILLS_HOME="$BAKE/skillshome"; \
    DEST="$BAKE/opencode-skills"; \
    mkdir -p "$SKILLS_HOME" "$DEST"; \
    HOME="$SKILLS_HOME" npx -y skills add beclab/Olares -a opencode --skill '*' -g -y \
      >/tmp/skills-add.log 2>&1 || true; \
    found=0; \
    for f in $(find "$SKILLS_HOME" -type f -name SKILL.md); do \
      cp -a "$(dirname "$f")" "$DEST/"; \
      found=1; \
    done; \
    if [ "$found" != 1 ]; then \
      echo "FATAL: no SKILL.md found after 'skills add' (nothing installed)"; \
      tail -80 /tmp/skills-add.log || true; \
      exit 1; \
    fi; \
    rm -rf "$SKILLS_HOME" /tmp/skills-add.log; \
    echo "Baked Olares skills: $(ls "$DEST" | tr '\n' ' ')"

# ---- Bake the chart's init logic + static assets into the image ------------
# Moves the Helm chart's init-container scripts (init-setup / init-overlay /
# init-packages / pkg-manager / start-opencode) and the static content they
# used to inline (web-preview & system-admin SKILL.md, the OMO default config,
# the python config writer) out of the chart and into the image. The chart now
# only execs these (/opt/olares-bake/lib/<x>.sh) and passes the few dynamic
# values via env. pkg-install goes into the rootfs (rides the overlay lower),
# so init no longer writes it at runtime.
COPY olares-bake/lib/    /opt/olares-bake/lib/
COPY olares-bake/assets/ /opt/olares-bake/assets/
COPY olares-bake/pkg-install /usr/local/bin/pkg-install
RUN chmod +x /opt/olares-bake/lib/*.sh /usr/local/bin/pkg-install

# Record what was baked so the chart/init can pin & seed deterministically.
RUN set -eu; \
    CLI_VER="$(npm ls -g --depth=0 @olares/cli 2>/dev/null | sed -n 's/.*@olares\/cli@//p' | head -1)"; \
    SKILLS="$(ls /opt/olares-bake/opencode-skills 2>/dev/null | tr '\n' ',' | sed 's/,$//')"; \
    { \
      printf 'OPENCODE_VERSION=%s\n' "${OPENCODE_VERSION}"; \
      printf 'OMO_VERSION=%s\n' "${OMO_VERSION}"; \
      printf 'OMO_SPEC=oh-my-openagent@%s\n' "${OMO_VERSION}"; \
      printf 'OLARES_CLI_VERSION=%s\n' "${CLI_VER:-unknown}"; \
      printf 'OLARES_SKILLS=%s\n' "${SKILLS:-none}"; \
    } > /opt/olares-bake/BAKE_MANIFEST

# Keep the official entrypoint so the image is still a drop-in `opencode`.
ENTRYPOINT ["opencode"]
