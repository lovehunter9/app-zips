#!/bin/sh
# Privileged init: mount an OverlayFS so the baked image rootfs (/usr /bin /sbin
# /lib /lib64) is the read-only lower layer (ZERO copy) and only user-installed
# package deltas live in a small persistent upper layer on the appData hostPath.
#
# The upper is NEVER reset here. It persists across new install / restart /
# upgrade. A version bump (opencode/OMO/cli) or even a base-package change rides
# in through the NEW image's lower layer, while the user's installed packages
# stay untouched in the upper -- so init does ZERO network and ZERO reinstall in
# every case. (The Dockerfile pins the Alpine MINOR so the base libs the upper
# links against stay ABI-stable while the upper is kept.)
set -e
OV=/pkg-overlay
DIRS="usr bin sbin lib lib64"

# A previous pod's overlay mounts can survive (Bidirectional mounts propagate to
# the host). Their lower points at a now-deleted rootfs, so always unmount and
# remount against THIS image's dirs.
for d in $DIRS; do
  if mountpoint -q "$OV/merged/$d" 2>/dev/null; then
    umount "$OV/merged/$d" 2>/dev/null \
      || umount -l "$OV/merged/$d" 2>/dev/null || true
  fi
done

for d in $DIRS; do
  mkdir -p "$OV/merged/$d"
  [ -d "/$d" ] || { echo "=== overlay: /$d absent on this arch, skipping ==="; continue; }
  mkdir -p "$OV/upper/$d" "$OV/work/$d"
  mount -t overlay overlay \
    -o "lowerdir=/$d,upperdir=$OV/upper/$d,workdir=$OV/work/$d" \
    "$OV/merged/$d"
done
echo "=== overlay: mounted [$DIRS] (lower=image rootfs; upper persists, never reset) ==="
