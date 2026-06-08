# opencode-docker — forked & baked OpenCode image for Olares

Bakes everything the chart's init containers used to download at **runtime**
(apk packages, glibc, glibc opencode binary, global `vite`, the OMO plugin
cache) into **build time**, so first-boot init becomes a fast local copy with
zero network. User-facing behavior is unchanged — only "init is faster".

See the full design in `../opencode-docs/OpenCode_预装包内置化与镜像fork_设计文档.md`.

## Versions (pinned)

| Component | Version |
|---|---|
| opencode | **v1.16.0** (x86_64 = glibc build; arm64 = musl build) |
| OMO default | **oh-my-openagent@4.7.5** |
| glibc (sgerrand, x86_64 only) | 2.35-r1 |

Override at build time via `--build-arg OPENCODE_VERSION=... OMO_VERSION=... GLIBC_VERSION=...`.

## Build

```bash
# both arches, validate only (no push)
./build.sh

# both arches, push to registry
IMAGE=beclab/anomalyco-opencode:1.16.0-olares1 PUSH=1 ./build.sh

# single arch (native, fastest for a smoke test)
PLATFORMS=linux/amd64 ./build.sh
```

Requires Docker with `buildx`. The script creates a `docker-container` builder
and registers QEMU emulators so the foreign architecture can build under
emulation.

## What the image contains (vs the official 18-line Dockerfile)

The official Dockerfile `COPY dist/...` from opencode's own CI artifact (which we
don't have), so this is a **rewrite**, not an extension:

- Official base deps `libgcc libstdc++ ripgrep` **plus** the full toolchain the
  chart used to `apk add`: `python3 py3-pip git curl wget bash openssh-client
  nodejs npm go rust cargo iproute2 zip unzip gzip bzip2 xz tar zstd`.
- PEP 668 `EXTERNALLY-MANAGED` removed (pip/venv work).
- opencode binary fetched from the GitHub release: glibc `opencode-linux-x64.tar.gz`
  on x86_64 (avoids the documented musl segfault), musl
  `opencode-linux-arm64-musl.tar.gz` on arm64.
- glibc (sgerrand) + `/lib64` linker symlink on x86_64.
- Global `vite`.
- **OMO plugin cache** pre-warmed and staged at
  `/opt/olares-bake/opencode-cache/packages/oh-my-openagent@<ver>/` (see below).
- `/opt/olares-bake/BAKE_MANIFEST` records the pinned versions for the chart.

## IMPORTANT: runtime overlay contract (why we stage instead of bake-in-place)

At runtime the chart overlays hostPaths on top of this image:

- `/home/opencode` ← appData hostPath (so `~/.cache`, `~/.config`, etc. are the
  user's persistent data, NOT this image's copy).
- `/usr /lib /bin /sbin /lib64 …` ← the `.pkg-root` snapshot hostPath.

Therefore anything that must appear under those paths at runtime **cannot** be
consumed directly from the image. This image only **stages** the bakeable bits
under the neutral, non-overlaid `/opt/olares-bake/`; the chart's `init-packages`
then seeds them into the right place on first boot:

- base rootfs → snapshotted into `.pkg-root` (as today, but now a local copy
  instead of a networked install).
- `/opt/olares-bake/opencode-cache/packages/<spec>` → copied into
  `~/.cache/opencode/packages/<spec>` (one-time, marker-guarded).

The matching chart changes (init seed logic, version bumps, pinned plugin spec)
are specified in the design doc §9A and are a **separate step** from building
this image.

## OMO pre-warm caveat (arm64 / QEMU)

The OMO cache is populated by running `opencode run` once at build time to
trigger plugin resolution. For the foreign architecture this runs under QEMU. If
the emulated opencode binary fails to execute, the build **fails loudly** (the
`test -d .../node_modules` assertion). If that happens, build each arch natively
(`PLATFORMS=linux/arm64 ./build.sh` on an arm64 host) or pre-fetch the OMO cache
another way. Track per-arch build success the first time.
