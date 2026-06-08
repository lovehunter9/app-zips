#!/bin/sh
# Long-running sidecar: a queue-based apk install/remove/search worker. The
# pkg-install wrapper (run by the user/agent in the opencode container) drops
# requests into $QUEUE; this loop services them with root + network.
QUEUE="/home/opencode/.pkg-queue"
UPKGS="/home/opencode/.user-packages"
mkdir -p "$QUEUE"
rm -f "$QUEUE/request" "$QUEUE/result" "$QUEUE/log" "$QUEUE/search-result"
rm -rf "$QUEUE/.lock"
touch "$UPKGS"

rm -f /lib/apk/db/lock 2>/dev/null || true

# Lazy, run-once mirror selection: only touches the network the first time the
# user actually triggers a package op. A plain restart with no package activity
# now stays fully offline.
_MIRROR_DONE=0
ensure_mirror() {
  [ "$_MIRROR_DONE" = "1" ] && return 0
  _MIRROR_DONE=1
  wget -q -O /dev/null https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz 2>/dev/null &
  _wpid=$!
  ( sleep 5 && kill "$_wpid" 2>/dev/null ) &
  _gpid=$!
  if ! wait "$_wpid" 2>/dev/null; then
    echo "=== pkg-manager: switching to China mirrors ==="
    sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories
  fi
  kill "$_gpid" 2>/dev/null || true
  wait "$_gpid" 2>/dev/null || true
}

echo "=== APK DB check ==="
echo "installed: $(wc -l < /lib/apk/db/installed 2>/dev/null || echo 'NOT FOUND')"
echo "arch: $(cat /etc/apk/arch 2>/dev/null || echo 'NOT FOUND')"
echo "repos: $(cat /etc/apk/repositories 2>/dev/null || echo 'NOT FOUND')"
ls -la /lib/apk/db/ 2>&1 || echo "/lib/apk/db/ missing"
echo "apk info count: $(apk info 2>/dev/null | wc -l)"
echo "=== end DB check ==="

# bash + glibc are baked into the image (bash at /bin/bash) and ride the overlay
# lower, so no eager `apk update` / forced bash reinstall on every start (that
# used to hit the network unconditionally and would delete bash while offline).
# Only self-heal if bash is actually broken; resolve via PATH (NOT a hardcoded
# /usr/bin/bash).
if ! bash -c 'true' 2>/dev/null; then
  echo "=== bash not runnable, repairing ==="
  ensure_mirror
  apk update 2>&1 || true
  apk del bash 2>/dev/null || true
  apk add --no-cache bash 2>&1 || echo "=== WARNING: bash repair failed ==="
fi

_add_pkgs() {
  for p in $@; do
    p_base=$(echo "$p" | sed 's/=.*//')
    grep -qx "$p_base" "$UPKGS" || echo "$p_base" >> "$UPKGS"
  done
}
_del_pkgs() {
  for p in $@; do
    sed -i "/^${p}$/d" "$UPKGS"
  done
}

trap 'echo "=== Package manager shutting down ==="; exit 143' TERM INT
echo "=== Package manager ready ==="
while true; do
  if [ -f "$QUEUE/request" ]; then
    REQ=$(cat "$QUEUE/request")
    rm -f "$QUEUE/request"

    TMP="$QUEUE/.result.tmp"
    case "$REQ" in
      SEARCH\ *)
        KEYWORD="${REQ#SEARCH }"
        ensure_mirror
        apk update >/dev/null 2>&1
        apk search "$KEYWORD" > "$TMP" 2>&1
        mv "$TMP" "$QUEUE/search-result"
        ;;
      LIST)
        apk info > "$TMP" 2>&1
        mv "$TMP" "$QUEUE/search-result"
        ;;
      INFO\ *)
        TARGET="${REQ#INFO }"
        ensure_mirror
        apk update >/dev/null 2>&1
        { apk policy "$TARGET" 2>/dev/null
          echo ""
          apk info -d -s "$TARGET" 2>/dev/null; } > "$TMP" 2>&1
        mv "$TMP" "$QUEUE/search-result"
        ;;
      REMOVE\ *)
        PKGS="${REQ#REMOVE }"
        echo "=== Removing: $PKGS ==="
        apk del $PKGS > "$QUEUE/log" 2>&1
        RC=$?
        [ $RC -eq 0 ] && _del_pkgs $PKGS
        echo $RC > "$QUEUE/result"
        ;;
      INSTALL\ *)
        PKGS="${REQ#INSTALL }"
        echo "=== Installing: $PKGS ==="
        ensure_mirror
        apk add --no-cache $PKGS > "$QUEUE/log" 2>&1
        RC=$?
        [ $RC -eq 0 ] && _add_pkgs $PKGS
        echo $RC > "$QUEUE/result"
        ;;
      *)
        echo "=== Installing (legacy): $REQ ==="
        ensure_mirror
        apk add --no-cache $REQ > "$QUEUE/log" 2>&1
        RC=$?
        [ $RC -eq 0 ] && _add_pkgs $REQ
        echo $RC > "$QUEUE/result"
        ;;
    esac
  fi
  sleep 1
done
