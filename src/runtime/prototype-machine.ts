export type Value = string | number | boolean;
export type Trigger = "click" | "hover" | "delay";
export interface Transition {
  type:
    "instant" | "dissolve" | "move-in" | "push" | "slide-in" | "smart-animate";
  direction?: "left" | "right" | "top" | "bottom";
  duration?: number;
  easing?: "linear" | "ease-out" | "ease-in-out";
}
export type Action =
  | { kind: "openLink"; url: string }
  | {
      kind: "navigate";
      target: string;
      resetScroll?: boolean;
      transition?: Transition;
    }
  | {
      kind: "overlay";
      target: string;
      position: "bottom" | "center";
      transition?: Transition;
    }
  | { kind: "close" | "back" | "reset" }
  | { kind: "scrollTo"; target: string }
  | { kind: "control"; target: string; value: Value }
  | { kind: "set"; variable: string; value: Value }
  | { kind: "input" | "toggle"; variable: string };
export interface Rule {
  trigger?: Trigger;
  delayMs?: number;
  condition?: {
    variable: string;
    operator: "equals" | "different" | "greater" | "less";
    value: Value;
  };
  actions?: Action[];
  otherwise?: Action[];
}
export interface Program {
  flows: { id: string; name: string }[];
  rules: Record<string, Rule>;
  multiRules?: Record<string, Rule[]>;
  variables: Record<string, Value>;
  p3Variables?: string[];
  cssNames: Record<string, string>;
}
export function rulesFor(program: Program, id: string): Rule[] {
  const multi = program.multiRules?.[id];
  if (multi?.length) return multi;
  const single = program.rules[id];
  return single ? [single] : [];
}
export interface Session {
  start: string;
  screen: string;
  history: string[];
  overlays: { target: string; position: "center" | "bottom" }[];
  variables: Record<string, Value>;
  changes: Record<string, Value>;
  controls: Record<string, Value>;
  scrollTarget?: string;
  scrollReset?: string;
  resetCount: number;
}
export function startFlow(program: Program, start: string): Session {
  return {
    start,
    screen: start,
    history: [],
    overlays: [],
    variables: { ...program.variables },
    changes: {},
    controls: {},
    resetCount: 0,
  };
}
export function act(
  program: Program,
  previous: Session,
  actions: Action[],
  input: Value = true,
): Session {
  let next = {
    ...previous,
    scrollTarget: undefined,
    scrollReset: undefined,
  } as Session;
  for (const action of actions) {
    switch (action.kind) {
      case "navigate":
        if (next.screen !== action.target)
          next.history = [...next.history, next.screen];
        next.screen = action.target;
        next.overlays = [];
        if (action.resetScroll) next.scrollReset = action.target;
        break;
      case "overlay":
        next.overlays = [
          ...next.overlays.filter((o) => o.target !== action.target),
          { target: action.target, position: action.position },
        ];
        break;
      case "close":
        next.overlays = next.overlays.slice(0, -1);
        break;
      case "back":
        if (next.overlays.length) next.overlays = next.overlays.slice(0, -1);
        else if (next.history.length) {
          next.screen = next.history.at(-1)!;
          next.history = next.history.slice(0, -1);
        }
        break;
      case "reset":
        next = {
          ...startFlow(program, next.start),
          resetCount: next.resetCount + 1,
        };
        break;
      case "scrollTo":
        next.scrollTarget = action.target;
        break;
      case "control":
        next.controls = { ...next.controls, [action.target]: action.value };
        break;
      case "set":
      case "input":
      case "toggle": {
        const value =
          action.kind === "set"
            ? action.value
            : action.kind === "toggle"
              ? !next.variables[action.variable]
              : input;
        next.changes = { ...next.changes, [action.variable]: value };
        next.variables = { ...next.variables, [action.variable]: value };
        break;
      }
    }
  }
  return next;
}
export function actionsFor(rule: Rule | undefined, session: Session): Action[] {
  const condition = rule?.condition;
  const value = condition && session.variables[condition.variable];
  const matches =
    !condition ||
    (condition.operator === "equals"
      ? value === condition.value
      : condition.operator === "different"
        ? value !== condition.value
        : typeof value === "number" &&
          typeof condition.value === "number" &&
          (condition.operator === "greater"
            ? value > condition.value
            : value < condition.value));
  return (matches ? rule?.actions : rule?.otherwise) ?? [];
}
export function trigger(
  program: Program,
  session: Session,
  id: string,
  input: Value,
  event: Trigger = "click",
) {
  const matching = rulesFor(program, id).filter(
    (rule) => (rule.trigger ?? "click") === event,
  );
  if (!matching.length) return session;
  let next =
    event === "click"
      ? { ...session, controls: { ...session.controls, [id]: input } }
      : session;
  for (const rule of matching) {
    next = act(program, next, actionsFor(rule, next), input);
  }
  return next;
}
