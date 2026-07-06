#!/bin/sh
# init-packages: runs as root during init. Everything the runtime needs (node,
# opencode, glibc, bash, vite, olares-cli, pkg-install, the OMO plugin cache, the
# Olares Agent Skills) is BAKED into the image, so this script does ONLY local,
# offline work and NEVER touches the network -- on new install, restart AND
# upgrade alike. It:
#   - sets up the $HOME env files + ownership
#   - creates the persistent Python venv
#   - seeds the tiny /etc bits the pkg-manager sidecar binds
#   - seeds the baked OMO cache + Olares skills into appData (idempotent copies)
#
# User-installed apk packages live in the persistent OverlayFS upper (mounted by
# init-overlay) and are NEVER reinstalled here -- they simply persist. The only
# thing that may use the network is the user installing a NEW package later, via
# the pkg-manager sidecar (use-time, out of scope of the offline init contract).
# Reads env:
#   OLARES_OMO_VERSION  - OMO plugin version (from chart olaresEnv)
set -u
PKG="/home/opencode/.pkg-overlay"

# App fingerprint (opencode/OMO/cli/skills, from the baked manifest). Used ONLY
# to stamp the appData-side skills seed so it refreshes on a version bump. It
# gates no network and triggers no reinstall.
APP_HASH=$(sha256sum /opt/olares-bake/BAKE_MANIFEST 2>/dev/null | cut -c1-16)

OMO_VER="${OLARES_OMO_VERSION:-4.8.1}"
case "$OMO_VER" in
  ""|latest|next|beta|*[!0-9.]*)
    echo "=== WARNING: invalid OPENCODE_OMO_VERSION '$OMO_VER', falling back to 4.8.1 ==="
    OMO_VER="4.8.1"
    ;;
esac

