/// <reference types="@figma/plugin-typings" />

// Myra LLM Export — Figma plugin (sandbox / main thread)
// Reads the current selection, serializes each node to compact JSON, renders a
// PNG of every selected node, and ships both to the UI as an LLM-ready bundle.
// No network here — the UI does the exporting. To send to an agent later, add a
// `send` message handler that POSTs the payload (and whitelist the domain in
// manifest.json's networkAccess).

const MAX_DEPTH = 12;
const PNG_SCALE = 2;
// Skip recursing into instances' subtrees — they explode payload size and the
// agent rarely needs the internal structure of a component instance.
const NO_RECURSE: ReadonlyArray<string> = ["INSTANCE"];

// Per-element PNG export tuning.
// Child elements smaller than this (either dimension, px) are not cropped on
// their own — avoids a flood of useless text/icon slivers. The nodes the user
// explicitly selected are always exported regardless of size.
const MIN_EXPORT_DIM = 24;
// Types never worth a standalone crop (rendered fine inside their parent).
const SKIP_EXPORT_TYPES: ReadonlyArray<string> = ["TEXT", "VECTOR", "LINE", "SLICE"];
// Don't crop into these subtrees — treat them as one atomic block.
const NO_RECURSE_EXPORT: ReadonlyArray<string> = ["INSTANCE"];
// Hard cap on number of cropped PNGs per run (payload + speed guard).
const MAX_EXPORTS = 80;

const round = (n: number): number => Math.round(n * 100) / 100;
const isMixed = (v: unknown): boolean => typeof v === "symbol";

interface SerializedNode {
  id: string;
  name: string;
  type: string;
  [key: string]: unknown;
  children?: SerializedNode[];
}

