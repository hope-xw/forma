import { z } from "zod";
import { importName, limitedText } from "./types";
import { fillUsesTextColor, defaultStyle } from "../../domain/node";
import { maxPageNodes, maxLayerDimension } from "../../domain/document-limits";
import {
  parseDocument,
  type DesignDocument,
  type DesignNode,
} from "../../domain/document";
import { materializeSlots, type SlotRef } from "../../domain/component-slots";
import type {
  ComponentLibrary,
  ComponentVariant,
} from "../../domain/library-schema";
import { replaceText } from "../../domain/rich-text";
import { styleGroups } from "../../domain/design-properties";
import { attachSketchTextLayouts } from "./sketch-text-layout";
import { importSketchFonts } from "./sketch-fonts";
import {
  libraryDesignSystem,
  libraryFonts,
  templateNodes,
} from "../../domain/library-design-system";
import { openDesignArchive } from "./archive";
import { importSketchImage } from "./sketch-image";
import type { ExternalDesignImport, ImportIssue } from "./types";
import {
  applyModernLayout,
  pinSettings,
  reflowOverrides,
} from "./sketch-layout";
import { constrainAxis } from "../../domain/constraints";
import {
  makeLayer,
  appearance,
  orderedFills,
  sketchBlendModes,
} from "./sketch-appearance";
import { readSystem } from "./sketch-system";
import {
  readLayer,
  parseSketch,
  bounded,
  rotation,
  object,
  array,
  number,
  color,
  alpha,
  string,
  idFor,
  type Layer,
  type Warn,
} from "./sketch-source";

const decoder = new TextDecoder("utf-8", { fatal: true });
type Master = {
  layer: Layer;
  library: ComponentLibrary;
  local: boolean;
  variant?: ComponentVariant;

  paths?: Map<string, string>;
};
const schema = z.looseObject({
  pages: z
    .array(z.object({ _ref: z.string() }))
    .min(1)
    .max(100),
  do_objectID: z.string().min(1),
});
const componentRef = (m: Master): SlotRef => ({
  libraryId: m.library.id,
  componentId: string(m.layer.symbolID),
  variantId: "default",
});

