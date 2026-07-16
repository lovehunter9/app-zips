#!/usr/bin/env python3
"""Analyze long-audio test results.

Emits report.md (markdown source) -- the shell script duplicates it as
report.txt so the user can paste verbatim into any chat client without
markdown rendering interference.

For each language we compare Buffered vs Batched: _meta.path (real path
evidence), elapsed time (Batched should be FASTER on long audio), text
length / segments count, head/tail samples (VAD boundary verification),
and full traceback if either Batched call fell back.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

OUT = Path(sys.argv[1])


def load_json(name: str) -> dict | None:
    p = OUT / name
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"_parse_error": str(exc), "_raw": p.read_text(encoding="utf-8")[:300]}


def load_summary() -> dict[str, dict]:
    rows: dict[str, dict] = {}
    tsv = OUT / "summary.tsv"
    if not tsv.exists():
        return rows
    header = None
    for line in tsv.read_text(encoding="utf-8").splitlines():
        cols = line.split("\t")
        if header is None:
            header = cols
            continue
        rows[cols[0]] = dict(zip(header, cols))
    return rows


def similarity(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    ca, cb = Counter(a), Counter(b)
    common = sum((ca & cb).values())
    return common / max(len(a), len(b))


def fmt_ms(ms_str: str) -> str:
    try:
        ms = int(ms_str)
    except Exception:
        return ms_str
    if ms < 60000:
        return f"{ms / 1000:.1f}s"
    m, s = divmod(ms // 1000, 60)
    return f"{m}m{s:02d}s"


def main() -> None:
    summary = load_summary()
    print("# 长音频实测报告\n")
    print(f"**输出目录**: `{OUT.name}`\n")
    print("**端点**: `POST /v1/audio/transcriptions`")
    print("**用例**: 2 语种 × 2 模式 = 最多 4 次调用（每语种缺文件就跳过对应两个用例）")
    print("**关闭后处理**: `text_cleaning=false` + `segment_merging=false`（只看引擎层差异）")
    print("**诊断**: 全部以 `_diag=true` 调用，响应里直接带 `_meta.path` 真相\n")

    # ── 0. _meta.path 观测（最关键）─────────────────────────
    print("## 0. 每次调用的 `_meta.path` 观测（真相，非推断）\n")
    print("> 在本开发版的 `clip_timestamps` 修复之后，Batched 路径首次"
          "应该真的能跑起来。如果这里还看到 `batched_fallback_to_buffered`，")
    print("> `_meta.batched_traceback` 会告诉我们究竟挂在 faster-whisper 的哪一行。\n")
    print("| 用例 | HTTP | 耗时 | _meta.path | batched_typeerror | batched_dropped_kwargs |")
    print("|---|---|---:|---|---|---|")

    cases = [
        ("L1_zh_buffered", "中文 Buffered"),
        ("L2_zh_batched",  "中文 Batched"),
        ("L3_en_buffered", "英文 Buffered"),
        ("L4_en_batched",  "英文 Batched"),
    ]
    bodies: dict[str, dict | None] = {}
    for cid, _label in cases:
        bodies[cid] = load_json(f"{cid}.json")

    for cid, label in cases:
        body = bodies[cid]
        row = summary.get(cid, {})
        http = row.get("http", "—")
        elapsed = fmt_ms(row.get("elapsed_ms", "0"))
        if body is None:
            print(f"| {label} | — | — | (用例未运行) | — | — |")
            continue
        meta = (body or {}).get("_meta") or {}
        path = meta.get("path", "?")
        terr = meta.get("batched_typeerror") or "—"
        if terr != "—":
            terr = terr[:80] + ("…" if len(terr) > 80 else "")
        bdrop = meta.get("batched_dropped_kwargs") or []
        bdrop_s = ",".join(bdrop) if bdrop else "—"
        print(f"| {label} | {http} | {elapsed} | `{path}` | {terr} | `{bdrop_s}` |")

    # Traceback dump for any failed Batched calls
    for cid, label in [("L2_zh_batched", "中文 Batched"), ("L4_en_batched", "英文 Batched")]:
        body = bodies.get(cid)
        if not body:
            continue
        meta = (body or {}).get("_meta") or {}
        if meta.get("path") == "batched_fallback_to_buffered" and meta.get("batched_traceback"):
            print(f"\n### `{cid}` ({label}) 完整 traceback\n")
            print("```")
            print(meta["batched_traceback"].rstrip())
            print("```\n")

    # ── 1. Buffered vs Batched 速度对照 ─────────────────────
    print("\n## 1. 速度对照（Buffered vs Batched 在长音频上）\n")
    print("> 长音频是 Batched 该发光的场景。如果这里 Batched 显著快于 Buffered，"
          "说明 BatchedInferencePipeline 真在跑且收益落地了。\n")
    print("| 语种 | Buffered 耗时 | Batched 耗时 | 速度比 (Buf / Bat) | Batched 真路径 |")
    print("|---|---:|---:|---:|---|")

    def speed_row(lang_label: str, buf_id: str, bat_id: str):
        buf_row = summary.get(buf_id, {})
        bat_row = summary.get(bat_id, {})
        try:
            buf_ms = int(buf_row.get("elapsed_ms", "0"))
            bat_ms = int(bat_row.get("elapsed_ms", "0"))
        except Exception:
            buf_ms, bat_ms = 0, 0
        if buf_ms == 0 or bat_ms == 0:
            print(f"| {lang_label} | {fmt_ms(str(buf_ms))} | {fmt_ms(str(bat_ms))} | —  | (有用例未运行) |")
            return
        ratio = buf_ms / bat_ms
        flag = "🚀" if ratio >= 1.3 else ("✓" if ratio >= 1.05 else "⚠️")
        bat_body = bodies.get(bat_id) or {}
        bat_path = (bat_body.get("_meta") or {}).get("path", "?")
        print(f"| {lang_label} | {fmt_ms(str(buf_ms))} | {fmt_ms(str(bat_ms))} | {ratio:.2f}x {flag} | `{bat_path}` |")

    speed_row("中文 (zh)", "L1_zh_buffered", "L2_zh_batched")
    speed_row("英文 (en)", "L3_en_buffered", "L4_en_batched")

    # ── 2. 文本量与段数 ─────────────────────────────────────
    print("\n## 2. 段数与字符数\n")
    print("| 用例 | _meta.path | 段数 | 字符数 | duration(s) |")
    print("|---|---|---:|---:|---:|")
    for cid, label in cases:
        body = bodies.get(cid)
        if not body:
            continue
        meta = body.get("_meta") or {}
        segs = body.get("segments") or []
        text = body.get("text") or ""
        dur = body.get("duration")
        path = meta.get("path", "?")
        print(f"| {label} | `{path}` | {len(segs)} | {len(text)} | {dur} |")

    # ── 3. 文本相似度（Buf vs Bat 同语种）────────────────────
    print("\n## 3. Buffered vs Batched 文本相似度\n")
    print("> 长音频上，由于 VAD 切片边界不同（Batched 用 BatchedInferencePipeline 内置 VAD，")
    print("> Buffered 用我们指定的 vad_parameters），输出**通常会有差异**——")
    print("> 不是 bug，是 chunking 不同导致的合理变化。\n")
    print("| 语种 | Buf 字符数 | Bat 字符数 | 字符多重集 Jaccard 相似度 |")
    print("|---|---:|---:|---:|")
    for lang_label, buf_id, bat_id in [
        ("中文 (zh)", "L1_zh_buffered", "L2_zh_batched"),
        ("英文 (en)", "L3_en_buffered", "L4_en_batched"),
    ]:
        buf_body = bodies.get(buf_id) or {}
        bat_body = bodies.get(bat_id) or {}
        buf_text = buf_body.get("text") or ""
        bat_text = bat_body.get("text") or ""
        if not buf_text or not bat_text:
            print(f"| {lang_label} | {len(buf_text)} | {len(bat_text)} | (有用例未运行) |")
            continue
        sim = similarity(buf_text, bat_text)
        print(f"| {lang_label} | {len(buf_text)} | {len(bat_text)} | {sim:.3f} |")

    # ── 4. 首尾片段对照（VAD 漏识 / 幻觉检测）────────────────
    print("\n## 4. 首尾段对照（VAD 漏识 + 幻觉检测）\n")
    print("> 关键质量观察：首尾段是否截断（VAD 误切静音/弱音）、")
    print("> 末尾是否出现幻觉式重复或与音频无关的句子。\n")
    for cid, label in cases:
        body = bodies.get(cid)
        if not body:
            continue
        segs = body.get("segments") or []
        if not segs:
            print(f"### {label}: (无 segments)\n")
            continue
        first = segs[0].get("text", "").strip()[:120]
        last = segs[-1].get("text", "").strip()[:120]
        print(f"### {label}（{len(segs)} 段）\n")
        print(f"- 首段: {first}")
        print(f"- 末段: {last}\n")

    # ── 5. 强制覆盖证据（_BATCHED_DROPPED_KWARGS）────────────
    print("## 5. Batched 路径强制覆盖证据\n")
    print("> 当 `_meta.path == batched` 时，`batched_dropped_kwargs` 应当包含")
    print("> `_BATCHED_DROPPED_KWARGS` 的完整 5 项（condition_on_previous_text, "
          "hallucination_silence_threshold, prompt_reset_on_temperature, "
          "vad_filter, vad_parameters）。\n")
    EXPECTED = {
        "condition_on_previous_text", "prompt_reset_on_temperature",
        "hallucination_silence_threshold", "vad_filter", "vad_parameters",
    }
    print("| 用例 | _meta.path | dropped 是否完整 | 实际 dropped |")
    print("|---|---|---|---|")
    for cid, label in [("L2_zh_batched", "中文 Batched"), ("L4_en_batched", "英文 Batched")]:
        body = bodies.get(cid)
        if not body:
            continue
        meta = body.get("_meta") or {}
        path = meta.get("path", "?")
        dropped = set(meta.get("batched_dropped_kwargs") or [])
        if path != "batched":
            flag = "—（未真走 Batched，所以 dropped 不适用）"
        elif dropped == EXPECTED:
            flag = "✓ 完整"
        else:
            missing = EXPECTED - dropped
            extra = dropped - EXPECTED
            flag = f"⚠️ 缺：{sorted(missing) or '—'}，多：{sorted(extra) or '—'}"
        print(f"| {label} | `{path}` | {flag} | `{','.join(sorted(dropped)) or '—'}` |")

    print("\n---\n")
    print(f"_报告生成自 `{OUT}/summary.tsv` + `*.json` 原始响应；脚本：`scripts/lib/analyze_long_audio.py`_")


if __name__ == "__main__":
    main()
