import test from "node:test";
import assert from "node:assert/strict";
import { createStarter } from "../src/domain/seed";
import {
  classifyImportIssue,
  importSummary,
} from "../src/infrastructure/design-import/summary";

test("importSummary resolves human-readable labels for nodes, variables, styles, components, and document keys", () => {
  const doc = createStarter();
  doc.activePage = "page-1";
  doc.pages = [{ id: "page-1", name: "封面" }];
  const firstNode = doc.nodes[0];
  doc.designSystem = {
    collections: {
      c1: {
        id: "c1",
        name: "Colors",
        modes: [{ id: "m1", name: "Light" }],
        defaultModeId: "m1",
      },
    },
    activeModes: { c1: "m1" },
    variables: {
      "FCB79DE3-BA43-4DBB-A8A9-D81CD086E79E": {
        id: "FCB79DE3-BA43-4DBB-A8A9-D81CD086E79E",
        collectionId: "c1",
        name: "Fills/Primary",
        type: "color",
        values: { m1: "#007aff" },
        scopes: [],
        description: "",
        codeSyntax: "",
      },
    },
    styles: {
      "style-1": {
        id: "style-1",
        name: "Material/Chrome",
        kind: "paint",
        properties: { fill: "#ffffff" },
        bindings: {},
        description: "",
      },
    },
  };
  doc.importReport = {
    version: 1,
    format: "Sketch",
    filename: "kit.sketch",
    sha256: "a".repeat(64),
    sourceNodes: 10,
    issues: [
      { node: firstNode.id, detail: "Liquid Glass 折射、色散及光照参数已保留" },
      {
        node: "FCB79DE3-BA43-4DBB-A8A9-D81CD086E79E",
        detail: "色变量透明度保留在引用图层，变量值采用 RGB",
      },
      { node: "style-1", detail: "共享样式缺失：abc" },
      { node: "document", detail: "嵌入字体排版引擎无法加载" },
    ],
  };

  const summary = importSummary(doc);
  assert.equal(summary.positions.get(firstNode.id)?.name, firstNode.name);
  assert.equal(summary.positions.get(firstNode.id)?.pageName, "封面");
  assert.equal(
    summary.labels.get("FCB79DE3-BA43-4DBB-A8A9-D81CD086E79E"),
    "色变量 · Fills/Primary",
  );
  assert.equal(summary.labels.get("style-1"), "样式 · Material/Chrome");
  assert.equal(summary.labels.get("document"), "文档全局");

  assert.equal(classifyImportIssue("此环境未能载入本机字体 SF Pro"), "font");
  assert.equal(
    classifyImportIssue("Liquid Glass 折射、色散及光照参数已保留"),
    "style",
  );
  assert.equal(
    classifyImportIssue("实例尺寸与主件不同，内部约束及自适应布局需复核"),
    "component",
  );
  assert.equal(
    classifyImportIssue("Sketch 智能布局（Smart Layout）已保留当前尺寸"),
    "layout",
  );
});
