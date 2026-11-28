import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  boardBranchSignature,
  branchHasLayoutGuides,
  computeTileResolution,
  countBoardDescendants,
  hasMoreDescendantsThan,
  isBoardLodRenderable,
  structuralDocument,
  LruTileCache,
  resolveBoardLodMode,
  resolveLodActive,
} from "../src/application/board-lod";
import {
  commitEditorOperations,
  previewGeometry,
} from "../src/application/geometry-preview";
import { commit, travel } from "../src/application/history";
import { flowItemCss } from "../src/compiler/flow-gap";
import { duplicateSelectionForDrag } from "../src/domain/clipboard";
import { indexPublishedScene, positionDelta } from "../src/domain/scene-index";
import { transact } from "../src/domain/commands";
import { designSystemSchema } from "../src/domain/design-system-schema";
import {
  createNode,
  layoutGuideSchema,
  type DesignDocument,
  type DesignNode,
} from "../src/domain/document";
import {
  alignOperations,
  layerOrderOperations,
  type Alignment,
} from "../src/domain/editing";
import { layoutBounds } from "../src/domain/geometry";
import { createStarter } from "../src/domain/seed";
import { BoardLodTile } from "../src/editor/BoardLodTile";
import {
  BoardTileCache,
  boardTileCache,
  boardImageCacheStats,
  scheduleTilePaint,
} from "../src/editor/board-tile-cache";
import { useEditor } from "../src/editor/useEditor";

function fixture(
  type: "frame" | "section" = "frame",
  layout: DesignNode["style"]["layout"] = "free",
) {
  const root = createNode(type);
  Object.assign(root.style, {
    x: -150,
    y: 275,
    width: 400,
    height: 300,
    layout,
  });
  const children = [
    [15, 5, 60, 30],
    [89, 68, 36, 12],
    [207, 147, 50, 44],
  ].map(([x, y, width, height]) => {
    const child = createNode("rectangle", root.id);
    Object.assign(child.style, {
      x,
      y,
      width,
      height,
      absolutePosition: layout !== "free",
    });
    return child;
  });
  const doc: DesignDocument = {
    ...createStarter(),
    nodes: [root, ...children],
  };
  return { doc, root, children };
}
function aligned(
  doc: DesignDocument,
  nodes: DesignNode[],
  direction: Alignment,
) {
  return transact(doc, {
    baseRevision: doc.revision,
    operations: alignOperations(
      doc,
      nodes.map((n) => n.id),
      direction,
    ),
  });
}
function close(actual: number, expected: number) {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${actual} differs from ${expected}`,
  );
}

const directions = [
  ["left", "x", 0],
  ["center", "x", 0.5],
  ["right", "x", 1],
  ["top", "y", 0],
  ["middle", "y", 0.5],
  ["bottom", "y", 1],
] as const;
for (const [direction, axis, factor] of directions) {
  test(`${direction} aligns mixed-size layers to the selection on only the requested axis`, () => {
    const { doc, children } = fixture();
    const next = aligned(doc, children, direction);
    const size = axis === "x" ? "width" : "height",
      other = axis === "x" ? "y" : "x";
    const start = children[0].style[axis];
    const end = children[2].style[axis] + children[2].style[size];
    for (const child of children) {
      const style = next.nodes.find((n) => n.id === child.id)!.style;
      close(style[axis] + factor * style[size], start + factor * (end - start));
      assert.equal(style[other], child.style[other]);
    }
  });
  for (const [type, layout] of [
    ["frame", "free"],
    ["section", "free"],
    ["frame", "row"],
  ] as const) {
    test(`${direction} uses local painted edges for a rotated child of a rotated ${layout} ${type}`, () => {
      const {
        doc,
        root,
        children: [child],
      } = fixture(type, layout);
      root.style.rotation = 31;
      child.style.rotation = 90;
      const result = aligned(doc, [child], direction);
      const style = result.nodes[1].style;
      const size = axis === "x" ? "width" : "height",
        otherSize = axis === "x" ? "height" : "width";
      const center = style[axis] + style[size] / 2;
      close(
        center + (factor - 0.5) * style[otherSize],
        factor * root.style[size],
      );
      const other = axis === "x" ? "y" : "x";
      close(style[other], child.style[other]);
      assert.equal(style.rotation, 90);
    });
  }
}
for (const [direction, axis, size] of [
  ["horizontal", "x", "width"],
  ["vertical", "y", "height"],
] as const) {
  for (const layout of ["free", "row", "column", "grid"] as const) {
    test(`${direction} distribution equalizes painted gaps and preserves endpoints in ${layout}`, () => {
      const { doc, children } = fixture("frame", layout);
      const [a, b, c] = aligned(doc, children.slice().reverse(), direction)
        .nodes.slice(1)
        .map((n) => n.style);
      close(a[axis], children[0].style[axis]);
      close(c[axis], children[2].style[axis]);
      close(b[axis] - (a[axis] + a[size]), c[axis] - (b[axis] + b[size]));
      assert.throws(
        () => aligned(doc, children.slice(0, 2), direction),
        /三个图层/,
      );
    });
  }
}
test("one flow child blocks both alignment and distribution of a mixed selection", () => {
  const { doc, root, children } = fixture("frame", "row");
  children[1].style.absolutePosition = false;
  for (const op of [
    ...directions.map((d) => d[0]),
    "horizontal",
    "vertical",
  ] as const)
    assert.throws(() => aligned(doc, children, op), /自动布局/);
  assert.deepEqual(alignOperations(doc, [root.id], "left"), []);
});

// Load the actual Inspector in Node, ignoring its stylesheet as in a server render.
const css = registerHooks({
  load(url, context, next) {
    return url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context);
  },
});
const { Inspector } = await import("../src/editor/Inspector");
css.deregister();
for (const layout of ["row", "column"] as const)
  test(`layer order actions respect reversed and ordinary stacking in the same ${layout} selection`, () => {
    const reversed = createNode("frame"),
      normal = createNode("frame");
    reversed.style.layout = normal.style.layout = layout;
    reversed.style.firstChildOnTop = true;
    const children = [reversed, normal].map((frame) =>
      Array.from({ length: 5 }, () => createNode("rectangle", frame.id)),
    );
    const doc = {
      ...createStarter(),
      nodes: [reversed, normal, ...children.flat()],
    };
    const selected = children.map((items) => items[2].id);
    for (const [action, expectedRank] of [
      ["front", 5],
      ["back", 1],
      ["forward", 4],
      ["backward", 2],
    ] as const) {
      const updated = transact(doc, {
        baseRevision: doc.revision,
        operations: layerOrderOperations(doc, selected, action),
      });
      const ranked = [reversed, normal].map((frame, i) => {
        const siblings = updated.nodes.filter((n) => n.parentId === frame.id);
        const index = siblings.findIndex((n) => n.id === selected[i]);
        return flowItemCss(updated, siblings[index], frame).zIndex ?? index + 1;
      });
      assert.deepEqual(ranked, [expectedRank, expectedRank], action);
    }
  });

function toolbar(doc: DesignDocument, nodes: DesignNode[]) {
  function Panel() {
    return createElement(Inspector, {
      editor: useEditor({
        initialDocument: doc,
        initialSelection: nodes.map((n) => n.id),
      }),
    });
  }
  return [
    ...renderToStaticMarkup(createElement(Panel)).matchAll(
      /<button\b[^>]*data-align-id="([^"]+)"[^>]*>[\s\S]*?<\/button>/g,
    ),
  ];
}
test("all eight Inspector buttons render their labeled Lucide SVG and reference line in order", () => {
  const { doc, children } = fixture();
  const buttons = toolbar(doc, children);
  const expected = [
    ["left", "左对齐", "左对齐", "align-start-vertical", "M2 2v20"],
    ["center", "水平居中", "水平居中", "align-center-vertical", "M12 2v20"],
    ["right", "右对齐", "右对齐", "align-end-vertical", "M22 22V2"],
    ["top", "顶对齐", "顶对齐", "align-start-horizontal", "M22 2H2"],
    ["middle", "垂直居中", "垂直居中", "align-center-horizontal", "M2 12h20"],
    ["bottom", "底对齐", "底对齐", "align-end-horizontal", "M22 22H2"],
    [
      "horizontal",
      "水平分布",
      "水平等距分布",
      "align-horizontal-space-around",
      "M4 22V2",
    ],
    [
      "vertical",
      "垂直分布",
      "垂直等距分布",
      "align-vertical-space-around",
      "M22 20H2",
    ],
  ];
  assert.deepEqual(
    buttons.map((b) => b[1]),
    expected.map((b) => b[0]),
  );
  expected.forEach(([id, label, title, icon, path], i) => {
    const html = buttons[i][0];
    for (const attr of [
      `aria-label="${label}"`,
      `title="${title}"`,
      `lucide-${icon}"`,
      `d="${path}"`,
    ])
      assert.ok(html.includes(attr), id + " missing " + attr);
    assert.doesNotMatch(html, /disabled=/);
  });
});
test("Inspector reports the flow restriction and enables the absolute-position child", () => {
  const { doc, root, children } = fixture("frame", "column");
  children[0].style.absolutePosition = false;
  const blocked = toolbar(doc, [children[0]]);
  assert.equal(blocked.length, 8);
  for (const [html] of blocked) {
    assert.match(html, /disabled=""/);
    assert.match(
      html,
      /data-tip-desc="自动布局内请调整布局对齐，或开启绝对定位后对齐"/,
    );
  }
  const absolute = toolbar(doc, [children[1]]);
  for (const [html] of absolute.slice(0, 6))
    assert.doesNotMatch(html, /disabled=/);
  for (const [html] of absolute.slice(6))
    assert.match(html, /请同时选中至少 3 个图层/);
  for (const [html] of toolbar(doc, [root]).slice(0, 6))
    assert.match(html, /请选中至少 2 个图层或容器内子图层/);
});

