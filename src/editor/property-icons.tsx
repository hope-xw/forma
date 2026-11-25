import {
  Blend,
  Radius,
  Space,
  BetweenHorizontalStart,
  Bold,
  Baseline,
  CaseSensitive,
  WrapText,
  MoveVertical as Leading,
  ScanLine,
  Droplets,
  Layers,
  RotateCw,
  Columns3,
  Rows3,
  Ruler,
} from "lucide-react";
import type { NodeStyle } from "../domain/document";
import type { BooleanOperation } from "../domain/boolean-shapes";
export function BooleanIcon({ mode }: { mode: BooleanOperation }) {
  const a = "M2 2h9v4H6v5H2Z",
    b = "M11 6h4v9H6v-4h5Z",
    intersection = "M6 6h5v5H6Z";
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" aria-hidden="true">
      <path
        d="M2 2h9v9H2ZM6 6h9v9H6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth=".8"
        opacity=".5"
      />
      <path
        fill="currentColor"
        d={
          mode === "intersect"
            ? intersection
            : mode === "subtract"
              ? a
              : mode === "exclude"
                ? a + b
                : a + b + intersection
        }
      />
    </svg>
  );
}
const monograms: Partial<Record<keyof NodeStyle, string>> = {
  x: "X",
  y: "Y",
  width: "W",
  height: "H",
};
const glyphs = {
  rotation: RotateCw,
  columns: Columns3,
  rowGap: Rows3,
  minColumnWidth: Ruler,
  opacity: Blend,
  radius: Radius,
  gap: Space,
  padding: BetweenHorizontalStart,
  fontSize: CaseSensitive,
  fontWeight: Bold,
  fontFamily: Baseline,
  letterSpacing: WrapText,
  lineHeight: Leading,
  strokeWidth: ScanLine,
  blur: Droplets,
  backdropBlur: Layers,
};
export function PropertyGlyph({
  property,
  label,
}: {
  property?: keyof NodeStyle;
  label: string;
}) {
  if (property && monograms[property]) {
    return <span aria-hidden>{monograms[property]}</span>;
  }
  const Icon = property && glyphs[property as keyof typeof glyphs];
  return Icon ? (
    <Icon size={13} strokeWidth={1.6} aria-hidden />
  ) : (
    <span>{label}</span>
  );
}
