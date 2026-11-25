// Run with node --import tsx --max-old-space-size=8192 scripts/check-original-figma.mjs <file.fig>
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { openDesignArchive } from "../src/infrastructure/design-import/archive.ts";
import { readFigmaCanvas } from "../src/infrastructure/design-import/figma-kiwi.ts";
import { guid } from "../src/infrastructure/design-import/figma-layer.ts";
import { importFigma } from "../src/infrastructure/design-import/figma.ts";
import { parseDocument } from "../src/domain/document.ts";
import {
  nativeDocumentBlob,
  readNativeDocument,
} from "../src/infrastructure/native-document.ts";

const [file] = process.argv.slice(2);
if (!file) throw Error("Pass a local .fig filename");
const bytes = new Uint8Array(await readFile(file));
const archive = bytes[0] === 80 ? openDesignArchive(bytes) : undefined;
const snapshot = readFigmaCanvas(archive ? archive.read("canvas.fig") : bytes);
const records = snapshot.message.nodeChanges;
const indexed = new Map(records.map((n) => [guid(n.guid), n]));
const children = new Map();
for (const n of records) {
  const parent = guid(n.parentIndex?.guid);
  if (!children.has(parent)) children.set(parent, []);
  children.get(parent).push(n);
}
function position(a, b) {
  const x = a.parentIndex.position,
    y = b.parentIndex.position;
  return x < y ? -1 : x > y ? 1 : 0;
}
for (const list of children.values()) if (list.length > 1) list.sort(position);
const sourcePages = records
  .filter((n) => n.type === "CANVAS" && !n.internalOnly)
  .sort(position);
const excluded = new Set(["VARIABLE", "VARIABLE_SET", "CODE_LIBRARY", "BRUSH"]);
const graphic = (n) => !n.styleType && !excluded.has(n.type);
const rawStyles = records.filter((n) => n.styleType),
  rawSymbols = records.filter((n) => n.type === "SYMBOL" && !n.styleType);
const { document: draft, issues } = await importFigma(bytes, basename(file));
const portable = nativeDocumentBlob(parseDocument(draft));
const doc = await readNativeDocument(portable);
assert.deepEqual(
  doc.pages.map((p) => p.id),
  sourcePages.map((p) => guid(p.guid)),
  "ordinary page order",
);
assert.deepEqual(
  doc.pages.map((p) => p.name),
  sourcePages.map((p) => p.name),
  "page names",
);
let sourceLayers = 0,
  strings = 0,
  ordinaryInstances = 0,
  renderedNodes = 0;
const all = new Map();
const assignedSlots = new Set(),
  dormantSlots = new Set();
function add(n) {
  const variants = all.get(n.id) ?? new Set();
  const ref = (n.instance ?? n.nestedSource)?.variantId;
  if (ref) variants.add(ref);
  if (n.nestedSource) assignedSlots.add(n.nestedSource.variantId);
  for (const ref of Object.values(
    (n.instance ?? n.nestedSource)?.slotProperties ?? {},
  ))
    dormantSlots.add(ref.variantId);
  all.set(n.id, variants);
  for (const ref of Object.values(
    n.instance?.slots ?? n.nestedSource?.slots ?? {},
  ))
    assignedSlots.add(ref.variantId);
}
for (const [i, p] of doc.pages.entries()) {
  const nodes = p.nodes ?? doc.nodes;
  renderedNodes += nodes.length;
  const visibleSourceNodes = nodes.filter((n) => indexed.has(n.id)),
    actual = new Map(visibleSourceNodes.map((n) => [n.id, n]));
  for (const n of nodes) add(n);
  const actualChildren = new Map();
  for (const n of visibleSourceNodes) {
    const family = actualChildren.get(n.parentId) ?? [];
    family.push(n.id);
    actualChildren.set(n.parentId, family);
  }
  function walk(ancestor, parentId) {
    const list = (children.get(guid(ancestor.guid)) ?? []).filter(graphic);
    assert.deepEqual(
      actualChildren.get(parentId) ?? [],
      list.map((n) => guid(n.guid)),
      p.name + " drawing order " + (parentId ?? "page"),
    );
    for (const n of list) {
      const id = guid(n.guid),
        stored = actual.get(id);
      assert.ok(stored, id);
      assert.equal(stored.parentId, parentId, id + " original parent");
      assert.equal(stored.name, n.name ?? n.type, id + " layer name");
      if (n.type === "TEXT") {
        strings++;
        assert.equal(
          stored.text,
          n.textData?.characters ?? "",
          id + " original Unicode",
        );
      }
      if (n.type === "INSTANCE") ordinaryInstances++;
      if (n.mask === true)
        assert.equal(
          stored.siblingMask,
          n.maskType === "LUMINANCE"
            ? "luminance"
            : n.maskType === "VECTOR"
              ? "vector"
              : "alpha",
          id + " sibling mask",
        );
      sourceLayers++;
      walk(n, id);
    }
  }
  walk(sourcePages[i], null);
}
const libraries = Object.values(doc.libraries ?? {}),
  components = libraries.flatMap((l) => l.components),
  variants = components.flatMap((c) => c.variants);
