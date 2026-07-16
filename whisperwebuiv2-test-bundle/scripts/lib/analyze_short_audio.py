#!/usr/bin/env python3
"""Analyze short-audio batched-vs-buffered results.

Reads the *.json files in results/short_audio_<ts>/ plus summary.tsv,
emits a markdown report to stdout.
"""

from __future__ import annotations

import json
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any

OUT = Path(sys.argv[1])

CASES = [
    ("zh_10s",   10,  "Chinese"),
    ("zh_30s",   30,  "Chinese"),
    ("zh_1min",  60,  "Chinese"),
    ("zh_3min",  180, "Chinese"),
    ("zh_5min",  300, "Chinese"),
    ("en_10s",   10,  "English"),
    ("en_30s",   30,  "English"),
    ("en_1min",  60,  "English"),
    ("en_3min",  180, "English"),
    ("en_5min",  300, "English"),
]


def normalize(text: str) -> str:
    """Strip whitespace, NFKC-normalize, lowercase for comparison."""
    if not text:
        return ""
    return unicodedata.normalize("NFKC", text).strip().lower()


def load_response(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"_parse_error": str(exc), "_raw": path.read_text(encoding="utf-8")[:300]}


def stats(resp: dict[str, Any] | None) -> dict[str, Any]:
    """Extract observable metrics from a verbose_json response."""
    if resp is None:
        return {"missing": True}
    if "_parse_error" in resp:
        return {"parse_error": resp["_parse_error"]}
    text = resp.get("text", "")
    segments = resp.get("segments") or []
    first_seg = segments[0]["text"].strip() if segments else ""
    last_seg = segments[-1]["text"].strip() if segments else ""
    duration = resp.get("duration")
    meta = resp.get("_meta") or {}
    return {
        "text_len": len(text or ""),
        "n_segments": len(segments),
        "first_seg": first_seg[:60],
        "last_seg": last_seg[:60],
        "duration": duration,
        "language": resp.get("language"),
        "text_norm": normalize(text),
        "meta_path": meta.get("path"),
        "meta_typeerror": meta.get("batched_typeerror"),
    }


def read_summary(tsv_path: Path) -> dict[tuple[str, str], dict[str, str]]:
    """summary.tsv → {(clip, mode): row}."""
    rows: dict[tuple[str, str], dict[str, str]] = {}
    if not tsv_path.exists():
        return rows
    header = None
    for line in tsv_path.read_text(encoding="utf-8").splitlines():
        cols = line.split("\t")
        if header is None:
            header = cols
            continue
        row = dict(zip(header, cols))
        step = row.get("step", "")
        # step format: <clip>_<mode>
        if "_batched" in step:
            clip, mode = step.rsplit("_", 1)
        elif "_buffered" in step:
            clip, mode = step.rsplit("_", 1)
        else:
            continue
        rows[(clip, mode)] = row
    return rows


