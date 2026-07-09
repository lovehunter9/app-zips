---
name: local-dev-server
description: Start or restart the local Node demo servers (audiominutesxdemo on 8090, audiostudioxdemo on 8080, etc.) reliably. Use whenever the user asks to start / restart / bring up the 8090 or 8080 server, or after a rebuild that needs the server running for self-test.
---

# Local Dev Server (Node demos)

The ONLY reliable way to keep a local Node server alive in this environment.
Do not improvise other backgrounding methods — they always fail here.

## Standard restart flow (use exactly this)

Three separate Shell calls, in order. All use `required_permissions: ["all"]`
(the server needs real network to reach the Olares gateway; `&`-backgrounding is banned).

1. Free the port (separate call):

```bash
lsof -ti tcp:8090 | xargs kill -9 2>/dev/null; sleep 1; lsof -ti tcp:8090 2>/dev/null && echo BUSY || echo FREE
```

2. Start the server as the FOREGROUND process of a tool-managed background job
   — set `block_until_ms: 0` so the Shell tool keeps it alive. No `&`, no `nohup`, no redirect:

```bash
cd /Users/wangrongxiang/beclab/app-zips/audiominutesxdemo-app && DATA_DIR=./data PORT=8090 node server.js
```

3. Health-check in a SEPARATE call:

```bash
sleep 2; curl -s --max-time 3 http://127.0.0.1:8090/healthz; echo; lsof -ti tcp:8090 2>/dev/null && echo LISTENING
```

Expect `{"status":"ok","ffmpeg":true}` and `LISTENING`. If you also need to rebuild
the web first: `cd audiominutesxdemo-app/web && npm run build` (run from the `web` dir).

## App → port map

| App dir | Port | Data dir |
|---|---|---|
| `audiominutesxdemo-app` | 8090 | `DATA_DIR=./data` |
| `audiostudioxdemo-app` | 8080 | (default) |

## Why (root cause)

The Shell tool reaps child processes when a call returns. Any server started with
a trailing `&` (with or without `nohup`) is killed the moment the tool call
finishes — this shows up as **exit_code 143 (SIGTERM)** in a completion notification,
or as "connection refused" on the next curl. The fix is to make `node server.js`
the foreground process and let the tool's native backgrounding (`block_until_ms: 0`)
own it as a persistent job.

## Banned methods (these WILL fail — never try them)

- `node server.js &` / `nohup node server.js ... &` → child reaped, exit 143.
- `setsid ...` → not available on macOS (command not found).
- `nohup ... & disown` → still reaped; also flaky arg-parsing.
- Chaining start + curl in one call with `&` → the health check "passes" once, then
  the process dies right after.

## After starting

The persistent job survives only for the current session. If it dies later, tell the
user they can run it directly in their own terminal (their shell has real network and
won't get reaped): `cd audiominutesxdemo-app && DATA_DIR=./data PORT=8090 node server.js`.
