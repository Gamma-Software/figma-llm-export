---
name: figma-to-code
description: >-
  Convert a Figma design into application code from a figma-llm-export payload —
  the JSON produced by the "LLM Export" Figma plugin (node tree + inlined design
  tokens + rendered PNG/SVG crops). Use whenever the user points at such a .json
  export, says "build/implement this Figma screen/component", "turn this design
  into code", references a "figma payload", "design tokens from Figma", or shares
  a node JSON with `{value, variable}` pairs. Produces token-faithful, framework-
  appropriate code (React/Tailwind/shadcn, Vue, plain HTML, SwiftUI, …) and
  verifies it against the exported screenshot.
---

# Figma → code (from a figma-llm-export payload)

A figma-llm-export payload is **richer than a screenshot**: every styled value
carries the **design token behind it** (`{ "value": "#141414", "variable":
"Theme/background" }`), the full auto-layout, the text runs, the component
instances, and a rendered PNG/SVG of each element. Your job is to turn it into
code that **reuses the app's own design system**, not a pixel copy with magic
numbers.

## The one rule that matters

> **Map the `variable`, never hardcode the `value`.**
> `"variable": "Theme/background"` → the app's `--background` token / `bg-background`
> class — *not* `#141414`. The `value` is a fallback and a sanity check only.

A design built with a token collection that mirrors the app's tokens (the common
case — see the example in `references/token-mapping.md`) maps almost 1:1. When a
value has **no** `variable`, it's a genuine one-off: use an arbitrary value and
flag it to the user as a candidate for a new token.

## Workflow

### 0. Parse the payload — run the bundled inspector

A helper script is bundled next to this file at
`scripts/inspect_payload.py` (stdlib-only Python 3). Run it first:

```bash
python3 <skill-dir>/scripts/inspect_payload.py "<payload>.json" --out ./.figma-assets
```

It prints (a) the node tree with layout + the token on every value, (b) a
"tokens used" report, (c) the variable/collection dumps, and (d) extracts the
PNG/SVG crops to disk. Read its output before writing anything — it's the map.
If you can't locate the script, the same inspection is easy to do inline with
`python3`/`jq`; the payload schema is in `references/payload-schema.md`.

### 1. Look at the picture(s)

`Read` the extracted PNG(s) — they are the ground truth for spacing, alignment
and visual intent that the tree alone can't convey. For icon crops exported as
`.svg`, read the markup as text to recover the exact `<path>` geometry. Keep the
main frame's screenshot open to compare against at the end.

### 2. Resolve tokens against the TARGET codebase

Before coding, discover the app's design-token system so you can translate
`Theme/*` names into real classes/vars. Search the repo:

```bash
# CSS custom properties (shadcn / tweakcn / vanilla):
grep -rnE "^\s*--[a-z-]+:" src/**/globals.css app/**/globals.css 2>/dev/null
# Tailwind theme tokens / config:
grep -rn "@theme\|theme:\s*{" . --include=globals.css --include=tailwind.config.* 2>/dev/null
```

Build a small mapping table `Figma variable → app token → class/var`. The full
strategy (colors, radius, spacing, dimension tokens, alpha, light/dark modes,
fallbacks) is in **`references/token-mapping.md`**. Confirm whether the design is
the **light or dark** variant (compare the resolved colors to the app's `:root`
vs `.dark` blocks) so you bind the right mode.

### 3. Translate structure

Map Figma constructs to the target framework using
**`references/node-types.md`**:

- `FRAME`/`GROUP` with `layout.mode` → a flex container (`flex` + direction);
  `itemSpacing` → `gap`, `padding` → padding, `primaryAxis`/`counterAxis` →
  `justify-*`/`items-*`.
- `layoutSizing` `HUG`→ fit content, `FILL`→ grow/stretch, `FIXED`→ explicit size.
- `TEXT` → text element with the font family/size/weight/line-height (prefer the
  app's font tokens over the literal `Lato`/`Geist` name).
- `VECTOR` / small icon frames → the app's icon set (e.g. `lucide-react`) by
  name when recognizable, else inline the SVG from the `.svg` crop.
- `INSTANCE` → an **existing component**. The node's `mainComponent` and
  `componentProperties` (variant props) tell you which and in what state.

### 3b. Spacing & dimension fidelity — capture every value, never approximate

Spacing is where design-to-code silently drifts. Reproduce it **exactly**, and
understand Figma's model: there is **no per-element margin** in auto-layout.

- **Gap between siblings** = the parent's `itemSpacing` → `gap-*`. A `gap=0` is a
  real value (means "no gap"); don't assume a default.
- **Inset from edges** = the parent's `padding`, which is **per-side** (T/R/B/L)
  and frequently asymmetric (e.g. `0/16/0/0` = only `pr-4`). The inspector prints
  `pad[T/R/B/L]=…` — map each side independently to `pt-/pr-/pb-/pl-`; collapse to
  `px-/py-/p-` only when sides are genuinely equal.
- **What looks like a margin** on one child is normally the parent's padding or
  gap. For a child of a **non-auto-layout** frame, its `x`/`y` IS its offset
  (inspector shows `@(x,y)←offset`) — reproduce via absolute position, an
  explicit margin, or a centering rule, whichever matches intent.
- **Per-corner radius** (`cornerRadius` as `{topLeft,…}`) and **per-side stroke
  weight** (`strokeWeight.{top,right,bottom,left}`) are independent too: `0/0/15/15`
  radius → `rounded-t-[…]` only; `bottom:1` stroke → `border-b`. Don't round the
  whole box or border all sides.
- **Honour bound dimension tokens** for width/height (`w-[var(--…)]`), not the px.

Before moving on, account for **every** spacing/size number the inspector
reported — each one is intentional.

### 4. Reuse components, don't reinvent

For every `INSTANCE`, search the codebase for a component matching its
`mainComponent` name or role before writing markup:

```bash
grep -rniE "function (Breadcrumb|TrafficLights|…)" src/ ; ls src/components/ui
```

Pass the Figma `componentProperties` through as props/variants. Only build new
markup when no component exists — and then match the app's component conventions.

### 5. Write the code

Match the surrounding code's idiom (file layout, naming, className ordering,
TS/JS). Use token classes/vars from step 2 throughout. Dimension tokens with no
utility class become arbitrary values referencing the var, e.g.
`h-[var(--mac-top-height)]`, `w-[var(--app-sidebar-width)]`.

### 6. Verify against the screenshot

This is not optional. Render the result (project's preview/dev server, or the
`run`/preview tooling) and compare to the exported PNG: structure, **spacing**,
colors, text. Specifically re-check spacing against the inspector output — every
`gap`, per-side `pad`, per-corner `radius`, per-side `stroke`, and offset should
be present in the code; inspect computed box metrics if the preview tool allows
it. List any deltas. Then audit for hardcoded values that should have been tokens
(`grep` your new file for hex/`px` literals) and report leftovers.

## Output to the user

- The code, written into the right place in the repo.
- The `Figma variable → app token` mapping table you used.
- Any value with **no** matching token (flag as a possible new token).
- The screenshot-vs-render comparison and remaining deltas.

## References

- `references/payload-schema.md` — every key in the payload and what it means.
- `references/token-mapping.md` — turning Figma variables into app tokens.
- `references/node-types.md` — Figma node/auto-layout → framework constructs.
