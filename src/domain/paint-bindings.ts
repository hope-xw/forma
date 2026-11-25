import type { NodeStyle } from "./document";

type Paints = Pick<Partial<NodeStyle>, "gradient" | "paints" | "strokePaints">;
type PaintProperty = "fill" | "fillOpacity" | "stroke" | "strokeOpacity";

export function paintVariables(style: Paints) {
  const bindings: { property: PaintProperty; id: string }[] = [];
  function collect(
    gradient: NodeStyle["gradient"],
    property: "fill" | "stroke" = "fill",
  ) {
    for (const stop of gradient?.stops ?? [])
      if (stop.variableId) bindings.push({ property, id: stop.variableId });
  }
  collect(style.gradient);
  for (const stack of ["paints", "strokePaints"] as const) {
    const stroke = stack === "strokePaints";
    for (const paint of style[stack] ?? []) {
      collect(paint.gradient, stroke ? "stroke" : "fill");
      if (paint.colorVariableId)
        bindings.push({
          property: stroke ? "stroke" : "fill",
          id: paint.colorVariableId,
        });
      if (paint.opacityVariableId)
        bindings.push({
          property: stroke ? "strokeOpacity" : "fillOpacity",
          id: paint.opacityVariableId,
        });
    }
  }
  return bindings;
}

export function mapPaintVariables<T extends Paints>(
  style: T,
  change: (id: string) => { value?: string | number | boolean; id?: string },
): T {
  const mapGradient = (g: NodeStyle["gradient"]) =>
    g && {
      ...g,
      stops: g.stops.map((s) => {
        if (!s.variableId) return s;
        const v = change(s.variableId);
        return {
          ...s,
          color: typeof v.value === "string" ? v.value : s.color,
          variableId: v.id ?? s.variableId,
        };
      }),
    };
  const applyPaints = (paints: NonNullable<NodeStyle["paints"]>) =>
    paints.map((p) => {
      const color = p.colorVariableId && change(p.colorVariableId);
      const alpha = p.opacityVariableId && change(p.opacityVariableId);
      return {
        ...p,
        ...(p.gradient ? { gradient: mapGradient(p.gradient) } : {}),
        ...(color
          ? {
              color: typeof color.value === "string" ? color.value : p.color,
              colorVariableId: color.id ?? p.colorVariableId,
            }
          : {}),
        ...(alpha
          ? {
              opacity:
                typeof alpha.value === "number" ? alpha.value : p.opacity,
              opacityVariableId: alpha.id ?? p.opacityVariableId,
            }
          : {}),
      };
    });
  return {
    ...style,
    ...(style.gradient && { gradient: mapGradient(style.gradient) }),
    ...(style.paints && { paints: applyPaints(style.paints) }),
    ...(style.strokePaints && {
      strokePaints: applyPaints(style.strokePaints),
    }),
  };
}