test("LOD enters and exits at distinct thresholds for either document size trigger", () => {
  for (const [boards, nodes] of [
    [12, 599],
    [11, 600],
  ]) {
    assert.equal(resolveLodActive(0.38, false, boards, nodes), false);
    assert.equal(resolveLodActive(0.37, false, boards, nodes), true);
    assert.equal(resolveLodActive(0.4, true, boards, nodes), true);
    assert.equal(resolveLodActive(0.42, true, boards, nodes), false);
    assert.equal(resolveLodActive(0.4, false, boards, nodes), false);
  }
  for (const wasActive of [true, false])
    assert.equal(resolveLodActive(0.02, wasActive, 11, 599), false);
});
test("only inactive complex frames without visible guide overlays can use a tile", () => {
  const input = {
    lodActive: true,
    node: createNode("frame"),
    descendantCount: 9,
    isSelectedBranch: false,
    isHovered: false,
    isEditingBranch: false,
    isDragging: false,
    isAiPreview: false,
    outlineMode: false,
    showLayoutGuides: false,
    hasLayoutGuides: false,
  };
  assert.equal(resolveBoardLodMode(input), "cached");
  for (const key of [
    "isSelectedBranch",
    "isHovered",
    "isEditingBranch",
    "isDragging",
    "isAiPreview",
    "outlineMode",
  ] as const)
    assert.equal(resolveBoardLodMode({ ...input, [key]: true }), "live", key);
  for (const patch of [
    { lodActive: false },
    { renderable: false },
    { descendantCount: 8 },
    { descendantCount: 0 },
    { node: createNode("section") },
    { showLayoutGuides: true, hasLayoutGuides: true },
  ])
    assert.equal(resolveBoardLodMode({ ...input, ...patch }), "live");
  for (const key of ["hasLayoutGuides", "showLayoutGuides"] as const)
    assert.equal(resolveBoardLodMode({ ...input, [key]: true }), "cached");
});
test("tile resolution respects DPR, both edges, aspect and RGBA byte cost", () => {
  for (const [w, h, zoom, dpr, width, height, scale] of [
    [400, 300, 0.02, 1, 72, 54, 0.18],
    [400, 300, 0.2, 1, 120, 90, 0.3],
    [400, 300, 0.2, 2, 200, 150, 0.5],
    [4096, 2048, 0.37, 2, 512, 256, 0.125],
    [2048, 4096, 0.37, 2, 256, 512, 0.125],
    [20000, 1, 0.3, 1, 512, 16, 512 / 20000],
    [40, 20, 0.02, 1, 32, 16, 0.18],
    [0, 0, 0.02, 1, 16, 16, 0.18],
  ]) {
    const result = computeTileResolution(w, h, zoom, dpr);
    close(result.scale, scale);
    assert.deepEqual(
      [result.width, result.height, result.estimatedBytes],
      [width, height, width * height * 4],
    );
  }
});

test("immutable branch counts include nested, hidden layers and update in the next document", () => {
  const { doc, root, children } = fixture();
  children[0].hidden = true;
  children[1].parentId = children[0].id;
  assert.equal(countBoardDescendants(doc, root.id), 3);
  assert.equal(countBoardDescendants(doc, children[0].id), 1);
  assert.equal(countBoardDescendants(doc, "missing"), 0);
  const next = {
    ...doc,
    nodes: [...doc.nodes, createNode("text", children[0].id)],
  };
  assert.equal(countBoardDescendants(next, root.id), 4);
  assert.equal(countBoardDescendants(doc, root.id), 3);
});
test("branch signatures follow visible payload, paint order, tokens, paths, profile and active modes", () => {
  const { doc, root, children } = fixture();
  children[0].type = "text";
  children[1].type = "vector";
  children[1].vector = {
    width: 10,
    height: 10,
    paths: [{ d: "M0 0L10 10Z", fill: true, strokeWidth: 0 }],
  };
  children[2].fillToken = "brand";
  const hidden = createNode("frame", root.id);
  hidden.hidden = true;
  doc.nodes.push(hidden, createNode("text", hidden.id), createNode("frame"));
  doc.designSystem = designSystemSchema.parse({
    collections: {
      theme: {
        id: "theme",
        name: "Theme",
        defaultModeId: "light",
        modes: [
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ],
      },
    },
    variables: {
      ink: {
        id: "ink",
        name: "Ink",
        collectionId: "theme",
        type: "color",
        values: { light: "#123456", dark: "#654321" },
      },
    },
    activeModes: { theme: "light" },
    styles: {},
  });
  children[0].variableBindings = { color: "ink" };
  const original = boardBranchSignature(doc, root.id);
  assert.equal(boardBranchSignature(structuredClone(doc), root.id), original);
  const nextKey = (edit: (next: DesignDocument) => void) => {
    const next = structuredClone(doc);
    edit(next);
    return boardBranchSignature(next, root.id);
  };
  for (const edit of [
    (d: DesignDocument) => {
      d.nodes[1].text += "!";
    },
    (d: DesignDocument) => {
      d.nodes[1].style.fill = "#00FF00";
    },
    (d: DesignDocument) => {
      d.nodes[2].vector!.paths[0].d += " M1 1";
    },
    (d: DesignDocument) => {
      d.nodes[2].style.rotation = 11;
    },
    (d: DesignDocument) => {
      d.tokens.brand.value = "#123abc";
    },
    (d: DesignDocument) => {
      d.colorProfile = "display-p3";
    },
    (d: DesignDocument) => {
      d.designSystem!.activeModes.theme = "dark";
    },
    (d: DesignDocument) => {
      d.designSystem!.variables.ink.values.light = "#EEEEEE";
    },
    (d: DesignDocument) => {
      d.nodes[4].hidden = false;
    },
    (d: DesignDocument) => {
      [d.nodes[1], d.nodes[2]] = [d.nodes[2], d.nodes[1]];
    },
  ])
    assert.notEqual(nextKey(edit), original);
  assert.equal(
    nextKey((d) => {
      d.nodes[5].text = "hidden descendant";
      d.nodes[6].name = "unrelated board";
    }),
    original,
  );
  assert.equal(boardBranchSignature(doc, root.id), original);
});
test("LRU hit promotion, entry and byte eviction, replacement and disposal", () => {
  const released: string[] = [];
  const cache = new LruTileCache<string>(2, 10, (key, value) =>
    released.push(key + value),
  );
  cache.set("a", "A", 4);
  cache.set("b", "B", 3);
  assert.equal(cache.get("a"), "A");
  cache.set("c", "C", 4);
  assert.equal(cache.get("b"), undefined);
  cache.set("d", "D", 7);
  assert.deepEqual(cache.stats(), {
    entries: 1,
    bytes: 7,
    hits: 1,
    misses: 1,
    evictions: 3,
  });
  cache.set("d", "D", 6);
  cache.set("d", "E", 3);
  assert.deepEqual(released, ["bB", "aA", "cC", "dD"]);
  cache.set("huge", "H", 11);
  assert.equal(cache.stats().bytes, 3);
  cache.delete("d");
  cache.set("a", "F", 1);
  cache.clear();
  cache.clear();
  assert.deepEqual(released, ["bB", "aA", "cC", "dD", "hugeH", "dE", "aF"]);
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().bytes, 0);
  const disabled = new LruTileCache(0, 0);
  disabled.set("empty", 1, 0);
  assert.equal(disabled.stats().entries, 0);
});

