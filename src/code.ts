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

function simplifyPaints(paints: unknown): unknown {
  if (isMixed(paints) || !Array.isArray(paints)) return undefined;
  return paints.map((p: Paint) => {
    const base: Record<string, unknown> = { type: p.type, visible: p.visible !== false };
    if (p.opacity !== undefined && p.opacity !== 1) base.opacity = round(p.opacity);
    if (p.type === "SOLID") {
      const { r, g, b } = (p as SolidPaint).color;
      base.color = rgbToHex(r, g, b);
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
  });
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Collection name per id, deduped across the whole selection.
const collectionNameCache = new Map<string, string | null>();
async function resolveCollectionName(id: string): Promise<string | null> {
  const hit = collectionNameCache.get(id);
  if (hit !== undefined) return hit;
  let name: string | null = null;
  try {
    const col = await figma.variables.getVariableCollectionByIdAsync(id);
    name = col ? col.name : null;
  } catch {
    name = null;
  }
  collectionNameCache.set(id, name);
  return name;
}

function colorToHex(c: RGBA): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  let s = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  if (typeof c.a === "number" && c.a < 1) s += h(c.a); // 8-digit when translucent
  return s;
}

function simplifyVarValue(val: VariableValue): unknown {
  if (val && typeof val === "object") {
    if ("r" in val && "g" in val && "b" in val) return colorToHex(val as RGBA);
    if ((val as VariableAlias).type === "VARIABLE_ALIAS") return { aliasOf: (val as VariableAlias).id };
  }
  return val;
}

interface ResolvedVar {
  id: string;
  name: string | null;
  collection: string | null;
  value?: unknown;
}

async function resolveVar(id: string, node: BaseNode): Promise<ResolvedVar> {
  let v: Variable | null = null;
  try {
    v = await figma.variables.getVariableByIdAsync(id);
  } catch {
    v = null;
  }
  if (!v) return { id, name: null, collection: null };
  const collection = await resolveCollectionName(v.variableCollectionId);
  let value: unknown;
  try {
    // Resolve through the node's own mode (and any alias chain) to a concrete value.
    value = simplifyVarValue(v.resolveForConsumer(node as SceneNode).value);
  } catch {
    /* value stays undefined */
  }
  return { id, name: v.name, collection, value };
}

// Surface bound variables (e.g. cornerRadius -> { name: "radius/md",
// collection: "Primitives", value: 8 }) so a bound property is distinguishable
// from a hardcoded one, with enough context to act on.
async function serializeBoundVariables(
  node: BaseNode
): Promise<Record<string, unknown> | undefined> {
  const bv = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables;
  if (!bv) return undefined;
  const one = (a: { id: string }) => resolveVar(a.id, node);
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(bv)) {
    const val = bv[field] as { id: string } | { id: string }[];
    if (Array.isArray(val)) out[field] = await Promise.all(val.filter((a) => a && a.id).map(one));
    else if (val && val.id) out[field] = await one(val);
  }
  return Object.keys(out).length ? out : undefined;
}

async function serialize(node: BaseNode, depth: number): Promise<SerializedNode> {
  const out: SerializedNode = { id: node.id, name: node.name, type: node.type };
  const n = node as unknown as Record<string, unknown>;

  if ("visible" in node && (node as SceneNode).visible === false) out.visible = false;
  if ("width" in node) {
    out.width = round((node as LayoutMixin).width);
    out.height = round((node as LayoutMixin).height);
  }
  if ("x" in node) {
    out.x = round((node as LayoutMixin).x);
    out.y = round((node as LayoutMixin).y);
  }
  if ("rotation" in node && (node as LayoutMixin).rotation) {
    out.rotation = round((node as LayoutMixin).rotation);
  }
  if ("opacity" in node && (node as BlendMixin & { opacity: number }).opacity !== 1) {
    out.opacity = round((node as unknown as { opacity: number }).opacity);
  }
  if ("cornerRadius" in node) {
    if (!isMixed(n.cornerRadius)) {
      if ((n.cornerRadius as number) > 0) out.cornerRadius = n.cornerRadius;
    } else {
      // Mixed corners: figma.mixed isn't serializable, so expand the per-corner
      // radii (each is a plain number) instead of dropping the field.
      out.cornerRadius = {
        topLeft: n.topLeftRadius,
        topRight: n.topRightRadius,
        bottomRight: n.bottomRightRadius,
        bottomLeft: n.bottomLeftRadius,
      };
    }
  }

  // Text
  if (node.type === "TEXT") {
    const t = node as TextNode;
    out.characters = t.characters;
    if (!isMixed(t.fontSize)) out.fontSize = t.fontSize;
    if (!isMixed(t.fontName)) out.fontName = t.fontName;
    out.textAlignHorizontal = t.textAlignHorizontal;
  }

  // Paint
  if ("fills" in node) {
    const fills = simplifyPaints((node as GeometryMixin).fills);
    if (fills) out.fills = fills;
  }
  if ("strokes" in node && Array.isArray((node as GeometryMixin).strokes) && (node as GeometryMixin).strokes.length) {
    out.strokes = simplifyPaints((node as GeometryMixin).strokes);
    if (!isMixed(n.strokeWeight)) out.strokeWeight = n.strokeWeight;
  }

  // Auto-layout
  if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
    const f = node as FrameNode;
    out.layout = {
      mode: f.layoutMode,
      itemSpacing: f.itemSpacing,
      padding: [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft],
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

  // Bound variables (cornerRadius, padding, fills, strokeWeight, …)
  const bound = await serializeBoundVariables(node);
  if (bound) out.boundVariables = bound;

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

  const nodes = await Promise.all(selection.map((s) => serialize(s, 0)));

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
      truncated: images.length >= MAX_EXPORTS,
    },
    nodes,
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
