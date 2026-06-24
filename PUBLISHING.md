# Publishing to the Figma Community

Figma plugins are published **from the Figma desktop app** (not the CLI). Steps:

## 1. Build

```bash
npm install
npm run build      # produces code.js (gitignored — must exist locally to publish)
```

## 2. Load the plugin locally

Figma desktop → **Plugins → Development → Import plugin from manifest…** → pick
`manifest.json`. Run it once (**Plugins → Development → LLM Export**) and smoke-test.

## 3. Prepare the assets (in `assets/`)

| Asset | Spec | File |
|-------|------|------|
| Plugin icon | 128×128 PNG | `assets/icon-128.png` ✅ |
| Cover art | 1920×960 PNG | `assets/cover.png` ✅ |
| Listing copy | name / tagline / description / tags | `assets/LISTING.md` ✅ |
| Screenshots | optional, 1+ | capture the plugin running on a real file |

Icons/cover are generated from `assets/icon.svg` + `assets/cover.svg` — edit the
SVGs and re-export if you want to tweak. (To re-render the PNGs:
`npx sharp-cli` or open the SVG in Figma and export.)

## 4. Publish

1. Figma desktop → **Plugins → Manage plugins** (or right-click the plugin →
   **Publish new release**).
2. Fill in from `assets/LISTING.md`: name, tagline, description, tags.
3. Upload `icon-128.png`, `cover.png`, and any screenshots.
4. Set a **support contact** (required — email or the repo issues URL).
5. Choose visibility (free / public) and **Submit for review**.

## 5. Review

Figma reviews new plugins (typically a few days). On approval it goes live on
the Community and anyone can install it in one click.

## Notes / gotchas

- The manifest `id` (`myra-llm-export`) is a dev placeholder; Figma assigns the
  real plugin id on first publish — don't worry about it.
- `networkAccess` is currently `"none"` → fast, low-friction review.
  **If you later add "send to an agent"** (a network call), you must whitelist
  the domain in `manifest.json` and the plugin needs **another review**.
- Updates = bump, rebuild, **Publish new release** again (also reviewed).
- Check the **name is free** on the Community before committing to it.
