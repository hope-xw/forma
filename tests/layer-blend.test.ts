import assert from "node:assert/strict";
import test from "node:test";
import { createNode, parseDocument } from "../src/domain/document";
import { linearBurnLayer } from "../src/compiler/layer-blend";

test("linear burn paints once over clear alpha and responds to overlapping or newly painted backings", () => {
  const group = createNode("group"),
    nearby = createNode("frame", group.id);
  const container = createNode("frame", group.id),
    fill = createNode("rectangle", container.id);
  Object.assign(nearby.style, {
    x: 0,
    y: 0,
    width: 30,
    height: 30,
    fill: "#608050",
  });
  Object.assign(container.style, {
    x: 90,
    y: 0,
    width: 30,
    height: 30,
    fillOpacity: 0,
  });
  Object.assign(fill.style, {
    x: 0,
    y: 0,
    width: 30,
    height: 30,
    fill: "#787880",
    fillOpacity: 0.16,
    blendMode: "plus-darker",
  });
  const result = () => {
    const doc = parseDocument({
      schemaVersion: 1,
      id: "field",
      name: "Field",
      revision: 1,
      nodes: [group, nearby, container, fill],
      tokens: {},
    });
    return linearBurnLayer(doc.nodes[3], doc)!.layers;
  };
  assert.deepEqual(result(), [{ backgroundColor: "#787880", opacity: 0.16 }]);
  nearby.style.x = 80;
  assert.deepEqual(
    result().map((p) => p.mixBlendMode),
    ["color-burn", "color-burn", "multiply"],
  );
  nearby.style.x = 0;
  container.style.fillOpacity = 0.6;
  assert.equal(result().length, 3);
});
