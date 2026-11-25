import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  startFlow,
  trigger,
  type Program,
} from "../src/runtime/prototype-machine";
import { createStarter } from "../src/domain/seed";
import { createNode } from "../src/domain/node";
import { duplicatePage } from "../src/domain/pages";
import { prototypeIssues } from "../src/domain/prototype";
import { pageForExport } from "../src/compiler/runtime";

test("one guard chooses one ordered branch; input, component state and history survive navigation until reset", () => {
  const program: Program = {
    flows: [{ id: "a", name: "Browse" }],
    rules: {
      go: {
        condition: { variable: "count", operator: "greater", value: 1 },
        actions: [
          { kind: "control", target: "tab", value: 2 },
          { kind: "set", variable: "count", value: 0 },
          { kind: "navigate", target: "b" },
        ],
        otherwise: [
          { kind: "input", variable: "count" },
          { kind: "overlay", target: "sheet", position: "bottom" },
        ],
      },
    },
    variables: { count: 0 },
    cssNames: {},
  };
  let s = startFlow(program, "a");
  s = trigger(program, s, "go", 2);
  assert.equal(s.variables.count, 2);
  assert.equal(s.overlays[0].target, "sheet");
  s = act(program, s, [{ kind: "back" }]);
  assert.equal(s.overlays.length, 0);
  assert.equal(s.screen, "a");
  s = trigger(program, s, "go", 1);
  assert.equal(s.screen, "b");
  assert.equal(s.controls.tab, 2);
  assert.equal(s.variables.count, 0);
  s = act(program, s, [{ kind: "back" }]);
  assert.equal(s.screen, "a");
  assert.equal(s.controls.tab, 2);
  s = act(program, s, [{ kind: "reset" }]);
  assert.deepEqual(s.controls, {});
  assert.deepEqual(s.history, []);
  assert.equal(s.start, "a");
});
test("duplicating a page remaps prototype links; dangling targets block export with layer name", () => {
  const d = createStarter(),
    a = createNode("frame"),
    b = createNode("frame"),
    source = createNode("button", a.id);
  source.interaction = { actions: [{ kind: "navigate", target: b.id }] };
  a.interaction = { flow: "Start" };
  source.name = "Next";
  d.nodes = [a, b, source];
  const copy = duplicatePage(d);
  assert.deepEqual(prototypeIssues(copy), []);
  assert.equal(pageForExport(d, [a.id]).nodes.length, 3);
  d.nodes = d.nodes.filter((n) => n.id !== b.id);
  assert.throws(() => pageForExport(d, [a.id]), /Next/);
});