for (const v of variants) for (const n of v.nodes) add(n);
// A plate can retain several paint types at once. Check every authored
// gradient stop and its position after the actual portable serialization.
const authoredById = new Map(
  variants.flatMap((v) => v.nodes).map((n) => [n.id, n]),
);
for (const p of doc.pages)
  for (const n of p.nodes ?? doc.nodes) authoredById.set(n.id, n);
let sourceGradientLayers = 0,
  sourceGradientStops = 0;
for (const record of records) {
  if (record.styleType) continue;
  const sourcePaints = record.fillPaints ?? [];
  const sourceGradients = sourcePaints.filter((p) =>
    p.type?.startsWith("GRADIENT_"),
  );
  if (!sourceGradients.length) continue;
  const identity = guid(record.guid);
  const node = authoredById.get(identity);
  if (!node) continue;
  const saved = node.style.paints
    ? node.style.paints
        .map((p) => p.gradient)
        .filter(Boolean)
        .reverse()
    : node.style.gradient
      ? [node.style.gradient]
      : [];
  assert.equal(
    saved.length,
    sourceGradients.length,
    identity + " gradient layers",
  );
  for (const [i, g] of sourceGradients.entries()) {
    assert.deepEqual(
      saved[i].stops.map((s) => s.offset),
      g.stops.map((s) => s.position),
      identity + " gradient stops",
    );
    sourceGradientStops += g.stops.length;
  }
  sourceGradientLayers++;
}
const sourceSlots = new Set(
  records.filter((n) => n.isSlotContent).map((n) => guid(n.guid)),
);
const storedSlots = components
  .filter((c) => c.category === "Figma 插槽内容")
  .flatMap((c) => c.variants)
  .map((v) => v.id);
assert.deepEqual(
  new Set(storedSlots),
  sourceSlots,
  "original slot content subtrees",
);
const referencedSlots = storedSlots.filter((id) => assignedSlots.has(id));
assert.deepEqual(
  storedSlots.filter((id) => !assignedSlots.has(id) && !dormantSlots.has(id)),
  [],
  "source slot assignments including inactive variants",
);
const masters = components
  .filter((c) => c.category !== "Figma 插槽内容")
  .flatMap((c) => c.variants);
assert.deepEqual(
  new Set(masters.map((v) => v.id)),
  new Set(rawSymbols.map((n) => guid(n.guid))),
  "every component definition",
);
assert.deepEqual(
  new Set(Object.keys(doc.designSystem?.styles ?? {})),
  new Set(rawStyles.map((n) => guid(n.guid))),
  "every shared style",
);
for (const original of rawStyles) {
  assert.equal(
    doc.designSystem.styles[guid(original.guid)].sourceArchived === true,
    original.isSoftDeleted === true,
    "active and archived source styles",
  );
}
const instances = records.filter((n) => n.type === "INSTANCE");
const missing = [],
  detached = [],
  internalObjects = [];
for (const n of instances) {
  const origin = guid(n.guid),
    master = guid(n.symbolData?.symbolID);
  if (!indexed.has(master)) {
    missing.push(origin);
    continue;
  }
  if (!all.get(origin)?.has(master)) {
    let parent = indexed.get(guid(n.parentIndex?.guid));
    while (parent && parent.type !== "SYMBOL" && parent.type !== "CANVAS")
      parent = indexed.get(guid(parent.parentIndex?.guid));
    if (parent?.type === "CANVAS" && parent.internalOnly)
      internalObjects.push(origin);
    else detached.push(origin);
  }
}
assert.deepEqual(detached, [], "source instance lost master binding");
console.log(
  JSON.stringify(
    {
      source: basename(file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourceBytes: bytes.length,
      kiwiVersion: snapshot.version,
      sourceRecords: records.length,
      ordinaryPages: sourcePages.length,
      ordinarySourceLayers: sourceLayers,
      expandedPageLayers: renderedNodes,
      verbatimSourceTexts: strings,
      sourceInstances: instances.length,
      ordinaryInstances,
      templateInstances:
        instances.length - ordinaryInstances - internalObjects.length,
      nonComponentInternalInstances: internalObjects.length,
      sourceMissingMasters: missing.length,
      detachedInstances: detached.length,
      components: components.filter((c) => c.category !== "Figma 插槽内容")
        .length,
      variants: masters.length,
      slotContentVariants: variants.length - masters.length,
      slotVariantsInSavedAssignments: referencedSlots.length,
      slotVariantsOnlyInInactiveProperties: storedSlots.filter(
        (id) => !assignedSlots.has(id) && dormantSlots.has(id),
      ).length,
      styles: rawStyles.length,
      activeStyleRecords: rawStyles.filter((n) => !n.isSoftDeleted).length,
      archivedStyleRecords: rawStyles.filter((n) => n.isSoftDeleted).length,
      variables: Object.keys(doc.designSystem?.variables ?? {}).length,
      images: Object.keys(doc.images ?? {}).length,
      nativeReopenBytes: portable.size,
      sourceGradientLayers,
      sourceGradientStops,
      diagnosticRows: issues.length,
    },
    null,
    2,
  ),
);
