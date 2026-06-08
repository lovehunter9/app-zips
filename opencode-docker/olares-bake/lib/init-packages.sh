#!/bin/sh
# init-packages: runs as root after init-overlay. The base toolchain (node,
# opencode, glibc, bash, vite, olares-cli, pkg-install) is baked into the image
# and visible via the overlay lower, so there is nothing to install here on a
# fresh boot. This script only: sets up $HOME env files, seeds the appData-side
# caches (OMO, skills, /etc bits), and restores user-installed apk packages into
# the persistent overlay upper. Reads env:
#   OLARES_OMO_VERSION  - OMO plugin version (from chart olaresEnv)

# State dir on the appData hostPath. /usr /bin /sbin /lib /lib64 are OverlayFS
# merges (set up by init-overlay): lower=image, upper here. Writes below (apk)
# land in the overlay upper.
PKG="/home/opencode/.pkg-overlay"
BAKE_MANIFEST="/opt/olares-bake/BAKE_MANIFEST"
# Marker binds to the baked image (opencode/OMO/cli/skills versions). Same hash
# init-overlay uses: a new image -> new hash -> upper was reset by init-overlay
# -> we re-run the fresh path below.
FINGERPRINT="$(cat "$BAKE_MANIFEST" 2>/dev/null) arch=$(uname -m)"
PKG_HASH=$(printf '%s' "$FINGERPRINT" | sha256sum | cut -c1-16)
MARKER="$PKG/.installed-${PKG_HASH}"

OMO_VER="${OLARES_OMO_VERSION:-4.7.5}"
case "$OMO_VER" in
  ""|latest|next|beta|*[!0-9.]*)
    echo "=== WARNING: invalid OPENCODE_OMO_VERSION '$OMO_VER', falling back to 4.7.5 ==="
    OMO_VER="4.7.5"
    ;;
esac

verify_overlay() {
  # The base (/usr/bin/node, opencode, glibc, ...) is the read-only overlay
  # lower from the image, so it is always present once init-overlay mounted. We
  # only confirm the mounts are live and the baked pkg-install wrapper is
  # reachable; anything missing falls through to the fresh path (cheap: no copy).
  [ -e /usr/bin/node ] || { echo "=== overlay check: /usr not mounted ==="; return 1; }
  [ -x /usr/local/bin/pkg-install ] || { echo "=== overlay check: pkg-install missing ==="; return 1; }
  return 0
}

ensure_apk_mirror() {
  # Only used by restore_user_packages (apk add). The base install is baked, so
  # this never runs on a fresh instance (no user packages -> restore returns
  # early, zero network). When the user HAS installed packages, restoring them
  # needs apk/network, so we mirror the pkg-manager probe to stay usable behind
  # the GFW.
  wget -q -O /dev/null https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz 2>/dev/null &
  _wpid=$!
  ( sleep 5 && kill "$_wpid" 2>/dev/null ) &
  _gpid=$!
  if ! wait "$_wpid" 2>/dev/null; then
    echo "=== restore: Alpine CDN slow/unreachable, switching to China mirrors ==="
    sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories
  fi
  kill "$_gpid" 2>/dev/null || true
  wait "$_gpid" 2>/dev/null || true
}

restore_user_packages() {
  # /usr /lib /bin /sbin are overlay-bound here, so apk writes the package files
  # AND the apk database straight into the persistent upper layer -- no manual
  # file-list copy anymore. Runs only on the fresh path (image change / first
  # install); on restart the upper already has these packages and it is skipped.
  UPKGS="/home/opencode/.user-packages"
  [ ! -s "$UPKGS" ] && return 0
  ensure_apk_mirror
  RESTORE=$(cat "$UPKGS" | tr '\n' ' ')
  echo "=== Restoring user packages into overlay: $RESTORE ==="
  FAILED=""
  for p in $RESTORE; do
    if ! apk add --no-cache "$p" 2>&1; then
      echo "=== Warning: failed to restore $p ==="
      FAILED="$FAILED $p"
    fi
  done
  if [ -n "$FAILED" ]; then
    echo "=== Failed packages (will retry next restart):$FAILED ==="
  fi
  echo "=== Restore complete ==="
}

seed_etc() {
  # /etc is NOT overlay-bound in this container, so /etc here is the image's.
  # Copy the tiny base bits (KB) into the persistent state dir; opencode/
  # pkg-manager bind these. Re-seeded on image change. /etc/passwd|group get the
  # opencode (uid 1000) entry appended.
  ETC="$PKG/etc"
  mkdir -p "$ETC"
  # rm before cp -a: on image change these dirs already exist and a bare
  # `cp -a src dest` would nest as dest/apk/apk.
  rm -rf "$ETC/apk" "$ETC/ssl"
  cp -a /etc/apk "$ETC/apk" 2>/dev/null || true
  cp -a /etc/ssl "$ETC/ssl" 2>/dev/null || true
  cp /etc/passwd "$ETC/passwd"
  cp /etc/group  "$ETC/group"
  grep -q '^opencode:' "$ETC/group" \
    || echo 'opencode:x:1000:' >> "$ETC/group"
  grep -q '^opencode:' "$ETC/passwd" \
    || echo 'opencode:x:1000:1000:opencode:/home/opencode:/bin/bash' >> "$ETC/passwd"
}

