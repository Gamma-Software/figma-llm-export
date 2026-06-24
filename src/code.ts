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

// id -> variable name, deduped across the whole selection.
const varNameCache = new Map<string, string | null>();
async function resolveVarName(id: string): Promise<string | null> {
  const hit = varNameCache.get(id);
  if (hit !== undefined) return hit;
  let name: string | null = null;
  try {
    const v = await figma.variables.getVariableByIdAsync(id);
    name = v ? v.name : null;
  } catch {
    name = null;
  }
  varNameCache.set(id, name);
  return name;
}

// Surface bound variables (e.g. cornerRadius -> "radius/md") next to their
// resolved values, so a bound property is distinguishable from a hardcoded one.
async function serializeBoundVariables(
  node: BaseNode
): Promise<Record<string, unknown> | undefined> {
  const bv = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables;
  if (!bv) return undefined;
  const alias = async (a: { id: string }) => ({ id: a.id, name: await resolveVarName(a.id) });
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(bv)) {
    const val = bv[field] as { id: string } | { id: string }[];
    if (Array.isArray(val)) out[field] = await Promise.all(val.filter((a) => a && a.id).map(alias));
    else if (val && val.id) out[field] = await alias(val);
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
  if ("cornerRadius" in node && !isMixed(n.cornerRadius) && (n.cornerRadius as number) > 0) {
    out.cornerRadius = n.cornerRadius;
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

async function exportPng(node: SceneNode): Promise<{ id: string; name: string; scale: number; bytes: Uint8Array } | null> {
  if (typeof (node as ExportMixin).exportAsync !== "function") return null;
  try {
    const bytes = await (node as ExportMixin).exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: PNG_SCALE },
    });
    return { id: node.id, name: node.name, scale: PNG_SCALE, bytes };
  } catch (e) {
    console.warn("PNG export failed for", node.name, e);
    return null;
  }
}

async function run(withImages: boolean): Promise<void> {
  const selection = figma.currentPage.selection;
  if (!selection.length) {
    figma.ui.postMessage({ type: "empty" });
    return;
  }

  figma.ui.postMessage({ type: "working", count: selection.length });

  const nodes = await Promise.all(selection.map((s) => serialize(s, 0)));
  const images = withImages
    ? (await Promise.all(selection.map(exportPng))).filter(Boolean)
    : [];

  figma.ui.postMessage({
    type: "data",
    meta: {
      file: figma.root.name,
      page: figma.currentPage.name,
      selectionCount: selection.length,
    },
    nodes,
    images,
  });
}

figma.showUI(__html__, { width: 440, height: 680, themeColors: true });

figma.ui.onmessage = (msg: { type: string }) => {
  if (msg.type === "rerun") void run(true);
  else if (msg.type === "close") figma.closePlugin();
  else if (msg.type === "notify") figma.notify((msg as unknown as { text: string }).text);
};

// Live count hint as selection changes; full bundle only on demand (PNG export
// is too heavy to run on every marquee drag).
figma.on("selectionchange", () => {
  figma.ui.postMessage({ type: "hint", count: figma.currentPage.selection.length });
});

void run(true);
