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
#     -t docker.io/beclab/lovehunter9-bifrost-cli:0.0.1-test1 --push bifrost-cli-docker/
# ------------------------------------------------------------------------------
ARG NODE_VERSION=22
ARG BIFROST_CLI_VERSION=latest

FROM node:${NODE_VERSION}-alpine
ARG BIFROST_CLI_VERSION

# bash = nicer interactive shell; git = required by some agents (e.g. Claude Code
# worktrees); curl/ca-certificates = quick REST pokes against the gateway.
RUN apk add --no-cache bash git curl ca-certificates

# Pre-install the Bifrost CLI globally so `bifrost` is ready with ZERO download at
# use time. (`@maximhq/bifrost-cli` is the interactive agent launcher, distinct
# from `@maximhq/bifrost` which is the gateway server we already run.)
RUN npm install -g @maximhq/bifrost-cli@${BIFROST_CLI_VERSION} \
 && (bifrost --help >/dev/null 2>&1 || true)

# Best-effort pre-install of the coding agents the CLI can launch. NON-FATAL: if a
# package name changes upstream, the CLI still offers to install it on demand at
# first use (use-time network is fine; this app has no offline constraint).
RUN npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      @google/gemini-cli \
      opencode-ai \
  || echo "WARN: some agents not pre-installed; CLI will install on demand"

# The chart runs the pod as uid/gid 1000 and sets HOME onto the appData volume,
# so ~/.bifrost (CLI config) persists. node:alpine already ships a uid 1000 user.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /home/node

# Idle; the Terminal component execs bash into this container.
CMD ["tail", "-f", "/dev/null"]