test("tile eviction releases both canvas dimensions", () => {
  const cache = new BoardTileCache(1, 256);
  const tile = () => ({
    canvas: { width: 8, height: 8 } as HTMLCanvasElement,
    width: 8,
    height: 8,
    signature: "sig",
  });
  const a = tile(),
    b = tile();
  cache.set("a", a, 256);
  cache.set("b", b, 256);
  assert.deepEqual([a.canvas.width, a.canvas.height], [0, 0]);
  assert.equal(b.canvas.width, 8);
  cache.clear();
  assert.deepEqual([b.canvas.width, b.canvas.height], [0, 0]);
});
test("the queued tile immediately renders a rounded, colored pointer target and one inert canvas", () => {
  const { doc, root } = fixture();
  root.style.corners = { tl: 8, tr: 12, br: 16, bl: 20 };
  const bounds = layoutBounds(doc);
  const html = renderToStaticMarkup(
    createElement(BoardLodTile, {
      document: doc,
      node: root,
      bounds,
      rect: bounds.get(root.id)!,
      zoom: 0.2,
    }),
  );
  assert.deepEqual(html.match(/<\w+/g), ["<div", "<canvas"]);
  for (const value of [
    `data-node-id="${root.id}"`,
    'data-node-type="frame"',
    'data-lod="cached"',
    "pointer-events:auto",
    "pointer-events:none",
    "border-radius:8px 12px 16px 20px",
    "background:rgba(255, 255, 255, 1)",
    'aria-hidden="true"',
  ])
    assert.ok(html.includes(value), value);
});
test("one global 4 ms frame budget slices unfinished jobs and cancellation drops pending work", (t) => {
  let now = 0,
    sequence = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const oldRequest = globalThis.requestAnimationFrame,
    oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => {
    callbacks.set(++sequence, cb);
    return sequence;
  };
  globalThis.cancelAnimationFrame = (id) => {
    callbacks.delete(id);
  };
  t.mock.method(performance, "now", () => now);
  try {
    let total = 0;
    scheduleTilePaint(() => {
      now++;
      return ++total === 10;
    });
    const cancel = scheduleTilePaint(() => assert.fail("cancelled task ran"));
    cancel();
    const counts = [];
    while (callbacks.size) {
      assert.equal(callbacks.size, 1);
      const [id, cb] = [...callbacks][0];
      callbacks.delete(id);
      cb(now);
      counts.push(total);
    }
    assert.deepEqual(counts, [3, 6, 9, 10]);
  } finally {
    globalThis.requestAnimationFrame = oldRequest;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});

const shadow = {
  x: 1,
  y: 2,
  blur: 5,
  spread: 0,
  color: "#000000",
  opacity: 1,
  inset: false,
};
const paint = { id: "paint", color: "#00ff00", opacity: 1, visible: true };
const unsupported: [string, (node: DesignNode) => void][] = [
  [
    "Boolean group",
    (n) => {
      n.booleanOperation = "union";
    },
  ],
  [
    "mask source",
    (n) => {
      n.maskSourceId = "source";
    },
  ],
  [
    "bitmap mask",
    (n) => {
      n.maskType = "alpha";
    },
  ],
  [
    "sibling mask",
    (n) => {
      n.siblingMask = "vector";
    },
  ],
  [
    "blend",
    (n) => {
      n.style.blendMode = "overlay";
    },
  ],
  [
    "drop shadow",
    (n) => {
      n.style.shadows = [shadow];
    },
  ],
  [
    "inner shadow",
    (n) => {
      n.style.shadows = [{ ...shadow, inset: true }];
    },
  ],
  [
    "stroke paints",
    (n) => {
      n.style.strokePaints = [paint];
    },
  ],
  [
    "fill paints",
    (n) => {
      n.style.paints = [paint];
    },
  ],
  [
    "blur",
    (n) => {
      n.style.blur = 2;
    },
  ],
  [
    "backdrop blur",
    (n) => {
      n.style.backdropBlur = 1;
    },
  ],
  [
    "glass",
    (n) => {
      n.style.figmaGlass = { visible: true, radius: 2 };
    },
  ],
  [
    "glyph effect",
    (n) => {
      n.style.textEffectClip = "glyphs";
    },
  ],
  [
    "tint",
    (n) => {
      n.style.tint = { color: "#ff00ff", opacity: 1 };
    },
  ],
];
for (const [feature, apply] of unsupported) {
  test(`a visible ${feature} anywhere in the branch requires live artwork`, () => {
    const { doc, root, children } = fixture();
    const nested = createNode("rectangle", children[0].id);
    doc.nodes.push(nested);
    apply(nested);
    assert.equal(isBoardLodRenderable(doc, root.id), false);
    for (const invisible of ["hidden", "transparent"]) {
      const next = structuredClone(doc);
      if (invisible === "hidden") next.nodes[1].hidden = true;
      else next.nodes[1].style.opacity = 0;
      assert.equal(isBoardLodRenderable(next, root.id), true, invisible);
    }
  });
}
test("plain artwork and disabled effects are eligible; isolated group opacity counts visible direct children", () => {
  const { doc, root, children } = fixture();
  const [group, a, b] = children;
  group.type = "group";
  a.parentId = b.parentId = group.id;
  Object.assign(group.style, {
    opacity: 0.5,
    blendMode: "normal",
    paints: [{ ...paint, visible: false }],
    shadows: [{ ...shadow, visible: false }],
  });
  b.style.blendMode = "pass-through";
  assert.equal(isBoardLodRenderable(doc, root.id), false);
  const single = structuredClone(doc);
  single.nodes[2].hidden = true;
  assert.equal(isBoardLodRenderable(single, root.id), true);
  const opaque = structuredClone(doc);
  opaque.nodes[1].style.opacity = 1;
  assert.equal(isBoardLodRenderable(opaque, root.id), true);
});

test("guide eligibility follows the visible subtree and the guide toggle at the tile entry", () => {
  const { doc, root, children } = fixture();
  children[0].type = "frame";
  children[0].style.layoutGuides = [
    layoutGuideSchema.parse({ id: "grid", kind: "grid" }),
  ];
  const bounds = layoutBounds(doc);
  const render = (showLayoutGuides: boolean) =>
    renderToStaticMarkup(
      createElement(BoardLodTile, {
        document: doc,
        node: root,
        rect: bounds.get(root.id)!,
        bounds,
        zoom: 0.2,
        showLayoutGuides,
      }),
    );
  assert.equal(branchHasLayoutGuides(doc, root.id), true);
  assert.doesNotMatch(render(true), /data-lod="cached"/);
  assert.match(render(true), new RegExp(children[0].id));
  assert.match(render(false), /data-lod="cached"/);
  const hidden = structuredClone(doc);
  hidden.nodes[1].hidden = true;
  assert.equal(branchHasLayoutGuides(hidden, root.id), false);
  const disabled = structuredClone(doc);
  disabled.nodes[1].style.layoutGuides![0].visible = false;
  assert.equal(branchHasLayoutGuides(disabled, root.id), false);
});

test("overflow uses board-relative local boxes or supplied world layout, including descendants and rotated edges", () => {
  const { doc, root, children } = fixture();
  root.style.clipContent = false;
  assert.equal(isBoardLodRenderable(doc, root.id), true);
  const bounds = layoutBounds(doc);
  const child = children[0];
  for (const [x, y] of [
    [-1, 5],
    [5, -1],
    [341, 5],
    [5, 271],
  ]) {
    const next = structuredClone(doc);
    Object.assign(next.nodes[1].style, { x, y });
    assert.equal(isBoardLodRenderable(next, root.id), false);
    const escaped = new Map(bounds);
    escaped.set(child.id, {
      ...bounds.get(child.id)!,
      x: root.style.x + x,
      y: root.style.y + y,
    });
    assert.equal(isBoardLodRenderable(doc, root.id, escaped), false);
    assert.equal(isBoardLodRenderable(doc, root.id, bounds), true);
    assert.equal(isBoardLodRenderable(next, root.id, bounds), true);
    next.nodes[0].style.clipContent = true;
    assert.equal(isBoardLodRenderable(structuredClone(next), root.id), true);
  }
  const nested = structuredClone(doc);
  nested.nodes[2].parentId = child.id;
  nested.nodes[2].style.x = 360;
  assert.equal(isBoardLodRenderable(nested, root.id), false);
  const rotated = structuredClone(doc);
  Object.assign(rotated.nodes[1].style, { y: 0, rotation: 90 });
  assert.equal(isBoardLodRenderable(rotated, root.id), false);
});

test("resolved variable-bound visibility determines eligibility", () => {
  const { doc, root, children } = fixture();
  doc.designSystem = designSystemSchema.parse({
    collections: {
      c: {
        id: "c",
        name: "Theme",
        defaultModeId: "light",
        modes: [{ id: "light", name: "Light" }],
      },
    },
    variables: {
      visible: {
        id: "visible",
        name: "Visible",
        collectionId: "c",
        type: "boolean",
        values: { light: false },
      },
    },
    activeModes: { c: "light" },
    styles: {},
  });
  children[0].style.blur = 1;
  children[0].variableBindings = { visible: "visible" };
  assert.equal(isBoardLodRenderable(doc, root.id), true);
  const next = structuredClone(doc);
  next.designSystem!.variables.visible.values.light = true;
  assert.equal(isBoardLodRenderable(next, root.id), false);
});

test("signature hashes compositing metadata, resolved style and every vector path field at identical IDs and bounds", () => {
  const { doc, root, children } = fixture();
  const n = children[1];
  n.type = "vector";
  n.booleanOperation = "union";
  n.operandOperation = "union";
  n.maskSourceId = children[0].id;
  n.vector = {
    width: 10,
    height: 10,
    paths: [
      { d: "M0 0L3 3Z", fill: true, strokeWidth: 0 },
      { d: "M2 2L4 4Z", fill: true, strokeWidth: 1 },
    ],
  };
  const base = boardBranchSignature(doc, root.id),
    bounds = layoutBounds(doc);
  const verify = (name: string, edit: (node: DesignNode) => void) => {
    const next = structuredClone(doc);
    edit(next.nodes[2]);
    assert.deepEqual([...layoutBounds(next)], [...bounds], name);
    assert.notEqual(boardBranchSignature(next, root.id), base, name);
  };
  for (const patch of [
    { booleanOperation: "subtract" },
    { operandOperation: "exclude" },
    { maskSourceId: children[2].id },
    { maskType: "vector" },
    { compoundWindingRule: "evenodd" },
    { locked: true },
    { componentSet: { libraryId: "lib", componentId: "component" } },
  ])
    verify(Object.keys(patch)[0], (node) => Object.assign(node, patch));
  for (const patch of [
    { clipContent: false },
    { blendMode: "multiply" },
    { strokeSides: { left: 2 } },
    { strokeDash: "2 3" },
    { strokeStyle: "dashed" },
    { strokeAlign: "outside" },
    { strokeVisible: false },
    { cornerSmoothing: 0.2 },
    { paints: [paint] },
    { strokePaints: [paint] },
    { shadows: [shadow] },
    {
      gradient: {
        type: "linear",
        angle: 90,
        stops: [
          { offset: 0, color: "#ffffff", opacity: 1 },
          { offset: 1, color: "#000000", opacity: 1 },
        ],
      },
    },
    { flipX: true },
    { flipY: true },
    { rotation: 20 },
  ])
    verify(Object.keys(patch)[0], (node) => Object.assign(node.style, patch));
  for (const patch of [
    { d: "M1 1L3 3Z" },
    { fill: false },
    { fillColor: "#abcdef" },
    { fillOpacity: 0.6 },
    { fillRule: "evenodd" },
    { strokeWidth: 3 },
    { strokeColor: "#123456" },
    { strokeOpacity: 0.8 },
    { lineCap: "square" },
    { lineJoin: "bevel" },
    { opacity: 0.3 },
  ])
    verify("second path " + Object.keys(patch)[0], (node) =>
      Object.assign(node.vector!.paths[1], patch),
    );
});

test("threshold stops before visiting children; unrelated position previews reuse exact counts and paint eligibility without reading branch nodes", () => {
  const { doc, root, children } = fixture();
  const other = createNode("frame");
  doc.nodes.push(other);
  indexPublishedScene(doc);
  const bounds = layoutBounds(doc);
  const child = children[0],
    id = child.id;
  let reads = 0;
  Object.defineProperty(child, "id", {
    get() {
      reads++;
      return id;
    },
  });
  Object.defineProperty(child, "hidden", {
    get() {
      reads++;
      return false;
    },
  });
  assert.equal(hasMoreDescendantsThan(doc, root.id, 2), true);
  assert.equal(reads, 0);
  assert.equal(countBoardDescendants(doc, root.id), 3);
  assert.equal(hasMoreDescendantsThan(doc, root.id, 3), false);
  assert.equal(isBoardLodRenderable(doc, root.id, bounds), true);
  assert.equal(isBoardLodRenderable(doc, root.id), true);
  assert.ok(reads > 0);
  for (let x = 1; x <= 20; x++) {
    const preview = previewGeometry(doc, [
      { type: "update", id: other.id, patch: {}, style: { x } },
    ]);
    const previewBounds = layoutBounds(preview);
    assert.equal(structuralDocument(preview), doc);
    reads = 0;
    assert.equal(countBoardDescendants(preview, root.id), 3);
    assert.equal(hasMoreDescendantsThan(preview, root.id, 2), true);
    assert.equal(isBoardLodRenderable(preview, root.id, previewBounds), true);
    assert.equal(isBoardLodRenderable(preview, root.id), true);
    assert.equal(reads, 0);
  }
  const committed = commitEditorOperations(
    doc,
    [{ type: "update", id: other.id, patch: {}, style: { x: 21 } }],
    doc.revision,
  );
  assert.equal(structuralDocument(committed), doc);
  assert.equal(countBoardDescendants(committed, root.id), 3);
  assert.equal(
    isBoardLodRenderable(committed, root.id, layoutBounds(committed)),
    true,
  );
  const nextDrag = previewGeometry(committed, [
    { type: "update", id: other.id, patch: {}, style: { x: 22 } },
  ]);
  const nextBounds = layoutBounds(nextDrag);
  reads = 0;
  assert.equal(countBoardDescendants(nextDrag, root.id), 3);
  assert.equal(isBoardLodRenderable(nextDrag, root.id, nextBounds), true);
  assert.equal(reads, 0, "first frame of a subsequent drag");
  const changed = previewGeometry(doc, [
    { type: "update", id, patch: {}, style: { x: -1 } },
  ]);
  assert.equal(
    isBoardLodRenderable(changed, root.id, layoutBounds(changed)),
    false,
  );
});

function setTestGlobal(t: TestContext, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}

function rasterHarness(t: TestContext) {
  const document = new DOMParser().parseFromString("<html/>", "text/html");
  const create = document.createElement.bind(document);
  const draws: { target: HTMLCanvasElement; source: CanvasImageSource }[] = [];
  const clears: Element[] = [];
  const strokes: string[] = [];
  const contexts: {
    target: Element;
    type: string;
    colorSpace?: PredefinedColorSpace;
  }[] = [];
  t.mock.method(document, "createElement", (tag: string) => {
    const element = create(tag);
    Object.assign(element, {
      style: {},
      addEventListener() {},
      removeEventListener() {},
    });
    Object.defineProperty(element, "parentElement", {
      get: () => element.parentNode,
    });
    if (tag === "canvas") {
      for (const key of ["width", "height"]) {
        let dimension = 0;
        Object.defineProperty(element, key, {
          get: () => dimension,
          set: (value: number) => {
            dimension = value;
            clears.push(element);
          },
        });
      }
      const noop = () => {};
      const ctx = {
        save: noop,
        restore: noop,
        translate: noop,
        rotate: noop,
        scale: noop,
        clip: noop,
        fill: noop,
        strokeStyle: "",
        stroke() {
          strokes.push(this.strokeStyle);
        },
        globalAlpha: 1,
        drawImage(source: CanvasImageSource) {
          draws.push({ target: element as HTMLCanvasElement, source });
        },
      };
      Object.assign(element, {
        getContext: (
          type: string,
          options?: CanvasRenderingContext2DSettings,
        ) => {
          contexts.push({
            target: element,
            type,
            colorSpace: options?.colorSpace,
          });
          return ctx;
        },
      });
    }
    return element;
  });
  document.addEventListener = () => {};
  const host = document.createElement("div");
  setTestGlobal(t, "document", document);
  setTestGlobal(t, "window", { document, HTMLIFrameElement: class {} });
  setTestGlobal(t, "IS_REACT_ACT_ENVIRONMENT", true);
  setTestGlobal(
    t,
    "Path2D",
    class {
      roundRect() {}
    },
  );
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  setTestGlobal(t, "requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++sequence, cb);
    return sequence;
  });
  setTestGlobal(t, "cancelAnimationFrame", (id: number) => frames.delete(id));
  function flushFrames() {
    for (let i = 0; frames.size; i++) {
      assert.ok(i < 10000, "tile jobs must make progress");
      const [id, cb] = frames.entries().next().value!;
      frames.delete(id);
      cb(i);
    }
  }
  return { host, flushFrames, draws, clears, contexts, strokes };
}

