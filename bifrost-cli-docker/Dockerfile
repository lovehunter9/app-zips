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
#     -t docker.io/beclab/lovehunter9-bifrost-cli:0.0.1-test2 --push bifrost-cli-docker/
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

# The chart runs the pod as uid/gid 1000 and sets HOME onto the appData volume,
# so ~/.bifrost (CLI config) persists. node:alpine already ships a uid 1000 user.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /home/node

# Idle; the Terminal component execs bash into this container.
CMD ["tail", "-f", "/dev/null"]
