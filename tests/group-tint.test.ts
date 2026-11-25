import assert from "node:assert/strict";
import test from "node:test";
import { createNode, parseDocument } from "../src/domain/document";
import { runtimeNodes } from "../src/compiler/runtime";
import { nodeCss } from "../src/compiler/react";
import { exportNodeToSvg } from "../src/infrastructure/static-export";
import { horizontalTracking } from "../src/infrastructure/font-import";

test("group tint replaces RGB once after descendants overlap and preserves separately colored group shadows", () => {
  const group = createNode("group"),
    child = createNode("rectangle", group.id);
  group.style.tint = { color: "#ebebf5", opacity: 0.6 };
  group.style.shadows = [
    {
      x: 0,
      y: 2,
      spread: 0,
      blur: 2,
      color: "#ff0000",
      inset: false,
      opacity: 1,
    },
  ];
  child.style.opacity = 0.5;
  const doc = parseDocument({
    schemaVersion: 1,
    id: "original",
    name: "Tint",
    revision: 1,
    nodes: [group, child],
    tokens: {},
  });
  const css = nodeCss(group, doc),
    runtime = runtimeNodes(doc)[0],
    markup = decodeURIComponent(css.filter.toString());
  assert.match(
    markup,
    /flood-color="#ebebf5" flood-opacity="0.6".*SourceAlpha.*result="ink"/,
  );
  assert.match(markup, /flood-color="#ff0000".*<feMergeNode in="ink"/);
  assert.equal(css.boxShadow, undefined);
  assert.equal(runtime.style.filter, css.filter);
  assert.equal(runtime.children[0].style.opacity, 0.5);
  assert.equal(runtime.children[0].style.filter, undefined);
  const svg = exportNodeToSvg(doc, group.id);
  assert.match(svg, /flood-color="#ebebf5" flood-opacity="0.6"/);
  assert.equal((svg.match(/flood-color="#ff0000"/g) ?? []).length, 1);
});
test("normal horizontal AAT tracking interpolates font units by point size and clamps the sampled range", () => {
  const v = new DataView(new ArrayBuffer(48));
  v.setUint32(0, 0x10000);
  v.setUint16(6, 12);
  v.setUint16(12, 1);
  v.setUint16(14, 2);
  v.setUint32(16, 28);
  v.setUint16(26, 36);
  v.setInt32(28, 12 * 65536);
  v.setInt32(32, 20 * 65536);
  v.setInt16(36, 40);
  v.setInt16(38, -40);
  const track = horizontalTracking(v, 2048)!;
  assert.equal(track(8), (40 * 8) / 2048);
  assert.equal(track(16), 0);
  assert.equal(track(17), (-10 * 17) / 2048);
  assert.equal(track(24), (-40 * 24) / 2048);
  v.setUint16(26, 47);
  assert.throws(() => horizontalTracking(v, 2048), /越界/);
});
