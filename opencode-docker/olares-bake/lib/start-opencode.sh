#!/bin/sh
# Main container entrypoint wrapper. Kept tiny; all heavy init runs in the init
# containers. opencode is baked into the image; bash/glibc ride the overlay.
echo "=== Runtime check ==="
command -v bash >/dev/null 2>&1 && echo "bash OK" || echo "bash: waiting for pkg-manager fix"
if [ ! -f "$HOME/.venv/bin/activate" ]; then
  echo "Creating Python venv..."
  python3 -m venv "$HOME/.venv"
fi
exec opencode web --hostname 0.0.0.0 --port 3000
