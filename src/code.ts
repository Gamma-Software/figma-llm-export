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
// Hard cap on number of cropped exports per run (payload + speed guard).
const MAX_EXPORTS = 80;

// SVG export (icons/vectors): when enabled, these types — and any node whose
// longer edge is <= SVG_MAX_DIM (i.e. icon-sized) — export as SVG markup
// instead of a blurry PNG, which an agent can read as actual <path> data.
const SVG_TYPES: ReadonlyArray<string> = ["VECTOR", "BOOLEAN_OPERATION", "LINE", "STAR", "POLYGON"];
const SVG_MAX_DIM = 64;

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
        base.stops = await Promise.all(
          (p as GradientPaint).gradientStops.map(async (s) => {
            const hex = rgbToHex(s.color.r, s.color.g, s.color.b);
            const cb = (s as ColorStop & { boundVariables?: { color?: VariableAlias } }).boundVariables?.color;
            return {
              position: round(s.position),
              color: cb && cb.id ? { value: hex, variable: bindLabel(await resolveVar(cb.id)) } : hex,
              opacity: round(s.color.a),
            };
          })
        );
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

// Shadows and blurs → compact, agent-readable records (visible effects only).
function simplifyEffects(effects: unknown): unknown {
  if (!Array.isArray(effects) || !effects.length) return undefined;
  const out = (effects as Effect[])
    .filter((e) => e.visible !== false)
    .map((e) => {
      const b: Record<string, unknown> = { type: e.type };
      const shadow = e as DropShadowEffect;
      if ("color" in e && shadow.color) b.color = rgbaToHex(shadow.color);
      if ("offset" in e && shadow.offset) b.offset = { x: round(shadow.offset.x), y: round(shadow.offset.y) };
      if ("radius" in e) b.radius = round((e as { radius: number }).radius);
      if ("spread" in e && shadow.spread) b.spread = round(shadow.spread);
      return b;
    });
  return out.length ? out : undefined;
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

// --- Full local-variables export (Figma "export variables" shape) ---------
// Mirrors the per-collection JSON: raw valuesByMode kept as-is (colors stay
// {r,g,b,a}), plus a resolvedValuesByMode with the alias chain followed.

function resolveAliasValue(
  startId: string,
  modeId: string,
  byId: Map<string, Variable>,
  guard = 0
): VariableValue | null {
  if (guard > 24) return null;
  const target = byId.get(startId);
  if (!target) return null;
  let val: VariableValue | undefined = target.valuesByMode[modeId];
  if (val === undefined) {
    // Target collection may not share this modeId — fall back to its first mode.
    const keys = Object.keys(target.valuesByMode);
    val = keys.length ? target.valuesByMode[keys[0]] : undefined;
  }
  if (val && typeof val === "object" && (val as VariableAlias).type === "VARIABLE_ALIAS") {
    return resolveAliasValue((val as VariableAlias).id, modeId, byId, guard + 1);
  }
  return val ?? null;
}

function fullVariable(v: Variable, byId: Map<string, Variable>): unknown {
  const resolvedValuesByMode: Record<string, unknown> = {};
  for (const modeId of Object.keys(v.valuesByMode)) {
    const raw = v.valuesByMode[modeId];
    if (raw && typeof raw === "object" && (raw as VariableAlias).type === "VARIABLE_ALIAS") {
      const aliasId = (raw as VariableAlias).id;
      const target = byId.get(aliasId);
      resolvedValuesByMode[modeId] = {
        resolvedValue: resolveAliasValue(aliasId, modeId, byId),
        alias: aliasId,
        aliasName: target ? target.name : null,
      };
    } else {
      resolvedValuesByMode[modeId] = { resolvedValue: raw, alias: null };
    }
  }
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    type: v.resolvedType,
    valuesByMode: v.valuesByMode,
    resolvedValuesByMode,
    scopes: v.scopes,
    hiddenFromPublishing: v.hiddenFromPublishing,
    codeSyntax: v.codeSyntax,
  };
}

// Lightweight list of local collections for the UI picker.
interface CollectionMeta {
  id: string;
  name: string;
  variableCount: number;
}
async function listCollections(): Promise<CollectionMeta[]> {
  const [cols, vars] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
  ]);
  const counts: Record<string, number> = {};
  for (const v of vars) counts[v.variableCollectionId] = (counts[v.variableCollectionId] || 0) + 1;
  return cols.map((c) => ({ id: c.id, name: c.name, variableCount: counts[c.id] || 0 }));
}

