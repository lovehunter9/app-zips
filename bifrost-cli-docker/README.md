# Bifrost CLI sidecar image

A small node image with [`@maximhq/bifrost-cli`](https://docs.getbifrost.ai/quickstart/cli/getting-started)
(and the common coding-agent CLIs) pre-installed. It runs as an idle sidecar in
the Olares `bifrost` pod; the in-app **Terminal** entrance execs into this
container so the user can run `bifrost` to launch Claude Code / Codex / Gemini /
Opencode through the Bifrost gateway.

## What's inside
- `bifrost` — the **real** Bifrost CLI binary, baked onto the system PATH at build
  time. The npm `@maximhq/bifrost-cli` package is only a bootstrapper that would
  otherwise re-download the ~11 MB binary into `$HOME/.bifrost/bin` on every call
  (and the runtime `$HOME` is a volume that shadows the image), so we run the
  download during build and install the binary to `/usr/local/bin/bifrost`.
  Result: ZERO download at use time.
- Pre-installed coding agents (binaries): `claude` (`@anthropic-ai/claude-code`),
  `codex` (`@openai/codex`), `gemini` (`@google/gemini-cli`), `opencode`
  (`opencode-ai`), `qwen` (`@qwen-code/qwen-code`).
- `bash`, `git`, `curl`, `ca-certificates`.

## Usage in the Terminal
Inside the in-app Terminal (which lands in this container):

```bash
bifrost            # interactive launcher; base URL = http://localhost:8080
claude / codex / gemini / opencode / qwen   # run an agent directly
```

## Build (multi-arch)

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t docker.io/beclab/lovehunter9-bifrost-cli:0.0.1-test2 --push bifrost-cli-docker/
```

Build args: `NODE_VERSION` (default `22`), `BIFROST_CLI_VERSION` (default `latest`).
