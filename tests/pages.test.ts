import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStarter } from "../src/domain/seed";
import { parseDocument, createNode } from "../src/domain/document";
import {
  addPage,
  openPage,
  pageList,
  removePage,
  duplicatePage,
  reorderPage,
} from "../src/domain/pages";
import { transact } from "../src/domain/commands";
import { layoutBounds } from "../src/domain/geometry";
import { nodeCss } from "../src/compiler/react";
import { pageForExport } from "../src/compiler/runtime";
test("legacy file → multiple pages → duplicate, reorder, delete and reopen retains isolated trees", () => {
  const original = createStarter(),
    empty = addPage(original, "Mobile");
  assert.equal(empty.nodes.length, 0);
  const second = transact(empty, {
    baseRevision: empty.revision,
    operations: [{ type: "create", node: createNode("frame") }],
  });
  const first = openPage(second, "first"),
    copy = duplicatePage(first);
  assert.deepEqual(first.nodes, original.nodes);
  assert.equal(copy.nodes.length, first.nodes.length);
  assert.ok(
    copy.nodes.every((node) => !first.nodes.some((old) => old.id === node.id)),
  );
  const sorted = reorderPage(copy, copy.activePage!, "first");
  assert.equal(pageList(sorted)[0].id, copy.activePage);
  const removed = removePage(sorted);
  assert.equal(
    parseDocument(JSON.parse(JSON.stringify(removed))).pages?.length,
    2,
  );
  assert.throws(() => removePage(original));
});
test("invalid inactive page references and shared IDs are rejected; React export excludes other pages", () => {
  const example = parseDocument(
    JSON.parse(
      readFileSync("public/examples/mobile-studio.forma.json", "utf8"),
    ),
  );
  const inactive = example.pages!.find((page) => page.nodes)!;
  const exported = pageForExport(example, [example.nodes[0].id]);
  assert.ok(!exported.pages && !exported.activePage);
  assert.ok(
    !exported.nodes.some((node) =>
      inactive.nodes!.some((other) => other.id === node.id),
    ),
  );
  inactive.nodes![0].id = example.nodes[0].id;
  assert.throws(() => parseDocument(example), /跨页/);
});
test("independent insets and nine-position alignment agree with CSS for a column and row", () => {
  const doc = createStarter(),
    board = createNode("frame"),
    child = createNode("rectangle", board.id);
  Object.assign(board.style, {
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    layout: "column",
    insets: { top: 10, right: 20, bottom: 30, left: 40 },
    alignX: "end",
    alignY: "center",
  });
  Object.assign(child.style, { width: 60, height: 40 });
  doc.nodes = [board, child];
  for (const direction of ["row", "column"] as const) {
    board.style.layout = direction;
    assert.deepEqual(layoutBounds(doc).get(child.id), {
      x: 220,
      y: 70,
      width: 60,
      height: 40,
    });
    assert.equal(nodeCss(board, doc).padding, "10px 20px 30px 40px");
  }
});
test("guides belong to a page, duplicate independently and snap on their own axis", async () => {
  const { snapMove } = await import("../src/domain/geometry");
  const doc = createStarter();
  doc.guides = [{ id: "line", axis: "x", value: 100 }];
  const blank = addPage(doc, "blank");
  assert.equal(blank.guides, undefined);
  const reopened = openPage(parseDocument(blank), "first");
  const copy = duplicatePage(reopened);
  assert.notEqual(copy.guides?.[0].id, "line");
  assert.equal(copy.guides?.[0].value, 100);
  assert.deepEqual(
    snapMove({ x: 98, y: 99, width: 20, height: 20 }, [], 5, doc.guides),
    { dx: 2, dy: 0, guides: [{ axis: "x", value: 100 }] },
  );
});
