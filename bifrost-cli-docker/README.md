# Bifrost CLI sidecar image

A small node image with [`@maximhq/bifrost-cli`](https://docs.getbifrost.ai/quickstart/cli/getting-started)
(and the common coding-agent CLIs) pre-installed. It runs as an idle sidecar in
the Olares `bifrost` pod; the in-app **Terminal** entrance execs into this
container so the user can run `bifrost` to launch Claude Code / Codex / Gemini /
Opencode through the Bifrost gateway.

## What's inside
- `@maximhq/bifrost-cli` (the interactive agent launcher) — pre-installed.
- Best-effort pre-install of agents: `@anthropic-ai/claude-code`, `@openai/codex`,
  `@google/gemini-cli`, `opencode-ai`. If any are missing, the CLI installs them
  on demand at first use.
- `bash`, `git`, `curl`, `ca-certificates`.

## Usage in the Terminal
Inside the in-app Terminal (which lands in this container):

```bash
bifrost            # interactive launcher; base URL = http://localhost:8080
```

## Build (multi-arch)

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t docker.io/beclab/lovehunter9-bifrost-cli:0.0.1-test1 --push bifrost-cli-docker/
```

Build args: `NODE_VERSION` (default `22`), `BIFROST_CLI_VERSION` (default `latest`).
