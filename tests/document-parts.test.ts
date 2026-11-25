import assert from "node:assert/strict";
import test from "node:test";
import { assetByteLength } from "../src/domain/asset-bytes";
import {
  cloneDocument,
  createNode,
  parseDocument,
  type DesignDocument,
} from "../src/domain/document";
import { createLibraryFromSelection } from "../src/domain/library";
import { importImageBytes } from "../src/infrastructure/design-import/image";
import {
  splitDocument,
  useLargeDocumentFormat,
} from "../src/infrastructure/document-parts";
import {
  nativeDocumentBlob,
  nativeDocumentText,
  readNativeDocument,
} from "../src/infrastructure/native-document";
import {
  BrowserDocumentRepository,
  deleteLocalFile,
  renameLocalFile,
  download,
} from "../src/infrastructure/storage";
import {
  partStore,
  assetStore,
  type StoredSnapshot,
} from "../src/infrastructure/storage-parts";

async function fixture() {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+C9asAAAAASUVORK5CYII=",
    "base64",
  );
  const { id, image } = await importImageBytes(bytes, "像素");
  const n = createNode("rectangle");
  n.image = { assetId: id, fit: "fill", x: 0.5, y: 0.5, zoom: 1 };
  const d: DesignDocument = {
    schemaVersion: 1,
    id: "sample",
    name: "测试",
    revision: 3,
    tokens: {},
    images: { [id]: image },
    nodes: [n],
    pages: [
      { id: "one", name: "画布" },
      { id: "two", name: "第二页", nodes: [createNode("text")] },
    ],
    activePage: "one",
    importReport: {
      version: 1,
      format: "Sketch",
      filename: "样例.sketch",
      sha256: "a".repeat(64),
      sourceNodes: 2,
      issues: [{ node: "来源", detail: "保留文本" }],
    },
  };
  const library = createLibraryFromSelection(d, n.id, "组件");
  library.images![id] = { ...image, name: "库副本" };
  d.libraries = { [library.id]: library };
  return {
    id,
    doc: parseDocument(JSON.parse(JSON.stringify(d))),
    length: bytes.length,
  };
}
function records(doc: DesignDocument) {
  const split = splitDocument(doc);
  return [
    ...split.parts(),
    ...Array.from(split.assets, ([id, data]) => ({
      kind: "asset",
      id,
      size: data.length,
      offset: 0,
      data,
    })),
    { kind: "end" },
  ];
}
function native(rows: unknown[], pretty = false) {
  const file = { format: "forma/design-parts", version: 1, records: rows };
  if (pretty) return new Blob([JSON.stringify(file, null, 2)]);
  const prefix = '{"format":"forma/design-parts","version":1,"records":[\n';
  return new Blob([
    prefix,
    rows.map((r) => JSON.stringify(r)).join(",\n"),
    "]}\n",
  ]);
}
test("native document preserves legacy files and deduplicates file/library resources on partitioned reopen", async () => {
  const { id, doc, length } = await fixture();
  const source = doc.images![id];
  assert.equal(assetByteLength(source.data), length);
  assert.equal(useLargeDocumentFormat(doc), false);
  assert.equal(nativeDocumentText(doc), JSON.stringify(doc, null, 2));
  assert.deepEqual(await readNativeDocument(nativeDocumentBlob(doc)), doc);
  const rows = records(doc);
  assert.equal(rows.filter((r) => r.kind === "asset").length, 1);
  const head = Array.from(splitDocument(doc).parts())[0];
  assert.ok(head?.kind === "header");
  assert.equal(head.document.images![id].data, "@" + id);
  assert.equal(head.document.importReport!.issues.length, 0);
  assert.equal(
    Object.values(head.document.libraries!)[0].images![id].data,
    "@" + id,
  );
  for (const pretty of [false, true])
    assert.deepEqual(await readNativeDocument(native(rows, pretty)), doc);
  const copy = cloneDocument(doc);
  Object.values(copy.libraries!)[0].images![id].name = "已修改";
  assert.equal(Object.values(doc.libraries!)[0].images![id].name, "库副本");
});
test("partitioned reader rejects damaged, missing or out-of-order resources and declared dimensions", async () => {
  const { doc } = await fixture(),
    rows = records(doc);
  const i = rows.findIndex((r) => r.kind === "asset");
  const data = rows[i] as {
    id: string;
    data: string;
    offset: number;
    size: number;
  };
  const replaced = (values: object[]) => [
    ...rows.slice(0, i),
    ...values,
    ...rows.slice(i + 1),
  ];
  await assert.rejects(readNativeDocument(native(replaced([]))), /缺少资源/);
  await assert.rejects(
    readNativeDocument(native(replaced([{ ...data, offset: 1 }]))),
    /顺序/,
  );
  const wrong = data.data.replace("AAAA", "BAAA");
  await assert.rejects(
    readNativeDocument(native(replaced([{ ...data, data: wrong }]))),
    /内容与标识/,
  );
  const partial = await native(rows).text();
  await assert.rejects(
    readNativeDocument(new Blob([partial.slice(0, -17)])),
    /未完成|截断/,
  );
  const meta = structuredClone(rows);
  const hdr = meta[0] as { document: DesignDocument };
  Object.values(hdr.document.images!)[0].width = 2;
  await assert.rejects(readNativeDocument(native(meta)), /像素尺寸/);
});

