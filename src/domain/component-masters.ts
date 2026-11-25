import {
  referencedComponents,
  variantFor,
  materializeSlots,
} from "./component-slots";
import { selectedRevision, type ReviewOptions } from "./library-review";
import { mergeFonts } from "./fonts";
import { libraryFonts } from "./library-design-system";
import { emptyDesignSystem } from "./design-system-schema";
import type { ComponentLibrary } from "./library-schema";
import { libraryDesignSystem, templateNodes } from "./library-design-system";
import type { DesignDocument, DesignNode } from "./document";
import type { Operation } from "./commands";
import { createLibraryFromSelection, planSwitchInstance } from "./library";
import { isLocked, subtreeIds } from "./tree";

export function localMasters(doc: DesignDocument) {
  return Object.values(doc.libraries ?? {}).flatMap((library) =>
    library.components.flatMap((component) =>
      component.master?.documentId === doc.id
        ? component.variants.flatMap((variant, index) => {
            const nodeId =
              index === 0 ? component.master!.nodeId : variant.masterNodeId;
            return nodeId ? [{ library, component, variant, nodeId }] : [];
          })
        : [],
    ),
  );
}
function applyRebuild(page: DesignDocument, ops: Operation[]) {
  const removed = subtreeIds(
    page,
    ops.flatMap((op) => (op.type === "remove" ? [op.id] : [])),
  );
  const nodes = page.nodes.filter((n) => !removed.has(n.id));
  const index = new Map(nodes.map((n) => [n.id, n]));
  for (const op of ops) {
    if (op.type === "create") {
      nodes.push(op.node);
      index.set(op.node.id, op.node);
    }
    if (op.type === "update") {
      const node = index.get(op.id)!;
      Object.assign(node, op.patch);
      Object.assign(node.style, op.style);
    }
  }
  return nodes;
}
/** Reconcile nested masters in dependency order inside the originating edit's history entry. */
export function synchronizeMasters(
  doc: DesignDocument,
  previousPage?: DesignNode[],
): boolean {
  const masters = localMasters(doc);
  if (!masters.length) return false;
  let changed = false;
  const pages = [
    { nodes: doc.nodes },
    ...(doc.pages ?? []).filter(
      (p): p is typeof p & { nodes: DesignNode[] } => !!p.nodes,
    ),
  ];
  const masterByRoot = new Map(masters.map((m) => [m.nodeId, m]));
  const refKey = (ref: {
    libraryId: string;
    componentId: string;
    variantId: string;
  }) => JSON.stringify([ref.libraryId, ref.componentId, ref.variantId]);
  const byReference = new Map(
    masters.map((m) => [
      JSON.stringify([m.library.id, m.component.id, m.variant.id]),
      m,
    ]),
  );
  const affected = new Set<string>();
  if (previousPage) {
    // Compare the active page after constraints and group bounds have settled.
    // Reparenting/removing a layer dirties its old master as well as its new one.
    const before = new Map(previousPage.map((n) => [n.id, n]));
    const after = new Map(doc.nodes.map((n) => [n.id, n]));
    const addAncestors = (id: string, index: Map<string, DesignNode>) => {
      let node = index.get(id);
      while (node) {
        if (masterByRoot.has(node.id)) affected.add(node.id);
        node = node.parentId ? index.get(node.parentId) : undefined;
      }
    };
    const previousOrder = new Map(previousPage.map((n, i) => [n.id, i]));
    for (const [i, n] of doc.nodes.entries()) {
      if (
        previousOrder.get(n.id) === i &&
        JSON.stringify(before.get(n.id)) === JSON.stringify(n)
      )
        continue;
      addAncestors(n.id, before);
      addAncestors(n.id, after);
    }
    for (const n of previousPage)
      if (!after.has(n.id)) addAncestors(n.id, before);
    if (!affected.size) return false;
    const dependents = new Map<string, Set<string>>();
    for (const page of pages) {
      const nodes = new Map(page.nodes.map((n) => [n.id, n]));
      for (const n of page.nodes) {
        if (!n.instance) continue;
        const deps = referencedComponents(n.instance).map((ref) =>
          byReference.get(refKey(ref)),
        );
        let parent = n.parentId ? nodes.get(n.parentId) : undefined;
        while (parent) {
          if (masterByRoot.has(parent.id))
            for (const dep of deps) {
              if (!dep) continue;
              const owners = dependents.get(dep.nodeId) ?? new Set<string>();
              owners.add(parent.id);
              dependents.set(dep.nodeId, owners);
            }
          parent = parent.parentId ? nodes.get(parent.parentId) : undefined;
        }
      }
    }
    for (const root of affected)
      for (const owner of dependents.get(root) ?? []) affected.add(owner);
  }
  const visited = new Set<string>(),
    visiting = new Set<string>();
  const sync = (master: (typeof masters)[number]) => {
    const { library, component, nodeId, variant } = master;
    if (previousPage && !affected.has(nodeId)) return;
    const key = JSON.stringify([library.id, component.id, variant.id]);
    const family = JSON.stringify([library.id, component.id]);
    if (visited.has(key)) return;
    if (visiting.has(family)) throw new Error("主组件不能循环嵌套实例");
    visiting.add(family);
    const owner = pages.find((p) => p.nodes.some((n) => n.id === nodeId));
    if (owner) {
      const scope = subtreeIds({ ...doc, nodes: owner.nodes }, [nodeId]);
      for (const n of owner.nodes) {
        if (!scope.has(n.id) || !n.instance) continue;
        for (const ref of referencedComponents(n.instance)) {
          const dependency = byReference.get(refKey(ref));
          if (dependency) sync(dependency);
        }
      }
      const index = component.variants.findIndex((v) => v.id === variant.id);
      const old = component.variants[index];
      const capturedLibrary = createLibraryFromSelection(
        { ...doc, nodes: owner.nodes },
        nodeId,
        library.name,
        old,
      );
      const captured = capturedLibrary.components[0];
      const next = { ...old, nodes: captured.variants[0].nodes };
      const dependencies = libraryDesignSystem(doc.designSystem, [
        ...templateNodes(library).filter((n) => !old.nodes.includes(n)),
        ...next.nodes,
      ]);
      const dependencyChanged =
        JSON.stringify(dependencies) !== JSON.stringify(library.designSystem);
      const nodesChanged =
        JSON.stringify(old.nodes) !== JSON.stringify(next.nodes);
      if (nodesChanged) {
        changed = true;
        const changedLibrary = {
          ...library,
          components: library.components.map((c) =>
            c.id === component.id
              ? {
                  ...c,
                  variants: c.variants.map((v) => (v.id === old.id ? next : v)),
                }
              : c,
          ),
        };
        reconcileInstances(doc, library, changedLibrary, pages);
        component.variants[index] = next;
        if (component.exposed)
          component.exposed = component.exposed.filter((p) =>
            component.variants.some((v) =>
              v.nodes.some(
                (n) =>
                  n.templateKey === p.target &&
                  (p.kind !== "swap" || !!n.nestedSlot) &&
                  (p.kind !== "text" ||
                    n.type === "text" ||
                    n.type === "button"),
              ),
            ),
          );

        library.images = { ...library.images, ...capturedLibrary.images };
        if (index === 0) component.name = captured.name;
        library.revision++;
      } else if (dependencyChanged) {
        changed = true;
        library.revision++;
      }
      if (dependencyChanged || nodesChanged)
        library.fonts = libraryFonts(doc, templateNodes(library), dependencies);
      if (dependencies) library.designSystem = dependencies;
      else delete library.designSystem;
    }
    visited.add(key);
    visiting.delete(family);
  };
  masters.forEach(sync);
  doc.nodes = pages[0].nodes;
  return changed;
}

