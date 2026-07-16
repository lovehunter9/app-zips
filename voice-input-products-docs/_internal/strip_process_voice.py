#!/usr/bin/env python3
"""把标题里的 "（Step N）" 副标题、引导段的"阅读关系/承接 XX"等过程语言去掉。"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TARGETS = [
    "03_技术架构对比.md",
    "04_大模型架构对比.md",
    "05_安装与生态.md",
    "06_R4_集群侧设计.md",
    "07_客户端设计.md",
    "08_选型推荐与落地路线.md",
    "09_风险与开放问题.md",
]


def clean(text: str) -> str:
    # 一级标题里的 "（Step N）"
    text = re.sub(r"^(# [^\n]+?)（Step \d+(?:\.\d+)?）", r"\1", text, flags=re.MULTILINE)
    text = re.sub(r"^(# [^\n]+?) \(Step \d+(?:\.\d+)?\)", r"\1", text, flags=re.MULTILINE)
    # "> 阅读关系：xxx" 整段（到下一空行）
    text = re.sub(
        r"^> 阅读关系：[^\n]*(?:\n>[^\n]*)*\n",
        "",
        text,
        flags=re.MULTILINE,
    )
    # 内嵌的 "（R 路径定义）" / "（R 路径映射）" 之类历史引用
    text = re.sub(r"（R 路径定义）", "（候选方案定义）", text)
    text = re.sub(r"（R 路径映射）", "（候选方案映射）", text)
    text = re.sub(r"R 路径", "候选方案", text)
    # "本文承接 xxx" 段
    text = re.sub(
        r"^> 本文承接[^\n]*\n",
        "",
        text,
        flags=re.MULTILINE,
    )
    # 引文里的 "Step N" 描述
    text = re.sub(r"Step \d+ 落实", "前序章节落实", text)
    text = re.sub(r"Step \d+(?:[‑\-]\d+)?", "前序章节", text)
    # 删除已变空的标题尾部空格 / 多余空白
    text = re.sub(r"^(# [^\n]+) +$", r"\1", text, flags=re.MULTILINE)
    # 连续空行折叠
    text = re.sub(r"\n\n\n+", "\n\n", text)
    return text


def main():
    for name in TARGETS:
        md = ROOT / name
        if not md.exists():
            continue
        original = md.read_text(encoding="utf-8")
        text = clean(original)
        if text != original:
            md.write_text(text, encoding="utf-8")
            print(f"Stripped: {md.name}")


if __name__ == "__main__":
    main()
