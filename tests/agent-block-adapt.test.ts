import test from "node:test";
import assert from "node:assert/strict";
import {
  compileBlueprintToTransaction,
  type BlueprintNode,
} from "../src/agent/blueprint-compiler";
import { validateProposal } from "../src/agent/provider";
import { commit, travel } from "../src/application/history";
import { transact } from "../src/domain/commands";
import {
  createNode,
  parseDocument,
  type DesignDocument,
  type DesignNode,
} from "../src/domain/document";
import { layoutBounds } from "../src/domain/geometry";
import {
  createLibraryFromSelection,
  instantiateComponent,
  validateInstanceStructure,
} from "../src/domain/library";
import { parseLibrary } from "../src/domain/library-schema";
import { createStarter } from "../src/domain/seed";
import { subtreeIds } from "../src/domain/tree";

function template(
  type: DesignNode["type"],
  key: string,
  name: string,
  parentId: string | null = null,
) {
  return { ...createNode(type, parentId), id: key, templateKey: key, name };
}

function campaignDocument(locked = false) {
  const block = template("frame", "floor", "促销三卡楼层");
  const cards = template("frame", "cards", "商品卡片", block.id);
  const badge = template("frame", "root", "满减胶囊");
  const label = {
    ...template("text", "label", "胶囊文案", badge.id),
    text: "满 100 减 20",
  };
  const cta = template("frame", "root", "主促按钮");
  const slot = {
    ...badge,
    id: "badge-slot",
    parentId: block.id,
    templateKey: "badge-slot",
    nestedKey: badge.templateKey,
    nestedSlot: true,
    nestedSource: {
      libraryId: "shop",
      componentId: "badge",
      variantId: "default",
    },
  };
  function component(id: string, nodes: DesignNode[]) {
    return {
      id,
      name: nodes[0].name,
      category: "促销",
      description: "",
      variants: [{ id: "default", name: "默认", properties: {}, nodes }],
    };
  }
  const library = parseLibrary({
    format: "forma/library",
    version: 1,
    id: "shop",
    name: "移动商城",
    revision: 1,
    description: "",
    source: { name: "测试", license: "自有" },
    components: [
      {
        ...component("floor", [
          block,
          template("text", "title", "标题", block.id),
          template("text", "sub", "副标题", block.id),
          cards,
          template("text", "old-tag", "旧标签", cards.id),
          { ...template("text", "legal", "活动条款", cards.id), locked },
          { ...slot, nestedSlot: true },
          {
            ...label,
            id: "badge-text",
            templateKey: "badge-text",
            nestedKey: "label",
            parentId: slot.id,
          },
        ]),
        exposed: [
          {
            kind: "swap",
            id: "promo",
            target: slot.templateKey,
            name: "活动挂件",
          },
        ],
      },
      component("badge", [badge, label]),
      component("cta", [
        cta,
        { ...template("text", "label", "按钮文案", cta.id), text: "立即抢购" },
        template("rectangle", "icon", "箭头", cta.id),
      ]),
    ],
  });
  return parseDocument({ ...createStarter(), libraries: { shop: library } });
}

function named(doc: DesignDocument, name: string, parentId?: string) {
  const node = doc.nodes.find(
    (n) =>
      n.name === name && (parentId === undefined || n.parentId === parentId),
  );
  assert.ok(node, name);
  return node;
}

function replay(
  document: DesignDocument,
  input: unknown,
  selection: string | null = null,
  viewportCenter?: { x: number; y: number },
) {
  const context = {
    document,
    prompt: "派生促销楼层及其异常页",
    selection,
    viewportCenter,
  };
  const compiled = compileBlueprintToTransaction(input, context);
  assert.deepEqual(
    compiled.diagnostics.filter((d) => d.severity === "error"),
    [],
  );
  assert.ok(compiled.transaction);
  const tx = validateProposal(
    context,
    JSON.parse(JSON.stringify(compiled.transaction)),
  );
  return { ...compiled, tx, next: parseDocument(transact(document, tx)) };
}