function reconcileInstances(
  doc: DesignDocument,
  old: ComponentLibrary,
  incoming: ComponentLibrary,
  pages: { nodes: DesignNode[] }[],
  protectLocks = false,
) {
  const targetDoc = {
    ...doc,
    libraries: { ...doc.libraries, [old.id]: incoming },
  };
  for (const page of pages) {
    const roots = page.nodes.filter(
      (n) =>
        n.instance &&
        referencedComponents(n.instance).some(
          (ref) => ref.libraryId === old.id,
        ),
    );
    for (const root of roots) {
      const ref = root.instance!;
      const base = variantFor(doc, ref),
        next = variantFor(targetDoc, ref);
      if (!base || !next) throw Error("更新缺少正在使用的变体：" + root.name);
      const original = materializeSlots(doc, base, ref.slots),
        target = materializeSlots(targetDoc, next, ref.slots);
      if (JSON.stringify(original) === JSON.stringify(target)) continue;
      const before = original.nodes.find((n) => !n.parentId),
        after = target.nodes.find((n) => !n.parentId);
      if (
        before?.type !== after?.type ||
        before?.templateKey !== after?.templateKey
      )
        throw Error("组件根层类型或模板键变化：" + root.name);
      const view = { ...doc, nodes: page.nodes };
      if (protectLocks) {
        const scope = subtreeIds(view, [root.id]);
        if (
          isLocked(view, root.id) ||
          page.nodes.some(
            (n) =>
              n.locked &&
              scope.has(n.id) &&
              !original.nodes.some(
                (t) => t.templateKey === n.templateKey && t.locked,
              ),
          )
        )
          throw Error("实例包含本地锁定图层：" + root.name);
      }
      page.nodes = applyRebuild(
        view,
        planSwitchInstance(view, root.id, ref.variantId, false, next, {
          targetDocument: targetDoc,
        }),
      );
    }
  }
}
/** Refresh portable definitions when only the document system changed. The templates
 * already contain the bindings; recapturing every master would rebuild unrelated instances. */