test("the mounted tile preserves its display until replacement, retains old keys for undo, and blits synchronously on remount", async (t) => {
  const { host, flushFrames, draws, clears } = rasterHarness(t);
  boardTileCache.clear();
  t.after(() => boardTileCache.clear());
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const { doc } = fixture();
  function show(d: DesignDocument, zoom = 0.2) {
    const node = d.nodes[0],
      bounds = layoutBounds(d);
    return act(() =>
      root.render(
        createElement(BoardLodTile, {
          document: d,
          node,
          bounds,
          rect: bounds.get(node.id)!,
          zoom,
        }),
      ),
    );
  }
  await show(doc);
  flushFrames();
  const display = host.getElementsByTagName("canvas")[0];
  const first = draws.find((d) => d.target === display)!
    .source as HTMLCanvasElement;
  const background = (display.parentNode as HTMLElement).style.background;
  assert.equal(background, "transparent");
  assert.equal(boardTileCache.stats().entries, 1);
  const undo = structuredClone(doc);
  undo.nodes[0].style.fill = "#ffeedd";
  const writes = clears.filter((c) => c === display).length;
  await show({ ...doc, nodes: [...doc.nodes, createNode("frame")] });
  flushFrames();
  assert.equal(clears.filter((c) => c === display).length, writes);
  await show(undo, 0.1);
  assert.deepEqual(
    [display.width, display.height],
    [first.width, first.height],
  );
  assert.equal(clears.filter((c) => c === display).length, writes);
  assert.equal(
    (display.parentNode as HTMLElement).style.background,
    background,
  );
  assert.equal(draws.filter((d) => d.target === display).length, 1);
  flushFrames();
  const replacement = draws.filter((d) => d.target === display).at(-1)!.source;
  assert.notEqual(replacement, first);
  assert.equal(boardTileCache.stats().entries, 2);
  await show(doc);
  assert.equal(draws.at(-1)!.source, first);
  await act(() => root.render(null));
  assert.deepEqual([display.width, display.height], [0, 0]);
  assert.ok(first.width > 0);
  assert.equal(boardTileCache.stats().entries, 2);
  const hits = boardTileCache.stats().hits;
  await show(doc);
  const remounted = host.getElementsByTagName("canvas")[0];
  assert.notEqual(remounted, display);
  assert.deepEqual(draws.at(-1), { target: remounted, source: first });
  assert.equal(boardTileCache.stats().hits, hits + 1);
  await act(() => root.unmount());
  assert.ok(first.width > 0);
});

