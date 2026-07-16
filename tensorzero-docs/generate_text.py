"""
Generate a plain-text version of the doc from the companion Markdown file.

Reads:  TensorZero简易使用文档.md (same directory)
Writes: TensorZero简易使用文档_纯文字版.txt (same directory)

Output is designed for direct paste into another document (e.g. Word):
  - All markdown markers (`#`, `**`, `` ` ``) are stripped to plain characters.
  - Headings get visual ASCII underlines for easy scanning.
  - Tables become TAB-separated lines so users can paste them into Word and
    use "Insert → Table → Convert Text to Table" with TAB delimiter.
  - Code blocks become 4-space-indented blocks (no fences).
  - Image lines become a clearly-tagged placeholder like
        【▼ 此处插入图片：assets/ui-01-overview.png（TensorZero Overview） ▼】
    so the user can search-and-replace in the target document and paste the
    actual image (taken from the .docx) at each spot.
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
MD_PATH = os.path.join(HERE, 'TensorZero简易使用文档.md')
TXT_PATH = os.path.join(HERE, 'TensorZero简易使用文档_纯文字版.txt')


# ──────────────────────────────────────────────────────────────────────────
# Inline transformations
# ──────────────────────────────────────────────────────────────────────────

INLINE_CODE_RE = re.compile(r'`([^`]+)`')
BOLD_RE = re.compile(r'\*\*([^*]+)\*\*')
LINK_RE = re.compile(r'(?<!!)\[([^\]]+)\]\(([^)]+)\)')


def transform_inline(text: str) -> str:
    """Strip inline markdown markers, leaving readable plain text."""
    # Links: [label](url) → "label (url)" if URL is http(s), else just label
    def _link(m):
        label, url = m.group(1), m.group(2)
        if url.startswith(('http://', 'https://')):
            return f'{label}（{url}）'
        return label
    text = LINK_RE.sub(_link, text)
    # Bold: **text** → just text (plain text can't represent bold)
    text = BOLD_RE.sub(lambda m: m.group(1), text)
    # Inline code: `xxx` → 「xxx」 (Chinese-friendly visual quoting)
    text = INLINE_CODE_RE.sub(lambda m: f'「{m.group(1)}」', text)
    return text


# ──────────────────────────────────────────────────────────────────────────
# Block parser
# ──────────────────────────────────────────────────────────────────────────

IMG_LINE_RE = re.compile(r'^!\[([^\]]*)\]\(([^)]+)\)\s*$')


def render(md: str) -> str:
    out = []
    lines = md.split('\n')
    i, n = 0, len(lines)

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # Blank line
        if not stripped:
            if out and out[-1] != '':
                out.append('')
            i += 1
            continue

        # HTML comment
        if stripped.startswith('<!--'):
            while i < n and '-->' not in lines[i]:
                i += 1
            i += 1
            continue

        # Horizontal rule
        if stripped == '---':
            out.append('')
            out.append('─' * 60)
            out.append('')
            i += 1
            continue

        # Image line: ![alt](path)
        m = IMG_LINE_RE.match(stripped)
        if m:
            alt, path = m.group(1), m.group(2)
            out.append('')
            out.append(f'【▼ 此处插入图片:{path}({alt}) ▼】')
            out.append('')
            i += 1
            continue

        # Headings
        m = re.match(r'^(#{1,4})\s+(.*)$', stripped)
        if m:
            level = len(m.group(1))
            title = transform_inline(m.group(2).strip())
            out.append('')
            if level == 1:
                out.append('═' * 60)
                out.append(title)
                out.append('═' * 60)
            elif level == 2:
                out.append('━' * 50)
                out.append(title)
                out.append('━' * 50)
            elif level == 3:
                out.append(f'▶ {title}')
                # underline matching visible width (CJK = 2 cells, ASCII = 1)
                width = sum(2 if ord(c) > 127 else 1 for c in title) + 2
                out.append('─' * min(width, 60))
            else:  # level 4
                out.append(f'◆ {title}')
            out.append('')
            i += 1
            continue

        # Fenced code block
        if stripped.startswith('```'):
            i += 1
            buf = []
            while i < n and not lines[i].lstrip().startswith('```'):
                buf.append(lines[i])
                i += 1
            out.append('')
            for code_line in buf:
                out.append(f'    {code_line}')
            out.append('')
            i += 1  # skip closing ```
            continue

        # Blockquote / callout
        if stripped.startswith('> ') or stripped == '>':
            buf = []
            while i < n and (lines[i].lstrip().startswith('> ') or lines[i].lstrip() == '>'):
                content = lines[i].lstrip()[1:].lstrip()
                buf.append(content)
                i += 1
            out.append('')
            out.append(f'★ 注意：{transform_inline(" ".join(buf))}')
            out.append('')
            continue

        # Table (header row followed by separator)
        if stripped.startswith('|') and i + 1 < n and re.match(r'^\|[\s:\-|]+\|$', lines[i + 1].strip()):
            header_cells = [transform_inline(c.strip()) for c in stripped.strip('|').split('|')]
            i += 2  # skip separator
            rows = [header_cells]
            while i < n and lines[i].strip().startswith('|'):
                cells = [transform_inline(c.strip()) for c in lines[i].strip().strip('|').split('|')]
                rows.append(cells)
                i += 1
            out.append('')
            out.append('（以下为表格，整段复制后在 Word 里点"插入→表格→将文字转换为表格"，分隔符选「制表符」即可还原表格）')
            for row in rows:
                out.append('\t'.join(row))
            out.append('')
            continue

        # Bullet list (- or *)
        m = re.match(r'^(\s*)[-*]\s+(.*)$', line)
        if m:
            indent_spaces = len(m.group(1))
            indent_level = indent_spaces // 2
            prefix = '  ' * (indent_level + 1) + '· '
            out.append(f'{prefix}{transform_inline(m.group(2))}')
            i += 1
            continue

        # Numbered list
        m = re.match(r'^(\s*)(\d+\.)\s+(.*)$', line)
        if m:
            indent_spaces = len(m.group(1))
            indent_level = indent_spaces // 2
            prefix = '  ' * (indent_level + 1) + f'{m.group(2)} '
            out.append(f'{prefix}{transform_inline(m.group(3))}')
            i += 1
            continue

        # Plain paragraph
        out.append(transform_inline(stripped))
        i += 1

    return '\n'.join(out).rstrip() + '\n'


def main():
    with open(MD_PATH, 'r', encoding='utf-8') as f:
        md = f.read()
    txt = render(md)
    with open(TXT_PATH, 'w', encoding='utf-8') as f:
        f.write(txt)
    print(f'Wrote: {TXT_PATH}  ({len(txt)} chars)')


if __name__ == '__main__':
    main()
