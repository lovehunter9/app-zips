# opencode-docker — forked & baked OpenCode image for Olares

Bakes everything the chart's init containers used to download at **runtime**
(apk packages, glibc, glibc opencode binary, global `vite`, the Olares CLI, the
OMO plugin cache, the Olares Agent Skills) into **build time**, so first-boot
init becomes a fast local copy with zero network. User-facing behavior is
unchanged — only "init is faster".

See the full design in `../opencode-docs/OpenCode_预装包内置化与镜像fork_设计文档.md`.

## Versions (pinned)

| Component | Version |
|---|---|
| opencode | **v1.17.0** (x86_64 = glibc build; arm64 = musl build) |
| OMO default | **oh-my-openagent@4.8.1** |
| glibc (sgerrand, x86_64 only) | 2.35-r1 |

Override at build time via `--build-arg OPENCODE_VERSION=... OMO_VERSION=... GLIBC_VERSION=...`.

## Build

```bash
# both arches, validate only (no push)
./build.sh

# both arches, push to registry
IMAGE=docker.io/beclab/lovehunter9-anomalyco-opencode:1.17.0.0 PUSH=1 ./build.sh

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
- **Olares CLI** (`npm install -g @olares/cli@latest`) — the JS shim + the
  arch-specific Go binary (downloaded into the package's `vendor/` by its
  postinstall). Both live in the npm global prefix (rootfs), so they ride the
  `.pkg-root` snapshot like `vite` — **no `$HOME` seeding needed**. This is the
  `npm install -g @olares/cli` half of `npx @olares/cli@latest install`.
- **OMO plugin cache** pre-warmed and staged at
  `/opt/olares-bake/opencode-cache/packages/oh-my-openagent@<ver>/` (see below).
- **Olares Agent Skills** installed (`skills add beclab/Olares -a opencode
  --skill '*'`, the skills half of the wizard) and staged at
  `/opt/olares-bake/opencode-skills/` — they target `~/.config/opencode/skills`
  which is overlaid at runtime, so they are staged + seeded like the OMO cache.
- `/opt/olares-bake/BAKE_MANIFEST` records the pinned versions (opencode / OMO /
  olares-cli / skills list) for the chart.

## Dockerfile walkthrough (stage by stage)

Relationship to upstream: the official image is ~18 lines that `FROM alpine`, add
`libgcc libstdc++ ripgrep`, set `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, **`COPY`
their own CI-built `dist/` binary**, and `ENTRYPOINT ["opencode"]`. We can't
extend that (we don't have their artifact), so this is a **self-contained
rewrite** that keeps the same alpine base, the same base deps, the same BUN knob
and entrypoint — the only real divergence is fetching the opencode binary from
the **GitHub release** instead of `COPY`-ing a private artifact. Everything else
added here is just moving the chart's old runtime installs to build time.

Multi-stage layout (`TARGETARCH` is injected by buildx per platform):

```
base ──► build-amd64 ─┐
   └───► build-arm64 ─┴─► final
```

- **`base`** — alpine + full toolchain. Official base deps (`libgcc libstdc++
  ripgrep`) plus the exact `BASE_PKGS` the chart's `init-packages` used to
  `apk add`; removes PEP 668 `EXTERNALLY-MANAGED`; asserts node >= 20.
  → replaces the chart's networked "Installing system packages" step.
- **`build-amd64`** (x86_64 only) — embeds the sgerrand key, installs **glibc**
  + the `/lib64/ld-linux-x86-64.so.2` symlink, downloads the **glibc** opencode
  binary (`opencode-linux-x64.tar.gz`), sets `LD_LIBRARY_PATH`.
  → replaces the chart's runtime glibc download + opencode binary swap.
- **`build-arm64`** (arm64 only) — downloads the **musl** opencode binary
  (`opencode-linux-arm64-musl.tar.gz`); no glibc, matching upstream.
- **`final`** (`FROM build-${TARGETARCH}`) — `opencode --version` smoke test;
  `npm install -g vite`; `npm install -g @olares/cli@latest`; pre-warm + stage
  the OMO cache; install + stage the Olares skills; write `BAKE_MANIFEST`; keep
  `ENTRYPOINT ["opencode"]`.
  → replaces the chart's `npm install -g vite`, the global-npm OMO install, and
  the `npx @olares/cli@latest install` the user used to run by hand.

Build-time vs runtime split: `base`/`build-*` populate the **rootfs** (`/usr`,
`/lib`, `/lib64`, …) which the chart snapshots into `.pkg-root`; `final` also
writes the two **staging dirs** under `/opt/olares-bake/` that the chart seeds
into `$HOME` (next section explains why).

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
  instead of a networked install). The olares-cli binary rides along here.
- `/opt/olares-bake/opencode-cache/packages/<spec>` → copied into
  `~/.cache/opencode/packages/<spec>` (one-time, marker-guarded).
- `/opt/olares-bake/opencode-skills/` → copied into
  `~/.config/opencode/skills/` (one-time, marker-guarded).

The matching chart changes (init seed logic for the OMO cache **and** the
skills, version bumps, pinned plugin spec) are specified in the design doc §9A
and are **already implemented** in `opencode/templates/opencode.yaml`
(`seed_omo_cache` / `seed_skills`, both called on the cached and fresh init
paths). Building this image and shipping the chart are still two separate
artifacts, but the runtime side is in place.

### Caveat: Olares skill descriptions vs the 1024-char limit

Several of the `beclab/Olares` skills (the build installs 7: olares-cluster,
-dashboard, -files, -market, -settings, -shared, -chart) currently have a
`description` longer than the 1024-char limit opencode/zed/codex document.
opencode **silently loads** them (no error/truncation), but over-long
descriptions bloat the agent's tool/skill context. Baking the skills in by
default ships that to every user. This is a skill-authoring issue in
`beclab/Olares`, independent of this image; flagged here so the trade-off is
explicit.

## OMO pre-warm caveat (arm64 / QEMU)

The OMO cache is populated by running `opencode run` once at build time to
trigger plugin resolution. For the foreign architecture this runs under QEMU. If
the emulated opencode binary fails to execute, the build **fails loudly** (the
`test -d .../node_modules` assertion). If that happens, build each arch natively
(`PLATFORMS=linux/arm64 ./build.sh` on an arm64 host) or pre-fetch the OMO cache
another way. Track per-arch build success the first time.
