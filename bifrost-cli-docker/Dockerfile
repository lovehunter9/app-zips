# syntax=docker/dockerfile:1
#
# Bifrost CLI sidecar image for Olares.
# ------------------------------------------------------------------------------
# A small node image with @maximhq/bifrost-cli (and the common coding-agent CLIs)
# pre-installed. It runs as an idle sidecar in the bifrost pod; the in-app
# Terminal component (templates/terminal.yaml) execs into THIS container so the
# user can run `bifrost` to launch Claude Code / Codex / Gemini / Opencode
# through the Bifrost gateway (base URL http://localhost:8080 inside the pod).
#
# Multi-arch build (amd64 + arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t docker.io/beclab/lovehunter9-bifrost-cli:0.10.5.0 --push bifrost-cli-docker/
# ------------------------------------------------------------------------------
ARG NODE_VERSION=22
ARG BIFROST_CLI_VERSION=latest

FROM node:${NODE_VERSION}-alpine
ARG BIFROST_CLI_VERSION

# bash = nicer interactive shell; git = required by some agents (e.g. Claude Code
# worktrees); curl/ca-certificates = quick REST pokes against the gateway.
RUN apk add --no-cache bash git curl ca-certificates

# Pre-install the Bifrost CLI. IMPORTANT: the npm package is only a BOOTSTRAPPER —
# running `bifrost` downloads the real binary into $HOME/.bifrost/bin at first use.
# Because the runtime HOME is the appData volume (which shadows the image), a binary
# baked into HOME would be hidden, and the bootstrapper re-downloads on every call.
# So we trigger the download HERE (build time, HOME=/root) and bake the REAL binary
# onto the system PATH (/usr/local/bin/bifrost, overwriting the npm shim) -> ready
# with ZERO download at use time, never shadowed by the volume.
RUN npm install -g @maximhq/bifrost-cli@${BIFROST_CLI_VERSION}

# Trigger the bootstrapper's one-time download (non-fatal), then REQUIRE that the
# real binary exists and bake it onto the system PATH, overwriting the npm shim.
# Fatal on purpose: if zero-download cannot be guaranteed, fail the build loudly
# rather than ship an image that re-downloads on every `bifrost` invocation.
RUN bifrost --version >/dev/null 2>&1 || true; \
    test -f "$HOME/.bifrost/bin/bifrost" \
      && install -m 0755 "$HOME/.bifrost/bin/bifrost" /usr/local/bin/bifrost \
      && echo "baked real bifrost binary -> $(command -v bifrost)"

# Pre-install the 4 coding agents the Bifrost CLI can launch (binaries: claude /
# codex / gemini / opencode). Kept in their own layer (known-good set).
RUN npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      @google/gemini-cli \
      opencode-ai \
  || echo "WARN: some agents not pre-installed; CLI will install on demand"

# Qwen Code (binary: qwen) — not a Bifrost-CLI harness, but an OpenAI-compatible
# coding agent that works against the gateway; users can run it directly. Separate
# layer + non-fatal so a name/version change here can never break the 4 above.
RUN npm install -g @qwen-code/qwen-code \
  || echo "WARN: qwen-code not pre-installed; install on demand"

# Speed up the Bifrost CLI's harness version probe. The chooser runs `<bin>
# --version` with a short (~1s) timeout; gemini (~2.4s) and opencode (~1.0s) are
# slow to boot and get labelled "timeout" (cosmetic — the harness still works).
# Wrap just those two: intercept --version/-v to echo a version captured HERE at
# build time (instant), and exec the real binary for everything else so launching
# the agent is completely unaffected. (claude/codex are ~0.1s, left untouched.)
# NOTE: the Terminal auto-launches the CLI via the chart's ~/.bashrc, not a shell
# wrapper, so no bifrost-shell is baked here.
RUN set -eu; \
    mkdir -p /usr/local/share/bifrost-cli; \
    for h in gemini opencode; do \
      real="$(command -v "$h" || true)"; \
      [ -n "$real" ] || { echo "WARN: $h not found; skip version-cache wrapper"; continue; }; \
      dir="$(dirname "$real")"; \
      mv "$real" "$dir/$h.real"; \
      "$dir/$h.real" --version 2>/dev/null | head -n1 > "/usr/local/share/bifrost-cli/$h.version" || true; \
      { \
        echo '#!/bin/sh'; \
        echo "real=\"$dir/$h.real\""; \
        echo "cache=\"/usr/local/share/bifrost-cli/$h.version\""; \
        echo 'case "$1" in'; \
        echo '  --version|-v) v="$(cat "$cache" 2>/dev/null)"; [ -n "$v" ] && { echo "$v"; exit 0; } ;;'; \
        echo 'esac'; \
        echo 'exec "$real" "$@"'; \
      } > "$dir/$h"; \
      chmod 0755 "$dir/$h"; \
      echo "wrapped $h -> cached version [$(cat /usr/local/share/bifrost-cli/$h.version 2>/dev/null)]"; \
    done

# The chart runs the pod as uid/gid 1000 and sets HOME onto the appData volume,
# so ~/.bifrost (CLI config) persists. node:alpine already ships a uid 1000 user.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /home/node

# Idle; the Terminal component execs bash into this container.
CMD ["tail", "-f", "/dev/null"]
