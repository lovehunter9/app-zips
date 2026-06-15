# 备份：Terminal 自启 Bifrost CLI + 终端尺寸竞态处理（2026-06-15 移除）

> 决策：Terminal 回退为**默认进 Bash**，不再自动拉起 Bifrost CLI。
> 因此那套"等真实分辨率再启动 TUI"的逻辑（stty size 轮询）连同自启一并移除。
> 本文件保留被删内容与**恢复步骤**，便于以后需要时还原。
> 用户仍可在 Bash 里手动 `bifrost` 启动 CLI（`~/.bifrost/config.json` 的 base_url 仍由 init 播种）。

---

## 1. configmap.yaml —— 被删的 `cli-profile` 数据块（含尺寸竞态轮询）

挂在 `bifrost-config` ConfigMap 的 `data:` 下（与 `config.json` 同级）：

```yaml
  # Auto-launch the Bifrost CLI when the in-app Terminal opens. The terminal runs an
  # interactive NON-login bash (verified: $0=bash, no $ENV support), so this file is
  # mounted as the cli container's ~/.bashrc (/app/data/.cli-home/.bashrc). bash
  # sources it on entry -> runs `bifrost`; when the user quits the CLI they fall back
  # to this same bash. Guarded so nested shells don't relaunch. (Also mounted at
  # $ENV=/etc/bifrost/cli-profile as a POSIX-sh fallback; harmless if unused.)
  cli-profile: |
    case "$-" in
      *i*) ;;
      *) return 2>/dev/null ;;
    esac
    if [ -z "${BIFROST_CLI_STARTED:-}" ]; then
      export BIFROST_CLI_STARTED=1
      export PATH="/usr/local/bin:$PATH"
      # Wait until the terminal size has truly SETTLED before drawing the TUI. Two
      # failure modes we must avoid at once, and they pull in opposite directions:
      #   * "stale bottom line": bifrost starts, THEN a resize arrives -> Bubble Tea
      #     repaints and leaves garbage on the last row (a bifrost redraw bug we cannot
      #     fix). Avoidable only by starting AFTER all resizes are done.
      #   * "stuck small": bifrost starts at 80x24 and no later resize ever comes -> it
      #     stays cramped forever.
      # The only state that satisfies both is "size is final and no more resizes are
      # coming". We can't be told that, so we infer it: require the size to be WIDE
      # (cols > 80, i.e. grown past the 80x24 default) AND held UNCHANGED for ~1s. When a
      # new tab is created, tmux + the web terminal do a couple of resize cycles in the
      # first few hundred ms; a short stability window (the previous 0.3s) launched in
      # the middle of them. ~1s of no-change waits those cycles out. Slower by design
      # (~1s/tab) but stable; the already-good first tab is only ~0.7s slower, not broken.
      # Hard cap so a genuinely narrow (<=80 col) terminal never hangs.
      _i=0; _stable=0; _prev=""; _need=10; _max=100
      while [ "$_i" -lt "$_max" ]; do
        _sz=$(stty size 2>/dev/null)
        # shellcheck disable=SC2086
        set -- $_sz
        _rows="${1:-0}"; _cols="${2:-0}"
        case "$_rows$_cols" in
          ''|*[!0-9]*) _ok=0 ;;
          *) if [ "$_rows" -ge 1 ] && [ "$_cols" -gt 80 ]; then _ok=1; else _ok=0; fi ;;
        esac
        if [ "$_ok" = 1 ] && [ "$_sz" = "$_prev" ]; then
          _stable=$((_stable + 1))
        else
          _stable=0
        fi
        _prev="$_sz"
        [ "$_stable" -ge "$_need" ] && break
        _i=$((_i + 1)); sleep 0.1
      done
      unset _i _stable _prev _sz _need _max _rows _cols _ok
      clear
      bifrost
    fi
```

## 2. bifrost.yaml —— cli 容器被删的 env 与 volumeMounts

`env:` 下被删的一项：

```yaml
            # POSIX sh sources $ENV on interactive entry -> auto-launches the Bifrost
            # CLI when the in-app Terminal opens (see bifrost-config: cli-profile).
            - name: ENV
              value: /etc/bifrost/cli-profile
```

`volumeMounts:` 下被删的两项（均来自 `bifrost-config` ConfigMap 的 `cli-profile` key）：

```yaml
            # Primary: the Terminal opens an interactive non-login bash, which sources
            # ~/.bashrc (HOME=/app/data/.cli-home) -> auto-launches the Bifrost CLI.
            - name: bifrost-config
              mountPath: /app/data/.cli-home/.bashrc
              subPath: cli-profile
              readOnly: true
            # Fallback for POSIX sh ($ENV); harmless when the shell is bash.
            - name: bifrost-config
              mountPath: /etc/bifrost/cli-profile
              subPath: cli-profile
              readOnly: true
```

保留（未删）：`HOME=/app/data/.cli-home`、`BIFROST_BASE_URL`、`bifrost-data` 挂载、
init 容器里 `~/.bifrost/config.json` 的 base_url 首次播种。

## 3. terminal.yaml —— 被改回的 `--shell`

```yaml
            # --shell is only the tab label here; the CLI auto-launch is driven by the
            # cli container's $ENV -> bifrost-config:cli-profile (see configmap.yaml).
            - --shell=bifrost-cli
```
改为：`- --shell=bash`

---

## 恢复步骤（如需重新启用自启 + 尺寸处理）
1. 把上面 §1 的 `cli-profile:` 块加回 `configmap.yaml` 的 `bifrost-config` ConfigMap `data:` 下。
2. 把 §2 的 `ENV` env 与两个 `volumeMounts` 加回 `bifrost.yaml` 的 `cli` 容器。
3. 把 `terminal.yaml` 的 `--shell=bash` 改回 `--shell=bifrost-cli`（仅 tab 名）。
4. `helm package bifrost` 重打 1.0.8。