function imageHarness(t: TestContext, width: number, height: number) {
  const harness = rasterHarness(t);
  const started: string[] = [];
  const inflight = new Map<string, { finish: () => void; fail: () => void }>();
  const detached: string[] = [];
  let peak = 0;
  class TestImage {
    src = "";
    naturalWidth = width;
    naturalHeight = height;
    decode() {
      const asset = this.src;
      started.push(asset);
      return new Promise<void>((resolve, reject) => {
        inflight.set(asset, {
          finish() {
            inflight.delete(asset);
            resolve();
          },
          fail() {
            inflight.delete(asset);
            reject(new Error("decode interrupted"));
          },
        });
        peak = Math.max(peak, inflight.size);
      });
    }
    removeAttribute(key: string) {
      if (key === "src" && this.src) {
        detached.push(this.src);
        this.src = "";
      }
    }
  }
  setTestGlobal(t, "Image", TestImage);
  const cache = new BoardTileCache();
  t.after(() => cache.clear());
  const finished: string[] = [];
  function request(ids: string[], name: string) {
    const { doc, root } = fixture();
    doc.nodes = [root];
    doc.images = {};
    for (const id of ids) {
      const node = createNode("rectangle", root.id);
      node.image = { assetId: id, fit: "fill", x: 50, y: 50, zoom: 1 };
      doc.images[id] = { name: id, data: id, width, height };
      doc.nodes.push(node);
    }
    return cache.request(doc, root.id, layoutBounds(doc), 64, 64, () => {
      finished.push(name);
    });
  }
  async function drain() {
    let passes = 0;
    harness.flushFrames();
    while (inflight.size) {
      assert.ok(
        ++passes < 250,
        "paint must finish even when all source thumbnails cannot fit in the LRU",
      );
      for (const active of [...inflight.values()]) active.finish();
      await Promise.resolve();
      harness.flushFrames();
      assert.ok(boardImageCacheStats().bytes <= 12 * 1024 * 1024);
      assert.ok(boardImageCacheStats().entries <= 64);
    }
  }
  return {
    ...harness,
    request,
    finished,
    started,
    detached,
    inflight,
    drain,
    peak: () => peak,
    TestImage,
  };
}

test("image decode FIFO shares waiters, cancels orphaned queued and active work, and never exceeds four browser decodes", async (t) => {
  const h = imageHarness(t, 4096, 1024);
  const cancel = ["a", "b", "c", "d", "e", "f", "g", "f"].map((id, i) =>
    h.request([id], "job" + i),
  );
  h.flushFrames();
  assert.deepEqual(h.started, ["a", "b", "c", "d"]);
  assert.equal(boardImageCacheStats().queued, 3);
  cancel[4](); // last waiter on queued E
  cancel[5](); // F still has a waiter
  cancel[0](); // browser hasn't settled A yet
  assert.deepEqual(h.detached, ["a"]);
  assert.equal(boardImageCacheStats().queued, 2);
  assert.equal(boardImageCacheStats().active, 4);
  h.inflight.get("a")!.fail();
  await Promise.resolve();
  assert.deepEqual(h.started, ["a", "b", "c", "d", "f"]);
  await h.drain();
  assert.deepEqual(h.started, ["a", "b", "c", "d", "f", "g"]);
  assert.deepEqual(h.finished.sort(), ["job1", "job2", "job3", "job6", "job7"]);
  assert.deepEqual(h.detached.sort(), [...h.started].sort());
  assert.equal(h.peak(), 4);
  assert.equal(boardImageCacheStats().active, 0);
  assert.equal(boardImageCacheStats().queued, 0);
  const thumbnails = h.draws
    .filter((d) => d.source instanceof h.TestImage)
    .map((d) => d.target);
  assert.equal(thumbnails.length, 5);
  for (const thumb of thumbnails)
    assert.deepEqual([thumb.width, thumb.height], [512, 128]);
});

for (const [budget, size, count] of [
  ["byte", 4096, 17],
  ["entry", 16, 70],
] as const) {
  test(`a board exceeding the thumbnail ${budget} budget finishes in paint order and releases evicted surfaces`, async (t) => {
    const h = imageHarness(t, size, size);
    const ids = Array.from({ length: count }, (_, i) => budget + i);
    const evictions = boardImageCacheStats().evictions;
    h.request(ids, "large-board");
    await h.drain();
    assert.deepEqual(h.finished, ["large-board"]);
    assert.deepEqual(h.started, ids);
    assert.deepEqual(h.detached, ids);
    const surfaces = h.draws
      .filter((d) => d.source instanceof h.TestImage)
      .map((d) => d.target);
    const painted = h.draws.filter((d) => !(d.source instanceof h.TestImage));
    assert.deepEqual(
      painted.map((d) => d.source),
      surfaces,
    );
    assert.equal(surfaces.length, count);
    assert.deepEqual([surfaces[0].width, surfaces[0].height], [0, 0]);
    assert.equal(surfaces.at(-1)!.width, Math.min(512, size));
    assert.ok(boardImageCacheStats().evictions > evictions);
    assert.equal(boardImageCacheStats().active, 0);
    assert.equal(boardImageCacheStats().queued, 0);
  });
}

test("a tile candidate renders the live board subtree for unsupported artwork", () => {
  const { doc, root, children } = fixture();
  children[0].style.shadows = [shadow];
  const bounds = layoutBounds(doc);
  const html = renderToStaticMarkup(
    createElement(BoardLodTile, {
      document: doc,
      node: root,
      rect: bounds.get(root.id)!,
      bounds,
      zoom: 0.2,
      showLayoutGuides: false,
    }),
  );
  assert.doesNotMatch(html, /<canvas|data-lod="cached"/);
  assert.match(html, /box-shadow:/);
  for (const node of doc.nodes)
    assert.ok(html.includes(`data-node-id="${node.id}"`));
});

