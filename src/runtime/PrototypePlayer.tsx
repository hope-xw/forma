import {
  useLayoutEffect,
  useMemo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DesignNodeView,
  InteractionContext,
  type DesignAction,
  type RuntimeNode,
} from "./FormaRuntime";
import {
  act,
  actionsFor,
  rulesFor,
  startFlow,
  trigger,
  type Program,
  type Transition,
  type Trigger,
  type Value,
} from "./prototype-machine";

export interface SmartAnimateMatch {
  name: string;
  fromId: string;
  toId: string;
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  fromOpacity: number;
  toOpacity: number;
}

function parseLength(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

interface NodeSnapshot {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
}

function collectSnapshots(root: RuntimeNode): NodeSnapshot[] {
  const result: NodeSnapshot[] = [];
  const walk = (node: RuntimeNode, ox: number, oy: number) => {
    for (const child of node.children) {
      const x = ox + parseLength(child.style.left, 0);
      const y = oy + parseLength(child.style.top, 0);
      const width = child.geometry?.width ?? parseLength(child.style.width, 0);
      const height =
        child.geometry?.height ?? parseLength(child.style.height, 0);
      const opacity =
        typeof child.style.opacity === "number" ? child.style.opacity : 1;
      result.push({
        id: child.id,
        name: child.name,
        x,
        y,
        width,
        height,
        opacity,
      });
      walk(child, x, y);
    }
  };
  walk(root, 0, 0);
  return result;
}

/**
 * Match descendants by layer name between source and target screens and compute
 * FLIP interpolation deltas for Figma-style Smart Animate transitions.
 */
export function computeSmartAnimateMatches(
  fromScreen: RuntimeNode,
  toScreen: RuntimeNode,
): Map<string, SmartAnimateMatch> {
  const fromByName = new Map<string, NodeSnapshot>();
  for (const snap of collectSnapshots(fromScreen)) {
    if (!fromByName.has(snap.name)) fromByName.set(snap.name, snap);
  }
  const matches = new Map<string, SmartAnimateMatch>();
  for (const toSnap of collectSnapshots(toScreen)) {
    const fromSnap = fromByName.get(toSnap.name);
    if (!fromSnap) continue;
    const scaleX =
      toSnap.width > 0 && fromSnap.width > 0
        ? fromSnap.width / toSnap.width
        : 1;
    const scaleY =
      toSnap.height > 0 && fromSnap.height > 0
        ? fromSnap.height / toSnap.height
        : 1;
    matches.set(toSnap.id, {
      name: toSnap.name,
      fromId: fromSnap.id,
      toId: toSnap.id,
      dx: fromSnap.x - toSnap.x,
      dy: fromSnap.y - toSnap.y,
      scaleX,
      scaleY,
      fromOpacity: fromSnap.opacity,
      toOpacity: toSnap.opacity,
    });
  }
  return matches;
}

function applySmartAnimateTree(
  screen: RuntimeNode,
  matches: ReadonlyMap<string, SmartAnimateMatch>,
  duration: number,
  easing: string,
  role: "enter" | "exit",
): RuntimeNode {
  if (role === "exit") {
    const matchedFromIds = new Set(
      Array.from(matches.values(), (m) => m.fromId),
    );
    const hideMatched = (node: RuntimeNode): RuntimeNode => ({
      ...node,
      style: matchedFromIds.has(node.id)
        ? { ...node.style, opacity: 0 }
        : node.style,
      children: node.children.map(hideMatched),
    });
    return { ...screen, children: screen.children.map(hideMatched) };
  }

  const animateEnter = (
    node: RuntimeNode,
    ancestorMatched: boolean,
  ): RuntimeNode => {
    const match = matches.get(node.id);
    if (match && !ancestorMatched) {
      const existing = node.style.transform ? ` ${node.style.transform}` : "";
      const fromTransform = `translate(${match.dx}px, ${match.dy}px) scale(${match.scaleX}, ${match.scaleY})${existing}`;
      return {
        ...node,
        style: {
          ...node.style,
          "--forma-sa-from": fromTransform,
          "--forma-sa-opacity": match.fromOpacity,
          transformOrigin: "top left",
          animation: `forma-smart-enter ${duration}ms ${easing} both`,
        },
        children: node.children.map((c) => animateEnter(c, true)),
      };
    }
    if (!ancestorMatched && !match) {
      return {
        ...node,
        style: {
          ...node.style,
          "--forma-sa-opacity": 0,
          "--forma-sa-from": String(node.style.transform ?? "none"),
          animation: `forma-smart-enter ${duration}ms ${easing} both`,
        },
        children: node.children.map((c) => animateEnter(c, false)),
      };
    }
    return {
      ...node,
      children: node.children.map((c) => animateEnter(c, ancestorMatched)),
    };
  };
  return {
    ...screen,
    children: screen.children.map((c) => animateEnter(c, false)),
  };
}

export interface PrototypePlayerProps {
  nodes: RuntimeNode[];
  program: Program;
  start: string;
  onAction?: (summary: string) => void;
  onControlAction?: DesignAction;
  fit?: { width: number; height: number; mode?: "fit" | "100" | "fill" };
  onScreenChange?(id: string): void;
  previewWidth?: number;
  style?: CSSProperties;
}
type Motion = {
  transition: Transition;
  from: string;
  to: string;
  overlay: boolean;
  sequence: number;
};
const focusable = 'button,input,select,textarea,a[href],[tabindex="0"]';
function layerControls(layer: HTMLElement) {
  return layer.matches(focusable)
    ? [layer]
    : Array.from(layer.querySelectorAll<HTMLElement>(focusable)).filter(
        (el) => !el.closest('[aria-hidden="true"]'),
      );
}
const motionCss = `
@keyframes forma-enter {from {transform:translate(var(--forma-dx),var(--forma-dy));opacity:var(--forma-in-opacity)}}
@keyframes forma-exit {to {transform:translate(var(--forma-ex),var(--forma-ey));opacity:var(--forma-out-opacity)}}
@keyframes forma-smart-enter {from {transform:var(--forma-sa-from);opacity:var(--forma-sa-opacity)}}
[data-forma-hints] [data-active-screen] [data-forma-hotspot]::after {content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;box-shadow:inset 0 0 0 2px #0d99ff;background:rgba(13,153,255,0.14);z-index:2147483647}
@media(prefers-reduced-motion:reduce){[data-forma-motion],[data-forma-motion] *{animation-duration:1ms!important}}
`;
function animation(
  motion: Motion,
  exit = false,
  hasSmartMatches = false,
): CSSProperties {
  const {
    direction = "left",
    duration = 300,
    easing = "ease-out",
    type,
  } = motion.transition;
  if (type === "smart-animate") {
    if (!exit && hasSmartMatches) return {};
    return {
      "--forma-dx": "0%",
      "--forma-dy": "0%",
      "--forma-ex": "0%",
      "--forma-ey": "0%",
      "--forma-in-opacity": 0,
      "--forma-out-opacity": 0,
      animation: `forma-${exit ? "exit" : "enter"} ${duration}ms ${easing} both`,
    } as CSSProperties;
  }
  const x = direction === "left" ? 100 : direction === "right" ? -100 : 0;
  const y = direction === "top" ? 100 : direction === "bottom" ? -100 : 0;
  const distance = type === "dissolve" ? 0 : 1;
  const outgoing = type === "push" ? 1 : type === "slide-in" ? 0.25 : 0;
  return {
    "--forma-dx": x * distance + "%",
    "--forma-dy": y * distance + "%",
    "--forma-ex": -x * outgoing + "%",
    "--forma-ey": -y * outgoing + "%",
    "--forma-in-opacity": type === "dissolve" ? 0 : 1,
    "--forma-out-opacity": type === "dissolve" ? 0 : 1,
    animation: `forma-${exit ? "exit" : "enter"} ${duration}ms ${easing} both`,
  } as CSSProperties;
}
export function ProjectPrototypePlayer({
  onAction,
  ...props
}: Omit<PrototypePlayerProps, "onAction"> & { onAction?: DesignAction }) {
  return <PrototypePlayer {...props} onControlAction={onAction} />;
}
export function PrototypePlayer(
  props: PrototypePlayerProps,
): React.JSX.Element | null;
export function PrototypePlayer(
  props: Omit<PrototypePlayerProps, "onAction"> & { onAction?: DesignAction },
): React.JSX.Element | null;
export function PrototypePlayer({
  nodes,
  program,
  start,
  onAction,
  onControlAction,
  onScreenChange,
  fit,
  previewWidth,
  style,
}: Omit<PrototypePlayerProps, "onAction"> & {
  onAction?: DesignAction | PrototypePlayerProps["onAction"];
}) {
  const [session, setSession] = useState(() => startFlow(program, start));
  useEffect(() => {
    onScreenChange?.(session.screen);
  }, [onScreenChange, session.screen]);
  const live = useRef(session);
  const [motion, setMotion] = useState<Motion>();
  const sequence = useRef(0);
  const [hint, setHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const initial = useRef({ program, start });
  useLayoutEffect(() => {
    if (initial.current.program === program && initial.current.start === start)
      return;
    initial.current = { program, start };
    const next = startFlow(program, start);
    next.resetCount = live.current.resetCount + 1;
    live.current = next;
    setSession(next);
    setMotion(undefined);
  }, [program, start]);
  const screen = nodes.find((n) => n.id === session.screen);
  const host = useRef<HTMLDivElement>(null);
  const scroll = useRef(new Map<string, [number, number]>());
  const wired = useMemo(
    () =>
      new Set([
        ...Object.keys(program.rules),
        ...Object.keys(program.multiRules ?? {}),
      ]),
    [program],
  );
  const reset = useRef(session.resetCount);
  const previousTop = useRef("");
  const returningTo = useRef<string | undefined>(undefined);
  const top = session.overlays.at(-1)?.target ?? session.screen;
  const opener = useRef(new Map<string, { id: string; control: number }>());
  const hovered = useRef<{ id?: string; x: number; y: number } | null>(null);
  const activationTarget = useRef<Element | null>(null);
  function commit(next: typeof session) {
    const before = live.current;
    const topBefore = before.overlays.at(-1)?.target ?? before.screen;
    const topAfter = next.overlays.at(-1)?.target ?? next.screen;
    if (topBefore !== topAfter) {
      const returning =
        (next.screen === before.screen &&
          next.overlays.length < before.overlays.length) ||
        next.history.length < before.history.length;
      returningTo.current =
        returning && before.resetCount === next.resetCount
          ? topAfter
          : undefined;
    }
    live.current = next;
    setSession(next);
  }
  const close = () => {
    setMotion(undefined);
    commit(act(program, live.current, [{ kind: "close" }]));
    if (onAction && onAction.length < 2)
      (onAction as (summary: string) => void)("close · " + top);
  };
  function dispatch(id: string, value: Value, event: Trigger) {
    const before = live.current;
    const matching = rulesFor(program, id).filter(
      (rule) => (rule.trigger ?? "click") === event,
    );
    if (!matching.length) {
      // An input still edits its own value when its prototype rule uses another trigger.
      if (event === "click") {
        commit({ ...before, controls: { ...before.controls, [id]: value } });
        if (onAction && onAction.length >= 2)
          (onAction as DesignAction)(id, value);
        else (onAction as PrototypePlayerProps["onAction"])?.("input · " + id);
        onControlAction?.(id, value);
      }
      return;
    }
    const actions: ReturnType<typeof actionsFor> = [];
    let previewSession =
      event === "click"
        ? { ...before, controls: { ...before.controls, [id]: value } }
        : before;
    for (const rule of matching) {
      const ruleActions = actionsFor(rule, previewSession);
      actions.push(...ruleActions);
      previewSession = act(program, previewSession, ruleActions, value);
    }
    const next = trigger(program, before, id, value, event);
    const from = before.overlays.at(-1)?.target ?? before.screen;
    const to = next.overlays.at(-1)?.target ?? next.screen;
    if (from !== to || before.resetCount !== next.resetCount) {
      const change = actions
        .slice()
        .reverse()
        .find(
          (a) =>
            (a.kind === "navigate" || a.kind === "overlay") && a.target === to,
        );
      const transition = change && "transition" in change && change.transition;
      setMotion(
        transition && transition.type !== "instant" && transition.duration !== 0
          ? {
              transition,
              from: before.screen,
              to,
              overlay: change.kind === "overlay",
              sequence: ++sequence.current,
            }
          : undefined,
      );
    }
    if (
      from !== to &&
      actions.some((a) => a.kind === "overlay" || a.kind === "navigate")
    ) {
      const scope = host.current?.querySelector("[data-active-screen]");
      const layer = scope?.querySelector<HTMLElement>(
        `[data-design-id="${CSS.escape(id)}"]`,
      );
      const target =
        event === "click"
          ? activationTarget.current &&
            layer?.contains(activationTarget.current)
            ? activationTarget.current
            : document.activeElement
          : null;
      const control = layer
        ? layerControls(layer).findIndex(
            (el) => !!target && el.contains(target),
          )
        : -1;
      opener.current.set(from, { id, control });
    }
    activationTarget.current = null;
    commit(next);
    for (const action of actions)
      if (action.kind === "openLink" && /^https?:\/\//i.test(action.url))
        window.open(action.url, "_blank", "noopener,noreferrer");
    const summary = [
      event,
      id,
      ...actions.map(
        (action) =>
          action.kind +
          ("target" in action
            ? " " + action.target
            : "url" in action
              ? " " + action.url
              : ""),
      ),
    ].join(" · ");
    if (onAction && onAction.length >= 2) (onAction as DesignAction)(id, value);
    else (onAction as PrototypePlayerProps["onAction"])?.(summary);
    onControlAction?.(id, value);
  }
  const activate: DesignAction = (id, value) => dispatch(id, value, "click");
  const latest = useRef(dispatch);
  useLayoutEffect(() => {
    latest.current = dispatch;
  });
  useLayoutEffect(() => {
    setHint(false);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const scope = host.current?.querySelector("[data-active-screen]");
    for (const el of Array.from(
      scope?.querySelectorAll<HTMLElement>("[data-design-id]") ?? [],
    )) {
      const id = el.dataset.designId!;
      const delayRules = rulesFor(program, id).filter(
        (rule) => rule.trigger === "delay",
      );
      if (!delayRules.length || !el.getClientRects().length) continue;
      for (const rule of delayRules) {
        timers.push(
          setTimeout(() => {
            const current = live.current;
            if (
              (current.overlays.at(-1)?.target ?? current.screen) === top &&
              current.resetCount === session.resetCount &&
              el.getClientRects().length
            )
              latest.current(id, true, "delay");
          }, rule.delayMs ?? 1000),
        );
      }
    }
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(hintTimer.current);
    };
  }, [
    program,
    nodes,
    top,
    session.screen,
    session.resetCount,
    session.overlays.length,
  ]);
  useEffect(() => {
    if (!motion) return;
    const timer = setTimeout(
      () => setMotion(undefined),
      motion.transition.duration ?? 300,
    );
    return () => clearTimeout(timer);
  }, [motion]);
  useLayoutEffect(() => {
    if (reset.current !== session.resetCount) {
      scroll.current.clear();
      opener.current.clear();
      returningTo.current = undefined;
      reset.current = session.resetCount;
    }
    const region = host.current;
    if (!region) return;
    const elements = Array.from(
      region.querySelectorAll<HTMLElement>("[data-screen] [data-design-id]"),
    );
    for (const element of elements) {
      const id = element.dataset.designId!;
      if (
        session.scrollReset &&
        element.closest("[data-screen]")?.getAttribute("data-screen") ===
          session.scrollReset
      )
        scroll.current.delete(id);
      const [x, y] = scroll.current.get(id) ?? [0, 0];
      if (element.scrollTop !== y || element.scrollLeft !== x)
        element.scrollTo(x, y);
    }
    if (session.scrollTarget)
      elements
        .find((el) => el.dataset.designId === session.scrollTarget)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (
      top !== previousTop.current &&
      (previousTop.current || session.overlays.length)
    ) {
      const scope = region.querySelector<HTMLElement>("[data-active-screen]");
      const bookmark =
        returningTo.current === top ? opener.current.get(top) : undefined;
      returningTo.current = undefined;
      const last = bookmark
        ? elements.find(
            (el) => scope?.contains(el) && el.dataset.designId === bookmark.id,
          )
        : undefined;
      const controls = last ? layerControls(last) : [];
      const usable = (el?: HTMLElement) =>
        el && !el.matches(":disabled") && el.getClientRects().length > 0;
      const original = bookmark && controls[bookmark.control];
      const target = usable(original) ? original : controls.find(usable);
      (target ?? scope)?.focus({ preventScroll: true });
    }
    previousTop.current = top;
  }, [session, top]);
  if (!screen) return null;
  const responsive = screen.style.width === "100%";
  const designWidth =
    screen.geometry?.width ?? (Number(screen.style.width) || 390);
  const width = responsive && fit && previewWidth ? previewWidth : designWidth;
  const height =
    screen.geometry?.height ?? (Number(screen.style.height) || 844);
  const scale =
    !fit || fit.mode === "100"
      ? 1
      : fit.mode === "fill"
        ? fit.width / width
        : Math.min(1, fit.width / width, fit.height / height);
  const variables = Object.fromEntries(
    Object.entries(session.changes).map(([key, value]) => [
      program.cssNames[key],
      program.p3Variables?.includes(key) &&
      typeof value === "string" &&
      /^#[a-f0-9]{6}$/i.test(value)
        ? "color(display-p3 " +
          [1, 3, 5]
            .map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
            .join(" ") +
          ")"
        : String(value),
    ]),
  );
  const smartMatches = useMemo(() => {
    if (!motion || motion.transition.type !== "smart-animate" || motion.overlay)
      return null;
    const fromNode = nodes.find((n) => n.id === motion.from);
    const toNode = nodes.find((n) => n.id === motion.to);
    if (!fromNode || !toNode) return null;
    const matched = computeSmartAnimateMatches(fromNode, toNode);
    return matched.size ? matched : null;
  }, [motion, nodes]);
  const render = (node: RuntimeNode, overlay: boolean, index: number) => {
    const active = overlay
      ? index === session.overlays.length - 1
      : !session.overlays.length;
    const isSmartEntering =
      !overlay &&
      motion?.to === node.id &&
      motion.transition.type === "smart-animate" &&
      Boolean(smartMatches);
    const baseLayer = {
      ...node,
      style: { ...node.style, left: 0, top: 0, position: "relative" as const },
    };
    const layer =
      isSmartEntering && smartMatches
        ? applySmartAnimateTree(
            baseLayer,
            smartMatches,
            motion!.transition.duration ?? 300,
            motion!.transition.easing ?? "ease-out",
            "enter",
          )
        : baseLayer;
    const region = (
      <div
        key={node.id}
        data-forma-motion={motion?.to === node.id ? "" : undefined}
        data-screen={node.id}
        data-active-screen={active ? "" : undefined}
        inert={!active}
        role={overlay ? "dialog" : undefined}
        aria-modal={overlay && active ? true : undefined}
        aria-label={node.name}
        tabIndex={-1}
        style={{
          position: "relative",
          ...(motion?.to === node.id
            ? animation(motion, false, Boolean(smartMatches))
            : {}),
          outline: "none",
          maxWidth: "100%",
          maxHeight: "100%",
          overflow: "auto",
        }}
        onKeyDown={(e) => {
          if (!overlay || !active) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
          if (e.key === "Tab") {
            const controls = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
              ),
            ).filter((el) => el.getClientRects().length);
            if (!controls.length) {
              e.preventDefault();
              return;
            }
            const edge = e.shiftKey ? controls[0] : controls.at(-1);
            if (
              document.activeElement === edge ||
              (e.shiftKey && document.activeElement === e.currentTarget)
            ) {
              e.preventDefault();
              (e.shiftKey ? controls.at(-1) : controls[0])?.focus();
            }
          }
        }}
      >
        <DesignNodeView node={layer} onAction={activate} />
      </div>
    );
    return overlay ? (
      <div
        key={node.id}
        style={{
          position: "absolute",
          inset: 0,
          background: "#0006",
          display: "flex",
          justifyContent: "center",
          alignItems:
            session.overlays[index].position === "bottom" ? "end" : "center",
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && active) close();
        }}
      >
        {region}
      </div>
    ) : (
      region
    );
  };
  return (
    <div
      style={{
        width: responsive && !fit ? "100%" : width * scale,
        height: height * scale,
        position: "relative",
      }}
    >
      <div
        ref={host}
        data-forma-hints={hint ? "" : undefined}
        onClickCapture={(e) => {
          activationTarget.current = e.target as Element;
        }}
        onKeyDownCapture={(e) => {
          activationTarget.current = e.target as Element;
        }}
        onPointerMove={(e) => {
          if (e.pointerType === "touch" || e.buttons) return;
          const last = hovered.current;
          if (last?.x === e.clientX && last.y === e.clientY) return;
          const el = (e.target as Element).closest<HTMLElement>(
            "[data-forma-hover]",
          );
          const id = el?.closest("[data-active-screen]")
            ? el.dataset.designId
            : undefined;
          hovered.current = { x: e.clientX, y: e.clientY, id };
          if (id && last?.id !== id) dispatch(id, true, "hover");
        }}
        onPointerLeave={() => {
          hovered.current = null;
        }}
        onClick={(e) => {
          if (
            (e.target as Element).closest(
              "[data-forma-hotspot],button,input,[role=button]",
            )
          )
            return;
          clearTimeout(hintTimer.current);
          setHint(true);
          hintTimer.current = setTimeout(() => setHint(false), 450);
        }}
        style={{
          ...style,
          ...variables,
          position: "relative",
          width: responsive && !fit ? "100%" : width,
          height,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          transform: "scale(" + scale + ")",
          transformOrigin: "top left",
        }}
        onScrollCapture={(e) => {
          const el = e.target as HTMLElement;
          if (el.dataset.designId)
            scroll.current.set(el.dataset.designId, [
              el.scrollLeft,
              el.scrollTop,
            ]);
        }}
      >
        <style>{motionCss}</style>
        <InteractionContext.Provider
          value={{
            wired,
            rules: program.rules,
            multiRules: program.multiRules,
            controls: session.controls,
            changes: session.changes,
          }}
        >
          {motion &&
            !motion.overlay &&
            (() => {
              const old = nodes.find((n) => n.id === motion.from);
              const exitingNode =
                old &&
                smartMatches &&
                motion.transition.type === "smart-animate"
                  ? applySmartAnimateTree(
                      {
                        ...old,
                        style: {
                          ...old.style,
                          position: "relative",
                          left: 0,
                          top: 0,
                        },
                      },
                      smartMatches,
                      motion.transition.duration ?? 300,
                      motion.transition.easing ?? "ease-out",
                      "exit",
                    )
                  : old && {
                      ...old,
                      style: {
                        ...old.style,
                        position: "relative" as const,
                        left: 0,
                        top: 0,
                      },
                    };
              return (
                exitingNode && (
                  <div
                    key={motion.sequence}
                    inert
                    aria-hidden="true"
                    data-forma-motion=""
                    style={{
                      position: "absolute",
                      inset: 0,
                      pointerEvents: "none",
                      ...animation(motion, true, Boolean(smartMatches)),
                    }}
                  >
                    <DesignNodeView node={exitingNode} />
                  </div>
                )
              );
            })()}
          <div key={session.screen + ":" + session.resetCount}>
            {render(screen, false, 0)}
          </div>
          {session.overlays.map((overlay, index) => {
            const node = nodes.find((n) => n.id === overlay.target);
            return node && render(node, true, index);
          })}
        </InteractionContext.Provider>
      </div>
    </div>
  );
}
