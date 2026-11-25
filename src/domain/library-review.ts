import type { DesignSystem } from "./design-system-schema";
import type { ComponentLibrary } from "./library-schema";
import type { DesignDocument } from "./document";
export type ReviewDefinition =
  | DesignSystem["collections"][string]
  | DesignSystem["styles"][string]
  | DesignSystem["variables"][string];
export const sameDefinition = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function changedComponents(
  old: ComponentLibrary,
  incoming: ComponentLibrary,
) {
  const next = new Map(incoming.components.map((c) => [c.id, c]));
  const before = new Map(old.components.map((c) => [c.id, c]));
  return [...new Set([...next.keys(), ...before.keys()])].flatMap((id) => {
    const a = before.get(id),
      b = next.get(id);
    return sameDefinition(a, b)
      ? []
      : [
          {
            id,
            name: (b ?? a)!.name,
            kind: !a ? "新增" : !b ? "移除" : "修改",
          },
        ];
  });
}
export function definitionConflicts(
  doc: DesignDocument,
  old: ComponentLibrary,
  incoming: ComponentLibrary,
) {
  const conflicts: {
    key: string;
    name: string;
    local: ReviewDefinition;
    remote: ReviewDefinition;
  }[] = [];
  for (const group of ["variables", "collections", "styles"] as const)
    for (const [id, remote] of Object.entries(
      incoming.designSystem?.[group] ?? {},
    )) {
      const local = doc.designSystem?.[group][id],
        previous = old.designSystem?.[group][id];
      if (
        local &&
        !sameDefinition(local, previous) &&
        !sameDefinition(local, remote) &&
        !sameDefinition(previous, remote)
      )
        conflicts.push({
          key: group + "/" + id,
          name: remote.name,
          local,
          remote,
        });
    }
  return conflicts;
}
export type ReviewOptions = {
  componentIds?: string[];
  decisions?: Record<string, "local" | "incoming">;
};
export function selectedRevision(
  old: ComponentLibrary,
  incoming: ComponentLibrary,
  ids?: string[],
) {
  if (!ids) return incoming;
  const selected = new Set(ids),
    changes = changedComponents(old, incoming);
  const partial = changes.some((change) => !selected.has(change.id));
  if (
    !changes.some((change) => selected.has(change.id)) &&
    !(["collections", "variables", "styles"] as const).some((group) => {
      const before = old.designSystem?.[group] ?? {};
      const after = incoming.designSystem?.[group] ?? {};
      // Partial updates retain definitions used by the deferred components.
      return (
        (!partial &&
          Object.keys(before).length !== Object.keys(after).length) ||
        Object.entries(after).some(
          ([id, value]) => !sameDefinition(before[id], value),
        )
      );
    })
  )
    throw Error("请选择至少一项组件更新");
  if (partial) {
    const map = new Map(old.components.map((c) => [c.id, c]));
    for (const change of changes)
      if (selected.has(change.id)) {
        const next = incoming.components.find((c) => c.id === change.id);
        if (next) map.set(next.id, next);
        else map.delete(change.id);
      }
    return {
      ...incoming,
      revision: old.revision,
      components: [...map.values()],
      images: { ...old.images, ...incoming.images },
      fonts: { ...old.fonts, ...incoming.fonts },
      designSystem:
        incoming.designSystem || old.designSystem
          ? {
              collections: {
                ...old.designSystem?.collections,
                ...incoming.designSystem?.collections,
              },
              variables: {
                ...old.designSystem?.variables,
                ...incoming.designSystem?.variables,
              },
              styles: {
                ...old.designSystem?.styles,
                ...incoming.designSystem?.styles,
              },
              activeModes: {
                ...old.designSystem?.activeModes,
                ...incoming.designSystem?.activeModes,
              },
            }
          : undefined,
    };
  }
  return incoming;
}
