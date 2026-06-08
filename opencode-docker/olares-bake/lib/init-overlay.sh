#!/bin/sh
# Privileged init: mount an OverlayFS so the baked image rootfs (/usr /bin /sbin
# /lib /lib64) is the read-only lower layer (ZERO copy) and only user-installed
# package deltas live in a small persistent upper layer on the appData hostPath.
# Replaces the old multi-hundred-MB `cp -a` snapshot entirely.
set -e
OV=/pkg-overlay
DIRS="usr bin sbin lib lib64"
BAKE_MANIFEST="/opt/olares-bake/BAKE_MANIFEST"
# Fingerprint = baked image identity (opencode/OMO/cli/skills) + arch.
# Must match the hash init-packages uses to write the marker.
FINGERPRINT="$(cat "$BAKE_MANIFEST" 2>/dev/null) arch=$(uname -m)"
HASH=$(printf '%s' "$FINGERPRINT" | sha256sum | cut -c1-16)
MARKER="$OV/.installed-${HASH}"

# A previous pod's overlay mounts can survive (Bidirectional mounts propagate to
# the host). Their lower points at a now-deleted rootfs, so always unmount and
# remount against THIS image's dirs.
for d in $DIRS; do
  if mountpoint -q "$OV/merged/$d" 2>/dev/null; then
    umount "$OV/merged/$d" 2>/dev/null \
      || umount -l "$OV/merged/$d" 2>/dev/null || true
  fi
done

# New/changed image -> drop the upper deltas so the apk database in the upper
# layer cannot drift from the new base (matches the old "wipe + re-restore"
# behavior, minus the giant copy).
if [ ! -f "$MARKER" ]; then
  echo "=== overlay: new/changed image ($HASH); resetting upper ==="
  rm -rf "$OV/upper" "$OV/work"
else
  echo "=== overlay: same image ($HASH); keeping upper ==="
fi

for d in $DIRS; do
  mkdir -p "$OV/merged/$d"
  [ -d "/$d" ] || { echo "=== overlay: /$d absent on this arch, skipping ==="; continue; }
  mkdir -p "$OV/upper/$d" "$OV/work/$d"
  mount -t overlay overlay \
    -o "lowerdir=/$d,upperdir=$OV/upper/$d,workdir=$OV/work/$d" \
    "$OV/merged/$d"
done
echo "=== overlay: mounted [$DIRS] (lower=image rootfs, upper persists) ==="