def char_overlap_ratio(a: str, b: str) -> float:
    """Rough text similarity: |intersection of multisets| / max(|a|, |b|)."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    from collections import Counter
    ca, cb = Counter(a), Counter(b)
    common = sum((ca & cb).values())
    return common / max(len(a), len(b))


def main() -> None:
    summary = read_summary(OUT / "summary.tsv")
    print(f"# 短音频实测报告  \n")
    print(f"**输出目录**: `{OUT.name}`  \n")
    print(f"**测试矩阵**: 10 个 clip（5 时长档 × 2 语种） × 2 模式（batched / buffered） = 20 次调用  \n")
    print(f"**端点**: `POST /v1/audio/transcriptions`  \n")
    print(f"**关闭后处理**: `text_cleaning=false` + `segment_merging=false`（只看引擎层差异）  \n")
    print()

    # ── 表格 0：_meta.path 观测（最关键证据）────────────
    print("## 0. 每次调用的 `_meta.path` 观测（铁证：Batched 是否真在跑）\n")
    print("> 由本开发版引擎在响应里直接吐出，非推断。`batched` = 真走了 BatchedInferencePipeline；")
    print("> `batched_fallback_to_buffered` = TypeError 后退回 Buffered；`buffered` = 走 Buffered 路径。\n")
    print("| Clip | Buffered 调用 path | Batched 调用 path | Batched TypeError（若有） |")
    print("|---|---|---|---|")
    for clip, dur, lang in CASES:
        buf_st = stats(load_response(OUT / f"{clip}_buffered.json"))
        bat_st = stats(load_response(OUT / f"{clip}_batched.json"))
        buf_path = buf_st.get("meta_path") or "?"
        bat_path = bat_st.get("meta_path") or "?"
        terr = bat_st.get("meta_typeerror") or "—"
        if terr != "—":
            terr = terr[:80] + ("…" if len(terr) > 80 else "")
        print(f"| {clip} | `{buf_path}` | `{bat_path}` | {terr} |")
    print()

    # ── 表格 1：速度与基本指标对照 ──────────────────────────
    print("## 1. 速度与段数对照\n")
    print("| Clip | 时长(s) | Buffered 耗时(ms) | Batched 耗时(ms) | 速度比 (Buf/Bat) | Buf 段数 | Bat 段数 | Buf 字符数 | Bat 字符数 |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|")

    speed_flips = []   # batched 反而比 buffered 慢的样本
    seg_count_anomalies = []  # 段数差异 > 2x

    for clip, dur, lang in CASES:
        buf_resp = load_response(OUT / f"{clip}_buffered.json")
        bat_resp = load_response(OUT / f"{clip}_batched.json")
        buf_st = stats(buf_resp)
        bat_st = stats(bat_resp)

        buf_ms = int(summary.get((clip, "buffered"), {}).get("elapsed_ms", "0") or 0)
        bat_ms = int(summary.get((clip, "batched"), {}).get("elapsed_ms", "0") or 0)
        ratio = (buf_ms / bat_ms) if bat_ms else 0
        ratio_str = f"{ratio:.2f}x" if ratio else "n/a"
        if bat_ms and buf_ms and bat_ms > buf_ms * 1.10:
            ratio_str += " ⚠️"
            speed_flips.append((clip, buf_ms, bat_ms))

        buf_seg = buf_st.get("n_segments", "?")
        bat_seg = bat_st.get("n_segments", "?")
        if isinstance(buf_seg, int) and isinstance(bat_seg, int):
            if buf_seg > 0 and bat_seg > 0 and max(buf_seg, bat_seg) / min(buf_seg, bat_seg) > 2:
                seg_count_anomalies.append((clip, buf_seg, bat_seg))

        print(f"| {clip} | {dur} | {buf_ms} | {bat_ms} | {ratio_str} | {buf_seg} | {bat_seg} | {buf_st.get('text_len','?')} | {bat_st.get('text_len','?')} |")

    print()

    # ── 表格 2：首尾段对照（VAD 漏识检测）────────────────────
    print("## 2. 首尾段对照（VAD 漏识检测）\n")
    print("> 如果 Batched 的首段或末段缺失/截断而 Buffered 完整，说明 Silero VAD 误切了边界静音/弱音。\n")
    print("| Clip | 模式 | 首段（前 60 字） | 末段（前 60 字） |")
    print("|---|---|---|---|")

    head_tail_diffs = []  # (clip, side, buf_text, bat_text)
    for clip, dur, lang in CASES:
        buf_st = stats(load_response(OUT / f"{clip}_buffered.json"))
        bat_st = stats(load_response(OUT / f"{clip}_batched.json"))
        # 表格
        print(f"| {clip} | buffered | {buf_st.get('first_seg','?')} | {buf_st.get('last_seg','?')} |")
        print(f"| {clip} | batched  | {bat_st.get('first_seg','?')} | {bat_st.get('last_seg','?')} |")
        # 检测差异
        for side in ("first_seg", "last_seg"):
            a = normalize(buf_st.get(side, ""))
            b = normalize(bat_st.get(side, ""))
            if a and b:
                sim = char_overlap_ratio(a, b)
                if sim < 0.70:
                    head_tail_diffs.append((clip, side, buf_st.get(side, ""), bat_st.get(side, ""), sim))
            elif a and not b:
                head_tail_diffs.append((clip, side, buf_st.get(side, ""), "<MISSING>", 0.0))
            elif b and not a:
                head_tail_diffs.append((clip, side, "<MISSING>", bat_st.get(side, ""), 0.0))

    print()

    # ── 表格 3：整体文本相似度 ──────────────────────────────
    print("## 3. 全文相似度（Buf vs Bat，字符多重集 Jaccard 近似）\n")
    print("> 1.00 = 完全一致；< 0.85 通常意味着引擎对同一段音频产出了明显不同的转录。\n")
    print("| Clip | 全文相似度 | Buf 长度 | Bat 长度 |")
    print("|---|---:|---:|---:|")
    text_similarity_issues = []
    for clip, dur, lang in CASES:
        buf_st = stats(load_response(OUT / f"{clip}_buffered.json"))
        bat_st = stats(load_response(OUT / f"{clip}_batched.json"))
        sim = char_overlap_ratio(buf_st.get("text_norm", ""), bat_st.get("text_norm", ""))
        flag = " ⚠️" if sim < 0.85 else ""
        print(f"| {clip} | {sim:.3f}{flag} | {buf_st.get('text_len','?')} | {bat_st.get('text_len','?')} |")
        if sim < 0.85:
            text_similarity_issues.append((clip, sim))

    print()

    # ── 结论与告警 ──────────────────────────────────────────
    print("## 4. 自动检出的可疑样本\n")
    if not speed_flips and not seg_count_anomalies and not head_tail_diffs and not text_similarity_issues:
        print("✅ 未检出明显异常：速度、段数、首尾段、整体文本都在合理范围。\n")
    else:
        if speed_flips:
            print("### 4.1 Batched 反而更慢（速度反转）\n")
            for clip, buf_ms, bat_ms in speed_flips:
                print(f"- **{clip}**: Buffered {buf_ms}ms vs Batched {bat_ms}ms（慢了 {(bat_ms/buf_ms-1)*100:.0f}%）")
            print()
        if seg_count_anomalies:
            print("### 4.2 段数差异 > 2x\n")
            for clip, b, a in seg_count_anomalies:
                print(f"- **{clip}**: Buffered {b} 段 vs Batched {a} 段")
            print()
        if head_tail_diffs:
            print("### 4.3 首段 / 末段差异（VAD 误切嫌疑）\n")
            for clip, side, a, b, sim in head_tail_diffs:
                print(f"- **{clip}** [{side}, 相似度 {sim:.2f}]")
                print(f"  - buffered: `{a}`")
                print(f"  - batched : `{b}`")
            print()
        if text_similarity_issues:
            print("### 4.4 全文相似度 < 0.85\n")
            for clip, sim in text_similarity_issues:
                print(f"- **{clip}**: 全文相似度 {sim:.3f}")
            print()

    # ── HTTP 错误统计 ──────────────────────────────────────
    failed = [(k, v) for k, v in summary.items() if not v.get("http", "").startswith("2")]
    if failed:
        print("## 5. HTTP 失败列表\n")
        for (clip, mode), row in failed:
            print(f"- {clip}_{mode}: http={row.get('http')}, notes={row.get('notes')}")
        print()

    # ── 原始耗时分布 ──────────────────────────────────────
    print("## 6. 耗时分位（仅参考，供后续基线对比）\n")
    all_buf = [int(summary.get((c[0], "buffered"), {}).get("elapsed_ms", 0) or 0) for c in CASES]
    all_bat = [int(summary.get((c[0], "batched"), {}).get("elapsed_ms", 0) or 0) for c in CASES]
    all_buf = sorted(x for x in all_buf if x)
    all_bat = sorted(x for x in all_bat if x)

    def pct(lst, p):
        if not lst:
            return 0
        idx = max(0, min(len(lst) - 1, int(len(lst) * p / 100)))
        return lst[idx]

    print(f"| 模式 | min | p50 | p90 | max | 样本数 |")
    print(f"|---|---:|---:|---:|---:|---:|")
    if all_buf:
        print(f"| buffered | {min(all_buf)} | {pct(all_buf,50)} | {pct(all_buf,90)} | {max(all_buf)} | {len(all_buf)} |")
    if all_bat:
        print(f"| batched  | {min(all_bat)} | {pct(all_bat,50)} | {pct(all_bat,90)} | {max(all_bat)} | {len(all_bat)} |")

    print()
    print("---\n")
    print(f"_报告生成自 `{OUT}/summary.tsv` 与 `*.json` 原始响应；脚本：`scripts/lib/analyze_short_audio.py`_\n")


if __name__ == "__main__":
    main()