async function simplifyPaints(paints: unknown): Promise<unknown> {
  if (isMixed(paints) || !Array.isArray(paints)) return undefined;
  return Promise.all(
    (paints as Paint[]).map(async (p) => {
      const base: Record<string, unknown> = { type: p.type, visible: p.visible !== false };
      if (p.opacity !== undefined && p.opacity !== 1) base.opacity = round(p.opacity);
      if (p.type === "SOLID") {
        const { r, g, b } = (p as SolidPaint).color;
        const hex = rgbToHex(r, g, b);
        const cb = (p as SolidPaint).boundVariables?.color;
        // Inline the bound variable on the color itself: { value, variable }.
        base.color = cb && cb.id ? { value: hex, variable: bindLabel(await resolveVar(cb.id)) } : hex;
      } else if (p.type.startsWith("GRADIENT")) {
        base.stops = (p as GradientPaint).gradientStops.map((s) => ({
          position: round(s.position),
          color: rgbToHex(s.color.r, s.color.g, s.color.b),
          opacity: round(s.color.a),
        }));
      } else if (p.type === "IMAGE") {
        base.imageHash = (p as ImagePaint).imageHash;
        base.scaleMode = (p as ImagePaint).scaleMode;
      }
      return base;
    })
  );
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbaToHex(c: RGBA): string {
  let s = rgbToHex(c.r, c.g, c.b);
  if (typeof c.a === "number" && c.a < 1) {
    s += Math.round(c.a * 255).toString(16).padStart(2, "0"); // 8-digit when translucent
  }
  return s;
}

// Variable ids referenced by the current selection — seeds the variables export.
const usedVarIds = new Set<string>();

// Collection info (name + modeId->name) per id, deduped across the selection.
interface CollectionInfo {
  name: string | null;
  modes: Record<string, string>;
}
const collectionCache = new Map<string, CollectionInfo>();
async function resolveCollection(id: string): Promise<CollectionInfo> {
  const hit = collectionCache.get(id);
  if (hit) return hit;
  let info: CollectionInfo = { name: null, modes: {} };
  try {
    const col = await figma.variables.getVariableCollectionByIdAsync(id);
    if (col) {
      const modes: Record<string, string> = {};
      for (const m of col.modes) modes[m.modeId] = m.name;
      info = { name: col.name, modes };
    }
  } catch {
    /* keep empty */
  }
  collectionCache.set(id, info);
  return info;
}

interface ResolvedVar {
  id: string;
  name: string | null;
  collection: string | null;
}

// Resolve a variable id to its name + collection, and record it as referenced.
// The concrete value is read straight from the node's property (already
// mode-resolved), so resolveForConsumer isn't needed here.
async function resolveVar(id: string): Promise<ResolvedVar> {
  usedVarIds.add(id);
  let v: Variable | null = null;
  try {
    v = await figma.variables.getVariableByIdAsync(id);
  } catch {
    v = null;
  }
  if (!v) return { id, name: null, collection: null };
  const collection = (await resolveCollection(v.variableCollectionId)).name;
  return { id, name: v.name, collection };
}

// "Collection/name" label for a resolved variable (name alone if no collection).
function bindLabel(r: ResolvedVar): string {
  const name = r.name ?? r.id;
  return r.collection ? `${r.collection}/${name}` : name;
}

// Resolve a node's scalar (non-array) variable bindings to labels keyed by the
// bound field — e.g. { topLeftRadius: "Theme/radius/card-radius" }. Array-valued
// bindings (fills/strokes) are handled per-paint in simplifyPaints instead.
async function nodeBindingLabels(node: BaseNode): Promise<Record<string, string>> {
  const bv = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables;
  if (!bv) return {};
  const out: Record<string, string> = {};
  for (const field of Object.keys(bv)) {
    const val = bv[field] as { id?: string };
    if (val && !Array.isArray(val) && val.id) {
      out[field] = bindLabel(await resolveVar(val.id));
    }
  }
  return out;
}

// Full definition of a referenced variable, with per-mode values.
interface VariableDef {
  id: string;
  name: string;
  type: string;
  collection: string | null;
  valuesByMode: Record<string, unknown>;
}

// Turn a raw stored variable value into something serializable: colors -> hex,
// aliases -> { alias: "Collection/name" } (and the target gets queued so it's
// exported too). Booleans/numbers/strings pass through.
async function tokenValue(raw: VariableValue, queue: string[]): Promise<unknown> {
  if (raw && typeof raw === "object") {
    if ("r" in raw && "g" in raw && "b" in raw) return rgbaToHex(raw as RGBA);
    if ((raw as VariableAlias).type === "VARIABLE_ALIAS") {
      const targetId = (raw as VariableAlias).id;
      queue.push(targetId);
      return { alias: bindLabel(await resolveVar(targetId)) };
    }
  }
  return raw;
}

// Build the definitions for every referenced variable, following alias chains
// so the export is self-contained. Mode ids are resolved to mode names.
async function buildVariableDefs(seedIds: Set<string>): Promise<VariableDef[]> {
  const defs: VariableDef[] = [];
  const seen = new Set<string>();
  const queue = Array.from(seedIds);
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    let v: Variable | null = null;
    try {
      v = await figma.variables.getVariableByIdAsync(id);
    } catch {
      v = null;
    }
    if (!v) continue;
    const col = await resolveCollection(v.variableCollectionId);
    const valuesByMode: Record<string, unknown> = {};
    for (const modeId of Object.keys(v.valuesByMode)) {
      const modeName = col.modes[modeId] || modeId;
      valuesByMode[modeName] = await tokenValue(v.valuesByMode[modeId], queue);
    }
    defs.push({ id, name: v.name, type: v.resolvedType, collection: col.name, valuesByMode });
  }
  // Stable order: by collection then name.
  defs.sort((a, b) => (a.collection || "").localeCompare(b.collection || "") || a.name.localeCompare(b.name));
  return defs;
}

