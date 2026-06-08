#!/bin/sh
# init-setup: runs every start as root. Lays down the $HOME-side config that
# lives on the appData hostPath (skills, baseline instructions, opencode.json,
# OMO agent config) and fixes ownership. All static content is baked into the
# image under /opt/olares-bake; only the dynamic values come from env:
#   OLARES_OC_DOMAIN     - opencode public domain (from chart .Values.domain)
#   OLARES_ENABLE_OMO    - "1"/"0" (from chart olaresEnv OPENCODE_OMO)
#   OLARES_OMO_VERSION   - OMO plugin version (from chart olaresEnv)
set -e
BAKE=/opt/olares-bake

mkdir -p /home/opencode/workspace \
         /home/opencode/.opencode \
         /home/opencode/.config/opencode \
         /home/opencode/.config/opencode/skills/web-preview \
         /home/opencode/.config/opencode/skills/system-admin \
         /home/opencode/.pkg-queue

# Chart-managed skills: overwritten every start from the baked copies.
cp "$BAKE/assets/skills/web-preview/SKILL.md" \
   /home/opencode/.config/opencode/skills/web-preview/SKILL.md
cp "$BAKE/assets/skills/system-admin/SKILL.md" \
   /home/opencode/.config/opencode/skills/system-admin/SKILL.md

echo "=== Olares global baseline / plugin + workspace legacy instructions cleanup (python) ==="
python3 "$BAKE/lib/olares-config.py"

OMO_AGENT_CFG="/home/opencode/.config/opencode/oh-my-openagent.json"
if [ ! -f "$OMO_AGENT_CFG" ]; then
  echo "=== Writing default oh-my-openagent.json ==="
  cp "$BAKE/assets/oh-my-openagent.default.json" "$OMO_AGENT_CFG"
fi

chown 1000:1000 /home/opencode /home/opencode/workspace
# Skip .pkg-root and .pkg-overlay: their upper holds root-owned apk files and
# the merged subtree is an overlay mount -- chown -R must never touch it.
find /home/opencode -mindepth 1 -maxdepth 1 \
  ! -name '.pkg-root' ! -name '.pkg-overlay' \
  -exec chown -R 1000:1000 {} +