export function refreshMasterSystems(doc: DesignDocument) {
  let changed = false;
  for (const library of Object.values(doc.libraries ?? {})) {
    if (!library.components.some((c) => c.master?.documentId === doc.id))
      continue;
    const nodes = templateNodes(library);
    const dependencies = libraryDesignSystem(doc.designSystem, nodes);
    if (JSON.stringify(dependencies) === JSON.stringify(library.designSystem))
      continue;
    library.designSystem = dependencies;
    library.fonts = libraryFonts(doc, nodes, dependencies);
    library.revision++;
    changed = true;
  }
  return changed;
}
/** Called on the transaction's private copy, after the designer reviews an imported revision. */
export function updatePublishedLibrary(
  doc: DesignDocument,
  incoming: ComponentLibrary,
  expected: number,
  review: ReviewOptions = {},
) {
  const old = doc.libraries?.[incoming.id];
  if (!old || old.revision !== expected || incoming.revision <= expected)
    throw Error("组件库版本已变化，请重新导入更新");
  if (
    old.components.some((c) => c.master?.documentId === doc.id) ||
    incoming.components.some((c) => c.master?.documentId === doc.id)
  )
    throw Error("请在源文件修改本地主组件");
  incoming = selectedRevision(old, incoming, review.componentIds);
  const first = { nodes: doc.nodes };
  const pages = [
    first,
    ...(doc.pages ?? []).filter(
      (p): p is typeof p & { nodes: DesignNode[] } => !!p.nodes,
    ),
  ];
  reconcileInstances(doc, old, incoming, pages, true);
  doc.nodes = first.nodes;
  if (incoming.designSystem) {
    const system = doc.designSystem ?? emptyDesignSystem();
    for (const group of ["collections", "variables", "styles"] as const) {
      for (const [id, newValue] of Object.entries(
        incoming.designSystem[group],
      )) {
        const previous = old.designSystem?.[group][id],
          local = system[group][id];
        if (
          local &&
          JSON.stringify(previous) !== JSON.stringify(local) &&
          JSON.stringify(local) !== JSON.stringify(newValue)
        ) {
          if (JSON.stringify(previous) === JSON.stringify(newValue)) continue;
          const decision = review.decisions?.[group + "/" + id];
          if (decision === "local") continue;
          if (decision !== "incoming")
            throw Error("本地与组件库均修改了定义：" + newValue.name);
        }
        Object.assign(system[group], { [id]: structuredClone(newValue) });
      }
    }
    for (const [id, mode] of Object.entries(incoming.designSystem.activeModes))
      system.activeModes[id] ??= mode;
    doc.designSystem = system;
  }
  for (const [id, image] of Object.entries(incoming.images ?? {})) {
    if (doc.images?.[id] && doc.images[id].data !== image.data)
      throw Error("图像资源标识冲突：" + id);
    (doc.images ??= {})[id] = image;
  }
  if (incoming.fonts) doc.fonts = mergeFonts(doc.fonts, incoming.fonts);
  doc.libraries![incoming.id] = incoming;
}