async function serialize(node: BaseNode, depth: number): Promise<SerializedNode> {
  const out: SerializedNode = { id: node.id, name: node.name, type: node.type };
  const n = node as unknown as Record<string, unknown>;

  // Variable bindings inlined into each value: a bound property becomes
  // { value, variable: "Collection/name" }; unbound stays a plain value.
  const vb = await nodeBindingLabels(node);
  const bind = (value: unknown, field: string): unknown =>
    vb[field] ? { value, variable: vb[field] } : value;

  if ("visible" in node && (node as SceneNode).visible === false) out.visible = false;
  if ("width" in node) {
    out.width = bind(round((node as LayoutMixin).width), "width");
    out.height = bind(round((node as LayoutMixin).height), "height");
  }
  if ("x" in node) {
    out.x = round((node as LayoutMixin).x);
    out.y = round((node as LayoutMixin).y);
  }
  if ("rotation" in node && (node as LayoutMixin).rotation) {
    out.rotation = round((node as LayoutMixin).rotation);
  }
  if ("opacity" in node && (node as BlendMixin & { opacity: number }).opacity !== 1) {
    out.opacity = bind(round((node as unknown as { opacity: number }).opacity), "opacity");
  }
  if ("cornerRadius" in node) {
    if (!isMixed(n.cornerRadius)) {
      if ((n.cornerRadius as number) > 0 || vb.cornerRadius) {
        out.cornerRadius = bind(n.cornerRadius, "cornerRadius");
      }
    } else {
      // Mixed corners: figma.mixed isn't serializable, so expand the per-corner
      // radii — each wrapped with its own binding when bound.
      out.cornerRadius = {
        topLeft: bind(n.topLeftRadius, "topLeftRadius"),
        topRight: bind(n.topRightRadius, "topRightRadius"),
        bottomRight: bind(n.bottomRightRadius, "bottomRightRadius"),
        bottomLeft: bind(n.bottomLeftRadius, "bottomLeftRadius"),
      };
    }
  }

  // Text
  if (node.type === "TEXT") {
    const t = node as TextNode;
    out.characters = t.characters;
    out.textAlignHorizontal = t.textAlignHorizontal;
    if (!isMixed(t.fontSize)) out.fontSize = bind(t.fontSize, "fontSize");
    if (!isMixed(t.fontName)) out.fontName = t.fontName;
    // Per-range styling: when any of these is mixed across the string, a single
    // value would be lost — capture the styled segments instead of dropping it.
    if (isMixed(t.fontSize) || isMixed(t.fontName) || isMixed(t.fills as unknown)) {
      const fields: ("fontSize" | "fontName" | "fills")[] = ["fontSize", "fontName", "fills"];
      out.segments = await Promise.all(
        t.getStyledTextSegments(fields).map(async (s) => ({
          text: s.characters,
          start: s.start,
          end: s.end,
          fontSize: s.fontSize,
          fontName: s.fontName,
          fills: await simplifyPaints(s.fills),
        }))
      );
    }
  }

  // Paint (per-paint color bindings are inlined inside simplifyPaints)
  if ("fills" in node) {
    const fills = await simplifyPaints((node as GeometryMixin).fills);
    if (fills) out.fills = fills;
  }
  if ("strokes" in node && Array.isArray((node as GeometryMixin).strokes) && (node as GeometryMixin).strokes.length) {
    out.strokes = await simplifyPaints((node as GeometryMixin).strokes);
    if (!isMixed(n.strokeWeight)) {
      out.strokeWeight = bind(n.strokeWeight, "strokeWeight");
    } else if ("strokeTopWeight" in node) {
      // Mixed per-side weights — expand, each wrapped with its own binding.
      out.strokeWeight = {
        top: bind(n.strokeTopWeight, "strokeTopWeight"),
        right: bind(n.strokeRightWeight, "strokeRightWeight"),
        bottom: bind(n.strokeBottomWeight, "strokeBottomWeight"),
        left: bind(n.strokeLeftWeight, "strokeLeftWeight"),
      };
    }
  }

  // Auto-layout
  if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
    const f = node as FrameNode;
    out.layout = {
      mode: f.layoutMode,
      itemSpacing: bind(f.itemSpacing, "itemSpacing"),
      padding: [
        bind(f.paddingTop, "paddingTop"),
        bind(f.paddingRight, "paddingRight"),
        bind(f.paddingBottom, "paddingBottom"),
        bind(f.paddingLeft, "paddingLeft"),
      ],
      primaryAxisAlignItems: f.primaryAxisAlignItems,
      counterAxisAlignItems: f.counterAxisAlignItems,
    };
  }

  // Component instance properties
  if (node.type === "INSTANCE") {
    try {
      out.componentProperties = (node as InstanceNode).componentProperties;
    } catch {
      /* ignore */
    }
  }

  // Children
  if ("children" in node && depth < MAX_DEPTH && NO_RECURSE.indexOf(node.type) === -1) {
    const kids = (node as ChildrenMixin).children;
    if (kids.length) out.children = await Promise.all(kids.map((c) => serialize(c, depth + 1)));
  }

  return out;
}

interface ExportedImage {
  id: string;
  name: string;
  type: string;
  scale: number;
  bytes: Uint8Array;
}

