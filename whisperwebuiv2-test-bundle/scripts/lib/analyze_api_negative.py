#!/usr/bin/env python3
"""Analyze API negative-path + DeepL connectivity results.

For each case, compares actual HTTP code against the documented expected code,
and inspects the error body to confirm the right error message path.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

OUT = Path(sys.argv[1])

# Step → (endpoint, expected HTTP, expected substring in detail, human label)
CASES = [
    ("N1_nllb_missing",        "/v1/text/translations/nllb",                    "400", "Provide either",     "NLLB 不传 text/file"),
    ("N2_nllb_conflict",       "/v1/text/translations/nllb",                    "400", "Provide only one",   "NLLB 同时传 text+file"),
    ("N3_transcribe_no_file",  "/v1/audio/transcriptions",                      "422", "",                   "Transcribe 不传 file"),
    ("N4_youtube_bad_url",     "/v1/youtube/metadata",                          "400", "Failed",             "YouTube 无效 URL"),
    ("N5_deepl_no_key",        "/v1/text/translations/deepl",                   "422", "",                   "DeepL 不传 auth_key"),
    ("N6_deepl_bad_key",       "/v1/text/translations/deepl",                   "502", "DeepL request",      "DeepL 无效 auth_key"),
    ("C1_deepl_langs",         "/v1/translations/deepl/languages",              "200", "",                   "DeepL languages 端点"),
    ("N7_batched_invalid",     "/v1/audio/transcriptions",                      "422", "",                   "batched 传非 bool"),
    ("N8_cleaning_invalid",    "/v1/audio/transcriptions",                      "422", "",                   "text_cleaning 传非 bool"),
    ("N9_merging_invalid",     "/v1/audio/transcriptions",                      "422", "",                   "segment_merging 传非 bool"),
    ("N10_language_unknown",   "/v1/audio/transcriptions",                      "400", "Unknown language",   "language 传未知值"),
    ("N11_deepl_lang_unknown", "/v1/text/translations/deepl",                   "400", "Unknown DeepL",      "DeepL src_lang 传未知值"),
    ("N12_nllb_lang_unknown",  "/v1/text/translations/nllb",                    "400", "Unknown NLLB",       "NLLB src_lang 传未知值"),
    ("N13_youtube_no_url",     "/v1/audio/transcriptions/youtube",              "422", "youtube_url",        "YouTube transcribe 不传 youtube_url"),
]


def read_summary() -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    tsv = OUT / "summary.tsv"
    if not tsv.exists():
        return rows
    header = None
    for line in tsv.read_text(encoding="utf-8").splitlines():
        cols = line.split("\t")
        if header is None:
            header = cols
            continue
        row = dict(zip(header, cols))
        rows[row.get("step", "")] = row
    return rows


def load_body(step: str) -> tuple[str, Any]:
    """Return (raw_text, parsed_json_or_none)."""
    # File naming uses lowercased step prefix (N1 → n1, C1 → c1)
    code = step.split("_", 1)[0].lower()
    path = OUT / f"{code}.json"
    if not path.exists():
        return "<MISSING>", None
    raw = path.read_text(encoding="utf-8")
    try:
        return raw, json.loads(raw)
    except Exception:
        return raw, None


def main() -> None:
    summary = read_summary()

    print("# API 错误响应 + DeepL 连通性 实测报告\n")
    print(f"**输出目录**: `{OUT.name}`  \n")
    print("**目的**: 验证 STT 使用指南所列的错误响应矩阵与代码行为一致；同时通过 DeepL 端连通性测试确认 DeepL 路由可达。\n")
    print()

    # ── 主表 ──────────────────────────────────────────────────
    print("## 1. 错误路径校验\n")
    print("| Step | 用例 | 端点 | 期望 HTTP | 实际 HTTP | 匹配 | 期望关键字 | 命中 |")
    print("|---|---|---|---:|---:|:---:|---|:---:|")

    mismatches: list[tuple[str, str, str, str]] = []
    for step, endpoint, exp_http, exp_kw, label in CASES:
        r = summary.get(step, {})
        actual = r.get("http", "?")
        raw, body = load_body(step)
        # detail extraction
        detail = ""
        if isinstance(body, dict):
            if "detail" in body:
                detail = str(body["detail"])
            elif "error" in body:
                detail = json.dumps(body["error"], ensure_ascii=False)[:120]
        else:
            detail = raw[:200]
        http_match = actual == exp_http
        kw_hit = (not exp_kw) or (exp_kw.lower() in detail.lower())
        flag_http = "✅" if http_match else "❌"
        flag_kw = "✅" if kw_hit else ("—" if not exp_kw else "❌")
        print(f"| {step} | {label} | `{endpoint}` | {exp_http} | {actual} | {flag_http} | `{exp_kw}` | {flag_kw} |")
        if not http_match or not kw_hit:
            mismatches.append((step, label, f"http={actual}/exp{exp_http}", detail[:200]))

    print()

    # ── 详细响应正文 ──────────────────────────────────────────
    print("## 2. 响应正文（前 300 字符）\n")
    for step, endpoint, exp_http, exp_kw, label in CASES:
        raw, body = load_body(step)
        print(f"### {step} — {label}")
        print(f"- 端点: `{endpoint}`")
        if isinstance(body, dict):
            head = json.dumps(body, ensure_ascii=False, indent=2)
            head = head[:500] + ("…" if len(head) > 500 else "")
            print("```json")
            print(head)
            print("```")
        else:
            print("```")
            print(raw[:300] + ("…" if len(raw) > 300 else ""))
            print("```")
        print()

    # ── DeepL 连通性专题分析 ───────────────────────────────────
    print("## 3. DeepL 连通性专题\n")
    n6_row = summary.get("N6_deepl_bad_key", {})
    c1_row = summary.get("C1_deepl_langs", {})
    n6_http = n6_row.get("http", "?")
    c1_http = c1_row.get("http", "?")

    if c1_http == "200":
        print("- ✅ **C1**: `/v1/translations/deepl/languages` 返回 200 — DeepL 路由层与上游列表查询通畅。")
    else:
        print(f"- ❌ **C1**: `/v1/translations/deepl/languages` 返回 {c1_http} — 路由层或上游异常。")

    if n6_http == "502":
        print("- ✅ **N6**: 假 key 触发 502 — 代码确实把上游 401/403 包装成 502，错误路径正常。")
    elif n6_http.startswith("5"):
        print(f"- ⚠️ **N6**: 假 key 触发 {n6_http} — 服务器侧错误，但未必是 502；需查 detail。")
    elif n6_http.startswith("4"):
        print(f"- ⚠️ **N6**: 假 key 触发 {n6_http} — 异常未走 DeepL 上游（可能在 FastAPI 校验阶段就拒了，或本地 DeepL 客户端先报错）。")
    else:
        print(f"- ❌ **N6**: 假 key 返回 {n6_http} — 未达预期，参见正文。")

    print()

    # ── 不匹配清单 ────────────────────────────────────────────
    print("## 4. 不匹配清单\n")
    if not mismatches:
        print("✅ 所有期望项都命中，错误响应矩阵与代码一致。\n")
    else:
        print("| Step | 用例 | 偏差 | 实际响应（前 200 字） |")
        print("|---|---|---|---|")
        for step, label, dev, det in mismatches:
            det = det.replace("|", "\\|").replace("\n", " ")
            print(f"| {step} | {label} | {dev} | {det} |")
        print()

    print("---\n")
    print(f"_报告生成自 `{OUT}/summary.tsv` 与 `*.json` 原始响应；脚本：`scripts/lib/analyze_api_negative.py`_\n")


if __name__ == "__main__":
    main()