test("partition selection includes inactive pages, library payloads, assets and diagnostics", async () => {
  const { doc, id } = await fixture();
  const limit = 16 * 1024 * 1024;
  const library = Object.values(doc.libraries!)[0];
  const v = library.components[0].variants[0];
  const n = v.nodes[0];
  for (const patch of [
    { sourceTextShape: { d: "a".repeat(limit) } },
    { vector: { paths: [{ d: "a".repeat(limit) }] } },
    { sourceTextLayout: { lines: [{ text: "a".repeat(limit), x: [] }] } },
  ]) {
    v.nodes = [{ ...n, ...patch } as typeof n];
    assert.ok(useLargeDocumentFormat(doc));
  }
  v.nodes = [n];
  doc.images![id].data = "a".repeat(limit);
  assert.ok(useLargeDocumentFormat(doc));
  doc.images![id].data = library.images![id].data;
  doc.pages![1].nodes = Array(10001).fill(n);
  assert.ok(useLargeDocumentFormat(doc));
  doc.pages![1].nodes = [];
  doc.importReport!.issues = Array(2001).fill({ node: "a", detail: "b" });
  assert.ok(useLargeDocumentFormat(doc));
});

test("both native readers report malformed records and collection targets in Chinese", async () => {
  const { doc } = await fixture();
  for (const pretty of [true, false]) {
    for (const invalid of [null, 1, "row"]) {
      await assert.rejects(
        readNativeDocument(native([invalid, { kind: "end" }], pretty)),
        /分块文件/,
      );
    }
    const header = [...splitDocument(doc).parts()][0];
    assert.ok(header.kind === "header");
    const library = Object.keys(doc.libraries!)[0];
    for (const parts of [
      [header, { kind: "component", library, component: {} }],
      [header, { kind: "component", library, component: { variants: [null] } }],
      [header, { kind: "issues" }],
      [
        {
          kind: "header",
          document: { ...header.document, libraries: { [library]: {} } },
        },
      ],
      [{ kind: "header", document: { ...header.document, importReport: {} } }],
      [{ kind: "header", document: { ...header.document, pages: [null] } }],
    ])
      await assert.rejects(
        readNativeDocument(native([...parts, { kind: "end" }], pretty)),
        /分块文件/,
      );
  }
});

