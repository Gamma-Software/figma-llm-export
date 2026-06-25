#!/usr/bin/env python3
"""Inspect a figma-llm-export payload for design-to-code work.

Stdlib-only. Given the JSON payload produced by the LLM Export Figma plugin,
this prints three things an agent needs before writing code:

  1. a compact node tree with layout + the design TOKEN behind each value
  2. a "tokens used" report (every Figma variable the selection references)
  3. extracted images on disk (PNG crops decoded from base64, SVG crops as .svg)

Usage:
    python3 inspect_payload.py <payload.json> [--out DIR] [--no-images] [--max-depth N]

The point of the token annotations: NEVER hardcode the resolved value in code.
Map the `Theme/foo` variable name to your app's design token instead.
"""
import argparse
import base64
import json
import os
import sys


def _is_bound(v):
    return isinstance(v, dict) and "value" in v and "variable" in v


def disp(v):
    """Render a possibly-bound value as 'value  ⟨token⟩' or just the value."""
    if _is_bound(v):
        return f"{v['value']}  «{v['variable']}»"
    return str(v)


def color_str(color):
    """A fill/stroke .color entry — may be {value,variable} or plain hex."""
    if _is_bound(color):
        return f"{color['value']}  «{color['variable']}»"
    if isinstance(color, dict) and "value" in color:
        return str(color["value"])
    return str(color)


def collect_tokens(node, acc):
    """Walk any nested structure, collecting every {value,variable} pair."""
    if isinstance(node, dict):
        if _is_bound(node):
            acc.setdefault(node["variable"], node["value"])
        for val in node.values():
            collect_tokens(val, acc)
    elif isinstance(node, list):
        for item in node:
            collect_tokens(item, acc)


def fmt_layout(node):
    bits = []
    layout = node.get("layout") or {}
    mode = layout.get("mode") or node.get("layoutMode")
    if mode and mode != "NONE":
        bits.append(f"flex:{mode.lower()}")
        if "itemSpacing" in layout:
            bits.append(f"gap={disp(layout['itemSpacing'])}")
        if layout.get("padding"):
            bits.append(f"pad={layout['padding']}")
        if layout.get("primaryAxisAlignItems"):
            bits.append(f"justify={layout['primaryAxisAlignItems']}")
        if layout.get("counterAxisAlignItems"):
            bits.append(f"align={layout['counterAxisAlignItems']}")
    ls = node.get("layoutSizing") or {}
    if ls:
        bits.append(f"sizing={ls.get('h','?')}/{ls.get('v','?')}")
    return "  ".join(bits)


def fmt_size(node):
    w, h = node.get("width"), node.get("height")
    return f"{disp(w) if w is not None else '?'}×{disp(h) if h is not None else '?'}"


def fmt_paint(node):
    out = []
    for f in node.get("fills") or []:
        if f.get("visible", True) and f.get("type") == "SOLID":
            op = f.get("opacity")
            tag = f"fill={color_str(f.get('color'))}"
            if op not in (None, 1):
                tag += f" @{op}"
            out.append(tag)
    for s in node.get("strokes") or []:
        if s.get("visible", True) and s.get("type") == "SOLID":
            out.append(f"stroke={color_str(s.get('color'))}")
    sw = node.get("strokeWeight")
    if isinstance(sw, dict) and any(sw.get(k) for k in ("top", "right", "bottom", "left")):
        out.append(f"strokeW={ {k: disp(v) for k, v in sw.items() if v} }")
    cr = node.get("cornerRadius")
    if cr is not None:
        if isinstance(cr, dict):
            corners = {k: disp(v) for k, v in cr.items() if v}
            if corners:
                out.append(f"radius={corners}")
        elif cr:
            out.append(f"radius={disp(cr)}")
    return "  ".join(out)


def fmt_text(node):
    if node.get("type") != "TEXT":
        return ""
    parts = [f'"{node.get("characters","")}"']
    fn = node.get("fontName") or {}
    if fn:
        parts.append(f"{fn.get('family')} {fn.get('style')}")
    if node.get("fontSize") is not None:
        parts.append(f"{disp(node['fontSize'])}px")
    if node.get("fontWeight"):
        parts.append(f"w{node['fontWeight']}")
    lh = node.get("lineHeight")
    if isinstance(lh, dict) and lh.get("value") is not None:
        parts.append(f"lh={lh['value']}{lh.get('unit','')[:2]}")
    return "  ".join(str(p) for p in parts)


