import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { exportNodeToSvg } from "../src/compiler/svg-export";
import {
  BUILTIN_LIBRARIES,
  BUILTIN_LIBRARY_IDS,
} from "../src/design-system/catalog";
import { createNode, type DesignDocument } from "../src/domain/document";
import { OFFICIAL_BUILTIN_LIBRARY_IDS } from "../src/domain/library-schema";

const checker = new URL("../scripts/check-architecture.mjs", import.meta.url);
interface Violation {
  file: string;
  line: number;
  rule: string;
  message: string;
}
const {
  checkArchitecture,
  MAX_CSS_IMPORTANT,
}: {
  checkArchitecture(
    root: string,
    options?: { checkCss?: boolean },
  ): {
    ok: boolean;
    violations: Violation[];
    asAnyCount: number;
    importantCount: number;
  };
  MAX_CSS_IMPORTANT: number;
} = await import(checker.href);

function fixture(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "forma-architecture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

test("workspace meets layer, type and editor CSS budgets", () => {
  const report = checkArchitecture(process.cwd(), { checkCss: true });
  assert.ok(
    report.ok,
    report.violations
      .slice(0, 5)
      .map(({ file, line, message }) => `${file}:${line} ${message}`)
      .join("\n") +
      `\n${report.violations.length} violations, ${report.importantCount}/${MAX_CSS_IMPORTANT} !important`,
  );
  assert.deepEqual(report.violations, []);
});

test("official read-only IDs cover exactly the four registered catalog kits", () => {
  assert.deepEqual(
    OFFICIAL_BUILTIN_LIBRARY_IDS,
    new Set([
      "forma-mobile-v1",
      "forma-material3-v1",
      "forma-antd5-v1",
      "forma-shadcn-v1",
    ]),
  );
  assert.deepEqual(BUILTIN_LIBRARY_IDS, OFFICIAL_BUILTIN_LIBRARY_IDS);
  assert.deepEqual(
    new Set(BUILTIN_LIBRARIES.map(({ id }) => id)),
    OFFICIAL_BUILTIN_LIBRARY_IDS,
  );
});

test("layer checks resolve imports from nested files and report the specifier's line", (t) => {
  const domainLayers = [
    "application",
    "infrastructure",
    "editor",
    "agent",
    "compiler",
    "runtime",
    "design-system",
    "server",
    "electron",
  ];
  const root = fixture(t, {
    "src/domain/nested/file.ts": [
      'import type { T } from "react";',
      'import "react-dom/client";',
      ...domainLayers.map((layer) => `export * from "../../${layer}/api";`),
      'import "../allowed";',
      'import "reactive";',
      'const example = /import "react"/;',
    ].join("\n"),
    "src/application/features/session.ts": [
      "export type { T } from",
      '"react/jsx-runtime";',
      'const load = () => import("../../infrastructure/store");',
      'export * from "../../../server/api";',
      'import "../../agent/allowed";',
    ].join("\n"),
    "src/compiler/export.ts":
      'type T = import("../editor/view").T;\nimport "../runtime/allowed";',
    "src/runtime/ui/view.tsx":
      'import "react";\nconst bridge = require("../../../electron/main");\nconst label = <p>import "../editor/view"</p>;',
  });
  const result = checkArchitecture(root);
  assert.deepEqual(
    result.violations.map(({ file, line, rule }) => [file, line, rule]),
    [
      ...[2, 3, 4].map((line) => [
        "src/application/features/session.ts",
        line,
        "layer",
      ]),
      ["src/compiler/export.ts", 1, "layer"],
      ...Array.from({ length: 2 + domainLayers.length }, (_, i) => [
        "src/domain/nested/file.ts",
        i + 1,
        "layer",
      ]),
      ["src/runtime/ui/view.tsx", 2, "layer"],
    ],
  );
});

test("type budgets span renderer, server and Electron sources even with --skip-css", (t) => {
  const root = fixture(t, {
    "electron/main.mjs": "// @ts-expect-error intentional fixture",
    "electron/preload.cjs": "// @ts-ignore intentional fixture",
    "server/api.ts": "const a = input as any;",
    "src/editor/view.tsx": "const b: any = input;\nconst c = input as any;",
  });
  const result = checkArchitecture(root, { checkCss: false });
  assert.equal(result.asAnyCount, 2);
  assert.deepEqual(
    result.violations.map(({ file, line, rule }) => [file, line, rule]),
    [
      ["electron/main.mjs", 1, "type"],
      ["electron/preload.cjs", 1, "type"],
      ["src/editor/view.tsx", 1, "type"],
      ["src/editor/view.tsx", 2, "type"],
    ],
  );
  const cli = spawnSync(
    process.execPath,
    [fileURLToPath(checker), "--skip-css"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /src\/editor\/view\.tsx:2 \[type\]/);
});

test("CSS budget accepts 25 across stylesheets, rejects 26, and is optional only on request", (t) => {
  assert.equal(MAX_CSS_IMPORTANT, 25);
  const declaration = ".example { color: red !important }\n";
  const root = fixture(t, {
    "src/editor/a.css": declaration.repeat(24),
    "src/editor/b.css": declaration,
    "src/editor/nested/other.css": declaration,
    "src/other.css": declaration,
    "src/example.ts": "const a = input as any;",
  });
  assert.equal(checkArchitecture(root).ok, true);
  writeFileSync(path.join(root, "src/editor/b.css"), declaration.repeat(2));
  const report = checkArchitecture(root);
  assert.equal(report.importantCount, 26);
  assert.deepEqual(
    report.violations.map(({ file, line, rule }) => [file, line, rule]),
    [["src/editor/b.css", 2, "css"]],
  );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [fileURLToPath(checker), ...args], {
      cwd: root,
      encoding: "utf8",
    });
  const defaultCli = run();
  assert.equal(defaultCli.status, 1);
  assert.match(defaultCli.stderr, /src\/editor\/b\.css:2 \[css\]/);
  const skipped = run("--skip-css");
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /PASS/);
});

test("SVG text wraps consistently without accessing the browser document", (t) => {
  const label = createNode("text");
  label.text = "中文abc";
  Object.assign(label.style, { width: 15, height: 80, fontSize: 10 });
  const doc: DesignDocument = {
    schemaVersion: 1,
    id: "test",
    name: "test",
    revision: 0,
    tokens: {},
    nodes: [label],
  };
  const svg = exportNodeToSvg(doc, label.id);
  assert.deepEqual(
    [...svg.matchAll(/<tspan[^>]*>([^<>]+)<\/tspan>/g)].map((m) => m[1]),
    ["中", "文", "ab", "c"],
  );
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    get() {
      throw Error("SVG compiler accessed the browser document");
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  });
  assert.equal(exportNodeToSvg(doc, label.id), svg);
});