// Fully serialize the selected local variable collections (by id).
async function buildVariableCollections(ids: Set<string>): Promise<unknown[]> {
  if (!ids.size) return [];
  const [cols, vars] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
  ]);
  const byId = new Map(vars.map((v) => [v.id, v]));
  const byCol = new Map<string, Variable[]>();
  for (const v of vars) {
    const arr = byCol.get(v.variableCollectionId) || [];
    arr.push(v);
    byCol.set(v.variableCollectionId, arr);
  }
  return cols
    .filter((c) => ids.has(c.id))
    .map((c) => {
      const modes: Record<string, string> = {};
      for (const m of c.modes) modes[m.modeId] = m.name;
      return {
        id: c.id,
        name: c.name,
        modes,
        variableIds: c.variableIds,
        variables: (byCol.get(c.id) || []).map((v) => fullVariable(v, byId)),
      };
    });
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
    if (t.textAlignVertical !== "TOP") out.textAlignVertical = t.textAlignVertical;
    if (!isMixed(t.fontSize)) out.fontSize = bind(t.fontSize, "fontSize");
    if (!isMixed(t.fontName)) out.fontName = t.fontName;
    if (!isMixed(t.fontWeight)) out.fontWeight = t.fontWeight;
    // Extra typography — only when non-mixed and non-default (keep it terse).
    if (!isMixed(t.lineHeight) && (t.lineHeight as LineHeight).unit !== "AUTO") out.lineHeight = t.lineHeight;
    if (!isMixed(t.letterSpacing) && (t.letterSpacing as LetterSpacing).value !== 0) out.letterSpacing = t.letterSpacing;
    if (!isMixed(t.textCase) && t.textCase !== "ORIGINAL") out.textCase = t.textCase;
    if (!isMixed(t.textDecoration) && t.textDecoration !== "NONE") out.textDecoration = t.textDecoration;
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

  // Effects (shadows / blurs)
  if ("effects" in node) {
    const fx = simplifyEffects((node as BlendMixin).effects);
    if (fx) out.effects = fx;
  }

  // Blend mode (non-default only)
  if ("blendMode" in node) {
    const bm = (node as BlendMixin).blendMode;
    if (bm && bm !== "NORMAL" && bm !== "PASS_THROUGH") out.blendMode = bm;
  }

  // Resize behaviour against the parent — key for reconstructing layout.
  if ("layoutSizingHorizontal" in node) {
    out.layoutSizing = {
      h: (node as unknown as { layoutSizingHorizontal: string }).layoutSizingHorizontal,
      v: (node as unknown as { layoutSizingVertical: string }).layoutSizingVertical,
    };
  }
  if ("constraints" in node) {
    const c = (node as ConstraintMixin).constraints;
    out.constraints = { h: c.horizontal, v: c.vertical };
  }

  // Auto-layout
  if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
    const f = node as FrameNode;
    out.layout = {
      mode: f.layoutMode,
      wrap: f.layoutWrap === "WRAP" ? true : undefined,
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
  if ("clipsContent" in node && (node as FrameNode).clipsContent) out.clipsContent = true;

  // Components
  if (node.type === "INSTANCE") {
    try {
      out.componentProperties = (node as InstanceNode).componentProperties;
    } catch {
      /* ignore */
    }
    try {
      const mc = await (node as InstanceNode).getMainComponentAsync();
      if (mc) {
        out.mainComponent =
          mc.parent && mc.parent.type === "COMPONENT_SET" ? `${mc.parent.name} / ${mc.name}` : mc.name;
      }
    } catch {
      /* ignore */
    }
  }
  if (node.type === "COMPONENT") {
    const vp = (node as ComponentNode).variantProperties;
    if (vp) out.variantProperties = vp;
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
  format: "PNG" | "SVG";
  mimeType: string;
  scale: number;
  bytes: Uint8Array;
}

// Export a node as PNG (raster) or SVG (vector markup).
async function exportNode(node: SceneNode, format: "PNG" | "SVG"): Promise<ExportedImage | null> {
  if (typeof (node as ExportMixin).exportAsync !== "function") return null;
  try {
    if (format === "SVG") {
      const bytes = await (node as ExportMixin).exportAsync({ format: "SVG" });
      return { id: node.id, name: node.name, type: node.type, format: "SVG", mimeType: "image/svg+xml", scale: 1, bytes };
    }
    const bytes = await (node as ExportMixin).exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: PNG_SCALE },
    });
    return { id: node.id, name: node.name, type: node.type, format: "PNG", mimeType: "image/png", scale: PNG_SCALE, bytes };
  } catch (e) {
    console.warn(format + " export failed for", node.name, e);
    return null;
  }
}

// SVG when enabled and the node is a vector type or icon-sized (longer edge
// <= SVG_MAX_DIM) — an agent reads <path> markup better than a tiny raster.
function pickFormat(node: SceneNode, svgIcons: boolean): "PNG" | "SVG" {
  if (!svgIcons) return "PNG";
  const longer = Math.max((node as LayoutMixin).width, (node as LayoutMixin).height);
  return SVG_TYPES.indexOf(node.type) !== -1 || longer <= SVG_MAX_DIM ? "SVG" : "PNG";
}