async function exportPng(node: SceneNode): Promise<ExportedImage | null> {
  if (typeof (node as ExportMixin).exportAsync !== "function") return null;
  try {
    const bytes = await (node as ExportMixin).exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: PNG_SCALE },
    });
    return { id: node.id, name: node.name, type: node.type, scale: PNG_SCALE, bytes };
  } catch (e) {
    console.warn("PNG export failed for", node.name, e);
    return null;
  }
}

// Worth its own cropped PNG? Text/vectors and elements below `minDim` are not —
// they render fine inside their parent's crop and would just be noise.
function worthCropping(node: SceneNode, minDim: number): boolean {
  if (node.visible === false) return false;
  if (SKIP_EXPORT_TYPES.indexOf(node.type) !== -1) return false;
  const w = (node as LayoutMixin).width;
  const h = (node as LayoutMixin).height;
  return w >= minDim && h >= minDim;
}

// Recursively crop a PNG for each meaningful element. `isRoot` nodes (what the
// user explicitly selected) are always exported, even text/small ones.
async function collectExports(
  node: SceneNode,
  images: ExportedImage[],
  depth: number,
  isRoot: boolean,
  minDim: number
): Promise<void> {
  if (images.length >= MAX_EXPORTS) return;

  if (isRoot || worthCropping(node, minDim)) {
    const img = await exportPng(node);
    if (img) images.push(img);
  }

  if (
    "children" in node &&
    depth < MAX_DEPTH &&
    NO_RECURSE_EXPORT.indexOf(node.type) === -1
  ) {
    for (const child of (node as ChildrenMixin).children as SceneNode[]) {
      if (images.length >= MAX_EXPORTS) break;
      await collectExports(child, images, depth + 1, false, minDim);
    }
  }
}

async function run(withImages: boolean, minDim: number): Promise<void> {
  const selection = figma.currentPage.selection;
  if (!selection.length) {
    figma.ui.postMessage({ type: "empty" });
    return;
  }

  figma.ui.postMessage({ type: "working", count: selection.length });

  usedVarIds.clear(); // referenced ids accumulate during this serialize pass
  const nodes = await Promise.all(selection.map((s) => serialize(s, 0)));
  // Every variable touched by the selection (+ alias targets), fully defined.
  const variables = await buildVariableDefs(usedVarIds);

  const images: ExportedImage[] = [];
  if (withImages) {
    for (const s of selection) {
      if (images.length >= MAX_EXPORTS) break;
      await collectExports(s, images, 0, true, minDim);
    }
  }

  figma.ui.postMessage({
    type: "data",
    meta: {
      file: figma.root.name,
      page: figma.currentPage.name,
      selectionCount: selection.length,
      imageCount: images.length,
      variableCount: variables.length,
      truncated: images.length >= MAX_EXPORTS,
    },
    nodes,
    variables,
    images,
  });
}

const STORAGE_MIN_DIM = "minExportDim";
let minExportDim = MIN_EXPORT_DIM; // live value, persisted across reloads

figma.showUI(__html__, { width: 440, height: 720, themeColors: true });

figma.ui.onmessage = async (msg: { type: string; minDim?: number; text?: string }) => {
  if (msg.type === "rerun") {
    if (typeof msg.minDim === "number" && msg.minDim >= 0) {
      minExportDim = Math.floor(msg.minDim);
      await figma.clientStorage.setAsync(STORAGE_MIN_DIM, minExportDim);
    }
    void run(true, minExportDim);
  } else if (msg.type === "close") {
    figma.closePlugin();
  } else if (msg.type === "notify" && msg.text) {
    figma.notify(msg.text);
  }
};

// Live count hint as selection changes; full bundle only on demand (PNG export
// is too heavy to run on every marquee drag).
figma.on("selectionchange", () => {
  figma.ui.postMessage({ type: "hint", count: figma.currentPage.selection.length });
});

// Restore the saved threshold, tell the UI, then do the first export.
(async () => {
  const stored = await figma.clientStorage.getAsync(STORAGE_MIN_DIM);
  if (typeof stored === "number" && stored >= 0) minExportDim = stored;
  figma.ui.postMessage({ type: "settings", minDim: minExportDim });
  void run(true, minExportDim);
})();
