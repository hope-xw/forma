import test from "node:test";
import assert from "node:assert/strict";
import { createNode, parseDocument } from "../src/domain/document";
import { createStarter } from "../src/domain/seed";
import { alignOperations } from "../src/domain/editing";
import { runtimeNodes } from "../src/compiler/runtime";
import { nodeCss } from "../src/compiler/react";
import { nativeDesignSystem } from "../src/design-system/tokens";
test("layered paints and corners survive serialization, a variable-backed base and React compilation", () => {
  const doc = createStarter(),
    frame = createNode("frame");
  doc.nodes = [frame];
  doc.designSystem = nativeDesignSystem();
  frame.variableBindings = { fill: "color-accent" };
  Object.assign(frame.style, {
    corners: { tl: 47, tr: 3, br: 5, bl: 8 },
    strokeWidth: 4,
    strokeStyle: "dotted",
    blendMode: "screen",
    paints: [
      { id: "tint", color: "#336699", opacity: 0.5, visible: true },
      { id: "off", color: "#ff0000", opacity: 1, visible: false },
    ],
  });
  const saved = parseDocument(JSON.parse(JSON.stringify(doc))),
    editor = nodeCss(saved.nodes[0], saved),
    code = runtimeNodes(saved, undefined, true)[0].style;
  for (const css of [editor, code]) {
    assert.equal(css.borderRadius, "47px 3px 5px 8px");
    assert.equal(css.mixBlendMode, "screen");
    assert.match(String(css.border), /dotted/);
    assert.match(
      String(css.background),
      /linear-gradient\(rgba\(51, 102, 153, 0.5\)/,
    );
    assert.doesNotMatch(String(css.background), /255, 0, 0/);
  }
  assert.match(String(code.background), /var\(--color-accent\)/);
});
test("single child aligns to its free frame without moving the frame", () => {
  const doc = createStarter(),
    frame = createNode("frame"),
    child = createNode("rectangle", frame.id);
  frame.style.width = 300;
  child.style.width = 80;
  child.style.x = 7;
  doc.nodes = [frame, child];
  assert.deepEqual(alignOperations(doc, [child.id], "right"), [
    {
      type: "update",
      id: child.id,
      patch: {},
      style: { x: 220, y: child.style.y },
    },
  ]);
});