// Worth its own cropped export? Text and elements below `minDim` are not —
// they render fine inside their parent and would just be noise. (Vectors are
// kept here because they're valuable as standalone SVG.)
function worthCropping(node: SceneNode, minDim: number, svgIcons: boolean): boolean {
  if (node.visible === false) return false;
  // A vector is skipped as a PNG sliver, but kept when it can be SVG.
  const skip = SKIP_EXPORT_TYPES.indexOf(node.type) !== -1;
  if (skip && !(svgIcons && SVG_TYPES.indexOf(node.type) !== -1)) return false;
  const w = (node as LayoutMixin).width;
  const h = (node as LayoutMixin).height;
  return w >= minDim && h >= minDim;
}

// Recursively export each meaningful element. `isRoot` nodes (what the user
// explicitly selected) are always exported, even text/small ones.
async function collectExports(
  node: SceneNode,
  images: ExportedImage[],
  depth: number,
  isRoot: boolean,
  minDim: number,
  svgIcons: boolean
): Promise<void> {
  if (images.length >= MAX_EXPORTS) return;

  if (isRoot || worthCropping(node, minDim, svgIcons)) {
    const img = await exportNode(node, pickFormat(node, svgIcons));
    if (img) images.push(img);
  }

  if (
    "children" in node &&
    depth < MAX_DEPTH &&
    NO_RECURSE_EXPORT.indexOf(node.type) === -1
  ) {
    for (const child of (node as ChildrenMixin).children as SceneNode[]) {
      if (images.length >= MAX_EXPORTS) break;
      await collectExports(child, images, depth + 1, false, minDim, svgIcons);
    }
  }
}

async function run(
  withImages: boolean,
  minDim: number,
  collectionIds: string[],
  svgIcons: boolean
): Promise<void> {
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
  // Full dump of the picked collections (empty pick -> none).
  const picked = new Set(collectionIds);
  const variableCollections = picked.size ? await buildVariableCollections(picked) : null;
  const collections = await listCollections();

  const images: ExportedImage[] = [];
  if (withImages) {
    for (const s of selection) {
      if (images.length >= MAX_EXPORTS) break;
      await collectExports(s, images, 0, true, minDim, svgIcons);
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
      collectionCount: variableCollections ? variableCollections.length : 0,
      truncated: images.length >= MAX_EXPORTS,
    },
    collections,
    nodes,
    variables,
    variableCollections,
    images,
  });
}

const STORAGE_MIN_DIM = "minExportDim";
const STORAGE_COLLECTIONS = "exportCollectionIds";
const STORAGE_SVG = "svgIcons";
let minExportDim = MIN_EXPORT_DIM; // live values, persisted across reloads
let exportCollectionIds: string[] = [];
let svgIcons = false;

figma.showUI(__html__, { width: 440, height: 760, themeColors: true });

figma.ui.onmessage = async (msg: {
  type: string;
  minDim?: number;
  collectionIds?: string[];
  svgIcons?: boolean;
  text?: string;
}) => {
  if (msg.type === "rerun") {
    if (typeof msg.minDim === "number" && msg.minDim >= 0) {
      minExportDim = Math.floor(msg.minDim);
      await figma.clientStorage.setAsync(STORAGE_MIN_DIM, minExportDim);
    }
    if (Array.isArray(msg.collectionIds)) {
      exportCollectionIds = msg.collectionIds.filter((x) => typeof x === "string");
      await figma.clientStorage.setAsync(STORAGE_COLLECTIONS, exportCollectionIds);
    }
    if (typeof msg.svgIcons === "boolean") {
      svgIcons = msg.svgIcons;
      await figma.clientStorage.setAsync(STORAGE_SVG, svgIcons);
    }
    void run(true, minExportDim, exportCollectionIds, svgIcons);
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

// Restore saved settings, send the collection list + selection, first export.
(async () => {
  const storedDim = await figma.clientStorage.getAsync(STORAGE_MIN_DIM);
  if (typeof storedDim === "number" && storedDim >= 0) minExportDim = storedDim;
  const storedCols = await figma.clientStorage.getAsync(STORAGE_COLLECTIONS);
  if (Array.isArray(storedCols)) exportCollectionIds = storedCols.filter((x) => typeof x === "string");
  const storedSvg = await figma.clientStorage.getAsync(STORAGE_SVG);
  if (typeof storedSvg === "boolean") svgIcons = storedSvg;
  const collections = await listCollections();
  // Drop any saved ids whose collection no longer exists.
  const live = new Set(collections.map((c) => c.id));
  exportCollectionIds = exportCollectionIds.filter((id) => live.has(id));
  figma.ui.postMessage({
    type: "settings",
    minDim: minExportDim,
    collections,
    collectionIds: exportCollectionIds,
    svgIcons,
  });
  void run(true, minExportDim, exportCollectionIds, svgIcons);
})();