seed_omo_cache() {
  # opencode's plugin loader reads the OMO plugin from
  #   ~/.cache/opencode/packages/<spec>/node_modules
  # which lives under /home/opencode (appData hostPath). The forked image bakes
  # that cache for the default version into a neutral staging dir; copy it in
  # once (offline). If the user pinned a non-baked version via
  # OPENCODE_OMO_VERSION, there is no staged cache and opencode fetches it at
  # runtime -- same fallback semantics as before.
  OMO_SPEC="oh-my-openagent@${OMO_VER}"
  SRC="/opt/olares-bake/opencode-cache/packages/$OMO_SPEC"
  DST="/home/opencode/.cache/opencode/packages/$OMO_SPEC"
  if [ -d "$DST/node_modules" ]; then
    echo "=== OMO: cache already present for $OMO_SPEC ==="
  elif [ -d "$SRC" ]; then
    echo "=== OMO: seeding baked cache for $OMO_SPEC ==="
    mkdir -p "$(dirname "$DST")"
    cp -a "$SRC" "$DST"
    chown -R 1000:1000 /home/opencode/.cache
  else
    echo "=== OMO: no baked cache for $OMO_SPEC (env override); opencode will fetch at runtime ==="
  fi
}

seed_skills() {
  # The forked image bakes the Olares Agent Skills into a neutral staging dir.
  # opencode reads global skills from
  #   ~/.config/opencode/skills/<name>/SKILL.md
  # which lives under /home/opencode (appData hostPath), so they cannot be baked
  # into the rootfs -- they must be seeded here. The chart-managed web-preview/
  # system-admin skills (written by init-setup) use different names and are left
  # untouched. Stamped with $PKG_HASH so a new image refreshes them; no network.
  SRC="/opt/olares-bake/opencode-skills"
  [ -d "$SRC" ] || { echo "=== skills: no baked skills in image, skipping ==="; return 0; }
  DST="/home/opencode/.config/opencode/skills"
  STAMP="$DST/.olares-baked-stamp"
  mkdir -p "$DST"
  if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$PKG_HASH" ]; then
    echo "=== skills: baked Olares skills already seeded (${PKG_HASH}) ==="
  else
    echo "=== skills: seeding baked Olares skills ==="
    for d in "$SRC"/*/; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      rm -rf "$DST/$name"
      cp -a "$d" "$DST/$name"
    done
    echo "$PKG_HASH" > "$STAMP"
    echo "=== skills: seeded $(ls "$SRC" | tr '\n' ' ')==="
  fi
  chown -R 1000:1000 "$DST" 2>/dev/null || true
}

echo "=== Setting up home directory (runs every start) ==="
mkdir -p /home/opencode/.npm-global/bin /home/opencode/.npm-global/lib
chown -R 1000:1000 /home/opencode/.npm-global

cat > /home/opencode/.profile << 'EOFPROFILE'
export VIRTUAL_ENV="/home/opencode/.venv"
export NPM_CONFIG_PREFIX="/home/opencode/.npm-global"
export GOPATH="/home/opencode/go"
export CARGO_HOME="/home/opencode/.cargo"
export PATH="/home/opencode/.venv/bin:/home/opencode/.npm-global/bin:/home/opencode/go/bin:/home/opencode/.cargo/bin:/home/opencode/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EOFPROFILE
cp /home/opencode/.profile /home/opencode/.bashrc
chown 1000:1000 /home/opencode/.profile /home/opencode/.bashrc

if [ -f "$MARKER" ] && verify_overlay; then
  echo "=== overlay ready, unchanged image (${PKG_HASH}); skipping restore ==="
  # User packages already live in the persisted overlay upper layer: no apk, no
  # network, no copy. Just refresh the appData-side seeds.
  seed_omo_cache
  seed_skills
  chown -R 1000:1000 /usr/local 2>/dev/null || true
  exit 0
fi
# Fresh / image-changed: init-overlay has already reset the upper and mounted an
# empty overlay over the image base. Nothing to copy -- the base IS the
# read-only lower. We only restore user packages (apk -> upper) and seed
# appData. Drop stale markers.
rm -f "$PKG"/.installed-* 2>/dev/null || true

echo "=== Creating persistent Python venv ==="
VENV="/home/opencode/.venv"
if [ ! -f "$VENV/bin/activate" ]; then
  python3 -m venv "$VENV"
  chown -R 1000:1000 "$VENV"
fi

echo "=== Seeding /etc (passwd/group/apk/ssl) into persistent state ==="
# /etc is the image's here (not overlay-bound); seed the persistent copies that
# opencode/pkg-manager bind, and register uid 1000.
seed_etc

# bash is baked into the image (at /bin/bash) and rides the overlay lower. Only
# self-heal if it is genuinely not runnable; resolve via PATH (NOT a hardcoded
# /usr/bin/bash -- bash lives at /bin/bash).
if ! bash -c 'true' 2>/dev/null; then
  echo "=== bash not runnable, reinstalling ==="
  apk del bash 2>/dev/null || true
  apk add --no-cache bash 2>&1 || echo "=== WARNING: bash reinstall failed in init, pkg-manager will fix ==="
fi

# vite, opencode, glibc, olares-cli and pkg-install are baked into the image and
# appear via the overlay lower -- nothing to install or write here.
chown -R 1000:1000 /usr/local 2>/dev/null || true

# Restore user packages straight into the overlay upper (apk add). On a fresh
# instance .user-packages is empty -> this is a no-op and touches the network
# zero times.
restore_user_packages

# Seed the baked OMO plugin cache into ~/.cache (appData hostPath) so opencode
# loads the pinned version offline.
seed_omo_cache

# Seed the baked Olares Agent Skills into ~/.config/opencode/skills (appData
# hostPath; not part of the overlay). Coexists with the chart-managed
# web-preview/system-admin skills.
seed_skills

# Seal: marker lives in the state dir (not the upper), so it survives an upper
# reset and lets init-overlay/this container agree on state.
touch "$MARKER"
echo "=== overlay setup complete (${PKG_HASH}) ==="