migrate_from_pkgroot() {
  # ONE-TIME, FULLY OFFLINE migration for users upgrading from the legacy
  # `.pkg-root` design (the released 1.0.x chart bind-mounted a full
  # appData/.pkg-root snapshot over /usr /lib ... and restored user packages
  # with `apk add`). The new design uses the OverlayFS upper instead, so those
  # users' installed packages (e.g. ffmpeg) would otherwise vanish on upgrade.
  #
  # We import them WITHOUT touching the network: read the OLD snapshot's apk DB
  # locally, diff against THIS image's base package set, copy the files of the
  # extra (= user-installed) packages straight into the overlay upper dir, AND
  # register them in apk's installed DB so behavior is identical (pkg-install
  # --list shows them, --remove works). init-overlay (runs after this) then
  # mounts the upper. Runs once (marker), and never aborts init on error.
  OLDROOT="/home/opencode/.pkg-root"
  UPPER="$PKG/upper"
  MIG_MARKER="$PKG/.migrated-pkgroot"
  [ -f "$MIG_MARKER" ] && return 0
  [ -f "$OLDROOT/lib/apk/db/installed" ] || return 0
  echo "=== migrate: legacy .pkg-root detected; importing user packages into overlay upper (offline, no network) ==="
  apk info 2>/dev/null | sort -u > /tmp/base.list
  apk --root "$OLDROOT" info 2>/dev/null | sort -u > /tmp/old.list
  if [ ! -s /tmp/base.list ] || [ ! -s /tmp/old.list ]; then
    echo "=== migrate: could not read apk package lists; skipping (no change) ==="
    rm -f /tmp/base.list /tmp/old.list
    return 0
  fi
  # packages in the old snapshot that are NOT part of this image's base set
  # (= user-installed packages plus their unique dependencies)
  grep -vxF -f /tmp/base.list /tmp/old.list > /tmp/mig.list 2>/dev/null || true
  n=0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    apk --root "$OLDROOT" info -L "$p" 2>/dev/null | while IFS= read -r f; do
      # skip the "<pkg> contains:" header and anything outside the overlay dirs
      case "$f" in
        usr/*|lib/*|lib64/*|bin/*|sbin/*) ;;
        *) continue ;;
      esac
      [ -e "$OLDROOT/$f" ] || continue
      mkdir -p "$UPPER/$(dirname "$f")"
      cp -a "$OLDROOT/$f" "$UPPER/$f" 2>/dev/null || true
    done
    n=$((n + 1))
  done < /tmp/mig.list
  # Register the imported packages in apk's installed DB so they behave exactly
  # like before. Seed the upper DB from THIS image's base DB (correct versions
  # for the new lower), then append the imported packages' records extracted
  # verbatim from the legacy snapshot DB. Written to a temp first so a bad parse
  # can never leave a corrupt DB.
  if [ -s /tmp/mig.list ]; then
    cp -a /lib/apk/db/installed /tmp/merged.db 2>/dev/null || true
    awk '
      FNR==NR { want[$0]=1; next }
      { rec = rec $0 "\n" }
      /^P:/  { pname = substr($0, 3) }
      /^$/   { if (pname != "" && (pname in want)) printf "%s", rec; rec=""; pname="" }
      END    { if (pname != "" && (pname in want)) printf "%s", rec }
    ' /tmp/mig.list "$OLDROOT/lib/apk/db/installed" >> /tmp/merged.db 2>/dev/null || true
    if [ -s /tmp/merged.db ]; then
      mkdir -p "$UPPER/lib/apk/db"
      cp /tmp/merged.db "$UPPER/lib/apk/db/installed"
    fi
    rm -f /tmp/merged.db
  fi
  # Persist the imported package names so seed_etc unions them into apk world.
  # The migrated packages are in the installed DB (overlay upper) but NOT in the
  # image's base world; without this, the next apk add/del would treat them as
  # orphans and purge them (same class of bug as the /etc/apk/world reset).
  mkdir -p "$PKG"
  if [ -s /tmp/mig.list ]; then
    cat /tmp/mig.list >> "$PKG/.world-extra" 2>/dev/null || true
    if sort -u "$PKG/.world-extra" > "$PKG/.world-extra.tmp" 2>/dev/null; then
      mv "$PKG/.world-extra.tmp" "$PKG/.world-extra"
    else
      rm -f "$PKG/.world-extra.tmp"
    fi
  fi
  rm -f /tmp/base.list /tmp/old.list /tmp/mig.list
  touch "$MIG_MARKER"
  echo "=== migrate: imported $n package(s) (files + apk DB) from .pkg-root into overlay upper (offline) ==="
}

seed_etc() {
  # /etc is the image's here (not overlay-bound). The pkg-manager sidecar binds
  # these persistent bits for its (use-time) apk operations. /etc/passwd|group
  # get the opencode (uid 1000) entry appended.
  #
  # CRITICAL — apk world must NEVER be reset. The apk *installed DB*
  # (/lib/apk/db/installed) lives on the OverlayFS upper and persists forever;
  # the apk *world* (/etc/apk/world, the set of explicitly-wanted packages)
  # lives here in /etc/apk. If we clobbered world with the image's base set on
  # every start, it would drift from the persistent installed DB, and the NEXT
  # `apk add`/`apk del` would treat every user-installed package (ffmpeg, jq, ..)
  # as an orphan and PURGE it. So: seed the whole apk config only on first boot;
  # afterwards refresh only the image-controlled metadata (keys/repositories/arch)
  # and set world := union(image base world, existing world) -- base packages are
  # always kept, user packages are never dropped.
  ETC="$PKG/etc"
  mkdir -p "$ETC"
  if [ ! -d "$ETC/apk" ]; then
    # First boot: seed the full apk config (keys/repositories/arch/world/...).
    cp -a /etc/apk "$ETC/apk" 2>/dev/null || true
  else
    # Later boots: refresh only image-controlled metadata; world handled below.
    cp -a /etc/apk/repositories "$ETC/apk/repositories" 2>/dev/null || true
    cp -a /etc/apk/arch "$ETC/apk/arch" 2>/dev/null || true
    rm -rf "$ETC/apk/keys"
    cp -a /etc/apk/keys "$ETC/apk/keys" 2>/dev/null || true
  fi
  # world := union(image base world, existing world, migrated .pkg-root extras).
  # NEVER drop entries: the apk installed DB persists on the OverlayFS upper, so
  # world must stay in sync with it, else the next apk add/del purges user pkgs.
  { cat /etc/apk/world 2>/dev/null
    cat "$ETC/apk/world" 2>/dev/null
    cat "$PKG/.world-extra" 2>/dev/null
  } | sort -u > "$ETC/apk/world.tmp" 2>/dev/null \
    && mv "$ETC/apk/world.tmp" "$ETC/apk/world" \
    || rm -f "$ETC/apk/world.tmp"
  rm -rf "$ETC/ssl"
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
  # runtime (use-time) -- same fallback semantics as before.
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
  # untouched. Stamped with $APP_HASH so a new image refreshes them; no network.
  SRC="/opt/olares-bake/opencode-skills"
  [ -d "$SRC" ] || { echo "=== skills: no baked skills in image, skipping ==="; return 0; }
  DST="/home/opencode/.config/opencode/skills"
  STAMP="$DST/.olares-baked-stamp"
  mkdir -p "$DST"
  if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$APP_HASH" ]; then
    echo "=== skills: baked Olares skills already seeded (${APP_HASH}) ==="
  else
    echo "=== skills: seeding baked Olares skills ==="
    for d in "$SRC"/*/; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      rm -rf "$DST/$name"
      cp -a "$d" "$DST/$name"
    done
    echo "$APP_HASH" > "$STAMP"
    echo "=== skills: seeded $(ls "$SRC" | tr '\n' ' ')==="
  fi
  chown -R 1000:1000 "$DST" 2>/dev/null || true
}

# One-time offline import of user packages from a legacy .pkg-root snapshot
# (must run before init-overlay mounts the upper; writes the upper dir directly).
migrate_from_pkgroot

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

echo "=== Creating persistent Python venv ==="
VENV="/home/opencode/.venv"
if [ ! -f "$VENV/bin/activate" ]; then
  python3 -m venv "$VENV"
  chown -R 1000:1000 "$VENV"
fi

echo "=== Seeding /etc (passwd/group/apk/ssl) into persistent state ==="
seed_etc

# Seed the baked OMO plugin cache into ~/.cache (appData hostPath) so opencode
# loads the pinned version offline.
seed_omo_cache

# Seed the baked Olares Agent Skills into ~/.config/opencode/skills (appData
# hostPath; not part of the overlay). Coexists with the chart-managed
# web-preview/system-admin skills.
seed_skills

echo "=== init-packages complete (offline; app=${APP_HASH}) ==="