test("楼层外框先显式分离，再改网格、删层和追加文本及受保护按钮；一次撤销还原整笔事务", () => {
  const document = campaignDocument();
  const original = structuredClone(document);
  const { tx, next, diagnostics } = replay(document, {
    artboards: [
      {
        type: "frame",
        name: "大促首页",
        children: [
          {
            type: "component",
            componentId: "floor",
            overrides: {
              text: "今晚八点开抢",
              textByTemplateKey: { sub: "会员提前入场" },
              fill: "#111",
              color: "#c30",
              opacity: 0.8,
            },
            style: { fill: "#aaa", borderRadius: 18 },
            adapt: {
              detachOuter: true,
              name: "双列限时购",
              style: {
                background: "#fed",
                layout: "grid",
                columns: 2,
                padding: 16,
                gap: 12,
              },
              removeChildren: ["old-tag", "副标题"],
              appendChildren: [
                { type: "text", name: "倒计时", text: "00:29:59" },
                { type: "component", libraryId: "shop", componentId: "cta" },
              ],
            },
          },
        ],
      },
    ],
  });
  assert.deepEqual(diagnostics, []);
  const root = named(next, "双列限时购", named(next, "大促首页").id);
  const detach = tx.operations.findIndex(
    (op) => op.type === "detachInstance" && op.id === root.id,
  );
  assert.ok(detach > 0);
  const beforeDetach = tx.operations.slice(0, detach);
  const assembled = transact(document, { ...tx, operations: beforeDetach });
  const protectedRoot = assembled.nodes.find((n) => n.id === root.id)!;
  validateInstanceStructure(assembled, protectedRoot);
  assert.equal(protectedRoot.instance?.componentId, "floor");
  assert.equal(protectedRoot.style.fill, "#111111");
  assert.equal(named(assembled, "副标题", root.id).text, "会员提前入场");
  assert.ok(
    tx.operations
      .slice(detach + 1)
      .some(
        (op) =>
          op.type === "update" && op.id === root.id && op.style?.columns === 2,
      ),
  );
  assert.equal(root.type, "frame");
  assert.equal(root.instance, undefined);
  assert.deepEqual(
    [
      root.style.fill,
      root.style.layout,
      root.style.columns,
      root.style.gap,
      root.style.padding,
      root.style.radius,
      root.style.opacity,
    ],
    ["#ffeedd", "grid", 2, 12, 16, 18, 0.8],
  );
  assert.equal(named(next, "标题", root.id).text, "今晚八点开抢");
  assert.equal(named(next, "标题", root.id).style.color, "#cc3300");
  assert.ok(!next.nodes.some((n) => ["副标题", "旧标签"].includes(n.name)));
  assert.equal(named(next, "倒计时", root.id).text, "00:29:59");
  for (const [name, id] of [
    ["主促按钮", "cta"],
    ["满减胶囊", "badge"],
  ]) {
    const atom = named(next, name, root.id);
    assert.deepEqual(atom.instance, {
      libraryId: "shop",
      componentId: id,
      variantId: "default",
    });
    validateInstanceStructure(next, atom);
    const child = next.nodes.find((n) => n.parentId === atom.id)!;
    assert.throws(
      () =>
        transact(next, {
          baseRevision: next.revision,
          operations: [{ type: "remove", id: child.id }],
        }),
      /结构受保护/,
    );
  }
  const history = commit({ present: document, past: [], future: [] }, next);
  const undo = travel(history, "undo");
  assert.equal(undo.past.length, 0);
  assert.deepEqual({ ...undo.present, revision: document.revision }, original);
  assert.deepEqual(document, original);
  assert.deepEqual(transact(document, tx).nodes, next.nodes);
});

test("选区 insertComponent 可追加子组件，锁定分支及实例内部不能误删", () => {
  const document = campaignDocument(true);
  const [selected, other] = document.nodes.filter((n) => !n.parentId);
  const edit = {
    op: "insertComponent",
    componentId: "floor",
    position: { x: 14 },
    adapt: {
      detachOuter: true,
      name: "活动专区",
      style: { x: 100, y: 27 },
      removeChildren: ["商品卡片", "legal", "badge-text", "old-tag"],
      appendChildren: [{ type: "component", componentId: "cta" }],
    },
  };
  const { next, diagnostics, tx } = replay(
    document,
    { edits: [edit] },
    selected.id,
  );
  const root = named(next, "活动专区", selected.id);
  assert.ok(
    tx.operations.some(
      (op) => op.type === "detachInstance" && op.id === root.id,
    ),
  );
  assert.deepEqual([root.style.x, root.style.y], [14, 27]);
  assert.equal(root.instance, undefined);
  assert.ok(
    named(next, "活动条款", named(next, "商品卡片", root.id).id).locked,
  );
  assert.ok(!next.nodes.some((n) => n.name === "旧标签"));
  assert.equal(named(next, "主促按钮", root.id).instance?.componentId, "cta");
  assert.equal(
    diagnostics.filter(
      (d) => d.code === "locked-layer" && d.severity === "warning",
    ).length,
    2,
  );
  assert.ok(diagnostics.some((d) => d.code === "instance-protected"));
  const outside = (doc: DesignDocument) =>
    doc.nodes.filter((n) => !subtreeIds(doc, [selected.id]).has(n.id));
  assert.deepEqual(outside(next), outside(document));
  assert.deepEqual(next.libraries, document.libraries);
  const blocked = compileBlueprintToTransaction(
    { edits: [{ ...edit, parentId: other.id }] },
    { document, selection: selected.id },
  );
  assert.equal(blocked.transaction, undefined);
  assert.ok(blocked.diagnostics.some((d) => d.code === "selection-scope"));
});

