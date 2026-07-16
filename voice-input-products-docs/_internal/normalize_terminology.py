#!/usr/bin/env python3
"""把内部代号系统归一化为读者友好的描述性术语。

只处理对外 md 文档（00-09）；_internal/、_research/ 内的归档不动。
运行：
    cd voice-input-products-docs && python3 _internal/normalize_terminology.py
"""

from pathlib import Path

# (旧, 新) 替换映射。注意 U+2011 (NB hyphen ‑) 与 U+002D (ASCII -) 都要覆盖。
REPLACEMENTS = [
    # ── 集成路径代号 ──
    ("R‑1", "方案一"),
    ("R‑2", "方案二"),
    ("R‑3", "方案三"),
    ("R‑4", "方案四"),
    ("R‑5", "方案五"),
    ("R-1", "方案一"),
    ("R-2", "方案二"),
    ("R-3", "方案三"),
    ("R-4", "方案四"),
    ("R-5", "方案五"),

    # ── 阶段命名 ──
    ("Stage 1", "短期阶段"),
    ("Stage 2", "中期阶段"),
    ("Stage 3", "长期阶段"),

    # ── 调研分级 ──
    ("Tier 1+2", "重点 / 横向对比项目"),
    ("Tier 1 + Tier 2", "重点 / 横向对比项目"),
    ("Tier 1+Tier 2", "重点 / 横向对比项目"),
    ("Tier 1/2", "重点 / 横向对比项目"),
    ("Tier 2 / 3", "横向对比 / 提名项目"),
    ("Tier 1/2/3", "全部项目"),
    ("Tier 1", "重点分析项目"),
    ("Tier 2", "横向对比项目"),
    ("Tier 3", "提名项目"),
    ("Tier B", "服务端选项"),

    # ── 风险编号（仅去掉编号前缀，保留含义；后续手工把表头改为粗体即可） ──
    # 这些条目通常以 "**R‑XN：xxx**" 出现，替换后变成 "**xxx**"
    # 不在这里替换，避免破坏表格结构；手工处理。

    # ── 单一字符前缀代号（C-N / G-N / F-N / M-N / I-N / D-N / U-N / L-N） ──
    # 这些出现在表格 # 列里，去掉对读者负担最大；同样不在脚本里改，由 09/06/05 等单独
    # 文档的"评分维度"段手工删表头列。

    # ── 旧 P 代号（已废弃） ──
    # P‑A/B/C/D 出现在 00 §3.3 / 01 / 02 / 工作日志；
    # 02 是历史档案保留即可；其他地方在手工重写时处理。

    # ── 用户群 U1~U7 ──
    ("U1 国内中文 Mac 重度", "国内中文 Mac 重度用户"),
    ("U2 国内中文 Win 重度", "国内中文 Windows 重度用户"),
    ("U3 国内 Linux 极客", "国内 Linux 极客"),
    ("U4 国内中文 Android", "国内中文 Android 用户"),
    ("U5 国内 iOS", "国内 iOS 用户"),
    ("U6 海外英文 Mac/Win/Linux", "海外英文 Mac/Win/Linux 用户"),
    ("U7 海外 Android/iOS", "海外 Android/iOS 用户"),
    ("U1 + U2 + U4 + U6", "国内中文桌面 + Android + 海外桌面综合"),
    ("U1 + U6", "国内中文 Mac + 海外桌面"),

    # ── 里程碑 M‑N（08 文档）──
    ("M‑1（", "里程碑 1（"),
    ("M‑2（", "里程碑 2（"),
    ("M‑3（", "里程碑 3（"),
    ("M‑4（", "里程碑 4（"),
    ("M‑5（", "里程碑 5（"),

    # ── 项目编号 T1‑NN（03/04/05 文档）──
    ("T1‑01", "Typeless"),
    ("T1‑02", "Type4Me"),
    ("T1‑03", "Voquill"),
    ("T1‑04", "Handy"),
    ("T1‑05", "VoiceInk"),
    ("T1‑06", "FluidVoice"),
    ("T1‑07", "CapsWriter"),
    ("T1‑08", "hyprwhspr"),
    ("T1‑09", "WhisperIME"),
    ("T1‑10", "Whisperboard"),
    ("T2‑", "对比项 T2-"),  # Tier 2 项目暂保留编号但前缀脱敏
]


def main():
    root = Path(__file__).resolve().parent.parent
    md_files = sorted(p for p in root.glob("*.md") if p.is_file())
    for md in md_files:
        original = md.read_text(encoding="utf-8")
        text = original
        for old, new in REPLACEMENTS:
            text = text.replace(old, new)
        if text != original:
            md.write_text(text, encoding="utf-8")
            print(f"Updated: {md.name}")
        else:
            print(f"No change: {md.name}")


if __name__ == "__main__":
    main()
