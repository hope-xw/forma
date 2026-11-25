import { strokePaintOverrideKeys } from "./stroke-paint-overrides";
import { applyVariantChange, variantOperations } from "./variant-authoring";
import { componentRef } from "./node";
import { referencedComponents } from "./component-slots";
import { fontAsset, fontId, mergeFonts } from "./fonts";
import { integrateLibrarySystem } from "./library-design-system";
import { designSystemSchema } from "./design-system-schema";
import { resolveNode } from "./design-system";
import {
  planBindVariable,
  planApplyReusableStyle,
} from "./design-system-actions";
import {
  isNestedProperty,
  variableProperties,
  styleGroups,
} from "./design-properties";
import { z } from "zod";
import {
  documentSchema,
  nodeSchema,
  cloneDocument,
  parseDocument,
  styleSchema,
  type DesignDocument,
} from "./document";
import {
  ancestors,
  isContainer,
  isLocked,
  subtreeIds,
  instanceAncestor,
  instanceOwner,
  instanceGeometryKeys,
} from "./tree";
import {
  librarySchema,
  exposedProperty,
  type LibraryComponent,
} from "./library-schema";
import { imageId, imageSchema } from "./images";
import {
  refreshMasterSystems,
  synchronizeMasters,
  updatePublishedLibrary,
} from "./component-masters";
import { resizeAnchoredLayers } from "./constraints";
import { replaceText } from "./rich-text";
import { booleanVector } from "./boolean-shapes";
import {
  validateInstanceStructure,
  instantiateComponent,
  planSwitchInstance,
  planSwapInstance,
  planSetSlot,
  planDetachInstance,
} from "./library";
const operationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("setGuides"),
    guides: documentSchema.shape.guides.unwrap(),
  }),
  z.object({ type: z.literal("putFont"), id: fontId, font: fontAsset }),
  z.object({ type: z.literal("flattenBoolean"), id: z.string() }),
  z.object({ type: z.literal("putImage"), id: imageId, image: imageSchema }),
  z.object({
    type: z.literal("bindVariable"),
    id: z.string(),
    property: z.enum(variableProperties),
    variableId: z.string().optional(),
  }),
  z.object({
    type: z.literal("applyStyle"),
    slot: z.enum(["paint", "stroke", "text", "grid", "effect"]).optional(),
    id: z.string(),
    styleId: z.string(),
  }),
  z.object({ type: z.literal("setDesignSystem"), system: designSystemSchema }),
  z.object({
    type: z.literal("switchInstance"),
    id: z.string(),
    variantId: z.string(),
    reset: z.boolean().optional(),
  }),
  ...variantOperations,
  z.object({
    type: z.literal("setComponentProperties"),
    id: z.string(),
    libraryId: z.string(),
    componentId: z.string(),
    properties: z.array(exposedProperty).max(100),
  }),
  z.object({
    type: z.literal("setInstanceSlot"),
    id: z.string(),
    property: z.string(),
    value: componentRef.optional(),
  }),
  z.object({
    type: z.literal("swapInstance"),
    id: z.string(),
    libraryId: z.string(),
    componentId: z.string(),
    variantId: z.string(),
  }),
  z.object({ type: z.literal("detachInstance"), id: z.string() }),
  z.object({
    type: z.literal("insertComponent"),
    libraryId: z.string(),
    componentId: z.string(),
    variantId: z.string(),
    parentId: z.string().nullable(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  }),
  z.object({
    type: z.literal("updateLibrary"),
    library: librarySchema,
    componentIds: z.array(z.string()).max(1000).optional(),
    decisions: z.record(z.string(), z.enum(["local", "incoming"])).optional(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("putLibrary"), library: librarySchema }),
  z.object({
    type: z.literal("removeLibrary"),
    libraryId: z.string().min(1).max(128),
  }),
  z.object({ type: z.literal("create"), node: nodeSchema }),
  z.object({
    type: z.literal("update"),
    id: z.string(),
    patch: nodeSchema
      .pick({
        name: true,
        text: true,
        textRuns: true,
        hidden: true,
        locked: true,
        devStatus: true,
        exportSettings: true,
        annotations: true,
        fillToken: true,
        instance: true,
        templateKey: true,
        vector: true,
        control: true,
        interaction: true,
        interactions: true,
        image: true,
        sourceTextShape: true,
        sourceTextLayout: true,
        booleanOperation: true,
        operandOperation: true,
        compoundWindingRule: true,
        maskSourceId: true,
        maskType: true,
        siblingMask: true,
        variableBindings: true,
        variableModes: true,
        styleBindings: true,
        styleOverrides: true,
        instanceOverrides: true,
      })
      .partial(),
    style: styleSchema.partial().optional(),
  }),
  z.object({ type: z.literal("remove"), id: z.string() }),
  z.object({
    type: z.literal("move"),
    id: z.string(),
    parentId: z.string().nullable(),
    index: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("reorder"),
    id: z.string(),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("putToken"),
    id: z.string().min(1).max(128),
    token: z.object({
      name: z.string(),
      value: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    }),
  }),
]);
export const transactionSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  operations: z.array(operationSchema).min(1).max(20000),
});
// The provider consumes transactionSchema for selection-scoped proposals. Page
// metadata edits use the editor transaction schema so they cannot escape a selection.
const backgroundOperation = z.object({
  type: z.literal("setPageBackground"),
  color: documentSchema.shape.pageBackground,
  opacity: documentSchema.shape.pageBackgroundOpacity,
  visible: documentSchema.shape.pageBackgroundVisible,
});
const commentsOperation = z.object({
  type: z.literal("setComments"),
  comments: documentSchema.shape.comments.unwrap(),
});
const documentOperationSchema = z.discriminatedUnion("type", [
  ...operationSchema.options,
  backgroundOperation,
  commentsOperation,
]);
export const documentTransactionSchema = transactionSchema.extend({
  operations: z.array(documentOperationSchema).min(1).max(20000),
});
export type Operation = z.infer<typeof documentOperationSchema>;
function componentStructure(component?: LibraryComponent) {
  if (!component) return undefined;
  const { assetTier, aiHints, ...definition } = component;
  return definition;
}

