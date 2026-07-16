#!/usr/bin/env python3
"""Analyze API happy-path test results, emit markdown report to stdout."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

OUT = Path(sys.argv[1])


def load_json(name: str) -> Any:
    p = OUT / name
    if not p.exists():
        return {"_missing": True}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"_parse_error": str(exc), "_raw_head": p.read_text(encoding="utf-8")[:200]}


def load_text(name: str) -> str:
    p = OUT / name
    if not p.exists():
        return "<MISSING>"
    return p.read_text(encoding="utf-8")


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


def check(label: str, ok: bool, detail: str = "") -> str:
    icon = "✅" if ok else "❌"
    if detail:
        return f"- {icon} **{label}** — {detail}"
    return f"- {icon} **{label}**"


def expect_keys(d: Any, keys: list[str]) -> tuple[bool, str]:
    if not isinstance(d, dict):
        return False, f"非 dict（type={type(d).__name__}）"
    missing = [k for k in keys if k not in d]
    if missing:
        return False, f"缺字段: {missing}"
    return True, f"含字段: {keys}"


def expect_list_of_dicts_with(items: Any, key: str) -> tuple[bool, str]:
    if not isinstance(items, list):
        return False, f"非 list（type={type(items).__name__}）"
    if not items:
        return False, "list 为空"
    if not all(isinstance(x, dict) and key in x for x in items):
        return False, f"并非每个元素都含 `{key}`"
    return True, f"{len(items)} 个元素，每个含 `{key}`"


def main() -> None:
    summary = read_summary()

    print("# API Happy Path 实测报告\n")
    print(f"**输出目录**: `{OUT.name}`  \n")
    print(f"**端点覆盖**: §2.10 全部 11 个端点（YouTube 真实转录默认跳过）  \n")
    print()

    # ── 1. 调用清单（HTTP 状态 + 耗时）─────────────────────────
    print("## 1. 调用清单\n")
    print("| Step | 端点 | HTTP | 耗时(ms) | 备注 |")
    print("|---|---|---:|---:|---|")
    for step in [
        "P0_healthz", "P0_models", "P0_openapi",
        "P1a_transcribe_json", "P1b_transcribe_verbose", "P1c_transcribe_srt",
        "P2a_translate_json", "P2b_translate_verbose",
        "P3a_youtube_metadata", "P3b_youtube_real",
        "P4a_nllb_models", "P4b_nllb_languages",
        "P4c_nllb_text_single", "P4d_nllb_text_batch", "P4e_nllb_file",
        "P5a_deepl_langs",
        "P6a_meta_buffered_no_postproc", "P6b_meta_batched_no_postproc",
        "P6c_meta_buffered_both_postproc", "P6d_meta_batched_both_postproc",
    ]:
        r = summary.get(step, {})
        http = r.get("http", "?")
        elapsed = r.get("elapsed_ms", "?")
        notes = r.get("notes", "")
        ep = r.get("endpoint", "")
        flag = "✅" if http.startswith("2") else ("⏭️" if http == "SKIP" else "❌")
        print(f"| {step} | `{ep}` | {flag} {http} | {elapsed} | {notes} |")
    print()

    # ── 2. 响应结构校验 ────────────────────────────────────────
    print("## 2. 响应结构校验\n")
    print("### 2.1 §2.10.0 运维与发现\n")

    healthz = load_json("p0_healthz.json")
    ok, det = expect_keys(healthz, ["status"])
    print(check("/healthz", ok and healthz.get("status") == "ok", f"status={healthz.get('status')}"))

    models = load_json("p0_models.json")
    ok, det = expect_keys(models, ["object", "data"])
    print(check("/v1/models", ok and isinstance(models.get("data"), list), det + f"，data 长度={len(models.get('data', []))}" if ok else det))

    openapi = load_json("p0_openapi.json")
    paths = openapi.get("paths", {}) if isinstance(openapi, dict) else {}
    expected_paths = [
        "/healthz", "/v1/models",
        "/v1/audio/transcriptions", "/v1/audio/translations",
        "/v1/audio/transcriptions/youtube", "/v1/youtube/metadata",
        "/v1/text/translations/nllb",
        "/v1/translations/nllb/models", "/v1/translations/nllb/languages",
        "/v1/text/translations/deepl", "/v1/translations/deepl/languages",
    ]
    missing = [p for p in expected_paths if p not in paths]
    print(check("/openapi.json", not missing, f"包含全部 11 端点" if not missing else f"缺：{missing}"))

    print("\n### 2.2 §2.10.1 transcriptions\n")
    p1a = load_json("p1a_transcribe_json.json")
    ok, det = expect_keys(p1a, ["text"])
    print(check("response_format=json", ok, det))

    p1b = load_json("p1b_transcribe_verbose.json")
    ok_keys = isinstance(p1b, dict) and all(k in p1b for k in ["text", "segments", "language"])
    has_word_ts = ok_keys and any("words" in seg for seg in p1b.get("segments", [])[:3])
    print(check("response_format=verbose_json", ok_keys, "含 text/segments/language"))
    print(check("timestamp_granularities[]=word", has_word_ts, "首 3 段中至少 1 段含 `words`" if has_word_ts else "未发现 `words` 字段"))

    p1c = load_text("p1c_transcribe_srt.srt")
    srt_ok = "-->" in p1c and p1c.strip().splitlines()[0].strip().isdigit()
    print(check("response_format=srt", srt_ok, "首行为序号 + 含 `-->`" if srt_ok else f"格式异常（前 80 字：{p1c[:80]!r})"))

    print("\n### 2.3 §2.10.2 translations（中文 → 英文）\n")
    p2a = load_json("p2a_translate_json.json")
    text2a = p2a.get("text", "") if isinstance(p2a, dict) else ""
    has_latin = any(c.isascii() and c.isalpha() for c in text2a)
    print(check("translations json 含 text", bool(text2a), f"text 长度={len(text2a)}"))
    print(check("translations 输出含英文字符", has_latin, "（中文源 → 应译为英文）"))

    p2b = load_json("p2b_translate_verbose.json")
    print(check("translations verbose_json 结构",
                isinstance(p2b, dict) and "segments" in p2b and "language" in p2b,
                f"segments={len(p2b.get('segments', []))}"))

    print("\n### 2.4 §2.10.3 YouTube\n")
    p3a = load_json("p3a_yt_metadata.json")
    yt_ok = isinstance(p3a, dict) and any(k in p3a for k in ["title", "author", "length"])
    print(check("youtube/metadata 含基础字段", yt_ok,
                f"title={p3a.get('title', 'n/a')[:40] if isinstance(p3a, dict) else 'n/a'}"))

    p3b = summary.get("P3b_youtube_real", {})
    if p3b.get("http") == "SKIP":
        print("- ⏭️ **youtube 真实转录** — 默认跳过（设置 `RUN_YT=1` 启用）")
    else:
        body = load_json("p3b_yt_real.json")
        ok = isinstance(body, dict) and "text" in body
        print(check("youtube 真实转录", ok, f"text 长度={len(body.get('text','')) if isinstance(body, dict) else 0}"))

    print("\n### 2.5 §2.10.4 NLLB 文本翻译\n")
    # NLLB 列表端点遵循 OpenAI list 约定：{"object":"list", "data":[...]}
    p4a = load_json("p4a_nllb_models.json")
    data = p4a.get("data") if isinstance(p4a, dict) else None
    print(check("nllb/models",
                isinstance(data, list) and len(data) >= 1,
                f"返回 {len(data) if isinstance(data, list) else 0} 个 model"))

    p4b = load_json("p4b_nllb_languages.json")
    data = p4b.get("data") if isinstance(p4b, dict) else None
    print(check("nllb/languages",
                isinstance(data, list) and len(data) >= 100,
                f"返回 {len(data) if isinstance(data, list) else 0} 个语言（NLLB-200 应 ≥200）"))

    # 单条 → {"text": "<译文>"}；批量 → {"texts": ["<译文1>", ...]}
    p4c = load_json("p4c_nllb_text_single.json")
    t = p4c.get("text") if isinstance(p4c, dict) else None
    ok_single = isinstance(t, str) and len(t) > 0
    print(check("nllb 单条翻译",
                ok_single,
                f"text={t[:40]!r}" if ok_single else f"返回={p4c}"))

    p4d = load_json("p4d_nllb_text_batch.json")
    ts = p4d.get("texts") if isinstance(p4d, dict) else None
    ok_batch = isinstance(ts, list) and len(ts) == 3 and all(isinstance(x, str) for x in ts)
    print(check("nllb 批量翻译（3 条）",
                ok_batch,
                f"返回 {len(ts)} 条" if isinstance(ts, list) else f"返回={p4d}"))

    # 字幕文件 → {"text": "<拼合译文>", "segments": [...]}
    p4e = load_json("p4e_nllb_file.json")
    if isinstance(p4e, dict):
        keys = list(p4e.keys())
        has_useful = "text" in p4e and isinstance(p4e.get("segments"), list)
        seg_n = len(p4e.get("segments", []))
        print(check("nllb 字幕文件翻译", has_useful,
                    f"segments={seg_n}, text 长度={len(p4e.get('text',''))}" if has_useful else f"keys={keys}"))
    else:
        print(check("nllb 字幕文件翻译", False, "响应非 dict"))

    # ── 2.5b §2.10.X.0 默认响应"零侵入"自检 ───────────────
    # 关键：当调用方没传 `_diag=true` 时，本开发版应该和 OpenAI 上游字节
    # 一致——body 不出现 `_meta`，响应头不出现 `X-Whisper-*`。
    # 这里直接读 P1b (verbose_json, 没传 _diag) 看是否符合预期。
    print("\n### 2.5b 默认响应零侵入自检（不传 `_diag` 应字节级 OpenAI 兼容）\n")
    print("> P1b 是没传 `_diag` 的 verbose_json 调用；如果 body 出现 `_meta` 字段，说明 opt-in 守卫失效。\n")
    p1b = load_json("p1b_transcribe_verbose.json")
    if isinstance(p1b, dict):
        has_meta_in_default = "_meta" in p1b
        flag = "✗ FAIL" if has_meta_in_default else "✓ PASS"
        print(f"- **P1b 默认 verbose_json `body._meta` 缺席**: {flag}")
        if has_meta_in_default:
            print(f"  - 警告：`_meta` 字段意外出现在默认响应里：`{list((p1b.get('_meta') or {}).keys())[:5]}…`")
    print("")

    print("\n### 2.6 §2.10.X 引擎可观测性覆盖（_meta 字段）\n")
    print("> 验证 WebUI 新增的三个开关（`batched` / `text_cleaning` / `segment_merging`）在 API 路径下确实生效。")
    print("> 这一组用例**主动传 `_diag=true`** 开启诊断；与上一节默认零侵入是对照。\n")
    print("| Case | _meta.path | text_cleaning_active | segment_merging_active | batched_dropped_kwargs | batched_typeerror |")
    print("|---|---|---|---|---|---|")
    for label, fname, exp_path, exp_tc, exp_sm in [
        ("P6a_meta_buffered_no_postproc",  "p6a_meta_buffered_no_postproc.json",  "buffered", False, False),
        ("P6b_meta_batched_no_postproc",   "p6b_meta_batched_no_postproc.json",   "batched",  False, False),
        ("P6c_meta_buffered_both_postproc","p6c_meta_buffered_both_postproc.json", "buffered", True,  True),
        ("P6d_meta_batched_both_postproc", "p6d_meta_batched_both_postproc.json",  "batched",  True,  True),
    ]:
        body = load_json(fname)
        meta = (body or {}).get("_meta") or {}
        path = meta.get("path", "?")
        tc = meta.get("text_cleaning_active", "?")
        sm = meta.get("segment_merging_active", "?")
        bdrop = meta.get("batched_dropped_kwargs") or []
        bdrop_s = ",".join(bdrop) if bdrop else "—"
        terr = meta.get("batched_typeerror") or "—"
        if terr != "—":
            terr = terr[:60] + ("…" if len(terr) > 60 else "")
        path_flag = "✓" if path == exp_path else ("⚠️" if path == "batched_fallback_to_buffered" else "✗")
        tc_flag = "✓" if tc == exp_tc else "✗"
        sm_flag = "✓" if sm == exp_sm else "✗"
        print(f"| {label} | `{path}` {path_flag} | {tc} {tc_flag} | {sm} {sm_flag} | `{bdrop_s}` | {terr} |")
    print("")

    print("\n### 2.7 §2.10.5 DeepL languages（不需要 key）\n")
    p5a = load_json("p5a_deepl_langs.json")
    if isinstance(p5a, dict):
        # 端点返回结构可能是 {"source": [...], "target": [...]} 或 {"languages": [...]}
        keys = list(p5a.keys())
        has_lang_info = bool(keys) and any(k in p5a for k in ["source", "target", "languages"])
        print(check("deepl/languages", has_lang_info, f"keys={keys}"))
    elif isinstance(p5a, list):
        print(check("deepl/languages", len(p5a) > 0, f"返回 {len(p5a)} 条"))
    else:
        print(check("deepl/languages", False, "响应非 dict / 非 list"))

    print()

    # ── 3. 失败汇总 ─────────────────────────────────────────────
    failed = [s for s, r in summary.items() if not r.get("http", "").startswith("2") and r.get("http") != "SKIP"]
    print("## 3. 失败 / 异常清单\n")
    if not failed:
        print("✅ 无失败调用。\n")
    else:
        print("| Step | HTTP | 响应前 200 字 |")
        print("|---|---|---|")
        for step in failed:
            r = summary.get(step, {})
            # 读对应 json
            stem = step.lower()
            # find matching .json
            candidates = list(OUT.glob(f"{step.lower().replace('p','p')}*.json"))
            body_head = ""
            for c in OUT.iterdir():
                if c.is_file() and c.suffix in (".json", ".srt") and step.lower().split("_", 1)[0] in c.name.lower():
                    body_head = c.read_text(encoding="utf-8")[:200].replace("|", "\\|").replace("\n", " ")
                    break
            print(f"| {step} | {r.get('http','?')} | {body_head} |")
        print()

    print("---\n")
    print(f"_报告生成自 `{OUT}/summary.tsv` 与 `*.json` 原始响应；脚本：`scripts/lib/analyze_api_positive.py`_\n")


if __name__ == "__main__":
    main()
