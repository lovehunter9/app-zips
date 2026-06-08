---
name: web-preview
description: "Framework-specific dev-server configs (Vite / Next.js / FastAPI / Flask / static / Go / Express), HMR setup, and a troubleshooting table for previewing web pages in Olares. The baseline 5-step launch flow is authoritative; this skill only fills in per-framework details."
---

## Scope

The mandatory 5-step launch flow is in the system baseline (always in your context).
This skill provides framework config snippets, optional HMR setup, and a troubleshooting table.
Do NOT re-derive the launch flow here; follow the baseline and use this document for details only.

## Framework configs

### Vite (vite.config.js / vite.config.ts)

```js
export default defineConfig({
  base: "/__preview/<PORT>/",
  server: {
    host: "0.0.0.0",
    port: <PORT>,
    // Optional: HMR over the TLS reverse proxy
    hmr: { protocol: "wss", clientPort: 443 },
  },
})
```

### Next.js (next.config.js / next.config.mjs)

```js
module.exports = {
  basePath: "/__preview/<PORT>",
  assetPrefix: "/__preview/<PORT>",
}
```

Launch: `setsid nohup npx next dev -H 0.0.0.0 -p <PORT> >/tmp/preview-<PORT>.log 2>&1 </dev/null &`

### FastAPI / uvicorn

```
setsid nohup uvicorn app:app --host 0.0.0.0 --port <PORT> --root-path /__preview/<PORT> >/tmp/preview-<PORT>.log 2>&1 </dev/null &
```

### Flask

Flask does not accept a base-path flag. Use a WSGI prefix middleware (werkzeug DispatcherMiddleware) or set APPLICATION_ROOT in config. Bind `--host 0.0.0.0 --port <PORT>` and launch with the same `setsid nohup` template.

### Static HTML (no bundler)

Vite is pre-installed globally; no project setup or config file needed.

```
setsid nohup vite --host 0.0.0.0 --port <PORT> --base /__preview/<PORT>/ >/tmp/preview-<PORT>.log 2>&1 </dev/null &
```

### Go / Express / custom servers

Bind to `0.0.0.0:<PORT>` and route everything under `/__preview/<PORT>/`. Examples:
- Express: `app.use("/__preview/<PORT>", router)`
- Go: `http.Handle("/__preview/<PORT>/", http.StripPrefix("/__preview/<PORT>", handler))`

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| White page; console 404 on /src/main.js or /assets/* | base path not configured | Set `base` (Vite) / `basePath` (Next) to `/__preview/<PORT>/` |
| HMR / WebSocket errors in browser console | dev-server WS unaware of the TLS proxy | Vite: add `server.hmr: { protocol: "wss", clientPort: 443 }` |
| EADDRINUSE at launch | port chosen per baseline is still in use | `fuser -k <PORT>/tcp 2>/dev/null` then re-launch (follow baseline step 1 to decide whether to reuse or pick another port) |
| Server dies immediately after launch | shell hangup; missing `setsid` or stdio not closed | Use the exact launch template from the baseline |
| 502 / connection refused via the preview URL | server bound to 127.0.0.1 only | Add `--host 0.0.0.0` (or framework equivalent) |

## Verifying a running server

```
tail -f /tmp/preview-<PORT>.log          # startup output
ss -tlnp | grep ":<PORT>\b"              # confirm the listener
curl -sI http://127.0.0.1:<PORT>/        # local-side sanity check
```