test("unrelated previews reuse a partial count and a negative eligibility result", () => {
  const { doc, root, children } = fixture();
  const other = createNode("frame");
  doc.nodes.push(other);
  children[1].parentId = children[0].id;
  children[2].parentId = children[1].id;
  children[0].style.blur = 1;
  indexPublishedScene(doc);
  const child = children[0],
    id = child.id;
  let reads = 0;
  Object.defineProperty(child, "id", {
    get() {
      reads++;
      return id;
    },
  });
  assert.equal(hasMoreDescendantsThan(doc, root.id, 1), true);
  assert.ok(reads > 0);
  assert.equal(isBoardLodRenderable(doc, root.id), false);
  const preview = previewGeometry(doc, [
    { type: "update", id: other.id, patch: {}, style: { x: 50 } },
  ]);
  reads = 0;
  assert.equal(hasMoreDescendantsThan(preview, root.id, 1), true);
  assert.equal(isBoardLodRenderable(preview, root.id), false);
  assert.equal(reads, 0);
  assert.equal(hasMoreDescendantsThan(preview, root.id, 2), true);
  assert.equal(countBoardDescendants(preview, root.id), 3);
});

test("an unclipped board keeps overflowing vector artwork live, including stroke outset, scaling and rotation", () => {
  const {
    doc,
    root,
    children: [v],
  } = fixture();
  root.style.clipContent = false;
  v.type = "vector";
  Object.assign(v.style, { x: 370, y: 50, width: 30, height: 20 });
  v.vector = {
    width: 15,
    height: 10,
    overflowVisible: true,
    paths: [{ d: "M2 2H17V8H2Z", fill: true, strokeWidth: 0 }],
  };
  function check(d: DesignDocument, expected: boolean) {
    assert.equal(isBoardLodRenderable(d, root.id), expected);
    assert.equal(isBoardLodRenderable(d, root.id, layoutBounds(d)), expected);
  }
  check(doc, false);
  const implicit = structuredClone(doc);
  delete implicit.nodes[1].vector!.overflowVisible;
  check(implicit, false);
  const stroke = structuredClone(doc);
  Object.assign(stroke.nodes[1].vector!.paths[0], {
    d: "M2 5H14",
    fill: false,
    strokeWidth: 4,
  });
  check(stroke, false);
  const inside = structuredClone(stroke);
  inside.nodes[1].style.x -= 3;
  check(inside, true);
  const rotated = structuredClone(doc);
  Object.assign(rotated.nodes[1].style, { rotation: -90, x: 200, y: 5 });
  check(rotated, false);
  const letterbox = structuredClone(doc);
  Object.assign(letterbox.nodes[1].style, {
    x: 0,
    y: 1,
    width: 30,
    height: 40,
  });
  letterbox.nodes[1].vector!.paths[0].d = "M2 -3H10V8H2Z";
  check(letterbox, true);
  const stretched = structuredClone(letterbox);
  stretched.nodes[1].vector!.stretch = true;
  check(stretched, false);
  const clipped = structuredClone(doc);
  clipped.nodes[0].style.clipContent = true;
  check(clipped, true);
});

test("a zero-width or zero-height SVG stays live on an unclipped board", () => {
  for (const [x, y, width, height] of [
    [90, 10, 0, 40],
    [10, 90, 40, 0],
  ]) {
    const board = createNode("frame"),
      v = createNode("vector", board.id);
    Object.assign(board.style, { width: 100, height: 100, clipContent: false });
    Object.assign(v.style, { x, y, width, height });
    v.vector = {
      width: 40,
      height: 40,
      paths: [{ d: "M0 0H40V40H0Z", fill: true, strokeWidth: 0 }],
    };
    const doc = { ...createStarter(), nodes: [board, v] };
    assert.equal(isBoardLodRenderable(doc, board.id), false);
    assert.equal(isBoardLodRenderable(doc, board.id, layoutBounds(doc)), false);
  }
});

test("12 unclipped boards with two 6,000-point paths each stay live within 5 ms", (t) => {
  const doc = { ...createStarter(), nodes: [] as DesignNode[] };
  const boards = Array.from({ length: 12 }, (_, i) => {
    const board = createNode("frame"),
      v = createNode("vector", board.id);
    Object.assign(board.style, { width: 100, height: 100, clipContent: false });
    Object.assign(v.style, { x: 0, y: 0, width: 100, height: 100 });
    v.vector = {
      width: 100,
      height: 100,
      paths: [0, 1].map((offset) => ({
        d: Array.from(
          { length: 6000 },
          (_, j) =>
            `${j ? "L" : "M"}${1 + (j % 98)} ${1 + ((i + offset + j) % 98)}`,
        ).join(""),
        fill: false,
        strokeWidth: 1,
      })),
    };
    doc.nodes.push(board, v);
    return board;
  });
  const bounds = layoutBounds(doc);
  const start = performance.now();
  const results = boards.map((board) =>
    isBoardLodRenderable(doc, board.id, bounds),
  );
  const ms = performance.now() - start;
  assert.deepEqual(results, Array(12).fill(false));
  assert.ok(ms < 5, `12 board checks took ${ms} ms`);
  t.diagnostic(`12 boards, 144,000 points: ${ms.toFixed(3)} ms`);
});

test("the 2048-character vector budget sums paths and cached bounds follow the owning layer's stroke visibility", () => {
  const board = createNode("frame"),
    v = createNode("vector", board.id);
  Object.assign(board.style, { width: 100, height: 100, clipContent: false });
  Object.assign(v.style, {
    x: 90,
    y: 10,
    width: 10,
    height: 10,
    strokeVisible: false,
  });
  const line = { d: "M1 1H10".padEnd(1024), fill: false, strokeWidth: 4 };
  v.vector = {
    width: 10,
    height: 10,
    paths: [line, { d: "M1 1H3Z".padEnd(1024), fill: true, strokeWidth: 0 }],
  };
  const doc = { ...createStarter(), nodes: [board, v] };
  const data = line.d;
  let reads = 0;
  Object.defineProperty(line, "d", {
    enumerable: true,
    get() {
      reads++;
      return data;
    },
  });
  assert.equal(isBoardLodRenderable(doc, board.id), true);
  assert.ok(reads > 0);
  reads = 0;
  function withStroke(strokeVisible: boolean, color: string) {
    return {
      ...doc,
      nodes: [board, { ...v, style: { ...v.style, strokeVisible, color } }],
    };
  }
  assert.equal(
    isBoardLodRenderable(withStroke(true, "#000000"), board.id),
    false,
  );
  assert.equal(
    isBoardLodRenderable(withStroke(true, "transparent"), board.id),
    true,
  );
  assert.equal(reads, 0);
  const large = structuredClone(doc);
  large.nodes[1].vector!.paths[1].d += " ";
  assert.equal(isBoardLodRenderable(large, board.id), false);
});

test("a translucent group isolates the painted frame and grandchild beneath its single child", () => {
  const {
    doc,
    root,
    children: [group, frame, shape],
  } = fixture();
  group.type = "group";
  group.style.opacity = 0.5;
  frame.type = "frame";
  frame.parentId = group.id;
  frame.style.fill = "#ff0000";
  shape.parentId = frame.id;
  shape.style.fill = "#0000ff";
  assert.equal(isBoardLodRenderable(doc, root.id), false);
  const hidden = structuredClone(doc);
  hidden.nodes[3].hidden = true;
  assert.equal(isBoardLodRenderable(hidden, root.id), true);
});

test("a vector's fill, stroke and additional visible paths count separately under group opacity", () => {
  const {
    doc,
    root,
    children: [group, v, hidden],
  } = fixture();
  group.type = "group";
  group.style.opacity = 0.5;
  v.parentId = group.id;
  v.type = "vector";
  hidden.hidden = true;
  const path = { d: "M2 2H9V9Z", fill: true, strokeWidth: 1 };
  v.vector = { width: 10, height: 10, paths: [path] };
  assert.equal(isBoardLodRenderable(doc, root.id), false);
  const two = structuredClone(doc);
  const p = two.nodes[2].vector!.paths[0];
  p.strokeWidth = 0;
  two.nodes[2].vector!.paths.push({ ...p });
  assert.equal(isBoardLodRenderable(two, root.id), false);
  const one = structuredClone(two);
  one.nodes[2].vector!.paths[1].opacity = 0;
  assert.equal(isBoardLodRenderable(one, root.id), true);
});