def walk(node, depth, maxd, lines):
    pad = "  " * depth
    name = node.get("name", "?")
    ntype = node.get("type", "?")
    header = f"{pad}• {name}  [{ntype}]  {fmt_size(node)}"
    if ntype == "INSTANCE" and node.get("mainComponent"):
        header += f"  ⟶ component:{node['mainComponent']}"
    lines.append(header)
    meta = []
    lay = fmt_layout(node)
    if lay:
        meta.append(lay)
    paint = fmt_paint(node)
    if paint:
        meta.append(paint)
    txt = fmt_text(node)
    if txt:
        meta.append("text " + txt)
    cp = node.get("componentProperties")
    if cp:
        meta.append(f"props={cp}")
    for m in meta:
        lines.append(f"{pad}    {m}")
    if depth >= maxd:
        kids = node.get("children") or []
        if kids:
            lines.append(f"{pad}    … {len(kids)} children (depth cut)")
        return
    for child in node.get("children") or []:
        walk(child, depth + 1, maxd, lines)


def extract_images(payload, outdir):
    written = []
    os.makedirs(outdir, exist_ok=True)
    for im in payload.get("images") or []:
        ident = (im.get("name") or im.get("id") or "img").replace("/", "_").replace(" ", "_")
        # SVG crops carry raw markup; PNG crops carry base64.
        if im.get("svg") or (im.get("mimeType") == "image/svg+xml"):
            markup = im.get("svg") or im.get("markup") or im.get("base64") or ""
            path = os.path.join(outdir, f"{ident}.svg")
            with open(path, "w") as fh:
                fh.write(markup)
            written.append(path)
        elif im.get("base64"):
            path = os.path.join(outdir, f"{ident}.png")
            with open(path, "wb") as fh:
                fh.write(base64.b64decode(im["base64"]))
            written.append(path)
    return written


def main():
    ap = argparse.ArgumentParser(description="Inspect a figma-llm-export payload.")
    ap.add_argument("payload", help="path to the exported .json payload")
    ap.add_argument("--out", help="dir for extracted images (default: <payload>.assets)")
    ap.add_argument("--no-images", action="store_true", help="skip image extraction")
    ap.add_argument("--max-depth", type=int, default=12)
    args = ap.parse_args()

    with open(args.payload) as fh:
        payload = json.load(fh)

    print("=" * 72)
    print(f"file: {payload.get('file')!r}   page: {payload.get('page')!r}   "
          f"selection: {payload.get('selectionCount')}   "
          f"exported: {payload.get('exportedAt')}")
    print("=" * 72)

    print("\n## NODE TREE  (value «design-token» — map the token, don't hardcode the value)\n")
    lines = []
    for node in payload.get("nodes") or []:
        walk(node, 0, args.max_depth, lines)
    print("\n".join(lines))

    # Tokens referenced inline on values
    inline = {}
    collect_tokens(payload.get("nodes") or [], inline)
    print("\n## TOKENS USED  (Figma variable ⟶ resolved value — map each to an app token)\n")
    for name in sorted(inline):
        print(f"  {name}  =  {inline[name]}")

    # Top-level variables table (type + collection + per-mode)
    variables = payload.get("variables") or []
    if variables:
        print("\n## VARIABLES (referenced, self-contained)\n")
        for v in variables:
            vals = v.get("valuesByMode") or {}
            print(f"  [{v.get('collection')}] {v.get('name')} : {v.get('type')} = "
                  f"{list(vals.values())}")

    cols = payload.get("variableCollections") or []
    if cols:
        print("\n## FULL COLLECTION DUMPS\n")
        for c in cols:
            print(f"  collection {c.get('name')!r}: modes={c.get('modes')}  "
                  f"#vars={len(c.get('variables') or [])}")

    if not args.no_images:
        outdir = args.out or (os.path.splitext(args.payload)[0] + ".assets")
        written = extract_images(payload, outdir)
        print(f"\n## IMAGES  ({len(written)} written to {outdir})\n")
        for p in written:
            print(f"  {p}")
        print("\n→ Read the PNG(s) with the Read tool before and after coding "
              "to ground-truth the visual. Read .svg files as text for icon paths.")


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError as e:
        sys.exit(f"payload not found: {e}")
    except json.JSONDecodeError as e:
        sys.exit(f"invalid JSON: {e}")
