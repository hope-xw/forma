import type { DesignDocument, ImportIssue } from "../../domain/document";

const generic =
  /^(system-ui|sans-serif|serif|monospace|ui-serif|ui-sans-serif|ui-monospace|emoji|inherit|-apple-system|BlinkMacSystemFont)$/i;

const fontChecks = new Map<string, Promise<boolean | undefined>>();
export function canLoadLocalFont(family: string): Promise<boolean | undefined> {
  const name = family
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!name || generic.test(name)) return Promise.resolve(true);
  if (typeof FontFace === "undefined") return Promise.resolve(undefined);
  const cached = fontChecks.get(name);
  if (cached) return cached;
  const result = Promise.resolve()
    .then(async () => {
      const font = new FontFace(
        "FormaImportCheck",
        "local(" + JSON.stringify(name) + ")",
      );
      await font.load();
      return true;
    })
    .catch(() => false);
  fontChecks.set(name, result);
  return result;
}

/** Local font access differs between browsers. Preserve the requested face even when access fails. */
export async function checkImportedFonts(
  doc: DesignDocument,
): Promise<ImportIssue[]> {
  const embedded = new Set(Object.values(doc.fonts ?? {}).map((f) => f.name));
  const usage = new Map<string, { node: string; count: number }>();
  for (const nodes of [
    doc.nodes,
    ...(doc.pages ?? []).map((p) => p.nodes ?? []),
  ])
    for (const node of nodes) {
      if (node.type !== "text" && !node.text) continue;
      const families = new Set([
        node.style.fontFamily,
        ...(node.textRuns ?? []).map((r) => r.style.fontFamily),
      ]);
      for (const family of families) {
        const first = family
          ?.split(",")[0]
          ?.trim()
          .replace(/^["']|["']$/g, "");
        if (
          !first ||
          generic.test(first) ||
          Object.hasOwn(doc.fonts ?? {}, first) ||
          embedded.has(first)
        )
          continue;
        const item = usage.get(first) ?? { node: node.id, count: 0 };
        item.count++;
        usage.set(first, item);
      }
    }
  if (!usage.size) return [];
  if (typeof FontFace === "undefined")
    return [
      {
        node: "字体",
        detail: "此环境无法检查本机字体，请核对原稿字体与断行。",
      },
    ];
  const issues: ImportIssue[] = [];
  for (const [name, item] of usage) {
    if ((await canLoadLocalFont(name)) === false) {
      issues.push({
        ...item,
        detail:
          "此环境未能载入本机字体 " +
          name +
          "，改字或调整排版时将使用替代字体。",
      });
    }
  }
  return issues;
}