test("a translucent nested frame isolates its surface and visible children, while a transparent frame can flatten a single child", () => {
  const {
    doc,
    root,
    children: [frame, a, b],
  } = fixture();
  frame.type = "frame";
  Object.assign(frame.style, {
    width: 180,
    height: 100,
    opacity: 0.5,
    fill: "#ff0000",
    fillOpacity: 1,
  });
  a.parentId = b.parentId = frame.id;
  Object.assign(a.style, { x: 5, y: 5 });
  Object.assign(b.style, { x: 5, y: 5 });
  b.hidden = true;
  assert.equal(isBoardLodRenderable(doc, root.id), false);
  const transparent = structuredClone(doc);
  transparent.nodes[1].style.fillOpacity = 0;
  assert.equal(isBoardLodRenderable(transparent, root.id), true);
  const two = structuredClone(transparent);
  two.nodes[3].hidden = false;
  assert.equal(isBoardLodRenderable(two, root.id), false);
  const border = structuredClone(transparent);
  Object.assign(border.nodes[1].style, { stroke: "#ff00ff", strokeWidth: 4 });
  assert.equal(isBoardLodRenderable(border, root.id), false);
});

for (const type of [
  "frame",
  "rectangle",
  "ellipse",
  "text",
  "vector",
  "section",
] as const)
  test(`a translucent ${type} with fill and inside stroke stays live`, () => {
    const { doc, root } = fixture();
    const layer = createNode(type, root.id);
    Object.assign(layer.style, {
      x: 5,
      y: 5,
      width: 50,
      height: 50,
      opacity: 0.5,
      fill: "#ff0000",
      color: "#ff0000",
      stroke: "#0000ff",
      strokeWidth: 4,
      strokeAlign: "inside",
    });
    if (type === "vector")
      layer.vector = {
        width: 50,
        height: 50,
        paths: [
          {
            d: "M5 5h40v40z",
            fill: true,
            fillColor: "#ff0000",
            strokeColor: "#0000ff",
            strokeWidth: 4,
          },
        ],
      };
    doc.nodes = [root, layer];
    assert.equal(isBoardLodRenderable(doc, root.id), false);
    if (type === "frame") {
      const nested = structuredClone(doc);
      const empty = createNode("group", layer.id);
      Object.assign(empty.style, { x: 0, y: 0, width: 10, height: 10 });
      nested.nodes.push(empty);
      assert.equal(isBoardLodRenderable(nested, root.id), false);
    }
    const fillOnly = structuredClone(doc);
    fillOnly.nodes[1].style.strokeVisible = false;
    assert.equal(isBoardLodRenderable(fillOnly, root.id), true);
  });

for (const type of ["frame", "rectangle"] as const)
  test(`a translucent ${type} keeps its surface fill and stroke when an update attaches vector data`, () => {
    const { doc, root } = fixture();
    root.style.clipContent = false;
    const layer = createNode(type, root.id);
    Object.assign(layer.style, {
      x: 5,
      y: 5,
      width: 50,
      height: 50,
      opacity: 0.5,
      fill: "#ff0000",
      stroke: "#0000ff",
      strokeWidth: 4,
      strokeAlign: "inside",
    });
    doc.nodes = [root, layer];
    if (type === "frame") {
      const empty = createNode("group", layer.id);
      Object.assign(empty.style, { x: 0, y: 0, width: 10, height: 10 });
      doc.nodes.push(empty);
    }
    const next = transact(doc, {
      baseRevision: doc.revision,
      operations: [
        {
          type: "update",
          id: layer.id,
          patch: {
            vector: {
              width: 10,
              height: 10,
              paths: [{ d: "M0 0H5V5Z", fill: true, strokeWidth: 0 }],
            },
          },
        },
      ],
    });
    assert.equal(isBoardLodRenderable(next, root.id), false);
    const pathAndFill = structuredClone(next);
    pathAndFill.nodes[1].style.strokeVisible = false;
    assert.equal(isBoardLodRenderable(pathAndFill, root.id), false);
    const fillOnly = structuredClone(pathAndFill);
    fillOnly.nodes[1].vector!.paths[0].fill = false;
    assert.equal(isBoardLodRenderable(fillOnly, root.id), true);
    const overflowing = structuredClone(next);
    overflowing.nodes[1].style.opacity = 1;
    overflowing.nodes[1].vector!.paths[0].d = "M0 0H150V5Z";
    assert.equal(isBoardLodRenderable(overflowing, root.id), false);
  });

test("a translucent rectangle with only a red fill can use the tile", () => {
  const {
    doc,
    root,
    children: [layer],
  } = fixture();
  Object.assign(layer.style, { opacity: 0.5, fill: "#ff0000", strokeWidth: 0 });
  assert.equal(isBoardLodRenderable(doc, root.id), true);
  const side = structuredClone(doc);
  Object.assign(side.nodes[1].style, {
    stroke: "#0000ff",
    strokeSides: { left: 3 },
  });
  assert.equal(isBoardLodRenderable(side, root.id), false);
});

test("LOD counts the image, gradient and stroke that are visible in the canvas instance", () => {
  const {
    doc,
    root,
    children: [layer],
  } = fixture();
  layer.nestedSlot = true;
  Object.assign(layer.style, {
    opacity: 0.5,
    fillOpacity: 0,
    stroke: "#0000ff",
    strokeWidth: 3,
  });
  layer.image = { assetId: "photo", fit: "fill", x: 50, y: 50, zoom: 1 };
  doc.images = {
    photo: {
      name: "photo",
      width: 3,
      height: 3,
      data: "data:image/png;base64,AA==",
    },
  };
  assert.equal(isBoardLodRenderable(doc, root.id), false);
  const invisible = structuredClone(doc);
  invisible.nodes[1].image!.opacity = 0;
  assert.equal(isBoardLodRenderable(invisible, root.id), true);
  const gradient = structuredClone(invisible);
  Object.assign(gradient.nodes[1].style, {
    fill: "transparent",
    fillOpacity: 1,
    gradient: {
      type: "linear",
      angle: 0,
      stops: [
        { offset: 0, color: "#ff0000", opacity: 0 },
        { offset: 1, color: "#ff0000", opacity: 1 },
      ],
    },
  });
  assert.equal(isBoardLodRenderable(gradient, root.id), false);
  const hiddenBase = structuredClone(gradient);
  hiddenBase.nodes[1].style.sketchCanvasPaints = ["base"];
  assert.equal(isBoardLodRenderable(hiddenBase, root.id), true);
});

test("tile rasterization issues a stroke only for visible vector ink", (t) => {
  const { flushFrames, strokes } = rasterHarness(t);
  const {
    doc,
    root,
    children: [v],
  } = fixture();
  const p = {
    d: "M2 2H12",
    fill: false,
    strokeWidth: 2,
    strokeColor: "#112233",
  };
  v.type = "vector";
  v.vector = {
    width: 14,
    height: 8,
    paths: [
      p,
      { ...p, strokeWidth: 0 },
      { ...p, strokeOpacity: 0 },
      { ...p, strokeColor: "transparent" },
    ],
  };
  const hidden = structuredClone(v);
  hidden.id = crypto.randomUUID();
  hidden.style.strokeVisible = false;
  doc.nodes.push(hidden);
  const cache = new BoardTileCache();
  t.after(() => cache.clear());
  let ready = false;
  cache.request(doc, root.id, layoutBounds(doc), 120, 90, () => {
    ready = true;
  });
  flushFrames();
  assert.equal(ready, true);
  assert.deepEqual(strokes, ["#112233"]);
});

test("branch signatures follow junction identity and ignore junction list order", () => {
  const {
    doc,
    root,
    children: [v],
  } = fixture();
  v.type = "vector";
  v.vector = {
    width: 10,
    height: 10,
    paths: [
      {
        d: "M0 0H5L10 5",
        fill: false,
        strokeWidth: 2,
        junctions: [
          { contour: 0, anchor: 0, id: "one" },
          { contour: 0, anchor: 2, id: "two" },
        ],
      },
    ],
  };
  const original = boardBranchSignature(doc, root.id);
  const reordered = structuredClone(doc);
  reordered.nodes[1].vector!.paths[0].junctions!.reverse();
  assert.equal(boardBranchSignature(reordered, root.id), original);
  const edited = structuredClone(doc);
  edited.nodes[1].vector!.paths[0].junctions![0].id = "different";
  assert.notEqual(boardBranchSignature(edited, root.id), original);
});

