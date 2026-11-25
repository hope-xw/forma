import test from "node:test";
import assert from "node:assert/strict";
import { createStarter } from "../src/domain/seed";
import { createNode, parseDocument } from "../src/domain/document";
import { layoutBounds } from "../src/domain/geometry";
import { runtimeNodes } from "../src/compiler/runtime";
test("nested Hug and Fill resolve bottom-up then distribute free space and ignore hidden siblings", () => {
  const doc = createStarter(),
    row = createNode("frame"),
    nested = createNode("frame", row.id),
    leaf = createNode("rectangle", nested.id),
    other = createNode("rectangle", row.id),
    hidden = createNode("rectangle", row.id);
  Object.assign(row.style, {
    layout: "row",
    width: 436,
    padding: 10,
    gap: 12,
    heightMode: "hug",
    strokeWidth: 2,
    x: 0,
    y: 0,
  });
  Object.assign(nested.style, {
    layout: "column",
    padding: 8,
    widthMode: "fill",
    heightMode: "hug",
  });
  Object.assign(leaf.style, { height: 30, widthMode: "fill" });
  other.style.widthMode = "fill";
  other.style.height = 12;
  hidden.hidden = true;
  doc.nodes = [row, nested, leaf, other, hidden];
  const saved = parseDocument(doc),
    rect = layoutBounds(saved);
  assert.deepEqual(rect.get(row.id), { x: 0, y: 0, width: 436, height: 70 });
  assert.equal(rect.get(nested.id)?.width, 200);
  assert.equal(rect.get(leaf.id)?.width, 184);
  assert.equal(rect.get(other.id)?.x, 224);
  const compiled = runtimeNodes(saved, undefined, true)[0];
  assert.equal(compiled.style.height, "max-content");
  assert.equal(
    compiled.style.gridTemplateColumns,
    "minmax(1px, 1fr) minmax(1px, 1fr)",
  );
  assert.equal(compiled.children[0].children[0].style.alignSelf, "stretch");
});
test("reparenting Fill to a free frame uses its stored size; Hug does not recurse into Fill on the same axis", () => {
  const doc = createStarter(),
    parent = createNode("frame"),
    child = createNode("rectangle", parent.id);
  doc.nodes = [parent, child];
  child.style.width = 75;
  child.style.widthMode = "fill";
  assert.equal(layoutBounds(doc).get(child.id)?.width, 75);
  parent.style.layout = "row";
  parent.style.widthMode = "hug";
  parent.style.padding = 9;
  assert.equal(layoutBounds(doc).get(parent.id)?.width, 93);
});
test("fixed grids clamp a stored span to the column count and wrap whole items in document order", () => {
  const doc = createStarter(),
    board = createNode("frame"),
    a = createNode("rectangle", board.id),
    b = createNode("rectangle", board.id);
  Object.assign(board.style, {
    x: 0,
    y: 0,
    layout: "grid",
    columns: 3,
    width: 320,
    padding: 0,
    gap: 10,
    heightMode: "hug",
  });
  for (const cell of [a, b])
    Object.assign(cell.style, { widthMode: "fill", columnSpan: 2, height: 40 });
  doc.nodes = [board, a, b];
  const geometry = () => layoutBounds(parseDocument(doc));
  assert.deepEqual(geometry().get(b.id), {
    x: 0,
    y: 50,
    width: 210,
    height: 40,
  });
  board.style.columns = 1;
  assert.equal(geometry().get(b.id)?.width, 320);
  board.style.columns = 3;
  assert.equal(geometry().get(a.id)?.width, 210);
  board.style.minColumnWidth = 100;
  assert.deepEqual(geometry().get(b.id), {
    x: 165,
    y: 0,
    width: 155,
    height: 40,
  });
  b.style.columnSpan = 65;
  assert.throws(() => parseDocument(doc));
});
test("row spans reserve cells and respond to the grid container breakpoint", () => {
  const board = createNode("frame"),
    hero = createNode("rectangle", board.id),
    a = createNode("rectangle", board.id),
    b = createNode("rectangle", board.id);
  Object.assign(board.style, {
    x: 0,
    y: 0,
    width: 768,
    heightMode: "hug",
    layout: "grid",
    columns: 3,
    gridRowHeight: 48,
    gridBreakpoint: 600,
    narrowColumns: 1,
    narrowGap: 8,
    padding: 0,
    gap: 12,
  });
  Object.assign(hero.style, {
    columnSpan: 2,
    rowSpan: 2,
    widthMode: "fill",
    height: 108,
  });
  a.style.height = b.style.height = 40;
  const doc = { ...createStarter(), nodes: [board, hero, a, b] };
  const wide = layoutBounds(parseDocument(doc));
  assert.equal(wide.get(a.id)?.x, 520);
  assert.equal(wide.get(b.id)?.y, 60);
  assert.equal(wide.get(board.id)?.height, 108);
  board.style.width = 600;
  const narrow = layoutBounds(parseDocument(doc));
  assert.equal(narrow.get(hero.id)?.width, 600);
  assert.equal(narrow.get(a.id)?.y, 112);
  assert.equal(narrow.get(board.id)?.height, 216);
  hero.style.rowSpan = 0;
  assert.throws(() => parseDocument(doc));
});

test("explicit cells reserve later rows before auto placement and intrinsic tracks keep their content width", () => {
  const doc = createStarter(),
    root = createNode("frame"),
    a = createNode("rectangle", root.id),
    b = createNode("rectangle", root.id),
    c = createNode("rectangle", root.id);
  Object.assign(root.style, {
    x: 0,
    y: 0,
    width: 600,
    height: 300,
    layout: "grid",
    gridTracks: "150px auto 2fr 1fr",
    gridRowTracks: "40px 1fr 2fr",
    gap: 10,
    padding: 0,
  });
  Object.assign(a.style, {
    width: 65,
    height: 20,
    gridCell: { row: 1, column: 2 },
  });
  Object.assign(b.style, {
    widthMode: "fill",
    heightMode: "fill",
    gridCell: { row: 3, column: 3 },
    columnSpan: 2,
  });
  Object.assign(c.style, { widthMode: "fill", heightMode: "fill" });
  doc.nodes = [root, c, b, a];
  const rect = layoutBounds(doc);
  assert.deepEqual(rect.get(a.id), { x: 160, y: 0, width: 65, height: 20 });
  assert.deepEqual(rect.get(c.id), { x: 0, y: 0, width: 150, height: 40 });
  assert.deepEqual(rect.get(b.id), { x: 235, y: 140, width: 365, height: 160 });
});
