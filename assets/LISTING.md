# Figma Community listing — copy

Paste these into the publish dialog. Assets to upload live next to this file:
`icon-128.png` (plugin icon) and `cover.png` (cover art, 1920×960).

## Name

Primary: **LLM Export**
If taken, alternates: **Layers to LLM**, **Design Context Export**,
**Spec for AI**, **Figma → LLM Payload**.

## Tagline (one line)

> Turn a Figma selection into an LLM-ready payload — nodes, variables, and cropped images.

## Description (markdown)

**LLM Export** packages whatever you select into a single, clean JSON your AI
agent can actually use — no more pasting screenshots and guessing.

**What it exports**
- **Nodes** — geometry, auto-layout, typography, effects, corner radii, stroke
  weights, constraints, component/instance info. Figma **variables are inlined**
  on each value as `{ value, variable: "Collection/name" }`, so a bound property
  is never confused with a hardcoded one. Mixed values (per-corner radii,
  per-range text) are expanded, never dropped.
- **Variables** — every variable the selection references, plus a one-click
  **full dump** of any collection in Figma's native export shape
  (`valuesByMode` + resolved alias chains).
- **Images** — each element cropped to its own PNG (base64), or **SVG markup**
  for vectors and icons so the agent reads real `<path>` data.

**How it works**
1. Select layers.
2. Pick which cropped images and variable collections to include.
3. Copy the payload or download the LLM bundle (JSON + images in one file).

**Private by design** — runs entirely inside Figma, makes **no network
requests**. Your design never leaves your machine.

Perfect for design-to-code, design QA with an AI, building component context,
or feeding a custom agent.

## Tags

`developer-tools` · `design-tokens` · `variables` · `export` · `json` ·
`ai` · `handoff` · `code`

## Support contact

Set an email or the repo issues URL:
`https://github.com/Gamma-Software/figma-llm-export/issues`
