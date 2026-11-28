import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { resolveNode } from "../domain/design-system";
import type { DesignDocument, DesignNode } from "../domain/document";
import { isVisible } from "../domain/tree";

interface ArtboardLabelPointerInput {
  locked: boolean;
  panning: boolean;
  tool: string;
  devMode: boolean;
  interacting: boolean;
  hasMarquee: boolean;
}

export function shouldAllowArtboardLabelPointer({
  tool,
  panning,
  devMode,
  interacting,
  hasMarquee,
}: ArtboardLabelPointerInput): boolean {
  return (
    (tool === "select" || tool === "scale") &&
    !panning &&
    !devMode &&
    !interacting &&
    !hasMarquee
  );
}

export function shouldAllowArtboardLabelDrag(
  input: ArtboardLabelPointerInput,
): boolean {
  return !input.locked && shouldAllowArtboardLabelPointer(input);
}

export function collectArtboardLabelNodes(doc: DesignDocument): DesignNode[] {
  const visibleSections = new Set<string>();
  for (const node of doc.nodes) {
    if (node.type === "section" && isVisible(doc, node.id)) {
      visibleSections.add(node.id);
    }
  }
  return doc.nodes.filter(
    (node) =>
      (node.type === "frame" ||
        node.type === "section" ||
        !!node.componentSet) &&
      (node.parentId === null || visibleSections.has(node.parentId)) &&
      !resolveNode(doc, node).hidden,
  );
}

const roleNames = {
  frame: "画板",
  section: "分区",
  "component-set": "组件集",
  component: "主组件",
  instance: "组件实例",
};

export interface ArtboardLabelProps {
  labelRole?: keyof typeof roleNames;
  devStatus?: "ready" | "completed";
  maxWidth?: number;
  nodeId: string;
  name: string;
  width: number;
  height: number;
  left: number;
  top: number;
  selected: boolean;
  locked: boolean;
  interactive: boolean;
  renaming: boolean;
  onSelect?(nodeId: string, add: boolean): void;
  onBeginDrag(event: ReactPointerEvent<HTMLElement>, nodeId: string): void;
  onHoverChange?(nodeId: string | null): void;
  onStartRename(nodeId: string): void;
  onCommitRename(nodeId: string, nextName: string): void;
  onCancelRename(): void;
}

function ArtboardLabelEditor({
  labelRole = "frame",
  maxWidth,
  nodeId,
  name,
  left,
  top,
  locked,
  onCommitRename,
  onCancelRename,
}: ArtboardLabelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const pendingBlurCommitRef = useRef(false);
  const doneRef = useRef(false);

  function finish(value?: string) {
    if (doneRef.current) return;
    doneRef.current = true;
    pendingBlurCommitRef.current = false;
    const nextName = value?.trim();
    if (!locked && nextName && nextName !== name)
      onCommitRename(nodeId, nextName);
    else onCancelRename();
  }
  useEffect(() => {
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.select();
    return () => {
      if (composingRef.current) doneRef.current = true;
    };
  }, []);

  return (
    <input
      ref={inputRef}
      className={
        labelRole === "section"
          ? "frame-label-editor section-title-editor"
          : "frame-label-editor"
      }
      aria-label={labelRole === "section" ? "重命名分区" : "重命名画板"}
      data-frame-label-id={labelRole !== "section" ? nodeId : undefined}
      data-section-label-id={labelRole === "section" ? nodeId : undefined}
      style={{ left, top, maxWidth }}
      defaultValue={name}
      readOnly={locked}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        if (pendingBlurCommitRef.current) finish(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          composingRef.current ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        )
          return;
        if (event.key === "Escape") {
          event.preventDefault();
          finish();
        } else if (event.key === "Enter") {
          event.preventDefault();
          finish(event.currentTarget.value);
        }
      }}
      onBlur={(event) => {
        if (!composingRef.current) return finish(event.currentTarget.value);
        pendingBlurCommitRef.current = true;
      }}
    />
  );
}

export function ArtboardLabel(props: ArtboardLabelProps) {
  const {
    labelRole = "frame",
    maxWidth,
    devStatus,
    onSelect,
    nodeId,
    name,
    width,
    height,
    left,
    top,
    selected,
    locked,
    interactive,
    onBeginDrag,
    onHoverChange,
    onStartRename,
  } = props;
  if (props.renaming) return <ArtboardLabelEditor key={nodeId} {...props} />;

  const className = [
    labelRole === "section" ? "section-title-pill" : "frame-label",
    selected && "selected",
    labelRole !== "section" && labelRole !== "frame" && "is-component",
    locked && "is-locked",
    !interactive && "is-passthrough",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={className}
      data-frame-label-id={labelRole !== "section" ? nodeId : undefined}
      data-section-label-id={labelRole === "section" ? nodeId : undefined}
      aria-label={`${roleNames[labelRole]} ${name}`}
      tabIndex={interactive ? 0 : -1}
      style={{ left, top, maxWidth }}
      onKeyDown={(event) => {
        if (!interactive || locked) return;
        if (!["Enter", " ", "F2"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "F2") onStartRename(nodeId);
        else onSelect?.(nodeId, event.shiftKey);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !interactive) return;
        event.stopPropagation();
        if (!locked) onBeginDrag(event, nodeId);
      }}
      onDoubleClick={(event) => {
        if (!interactive || locked) return;
        event.stopPropagation();
        event.preventDefault();
        onStartRename(nodeId);
      }}
      onPointerEnter={() => {
        if (interactive) onHoverChange?.(nodeId);
      }}
      onPointerLeave={() => {
        if (interactive) onHoverChange?.(null);
      }}
    >
      {labelRole === "section" ? (
        <>
          <span>{name}</span>
          {devStatus && (
            <small>
              {devStatus === "completed" ? "Completed" : "Ready for dev"}
            </small>
          )}
        </>
      ) : (
        <>
          {name}{" "}
          <small>
            {Math.round(width)} × {Math.round(height)}
          </small>
        </>
      )}
    </button>
  );
}