test("children 配合 adapt 触发分离，插槽替换生成的新子层可稳定回放", () => {
  const document = campaignDocument();
  const { next, tx, diagnostics } = replay(document, {
    artboards: [
      {
        type: "component",
        componentId: "floor",
        name: "活动",
        overrides: {
          slots: { promo: { libraryId: "shop", componentId: "cta" } },
        },
        adapt: { name: "替换挂件", removeChildren: ["old-tag"] },
        children: [
          {
            type: "frame",
            name: "倒计时栏",
            locked: true,
            children: [{ type: "text", name: "倒计时", text: "剩余 30 秒" }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(diagnostics, []);
  const root = named(next, "替换挂件");
  assert.equal(root.instance, undefined);
  const clock = named(next, "倒计时栏", root.id);
  assert.equal(clock.locked, true);
  assert.equal(named(next, "倒计时", clock.id).text, "剩余 30 秒");
  const slot = named(next, "满减胶囊", root.id);
  assert.equal(slot.instance?.componentId, "cta");
  validateInstanceStructure(next, slot);
  assert.equal(named(next, "箭头", slot.id).templateKey, "icon");
  assert.deepEqual(transact(document, tx).nodes, next.nodes);
  for (const specification of [
    { children: [{ type: "text", name: "未授权" }] },
    { adapt: { detachOuter: false, removeChildren: ["old-tag"] } },
  ]) {
    const { next: protectedDoc, tx: protectedTx } = replay(document, {
      artboards: [
        { type: "component", componentId: "floor", ...specification },
      ],
    });
    assert.ok(
      !protectedTx.operations.some((op) => op.type === "detachInstance"),
    );
    validateInstanceStructure(
      protectedDoc,
      named(protectedDoc, "促销三卡楼层"),
    );
  }
});

test("离线楼层缺少嵌套组件来源时，保留可回放的原始图层快照并给出提示", () => {
  const document = campaignDocument();
  const shop = document.libraries!.shop;
  shop.components = shop.components.filter((c) => c.id !== "badge");
  const { next, diagnostics } = replay(parseDocument(document), {
    artboards: [
      {
        type: "component",
        componentId: "floor",
        adapt: { detachOuter: true, removeChildren: ["胶囊文案"] },
      },
    ],
  });
  assert.deepEqual(
    diagnostics.map((d) => d.code),
    ["nested-source-unavailable", "instance-protected"],
  );
  const slot = named(next, "满减胶囊", named(next, "促销三卡楼层").id);
  assert.equal(slot.instance, undefined);
  assert.equal(named(next, "胶囊文案", slot.id).text, "满 100 减 20");
});

test("Group 楼层转为 Frame 后，其内嵌楼层仍保留可再次替换的原装插槽", () => {
  const base = campaignDocument();
  const group = createNode("group"),
    footer = template("text", "footer", "楼层尾注", group.id);
  const shop = base.libraries!.shop;
  const author = { ...base, nodes: [group] };
  const inserted = instantiateComponent(
    author,
    shop,
    "floor",
    "default",
    group.id,
    { x: 0, y: 0 },
  );
  const authored = transact(author, {
    baseRevision: author.revision,
    operations: [...inserted.operations, { type: "create", node: footer }],
  });
  const library = createLibraryFromSelection(authored, group.id, "活动楼层组");
  const document = parseDocument({
    ...base,
    libraries: { ...base.libraries, [library.id]: library },
  });
  const { next, diagnostics } = replay(
    document,
    {
      edits: [
        {
          op: "insertComponent",
          libraryId: library.id,
          componentId: "component",
          adapt: {
            detachOuter: true,
            name: "派生活动区",
            style: { layout: "grid", columns: 2 },
          },
        },
      ],
    },
    base.nodes[0].id,
  );
  assert.deepEqual(diagnostics, []);
  const adapted = named(next, "派生活动区");
  assert.equal(adapted.type, "frame");
  assert.equal(adapted.style.layout, "grid");
  assert.deepEqual(
    next.nodes.filter((n) => n.parentId === adapted.id).map((n) => n.name),
    ["促销三卡楼层", "楼层尾注"],
  );
  const floor = named(next, "促销三卡楼层", adapted.id);
  validateInstanceStructure(next, floor);
  const badge = named(next, "满减胶囊", floor.id);
  assert.equal(badge.nestedSource?.componentId, "badge");
  assert.equal(badge.templateKey, "badge-slot");
  const switched = transact(next, {
    baseRevision: next.revision,
    operations: [
      {
        type: "setInstanceSlot",
        id: floor.id,
        property: "promo",
        value: { libraryId: "shop", componentId: "cta", variantId: "default" },
      },
    ],
  });
  validateInstanceStructure(switched, named(switched, floor.name, adapted.id));
  assert.equal(named(switched, "箭头", badge.id).type, "rectangle");
});

function screen(
  refId: string,
  width: number,
  height: number,
  role?: BlueprintNode["role"],
  parentRef?: string,
): BlueprintNode {
  return {
    refId,
    name: refId,
    type: "frame",
    role,
    parentRef,
    style: { width, height },
  };
}

function assertDisjoint(doc: DesignDocument) {
  const bounds = layoutBounds(doc);
  const roots = doc.nodes.filter((n) => n.parentId === null);
  for (const [i, a] of roots.entries())
    for (const b of roots.slice(i + 1)) {
      const r = bounds.get(a.id)!,
        s = bounds.get(b.id)!;
      assert.ok(
        r.x + r.width <= s.x ||
          s.x + s.width <= r.x ||
          r.y + r.height <= s.y ||
          s.y + s.height <= r.y,
        a.name + " 与 " + b.name + " 重叠",
      );
    }
}

test("五张画板的主流程与异常矩阵按实际尺寸排布，正向及反向引用均可解析", () => {
  const document = campaignDocument();
  const home = screen("home", 390, 844, "primary");
  home.children = [
    {
      type: "button",
      name: "打开优惠券",
      interaction: { overlayRef: "coupon" },
    },
    {
      type: "button",
      name: "查看异常",
      interaction: { navigateToRef: "sold-out" },
    },
  ];
  const sold = screen("sold-out", 375, 280, "exception", "home");
  sold.children = [
    {
      type: "button",
      name: "返回首页",
      interaction: { navigateToRef: "home" },
    },
  ];
  const { next, createdRootIds } = replay(document, {
    artboards: [
      sold,
      home,
      screen("pay-failed", 320, 220, "exception", "checkout"),
      screen("checkout", 414, 736, "primary"),
      screen("coupon", 320, 180, "overlay", "home"),
    ],
  });
  const [s, h, f, c, o] = createdRootIds.map((id) =>
    next.nodes.find((n) => n.id === id)!,
  );
  assert.deepEqual(
    [s.name, h.name, f.name, c.name, o.name],
    ["sold-out", "home", "pay-failed", "checkout", "coupon"],
  );
  assert.deepEqual([c.style.x, c.style.y], [h.style.x + 390 + 80, h.style.y]);
  assert.deepEqual([s.style.x, s.style.y], [h.style.x, h.style.y + 844 + 80]);
  assert.deepEqual([o.style.x, o.style.y], [h.style.x, s.style.y + 280 + 80]);
  assert.deepEqual([f.style.x, f.style.y], [c.style.x, c.style.y + 736 + 80]);
  assert.deepEqual(named(next, "打开优惠券", h.id).interaction?.actions, [
    { kind: "overlay", target: o.id, position: "bottom" },
  ]);
  assert.deepEqual(named(next, "查看异常", h.id).interaction?.actions, [
    { kind: "navigate", target: s.id },
  ]);
  assert.deepEqual(named(next, "返回首页", s.id).interaction?.actions, [
    { kind: "navigate", target: h.id },
  ]);
  assertDisjoint(next);
});

test("视口起点可用时，后续主画板和宽幅详情页仍避开已有画板与相邻列", () => {
  const wall = createNode("frame"),
    below = createNode("frame");
  Object.assign(wall.style, { x: 190, y: 0, width: 80, height: 80 });
  Object.assign(below.style, { x: 0, y: 180, width: 80, height: 80 });
  const document = parseDocument({ ...createStarter(), nodes: [wall, below] });
  const { next } = replay(
    document,
    {
      artboards: [
        screen("home", 100, 100, "primary"),
        screen("checkout", 100, 100, "primary"),
        screen("wide", 550, 150, "detail", "home"),
        screen("alert", 100, 200, "exception", "checkout"),
        screen("unattached", 80, 60, "overlay", "unknown"),
      ],
    },
    null,
    { x: 50, y: 50 },
  );
  assert.equal(named(next, "home").style.x, 0);
  assert.equal(named(next, "checkout").style.x, 350);
  assert.deepEqual(
    [named(next, "wide").style.x, named(next, "wide").style.y],
    [0, 340],
  );
  const alert = named(next, "alert").style;
  assert.equal(alert.x, 350);
  assert.equal(alert.y, 570);
  assertDisjoint(next);
});

test("作为主画板的派生楼层按最终尺寸占位，原装按钮可连接浮层", () => {
  const document = campaignDocument();
  const { next } = replay(document, {
    artboards: [
      {
        ...screen("offer", 240, 180, "overlay", "home"),
        children: [
          {
            type: "button",
            name: "回到主会场",
            interaction: { navigateToRef: "home" },
          },
        ],
      },
      {
        type: "component",
        refId: "home",
        role: "primary",
        componentId: "floor",
        adapt: {
          detachOuter: true,
          name: "主会场",
          style: { width: 100, minWidth: 520, height: 400 },
          appendChildren: [
            {
              type: "component",
              componentId: "cta",
              interaction: { overlayRef: "offer" },
            },
          ],
        },
      },
      screen("order", 200, 300, "primary"),
    ],
  });
  const home = named(next, "主会场"),
    offer = named(next, "offer");
  const bounds = layoutBounds(next),
    size = bounds.get(home.id)!;
  assert.equal(size.width, 520);
  assert.equal(named(next, "order").style.x, size.x + size.width + 80);
  assert.deepEqual(
    [offer.style.x, offer.style.y],
    [size.x, size.y + size.height + 80],
  );
  const button = named(next, "主促按钮", home.id);
  validateInstanceStructure(next, button);
  assert.deepEqual(button.interaction?.actions, [
    { kind: "overlay", target: offer.id, position: "bottom" },
  ]);
  assert.deepEqual(named(next, "回到主会场", offer.id).interaction?.actions, [
    { kind: "navigate", target: home.id },
  ]);
  assertDisjoint(next);
});

test("无角色及全 primary 均保留原有起点、输入顺序和 80px 横向间距", () => {
  const document = createStarter();
  for (const role of [undefined, "primary"] as const) {
    const boards = [
      screen("a", 220, 450, role),
      screen("b", 365, 640, role),
      screen("c", 150, 300, role),
    ];
    const { next, createdRootIds } = replay(
      document,
      { artboards: boards },
      null,
      { x: -500, y: -300 },
    );
    assert.deepEqual(
      createdRootIds.map((id) => {
        const node = next.nodes.find((n) => n.id === id)!;
        return [node.name, node.style.x, node.style.y];
      }),
      [
        ["a", -610, -525],
        ["b", -310, -525],
        ["c", 135, -525],
      ],
    );
  }
});

test("后续全主画板和无角色画板按实测占位避开既有画板", () => {
  const wall = createNode("frame");
  Object.assign(wall.style, { x: 260, y: 0, width: 260, height: 300 });
  const document = parseDocument({ ...createStarter(), nodes: [wall] });
  for (const role of [undefined, "primary"] as const) {
    const { next } = replay(
      document,
      {
        artboards: [
          screen("first", 200, 200, role),
          screen("second", 200, 200, role),
        ],
      },
      null,
      { x: 100, y: 100 },
    );
    assert.equal(named(next, "first").style.x, 0);
    assert.equal(named(next, "second").style.x, 600);
    assertDisjoint(next);
  }
});