export async function importSketch(
  bytes: Uint8Array,
  filename: string,
): Promise<ExternalDesignImport> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw Error(
      "此文件不属于 ZIP + JSON 世代的 Sketch 原档，可用兼容版本的 Sketch 打开并另存副本后重试",
    );
  const archive = openDesignArchive(bytes);
  if (!archive.has("meta.json") || !archive.has("document.json"))
    throw Error(
      "不是受支持的 Sketch ZIP 原档，需要 meta.json 与 document.json",
    );
  const json = (path: string): unknown => {
    const data = archive.read(path);
    try {
      return JSON.parse(decoder.decode(data));
    } catch {
      throw Error("Sketch " + path + " 不是有效的 UTF-8 JSON");
    }
  };
  const meta = parseSketch(
    z.looseObject({ version: z.number().int().positive() }),
    json("meta.json"),
    "meta.json",
  );
  const raw = parseSketch(schema, json("document.json"), "document.json");
  const issues = new Map<string, ImportIssue>();
  const warn: Warn = (node, detail) => {
    node = limitedText(node, 4096);
    detail = limitedText(detail, 8192);
    const key = node + "\n" + detail;
    if (!issues.has(key)) issues.set(key, { node, detail });
  };
  if (![144, 146, 196].includes(meta.version))
    warn(
      filename,
      "Sketch 文档版本 " + meta.version + " 尚未列入实测版本，需核对导入报告",
    );
  const fontContext = await importSketchFonts(raw, archive);
  const { fonts, issues: fontIssues } = fontContext;
  for (const issue of fontIssues) warn(issue.node, issue.detail);
  if (
    raw.colorSpace !== undefined &&
    raw.colorSpace !== 1 &&
    raw.colorSpace !== 2
  )
    warn(filename, "未指定受支持的文档色域，使用 sRGB");
  const usedIds = new Set<string>();
  const artboards = new Set<string>();
  const sourceLayers = new Map<string, Layer>();
  let sourceNodes = 0;
  const pages = raw.pages.map((ref) => {
    const path = ref._ref.endsWith(".json") ? ref._ref : ref._ref + ".json";
    if (!/^pages\/[^/]+\.json$/.test(path))
      throw Error("Sketch 页面引用路径无效");
    const page = parseSketch(
      z.looseObject({
        _class: z.literal("page"),
        do_objectID: z.string().min(1),
        name: z.string(),
        layers: z.array(z.unknown()),
      }),
      json(path),
      path,
    );
    const budget = { count: 0 };
    const layers = page.layers.map((l) => readLayer(l, 0, budget));
    sourceNodes += budget.count;
    return {
      id: page.do_objectID,
      name: importName(page.name, "页面", 120, (msg) =>
        warn(page.do_objectID, msg),
      ),
      layers,
    };
  });
  const title = importName(
    filename.replace(/\.sketch$/i, ""),
    "Sketch",
    200,
    (msg) => warn(filename, msg),
  );
  const doc: DesignDocument = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: title,
    revision: 0,
    tokens: {},
    nodes: [],
    libraries: {},
    images: {},
    colorProfile: raw.colorSpace === 2 ? "display-p3" : "srgb",
  };
  if (Object.keys(fonts).length) doc.fonts = fonts;
  const { system, styleRefs } = readSystem(raw, warn, fontContext);
  doc.designSystem = system;
  const assetPaths = new Map<string, string>();
  for (const path of archive.names.filter(
    (p) => p.startsWith("images/") && !p.endsWith("/"),
  )) {
    try {
      const { id, image } = await importSketchImage(
        archive.read(path),
        path.split("/").at(-1)!,
      );
      if (path.toLowerCase().endsWith(".pdf"))
        warn(path, "单页 PDF 图像保留为透明 PNG");
      assetPaths.set(path, id);
      doc.images![id] ??= image;
    } catch (error) {
      warn(
        path,
        "无法导入图像：" +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  function attachImage(
    node: DesignNode,
    value: unknown,
    fit: NonNullable<DesignNode["image"]>["fit"] = "fill",
  ) {
    const path = string(object(value)._ref),
      id = assetPaths.get(path);
    if (id) node.image = { assetId: id, fit, x: 50, y: 50, zoom: 1 };
    else warn(node.id, "图像引用未解析：" + path);
  }
  function applyShared(
    node: DesignNode,
    id: string,
    overridden = false,
    overrideKind?: "textStyle" | "layerStyle",
  ) {
    const refs = styleRefs.get(id);
    if (!refs) {
      warn(node.id, "共享样式缺失：" + id);
      return;
    }
    if (overrideKind) {
      const kinds =
        overrideKind === "textStyle"
          ? (["text"] as const)
          : (["paint", "stroke", "effect"] as const);
      const superseded = new Set<string>();
      for (const kind of kinds) {
        if (node.styleBindings) delete node.styleBindings[kind];
        for (const key of styleGroups[kind]) {
          superseded.add(key);
          if (
            !refs[kind] ||
            system.styles[refs[kind]!].properties[key] === undefined
          ) {
            if (Object.hasOwn(defaultStyle, key))
              Object.assign(node.style, { [key]: defaultStyle[key] });
            else delete node.style[key];
          }
        }
      }
      if (overrideKind === "layerStyle" && fillUsesTextColor(node)) {
        superseded.add("color");
        superseded.add("colorOpacity");
      }
      for (const key of Object.keys(
        node.variableBindings ?? {},
      ) as (keyof NonNullable<DesignNode["variableBindings"]>)[])
        if (superseded.has(key.split(".")[0]))
          delete node.variableBindings![key];
      node.styleOverrides = node.styleOverrides?.filter(
        (key) => !superseded.has(key),
      );
    }
    node.styleBindings = { ...node.styleBindings, ...refs };
    if (overridden) {
      if (!overrideKind) node.styleOverrides = undefined;
      return;
    }
    const diffs = new Set(node.styleOverrides);
    for (const [kind, ref] of Object.entries(refs)) {
      const st = system.styles[ref];
      for (const k of styleGroups[kind as keyof typeof styleGroups])
        if (JSON.stringify(st.properties[k]) !== JSON.stringify(node.style[k]))
          diffs.add(k);
      for (const key of ["fill", "color", "stroke"] as const) {
        const inherited = st.bindings[key];
        if (inherited && node.variableBindings?.[key] === inherited) {
          delete node.variableBindings[key];
          if (
            key === "fill" &&
            (fillUsesTextColor(node) ||
              sourceLayers.get(node.id)?._class === "shapeGroup") &&
            node.variableBindings.color === inherited
          )
            delete node.variableBindings.color;
        }
      }
    }
    if (diffs.size) node.styleOverrides = [...diffs];
  }
  function base(l: Layer) {
    const n = makeLayer(l, warn, fontContext);
    applyModernLayout(n, l, warn);
    Object.assign(n.style, pinSettings(l));
    const st = object(l.style),
      fills = orderedFills(st)
        .map((p) => p.fill)
        .filter((f) => f.isEnabled !== false),
      fill = fills[0];
    if (l.image) attachImage(n, l.image);
    for (const f of fills.filter((f) => f.fillType === 4)) {
      attachImage(
        n,
        f.image,
        (["tile", "cover", "fill", "contain"] as const)[
          number(f.patternFillType)
        ] ?? "cover",
      );
      if (fills.filter((p) => p.fillType === 4).length > 1)
        warn(n.id, "多项图片叠加仅映射顶层图片");
      if (n.image?.fit === "tile")
        n.image.tileScale = bounded(
          number(f.patternTileScale, 1),
          0.1,
          8,
          (msg) => warn(n.id, msg),
          "平铺比例",
        );
    }
    const bind = (key: "fill" | "color" | "stroke", c: unknown) => {
      const sid = string(object(c).swatchID);
      if (!sid) return;
      if (system.variables[sid])
        n.variableBindings = { ...n.variableBindings, [key]: sid };
      else warn(n.id, "颜色变量缺失：" + sid);
    };
    if (fill) {
      bind("fill", fill.color);
      if (fillUsesTextColor(n) || l._class === "shapeGroup")
        bind("color", fill.color);
    }
    const textAttrs = object(object(st.textStyle).encodedAttributes);
    bind("color", textAttrs.MSAttributedStringColorAttribute);
    bind(
      "stroke",
      array(st.borders)
        .filter((b) => b.isEnabled !== false)
        .at(-1)?.color,
    );
    for (const g of [
      n.style.gradient,
      ...(n.style.paints ?? []).map((p) => p.gradient),
    ])
      for (const stop of g?.stops ?? [])
        if (stop.variableId && !system.variables[stop.variableId]) {
          warn(n.id, "渐变色变量缺失：" + stop.variableId);
          delete stop.variableId;
        }
    if (typeof l.sharedStyleID === "string")
      applyShared(n, l.sharedStyleID, !l.style);
    applyFlow(n, l);
    return n;
  }
  function applyFlow(n: DesignNode, l: Layer) {
    const to = string(object(l.flow).destinationArtboardID);
    if (to && artboards.has(to))
      n.interaction = {
        trigger: "click",
        actions: [{ kind: "navigate", target: to }],
      };
    else if (to === "back")
      n.interaction = { trigger: "click", actions: [{ kind: "back" }] };
    else if (l.flow) warn(n.id, "原型目标未能定位：" + to);
  }
  const masters = new Map<string, Master>();
  function library(group: string, label: string) {
    const id = idFor("sketch-lib", group);
    return (doc.libraries![id] ??= {
      format: "forma/library",
      version: 1,
      id,
      name: importName(label, "Sketch 外部库", 200, (msg) => warn(group, msg)),
      revision: 1,
      description: "",
      source: { name: "Sketch", license: "源文件资源" },
      components: [],
      images: {},
    });
  }
  function register(l: Layer, lib: ComponentLibrary, local: boolean) {
    const remember = (n: Layer) => {
      sourceLayers.set(n.do_objectID, n);
      n.layers.forEach(remember);
    };
    if (!local) remember(l);
    const symbol = string(l.symbolID);
    if (!symbol || masters.has(symbol))
      throw Error("Symbol ID 缺失或重复：" + l.name);
    masters.set(symbol, { layer: l, library: lib, local });
  }
  function index(l: Layer) {
    if (usedIds.has(l.do_objectID))
      throw Error("Sketch 图层 ID 重复：" + l.do_objectID);
    usedIds.add(l.do_objectID);
    sourceLayers.set(l.do_objectID, l);
    if (l._class === "artboard") artboards.add(l.do_objectID);
    if (l._class === "symbolMaster")
      register(l, library(raw.do_objectID, title), true);
    for (const child of l.layers) index(child);
  }
  for (const p of pages) p.layers.forEach(index);
  for (const foreign of array(raw.foreignSymbols)) {
    if (!foreign.symbolMaster) {
      warn(
        filename,
        "外部组件库快照缺失：" + string(foreign.sourceLibraryName),
      );
      continue;
    }
    register(
      readLayer(foreign.symbolMaster),
      library(
        string(foreign.libraryID),
        string(foreign.sourceLibraryName, "Sketch 外部库"),
      ),
      false,
    );
  }
  const packing = new Map<
    string,
    { lib: ComponentLibrary; chunk: number; nodes: number }
  >();
  const building = new Set<Master>();
  // Paths consist of source IDs across symbol boundaries; ordinary groups do not add an override segment.
  function build(m: Master) {
    if (m.variant) return m.variant;
    if (building.has(m)) throw Error("Sketch 组件循环引用：" + m.layer.name);
    if (building.size >= 180) throw Error("Sketch 组件嵌套深度超限");
    building.add(m);
    const paths = new Map<string, string>();
    const drawing: DesignNode[] = [];
    render(m.layer, null, drawing, paths);
    if (drawing.length > 1000)
      throw Error(
        "Sketch 组件 " + m.layer.name + " 展开后超过当前单变体 1,000 层上限",
      );
    const first = m.library;
    const pack = packing.get(first.id) ?? { lib: first, chunk: 1, nodes: 0 };
    if (
      pack.nodes + drawing.length > 45_000 ||
      pack.lib.components.length >= 4096
    ) {
      const suffix = " " + ++pack.chunk;
      const id = first.id + "-" + pack.chunk;
      pack.lib = doc.libraries![id] = {
        ...first,
        id,
        name: limitedText(first.name, 200 - suffix.length) + suffix,
        components: [],
        images: {},
      };
      pack.nodes = 0;
    }
    pack.nodes += drawing.length;
    packing.set(first.id, pack);
    m.library = pack.lib;
    const templates = drawing.map((n) => {
      const copy = structuredClone(n);
      if (copy.variableBindings && !Object.keys(copy.variableBindings).length)
        delete copy.variableBindings;
      if (copy.styleBindings && !Object.keys(copy.styleBindings).length)
        delete copy.styleBindings;
      if (n.id === m.layer.do_objectID) {
        copy.parentId = null;
        copy.style.x = 0;
        copy.style.y = 0;
      }
      const inner = copy.templateKey;
      copy.templateKey = n.id === m.layer.do_objectID ? "root" : n.id;
      if (copy.instance) {
        const { slots, ...ref } = copy.instance;
        copy.nestedSlot = true;
        copy.nestedSource = ref;
        delete copy.instance;
        if (slots) warn(n.id, "嵌套默认换件保留当前实例快照");
      }
      if (inner) {
        const prev =
          copy.nestedPath ?? (copy.nestedKey ? [copy.nestedKey] : []);
        copy.nestedKey = inner;
        copy.nestedPath = prev.length ? [inner, ...prev] : undefined;
      }
      if (n.image)
        m.library.images![n.image.assetId] = doc.images![n.image.assetId];
      return copy;
    });
    const variant: ComponentVariant = {
      id: "default",
      name: "默认",
      properties: {},
      nodes: templates,
    };
    m.paths = new Map(templates.map((n) => [n.templateKey!, paths.get(n.id)!]));
    m.variant = variant;

    m.library.components.push({
      id: string(m.layer.symbolID),
      name: importName(m.layer.name, "Symbol", 200, (msg) =>
        warn(m.layer.do_objectID, msg),
      ),
      category: "Sketch",
      description: "",
      variants: [variant],
      ...(m.local
        ? { master: { documentId: doc.id, nodeId: m.layer.do_objectID } }
        : {}),
    });
    building.delete(m);
    return variant;
  }
  function emit(out: DesignNode[], n: DesignNode) {
    if (out.length >= maxPageNodes)
      throw Error("Sketch 单页展开后超过 " + maxPageNodes + " 层");
    out.push(n);
  }
  function render(
    l: Layer,
    parentId: string | null,
    out: DesignNode[],
    paths: Map<string, string>,
  ) {
    if (l._class === "symbolInstance") {
      const m = masters.get(string(l.symbolID));
      if (m) {
        expand(l, m, parentId, out, paths);
        return;
      }
      warn(
        l.do_objectID,
        "Symbol 主件未随文件提供，仅保留实例位置：" + string(l.symbolID),
      );
    }
    const n = base(l);
    n.parentId = parentId;
    emit(out, n);
    paths.set(n.id, n.id);
    for (const child of l.layers) render(child, n.id, out, paths);
    // A mask on the first sibling clips the following siblings up to a chain break.
    const masks = l.layers.filter((c) => c.hasClippingMask);
    if (masks.length) {
      const first = l.layers[0],
        mask = out.find((child) => child.id === first.do_objectID);
      if (
        masks.length === 1 &&
        first.hasClippingMask &&
        n.type === "group" &&
        l._class !== "shapeGroup" &&
        mask &&
        !l.layers.slice(1).some((c) => c.shouldBreakMaskChain) &&
        (["rectangle", "ellipse", "vector"].includes(mask.type) ||
          mask.booleanOperation) &&
        (!number(first.clippingMaskMode) || mask.image)
      ) {
        if (
          mask.type === "rectangle" &&
          !mask.style.rotation &&
          !number(first.clippingMaskMode) &&
          mask.style.x === 0 &&
          mask.style.y === 0 &&
          mask.style.width === n.style.width &&
          mask.style.height === n.style.height
        ) {
          n.type = "frame";
          n.style.clipContent = true;
          n.style.radius = mask.style.radius;
          n.style.corners = mask.style.corners;
          n.style.cornerSmoothing = mask.style.cornerSmoothing;
        } else {
          n.maskSourceId = mask.id;
          n.maskType =
            number(first.clippingMaskMode) === 1 ? "alpha" : "vector";
          if (mask.style.fillOpacity || mask.image)
            warn(mask.id, "不规则蒙版源的自身可见绘制需核对");
        }
      } else
        for (const c of masks)
          warn(c.do_objectID, "当前蒙版链含多个作用域或不支持的源，需复核");
    }
    if (l._class === "shapeGroup") {
      n.style.color = n.style.fill;
      n.style.colorOpacity = n.style.fillOpacity;
      const sourceOps = l.layers.map((child) =>
        number(child.booleanOperation, -1),
      );
      const ops = new Set(sourceOps.slice(1));
      const modes = ["union", "subtract", "intersect", "exclude"] as const;
      const children = out.filter((child) => child.parentId === n.id);
      const only = children.length === 1 ? children[0] : undefined;
      if (
        only &&
        ["ellipse", "rectangle", "vector"].includes(only.type) &&
        n.style.stroke &&
        n.style.strokeWidth &&
        !only.style.stroke
      ) {
        // A stroke on the compound contour follows the shape, not its rectangular group box.
        for (const k of [
          "stroke",
          "strokeWidth",
          "strokeAlign",
          "strokeStyle",
          "strokeDash",
          "strokeOpacity",
          "strokeVisible",
        ] as const) {
          Object.assign(only.style, { [k]: n.style[k] });
          delete n.style[k];
        }
        if (n.styleBindings?.stroke) {
          only.styleBindings = {
            ...only.styleBindings,
            stroke: n.styleBindings.stroke,
          };
          delete n.styleBindings.stroke;
          if (!Object.keys(n.styleBindings).length) delete n.styleBindings;
          const overrides =
            n.styleOverrides?.filter((k) =>
              (styleGroups.stroke as readonly string[]).includes(k),
            ) ?? [];
          only.styleOverrides = [
            ...new Set([...(only.styleOverrides ?? []), ...overrides]),
          ];
        }
        for (const key of ["stroke", "strokeOpacity", "strokeWidth"] as const)
          if (n.variableBindings?.[key]) {
            only.variableBindings = {
              ...only.variableBindings,
              [key]: n.variableBindings[key],
            };
            delete n.variableBindings[key];
          }
        if (only.vector)
          for (const path of only.vector.paths)
            path.strokeWidth = only.style.strokeWidth ?? 0;
        only.style.fill = n.style.fill;
        only.style.fillOpacity = n.style.fillOpacity;
        only.style.color = n.style.color;
        only.style.colorOpacity = n.style.colorOpacity;
        return;
      }
      const supported =
        children.length &&
        children.every(
          (c) =>
            ["rectangle", "ellipse"].includes(c.type) ||
            c.booleanOperation ||
            (c.vector && c.vector.paths.every((p) => p.fill)),
        );
      if (
        supported &&
        (ops.has(-1) || ops.size > 1) &&
        sourceOps.every((op) => op === -1 || modes[op])
      ) {
        n.booleanOperation = "compound";
        n.compoundWindingRule =
          object(l.style).windingRule === 1 ? "evenodd" : "nonzero";
        for (const [i, child] of children.entries())
          if (i > 0 && modes[sourceOps[i]])
            child.operandOperation = modes[sourceOps[i]];
      } else if (supported && ops.size <= 1)
        n.booleanOperation = modes[[...ops][0] ?? 0];
      if (!n.booleanOperation)
        warn(n.id, "复合路径运算按源子层保留，外观需复核");
    }
  }
  function missingOverride(path: string) {
    const absent = path.split("/").find((id) => !sourceLayers.has(id));
    return (
      (absent ? "覆盖路径引用的图层已不在原档" : "覆盖路径不在当前主件分支") +
      "：" +
      path
    );
  }
  function expand(
    l: Layer,
    m: Master,
    parentId: string | null,
    out: DesignNode[],
    paths: Map<string, string>,
  ) {
    const initial = build(m),
      overrides = array(l.overrideValues).flatMap((o) => {
        const name = string(o.overrideName),
          i = name.lastIndexOf("_");
        if (i < 0) {
          warn(l.do_objectID, "覆盖名称缺少属性分隔符：" + name);
          return [];
        }
        return [
          {
            path: name.slice(0, i),
            property: name.slice(i + 1),
            value: o.value,
          },
        ];
      });
    const lookup = new Map([...m.paths!].map(([k, p]) => [p, k]));
    // A modern Sketch instance can address its own style with the instance's source ID.
    lookup.set(l.do_objectID, "root");
    const slots: Record<string, SlotRef> = {};
    const emptySlots = new Set<string>();
    let variant = initial;
    const targetPaths = new Map(m.paths);
    for (const o of overrides
      .filter((o) => o.property === "symbolID" && o.value)
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length)) {
      const target = masters.get(string(o.value)),
        slot = lookup.get(o.path);
      if (
        slot &&
        (!variant.nodes.some(
          (n) => n.templateKey === slot && n.parentId && n.nestedSlot,
        ) ||
          (!Object.hasOwn(slots, slot) && Object.keys(slots).length >= 100))
      ) {
        warn(l.do_objectID, "换件目标不是有效插槽或超过 100 个插槽：" + o.path);
        continue;
      }
      if (!target || !slot) {
        if (!target && slot) emptySlots.add(o.path);
        warn(
          l.do_objectID,
          !target
            ? "换件主件未随原档提供，依原厂隐藏该槽：" +
                string(o.value) +
                " (" +
                o.path +
                ")"
            : missingOverride(o.path),
        );
        continue;
      }
      build(target);
      slots[slot] = componentRef(target);
      variant = materializeSlots(doc, initial, slots);
      const root = variant.nodes.find((n) => n.templateKey === slot);
      if (!root) throw Error("Sketch 嵌套组件替换失败：" + o.path);
      const inBranch = new Set([root.id]);
      const depth = o.path.split("/").length - 1;
      for (const n of variant.nodes) {
        if (!n.parentId || !inBranch.has(n.parentId)) continue;
        inBranch.add(n.id);
        const k = n.nestedPath?.[depth] ?? n.nestedKey,
          sub = k && target.paths?.get(k);
        if (sub) {
          const path = o.path + "/" + sub;
          lookup.set(path, n.templateKey!);
          targetPaths.set(n.templateKey!, path);
        }
      }
    }
    const root = variant.nodes.find((n) => !n.parentId)!;
    const ids = new Map(
      variant.nodes.map((n) => [
        n.id,
        n === root
          ? l.do_objectID
          : idFor("sk", l.do_objectID + "/" + n.templateKey),
      ]),
    );
    const live = new Map<string, DesignNode>();
    const byTemplateId = new Map(variant.nodes.map((n) => [n.id, n]));
    for (const t of variant.nodes) {
      const n = structuredClone(t);
      n.id = ids.get(t.id)!;
      n.parentId = t.parentId ? ids.get(t.parentId)! : parentId;
      if (n.maskSourceId) n.maskSourceId = ids.get(n.maskSourceId);
      if (t.parentId) {
        const p = byTemplateId.get(t.parentId)!;
        const liveParent = live.get(p.templateKey!)!;
        constrainAxis(n, "width", p.style.width, liveParent.style.width);
        constrainAxis(n, "height", p.style.height, liveParent.style.height);
      }
      if (t === root) {
        n.instance = {
          ...componentRef(m),
          ...(Object.keys(slots).length ? { slots } : {}),
        };
        const report = (msg: string) => warn(l.do_objectID, msg);
        n.name = limitedText(l.name, 16384, report, "图层名");
        n.hidden = l.isVisible === false;
        n.locked = l.isLocked === true;
        n.style = {
          ...n.style,
          ...l.frame,
          width: bounded(
            l.frame.width,
            0,
            maxLayerDimension,
            report,
            "图层宽度",
          ),
          height: bounded(
            l.frame.height,
            0,
            maxLayerDimension,
            report,
            "图层高度",
          ),
          rotation: rotation(l, warn),
          flipX: l.isFlippedHorizontal === true,
          flipY: l.isFlippedVertical === true,
        };
        if (
          !m.layer.includeBackgroundColorInInstance &&
          m.layer.hasBackgroundColor
        )
          n.style.fillOpacity = 0;
        const instanceStyle = object(l.style);
        if (
          array(instanceStyle.fills).some(
            (f) => f.layeringType === 1 && f.isEnabled !== false,
          )
        )
          n.style.tint = appearance(
            instanceStyle,
            (msg) => warn(l.do_objectID, msg),
            fontContext,
          ).tint;
        Object.assign(n.style, pinSettings(l));
        if (l.flow) applyFlow(n, l);
        applyModernLayout(n, l, warn);
        const graphics = object(instanceStyle.contextSettings);
        if (typeof graphics.opacity === "number")
          n.style.opacity = bounded(
            graphics.opacity,
            0,
            1,
            report,
            "实例透明度",
          );
        if (typeof graphics.blendMode === "number")
          n.style.blendMode = sketchBlendModes[graphics.blendMode];
      }
      paths.set(
        n.id,
        t === root
          ? l.do_objectID
          : l.do_objectID +
              "/" +
              (targetPaths.get(t.templateKey!) ?? t.templateKey),
      );
      live.set(t.templateKey!, n);
      emit(out, n);
    }
    for (const o of overrides) {
      if (o.property === "symbolID" && o.value && !emptySlots.has(o.path))
        continue;
      const n = live.get(lookup.get(o.path) ?? "");
      if (!n) {
        warn(l.do_objectID, missingOverride(o.path));
        continue;
      }
      let fields: string[] = [];
      const paintIndex = /^color:fill-(\d+)$/.exec(o.property);
      const extraPaint =
        paintIndex && n.style.paints?.find((p) => p.id === "p" + paintIndex[1]);
      const property = extraPaint ? "paintEntry" : o.property;
      switch (property) {
        case "paintEntry":
          if (extraPaint && typeof object(o.value).red === "number") {
            extraPaint.color = color(o.value);
            extraPaint.opacity = alpha(o.value, (msg) =>
              warn(l.do_objectID, msg),
            );
            fields = ["style.paints"];
            n.styleOverrides = [
              ...new Set([...(n.styleOverrides ?? []), "paints"]),
            ];
            if (object(o.value).swatchID)
              warn(l.do_objectID, "多重填色覆盖采用色变量当前值：" + o.path);
          } else warn(l.do_objectID, "未知填充颜色覆盖：" + o.path);
          break;
        case "stringValue":
          fields = ["text", "textRuns"];
          Object.assign(
            n,
            replaceText(
              n,
              limitedText(string(o.value), 50000, (msg) =>
                warn(l.do_objectID, msg),
              ),
            ),
          );
          if (!n.text) delete n.textRuns;
          break;
        case "symbolID":
          if (!n.nestedSlot) {
            warn(l.do_objectID, "换件目标不是有效插槽：" + o.path);
            break;
          }
          fields = ["hidden"];
          n.hidden = true;
          break;
        case "image":
          fields = ["image"];
          attachImage(n, o.value, n.image?.fit);
          break;
        case "isVisible":
          fields = ["hidden"];
          n.hidden =
            o.value === false ||
            o.value === 0 ||
            o.value === "0" ||
            o.value === "false";
          break;
        case "textStyle":
        case "layerStyle":
          fields = ["styleBindings", "styleOverrides", "variableBindings"];
          applyShared(n, string(o.value), true, property);
          break;
        case "horizontalSizing":
        case "verticalSizing": {
          const k =
            o.property === "horizontalSizing" ? "widthMode" : "heightMode";
          const mode = Number(o.value);
          n.style[k] = mode === 1 ? "hug" : mode === 2 ? "fill" : "fixed";
          fields = ["style." + k];
          if (mode === 3)
            warn(l.do_objectID, "相对尺寸覆盖保留源框宽高：" + o.path);
          break;
        }
        case "textHAlign":
          if (
            ["left", "center", "right", "justify"].includes(String(o.value))
          ) {
            n.style.textAlign = o.value as typeof n.style.textAlign;
            fields = ["style.textAlign"];
            n.styleOverrides = [
              ...new Set([...(n.styleOverrides ?? []), "textAlign"]),
            ];
          } else
            warn(l.do_objectID, "未知文字水平对齐覆盖：" + String(o.value));
          break;
        case "textWeight": {
          const weight = object(o.value).NSCTFontWeightTrait;
          if (typeof weight !== "number") {
            warn(l.do_objectID, "无法读取 CoreText 字重覆盖：" + o.path);
            break;
          }
          const weights = [
            [-0.8, 100],
            [-0.6, 200],
            [-0.4, 300],
            [0, 400],
            [0.23, 500],
            [0.3, 600],
            [0.4, 700],
            [0.56, 800],
            [0.62, 900],
          ];
          const best = weights.reduce((a, b) =>
            Math.abs(a[0] - weight) <= Math.abs(b[0] - weight) ? a : b,
          );
          n.style.fontWeight = best[1];
          fields = ["style.fontWeight"];
          n.styleOverrides = [
            ...new Set([...(n.styleOverrides ?? []), "fontWeight"]),
          ];
          break;
        }
        case "textSize": {
          const size = Number(o.value);
          if (!Number.isFinite(size)) {
            warn(l.do_objectID, "无效的实例字号覆盖：" + o.path);
            break;
          }
          n.style.fontSize = bounded(
            size,
            1,
            500,
            (msg) => warn(l.do_objectID, msg),
            "实例字号",
          );
          fields = ["style.fontSize"];
          n.styleOverrides = [
            ...new Set([...(n.styleOverrides ?? []), "fontSize"]),
          ];
          break;
        }
        case "textColor":
        case "fillColor":
        case "color:fill-0":
        case "color:border-0": {
          const key =
            o.property === "textColor"
              ? "color"
              : o.property === "color:border-0"
                ? "stroke"
                : "fill";
          const opacity =
            key === "color"
              ? "colorOpacity"
              : key === "stroke"
                ? "strokeOpacity"
                : "fillOpacity";
          const raw = o.value;
          if (
            typeof raw === "string" &&
            /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw)
          ) {
            n.style[key] = raw.slice(0, 7);
            n.style[opacity] =
              raw.length === 9 ? parseInt(raw.slice(7), 16) / 255 : 1;
          } else if (typeof object(raw).red === "number") {
            n.style[key] = color(raw);
            n.style[opacity] = alpha(raw, (msg) => warn(l.do_objectID, msg));
          } else {
            warn(l.do_objectID, "颜色覆盖值无法读取：" + o.path);
            break;
          }
          const swatch = string(object(raw).swatchID);
          if (swatch && system.variables[swatch])
            n.variableBindings = { ...n.variableBindings, [key]: swatch };
          else if (n.variableBindings) delete n.variableBindings[key];
          fields = ["style." + key, "style." + opacity, "variableBindings"];
          const changed = [key, opacity] as (keyof DesignNode["style"])[];
          if (key === "fill" && fillUsesTextColor(n)) {
            n.style.color = n.style.fill;
            n.style.colorOpacity = n.style.fillOpacity;
            if (n.variableBindings?.fill)
              n.variableBindings.color = n.variableBindings.fill;
            else if (n.variableBindings) delete n.variableBindings.color;
            changed.push("color", "colorOpacity");
            fields.push("style.color", "style.colorOpacity");
          }
          if (n.styleBindings)
            n.styleOverrides = [
              ...new Set([...(n.styleOverrides ?? []), ...changed]),
            ];
          break;
        }
        default: {
          const entry = /^color:(fill|shadow)-(\d+)$/.exec(o.property);
          if (entry && typeof object(o.value).red === "number") {
            const idx = Number(entry[2]),
              fill = entry[1] === "fill",
              k = fill ? "paints" : "shadows";
            const target = fill
              ? n.style.paints?.find((p) => p.id === "p" + idx)
              : n.style.shadows?.[idx];
            if (target) {
              target.color = color(o.value);
              target.opacity = alpha(o.value, (msg) =>
                warn(l.do_objectID, msg),
              );
              fields = ["style." + k];
              n.styleOverrides = [...new Set([...(n.styleOverrides ?? []), k])];
              if (object(o.value).swatchID)
                warn(
                  l.do_objectID,
                  "多重填色或阴影覆盖采用色变量当前值：" + o.path,
                );
              break;
            }
          }
          warn(
            l.do_objectID,
            "未映射覆盖：" + o.property + " (" + o.path + ")",
          );
        }
      }
      if (fields.length)
        n.instanceOverrides = [
          ...new Set([...(n.instanceOverrides ?? []), ...fields]),
        ];
    }
    if (overrides.some((o) => o.property === "stringValue"))
      reflowOverrides(
        live,
        variant.nodes,
        sourceLayers,
        targetPaths,
        (id) => masters.get(id)?.layer,
        warn,
      );
    if (
      l.frame.width !== root.style.width ||
      l.frame.height !== root.style.height
    )
      warn(l.do_objectID, "实例尺寸与主件不同，内部约束及自适应布局需复核");
  }
  for (const m of masters.values()) build(m);
  for (const lib of Object.values(doc.libraries ?? {})) {
    const nodes = templateNodes(lib);
    lib.designSystem = libraryDesignSystem(system, nodes);
    if (doc.fonts) lib.fonts = libraryFonts(doc, nodes, lib.designSystem);
  }
  const active = pages[Math.max(0, number(raw.currentPageIndex))] ?? pages[0];
  doc.activePage = active.id;
  doc.pages = pages.map((p) => {
    const nodes: DesignNode[] = [];
    for (const l of p.layers) render(l, null, nodes, new Map());
    if (p.id === active.id) {
      doc.nodes = nodes;
      return { id: p.id, name: p.name };
    }
    return { id: p.id, name: p.name, nodes };
  });
  if (!Object.keys(doc.libraries!).length) delete doc.libraries;
  await attachSketchTextLayouts(doc, fontContext.fontBytes, warn);
  return {
    document: parseDocument(doc),
    issues: [...issues.values()],
    sourceNodes,
  };
}
