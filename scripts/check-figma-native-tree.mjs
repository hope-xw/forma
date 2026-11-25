// Compare a read-only native Figma plugin traversal with the actual UI-saved file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { readNativeDocument } from "../src/infrastructure/native-document.ts";

const [manifest, native] = process.argv.slice(2);
if (!manifest || !native)
  throw Error("Pass the native Figma manifest and the saved Forma file");
const bytes = await readFile(manifest);
const source = JSON.parse(bytes);
assert.deepEqual(source.errors, []);
assert.equal(source.instanceChildren, "excluded");
const doc = await readNativeDocument(await openAsBlob(native));
const id = (value) => "fig-" + value.replace(":", "-");
assert.deepEqual(
  doc.pages.map((page) => [page.id, page.name]),
  source.pages.map((page) => [id(page.id), page.name]),
);
let explicitlyUnnamed = 0;
let layers = 0,
  textLayers = 0,
  instances = 0;
const errors = [];
for (const [index, page] of source.pages.entries()) {
  const savedPage = doc.pages[index];
  const nodes = savedPage.nodes ?? doc.nodes;
  const pageSourceIds = new Set(page.rows.map((row) => id(row[0])));
  const stored = new Map(nodes.map((n) => [n.id, n]));
  const siblingCounts = new Map();
  const positions = new Map();
  for (const node of nodes) {
    if (!pageSourceIds.has(node.id)) {
      if (/^fig-\d+-\d+$/.test(node.id))
        errors.push([page.id, node.id, "extra authored layer"]);
      continue;
    }
    const ordinal = siblingCounts.get(node.parentId) ?? 0;
    positions.set(node.id, ordinal);
    siblingCounts.set(node.parentId, ordinal + 1);
  }
  for (const [rawId, parent, ordinal, name, type, characters] of page.rows) {
    layers++;
    if (name === "") explicitlyUnnamed++;
    if (type === "TEXT") textLayers++;
    if (type === "INSTANCE") instances++;
    const identity = id(rawId);
    const n = stored.get(identity);
    if (!n) {
      errors.push([page.id, rawId, "missing"]);
      continue;
    }
    if (n.parentId !== (parent === page.id ? null : id(parent)))
      errors.push([page.id, rawId, "parent"]);
    if (positions.get(identity) !== ordinal)
      errors.push([
        page.id,
        rawId,
        "drawing order",
        positions.get(identity),
        ordinal,
      ]);
    if (n.name !== name) errors.push([page.id, rawId, "name"]);
    if (type === "TEXT" && (n.type !== "text" || n.text !== characters))
      errors.push([page.id, rawId, "Unicode"]);
    if (type === "INSTANCE" && !n.instance)
      errors.push([page.id, rawId, "instance"]);
  }
}
console.log(
  JSON.stringify(
    {
      manifestSha256: createHash("sha256").update(bytes).digest("hex"),
      pages: source.pages.length,
      layers,
      explicitlyUnnamed,
      textLayers,
      instances,
      mismatchCount: errors.length,
      examples: errors.slice(0, 20),
    },
    null,
    2,
  ),
);
assert.equal(errors.length, 0, "Figma native tree and Forma differ");
