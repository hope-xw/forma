import { assetHash } from "../../domain/asset-bytes";
import { importName, limitedText, requireImportCrypto } from "./types";
import { glassEnvironmentFields } from "../../domain/surface-color";
import { maxPageNodes } from "../../domain/document-limits";
import { z } from "zod";
import { materializeSlots } from "../../domain/component-slots";
import type { DesignDocument, DesignNode } from "../../domain/document";
import type {
  ComponentLibrary,
  ComponentVariant,
} from "../../domain/library-schema";
import {
  libraryDesignSystem,
  templateNodes,
} from "../../domain/library-design-system";
import { stableHash } from "../../domain/stable-hash";
import { openDesignArchive } from "./archive";
import { importImageBytes } from "./image";
import { prepareGlyphShapes } from "./figma-glyphs";
import { readFigmaCanvas } from "./figma-kiwi";
import {
  makeLayer,
  guid,
  str,
  obj,
  rows,
  hex,
  type Fields,
  type LayerContext,
} from "./figma-layer";
import { buildStyles, bindStyles } from "./figma-styles";
import type { ExternalDesignImport, ImportIssue } from "./types";

const sourceGuid = z.object({
  sessionID: z.number().int().nonnegative(),
  localID: z.number().int().nonnegative(),
});
const sourceNode = z.looseObject({
  guid: sourceGuid,
  type: z.string().min(1),
  name: z.string().optional(),
  phase: z.string().optional(),
  parentIndex: z.object({ guid: sourceGuid, position: z.string() }).optional(),
});
const snapshot = z.looseObject({
  nodeChanges: z
    .array(
      z.union([
        z.looseObject({ guid: sourceGuid, phase: z.literal("REMOVED") }),
        sourceNode,
      ]),
    )
    .min(1)
    .max(100000),
  blobs: z.array(z.object({ bytes: z.instanceof(Uint8Array) })).optional(),
});
type Ref = NonNullable<DesignNode["instance"]>;
const byPosition = (a: Fields, b: Fields) => {
  const x = str(obj(a.parentIndex).position),
    y = str(obj(b.parentIndex).position);
  return x < y ? -1 : x > y ? 1 : 0;
};
function indexSource(nodes: Fields[]) {
  const tree = new Map<string, Fields[]>(),
    index = new Map<string, Fields>();
  for (const n of nodes) {
    const id = guid(n.guid);
    if (index.has(id)) throw Error("Figma 图层 ID 重复 " + id);
    index.set(id, n);
    const parent = guid(obj(n.parentIndex).guid);
    const child = tree.get(parent) ?? [];
    child.push(n);
    tree.set(parent, child);
  }
  for (const n of nodes) {
    const trail = new Set<string>();
    let cursor: Fields | undefined = n;
    while (cursor?.parentIndex) {
      const id = guid(obj(cursor.parentIndex).guid);
      if (trail.has(id) || trail.size > 250)
        throw Error("Figma 图层循环或嵌套过深 " + id);
      trail.add(id);
      cursor = index.get(id);
      if (!cursor) throw Error("Figma 图层缺少父级 " + id);
    }
  }
  for (const children of tree.values()) children.sort(byPosition);
  return { tree, index };
}
interface Entry {
  layer: DesignNode;
  source: Fields;
  path: string;
  key: string;
}
export async function importFigma(
  bytes: Uint8Array,
  filename: string,
): Promise<ExternalDesignImport> {
  const archive =
    bytes[0] === 80 && bytes[1] === 75 ? openDesignArchive(bytes) : undefined;
  const canvas = readFigmaCanvas(archive ? archive.read("canvas.fig") : bytes);
  requireImportCrypto();
  return importFigmaSnapshot(canvas, filename, await assetHash(bytes), archive);
}
export async function importFigmaSnapshot(
  canvas: ReturnType<typeof readFigmaCanvas>,
  filename: string,
  hash: string,
  archive?: ReturnType<typeof openDesignArchive>,
): Promise<ExternalDesignImport> {
  const parsed = snapshot.safeParse(canvas.message);
  if (!parsed.success)
    throw Error(
      "Figma 节点快照不完整：" + parsed.error.issues[0]?.path.join("."),
    );
  const records = parsed.data.nodeChanges;
  const live = records.filter((r) => r.phase !== "REMOVED");
  if (live.some((r) => r.phase !== undefined && r.phase !== "CREATED"))
    throw Error("不支持增量 Figma 消息，需要保存完整本地副本");
  const removed = new Set(
    records.filter((r) => r.phase === "REMOVED").map((r) => guid(r.guid)),
  );
  if (removed.size) {
    const children = new Map<string, string[]>();
    for (const n of live) {
      const parent = guid(obj(n.parentIndex).guid);
      const siblings = children.get(parent) ?? [];
      siblings.push(guid(n.guid));
      children.set(parent, siblings);
    }
    for (const id of removed)
      for (const child of children.get(id) ?? []) removed.add(child);
  }
  const source = live.filter((n) => !removed.has(guid(n.guid))) as z.infer<
    typeof sourceNode
  >[];
  const { tree, index } = indexSource(source);
  const diagnostics = new Map<string, ImportIssue>();
  function report(node: string, detail: string) {
    const k = JSON.stringify([node, detail]);
    if (!diagnostics.has(k)) diagnostics.set(k, { node, detail });
  }
  const doc: DesignDocument = {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    name: importName(filename.replace(/\.fig$/i, ""), "Figma"),
    revision: 0,
    nodes: [],
    tokens: {},
    pages: [],
    libraries: {},
    images: {},
  };
  if (canvas.extra) report("canvas.fig", "附加二进制区段未映射");
  const ctx: LayerContext = {
    assetKeys: new Map(
      source
        .filter((n) => typeof n.key === "string")
        .map((n) => [str(n.key), guid(n.guid)]),
    ),
    blobs: parsed.data.blobs ?? [],
    images: new Map(),
    report,
  };
  for (const path of archive?.names ?? []) {
    if (!/^images\/[a-f\d]{40}$/i.test(path)) continue;
    const hash = path.slice(7),
      data = archive!.read(path);
    try {
      const { id, image } = await importImageBytes(data, hash);
      doc.images![id] = image;
      ctx.images.set(hash.toLowerCase(), id);
    } catch (e) {
      report(path, e instanceof Error ? e.message : "位图格式不支持");
    }
  }
  const glyphs = prepareGlyphShapes(ctx);
  const system = buildStyles(source, ctx);
  doc.designSystem = system;
  const root = tree.get("") ?? [];
  const profile = str(root[0]?.documentColorProfile);
  if (profile === "DISPLAY_P3") doc.colorProfile = "display-p3";
  else if (profile === "SRGB") doc.colorProfile = "srgb";
  else if (profile) report("DOCUMENT", "未识别文件色域 " + profile);
  if (root.length !== 1 || root[0].type !== "DOCUMENT")
    throw Error("Figma 文档根无效");
  const pages = (tree.get(guid(root[0].guid)) ?? []).filter(
    (p) => p.type === "CANVAS" && p.internalOnly !== true,
  );
  if (!pages.length) throw Error("Figma 文件没有普通页面");
  const refs = new Map<string, Ref>(),
    sets = new Map<string, Ref>(),
    cache = new Map<string, Entry[]>();
  const groups = new Map<string, Fields[]>();
  for (const symbol of source.filter(
    (r) => r.type === "SYMBOL" && !r.styleType,
  )) {
    const id = guid(symbol.guid),
      parent = guid(symbol.parentIndex?.guid);
    const group = index.get(parent)?.isStateGroup ? parent : id;
    const members = groups.get(group) ?? [];
    members.push(symbol);
    groups.set(group, members);
  }
  // Figma stores customized freeform slot contents as private frame subtrees.
  // Index these as separate portable variants so instance resets and swaps still
  // resolve the author's original component, including nested instance links.
  const contentGroups = new Map<string, string>();
  const slotCounts = new Map<string, number>();
  const contentRefs = new Map<string, string>();
  for (const n of source) {
    for (const props of [
      n.componentPropAssignments,
      ...rows(obj(n.symbolData).symbolOverrides).map(
        (p) => p.componentPropAssignments,
      ),
    ]) {
      for (const assignment of rows(props)) {
        const contents = guid(
          obj(obj(obj(assignment.varValue).value).slotContentIdValue).guid,
        );
        if (!contents || contentRefs.has(contents)) continue;
        const holder = index.get(contents);
        if (holder?.isSlotContent !== true || holder.type !== "FRAME") continue;
        const def = guid(assignment.defID);
        const count = slotCounts.get(def) ?? 0;
        slotCounts.set(def, count + 1);
        const chunk = Math.floor(count / 200);
        const key = "fig-slot-" + def + (chunk ? "-" + chunk : "");
        const members = groups.get(key) ?? [];
        members.push(holder);
        groups.set(key, members);
        contentGroups.set(key, str(holder.name) || "Slot");
        contentRefs.set(contents, key);
      }
    }
  }
  const prefix = "fig-lib-" + hash.slice(0, 24) + "-";
  // Keep each library's mode/asset closure small when validating large kits.
  let groupIndex = 0;
  for (const [group, symbols] of groups) {
    symbols.sort(byPosition);
    const lib = prefix + Math.floor(groupIndex++ / 32);
    if (symbols.length > 200)
      throw Error("Figma 组件集超过 200 个变体：" + group);
    for (const sym of symbols) {
      const ref = {
        libraryId: lib,
        componentId: group,
        variantId: guid(sym.guid),
      };
      refs.set(guid(sym.guid), ref);
      if (group !== ref.variantId && !contentGroups.has(group))
        sets.set(group, ref);
    }
  }
  const originSurfaces = new Map<
    string,
    ReturnType<typeof glassEnvironmentFields> | undefined
  >();
  function sourceEnvironment(parent: Fields | undefined) {
    const key = guid(parent?.guid);
    if (!key) return;
    if (originSurfaces.has(key)) return originSurfaces.get(key);
    let current = parent;
    const surfaces: Fields[] = [];
    while (current) {
      if (current.isStateGroup || current.type === "SECTION")
        surfaces.push(current);
      current = index.get(guid(obj(current.parentIndex).guid));
    }
    const paints: { color: string; alpha: number }[] = [];
    for (const group of surfaces.reverse())
      for (const paint of rows(group.fillPaints)) {
        if (paint.type !== "SOLID" || paint.visible === false) continue;
        const alpha =
          Number(paint.opacity ?? 1) * Number(obj(paint.color).a ?? 1);
        if (alpha <= 0) continue;
        paints.push({ color: hex(paint.color), alpha: Math.min(1, alpha) });
      }
    const environment = paints.length
      ? glassEnvironmentFields(paints)
      : undefined;
    originSurfaces.set(key, environment);
    return environment;
  }
  function layer(
    raw: Fields,
    id: string,
    parent: string | null,
    authored?: Fields,
  ) {
    const n = makeLayer(raw, id, parent, ctx);
    const parentRaw = index.get(guid(obj(raw.parentIndex).guid));
    if (n.type === "section" && parent) {
      let ancestor = parentRaw;
      while (ancestor?.type === "SECTION")
        ancestor = index.get(guid(obj(ancestor.parentIndex).guid));
      if (ancestor?.type !== "CANVAS") {
        n.type = "frame";
        report(id, "嵌套在普通图层中的分区已转换为画框");
      }
    }
    if (raw.type === "SYMBOL" || raw.type === "INSTANCE") {
      const environment = sourceEnvironment(parentRaw);
      if (environment) Object.assign(n.style, environment);
    }
    if (parentRaw?.type === "BOOLEAN_OPERATION" && n.vector) {
      // An unpainted source operand still contributes its contours to the Boolean.
      for (const path of n.vector.paths) path.fill = true;
    }
    const horizontal = parentRaw?.stackMode === "HORIZONTAL",
      vertical = parentRaw?.stackMode === "VERTICAL";
    if (horizontal || vertical) {
      if (raw.stackChildAlignSelf === "STRETCH")
        n.style[horizontal ? "heightMode" : "widthMode"] = "fill";
      if (
        typeof raw.stackChildPrimaryGrow === "number" &&
        raw.stackChildPrimaryGrow > 0
      )
        n.style[horizontal ? "widthMode" : "heightMode"] = "fill";
    }
    bindStyles(raw, n, system, ctx, {
      fill: !!authored?.fillPaints && !authored.styleIdForFill,
      stroke: !!authored?.strokePaints && !authored.styleIdForStrokeFill,
    });
    if (
      rows(raw.componentPropRefs).some(
        (f) => f.componentPropNodeField === "SLOT_CONTENT_ID",
      )
    )
      n.nestedSlot = true;
    const set = sets.get(guid(raw.guid));
    if (set) {
      n.type = "group";
      n.componentSet = {
        libraryId: set.libraryId,
        componentId: set.componentId,
      };
    }
    return n;
  }
  function patches(r: Fields) {
    const map = new Map<string, Fields>();
    for (const patch of [
      ...rows(r.derivedSymbolData),
      ...rows(obj(r.symbolData).symbolOverrides),
    ]) {
      const path = rows(obj(patch.guidPath).guids).map(guid).join("/");
      if (path) map.set(path, { ...map.get(path), ...patch });
    }
    return map;
  }
  function asTemplate(entry: Entry): DesignNode {
    const n = { ...entry.layer, templateKey: entry.key };
    if (n.instance && n.parentId) {
      n.nestedSlot = true;
      n.nestedSource = n.instance;
    }
    delete n.instance;
    if (!n.parentId) n.style = { ...n.style, x: 0, y: 0 };
    return n;
  }
  // Apply exposed Figma properties to their defining layers before expanding.
  function instanceEntries(
    raw: Fields,
    symbol: Fields,
    instance: DesignNode,
    changes: Map<string, Fields>,
    authored: Map<string, Fields>,
  ) {
    let entries = template(symbol);
    function assignmentValues(assignments: unknown, master: Fields) {
      const values = new Map(
        rows(assignments).map((a) => [
          guid(a.defID),
          { ...obj(obj(a.varValue).value), ...obj(a.value) },
        ]),
      );
      for (const def of rows(master.componentPropDefs)) {
        const inherited = values.get(guid(def.parentPropDefId));
        if (inherited && !values.has(guid(def.id)))
          values.set(guid(def.id), inherited);
      }
      return values;
    }
    const scoped = new Map([
      ["", assignmentValues(raw.componentPropAssignments, symbol)],
    ]);
    for (let entryIndex = 1; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex],
        scope = entry.path.split("/").slice(0, -1).join("/");
      const values = scoped.get(scope);
      const patch = { ...changes.get(entry.path) };
      for (const field of rows(entry.source.componentPropRefs)) {
        const value = values?.get(guid(field.defID));
        if (!value) continue;
        if (field.componentPropNodeField === "TEXT_DATA" && value.textValue) {
          patch.textData = value.textValue;
          authored.set(entry.path, {
            ...authored.get(entry.path),
            textData: patch.textData,
          });
        }
        if (
          field.componentPropNodeField === "VISIBLE" &&
          typeof value.boolValue === "boolean"
        ) {
          patch.visible = value.boolValue;
          authored.set(entry.path, {
            ...authored.get(entry.path),
            visible: patch.visible,
          });
        }
        if (
          field.componentPropNodeField === "SLOT_CONTENT_ID" &&
          value.slotContentIdValue
        )
          patch.slotContentTarget = obj(value.slotContentIdValue).guid;
        if (
          field.componentPropNodeField === "OVERRIDDEN_SYMBOL_ID" &&
          value.guidValue
        )
          patch.overriddenSymbolID = value.guidValue;
      }
      if (Object.keys(patch).length) changes.set(entry.path, patch);
      const contentTarget = guid(patch.slotContentTarget);
      const target = contentTarget || guid(patch.overriddenSymbolID),
        targetRef = refs.get(target);
      const masterId = guid(obj(entry.source.symbolData).symbolID);
      if (patch.componentPropAssignments)
        scoped.set(
          entry.path,
          assignmentValues(
            patch.componentPropAssignments,
            index.get(target || masterId) ?? {},
          ),
        );
      if (
        !target ||
        target === masterId ||
        target === "fig-4294967295-4294967295"
      )
        continue;
      if (!targetRef || (!entry.layer.instance && !entry.layer.nestedSlot)) {
        report(guid(raw.guid), "嵌套替换主件无法解析 " + entry.path);
        continue;
      }
      const replacement = template(index.get(target)!);
      const variant: ComponentVariant = {
        id: targetRef.variantId,
        name: target,
        properties: {},
        nodes: replacement.map(asTemplate),
      };
      const library: ComponentLibrary = {
        format: "forma/library",
        version: 1,
        id: targetRef.libraryId,
        name: target,
        description: "",
        revision: 1,
        source: { name: "Figma", license: "" },
        components: [
          {
            id: targetRef.componentId,
            name: target,
            category: "Figma",
            description: "",
            variants: [variant],
          },
        ],
      };
      const base: ComponentVariant = {
        id: "current",
        name: "current",
        properties: {},
        nodes: entries.map(asTemplate),
      };
      const swapped = materializeSlots(
        { ...doc, libraries: { [library.id]: library } },
        base,
        { [entry.key]: targetRef },
      );
      const originalById = new Map(entries.map((e) => [e.layer.id, e])),
        inner = new Map(replacement.map((e) => [e.key, e]));
      const swappedIds = new Set([entry.layer.id]);
      let depth = 0,
        ancestor = originalById.get(entry.layer.parentId!);
      while (ancestor) {
        if (ancestor.layer.nestedSlot || ancestor.layer.instance) depth++;
        ancestor = originalById.get(ancestor.layer.parentId!);
      }
      entries = swapped.nodes.map((n) => {
        const old = originalById.get(n.id);
        if (n.id === entry.layer.id)
          return {
            ...entry,
            layer: contentTarget ? n : { ...n, instance: targetRef },
            source: {
              ...entry.source,
              symbolData: {
                ...obj(entry.source.symbolData),
                symbolID: patch.overriddenSymbolID,
              },
            },
          };
        if (!n.parentId || !swappedIds.has(n.parentId)) return old!;
        swappedIds.add(n.id);
        const sourceEntry = inner.get(n.nestedPath?.[depth] ?? n.nestedKey!)!;

        return {
          layer: n,
          source: sourceEntry.source,
          key: n.templateKey!,
          path: contentTarget
            ? [scope, sourceEntry.path].filter(Boolean).join("/")
            : entry.path + "/" + sourceEntry.path,
        };
      });
      instance.instance!.slots ??= {};
      instance.instance!.slots[entry.key] = targetRef;
    }
    const active = new Set(
      Object.values(instance.instance!.slots ?? {}).map((ref) => ref.variantId),
    );
    for (const assignment of rows(raw.componentPropAssignments)) {
      const holder = guid(
        obj(obj(obj(assignment.varValue).value).slotContentIdValue).guid,
      );
      const target = refs.get(holder);
      if (!target || active.has(holder)) continue;
      const own = rows(symbol.componentPropDefs).find(
        (def) => guid(def.id) === guid(assignment.defID),
      );
      const property = guid(own?.parentPropDefId ?? assignment.defID);
      if (!property) continue;
      instance.instance!.slotProperties ??= {};
      instance.instance!.slotProperties[property] = target;
    }
    return entries;
  }
  function explicitFields(patch: Fields | undefined): string[] {
    if (!patch) return [];
    const fields = new Set<string>();
    const mappings: Record<string, string[]> = {
      fillPaints: [
        "style.fill",
        "style.fillOpacity",
        "style.color",
        "style.colorOpacity",
        "style.gradient",
        "style.paints",
        "image",
      ],
      strokePaints: [
        "style.stroke",
        "style.strokeOpacity",
        "style.strokeVisible",
        "style.strokeBlendMode",
        "style.strokePaints",
      ],
      effects: ["style.shadows", "style.blur", "style.backdropBlur"],
      opacity: ["style.opacity"],
      visible: ["hidden"],
      textData: ["text", "textRuns"],
      fontName: ["style.fontFamily", "style.fontStyle", "style.fontWeight"],
      fontSize: ["style.fontSize"],
      strokeWeight: ["style.strokeWidth"],
      size: ["style.width", "style.height"],
      transform: [
        "style.x",
        "style.y",
        "style.rotation",
        "style.flipX",
        "style.flipY",
      ],
      styleIdForText: ["styleBindings"],
      styleIdForFill: ["styleBindings"],
      styleIdForEffect: ["styleBindings"],
      styleIdForStrokeFill: ["styleBindings"],
      variableConsumptionMap: ["variableBindings"],
      cornerRadius: ["style.radius"],
      cornerSmoothing: ["style.cornerSmoothing"],
      borderTopWeight: ["style.strokeSides"],
      borderBottomWeight: ["style.strokeSides"],
      borderLeftWeight: ["style.strokeSides"],
      borderRightWeight: ["style.strokeSides"],
    };
    for (const key of Object.keys(patch))
      for (const field of Object.hasOwn(mappings, key) ? mappings[key] : [])
        fields.add(field);
    return [...fields];
  }
  const building = new Set<string>();
  let expanded = 0;
  function reserve(out: Entry[]) {
    if (++expanded > 500000 || out.length >= maxPageNodes)
      throw Error("Figma 展开超出 500000 条总记录或 50000 条单页记录");
  }
  function expand(
    raw: Fields,
    parent: string | null,
    out: Entry[],
    key: string,
    path: string,
  ) {
    reserve(out);
    const id = guid(raw.guid),
      ref = refs.get(guid(obj(raw.symbolData).symbolID));
    const symbol = ref ? index.get(ref.variantId) : undefined;
    const authored = new Map<string, Fields>();
    if (symbol)
      for (const override of rows(obj(raw.symbolData).symbolOverrides)) {
        const path = rows(obj(override.guidPath).guids).map(guid).join("/");
        if (path) authored.set(path, { ...authored.get(path), ...override });
      }
    const n = layer(
      symbol ? { ...symbol, ...raw } : raw,
      id,
      parent,
      ref ? authored.get(ref.variantId) : undefined,
    );
    out.push({
      source: symbol ? { ...symbol, ...raw } : raw,
      layer: n,
      key,
      path,
    });
    if (raw.type === "INSTANCE") {
      if (!ref || !symbol) {
        report(id, "实例主件未随文件提供");
        return;
      }
      n.instance = { ...ref };
      n.templateKey = "root";
      const rootFields = explicitFields(authored.get(ref.variantId));
      if (rootFields.length) n.instanceOverrides = rootFields;
      const changes = patches(raw),
        entries = instanceEntries(raw, symbol, n, changes, authored);
      const ids = new Map<string, string>([[ref.variantId, n.id]]);
      const realized = new Set([ref.variantId]);
      for (const entry of entries.slice(1)) {
        reserve(out);
        const childId = "fig-copy-" + stableHash(id + "/" + entry.path);
        ids.set(entry.layer.id, childId);
        const childParent = ids.get(entry.layer.parentId!)!,
          patch = changes.get(entry.path);
        const changed = patch ? { ...entry.source, ...patch } : entry.source;
        // The master's layout cache describes its original string and face.
        // An instance text/style override needs its own derived glyph table.
        if (
          patch &&
          !patch.derivedTextData &&
          [
            "textData",
            "fontName",
            "fontSize",
            "lineHeight",
            "letterSpacing",
            "textAlignHorizontal",
            "textAlignVertical",
            "leadingTrim",
            "size",
          ].some(
            (k) =>
              k in patch &&
              JSON.stringify(patch[k]) !== JSON.stringify(entry.source[k]),
          )
        )
          delete changed.derivedTextData;
        const copy = patch
          ? layer(changed, childId, childParent, authored.get(entry.path))
          : {
              ...structuredClone(entry.layer),
              id: childId,
              parentId: childParent,
            };
        if (entry.layer.instance || entry.layer.nestedSlot) {
          copy.nestedSlot = true;
          copy.nestedSource = structuredClone(
            entry.layer.instance ?? entry.layer.nestedSource,
          );
        }
        if (entry.layer.nestedKey) {
          copy.nestedKey = entry.layer.nestedKey;
          copy.nestedPath = entry.layer.nestedPath?.slice();
        }
        delete copy.instance;
        const fields = explicitFields(authored.get(entry.path));
        if (fields.length) copy.instanceOverrides = fields;
        copy.templateKey = entry.key;
        out.push({
          layer: copy,
          source: changed,
          key: key + "/" + entry.key,
          path: path + "/" + entry.path,
        });
        realized.add(entry.path);
      }
      const unresolved = new Map<
        string,
        { count: number; samples: string[] }
      >();
      for (const k of changes.keys()) {
        if (realized.has(k)) continue;
        const origin = authored.has(k) ? "显式实例" : "派生缓存";
        const label =
          origin +
          (k.split("/").some((g) => !index.has(g))
            ? "覆盖路径的 GUID 在源快照中缺失"
            : "覆盖路径不在当前实例主件内");
        const issue = unresolved.get(label) ?? { count: 0, samples: [] };
        issue.count++;
        if (issue.samples.length < 3) {
          const fields = Object.keys(authored.get(k) ?? changes.get(k)!).filter(
            (f) => f !== "guidPath" && f !== "overrideLevel",
          );
          issue.samples.push(
            limitedText(k + " [" + fields.join(",") + "]", 240),
          );
        }
        unresolved.set(label, issue);
      }
      for (const [label, { count, samples }] of unresolved)
        report(
          id,
          `${label}（共 ${count} 处，如 ${samples.join("、")}${count > samples.length ? " 等" : ""}）`,
        );
      return;
    }
    const children = tree.get(id) ?? [],
      occurrence = new Map<string, number>();
    for (const child of children) {
      if (
        child.styleType ||
        ["VARIABLE", "VARIABLE_SET", "CODE_LIBRARY", "BRUSH"].includes(
          str(child.type),
        )
      )
        continue;
      const name = str(child.name) || str(child.type),
        nth = occurrence.get(name) ?? 0;
      occurrence.set(name, nth + 1);
      expand(child, id, out, key + "/" + name + ":" + nth, guid(child.guid));
    }
  }
  function template(symbol: Fields): Entry[] {
    const id = guid(symbol.guid),
      cached = cache.get(id);
    if (cached) return cached;
    if (building.has(id) || building.size > 128)
      throw Error("Figma 主件依赖成环或过深 " + id);
    building.add(id);
    const out: Entry[] = [];
    expand(symbol, null, out, "root", id);
    for (const entry of out) {
      if (entry.layer.templateKey) {
        const previous =
          entry.layer.nestedPath ??
          (entry.layer.nestedKey ? [entry.layer.nestedKey] : []);
        entry.layer.nestedKey = entry.layer.templateKey;
        if (previous.length)
          entry.layer.nestedPath = [entry.layer.templateKey, ...previous];
      }
      if (entry.key.length > 118)
        entry.key = "fig-key-" + stableHash(entry.key);
    }
    building.delete(id);
    cache.set(id, out);
    return out;
  }
  for (const page of pages) {
    const pid = guid(page.guid),
      flat: Entry[] = [];
    for (const child of tree.get(pid) ?? []) {
      if (
        child.styleType ||
        ["VARIABLE", "VARIABLE_SET", "CODE_LIBRARY", "BRUSH"].includes(
          str(child.type),
        )
      )
        continue;
      expand(child, null, flat, "root", guid(child.guid));
    }
    glyphs.apply(doc, flat);
    const nodes = flat.map((e) => e.layer);
    if (nodes.length > maxPageNodes)
      throw Error("页面展开超过 Forma 50,000 图层限制：" + str(page.name));
    const pageInfo = { id: pid, name: importName(str(page.name), "页面", 120) };
    if (!doc.activePage) {
      doc.activePage = pid;
      doc.nodes = nodes;
      doc.pages!.push(pageInfo);
      if (page.backgroundColor) doc.pageBackground = hex(page.backgroundColor);
    } else
      doc.pages!.push({
        ...pageInfo,
        nodes,
        ...(page.backgroundColor
          ? { pageBackground: hex(page.backgroundColor) }
          : {}),
      });
  }
  const actual = new Set(
    [doc.nodes, ...doc.pages!.map((p) => p.nodes ?? [])]
      .flat()
      .map((n) => n.id),
  );
  // Expansion, including nested swaps, determines the actual cost of each variant.
  // Keep normal sets together. A set larger than one library spans consecutive libraries.
  const packed: { group: string; symbols: Fields[] }[] = [];
  let libraryIndex = 0,
    nodeCount = 0,
    componentCount = 0;
  for (const [group, symbols] of groups) {
    const sizes = symbols.map((s) => template(s).length);
    const total = sizes.reduce((sum, n) => sum + n, 0);
    if (
      componentCount &&
      (componentCount >= 32 || nodeCount + total > 45_000)
    ) {
      libraryIndex++;
      nodeCount = componentCount = 0;
    }
    let part: Fields[] = [];
    for (const [i, symbol] of symbols.entries()) {
      if (sizes[i] > 1000)
        throw Error("组件展开超过 1000 图层：" + str(symbol.name));
      if (nodeCount + sizes[i] > 45_000) {
        packed.push({ group, symbols: part });
        part = [];
        libraryIndex++;
        nodeCount = componentCount = 0;
      }
      if (!part.length) componentCount++;
      part.push(symbol);
      nodeCount += sizes[i];
      refs.get(guid(symbol.guid))!.libraryId = prefix + libraryIndex;
    }
    packed.push({ group, symbols: part });
  }
  function updateReferences(n: DesignNode) {
    for (const ref of [
      n.instance,
      n.nestedSource,
      ...Object.values(n.instance?.slots ?? {}),
      ...Object.values(n.instance?.slotProperties ?? {}),
      ...Object.values(n.nestedSource?.slotProperties ?? {}),
    ]) {
      const packedRef = ref && refs.get(ref.variantId);
      if (ref && packedRef) ref.libraryId = packedRef.libraryId;
    }
    if (n.componentSet) {
      const first = groups.get(n.componentSet.componentId)?.[0];
      if (first)
        n.componentSet.libraryId = refs.get(guid(first.guid))!.libraryId;
    }
  }
  for (const entries of cache.values())
    for (const { layer } of entries) updateReferences(layer);
  for (const group of [doc.nodes, ...doc.pages!.map((p) => p.nodes ?? [])])
    group.forEach(updateReferences);
  for (const { group, symbols } of packed) {
    const first = guid(symbols[0].guid),
      ref = refs.get(first)!,
      groupName = importName(
        contentGroups.get(group) ?? str(index.get(group)?.name),
        group,
      );
    const libraries = doc.libraries!;
    const library: ComponentLibrary = (libraries[ref.libraryId] ??= {
      format: "forma/library",
      version: 1,
      id: ref.libraryId,
      name: "Figma 组件 " + (Number(ref.libraryId.split("-").at(-1)) + 1),
      description: "",
      revision: 1,
      source: { name: doc.name, license: "遵循源设计文件许可" },
      components: [],
    });
    const exposed: NonNullable<
      ComponentLibrary["components"][number]["exposed"]
    > = [];
    const defNames = new Set<string>(),
      defIds = new Set<string>();
    const setDefs = rows(index.get(group)?.componentPropDefs);
    const variants: ComponentVariant[] = symbols.map((s, i) => {
      const id = guid(s.guid),
        entries = template(s);
      const nodes = entries.map(asTemplate);
      glyphs.apply(
        doc,
        nodes.map((layer, i) => ({ layer, source: entries[i].source })),
      );
      const defs = rows(s.componentPropDefs);
      for (const entry of entries.filter((e) => !e.path.includes("/"))) {
        for (const binding of rows(entry.source.componentPropRefs)) {
          const own = defs.find((v) => guid(v.id) === guid(binding.defID));
          const def =
            setDefs.find(
              (v) => guid(v.id) === guid(own?.parentPropDefId ?? binding.defID),
            ) ?? own;
          if (!def) continue;
          const field = str(binding.componentPropNodeField);
          const kind =
            field === "VISIBLE"
              ? "visible"
              : field === "TEXT_DATA"
                ? "text"
                : field === "OVERRIDDEN_SYMBOL_ID" ||
                    field === "SLOT_CONTENT_ID"
                  ? "swap"
                  : undefined;
          const id = guid(def.id),
            name = limitedText(str(def.name).trim(), 100);
          if (
            !kind ||
            !name ||
            defIds.has(id) ||
            defNames.has(name) ||
            exposed.length >= 100
          )
            continue;
          if (
            (kind === "swap" &&
              !entry.layer.instance &&
              !entry.layer.nestedSlot) ||
            (kind === "text" && entry.layer.type !== "text")
          )
            continue;
          exposed.push({
            id,
            name,
            kind,
            target: entry.key,
          });
          defIds.add(id);
          defNames.add(name);
        }
      }
      const props = Object.fromEntries(
        str(s.name)
          .split(",")
          .map((x) => x.trim().split("="))
          .filter((x) => x.length === 2 && x[0] && x[0].length <= 128)
          .map(([k, v]) => [k, importName(v, "默认")]),
      );
      for (const assignment of rows(s.variantPropSpecs)) {
        const def = setDefs.find(
          (d) => guid(d.id) === guid(assignment.propDefId),
        );
        if (
          typeof def?.name === "string" &&
          typeof assignment.value === "string" &&
          def.name.length <= 128
        )
          Object.defineProperty(props, def.name, {
            value: importName(assignment.value, "默认"),
            enumerable: true,
            configurable: true,
          });
      }
      return {
        id,
        name: importName(str(s.name), id),
        properties: props,
        nodes,
        ...(i > 0 && actual.has(id) && actual.has(first)
          ? { masterNodeId: id }
          : {}),
      };
    });
    library.components.push({
      id: group,
      name: groupName,
      category: contentGroups.has(group) ? "Figma 插槽内容" : "Figma",
      description: "",
      variants,
      ...(exposed.length ? { exposed } : {}),
      ...(actual.has(first)
        ? { master: { documentId: doc.id, nodeId: first } }
        : {}),
    });
  }
  for (const lib of Object.values(doc.libraries!)) {
    const nodes = templateNodes(lib);
    lib.designSystem = libraryDesignSystem(system, nodes);
    if (nodes.some((n) => n.image))
      lib.images = Object.fromEntries(
        nodes
          .filter((n) => n.image)
          .map((n) => [n.image!.assetId, doc.images![n.image!.assetId]]),
      );
  }
  glyphs.finish();
  return {
    document: doc,
    issues: [...diagnostics.values()],
    sourceNodes: source.length,
  };
}
