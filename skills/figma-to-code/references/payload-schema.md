# Payload schema (figma-llm-export)

The "LLM Export" Figma plugin emits one JSON object per export. Top-level keys:

| key                  | type   | meaning |
|----------------------|--------|---------|
| `source`             | string | always `"figma"` |
| `exportedAt`         | string | ISO timestamp |
| `file`, `page`       | string | Figma file + page names |
| `selectionCount`     | number | how many top-level layers were selected |
| `nodes`              | array  | the selected node trees (full, recursive) |
| `variables`          | array  | every variable the selection references (alias chains followed → self-contained) |
| `variableCollections`| array  | optional full dumps of the collections the user ticked |
| `images`             | array  | rendered crops — PNG base64, or SVG markup for vectors/icons |

## Bound values: `{ value, variable }`

The defining feature. Any styled property that is bound to a Figma variable is
**inlined as an object** carrying both the resolved value and the token name:

```jsonc
{ "value": "#181818", "variable": "Theme/card-background" }
```

An **unbound** property is just the plain value (`"#181818"`, `12`, …). This
appears on: fills/strokes `.color`, `cornerRadius` (whole or per-corner),
`strokeWeight` (per side), `padding`, `itemSpacing`, `opacity`, `width`/`height`,
and `fontSize`. **Always read the `variable` and map it; treat `value` as a
fallback.** (Detect with: is it a dict containing both `value` and `variable`?)

## Node fields (per entry in `nodes`, recursive via `children`)

`id`, `name`, `type` (`FRAME` `GROUP` `INSTANCE` `COMPONENT` `TEXT` `VECTOR`
`LINE` …), `width`, `height`, `x`, `y`.

Geometry / style: `cornerRadius` (number, or `{topLeft,topRight,bottomRight,
bottomLeft}`, each possibly bound), `fills[]` and `strokes[]`
(`{type,visible,opacity,color}` where `color` may be bound), `strokeWeight`
(`{top,right,bottom,left}`, each possibly bound), `effects[]` (shadows/blurs),
`opacity`, `clipsContent`, `constraints` (`{h,v}`).

Auto-layout: either a `layout` object `{ mode, itemSpacing, padding:[t,r,b,l],
primaryAxisAlignItems, counterAxisAlignItems }` or flat fields
(`layoutMode`, `itemSpacing`, `paddingLeft/Top/...`). `layoutSizing` `{h,v}` is
`HUG` | `FILL` | `FIXED`.

Text (`type:"TEXT"`): `characters`, `fontName` `{family,style}`, `fontSize`
(may be bound), `fontWeight`, `lineHeight` `{unit,value}`, `letterSpacing`,
`textCase`, `textDecoration`, `textAlignHorizontal`, `fills`.

Components: `INSTANCE` carries `mainComponent` (name of the master) and
`componentProperties` — a map of prop → `{ value, type, boundVariables }` where
`type:"VARIANT"` is a variant selection (e.g. `{ "Type": { "value":
"link_component", "type": "VARIANT" } }`). Use these as the component's props.

## `variables[]`

Each: `id`, `name` (e.g. `radius/card-radius`), `type` (`COLOR` `FLOAT` `STRING`
`BOOLEAN`), `collection`, `valuesByMode` (per mode; colors as hex, aliases as
`{ alias: "Collection/name" }`).

## `variableCollections[]` (only if the user picked collections)

Figma's native export-variables shape: `id`, `name`, `modes`, `variableIds[]`,
`variables[]` — each variable with raw `valuesByMode`, `resolvedValuesByMode`
(alias chains followed), `scopes`, `hiddenFromPublishing`, `codeSyntax`.
Colors in `valuesByMode` here are `{r,g,b,a}` floats (0–1), not hex.

## `images[]`

`id`, `name`, `type`, `mimeType`, `scale` (usually 2), and **either**
`base64` (PNG) **or** SVG markup (for vectors / icons ≤ 64px, when the user
toggled Icons→SVG). Each meaningful element gets its own crop; `TEXT`/`VECTOR`
and tiny elements are skipped as standalone crops unless explicitly selected.
`base64` is drop-in for Anthropic multimodal blocks
(`{"type":"image","source":{"type":"base64","media_type":"image/png","data":…}}`).
