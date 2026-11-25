import { z } from "zod";
import type { DesignNode, NodeStyle } from "./node";

const spacing = z.number().min(0).max(1000);
const rule = z.object({
  maxWidth: z.number().int().min(1).max(10000),
  columns: z.number().int().min(1).max(64).optional(),
  gap: spacing.optional(),
  rowGap: spacing.optional(),
  padding: spacing.optional(),
  radius: spacing.optional(),
  opacity: z.number().min(0).max(1).optional(),
  fill: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type LayoutRule = z.infer<typeof rule>;
export const layoutBreakpoints = z
  .array(rule)
  .max(9)
  .refine(
    (rules) => new Set(rules.map((r) => r.maxWidth)).size === rules.length,
    "每个断点须使用不同的最大宽度",
  );
export function editableRules(s: Partial<NodeStyle>, activeOnly = false) {
  const rules = new Map<number, LayoutRule>();
  if (s.layout === "grid" && s.gridBreakpoint && !s.minColumnWidth)
    rules.set(s.gridBreakpoint, {
      maxWidth: s.gridBreakpoint,
      columns: s.narrowColumns ?? 1,
      ...(s.narrowGap === undefined ? {} : { gap: s.narrowGap }),
    });
  for (const entry of s.layoutBreakpoints ?? []) {
    const { maxWidth, radius, opacity, fill } = entry;
    const appearanceOnly =
      activeOnly && (s.layout === "free" || s.widthMode === "hug");
    if (
      appearanceOnly &&
      radius === undefined &&
      opacity === undefined &&
      fill === undefined
    )
      continue;
    const rule = appearanceOnly ? { maxWidth, radius, opacity, fill } : entry;
    rules.set(maxWidth, {
      ...rules.get(maxWidth),
      ...Object.fromEntries(
        Object.entries(rule).filter(([, v]) => v !== undefined),
      ),
      maxWidth,
    });
  }
  return [...rules.values()];
}
export function saveRules(rules?: LayoutRule[]): Partial<NodeStyle> {
  return {
    layoutBreakpoints: rules,
    gridBreakpoint: undefined,
    narrowColumns: undefined,
    narrowGap: undefined,
  };
}
/** Resolve each range independently of source order. More specific values override broader ones. */
export function breakpointRules(s: NodeStyle) {
  if (!s.gridBreakpoint && !s.layoutBreakpoints?.length) return [];
  const rules = editableRules(s, true);
  if (!rules.length) return rules;
  const ranges = new Map<number, LayoutRule>();
  let inherited: Partial<LayoutRule> = {};
  for (const rule of rules.sort((a, b) => b.maxWidth - a.maxWidth)) {
    inherited = {
      ...inherited,
      ...Object.fromEntries(
        Object.entries(rule).filter(([, value]) => value !== undefined),
      ),
    };
    ranges.set(rule.maxWidth, { ...inherited, maxWidth: rule.maxWidth });
  }
  return [...ranges.values()].reverse();
}
export function layoutRuleAt(s: NodeStyle, width: number) {
  return breakpointRules(s).find((rule) => width <= rule.maxWidth);
}
export function gridBreakpoint(node: DesignNode) {
  const rules = breakpointRules(node.style);
  if (!rules.length) return undefined;
  return {
    rules,
    hasExplicitRowGap: node.style.rowGap !== undefined,
    variable:
      "--forma-grid-" +
      Array.from(node.id, (char) => char.codePointAt(0)!.toString(16)).join(
        "-",
      ),
  };
}
export function responsiveSpacing(s: NodeStyle, width: number) {
  const rule = layoutRuleAt(s, width);
  return {
    padding: rule?.padding ?? s.padding,
    insets: rule?.padding === undefined ? s.insets : undefined,
    gap: rule?.gap ?? s.gap,
    rowGap: rule?.rowGap ?? s.rowGap,
  };
}
