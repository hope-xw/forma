// Run from the project root with node --import tsx. Only reads the given asset directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createNode, parseDocument } from "../../../../src/domain/document.ts";
import { textParts } from "../../../../src/domain/rich-text.ts";

const root = process.argv[2];
if (!root) throw Error("请传入导出资源目录");
const paths = [];
async function list(folder) {
  for (const entry of await readdir(join(root, folder), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await list(path);
    else if (entry.isFile()) paths.push(path);
  }
}
await list("");
const byExtension = {};
const hashes = new Set();
const manifest = createHash("sha256");
let totalBytes = 0;
let privateUsePaths = 0;
for (const path of paths.sort()) {
  const bytes = await readFile(join(root, path));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const ext = extname(path).toLowerCase();
  if (ext === ".png")
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  byExtension[ext] = (byExtension[ext] ?? 0) + 1;
  if (/\p{Co}/u.test(path)) privateUsePaths++;
  hashes.add(digest);
  totalBytes += bytes.length;
  manifest.update(JSON.stringify([path, digest]) + "\n");
}

// Probe the existing Forma boundary independently of the two planned file readers.
const symbol = String.fromCodePoint(0x100ec3);
const probeText = "键" + symbol + "e\u0301/👩🏽‍💻/مرحبا";
const layer = {
  ...createNode("text"),
  id: "text",
  text: probeText,
  textRuns: [{ start: 1, end: 3, style: { fontWeight: 700 } }],
};
const design = {
  schemaVersion: 1,
  id: "probe",
  name: "导入探针",
  revision: 0,
  tokens: {},
  nodes: [layer],
};
const parsed = parseDocument(JSON.parse(JSON.stringify(design)));
assert.equal(parsed.nodes[0].text, probeText);
assert.equal(
  textParts(parsed.nodes[0]).find((part) => part.style.fontWeight === 700)
    ?.text,
  symbol,
);
const extra = parseDocument({
  ...design,
  nodes: [{ ...layer, externalSourceId: "42:7" }],
});
assert.equal(Object.hasOwn(extra.nodes[0], "externalSourceId"), false);
const noParent = { ...design, nodes: [{ ...layer, parentId: "missing" }] };
assert.throws(() => parseDocument(noParent));
const tooMany = {
  ...design,
  nodes: Array.from({ length: 10_001 }, (_, i) => ({
    ...layer,
    id: String(i),
  })),
};
assert.throws(() => parseDocument(tooMany));
console.log(
  JSON.stringify(
    {
      byExtension,
      totalBytes,
      distinctContentHashes: hashes.size,
      privateUsePaths,
      manifestSha256: manifest.digest("hex"),
      nativeDocumentChecks: {
        unicodeAndUtf16RangeRoundTrip: true,
        undeclaredSourceIdStripped: true,
        missingParentRejected: true,
        pageWith10001NodesRejected: true,
      },
    },
    null,
    2,
  ),
);
