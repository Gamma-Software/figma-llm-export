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

async function simplifyPaints(paints: unknown, node: BaseNode): Promise<unknown> {
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
        base.color = cb && cb.id ? { value: hex, variable: bindLabel(await resolveVar(cb.id, node)) } : hex;
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

interface ResolvedVar {
  id: string;
  name: string | null;
  collection: string | null;
}

// Resolve a variable id to its name + collection. The concrete value is read
// straight from the node's property (already mode-resolved), so we don't need
// resolveForConsumer here.
async function resolveVar(id: string, _node: BaseNode): Promise<ResolvedVar> {
  let v: Variable | null = null;
  try {
    v = await figma.variables.getVariableByIdAsync(id);
  } catch {
    v = null;
  }
  if (!v) return { id, name: null, collection: null };
  const collection = await resolveCollectionName(v.variableCollectionId);
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
      out[field] = bindLabel(await resolveVar(val.id, node));
    }
  }
  return out;
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
          fills: await simplifyPaints(s.fills, node),
        }))
      );
    }
  }

  // Paint (per-paint color bindings are inlined inside simplifyPaints)
  if ("fills" in node) {
    const fills = await simplifyPaints((node as GeometryMixin).fills, node);
    if (fills) out.fills = fills;
  }
  if ("strokes" in node && Array.isArray((node as GeometryMixin).strokes) && (node as GeometryMixin).strokes.length) {
    out.strokes = await simplifyPaints((node as GeometryMixin).strokes, node);
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
