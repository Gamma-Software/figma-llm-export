# Figma node / auto-layout → framework constructs

Defaults shown for React + Tailwind; adapt the idiom to the target framework
(Vue, Svelte, plain HTML/CSS, SwiftUI). The *mapping logic* is the same.

## Node types

| Figma `type` | becomes | notes |
|--------------|---------|-------|
| `FRAME` / `GROUP` with `layout.mode != NONE` | flex container `<div>` | see auto-layout below |
| `FRAME` / `GROUP` without layout | positioned/plain `<div>` | use constraints; avoid absolute unless needed |
| `TEXT` | `<span>` / `<p>` / heading | font + color from the node |
| `VECTOR` / `LINE` / small icon frame | icon component or inline `<svg>` | match an icon-set name first |
| `INSTANCE` | an existing component | `mainComponent` + `componentProperties` |
| `COMPONENT` / `COMPONENT_SET` | the component definition itself | rare in a screen export |
| `RECTANGLE` / `ELLIPSE` with image fill | `<img>` / background | check `fills` for `IMAGE` |

## Auto-layout → flexbox

| Figma | CSS / Tailwind |
|-------|----------------|
| `layout.mode: "HORIZONTAL"` | `flex flex-row` |
| `layout.mode: "VERTICAL"` | `flex flex-col` |
| `itemSpacing: n` | `gap-[n]` (or scale step) |
| `padding: [t,r,b,l]` | `pt-/pr-/pb-/pl-` (or `p-`, `px-`, `py-`) |
| `primaryAxisAlignItems` `MIN`/`CENTER`/`MAX`/`SPACE_BETWEEN` | `justify-start`/`center`/`end`/`between` |
| `counterAxisAlignItems` `MIN`/`CENTER`/`MAX` | `items-start`/`center`/`end` |

The **primary axis** follows `mode` (horizontal = main axis is X). `justify-*`
controls the primary axis, `items-*` the counter axis — same as flexbox.

### Padding, gap, and the absence of "margin" — be exact

Figma auto-layout has **no per-child margin**. The space you see comes from:

- **parent `padding`** — per-side `[top, right, bottom, left]`, often asymmetric.
  Map each side on its own: `[0,16,0,0]` → `pr-4` only. Collapse to `px-/py-/p-`
  *only* when the sides are truly equal. The inspector prints `pad[T/R/B/L]=…`.
- **parent `itemSpacing`** → `gap-*`. `gap=0` is meaningful (siblings touch) —
  don't drop it or assume a framework default.
- a child of a **non-auto-layout** frame is placed by `x`/`y`; that offset is the
  effective margin (inspector: `@(x,y)←offset`) — reproduce with absolute
  positioning, an explicit margin, or a centering rule per intent.

Pick exact spacing utilities: a raw `itemSpacing: 6` is `gap-1.5` (6px) only if
the scale matches — otherwise `gap-[6px]`, or `gap-[var(--token)]` when bound.
Never substitute a "close" scale step for a precise px value.

### Per-corner radius and per-side stroke

`cornerRadius` can be `{topLeft, topRight, bottomRight, bottomLeft}` and
`strokeWeight` `{top, right, bottom, left}` — both independent. `0/0/15/15` radius
→ `rounded-b-[15px]`; a stroke with only `bottom:1` → `border-b`. Don't round the
whole box or border every side when the design specifies a subset.

## `layoutSizing` → width/height behaviour

| `layoutSizing.h` / `.v` | meaning | Tailwind |
|--------------------------|---------|----------|
| `HUG` | size to content | `w-fit` / `h-fit` (often the default; omit) |
| `FILL` | stretch to parent | `flex-1` / `w-full` / `self-stretch` |
| `FIXED` | explicit px | `w-[Npx]` / `h-[Npx]`, or a dimension token var |

Prefer not to pin a width when the node `HUG`s — let content size it. Pin only
`FIXED` nodes, and use the bound dimension **token** when one exists.