for (const layout of ["row", "free"] as const)
  test(`dragging a child 7px inside a grouped ${layout} frame matches the transaction and skips all 12 unrelated descendants`, () => {
    const {
      doc,
      root,
      children: [absolute],
    } = fixture("frame", layout);
    const group = createNode("group");
    root.parentId = group.id;
    Object.assign(group.style, {
      x: root.style.x,
      y: root.style.y,
      width: root.style.width,
      height: root.style.height,
    });
    Object.assign(root.style, { x: 0, y: 0 });
    doc.nodes.unshift(group);
    const other = createNode("frame");
    const children = Array.from({ length: 12 }, () =>
      createNode("rectangle", other.id),
    );
    doc.nodes.push(other, ...children);
    indexPublishedScene(doc);
    const bounds = layoutBounds(doc);
    const operations = [
      {
        type: "update" as const,
        id: absolute.id,
        patch: {},
        style: { x: absolute.style.x + 7 },
      },
    ];
    const expected = layoutBounds(
      transact(doc, { baseRevision: doc.revision, operations }),
    );
    let reads = 0;
    for (const child of children) {
      Object.defineProperty(child, "hidden", {
        get() {
          reads++;
          return false;
        },
      });
    }
    assert.equal(isBoardLodRenderable(doc, other.id, bounds), true);
    assert.ok(reads >= children.length);
    reads = 0;
    const preview = previewGeometry(doc, operations);
    assert.equal(positionDelta(preview)?.moved.get(absolute.id)?.dx, 7);
    const shifted = layoutBounds(preview);
    assert.equal(shifted.get(absolute.id)!.x, bounds.get(absolute.id)!.x + 7);
    assert.equal(isBoardLodRenderable(preview, other.id, shifted), true);
    assert.equal(reads, 0);
    assert.deepEqual([...shifted], [...expected]);
  });

test("switching a mounted sRGB board to Display P3 requests a P3 context on a new display canvas", async (t) => {
  const { host, flushFrames, contexts, draws } = rasterHarness(t);
  boardTileCache.clear();
  t.after(() => boardTileCache.clear());
  const { createRoot } = await import("react-dom/client");
  const mounted = createRoot(host);
  const { doc, root } = fixture();
  async function render(colorProfile: DesignDocument["colorProfile"]) {
    const document = { ...doc, colorProfile },
      bounds = layoutBounds(document);
    await act(() =>
      mounted.render(
        createElement(BoardLodTile, {
          document,
          node: root,
          bounds,
          rect: bounds.get(root.id)!,
          zoom: 0.2,
        }),
      ),
    );
    flushFrames();
    return host.getElementsByTagName("canvas")[0];
  }
  const srgb = await render("srgb");
  const p3 = await render("display-p3");
  assert.notEqual(srgb, p3);
  for (const [canvas, colorSpace] of [
    [srgb, "srgb"],
    [p3, "display-p3"],
  ] as const) {
    assert.deepEqual(
      contexts
        .filter((c) => c.target === canvas)
        .map((c) => [c.type, c.colorSpace]),
      [["2d", colorSpace]],
    );
    assert.ok(draws.some((d) => d.target === canvas));
  }
  assert.deepEqual([srgb.width, srgb.height], [0, 0]);
  await act(() => mounted.unmount());
});

test("duplicating a set and a section holding the rest of its family keeps each copy's masters inside its own set", () => {
  const section = createNode("section");
  const drawings = Array.from({ length: 4 }, () => createNode("frame"));
  const initial = { ...createStarter(), nodes: [section, ...drawings] };
  const source = transact(initial, {
    baseRevision: initial.revision,
    operations: [
      {
        type: "createVariantSet",
        canvas: true,
        libraryId: "buttons",
        name: "Button",
        axis: "State",
        members: drawings.map((n, i) => ({
          id: n.id,
          value: `State ${i}`,
          variantId: `s${i}`,
        })),
      },
    ],
  });
  const firstSet = source.nodes.find((n) => n.componentSet)!;
  const nested = createNode("group", section.id);
  nested.componentSet = { ...firstSet.componentSet! };
  source.nodes.push(nested);
  for (const n of drawings.slice(2))
    source.nodes.find((node) => node.id === n.id)!.parentId = nested.id;
  const { operations, selection } = duplicateSelectionForDrag(
    source,
    [firstSet.id, section.id],
    null,
  );
  const result = transact(source, {
    baseRevision: source.revision,
    operations,
  });
  const components = result.libraries!.buttons.components;
  assert.equal(components.length, 3);
  assert.deepEqual(components[0], source.libraries!.buttons.components[0]);
  const setIds = new Set(selection);
  const copiedSets = result.nodes.filter(
    (n) =>
      n.componentSet &&
      (setIds.has(n.id) || (n.parentId && setIds.has(n.parentId))),
  );
  assert.equal(copiedSets.length, 2);
  assert.notEqual(
    copiedSets[0].componentSet!.componentId,
    copiedSets[1].componentSet!.componentId,
  );
  for (const set of copiedSets) {
    const component = components.find(
      (c) => c.id === set.componentSet!.componentId,
    )!;
    assert.deepEqual(
      component.variants.map((v) => v.id),
      setIds.has(set.id) ? ["s0", "s1"] : ["s2", "s3"],
    );
    const masters = component.variants.map((v, i) =>
      i ? v.masterNodeId : component.master?.nodeId,
    );
    assert.equal(component.variants[0].masterNodeId, undefined);
    assert.equal(component.master!.documentId, result.id);
    assert.deepEqual(
      new Set(masters),
      new Set(
        result.nodes.filter((n) => n.parentId === set.id).map((n) => n.id),
      ),
    );
    assert.deepEqual(
      component.variants.map((v) => v.nodes.find((n) => !n.parentId)!.id),
      masters,
    );
  }
});

for (const splitSet of [false, true])
  test(`Alt-duplicating a section clones its two variants across ${splitSet ? "two nested set containers" : "one nested set"} in one undo step`, () => {
    const section = createNode("section"),
      a = createNode("frame", section.id),
      b = createNode("frame", section.id);
    const child = createNode("text", b.id);
    const initial = { ...createStarter(), nodes: [section, a, b, child] };
    const source = transact(initial, {
      baseRevision: initial.revision,
      operations: [
        {
          type: "createVariantSet",
          canvas: true,
          libraryId: "buttons",
          name: "Button",
          axis: "State",
          members: [
            { id: a.id, value: "Idle", variantId: "idle" },
            { id: b.id, value: "Busy", variantId: "busy" },
          ],
        },
      ],
    });
    const oldSet = source.nodes.find((n) => n.componentSet)!;
    assert.equal(oldSet.parentId, section.id);
    if (splitSet) {
      const other = createNode("group", section.id);
      other.componentSet = { ...oldSet.componentSet! };
      source.nodes.find((n) => n.id === b.id)!.parentId = other.id;
      source.nodes.push(other);
    }
    const {
      operations,
      selection: [id],
    } = duplicateSelectionForDrag(source, [section.id], null);
    const history = commit(
      { past: [], present: source, future: [] },
      transact(source, {
        baseRevision: source.revision,
        operations: [
          ...operations,
          { type: "update", id, patch: {}, style: { x: 77 } },
        ],
      }),
    );
    const copied = history.present;
    const clonedSets = copied.nodes.filter(
      (n) => n.parentId === id && n.componentSet,
    );
    assert.equal(clonedSets.length, splitSet ? 2 : 1);
    assert.equal(copied.nodes.find((n) => n.id === id)!.style.x, 77);
    const clonedFamily = clonedSets[0].componentSet!;
    assert.notEqual(clonedFamily.componentId, oldSet.componentSet!.componentId);
    assert.equal(clonedFamily.libraryId, "buttons");
    assert.ok(
      clonedSets.every(
        (n) => n.componentSet!.componentId === clonedFamily.componentId,
      ),
    );
    const [original, clone] = copied.libraries!.buttons.components;
    assert.equal(copied.libraries!.buttons.components.length, 2);
    assert.deepEqual(original, source.libraries!.buttons.components[0]);
    assert.equal(clone.id, clonedFamily.componentId);
    const masters = [clone.master!.nodeId, clone.variants[1].masterNodeId!];
    assert.deepEqual(
      masters.slice().sort(),
      copied.nodes
        .filter((n) => clonedSets.some((set) => set.id === n.parentId))
        .map((n) => n.id)
        .sort(),
    );
    for (const [i, variant] of clone.variants.entries()) {
      assert.equal(variant.nodes.find((n) => !n.parentId)!.id, masters[i]);
      assert.ok(!source.nodes.some((n) => n.id === masters[i]));
    }
    assert.equal(history.past.length, 1);
    const undone = travel(history, "undo");
    assert.deepEqual(undone.present.nodes, source.nodes);
    assert.deepEqual(
      undone.present.libraries,
      JSON.parse(JSON.stringify(source.libraries)),
    );
  });
