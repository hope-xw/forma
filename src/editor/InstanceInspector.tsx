import { CombineVariants } from "./MasterVariants";
import { MasterProperties, InstanceProperties } from "./ComponentProperties";
import { instanceOwner, isLocked } from "../domain/tree";
import { localMasters } from "../domain/component-masters";
import {
  Component,
  ShieldCheck,
  Unlink,
  RotateCcw,
  ArrowUpRight,
  LayoutGrid,
} from "lucide-react";
import {
  instanceSource,
  switchInstance,
  detachInstance,
} from "../domain/library";
import type { EditorController } from "./useEditor";
export function InstanceInspector({ editor: e }: { editor: EditorController }) {
  if (e.selected.length > 1) {
    const selection = e.selected.flatMap((root) => {
      const source = instanceSource(e.doc, root);
      return source ? [{ root, source }] : [];
    });
    if (selection.length !== e.selected.length) {
      const masters = localMasters(e.doc);
      const selectedMasters = e.selected.map((n) =>
        masters.find((m) => m.nodeId === n.id),
      );
      if (
        selectedMasters.every(
          (m) =>
            m &&
            m.library.id === selectedMasters[0]!.library.id &&
            m.component.id === selectedMasters[0]!.component.id,
        )
      ) {
        const ref = selectedMasters[0]!;
        return (
          <section className="instance-inspector">
            <div className="section-title">
              <Component size={14} />
              组件变体<span>{e.selected.length} 个已选</span>
            </div>
            <div className="instance-title-row">
              <strong>{ref.component.name}</strong>
              <span className="protection-status">
                {ref.component.variants.length} 变体
              </span>
            </div>
          </section>
        );
      }
      return <CombineVariants key={JSON.stringify(e.selection)} editor={e} />;
    }
    return (
      <section className="instance-inspector">
        <div className="section-title">
          <Component size={14} />
          组件实例<span>{selection.length} 个实例</span>
        </div>
        <InstanceProperties editor={e} selection={selection} />
      </section>
    );
  }
  if (!e.selected.length) return null;
  const selected = e.selected[0];
  if (selected.componentSet) {
    const lib = e.doc.libraries?.[selected.componentSet.libraryId];
    const comp = lib?.components.find(
      (c) => c.id === selected.componentSet!.componentId,
    );
    const members = e.doc.nodes.filter((n) => n.parentId === selected.id);
    if (lib && comp) {
      const firstMasterId =
        comp.variants[0]?.masterNodeId ?? comp.master?.nodeId ?? members[0]?.id;
      return (
        <section className="instance-inspector">
          <div className="section-title">
            <Component size={14} />
            组件集<span>{comp.variants.length} 个变体</span>
          </div>
          <div className="instance-title-row">
            <strong>{comp.name}</strong>
            <span className="protection-status">{lib.name}</span>
          </div>
          <div className="component-set-members">
            {members.map((m) => (
              <button
                key={m.id}
                type="button"
                className="set-member-chip"
                onClick={() => e.setSelection([m.id])}
              >
                {m.name}
              </button>
            ))}
          </div>
          {firstMasterId && (
            <button
              className="wide"
              disabled={isLocked(e.doc, selected.id)}
              onClick={() =>
                e.attempt(() =>
                  e.apply([{ type: "arrangeComponentSet", id: firstMasterId }]),
                )
              }
            >
              <LayoutGrid size={13} />
              重新排列变体网格
            </button>
          )}
        </section>
      );
    }
  }
  const node = instanceOwner(e.doc, selected.id);
  if (!node)
    return <MasterProperties key={selected.id} editor={e} id={selected.id} />;
  const source = instanceSource(e.doc, node);
  if (!source) return null;
  const masterRef =
    source.component.master?.documentId === e.committed.id
      ? (source.variant.masterNodeId ?? source.component.master.nodeId)
      : null;
  const goToMaster = () => {
    if (!masterRef) return;
    if (e.committed.nodes.some((n) => n.id === masterRef)) {
      e.setSelection([masterRef]);
      requestAnimationFrame(() => e.api.current?.fit([masterRef]));
      return;
    }
    const targetPage = e.committed.pages?.find((p) =>
      p.nodes?.some((n) => n.id === masterRef),
    );
    if (targetPage) {
      e.switchPage(targetPage.id);
      e.setSelection([masterRef]);
      requestAnimationFrame(() => e.api.current?.fit([masterRef]));
    }
  };
  if (selected.id !== node.id)
    return (
      <section className="instance-inspector">
        <div
          className="section-title"
          title="内部结构与几何受保护，可修改文字与外观"
        >
          <ShieldCheck size={14} />
          组件内部图层
        </div>

        <button className="wide" onClick={() => e.setSelection([node.id])}>
          选择所属组件 · {source.component.name}
        </button>
      </section>
    );
  return (
    <section className="instance-inspector">
      <div className="section-title">
        <Component size={14} />
        组件实例<span>{source.library.name}</span>
      </div>
      <div className="instance-title-row">
        <strong>{source.component.name}</strong>
        <span
          className="protection-status"
          title="内部文字与外观可覆盖；修改结构须先分离组件，可撤销。"
        >
          <ShieldCheck size={12} />
          已保护
        </span>
      </div>

      <InstanceProperties editor={e} selection={[{ root: node, source }]} />
      <div className="instance-actions">
        {masterRef && (
          <button
            title="跳转到此组件的主组件"
            aria-label="定位主组件"
            data-tip="跳转到此组件的主组件"
            onClick={goToMaster}
          >
            <ArrowUpRight size={13} />
            主组件
          </button>
        )}
        <button
          disabled={isLocked(e.doc, node.id)}
          aria-label="重置覆盖"
          data-tip="清除实例覆盖"
          data-tip-desc="恢复当前变体默认样式与内容（可撤销）"
          title="清除实例覆盖，恢复当前变体；可撤销"
          onClick={() =>
            e.attempt(() =>
              e.apply(
                switchInstance(
                  e.committed,
                  node.id,
                  node.instance!.variantId,
                  true,
                ),
              ),
            )
          }
        >
          <RotateCcw size={13} />
          重置覆盖
        </button>
        <button
          disabled={isLocked(e.doc, node.id)}
          aria-label="分离组件"
          data-tip="分离组件实例"
          data-tip-kbd="⌥⌘B"
          data-tip-desc="转为普通可编辑图层"
          title="转为普通可编辑图层"
          onClick={() =>
            e.attempt(() => e.apply(detachInstance(e.committed, node.id)))
          }
        >
          <Unlink size={13} />
          分离组件
        </button>
      </div>
    </section>
  );
}
