#!/usr/bin/env python3
"""Render Whisper-WebUI_STT质量优化与API完整使用指南.md to DOCX.

This is a *thin* markdown-to-docx renderer: we parse the source .md with
``mistune`` and walk the AST, mapping each block to ``python-docx`` primitives.
The goal is to keep the docx faithfully in sync with the .md so the two
never drift again -- previously generate_docx.py was a manually maintained
mirror of the document and silently fell out of date.

Usage::

    python3 generate_docx.py                          # uses default .md path
    python3 generate_docx.py path/to/other.md         # custom source

The script auto-installs ``mistune`` and ``python-docx`` if missing.  Run
inside the project venv (``.venv/`` in this directory) to keep packages
isolated from system Python.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from typing import Iterable

try:
    import mistune
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "mistune"])
    import mistune

try:
    from docx import Document
    from docx.shared import Pt, RGBColor, Cm
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.oxml.ns import qn
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "python-docx"])
    from docx import Document
    from docx.shared import Pt, RGBColor, Cm
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.oxml.ns import qn


# ---------------------------------------------------------------------------
# styling helpers
# ---------------------------------------------------------------------------

BODY_FONT = 'Microsoft YaHei'
BODY_SIZE = Pt(10.5)
CODE_FONT = 'Courier New'
CODE_SIZE = Pt(8.5)
TABLE_FONT_SIZE = Pt(9)
HEADER_FILL = 'D9E2F3'
QUOTE_FILL = 'F2F2F2'
CODE_FILL = 'F5F5F5'


def _set_eastasia(run, name=BODY_FONT):
    """Force the East-Asian font on a run so CJK glyphs use the right face."""
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn('w:rFonts'))
    if rfonts is None:
        from docx.oxml import OxmlElement
        rfonts = OxmlElement('w:rFonts')
        rpr.append(rfonts)
    rfonts.set(qn('w:eastAsia'), name)


def _set_cell_shading(cell, color_hex):
    tcPr = cell._element.get_or_add_tcPr()
    from docx.oxml import OxmlElement
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), color_hex)
    tcPr.append(shd)


def _set_para_shading(p, color_hex):
    pPr = p._element.get_or_add_pPr()
    from docx.oxml import OxmlElement
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), color_hex)
    pPr.append(shd)


def _add_runs_from_inline(p, inline_tokens, *, base_size=BODY_SIZE,
                          base_font=BODY_FONT, base_color=None,
                          force_bold=False, force_italic=False):
    """Render mistune *inline* tokens onto a docx paragraph.

    Supported inline types: text, strong, emphasis, codespan, link, image,
    softbreak, linebreak, html_inline.  Unknown types fall back to plaintext.
    """
    for tok in inline_tokens or []:
        ttype = tok['type']
        if ttype == 'text':
            run = p.add_run(tok['raw'])
            run.font.name = base_font
            run.font.size = base_size
            if base_color is not None:
                run.font.color.rgb = base_color
            if force_bold:
                run.bold = True
            if force_italic:
                run.italic = True
            _set_eastasia(run, base_font)
        elif ttype == 'strong':
            _add_runs_from_inline(
                p, tok['children'], base_size=base_size, base_font=base_font,
                base_color=base_color, force_bold=True, force_italic=force_italic,
            )
        elif ttype == 'emphasis':
            _add_runs_from_inline(
                p, tok['children'], base_size=base_size, base_font=base_font,
                base_color=base_color, force_bold=force_bold, force_italic=True,
            )
        elif ttype == 'codespan':
            run = p.add_run(tok['raw'])
            run.font.name = CODE_FONT
            run.font.size = base_size
            run.font.color.rgb = RGBColor(0xB0, 0x30, 0x40)
        elif ttype == 'link':
            label = ''.join(c.get('raw', '') for c in tok.get('children', []))
            run = p.add_run(label or tok.get('attrs', {}).get('url', ''))
            run.font.name = base_font
            run.font.size = base_size
            run.font.color.rgb = RGBColor(0x1A, 0x4D, 0x99)
            run.underline = True
        elif ttype == 'image':
            label = ''.join(c.get('raw', '') for c in tok.get('children', []))
            run = p.add_run(f"[image: {label}]")
            run.font.size = base_size
            run.italic = True
        elif ttype in ('softbreak', 'linebreak'):
            p.add_run('\n')
        elif ttype == 'html_inline':
            # Strip the tag, keep nothing (no raw HTML in docx)
            pass
        else:
            # Unknown inline: dump raw text
            raw = tok.get('raw', '')
            if raw:
                run = p.add_run(raw)
                run.font.name = base_font
                run.font.size = base_size


def _flatten_inline_text(tokens):
    """Get plain text from inline tokens (used by table cells)."""
    out = []
    for tok in tokens or []:
        if tok['type'] == 'text':
            out.append(tok['raw'])
        elif tok['type'] == 'codespan':
            out.append(tok['raw'])
        elif tok['type'] in ('strong', 'emphasis'):
            out.append(_flatten_inline_text(tok['children']))
        elif tok['type'] == 'link':
            label = _flatten_inline_text(tok.get('children', []))
            url = tok.get('attrs', {}).get('url', '')
            out.append(label or url)
        elif tok['type'] in ('softbreak', 'linebreak'):
            out.append('\n')
        elif tok['type'] == 'image':
            out.append(_flatten_inline_text(tok.get('children', [])))
    return ''.join(out)


# ---------------------------------------------------------------------------
# block-level rendering
# ---------------------------------------------------------------------------

def _heading_level_to_docx(level):
    """Map markdown heading depth -> docx heading level (0 is Title)."""
    return min(level, 9)


def _render_heading(doc, tok):
    level = tok['attrs']['level']
    text = _flatten_inline_text(tok['children'])
    h = doc.add_heading(text, level=_heading_level_to_docx(level))
    for run in h.runs:
        _set_eastasia(run)


def _render_paragraph(doc, tok):
    p = doc.add_paragraph()
    _add_runs_from_inline(p, tok['children'])


def _render_block_text(doc, tok):
    """Mistune emits block_text inside lists for the item body."""
    p = doc.add_paragraph()
    _add_runs_from_inline(p, tok['children'])


def _render_block_quote(doc, tok):
    """Blockquotes are rendered as indented paragraphs with light background."""
    for child in tok['children']:
        if child['type'] == 'paragraph':
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.6)
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(2)
            _add_runs_from_inline(p, child['children'])
            _set_para_shading(p, QUOTE_FILL)
        elif child['type'] == 'list':
            _render_list(doc, child, indent_extra=Cm(0.6), depth=0)
        else:
            _render(doc, child)


def _render_code_block(doc, tok):
    """Fenced code block: monospaced, gray background."""
    code = tok.get('raw', '')
    code = code.rstrip('\n')
    for line in code.split('\n'):
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.8)
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        run = p.add_run(line if line else ' ')
        run.font.name = CODE_FONT
        run.font.size = CODE_SIZE
        run.font.color.rgb = RGBColor(0x1A, 0x1A, 0x1A)
        _set_para_shading(p, CODE_FILL)
    # add a small gap after the block
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.space_after = Pt(2)


def _render_thematic_break(doc, tok):
    # render a faint horizontal rule by adding a bottom-bordered empty paragraph
    p = doc.add_paragraph()
    pPr = p._element.get_or_add_pPr()
    from docx.oxml import OxmlElement
    pBdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '6')
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), 'CCCCCC')
    pBdr.append(bottom)
    pPr.append(pBdr)


def _render_list(doc, tok, indent_extra=None, depth=0):
    """Render an ordered or unordered list.

    Ordered lists deliberately render the index as inline text (``1. ``,
    ``2. `` ...) instead of relying on Word's built-in ``List Number``
    style, because that style auto-increments across the entire document
    -- so two unrelated ordered lists in the same .md end up numbered
    ``1, 2, 3`` followed by ``4, 5, 6`` in the .docx.  Inline numbering
    guarantees each ordered list restarts at 1.

    Unordered lists still use the ``List Bullet`` style (bullet glyph
    has no cross-list state so the built-in style behaves correctly).
    """
    ordered = tok.get('attrs', {}).get('ordered', False)
    start_at = tok.get('attrs', {}).get('start', 1) if ordered else None
    bullet_glyphs = ['•', '◦', '▪']  # progressively for nested unordered

    base_indent = Cm(0.6 + depth * 0.6)
    if indent_extra:
        base_indent = base_indent + indent_extra

    for i, item in enumerate(tok['children']):
        first = True
        if ordered:
            marker = f"{(start_at or 1) + i}. "
        else:
            marker = bullet_glyphs[min(depth, len(bullet_glyphs) - 1)] + " "

        for child in item['children']:
            if child['type'] in ('block_text', 'paragraph'):
                if first:
                    p = doc.add_paragraph()
                    p.paragraph_format.left_indent = base_indent
                    p.paragraph_format.first_line_indent = Cm(-0.6)
                    p.add_run(marker)
                    _add_runs_from_inline(p, child['children'])
                    first = False
                else:
                    p = doc.add_paragraph()
                    p.paragraph_format.left_indent = base_indent + Cm(0.6)
                    _add_runs_from_inline(p, child['children'])
            elif child['type'] == 'list':
                _render_list(doc, child, depth=depth + 1)
            elif child['type'] == 'block_code':
                _render_code_block(doc, child)
            elif child['type'] == 'block_quote':
                _render_block_quote(doc, child)
            else:
                _render(doc, child)


def _render_table(doc, tok):
    """Render a GFM table."""
    head_row = tok['children'][0]    # table_head
    body = tok['children'][1] if len(tok['children']) > 1 else None  # table_body
    headers = head_row['children']   # list of table_cell
    body_rows = body['children'] if body else []

    n_cols = len(headers)
    n_rows = 1 + len(body_rows)
    table = doc.add_table(rows=n_rows, cols=n_cols)
    table.style = 'Table Grid'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    # header
    for ci, cell_tok in enumerate(headers):
        cell = table.rows[0].cells[ci]
        cell.text = ''
        p = cell.paragraphs[0]
        _add_runs_from_inline(p, cell_tok['children'], base_size=TABLE_FONT_SIZE)
        for run in p.runs:
            run.bold = True
        _set_cell_shading(cell, HEADER_FILL)

    # body
    for ri, row in enumerate(body_rows, start=1):
        for ci, cell_tok in enumerate(row['children']):
            if ci >= n_cols:
                continue
            cell = table.rows[ri].cells[ci]
            cell.text = ''
            p = cell.paragraphs[0]
            _add_runs_from_inline(p, cell_tok['children'], base_size=TABLE_FONT_SIZE)

    # small gap after the table
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.space_after = Pt(2)


# ---------------------------------------------------------------------------
# main dispatcher
# ---------------------------------------------------------------------------

def _render(doc, tok):
    t = tok['type']
    if t == 'heading':
        _render_heading(doc, tok)
    elif t == 'paragraph':
        _render_paragraph(doc, tok)
    elif t == 'block_text':
        _render_block_text(doc, tok)
    elif t == 'block_quote':
        _render_block_quote(doc, tok)
    elif t == 'block_code':
        _render_code_block(doc, tok)
    elif t == 'thematic_break':
        _render_thematic_break(doc, tok)
    elif t == 'list':
        _render_list(doc, tok)
    elif t == 'table':
        _render_table(doc, tok)
    elif t == 'blank_line':
        # spacing between blocks; let docx handle it
        pass
    elif t == 'block_html':
        # Strip raw HTML / comments
        pass
    else:
        # Fallback: try to dump raw text if any
        raw = tok.get('raw') or ''
        if raw.strip():
            p = doc.add_paragraph()
            p.add_run(raw)


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

def build_docx(md_path: str, docx_path: str):
    with open(md_path, 'r', encoding='utf-8') as f:
        md_text = f.read()

    # mistune 3.x: enable table + url + strikethrough + task_lists
    parser = mistune.create_markdown(
        renderer=None,  # use the AST renderer
        plugins=['table', 'url', 'strikethrough', 'task_lists'],
    )
    tokens, _state = parser.parse(md_text)

    doc = Document()
    # configure default style
    style = doc.styles['Normal']
    style.font.name = BODY_FONT
    style.font.size = BODY_SIZE
    style.element.rPr.rFonts.set(qn('w:eastAsia'), BODY_FONT)

    for tok in tokens:
        _render(doc, tok)

    doc.save(docx_path)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_md = os.path.join(
        here, 'Whisper-WebUI_STT质量优化与API完整使用指南.md'
    )
    default_out = os.path.join(
        here, 'Whisper-WebUI_STT质量优化与API完整使用指南.docx'
    )
    md_path = sys.argv[1] if len(sys.argv) > 1 else default_md
    docx_path = sys.argv[2] if len(sys.argv) > 2 else default_out

    build_docx(md_path, docx_path)
    print(f"DOCX saved to: {docx_path}")


if __name__ == '__main__':
    main()
