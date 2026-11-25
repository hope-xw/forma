import { fontSettingsSchema } from "./font-settings";
import { z } from "zod";
const inlineStyle = z.object({
  fontWeight: z.number().int().min(100).max(900).optional(),
  fontStyle: z.literal("italic").optional(),
  textDecoration: z
    .enum(["underline", "line-through", "underline line-through"])
    .optional(),
  letterSpacing: z.number().min(-100).max(500).optional(),
  fontSize: z.number().min(1).max(500).optional(),
  color: z
    .string()
    .regex(/^#[\da-f]{6}$/i)
    .optional(),
  ...fontSettingsSchema,
  fontFamily: z.string().min(1).max(200).optional(),
});
export const textRunsSchema = z
  .array(
    z.object({
      start: z.number().int().min(0),
      end: z.number().int().positive(),
      style: inlineStyle,
    }),
  )
  .max(10000);
export type InlineStyle = z.infer<typeof inlineStyle>;
export type TextRuns = z.infer<typeof textRunsSchema>;
export interface TextDraft {
  text: string;
  textRuns?: TextRuns;
}
const clean = (s: InlineStyle) =>
  Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined),
  ) as InlineStyle;
function merge(runs: TextRuns) {
  const out: TextRuns = [];
  for (const r of runs) {
    const style = clean(r.style);
    if (r.start >= r.end || !Object.keys(style).length) continue;
    const last = out.at(-1);
    if (
      last?.end === r.start &&
      (Object.keys({ ...last.style, ...style }) as (keyof InlineStyle)[]).every(
        (k) => last.style[k] === style[k],
      )
    )
      last.end = r.end;
    else out.push({ start: r.start, end: r.end, style });
  }
  return out.length ? out : undefined;
}
export function textParts(draft: TextDraft) {
  let offset = 0;
  const parts: { text: string; style: InlineStyle }[] = [];
  for (const run of draft.textRuns ?? []) {
    if (run.start > offset)
      parts.push({ text: draft.text.slice(offset, run.start), style: {} });
    parts.push({
      text: draft.text.slice(run.start, run.end),
      style: run.style,
    });
    offset = run.end;
  }
  if (offset < draft.text.length)
    parts.push({ text: draft.text.slice(offset), style: {} });
  return parts;
}
export function formatRange(
  draft: TextDraft,
  start: number,
  end: number,
  patch: InlineStyle,
): TextDraft {
  if (start === end) return draft;
  const points = [
    ...new Set([
      0,
      start,
      end,
      draft.text.length,
      ...(draft.textRuns ?? []).flatMap((r) => [r.start, r.end]),
    ]),
  ].sort((a, b) => a - b);
  let i = 0;
  const runs = draft.textRuns ?? [];
  return {
    text: draft.text,
    textRuns: merge(
      points.slice(0, -1).map((a, j) => {
        while (i < runs.length && runs[i].end <= a) i++;
        const base = runs[i] && runs[i].start <= a ? runs[i].style : {};
        return {
          start: a,
          end: points[j + 1],
          style: a >= start && a < end ? { ...base, ...patch } : base,
        };
      }),
    ),
  };
}
export function replaceText(draft: TextDraft, text: string): TextDraft {
  if (text === draft.text) return draft;
  if (!draft.textRuns?.length) return { text };
  let a = 0,
    end = draft.text.length,
    newEnd = text.length;
  while (a < end && a < newEnd && draft.text[a] === text[a]) a++;
  while (end > a && newEnd > a && draft.text[end - 1] === text[newEnd - 1]) {
    end--;
    newEnd--;
  }
  const diff = newEnd - end,
    runs: TextRuns = [];
  for (const r of draft.textRuns) {
    if (r.start < a) runs.push({ ...r, end: Math.min(a, r.end) });
  }
  const inserted = draft.textRuns.find(
    (r) => r.start <= a && (a < r.end || (a === r.end && a === end)),
  );
  if (inserted && newEnd > a)
    runs.push({ start: a, end: newEnd, style: inserted.style });
  for (const r of draft.textRuns)
    if (r.end > end)
      runs.push({
        ...r,
        start: Math.max(r.start, end) + diff,
        end: r.end + diff,
      });
  return { text, textRuns: merge(runs) };
}
export function validateRuns(draft: TextDraft) {
  let end = 0;
  for (const r of draft.textRuns ?? []) {
    if (r.start < end || r.start >= r.end || r.end > draft.text.length)
      throw new Error("文字样式范围无效");
    end = r.end;
  }
}
