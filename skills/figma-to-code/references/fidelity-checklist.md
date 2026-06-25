# Fidelity checklist — the details design-to-code silently drops

Walk this list before declaring a conversion done. Each item is something the
payload carries (or implies) that is routinely lost. The inspector surfaces most
of them; the rest are judgment.

## Visual properties

- [ ] **Shadows & blur** (`effects[]`) — `DROP_SHADOW`/`INNER_SHADOW` →
  `shadow-*` / `box-shadow` (x, y, blur, spread, color); `LAYER_BLUR` →
  `blur-*`; `BACKGROUND_BLUR` → `backdrop-blur-*`. Inspector prints `shadow(...)`.
- [ ] **Non-solid fills** — `GRADIENT_*` → CSS gradient (no token; reproduce the
  stops/angle); `IMAGE` → real `<img>`/background, needs the **asset exported
  separately** (the per-node PNG crop can serve as that asset). Inspector flags
  these `⚠`.
- [ ] **Layer opacity** (node `opacity`, distinct from fill opacity) → `opacity-*`.
- [ ] **Blend mode** (`blendMode != NORMAL`) → `mix-blend-*` / `bg-blend-*`.
- [ ] **Hidden layers** (`visible:false`) — do **not** render; inspector marks
  `[HIDDEN]`. They are often alternate states — note them as states to wire later.
- [ ] **Clipping** (`clipsContent:true`) → `overflow-hidden`.
- [ ] **Rotation** (`rotation`) → `rotate-*`.
- [ ] **Stroke alignment / box model** — Figma strokes can sit outside the bounds
  while CSS `border` is inside the box; expect ±1–2px and use `box-sizing`/inset
  shadows if a pixel-exact border matters.

## Typography (beyond size/weight)

- [ ] **letterSpacing** → `tracking-*`. **textCase** `UPPER`→`uppercase`,
  `TITLE`→`capitalize`. **textDecoration** → `underline`/`line-through`.
  **textAlignHorizontal** → `text-center`/`text-right`. Inspector prints these.
- [ ] **Line clamping / truncation** — if the design shows an ellipsis or a fixed
  height with overflow, add `truncate` / `line-clamp-N`.
- [ ] **Font substitution** — design font (e.g. `Lato`) vs the app's font token
  (`Geist`): prefer the app token and **flag the swap**; don't silently ship Lato.

## Layout & responsiveness

- [ ] **Constraints** (`constraints {h,v}`: `MIN`/`MAX`/`CENTER`/`STRETCH`/`SCALE`)
  describe resize behaviour — `STRETCH`→ full width/`inset-x-0`, `CENTER`→ centered,
  `MAX`→ pinned right/bottom. Don't assume static.
- [ ] **Flex child behaviour** — `layoutGrow:1`→`flex-1`/`grow`; `layoutAlign:
  STRETCH`→`self-stretch`; `layoutPositioning:ABSOLUTE`→`absolute` inside a flex
  parent; `layoutWrap:WRAP`→`flex-wrap`.
- [ ] **Don't hardcode the artboard width** (e.g. 1440). Use the layout's
  hug/fill/constraints to make it fluid unless the target is a fixed-size surface
  (e.g. a desktop window). If unsure about breakpoints, ask.

## Semantics & accessibility (almost always forgotten)

- [ ] **Semantic elements** — an icon that triggers something is a `<button>`,
  not a `<div>`; nav is `<nav>`; a list is `<ul>`. Don't ship a div soup.
- [ ] **Accessible names** — icon-only buttons need `aria-label`; images need
  `alt`; decorative icons get `aria-hidden`.
- [ ] **Focus & keyboard** — interactive elements must be focusable and operable
  by keyboard, with a visible focus ring (`focus-visible:*`).
- [ ] **Contrast** — keep the token colors; if a one-off color fails contrast, flag it.

## Interactive states (a static export shows ONE state)

- [ ] **hover / focus / active / disabled** — the export is a single frozen
  state. Implement the obvious states (buttons, tabs, inputs) using the app's
  conventions, even though they aren't in the payload. Hidden sibling layers and
  component **variants** (`componentProperties`) hint at the other states.
- [ ] **Selected vs unselected** — e.g. an active tab styled differently from an
  inactive one (note `text-primary` vs `text-tertiary` in the topbar tabs) is a
  **state**, not two separate elements — model it with a prop/`data-state`.

## Component & pattern recognition

- [ ] **Recognize the UI pattern, not just the boxes** — "List / Kanban" side by
  side = a **Tabs / segmented control**; a sun/moon icon = a **theme toggle**; an
  icon in a hit-area = an **icon button**; "Breadcrumb" = breadcrumb nav. Reach
  for the app's existing primitive (shadcn `Tabs`, `Button`, `Tooltip`, …) before
  hand-rolling.
- [ ] **Reuse over rebuild** — every `INSTANCE` should map to an existing
  component (`mainComponent`); pass `componentProperties` through. `BOOLEAN`
  props → conditional render; `TEXT` props → label/children; `INSTANCE_SWAP` →
  slot/children; `VARIANT` → variant prop.
- [ ] **Ignore noise names** — `Frame 45`, `Placeholder` are auto-generated;
  derive semantics from role + meaningful names (`lucide/search`, `Breadcrumb`).

## Tokens & theming

- [ ] Every value with a `variable` is mapped to an app token (see
  `token-mapping.md`); leftover hex/px is flagged.
- [ ] **`tw/*`-prefixed collections** (e.g. `tw/gap/gap-1,5`) encode Tailwind
  steps directly → use the matching utility (`gap-1.5`).
- [ ] Light vs dark bound correctly; don't pin a mode unless the design does.

## Verify

- [ ] Rendered output compared to the exported PNG (structure, spacing, color, text).
- [ ] Spacing re-checked value-by-value against the inspector (see SKILL step 6).
- [ ] States and a11y manually exercised (tab to it, hover it).
