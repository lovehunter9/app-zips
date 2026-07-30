---
name: web-preview
description: "Framework-specific dev-server configs (Vite / Next.js / FastAPI / Flask / static / Go / Express), HMR setup, and a troubleshooting table for previewing web pages in Olares. Each newly-opened port is exposed at its own subdomain `https://<appid>-<port>.<zone>` served at the site root. The baseline 5-step launch flow is authoritative; this skill only fills in per-framework details."
---

## Scope

The mandatory 5-step launch flow is in the system baseline (always in your context).
This skill provides framework config snippets, optional HMR setup, and a troubleshooting table.
Do NOT re-derive the launch flow here; follow the baseline and use this document for details only.

## Preview URL (what to output to the user)

Each port the dev server listens on is automatically exposed as its OWN subdomain,
served at the site root (`/`) — there is no `/__preview/<port>/` path prefix anymore.

The URL format is:

```text
https://<appid>-<port>.<zone>
```

Substitute all three variables with real values before showing the URL:

- `<appid>` and `<zone>` — take the OpenCode domain in the browser address bar,
  which is `https://<label>.<zone>`, and split it into the first DNS label and the
  rest (`<zone>`, e.g. `olaresid.olares.cn`). The `<appid>` is the FIRST 8
  CHARACTERS of that first label:
  - if the label is already 8 chars, use it as-is
    (`1f47cd9b` → `<appid>` = `1f47cd9b`);
  - if the label is 9 chars, drop the trailing char
    (`1f47cd9b0` → `<appid>` = `1f47cd9b`).
- `<port>` — the port the dev server actually listens on.

Examples (both resolve to the same 8-char appid):
- `https://1f47cd9b.olaresid.olares.cn` + port `9999` → `https://1f47cd9b-9999.olaresid.olares.cn`
- `https://1f47cd9b0.olaresid.olares.cn` + port `9999` → `https://1f47cd9b-9999.olaresid.olares.cn`

Notes:
- Only a NEWLY-opened listening port is exposed, and the route needs a few seconds
  to appear after the server starts — retry once if the URL 404s immediately.
- Because the app is served at the root of its own subdomain, do NOT set any
  base path / sub-path (`base`, `basePath`, `--root-path`, `assetPrefix`, route
  prefixes). Configure everything for `/`.

## Framework configs

### Vite (vite.config.js / vite.config.ts)

```js
export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: <PORT>,
    // The preview hostname is dynamic; allow it (Vite blocks unknown hosts).
    allowedHosts: true,
    // Optional: HMR over the TLS reverse proxy (page is served on :443)
    hmr: { protocol: "wss", clientPort: 443 },
  },
})
```

### Next.js (next.config.js / next.config.mjs)

No base path is needed — Next serves at the root of the subdomain. Launch:

```
setsid nohup npx next dev -H 0.0.0.0 -p <PORT> >/tmp/preview-<PORT>.log 2>&1 </dev/null &
```

### FastAPI / uvicorn

```
setsid nohup uvicorn app:app --host 0.0.0.0 --port <PORT> >/tmp/preview-<PORT>.log 2>&1 </dev/null &
```

### Flask

Bind `--host 0.0.0.0 --port <PORT>` and launch with the standard `setsid nohup`
template. No prefix middleware or `APPLICATION_ROOT` is required — the app is
served at the root of its subdomain.

### Static HTML (no bundler)

```
setsid nohup python3 -m http.server <PORT> --bind 0.0.0.0 >/tmp/preview-<PORT>.log 2>&1 </dev/null &
```

### Go / Express / custom servers

Bind to `0.0.0.0:<PORT>` and serve routes from the root. Examples:

- Express: `app.use("/", router)`
- Go: `http.Handle("/", handler)`

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Blocked request. This host is not allowed." | dev server rejects the dynamic preview hostname | Vite: set `server.allowedHosts: true`; other servers: disable host checking |
| White page; console 404 on /src/main.js or /assets/* | a leftover base/sub-path config | Remove `base` / `basePath` / `assetPrefix` / `--root-path`; serve at `/` |
| Preview URL 404s right after launch | the per-port route hasn't been programmed yet | Wait a few seconds and retry; confirm the port is `LISTEN` |
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
