#!/usr/bin/env python3
"""把残留的内部编号（R‑XN、G‑N、F‑N、C‑N、I/D/M 维度编号、L‑N 等）清掉。

规则：
- "### R‑XN：xxx" → "### xxx"
- "**R‑XN**" → 删
- "G‑N：" / "F‑N：" / "C‑N" 内嵌引用 → 改成纯描述
- 维度编号 M1/I1/D1 等表格 # 列→留维度名删编号
"""

import re
from pathlib import Path


# (正则, 替换) 列表；按顺序执行
REGEX_REPLACEMENTS = [
    # 09 风险章节：### R-L1：xxx → ### xxx
    (r"^### R[‑\-][A-Z][0-9]+：", "### ", re.MULTILINE),
    # 09 内嵌引用：**（R‑E1）** / （R‑E1） / R‑E1 / R-X1
    (r"（R[‑\-][A-Z][0-9]+）", "", 0),
    (r"\(R[‑\-][A-Z][0-9]+\)", "", 0),
    (r"R[‑\-][A-Z][0-9]+", "", 0),
    # 06/05/03 文档内的 G‑1 / F‑1 / C‑1 等约束编号引用：
    # "| G‑1 | 目标 |" 表格行删第一列 → 复杂，留给手工
    # 但内嵌的 "(C‑3)" / "(F‑5)" / "(G‑2)" 这种引用全部清掉
    (r"（[CGFMILD][‑\-][0-9]+）", "", 0),
    (r"\([CGFMILD][‑\-][0-9]+\)", "", 0),
    # 行首独立 "| C‑1 |" / "| F‑1 |" 这种表格的第一列编号，把编号清空保留分隔符
    (r"^\| [CGFMILD][‑\-][0-9]+ \|", "| |", re.MULTILINE),
    # 08 工作量矩阵 等表格里 "G‑1 / F‑5 / C‑3" 等纯编号引用
    (r"\b[CGFMILD][‑\-][0-9]+\b", "", 0),
    # 09 待办编号 L-1 → 删
    (r"^\| L[‑\-][0-9]+ \|", "| |", re.MULTILINE),
    (r"（L[‑\-][0-9]+）", "", 0),
    (r"\(L[‑\-][0-9]+\)", "", 0),
    (r"\bL[‑\-][0-9]+\b", "", 0),
    # 里程碑 M‑N（08 中部分已替换；剩余 "| M‑1 |"）
    (r"^\| 里程碑 ([1-5])（", lambda m: f"| 里程碑 {m.group(1)}（", re.MULTILINE),
    # 用户群编号 U1-U7 在表格首列
    (r"^\| U[1-7] ", "| ", re.MULTILINE),
    # 残留的 P‑A/B/C/D 引用（02 之外的）—— 02 标"内部档案"后允许残留
    # 这里全删，由调用方在 02 单独保留
]


def clean(text: str) -> str:
    for entry in REGEX_REPLACEMENTS:
        pattern, repl = entry[0], entry[1]
        flags = entry[2] if len(entry) > 2 else 0
        text = re.sub(pattern, repl, text, flags=flags)
    # 二次清理：连续空格、表格 "| | |" 折叠
    text = re.sub(r"\|  +\|", "| |", text)
    # 表格中"| | xxx"如果第一列被清空，留个占位 — — 给读者更好辨识
    text = re.sub(r"^\| \| ", "| — | ", text, flags=re.MULTILINE)
    return text


def main():
    root = Path(__file__).resolve().parent.parent
    # 全部对外文档；02 是历史档案不动（其 C/P 编号是它的主角）
    targets = [
        "00_报告范围与样本集规划.md",
        "01_LarePass源码考察.md",
        "03_技术架构对比.md",
        "04_大模型架构对比.md",
        "05_安装与生态.md",
        "06_R4_集群侧设计.md",
        "07_客户端设计.md",
        "08_选型推荐与落地路线.md",
        "09_风险与开放问题.md",
    ]
    for name in targets:
        md = root / name
        if not md.exists():
            continue
        original = md.read_text(encoding="utf-8")
        text = clean(original)
        if text != original:
            md.write_text(text, encoding="utf-8")
            print(f"Cleaned: {md.name}")
        else:
            print(f"No change: {md.name}")


if __name__ == "__main__":
    main()
