#!/usr/bin/env python3
"""Analyze controlled-verification results.

Emits both report.md (markdown) and report.txt (plain text mirror) under
the given output directory.  The TXT mirror is identical content but with
a .txt suffix so it pastes verbatim into chat clients that aggressively
render markdown.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

OUT = Path(sys.argv[1])

CASES = [
    ("C1_buffered_no_postproc",         "batched=F, cleaning=F, merging=F (baseline)"),
    ("C2_batched_no_postproc",          "batched=T, cleaning=F, merging=F (only batched flipped)"),
    ("C3_buffered_cleaning_only",       "batched=F, cleaning=T, merging=F"),
    ("C4_buffered_merging_only",        "batched=F, cleaning=F, merging=T"),
    ("C5_buffered_both_postproc",       "batched=F, cleaning=T, merging=T"),
    ("C6_batched_both_postproc",        "batched=T, cleaning=T, merging=T"),
    ("C7_batched_with_condition_true",  "batched=T, condition_on_previous_text=T (should be forced to F)"),
]


def load_json(name: str) -> dict | None:
    p = OUT / f"{name}.json"
    if not p.exists():
        return {"_missing": True}
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


def main() -> None:
    summary = load_summary()
    lines: list[str] = []
    p = lines.append

    p("# 受控验证报告")
    p("")
    p(f"**输出目录**: `{OUT.name}`  ")
    p("**目的**: 用响应里的 `_meta` 字段直接观测：")
    p("- (1) Batched 路径是否在跑")
    p("- (2) text_cleaning / segment_merging 开关是否真生效")
    p("- (3) Batched 是否真把 _BATCHED_DROPPED_KWARGS 剥掉")
    p("- (4) Batched 是否能在被请求 `condition_on_previous_text=true` 时仍强制为 false")
    p("")
    p("**音频**: `audio/clips/en_30s.wav` (英文 30 秒)")
    p("**端点**: `POST /v1/audio/transcriptions`")
    p("")

    # ── 表 1：每个用例的关键 _meta 字段 ─────────────────
    p("## 1. 每个用例的 _meta 关键字段")
    p("")
    p("| 用例 | HTTP | 耗时(ms) | _meta.path | batched_requested | text_cleaning_active | segment_merging_active | condition_used | batched_dropped_kwargs | batched_typeerror |")
    p("|---|---|---:|---|---|---|---|---|---|---|")

    rows_for_analysis: dict[str, dict] = {}
    for case_id, _desc in CASES:
        body = load_json(case_id)
        row = summary.get(case_id, {})
        http = row.get("http", "?")
        elapsed = row.get("elapsed_ms", "?")
        meta = (body or {}).get("_meta") or {}
        rows_for_analysis[case_id] = {"body": body, "meta": meta, "row": row}

        path = meta.get("path", "?")
        breq = meta.get("batched_requested", "?")
        tc = meta.get("text_cleaning_active", "?")
        sm = meta.get("segment_merging_active", "?")
        cond = meta.get("condition_on_previous_text_used", "?")
        bdrop = meta.get("batched_dropped_kwargs", []) or []
        bdrop_s = ",".join(bdrop) if bdrop else "—"
        terr = meta.get("batched_typeerror") or "—"
        if terr != "—":
            terr = terr[:60] + ("…" if len(terr) > 60 else "")

        p(f"| {case_id} | {http} | {elapsed} | `{path}` | {breq} | {tc} | {sm} | {cond} | `{bdrop_s}` | {terr} |")
    p("")

    # ── 表 2：文本与段数对照（C1 baseline 对比所有其他用例）──
    p("## 2. 与 C1 (baseline) 的文本/段数对照")
    p("")
    p("> 字符相似度用字符多重集 Jaccard 近似；1.000 = 完全一致")
    p("")
    p("| 用例 | _meta.path | 段数 | 字符数 | 与 C1 文本相似度 | 与 C1 字符数差 |")
    p("|---|---|---:|---:|---:|---:|")

    def text_of(c):
        b = rows_for_analysis.get(c, {}).get("body") or {}
        return b.get("text") or ""

    def segs_of(c):
        b = rows_for_analysis.get(c, {}).get("body") or {}
        return b.get("segments") or []

    def similarity(a: str, b: str) -> float:
        if not a and not b:
            return 1.0
        if not a or not b:
            return 0.0
        from collections import Counter
        ca, cb = Counter(a), Counter(b)
        common = sum((ca & cb).values())
        return common / max(len(a), len(b))

    base_text = text_of("C1_buffered_no_postproc")
    base_chars = len(base_text)
    for case_id, _desc in CASES:
        txt = text_of(case_id)
        segs = segs_of(case_id)
        meta = rows_for_analysis[case_id]["meta"]
        sim = similarity(txt, base_text) if case_id != "C1_buffered_no_postproc" else 1.0
        diff = len(txt) - base_chars
        path = meta.get("path", "?")
        p(f"| {case_id} | `{path}` | {len(segs)} | {len(txt)} | {sim:.3f} | {diff:+d} |")
    p("")

    # ── 自动结论 ───────────────────────────────────────
    p("## 3. 自动结论")
    p("")

    c1 = rows_for_analysis.get("C1_buffered_no_postproc", {}).get("meta", {})
    c2 = rows_for_analysis.get("C2_batched_no_postproc", {}).get("meta", {})
    c3 = rows_for_analysis.get("C3_buffered_cleaning_only", {}).get("meta", {})
    c4 = rows_for_analysis.get("C4_buffered_merging_only", {}).get("meta", {})
    c5 = rows_for_analysis.get("C5_buffered_both_postproc", {}).get("meta", {})
    c6 = rows_for_analysis.get("C6_batched_both_postproc", {}).get("meta", {})
    c7 = rows_for_analysis.get("C7_batched_with_condition_true", {}).get("meta", {})

    # 3.1 Batched 路径
    p("### 3.1 Batched 是否真的在跑")
    p("")
    for label, m in [("C2", c2), ("C6", c6), ("C7", c7)]:
        path = m.get("path", "?")
        terr = m.get("batched_typeerror")
        tb = m.get("batched_traceback")
        if path == "batched":
            p(f"- ✓ **{label}**: `_meta.path = batched` → Batched 路径正常执行")
        elif path == "batched_fallback_to_buffered":
            p(f"- ✗ **{label}**: `_meta.path = batched_fallback_to_buffered` → **Batched 被 TypeError 拒绝**，fallback 到 Buffered。TypeError 信息：`{terr}`")
            if tb:
                # Show just the last 3-4 frames (most informative)
                tb_tail = "\n".join(tb.strip().splitlines()[-8:])
                p("  ```")
                p(tb_tail)
                p("  ```")
        elif path == "buffered":
            p(f"- ⚠️ **{label}**: 请求 batched=true 但 `_meta.path = buffered`（可能 _has_batched=False，或 batched 全局开关被关）")
        else:
            p(f"- ? **{label}**: `_meta.path = {path}`")

    # 3.2 text_cleaning / segment_merging
    p("")
    p("### 3.2 text_cleaning / segment_merging 开关是否生效")
    p("")
    for label, m, expect_tc, expect_sm in [
        ("C1", c1, False, False),
        ("C2", c2, False, False),
        ("C3", c3, True, False),
        ("C4", c4, False, True),
        ("C5", c5, True, True),
        ("C6", c6, True, True),
    ]:
        tc = m.get("text_cleaning_active")
        sm = m.get("segment_merging_active")
        tc_ok = (tc == expect_tc)
        sm_ok = (sm == expect_sm)
        flag = "✓" if (tc_ok and sm_ok) else "✗"
        p(f"- {flag} **{label}**: text_cleaning_active = {tc} (期望 {expect_tc}), segment_merging_active = {sm} (期望 {expect_sm})")

    # 3.3 _BATCHED_DROPPED_KWARGS
    p("")
    p("### 3.3 Batched 路径下被强制剥掉的 kwargs（_BATCHED_DROPPED_KWARGS）")
    p("")
    EXPECTED_DROPPED = {
        "condition_on_previous_text", "prompt_reset_on_temperature",
        "hallucination_silence_threshold", "vad_filter", "vad_parameters",
    }
    for label, m in [("C2", c2), ("C6", c6), ("C7", c7)]:
        dropped = set(m.get("batched_dropped_kwargs") or [])
        path = m.get("path", "?")
        if path == "batched":
            missing = EXPECTED_DROPPED - dropped
            extra = dropped - EXPECTED_DROPPED
            if not missing and not extra:
                p(f"- ✓ **{label}**: batched_dropped_kwargs = `{sorted(dropped)}` (与 _BATCHED_DROPPED_KWARGS 一致)")
            else:
                p(f"- ⚠️ **{label}**: batched_dropped_kwargs = `{sorted(dropped)}`; 缺：`{sorted(missing)}`, 多：`{sorted(extra)}`")
        else:
            p(f"- 跳过 **{label}**（path = {path}，没真走 Batched 所以 dropped 不适用）")

    # 3.4 C7: condition_on_previous_text 强制覆盖
    p("")
    p("### 3.4 C7: 调用方传 condition_on_previous_text=true，Batched 路径应强制为 False")
    p("")
    cond_used = c7.get("condition_on_previous_text_used")
    path7 = c7.get("path", "?")
    dropped7 = set(c7.get("batched_dropped_kwargs") or [])
    if path7 == "batched":
        if cond_used is False and "condition_on_previous_text" in dropped7:
            p(f"- ✓ Batched 路径成功强制覆盖：condition_on_previous_text_used = `{cond_used}`，并在 batched_dropped_kwargs 中包含 `condition_on_previous_text`")
        else:
            p(f"- ✗ Batched 路径未按预期强制覆盖：condition_on_previous_text_used = `{cond_used}`，dropped = `{sorted(dropped7)}`")
    elif path7 == "batched_fallback_to_buffered":
        p(f"- ⚠️ Batched fallback 了，condition_on_previous_text 在 Buffered 路径下应保持调用方传入值 → `{cond_used}`")
    else:
        p(f"- ? path = {path7}, condition_used = {cond_used}")

    # 3.5 C1 vs C2: 验证 Batched 输出与 Buffered 实际上是否相同
    p("")
    p("### 3.5 C1 (Buffered) vs C2 (Batched) 输出对比")
    p("")
    t1, t2 = text_of("C1_buffered_no_postproc"), text_of("C2_batched_no_postproc")
    s1, s2 = segs_of("C1_buffered_no_postproc"), segs_of("C2_batched_no_postproc")
    p2_path = c2.get("path", "?")
    sim12 = similarity(t1, t2)
    same_segs = len(s1) == len(s2)
    if p2_path == "batched":
        if sim12 < 0.99 or not same_segs:
            p(f"- ✓ Batched 真的在跑（path=batched），且输出确实不同（相似度 {sim12:.3f}, 段数 {len(s1)} vs {len(s2)}）")
        else:
            p(f"- ⚠️ Batched 在跑（path=batched），但输出与 Buffered 完全等价（相似度 {sim12:.3f}, 段数 {len(s1)}={len(s2)}）。这可能意味着 BatchedInferencePipeline 内部 VAD 与本调用使用的 VAD 参数等价；不算 bug，仅说明这条音频在两条路径上的结果天然一致")
    else:
        p(f"- C2 path = `{p2_path}`（不是纯 batched），下一节细看")

    # 3.6 C3/C4 vs C1: 验证后处理产生差异
    p("")
    p("### 3.6 后处理是否真的改变了输出（C3/C4/C5 vs C1）")
    p("")
    for label, c, expect_change_text, expect_change_segs in [
        ("C3", "C3_buffered_cleaning_only", True, False),
        ("C4", "C4_buffered_merging_only", False, True),
        ("C5", "C5_buffered_both_postproc", True, True),
    ]:
        t = text_of(c); s = segs_of(c)
        sim = similarity(t, t1)
        seg_diff = len(s) - len(s1)
        text_diff = len(t) - len(t1)
        notes = []
        if expect_change_text:
            notes.append(f"文本{'改变' if sim < 0.999 or text_diff != 0 else '未改变'}（相似度 {sim:.3f}, 字符差 {text_diff:+d}）")
        if expect_change_segs:
            notes.append(f"段数{'改变' if seg_diff else '未改变'}（{len(s1)} → {len(s)}）")
        p(f"- **{label}**: {' | '.join(notes)}")

    # ── 4. 失败列表 ──────────────────────────────────────
    p("")
    failed = [c for c, _ in CASES if not summary.get(c, {}).get("http", "").startswith("2")]
    if failed:
        p("## 4. HTTP 失败列表")
        p("")
        for c in failed:
            row = summary.get(c, {})
            body = load_json(c)
            head = ""
            if isinstance(body, dict):
                head = (body.get("detail") or str(body))[:200]
            p(f"- **{c}**: http={row.get('http')}, body 头部：`{head}`")
        p("")

    p("---")
    p("")
    p(f"_报告生成自 `{OUT}/summary.tsv` + `*.json` 原始响应；脚本：`scripts/lib/analyze_controlled_verify.py`_")
    p("")

    md = "\n".join(lines)
    (OUT / "report.md").write_text(md, encoding="utf-8")
    (OUT / "report.txt").write_text(md, encoding="utf-8")


if __name__ == "__main__":
    main()
