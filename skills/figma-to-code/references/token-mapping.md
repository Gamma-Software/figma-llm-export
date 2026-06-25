# Turning Figma variables into app tokens

The payload tells you the **token name** behind every value. Translate that name
into the target app's design system. Hardcoded hex/px is a bug, not a shortcut.

## Step 1 — discover the app's token system

```bash
# shadcn / tweakcn / vanilla CSS custom properties:
grep -rnE "^\s*--[a-z0-9-]+:" $(git ls-files '*globals.css' '*theme.css' '*.css' | head)
# Tailwind v4 inline theme or v3 config:
grep -rn "@theme" $(git ls-files '*.css') ; cat tailwind.config.* 2>/dev/null
# Design-token JSON / Style Dictionary:
git ls-files '*tokens*.json' '*design-tokens*'
```

You're looking for the names the Figma collection uses. A design built against
the app's own tokens maps **almost 1:1** — the collection name (`Theme`,
`App Tokens`, …) is noise; the leaf name is the key (`background`, `text-primary`,
`sidebar-border`, `radius/card-radius`).

## Step 2 — map by kind

| Figma binding kind | resolves to | Tailwind / CSS form |
|--------------------|-------------|---------------------|
| fill color `Theme/background` | `--background` | `bg-background` |
| text color `Theme/text-primary` | `--text-primary` | `text-text-primary` |
| stroke color `Theme/sidebar-border` | `--sidebar-border` | `border border-sidebar-border` |
| radius `Theme/radius/card-radius` | `--card-radius` | `rounded-[var(--card-radius)]` or a mapped `rounded-*` |
| spacing/gap `tw/gap/gap-1,5` | a spacing scale step | `gap-1.5` / `gap-[6px]` |
| dimension `Theme/sidebar-width` (280) | `--app-sidebar-width` | `w-[var(--app-sidebar-width)]` |
| dimension `Theme/mac-top-height` (42) | `--mac-top-height` | `h-[var(--mac-top-height)]` |
| stroke weight (1, per side) | — | `border-b`, `border-r`, … |

Rules:
- **Colors** → the matching shadcn role utility (`bg-`/`text-`/`border-`/`ring-`).
  If the Figma name isn't a shadcn role (e.g. `icon-primary`, `card-background`),
  it's almost certainly a **custom token already defined** in the app's CSS —
  grep for `--<name>` and use `text-icon-primary` / `bg-card-background` (Tailwind
  v4 picks up `--color-<name>` mappings automatically in `@theme inline`).
- **Radius / spacing / size tokens** → if a utility class maps the var, use it;
  otherwise an arbitrary value pointing at the var:
  `rounded-[var(--window-radius)]`. Prefer the var over the literal number so it
  tracks the source of truth.
- **Alpha**: a fill `opacity` (e.g. `@0.94`) on a color is the layer opacity, not
  the token — apply it as `text-text-primary/94` or an opacity utility, and note
  it; the token itself may already encode alpha (e.g. `#e4e4e4f0`).

## Step 3 — light vs dark mode

`variables[].valuesByMode` has one entry per mode, and
`variableCollections[].variables[].resolvedValuesByMode` gives `{r,g,b,a}` per
mode. Decide which mode the export represents by comparing the **resolved fill**
of the root frame to the app's `:root` (light) vs `.dark` block. Bind the token,
not the mode-specific value — the app's theme switch then handles both. Only when
a value is mode-pinned in the design should you hardcode a mode.

## Step 4 — no matching token

If a `variable` has no counterpart in the app (or a value is unbound entirely):
1. Use an arbitrary value (`bg-[#181818]`, `gap-[3px]`).
2. **Flag it** to the user as a candidate new token, with the Figma name and value.
Don't silently invent a token name; don't bury a magic number.

---

## Worked example — the Myra Agents app (shadcn + tweakcn, dark)

The Figma `Theme` collection mirrors `src/app/globals.css`. This export was the
**dark** variant (root fill `#141414` = `.dark --background`). Verified mapping:

| Figma variable | app CSS var | class |
|---|---|---|
| `Theme/background` | `--background` | `bg-background` |
| `Theme/text-primary` | `--text-primary` | `text-text-primary` |
| `Theme/text-tertiary` | `--text-tertiary` | `text-text-tertiary` |
| `Theme/icon-primary` | `--icon-primary` | `text-icon-primary` (icon stroke = `currentColor`) |
| `Theme/sidebar-border` | `--sidebar-border` | `border-sidebar-border` |
| `Theme/sidebar-width` (280) | `--app-sidebar-width` (280px) | `w-[var(--app-sidebar-width)]` |
| `Theme/mac-top-height` (42) | `--mac-top-height` (42px) | `h-[var(--mac-top-height)]` |
| `Theme/radius/mac-app-window-radius` (15) | `--window-radius` (15px) | `rounded-t-[var(--window-radius)]` |
| `App Tokens/border` (#27272a) | (not a Theme token) | arbitrary `border-[#27272a]` → flag |

Note `App Tokens/border` comes from a *different* collection than the app's
`--border` and didn't match — exactly the kind of value to surface to the user.
