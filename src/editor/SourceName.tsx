import type { CSSProperties } from "react";
import type { FontAsset } from "../domain/fonts";

const privateUse = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
const runs = /([\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+)/gu;
export function sourceNameFonts(
  fonts: Record<string, FontAsset> | undefined,
): CSSProperties | undefined {
  if (!fonts || !Object.keys(fonts).length) return;
  // Prefer upright regular faces. The browser checks the remaining embedded
  // cmaps in order before substituting a platform font for an uncovered glyph.
  const rank = (f: FontAsset) =>
    (f.italic ? 2000 : 0) + Math.abs((f.weight ?? 400) - 400);
  const families = Object.entries(fonts)
    .sort((a, b) => rank(a[1]) - rank(b[1]))
    .map(([id]) => '"' + id + '"')
    .join(", ");
  return { "--source-name-families": families } as CSSProperties;
}
export function SourceName({ name }: { name: string }) {
  if (!privateUse.test(name)) return name;
  return name.split(runs).map((text, i) =>
    privateUse.test(text) ? (
      <span
        key={i}
        data-source-symbol=""
        style={{ fontFamily: "var(--source-name-families, inherit)" }}
      >
        {text}
      </span>
    ) : (
      text
    ),
  );
}