// Deliver IDB request, cursor and transaction events independently, including an
// abort with no request error. No browser globals are required by the test runner.
test("repository saves two generations, reuses verified assets on rename, recovers either generation, and rejects quota and delete aborts", async (t) => {
  const { doc, id } = await fixture();
  doc.importReport!.issues = Array(2001).fill({ node: "a", detail: "b" });
  type RecordValue = {
    generation: number;
    current: StoredSnapshot;
    previous?: StoredSnapshot;
  };
  const tables = new Map<string, Map<string, unknown>>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  function request<T>(result: T) {
    const req = { result, onsuccess: () => {} };
    queueMicrotask(() => req.onsuccess());
    return req;
  }
  let abort: DOMException | undefined;
  const db = {
    transaction(_stores: unknown, mode?: string) {
      const tx = {
        error: abort,
        onabort: () => {},
        oncomplete: () => {},
        abort: () => {},
        objectStore(name: string) {
          const data = table(name);
          return {
            getAll: () => request([]),
            get: (key: unknown) =>
              request(structuredClone(data.get(JSON.stringify(key)))),
            put: (value: unknown, key: unknown) => {
              if (!abort) data.set(JSON.stringify(key), structuredClone(value));
              return request(key);
            },
            delete: () => request(undefined),
            openCursor: ({ lower }: { lower: [string, number] }) => {
              const entries = [...data.entries()]
                .filter(([key]) => {
                  const [file, generation] = JSON.parse(key);
                  return file === lower[0] && generation === lower[1];
                })
                .sort(([a], [b]) => JSON.parse(a)[2] - JSON.parse(b)[2]);
              const cursor: { result: unknown; onsuccess: () => void } = {
                result: null,
                onsuccess: () => {},
              };
              function visit() {
                const next = entries.shift();
                cursor.result = next && {
                  key: JSON.parse(next[0]),
                  value: structuredClone(next[1]),
                  continue: () => queueMicrotask(visit),
                };
                cursor.onsuccess();
              }
              queueMicrotask(visit);
              return cursor;
            },
          };
        },
      };
      if (mode === "readwrite")
        setImmediate(() => (abort ? tx.onabort() : tx.oncomplete()));
      return tx;
    },
  };
  const globals = {
    indexedDB: { open: () => request(db) },
    IDBKeyRange: { bound: (lower: unknown) => ({ lower }) },
  };
  for (const [key, value] of Object.entries(globals)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      old
        ? Object.defineProperty(globalThis, key, old)
        : Reflect.deleteProperty(globalThis, key),
    );
  }
  const repo = new BrowserDocumentRepository("file");
  const hash = t.mock.method(crypto.subtle, "digest");
  await repo.save(doc);
  assert.equal(hash.mock.callCount(), 1);
  await renameLocalFile("file", "新名");
  assert.equal(hash.mock.callCount(), 1);
  const loaded = new BrowserDocumentRepository("file");
  const restored = await loaded.load();
  assert.equal(restored!.name, "新名");
  restored!.images![id].width++;
  await assert.rejects(loaded.save(restored!), /像素尺寸/);
  restored!.images![id].width--;
  const record = table("documents").get('"file"') as RecordValue;
  assert.ok(
    "format" in record.current &&
      record.previous &&
      "format" in record.previous,
  );
  assert.equal(table(assetStore).size, 1);
  for (const which of ["current", "previous"] as const) {
    const generation = which === "current" ? 2 : 1;
    const key = JSON.stringify(["file", generation, 0]);
    const chunks = table(partStore);
    const original = chunks.get(key);
    chunks.delete(key);
    const backup = JSON.parse(await ((await loaded.backup()) as Blob).text());
    assert.match(backup[which + "Error"], /分片/);
    assert.ok(
      backup[which === "current" ? "previous" : "current"],
      JSON.stringify([backup.currentError, backup.previousError]),
    );
    const good = backup[which === "current" ? "previous" : "current"];
    assert.equal(
      (await readNativeDocument(new Blob([JSON.stringify(good)]))).name,
      which === "current" ? doc.name : "新名",
    );
    chunks.set(key, original);
  }
  abort = new DOMException("full", "QuotaExceededError");
  await assert.rejects(
    loaded.save(restored!),
    /浏览器本地存储空间不足，请先清理旧设计文件或下载本地副本后重试。/,
  );
  abort = new DOMException("delete cancelled", "AbortError");
  await assert.rejects(deleteLocalFile("file"), { name: "AbortError" });
});

test("download retains its blob URL for sixty seconds", (t) => {
  let clicked = false;
  const old = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        click: () => {
          clicked = true;
        },
      }),
    },
  });
  t.after(() =>
    old
      ? Object.defineProperty(globalThis, "document", old)
      : Reflect.deleteProperty(globalThis, "document"),
  );
  const revoke = t.mock.method(URL, "revokeObjectURL");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  download("large.forma.json", new Blob(["large"]));
  assert.ok(clicked);
  t.mock.timers.tick(59_999);
  assert.equal(revoke.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(revoke.mock.callCount(), 1);
});
