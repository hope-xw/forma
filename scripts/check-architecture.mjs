import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const MAX_CSS_IMPORTANT = 25;
const adapterLayers = ["editor", "infrastructure", "server", "electron"];
const forbiddenLayers = new Map([
  [
    "domain",
    [
      ...adapterLayers,
      "application",
      "agent",
      "compiler",
      "runtime",
      "design-system",
    ],
  ],
  ["application", adapterLayers],
  ["compiler", adapterLayers],
  ["runtime", adapterLayers],
]);
const sourceExtensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

function importSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    return node.moduleSpecifier;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  )
    return node.arguments[0];
}

function forbiddenImport(file, layer, specifier) {
  if (/^react(?:-dom)?(?:\/|$)/.test(specifier))
    return layer === "domain" || layer === "application";
  if (!specifier.startsWith(".")) return false;
  // Resolve from the importing file, including nested layers and top-level server/electron.
  const target = path.posix.join(
    path.posix.dirname(file),
    specifier.split(/[?#]/, 1)[0],
  );
  const [root, targetLayer] = target.split("/");
  return (
    root === "server" ||
    root === "electron" ||
    (root === "src" && forbiddenLayers.get(layer).includes(targetLayer))
  );
}

/** Check source dependencies and repository-wide occurrence budgets without writing files. */
export function checkArchitecture(rootDir, { checkCss = true } = {}) {
  const root = path.resolve(rootDir);
  if (!ts.sys.directoryExists(path.join(root, "src")))
    throw Error(`Missing src directory in ${root}`);
  const violations = [];
  let asAnyCount = 0;
  let importantCount = 0;
  function files(extensions, include) {
    return ts.sys
      .readDirectory(root, extensions, undefined, include)
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .sort();
  }

  for (const file of files(sourceExtensions, [
    "src/**/*",
    "server/**/*",
    "electron/**/*",
  ])) {
    const source = readFileSync(path.join(root, file), "utf8");
    const [base, layer] = file.split("/");
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
    function report(position, rule, message) {
      const { line } = parsed.getLineAndCharacterOfPosition(position);
      violations.push({ file, line: line + 1, rule, message });
    }
    if (
      base === "src" &&
      forbiddenLayers.has(layer) &&
      (file.endsWith(".ts") || (layer === "runtime" && file.endsWith(".tsx")))
    ) {
      function visit(node) {
        const spec = importSpecifier(node);
        if (
          spec &&
          ts.isStringLiteralLike(spec) &&
          forbiddenImport(file, layer, spec.text)
        )
          report(
            spec.getStart(parsed),
            "layer",
            `${layer} cannot import ${JSON.stringify(spec.text)}`,
          );
        ts.forEachChild(node, visit);
      }
      visit(parsed);
    }
    for (const match of source.matchAll(
      /:\s*any\b|\bas\s+any\b|@ts-(?:ignore|expect-error)\b/g,
    )) {
      if (match[0].startsWith("as")) {
        if (++asAnyCount > 1)
          report(
            match.index,
            "type",
            '"as any" exceeds the repository limit of 1',
          );
      } else {
        report(match.index, "type", `${JSON.stringify(match[0])} is forbidden`);
      }
    }
  }

  if (checkCss) {
    for (const file of files([".css"], ["src/editor/*.css"])) {
      const source = readFileSync(path.join(root, file), "utf8");
      for (const match of source.matchAll(/!\s*important\b/gi)) {
        if (++importantCount > MAX_CSS_IMPORTANT)
          violations.push({
            file,
            line: source.slice(0, match.index).split("\n").length,
            rule: "css",
            message: `!important exceeds the editor CSS limit of ${MAX_CSS_IMPORTANT}`,
          });
      }
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    asAnyCount,
    importantCount,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const checkCss = !process.argv.includes("--skip-css");
  const result = checkArchitecture(process.cwd(), { checkCss });
  console.log(
    `Architecture ${result.ok ? "PASS" : "FAIL"} (${result.violations.length} violations)`,
  );
  console.log(
    `as any: ${result.asAnyCount}/1  |  CSS !important: ${checkCss ? `${result.importantCount}/${MAX_CSS_IMPORTANT}` : "skipped"}`,
  );
  for (const { file, line, rule, message } of result.violations)
    console.error(`${file}:${line} [${rule}] ${message}`);
  if (!result.ok) process.exitCode = 1;
}