function applyBackground(
  doc: DesignDocument,
  op: z.infer<typeof backgroundOperation>,
) {
  if (op.color !== undefined) doc.pageBackground = op.color;
  if (op.opacity !== undefined) doc.pageBackgroundOpacity = op.opacity;
  if (op.visible !== undefined) doc.pageBackgroundVisible = op.visible;
}
export function transact(
  document: DesignDocument,
  input: unknown,
): DesignDocument {
  const tx = documentTransactionSchema.parse(input);
  if (tx.baseRevision !== document.revision)
    throw new Error("文件已变化，请重新读取后提交，避免覆盖人工修改");
  if (
    tx.operations.every(
      (op) =>
        op.type === "setGuides" ||
        op.type === "setComments" ||
        op.type === "setPageBackground",
    )
  ) {
    const next = { ...document, revision: document.revision + 1 };
    for (const op of tx.operations)
      if (op.type === "setGuides") next.guides = op.guides;
      else if (op.type === "setComments") next.comments = op.comments;
      else applyBackground(next, op);
    return next;
  }
  const next = cloneDocument(document);
  const pending = [...tx.operations];
  const internal = new WeakSet<Operation>();
  const protectedOwner = (id: string) => {
    const owner = instanceOwner(next, id);
    return owner && document.nodes.some((n) => n.id === owner.id)
      ? owner
      : undefined;
  };
  const protectionError = () =>
    new Error(
      "组件结构受保护：可修改文字和外观，改动结构或内部几何请先显式分离组件",
    );
  for (let index = 0; index < pending.length; index++) {
    const op = pending[index];
    if (op.type === "setPageBackground") {
      applyBackground(next, op);
      continue;
    }
    if (op.type === "setGuides") {
      next.guides = op.guides;
      continue;
    }
    if (op.type === "setComments") {
      next.comments = op.comments;
      continue;
    }
    if (op.type === "putFont") {
      next.fonts = mergeFonts(next.fonts, { [op.id]: op.font });
      continue;
    }
    if (op.type === "putImage") {
      const existing = next.images?.[op.id];
      if (existing && existing.data !== op.image.data)
        throw new Error("图像资源标识冲突");
      next.images = { ...next.images, [op.id]: existing ?? op.image };
      continue;
    }
    if (op.type === "bindVariable" || op.type === "applyStyle") {
      const node = next.nodes.find((n) => n.id === op.id);
      if (!node) throw new Error("目标图层不存在");
      let expanded: Operation;
      if (op.type === "bindVariable")
        expanded = planBindVariable(node, op.property, op.variableId);
      else {
        const style = next.designSystem?.styles[op.styleId];
        if (!style) throw new Error("样式引用不存在");
        if (
          style.kind === "grid" &&
          (node.type !== "frame" ||
            node.style.layout !== "grid" ||
            instanceOwner(next, node.id))
        )
          throw Error("请先选择可编辑的网格画板");
        expanded = planApplyReusableStyle(node, style, op.slot);
      }
      if (pending.length >= 20000) throw new Error("事务展开超过限制");
      pending.splice(index + 1, 0, expanded);
      continue;
    }
    if (op.type === "setDesignSystem") {
      next.designSystem = op.system;
      continue;
    }
    if (
      op.type === "createVariantSet" ||
      op.type === "arrangeComponentSet" ||
      op.type === "includeSetDrawing" ||
      op.type === "addComponentVariant" ||
      op.type === "editVariantProperty" ||
      op.type === "unlinkComponentVariant"
    ) {
      applyVariantChange(next, op);
      continue;
    }
    if (op.type === "setComponentProperties") {
      const lib = next.libraries?.[op.libraryId],
        c = lib?.components.find((c) => c.id === op.componentId);
      if (
        !lib ||
        !c ||
        c.master?.documentId !== next.id ||
        !(
          c.master.nodeId === op.id ||
          c.variants.some((v) => v.masterNodeId === op.id)
        ) ||
        !next.nodes.some((n) => n.id === op.id) ||
        isLocked(next, op.id)
      )
        throw Error("请在可编辑的本地主组件上管理属性");
      c.exposed = op.properties.map((property) => {
        const previous = c.exposed?.find((p) => p.id === property.id);
        if (!previous) return property;
        const previousNames = [
          ...new Set([previous.name, ...(previous.previousNames ?? [])]),
        ].filter((name) => name !== property.name);
        return {
          ...property,
          previousNames: previousNames.length ? previousNames : undefined,
        };
      });
      lib.revision++;
      continue;
    }
    if (
      op.type === "switchInstance" ||
      op.type === "detachInstance" ||
      op.type === "swapInstance" ||
      op.type === "setInstanceSlot"
    ) {
      if (isLocked(next, op.id)) throw new Error("图层或父图层已锁定");
      if (instanceAncestor(next, op.id)) throw protectionError();
      const expanded =
        op.type === "setInstanceSlot"
          ? planSetSlot(next, op.id, op.property, op.value)
          : op.type === "swapInstance"
            ? planSwapInstance(
                next,
                op.id,
                op.libraryId,
                op.componentId,
                op.variantId,
              )
            : op.type === "switchInstance"
              ? planSwitchInstance(next, op.id, op.variantId, op.reset)
              : planDetachInstance(next, op.id);
      if (pending.length + expanded.length > 20000)
        throw new Error("事务展开超过限制");
      expanded.forEach((item) => internal.add(item));
      pending.splice(index + 1, 0, ...expanded);
      continue;
    }
    if (op.type === "insertComponent") {
      const library = next.libraries?.[op.libraryId];
      if (!library) throw new Error("请先启用此组件库");
      const expanded = instantiateComponent(
        next,
        library,
        op.componentId,
        op.variantId,
        op.parentId,
        op.position,
      );
      if (pending.length + expanded.operations.length > 20000)
        throw new Error("组件实例展开超过事务限制");
      pending.splice(index + 1, 0, ...expanded.operations);
      continue;
    }
    if (op.type === "updateLibrary") {
      updatePublishedLibrary(next, op.library, op.expectedRevision, op);
      continue;
    }
    if (op.type === "removeLibrary") {
      if (!next.libraries?.[op.libraryId]) continue;
      const count = [
        ...next.nodes,
        ...(next.pages ?? []).flatMap((page) => page.nodes ?? []),
      ].filter(
        (node) =>
          node.instance &&
          referencedComponents(node.instance).some(
            (ref) => ref.libraryId === op.libraryId,
          ),
      ).length;
      if (count > 0)
        throw new Error(
          `仍有 ${count} 个画布实例正在使用此组件库，请先分离或删除相关实例后再移除`,
        );
      delete next.libraries[op.libraryId];
      if (!Object.keys(next.libraries).length) delete next.libraries;
      continue;
    }
    if (op.type === "putLibrary") {
      const previous = next.libraries?.[op.library.id];
      const prepared = integrateLibrarySystem(next, op.library);
      const used = new Set<string>();
      for (const node of [
        ...next.nodes,
        ...(next.pages ?? []).flatMap((page) => page.nodes ?? []),
      ]) {
        if (!node.instance) continue;
        for (const ref of referencedComponents(node.instance))
          if (ref.libraryId === op.library.id) used.add(ref.componentId);
      }
      for (const id of used) {
        const before = previous?.components.find((c) => c.id === id);
        const after = prepared.library.components.find((c) => c.id === id);
        if (
          JSON.stringify(componentStructure(before)) !==
          JSON.stringify(componentStructure(after))
        )
          throw new Error("此版本已有实例，请另存为新组件库，避免覆盖实例来源");
      }
      if (op.library.fonts)
        next.fonts = mergeFonts(next.fonts, op.library.fonts);
      next.libraries = { ...next.libraries, [op.library.id]: prepared.library };
      if (prepared.system) next.designSystem = prepared.system;
      continue;
    }
    if (op.type === "putToken") {
      next.tokens[op.id] = op.token;
      continue;
    }
    if (op.type === "create") {
      if (
        !internal.has(op) &&
        op.node.parentId &&
        protectedOwner(op.node.parentId)
      )
        throw protectionError();
      if (op.node.parentId && isLocked(next, op.node.parentId))
        throw new Error("父图层已锁定");
      next.nodes.push(op.node);
      continue;
    }
    const node = next.nodes.find((n) => n.id === op.id);
    if (!node) throw new Error("目标图层不存在");
    if (!internal.has(op)) {
      const owner = protectedOwner(node.id),
        inside = owner && owner.id !== node.id;
      if (inside && ["remove", "move", "reorder"].includes(op.type))
        throw protectionError();
      if (op.type === "move" && op.parentId && protectedOwner(op.parentId))
        throw protectionError();
      if (op.type === "update") {
        if (
          owner &&
          op.patch.styleBindings &&
          op.patch.styleBindings.grid !== node.styleBindings?.grid
        )
          throw protectionError();
        if (
          owner &&
          ("vector" in op.patch ||
            "maskType" in op.patch ||
            "siblingMask" in op.patch ||
            "maskSourceId" in op.patch ||
            "booleanOperation" in op.patch ||
            "compoundWindingRule" in op.patch ||
            "operandOperation" in op.patch)
        )
          throw protectionError();
        if (
          inside &&
          op.patch.variableBindings &&
          Object.keys(op.patch.variableBindings).some((k) =>
            instanceGeometryKeys.has(k.split(".")[0]),
          )
        )
          throw protectionError();
        if (
          document.nodes.some((n) => n.id === node.id) &&
          ("instance" in op.patch || "templateKey" in op.patch)
        )
          throw protectionError();
        if (
          inside &&
          Object.keys(op.style ?? {}).some((k) => instanceGeometryKeys.has(k))
        )
          throw protectionError();
        if (
          node.instance &&
          [
            "layout",
            "gap",
            "wrap",
            "rowGap",
            "columns",
            "gridTracks",
            "gridRowTracks",
            "layoutBreakpoints",
            "gridRowHeight",
            "gridBreakpoint",
            "narrowColumns",
            "narrowGap",
            "minColumnWidth",
            "padding",
            "alignX",
            "alignY",
            "insets",
          ].some(
            (k) =>
              k in (op.style ?? {}) ||
              Object.keys(op.patch.variableBindings ?? {}).some(
                (key) => key.split(".")[0] === k,
              ),
          )
        )
          throw protectionError();
      }
    }
    const onlyUnlock =
      op.type === "update" &&
      op.patch.locked === false &&
      Object.keys(op.patch).length === 1 &&
      !op.style;
    if (
      isLocked(next, node.id) &&
      !(onlyUnlock && !ancestors(next, node.id).some((n) => n.locked))
    )
      throw new Error("图层或父图层已锁定");
    if (op.type === "flattenBoolean") {
      if (!node.booleanOperation || protectedOwner(node.id))
        throw new Error("请选择可编辑的布尔组");
      const ids = subtreeIds(next, [node.id]);
      if (next.nodes.some((n) => ids.has(n.id) && n.locked))
        throw new Error("布尔组含有锁定图层");
      const vector = booleanVector({ ...next }, node);
      if (!vector) throw new Error("空的布尔结果无法拼合");
      next.nodes = next.nodes.filter((n) => n.id === node.id || !ids.has(n.id));
      node.type = "vector";
      node.vector = vector;
      delete node.booleanOperation;
      delete node.compoundWindingRule;
      continue;
    }
    if (op.type === "update") {
      if (!internal.has(op)) {
        if (
          (op.style?.color !== undefined ||
            op.style?.colorOpacity !== undefined) &&
          node.styleBindings?.paint &&
          ["text", "vector"].includes(node.type)
        )
          node.styleOverrides = [
            ...new Set([
              ...(node.styleOverrides ?? []),
              ...(op.style?.color !== undefined ? ["fill"] : []),
              ...(op.style?.colorOpacity !== undefined ? ["fillOpacity"] : []),
            ]),
          ];
        if (node.variableBindings && op.style) {
          const nestedKeys = Object.keys(node.variableBindings).filter(
            isNestedProperty,
          );
          if (nestedKeys.some((key) => key.split(".")[0] in op.style!)) {
            const before = resolveNode(next, node).style;
            for (const key of nestedKeys) {
              const [group, side] = key.split(".") as [
                "corners" | "insets" | "strokeSides",
                string,
              ];
              if (!(group in op.style)) continue;
              const previous = before[group] as
                Record<string, number> | undefined;
              const patch = op.style[group] as
                Record<string, number> | undefined;
              if (!patch || patch[side] !== previous?.[side])
                delete node.variableBindings[key];
            }
          }
        }
        for (const key of Object.keys(op.style ?? {})) {
          if (node.variableBindings)
            delete node.variableBindings[
              key as keyof typeof node.variableBindings
            ];
          if (
            Object.entries(node.styleBindings ?? {}).some(
              ([kind, id]) =>
                id &&
                (
                  styleGroups[
                    kind as keyof typeof styleGroups
                  ] as readonly string[]
                ).includes(key),
            )
          )
            node.styleOverrides = [
              ...new Set([
                ...(node.styleOverrides ?? []),
                ...(key === "strokePaints"
                  ? strokePaintOverrideKeys(
                      resolveNode(next, node).style.strokePaints,
                      op.style?.strokePaints,
                    )
                  : [key]),
              ]),
            ];
        }
        if ("text" in op.patch && node.variableBindings)
          delete node.variableBindings.text;
        if ("hidden" in op.patch && node.variableBindings)
          delete node.variableBindings.visible;
      }
      if (
        op.patch.text !== undefined &&
        !("textRuns" in op.patch) &&
        node.textRuns
      )
        node.textRuns = replaceText(node, op.patch.text).textRuns;
      Object.assign(node, op.patch, { style: { ...node.style, ...op.style } });
      if (
        node.sourceTextShape &&
        (node.text !== node.sourceTextShape.text || node.textRuns?.length)
      )
        delete node.sourceTextShape;
      if (
        node.sourceTextLayout &&
        (node.text !== node.sourceTextLayout.text || node.textRuns?.length)
      )
        delete node.sourceTextLayout;
    }
    if (op.type === "move") {
      const parent = next.nodes.find((n) => n.id === op.parentId);
      if (op.parentId && (!parent || !isContainer(parent)))
        throw new Error("目标必须是容器");
      if (
        op.parentId &&
        (isLocked(next, op.parentId) ||
          subtreeIds(next, [node.id]).has(op.parentId))
      )
        throw new Error("不能移入锁定容器或自身子层");
      if (node.parentId !== op.parentId) {
        const old = next.nodes.find((n) => n.id === node.parentId);
        if (old?.componentSet) throw Error("请先从主组件面板移出变体");
        if (old?.maskSourceId === node.id) {
          delete old.maskSourceId;
          delete old.maskType;
        }
      }
      node.parentId = op.parentId;
    }
    if (
      op.type === "reorder" ||
      (op.type === "move" && op.index !== undefined)
    ) {
      const siblings = next.nodes.filter(
        (n) => n.parentId === node.parentId && n.id !== node.id,
      );
      const index = Math.min(op.index!, siblings.length);
      next.nodes = next.nodes.filter((n) => n.id !== node.id);
      const insertion =
        index < siblings.length
          ? next.nodes.findIndex((n) => n.id === siblings[index].id)
          : siblings.length
            ? next.nodes.findIndex((n) => n.id === siblings.at(-1)!.id) + 1
            : next.nodes.length;
      next.nodes.splice(insertion, 0, node);
    }
    if (op.type === "remove") {
      const old = next.nodes.find((n) => n.id === node.parentId);
      if (old?.maskSourceId === node.id) {
        delete old.maskSourceId;
        delete old.maskType;
      }
      const removed = subtreeIds(next, [node.id]);
      if (next.nodes.some((n) => removed.has(n.id) && n.locked))
        throw new Error("包含锁定的子图层");
      next.nodes = next.nodes.filter((n) => !removed.has(n.id));
    }
  }
  for (const node of next.nodes)
    if (node.instance && !document.nodes.some((n) => n.id === node.id))
      validateInstanceStructure(next, node);
  next.revision++;
  const valid = parseDocument(next);
  let mutated = resizeAnchoredLayers(document, valid);
  // A Group is a bounding collection, not a fixed Frame. Rebase its children
  // while preserving their world positions, working from inner groups outward.
  const groups = valid.nodes
    .filter((n) => n.type === "group" && !instanceOwner(valid, n.id))
    .sort(
      (a, b) => ancestors(valid, b.id).length - ancestors(valid, a.id).length,
    );
  for (const group of groups) {
    const children = valid.nodes.filter((n) => n.parentId === group.id);
    if (!children.length) continue;
    const bounds = children.map((child) => resolveNode(valid, child).style);
    const x = Math.min(...children.map((n) => n.style.x)),
      y = Math.min(...children.map((n) => n.style.y));
    const width = Math.max(...bounds.map((style) => style.x + style.width)) - x;
    const height =
      Math.max(...bounds.map((style) => style.y + style.height)) - y;
    if (
      x !== 0 ||
      y !== 0 ||
      group.style.width !== width ||
      group.style.height !== height
    ) {
      mutated = true;
      group.style.width = width;
      group.style.height = height;
      group.style.x += x;
      group.style.y += y;
      for (const child of children) {
        child.style.x -= x;
        child.style.y -= y;
      }
    }
  }
  // Library and design-system operations can change dependencies outside the active page.
  const localEdit = tx.operations.every((op) =>
    [
      "update",
      "move",
      "remove",
      "reorder",
      "create",
      "bindVariable",
      "applyStyle",
      "setDesignSystem",
      "switchInstance",
      "setInstanceSlot",
      "detachInstance",
      "swapInstance",
    ].includes(op.type),
  );
  if (synchronizeMasters(valid, localEdit ? document.nodes : undefined))
    mutated = true;
  if (
    localEdit &&
    tx.operations.some((op) => op.type === "setDesignSystem") &&
    refreshMasterSystems(valid)
  )
    mutated = true;
  return mutated ? parseDocument(valid) : valid;
}
