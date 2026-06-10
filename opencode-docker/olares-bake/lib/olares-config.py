import json
import os
from pathlib import Path

DOMAIN = os.environ.get("OLARES_OC_DOMAIN", "")
ENABLE_OMO = os.environ.get("OLARES_ENABLE_OMO", "0") == "1"
BASELINE_MD = Path("/home/opencode/.config/opencode/olares-baseline-instructions.md")
GLOBAL_JSON = Path("/home/opencode/.config/opencode/opencode.json")
WORKSPACE_JSON = Path("/home/opencode/workspace/opencode.json")
OLARES_REF = "/home/opencode/.config/opencode/olares-baseline-instructions.md"
OMO_VER = os.environ.get("OLARES_OMO_VERSION", "4.8.1")
parts = OMO_VER.split(".")
if len(parts) != 3 or not all(x.isdigit() for x in parts):
    OMO_VER = "4.8.1"
PLUGIN_NPM = f"oh-my-openagent@{OMO_VER}"
STALE_PLUGIN_NPM = "oh-my-opencode"

LEGACY_S1 = (
    "CRITICAL: You have special skills. ALWAYS run /skill load web-preview BEFORE any task involving "
    "web, server, preview, run, start, serve, build, create, demo, test, launch, deploy, site, app, page, "
    "website, frontend, backend, API, port, vite, react, next, vue, flask, go server, python server. "
    "ALWAYS run /skill load system-admin BEFORE installing ANY system package."
)
LEGACY_S2 = "NEVER use sudo, apt, or apk directly. Use pkg-install instead."
LEGACY_S3 = (
    f"NEVER show localhost URLs. The domain is {DOMAIN}. "
    f"Dev server preview URL format: https://{DOMAIN}/__preview/<port>/"
)
LEGACY = {LEGACY_S1, LEGACY_S2, LEGACY_S3}

# --- BASELINE content (free to edit; independent from LEGACY cleanup below) ---
BASELINE_WEB = (
    f"URL pattern: https://{DOMAIN}/__preview/<PORT>/\n"
    "Never show localhost or pod IPs; always use the URL above.\n\n"
    "When the user asks to preview a running web page, follow EXACTLY:\n\n"
    "1. Pick <PORT>:\n"
    "     - If the user specified a port, use it exactly; free it first: fuser -k <PORT>/tcp 2>/dev/null || true\n"
    "     - Else if you already started a preview in this session for the same project, reuse that port; free it with the same fuser -k command.\n"
    "     - Else pick the first free port starting from 5173 (Vite) or 3000 (others).\n"
    "2. Ensure deps: [ -d node_modules ] || npm install --silent\n"
    "3. Configure the framework for base path /__preview/<PORT>/:\n"
    "     Vite (vite.config.*): base: \"/__preview/<PORT>/\"\n"
    "     Next.js (next.config.*): basePath: \"/__preview/<PORT>\"; start with -H 0.0.0.0 -p <PORT>\n"
    "4. Launch exactly:\n"
    "     setsid nohup <START_CMD> >/tmp/preview-<PORT>.log 2>&1 </dev/null &   # verify: tail -f /tmp/preview-<PORT>.log\n\n"
    "NEVER use a plain HTTP server (python3 -m http.server, npx serve, npx http-server, busybox httpd, etc.) - they cannot serve files under /__preview/<PORT>/.\n"
    "For plain HTML (no framework), use vite as the server (pre-installed, no vite.config.js needed):\n"
    "     setsid nohup vite --host 0.0.0.0 --port <PORT> --base /__preview/<PORT>/ >/tmp/preview-<PORT>.log 2>&1 </dev/null &"
)
BASELINE_PKG = "NEVER use sudo, apt, or apk directly. Use pkg-install instead."

BASELINE_MD.parent.mkdir(parents=True, exist_ok=True)
md = (
    "<!-- olares-managed: baseline-instructions v2 (rewritten each pod start) -->\n\n"
    "# Olares environment baseline\n\n"
    "## Web preview and dev servers\n\n"
    + BASELINE_WEB
    + "\n\n## System packages\n\n"
    + BASELINE_PKG
    + "\n"
)
BASELINE_MD.write_text(md, encoding="utf-8")

cfg = {}
if GLOBAL_JSON.is_file():
    try:
        cfg = json.loads(GLOBAL_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        cfg = {}
instr = cfg.get("instructions")
if not isinstance(instr, list):
    instr = []
if OLARES_REF not in instr:
    instr = list(instr) + [OLARES_REF]
cfg["instructions"] = instr
cfg.setdefault("$schema", "https://opencode.ai/config.json")
plugins = cfg.get("plugin")
if not isinstance(plugins, list):
    plugins = []
plugins = [p for p in plugins if isinstance(p, str)]
plugins = [p for p in plugins if p != STALE_PLUGIN_NPM]
plugins = [p for p in plugins if not p.startswith("oh-my-openagent")]
if ENABLE_OMO:
    plugins.append(PLUGIN_NPM)
if plugins:
    cfg["plugin"] = plugins
else:
    cfg.pop("plugin", None)
GLOBAL_JSON.parent.mkdir(parents=True, exist_ok=True)
GLOBAL_JSON.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


if WORKSPACE_JSON.is_file():
    try:
        wcfg = json.loads(WORKSPACE_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        wcfg = None
    if wcfg is not None:
        winst = wcfg.get("instructions")
        legacy_changed = False
        if isinstance(winst, list):
            new_inst = [x for x in winst if x not in LEGACY]
            if new_inst != winst:
                legacy_changed = True
                if new_inst:
                    wcfg["instructions"] = new_inst
                else:
                    wcfg.pop("instructions", None)
        only_schema = isinstance(wcfg, dict) and set(wcfg.keys()) == {"$schema"}
        if legacy_changed:
            if not wcfg or only_schema:
                WORKSPACE_JSON.unlink(missing_ok=True)
            else:
                WORKSPACE_JSON.write_text(json.dumps(wcfg, indent=2, ensure_ascii=False), encoding="utf-8")
        elif only_schema:
            WORKSPACE_JSON.unlink(missing_ok=True)