## Text nodes

- `fontName.family` / `fontWeight` / `fontSize` / `lineHeight` → font utilities.
  Prefer the app's font token (`font-sans`, `font-heading`) over the literal
  family name unless the design deliberately uses a different face.
- `lineHeight` `{unit:"PIXELS",value:20}` → `leading-[20px]`; `PERCENT` → `leading-[1.4]`.
- `letterSpacing`, `textCase` (`UPPER`→`uppercase`), `textDecoration`,
  `textAlignHorizontal` (`CENTER`→`text-center`).
- Color from `fills` (map the token); layer `opacity` → `/NN` alpha utility.

## Icons / vectors

1. If the layer name reveals the icon (`lucide/search`, `lucide/sun`, …) use that
   icon set's component (`<Search />`, `<Sun />` from `lucide-react`). Set its
   size from the frame (`size-5` for 20px) and color via `text-*` (icon stroke =
   `currentColor`). `Theme/icons-path-width` → the icon's `strokeWidth`.
2. Otherwise inline the `<svg>` from the `.svg` crop the inspector extracted, and
   wire its `stroke`/`fill` to the mapped color token (replace literal colors
   with `currentColor` where it should inherit).

## Effects → shadows & blur

| Figma effect | CSS / Tailwind |
|--------------|----------------|
| `DROP_SHADOW` | `box-shadow` / `shadow-*` (x, y, blur, spread, color) |
| `INNER_SHADOW` | `box-shadow: inset …` / `shadow-inner` |
| `LAYER_BLUR` | `filter: blur()` / `blur-*` |
| `BACKGROUND_BLUR` | `backdrop-filter: blur()` / `backdrop-blur-*` |

Multiple effects stack. The inspector prints each as `shadow(x=…,y=…,blur=…,
spread=…,color=…)`. Reproduce the exact offsets/blur, not a generic `shadow-md`.

## Fills beyond solid

| `fills[].type` | output |
|----------------|--------|
| `SOLID` | color (map the token) |
| `GRADIENT_LINEAR/RADIAL/ANGULAR` | CSS `linear-/radial-/conic-gradient` from `gradientStops` + angle/handles; **no single token** |
| `IMAGE` | `<img>` or `background-image` — the image bytes are **not** inline; export the asset (the node's PNG crop) and reference it; `imageHash` identifies it |

`fills` is an array (bottom→top); a node can layer several. Layer `opacity`,
fill `opacity`, and `blendMode` (`mix-blend-*`) are distinct — keep all three.

## Constraints → resize behaviour

`constraints {h,v}` says how the node reacts when its parent resizes — essential
for anything not in a hugging auto-layout:

| value | horizontal | vertical |
|-------|-----------|----------|
| `MIN` | pinned left | pinned top |
| `MAX` | pinned right (`ml-auto`/`right-0`) | pinned bottom |
| `CENTER` | centered | centered |
| `STRETCH` | full width (`inset-x-0`/`w-full`) | full height |
| `SCALE` | scales proportionally | scales proportionally |

## Flex-child modifiers

| Figma | CSS / Tailwind |
|-------|----------------|
| `layoutGrow: 1` | `flex-1` / `grow` |
| `layoutAlign: STRETCH` | `self-stretch` |
| `layoutPositioning: ABSOLUTE` | `absolute` (ignores parent flow) |
| `layoutWrap: WRAP` | `flex-wrap` |

## Component instances

- `mainComponent` is the master component name — **search the repo for it first**
  and reuse the real component.
- `componentProperties` carries the instance's state. A `type:"VARIANT"` entry
  (e.g. `{ "sidebar": { "value": "open" } }`, `{ "Type": { "value":
  "link_component" } }`) maps to the component's variant prop. Pass these through;
  don't hardcode the rendered appearance of the variant.
- Nested instances inside a component (e.g. macOS traffic lights) usually already
  exist as one app component — don't rebuild their internals.
