// Use the native Figma renderer. No plugin operation writes into the design.
const samples = [
  ["cover", "221:56229", "2401:4"],
  ["button", "507:24673", "5:108579"],
  ["toggle-on", "507:24690", "5433:19060"],
  ["toggle-off", "507:24690", "5433:20192"],
  ["alert-button", "507:24668", "5446:6654"],
  ["alert", "507:24668", "65:57149"],
];
figma.showUI(__html__, { width: 420, height: 160 });
async function collect() {
  const pages = figma.root.children;
  const output = {
    file: figma.root.name,
    pages: pages.map((p) => [p.id, p.name]),
    samples: [],
    errors: [],
  };
  for (const [tag, pid, id] of samples) {
    try {
      figma.ui.postMessage({ progress: tag });
      const page = pages.find((p) => p.id === pid);
      if (!page) throw Error("Missing page " + pid);
      await page.loadAsync();
      const node = page.findOne((n) => n.id === id);
      if (!node || !("exportAsync" in node)) throw Error("Missing node " + id);
      const png = await node.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 1 },
        useAbsoluteBounds: true,
      });
      output.samples.push({
        tag,
        id,
        name: node.name,
        type: node.type,
        size: [node.width, node.height],
        png: figma.base64Encode(png),
      });
    } catch (e) {
      output.errors.push([tag, String(e)]);
    }
  }
  try {
    const page = pages.find((p) => p.name === "Notifications");
    await page.loadAsync();
    const material = page.findOne((n) => n.id === "533:5302");
    if (material && "effects" in material)
      output.notificationEffects = material.effects;
  } catch (e) {
    output.errors.push(["notification", String(e)]);
  }
  figma.ui.postMessage({ output });
}
collect().catch((e) => figma.ui.postMessage({ error: String(e) }));

// Isolated paints are saved separately from the six release reference images.
figma.ui.onmessage = async (message) => {
  if (message.type === "structure") return structure();
  if (message.type === "paints") return sourcePaints();
  if (message.type !== "material" && message.type !== "controls") return;
  const output = { file: figma.root.name, samples: [], errors: [] };
  try {
    async function png(tag, n) {
      if (!n) throw Error("Missing reference " + tag);
      const png = await n.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 1 },
        useAbsoluteBounds: true,
      });
      output.samples.push({
        tag,
        id: n.id,
        name: n.name,
        type: n.type,
        size: [n.width, n.height],
        png: figma.base64Encode(png),
      });
    }
    if (message.type === "controls") {
      const page = figma.root.children.find((p) => p.id === "507:24690");
      await page.loadAsync();
      for (const [tag, id] of [
        ["dark-pressed-on", "5433:20196"],
        ["dark-idle-off", "5433:20197"],
        ["pressed-off", "10456:1236"],
        ["idle-on", "27:68905"],
        ["pressed-on", "10456:1240"],
      ]) {
        const n = page.findOne((n) => n.id === id);
        await png(tag, n);
        for (const part of n.findAll((n) =>
          ["Glass Effect", "Shadow", "Specular Light", "Knob"].includes(n.name),
        ))
          await png(
            tag + "-" + part.name.toLowerCase().replace(/ /g, "-"),
            part,
          );
      }
      const materials = figma.root.children.find((p) => p.id === "215:105157");
      await materials.loadAsync();
      const group = materials.findOne((n) => n.id === "5584:32503");
      for (const variant of group.children) {
        const tag = variant.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        await png("regular-" + tag, variant);
        for (const n of variant.children)
          await png(
            "regular-" +
              tag +
              "-" +
              n.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            n,
          );
      }
    } else {
      const page = figma.root.children.find((p) => p.id === "507:24668");
      await page.loadAsync();
      const bg = page.findOne((n) => n.id === "5446:7340");
      for (const [i, n] of [bg, ...bg.children].entries())
        await png("alert-material-" + i, n);
    }
  } catch (e) {
    output.errors.push(String(e));
  }
  figma.ui.postMessage({
    output,
    filename:
      message.type === "controls"
        ? "forma-figma-material-control-samples.json"
        : "forma-figma-material-layers.json",
  });
};

async function structure() {
  const result = {
    file: figma.root.name,
    schema: ["id", "parentId", "siblingIndex", "name", "type", "characters?"],
    instanceChildren: "excluded",
    pages: [],
    errors: [],
  };
  for (const page of figma.root.children) {
    try {
      figma.ui.postMessage({ progress: page.name });
      await page.loadAsync();
      const rows = [];
      function visit(parent) {
        parent.children.forEach((n, i) => {
          const row = [n.id, parent.id, i, n.name, n.type];
          if (n.type === "TEXT") row.push(n.characters);
          rows.push(row);
          if (n.type !== "INSTANCE" && "children" in n) visit(n);
        });
      }
      visit(page);
      result.pages.push({ id: page.id, name: page.name, rows });
    } catch (e) {
      result.errors.push([page.id, String(e)]);
    }
  }
  figma.ui.postMessage({
    output: result,
    filename: "forma-figma-native-structure.json",
  });
}

async function sourcePaints() {
  const output = { file: figma.root.name, samples: [], errors: [], nodes: [] };
  for (const [tag, id] of [
    ["multi-stroke-row", "36:58723"],
    ["multi-stroke-arrow", "492:46326"],
    ["linked-two-strokes", "492:46987"],
    ["gradient", "533:16900"],
    ["vector-multifill", "56:56615"],
  ]) {
    try {
      let n;
      for (let i = 0; i < 3 && !n; i++) {
        try {
          n = await figma.getNodeByIdAsync(id);
        } catch (e) {
          if (i === 2) throw e;
        }
      }
      if (!n) throw Error("No native node " + id);
      const details = { id: n.id, type: n.type, name: n.name };
      for (const field of [
        "strokes",
        "fills",
        "strokeStyleId",
        "fillStyleId",
        "key",
        "remote",
      ]) {
        if (field in n)
          details[field] = n[field] === figma.mixed ? "mixed" : n[field];
      }
      for (const field of ["fillStyleId", "strokeStyleId"]) {
        const styleId = details[field];
        if (typeof styleId === "string" && styleId) {
          const sty = await figma.getStyleByIdAsync(styleId);
          if (sty)
            details[field + "Resolved"] = {
              id: sty.id,
              key: sty.key,
              name: sty.name,
              type: sty.type,
              remote: sty.remote,
              paints: sty.paints,
            };
        }
      }
      let parent = n;
      while (
        parent &&
        parent.type !== "COMPONENT" &&
        parent.type !== "INSTANCE" &&
        parent.type !== "DOCUMENT"
      )
        parent = parent.parent;
      if (parent && parent.type !== "DOCUMENT") {
        const main =
          parent.type === "INSTANCE"
            ? await parent.getMainComponentAsync()
            : parent;
        if (main)
          details.nearestMainComponent = {
            id: main.id,
            key: main.key,
            name: main.name,
            remote: main.remote,
          };
      }
      output.nodes.push(details);
      const png = await n.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 1 },
        useAbsoluteBounds: true,
      });
      output.samples.push({
        tag,
        id: n.id,
        name: n.name,
        type: n.type,
        size: [n.width, n.height],
        png: figma.base64Encode(png),
      });
    } catch (e) {
      output.errors.push([id, String(e)]);
    }
  }
  figma.ui.postMessage({ output, filename: "forma-figma-native-styles.json" });
}
