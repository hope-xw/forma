import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  readFile,
  mkdtemp,
  writeFile,
  rm,
  open,
  realpath,
  glob,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FontAssets } from "../src/editor/FontAssets";
import {
  PopoverDocumentSessionContext,
  PopoverSurfaceContext,
} from "../src/editor/useAnchoredPopover";
import type { EditorController } from "../src/editor/useEditor";
import { zlibSync } from "fflate";
import paper from "paper";
import svgpath from "svgpath";
import { commit, type History } from "../src/application/history";
import { transact } from "../src/domain/commands";
import { parseDocument } from "../src/domain/document";
import {
  createOutlinedVectorFromTextOperations,
  normalizedGlyphPath,
  outlineTextFromShapeOperations,
} from "../src/domain/vector-outline";
import {
  parseFontFamilies,
  listSystemFontFamilies,
  resolveSystemFonts,
} from "../electron/system-fonts.mjs";
import { decodeBase64, maxAssetBytes } from "../src/domain/asset-bytes";
import { createStarter } from "../src/domain/seed";
import { readContours } from "../src/domain/vector-path";
import {
  decodeFormaPackage,
  encodeFormaPackage,
} from "../src/infrastructure/forma-package";
import {
  decodeWoff1,
  extractTtcFace,
  importFontBytes,
  listTtcFaces,
  normalizeFontBytes,
  readFont,
  inspectFontBytes,
  retainDocumentFonts,
  releaseDocumentFonts,
  loadFonts,
} from "../src/infrastructure/font-import";
import { textLayoutStyleKey } from "../src/domain/text-shape";
import { outlineTextNode } from "../src/infrastructure/text-outline";

const fixture = await readFile(
  new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
);
const compress = createRequire(import.meta.url)("wawoff2/compress.js") as (
  bytes: Uint8Array,
) => Promise<Uint8Array>;
const padding = (n: number) => Math.ceil(n / 4) * 4;
function tables(font: Buffer) {
  return Array.from({ length: font.readUInt16BE(4) }, (_, i) => {
    const at = 12 + 16 * i,
      offset = font.readUInt32BE(at + 8),
      length = font.readUInt32BE(at + 12);
    return {
      at,
      tag: font.toString("latin1", at, at + 4),
      data: font.subarray(offset, offset + length),
      offset,
      length,
    };
  });
}
function sum(data: Buffer) {
  const padded = Buffer.alloc(padding(data.length));
  data.copy(padded);
  let result = 0;
  for (let i = 0; i < padded.length; i += 4)
    result = (result + padded.readUInt32BE(i)) >>> 0;
  return result;
}
function checkSfnt(bytes: Uint8Array) {
  const font = Buffer.from(bytes),
    records = tables(font),
    count = records.length,
    exp = Math.floor(Math.log2(count));
  assert.ok([0x10000, 0x4f54544f].includes(font.readUInt32BE(0)));
  assert.deepEqual(
    [font.readUInt16BE(6), font.readUInt16BE(8), font.readUInt16BE(10)],
    [16 * 2 ** exp, exp, 16 * count - 16 * 2 ** exp],
  );
  assert.equal(sum(font), 0xb1b0afba);
  for (const { at, tag, data, offset, length } of records) {
    assert.equal(offset % 4, 0);
    assert.ok(offset + length <= font.length);
    const copy = Buffer.from(data);
    if (tag === "head") copy.writeUInt32BE(0, 8);
    assert.equal(sum(copy), font.readUInt32BE(at + 4), tag + " checksum");
  }
}
function makeTtc(faces: Buffer[]) {
  const header = Buffer.alloc(12 + faces.length * 4);
  header.write("ttcf");
  header.writeUInt32BE(0x10000, 4);
  header.writeUInt32BE(faces.length, 8);
  let offset = header.length;
  return Buffer.concat([
    header,
    ...faces.map((face, i) => {
      const buf = Buffer.from(face);
      for (const t of tables(buf))
        buf.writeUInt32BE(t.offset + offset, t.at + 8);
      header.writeUInt32BE(offset, 12 + i * 4);
      offset += buf.length;
      return buf;
    }),
  ]);
}
function makeWoff1() {
  const records = tables(fixture),
    header = Buffer.alloc(44 + 20 * records.length);
  header.write("wOFF");
  header.writeUInt32BE(0x10000, 4);
  header.writeUInt16BE(records.length, 12);
  header.writeUInt32BE(
    records.reduce((s, t) => s + padding(t.length), 12 + 16 * records.length),
    16,
  );
  let offset = header.length;
  const parts = records.map(({ at, tag, data, length }, i) => {
    const compressed = zlibSync(data);
    const stored = compressed.length < length ? compressed : data;
    const pos = 44 + 20 * i;
    header.write(tag, pos, "latin1");
    header.writeUInt32BE(offset, pos + 4);
    header.writeUInt32BE(stored.length, pos + 8);
    header.writeUInt32BE(length, pos + 12);
    header.writeUInt32BE(fixture.readUInt32BE(at + 4), pos + 16);
    const part = Buffer.alloc(padding(stored.length));
    part.set(stored);
    offset += part.length;
    return part;
  });
  header.writeUInt32BE(offset, 8);
  return Buffer.concat([header, ...parts]);
}
function scene(text: string) {
  const doc = createStarter(),
    n = doc.nodes[1];
  n.text = text;
  return { doc, n };
}
function artwork(result: Awaited<ReturnType<typeof outlineTextNode>>) {
  const op = result.operations.find((op) => op.type === "convertToVector");
  assert.ok(op && op.vector.paths[0].d);
  return op.vector.paths[0].d;
}
function resolver(
  data: Uint8Array,
): (r: SystemFontRequest) => Promise<SystemFontFace[]> {
  return async () => [
    { family: "Forma Fixture", format: "ttf", faceIndex: 0, data },
  ];
}
const req: SystemFontRequest = {
  fontFamily: "system-ui, sans-serif",
  fontWeight: 400,
  fontStyle: "normal",
  text: "Forma",
};

test("TTC directory offsets, checksums and regular/italic face selection", async () => {
  const italic = Buffer.from(fixture),
    os2 = tables(italic).find((t) => t.tag === "OS/2")!.data;
  os2.writeUInt16BE(700, 4);
  os2.writeUInt16BE(1, 62);
  const ttc = makeTtc([italic, fixture]);
  assert.deepEqual(
    listTtcFaces(ttc).map((f) => [f.weight, f.italic]),
    [
      [700, true],
      [400, false],
    ],
  );
  assert.ok(listTtcFaces(ttc)[0].family);
  assert.equal((await normalizeFontBytes(ttc)).faceIndex, 1);
  assert.equal(
    (await normalizeFontBytes(ttc, { italic: true, weight: 700 })).faceIndex,
    0,
  );
  const second = await normalizeFontBytes(ttc, { faceIndex: 1 });
  checkSfnt(second.bytes);
  assert.deepEqual(second.bytes, extractTtcFace(ttc, 1));
  assert.throws(() => extractTtcFace(ttc, 2), /索引/);
  const broken = Buffer.from(ttc);
  broken.writeUInt32BE(0xffffffff, ttc.readUInt32BE(12) + 20);
  assert.throws(() => extractTtcFace(broken), /表长度/);
});
test("Apple true signature normalizes to a standalone TrueType file", async () => {
  const apple = Buffer.from(fixture);
  apple.write("true");
  const result = await normalizeFontBytes(apple);
  assert.equal(result.format, "ttf");
  checkSfnt(result.bytes);
});
test("WOFF1 compressed tables reproduce checksums and WOFF2 decompresses offline", async () => {
  const woff = makeWoff1(),
    woff2 = await compress(fixture);
  assert.ok(woff.length < fixture.length);
  for (const [name, bytes] of [
    ["Fixture.woff", woff],
    ["Fixture.woff2", woff2],
  ] as const) {
    const normalized = await normalizeFontBytes(bytes);
    checkSfnt(normalized.bytes);
    const { id, asset } = await importFontBytes(bytes, name);
    assert.equal(asset.name, "Fixture");
    assert.ok(asset.data.startsWith("data:font/ttf;base64,"));
    const { doc, n } = scene("AB");
    doc.fonts = { [id]: asset };
    n.style.fontFamily = id;
    const reopened = await decodeFormaPackage(encodeFormaPackage(doc));
    assert.equal(reopened.fonts![id].data, asset.data);
    assert.equal(
      readContours(artwork(await outlineTextNode(reopened, n.id))).length,
      2,
    );
  }
});
test("WOFF decoders reject oversized output, inconsistent sizes and truncation", async () => {
  const woff = makeWoff1();
  woff.writeUInt32BE(maxAssetBytes + 1, 16);
  assert.throws(() => decodeWoff1(woff), /32 MiB/);
  woff.writeUInt32BE(12, 16);
  assert.throws(() => decodeWoff1(woff), /解压长度/);
  const woff2 = Buffer.from(await compress(fixture));
  woff2.writeUInt32BE(maxAssetBytes + 1, 16);
  await assert.rejects(normalizeFontBytes(woff2), /32 MiB/);
  await assert.rejects(normalizeFontBytes(woff2.subarray(0, 48)), /文件头/);
});
test("readFont installs the normalized SFNT matching the archived asset ID", async (t) => {
  let installed: ArrayBuffer | undefined;
  class Face {
    constructor(_id: string, data: ArrayBuffer) {
      installed = data;
    }
    async load() {
      return this;
    }
  }
  const oldFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace"),
    oldDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "FontFace", {
    configurable: true,
    value: Face,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { fonts: { add() {}, delete() {} } },
  });
  t.after(() => {
    if (oldFace) Object.defineProperty(globalThis, "FontFace", oldFace);
    else Reflect.deleteProperty(globalThis, "FontFace");
    if (oldDoc) Object.defineProperty(globalThis, "document", oldDoc);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const file = new File([new Uint8Array(makeWoff1())], "WebFont.woff");
  const { asset, id } = await readFont(file);
  await retainDocumentFonts("read-font-test", { [id]: asset });
  releaseDocumentFonts("read-font-test");
  assert.ok(installed);
  assert.deepEqual(new Uint8Array(installed), decodeBase64(asset.data));
  checkSfnt(new Uint8Array(installed));
});
test("complete embedded coverage skips the resolver even for transformed text", async () => {
  const { doc, n } = scene("ab🙂");
  const { id, asset } = await importFontBytes(fixture, "Local.ttf");
  n.style.fontFamily = id;
  n.style.textTransform = "uppercase";
  doc.fonts = { [id]: asset };
  assert.equal(
    readContours(
      artwork(
        await outlineTextNode(doc, n.id, {
          resolveSystemFonts: async () =>
            assert.fail("unnecessary font access"),
        }),
      ),
    ).length,
    3,
  );
});
test("legacy embedded WOFF1 and WOFF2 are normalized before HarfBuzz shaping", async () => {
  for (const [ext, data] of [
    ["woff", makeWoff1()],
    ["woff2", await compress(fixture)],
  ] as const) {
    const { doc, n } = scene("AB");
    n.style.fontFamily = "Fixture";
    doc.fonts = {
      fixture: {
        name: "Fixture",
        axes: [],
        data:
          "data:font/" +
          ext +
          ";base64," +
          Buffer.from(data).toString("base64"),
      },
    };
    assert.equal(
      readContours(artwork(await outlineTextNode(doc, n.id))).length,
      2,
    );
  }
});
test("fallback runs preserve distinct glyph advances, supplementary clusters and wrapping", async () => {
  // Remap U+0041..42 to U+8BBE..BF in the fixture's format 4 and 12 tables.
  // Give the second face twice the units per em and store it at TTC index 1.
  const cjk = Buffer.from(fixture);
  const cmap = tables(cjk).find((t) => t.tag === "cmap")!.data;
  const bmp = cmap.readUInt32BE(8),
    full = cmap.readUInt32BE(24);
  // Keep format 4 segments and format 12 groups sorted (combining acute precedes Han).
  cmap.writeUInt16BE(0x0301, bmp + 16);
  cmap.writeUInt16BE(0x8bbf, bmp + 18);
  cmap.writeUInt16BE(0x0301, bmp + 26);
  cmap.writeUInt16BE(0x8bbe, bmp + 28);
  cmap.writeUInt16BE((3 - 0x301) & 65535, bmp + 34);
  cmap.writeUInt16BE((2 - 0x8bbe) & 65535, bmp + 36);
  cmap.writeUInt32BE(0x301, full + 28);
  cmap.writeUInt32BE(0x301, full + 32);
  cmap.writeUInt32BE(3, full + 36);
  cmap.writeUInt32BE(0x8bbe, full + 40);
  cmap.writeUInt32BE(0x8bbf, full + 44);
  cmap.writeUInt32BE(2, full + 48);
  tables(cjk)
    .find((t) => t.tag === "head")!
    .data.writeUInt16BE(2000, 18);
  const { doc, n } = scene("A设🙂B");
  const { id, asset } = await importFontBytes(fixture, "Latin.ttf");
  doc.fonts = { [id]: asset };
  Object.assign(n.style, {
    fontFamily: id,
    fontSize: 10,
    lineHeight: 12,
    width: 100,
    widthMode: "fixed",
  });
  const seen: string[] = [];
  const options = {
    resolveSystemFonts: async (
      r: SystemFontRequest,
    ): Promise<SystemFontFace[]> => {
      seen.push(r.text);
      return [
        {
          family: "Han",
          format: "ttc",
          faceIndex: 1,
          data: makeTtc([fixture, cjk]),
        },
      ];
    },
  };
  const shapes = readContours(
    artwork(await outlineTextNode(doc, n.id, options)),
  );
  assert.equal(seen[0], "设");
  assert.deepEqual(
    shapes.map((c) => c.anchors[0].x),
    [0, 6, 9, 15],
  );
  n.style.width = 9;
  const wrapped = readContours(
    artwork(await outlineTextNode(doc, n.id, options)),
  );
  assert.equal(wrapped.length, 4);
  assert.ok(wrapped.at(-1)!.anchors[0].y > wrapped[0].anchors[0].y);
});
test("unavailable glyph error identifies the family and every distinct missing character", async () => {
  const { doc, n } = scene("设计设");
  n.style.fontFamily = "Example";
  const before = JSON.stringify(doc);
  await assert.rejects(
    outlineTextNode(doc, n.id, { resolveSystemFonts: resolver(fixture) }),
    /Example.*设.*计/,
  );
  assert.equal(JSON.stringify(doc), before);
});
test("system resolver rejects invalid parameters before font discovery", async () => {
  for (const invalid of [
    { fontFamily: "a".repeat(513) },
    { fontWeight: 0 },
    { fontWeight: 1001 },
    { fontStyle: "oblique" },
    { text: "x".repeat(50001) },
    { maxFaces: 7 },
  ]) {
    await assert.rejects(
      resolveSystemFonts({ ...req, ...invalid } as SystemFontRequest),
      /请求参数/,
    );
  }
  assert.deepEqual(await resolveSystemFonts({ ...req, text: " \t\n" }), []);
});

test(
  "real macOS Helvetica TTC imports a matching face with standalone checksums",
  { skip: process.platform !== "darwin" },
  async () => {
    const collection = await readFile("/System/Library/Fonts/Helvetica.ttc");
    const faces = listTtcFaces(collection);
    assert.ok(faces.length > 1);
    const normalized = await normalizeFontBytes(collection, {
      weight: 700,
      italic: true,
    });
    assert.equal(faces[normalized.faceIndex].italic, true);
    checkSfnt(normalized.bytes);
    const asset = await importFontBytes(collection, "Helvetica.ttc");
    assert.equal(asset.asset.name, "Helvetica");
    assert.notEqual(asset.asset.italic, true);
  },
);
for (const text of ["让好设计，发生。", "Forma 让好设计 2026"]) {
  test(
    "real macOS system-ui outlines " + text,
    { skip: process.platform !== "darwin" },
    async (t) => {
      const { doc, n } = scene(text);
      const hb = await import("harfbuzzjs");
      const families = await listSystemFontFamilies();
      assert.deepEqual(
        [...new Set(families)].sort((a, b) => a.localeCompare(b)),
        families,
      );
      assert.ok(families.includes("Helvetica"));
      const used: string[] = [];
      const result = await outlineTextNode(doc, n.id, {
        resolveSystemFonts: async (request) => {
          assert.equal(request.fontFamily, "system-ui, sans-serif");
          const faces = await resolveSystemFonts(request);
          assert.ok(faces.length && faces.length <= 6);
          const fonts = faces.map((f) => {
            used.push(f.family);
            const data =
              typeof f.data === "string"
                ? Buffer.from(f.data, "base64")
                : f.data;
            assert.ok(data.length <= 64 * 1024 * 1024);
            return new hb.Font(new hb.Face(new hb.Blob(data), f.faceIndex));
          });
          const missing = [...new Set(text)].filter(
            (c) =>
              c.trim() && !fonts.some((f) => f.nominalGlyph(c.codePointAt(0)!)),
          );
          assert.deepEqual(missing, []);
          return faces;
        },
      });
      const contours = readContours(artwork(result));
      assert.ok(contours.length >= text.trim().replaceAll(" ", "").length);
      t.diagnostic(
        used.join(" + ") +
          "; " +
          contours.length +
          " contours, 0 missing glyphs",
      );
    },
  );
}

test("browser resolver uses desktop first, then same-origin loopback, then Local Font Access", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const { doc, n } = scene("AB");
  const events: string[] = [];
  const faces = await resolver(fixture)(req);
  const win = {
    location: { hostname: "localhost" },
    formaDesktop: {
      resolveSystemFonts: async () => {
        events.push("desktop");
        return faces;
      },
    } as { resolveSystemFonts: () => Promise<SystemFontFace[]> } | undefined,
    fetch: async (url: string, init: RequestInit) => {
      events.push("loopback");
      assert.equal(url, "/api/system-fonts/resolve");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      return {
        ok: true,
        json: async () => ({
          faces: faces.map((f) => ({ ...f, data: fixture.toString("base64") })),
        }),
      };
    },
    queryLocalFonts: async () => {
      events.push("browser");
      return [
        {
          family: "SF Pro",
          fullName: "SF Pro",
          postscriptName: "SFPro",
          style: "Italic",
          blob: async () => {
            throw Error("unexpected italic face");
          },
        },
        {
          family: "SF Pro",
          fullName: "SF Pro",
          postscriptName: "SFPro",
          style: "Regular",
          blob: async () => {
            events.push("regular");
            return new Blob([new Uint8Array(fixture)]);
          },
        },
      ];
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: win,
  });
  for (const [host, expected] of [
    ["localhost", ["desktop"]],
    ["127.0.0.1", ["loopback"]],
    ["localhost", ["loopback"]],
    ["[::1]", ["loopback"]],
    ["::1", ["loopback"]],
    ["design.example", ["browser", "regular"]],
  ] as const) {
    win.location.hostname = host;
    events.length = 0;
    assert.ok(artwork(await outlineTextNode(doc, n.id)));
    assert.deepEqual(events, expected);
    if (expected[0] === "desktop") win.formaDesktop = undefined;
  }
});
test("Vite font middleware enforces exact route, peer, host, origin, method and streamed JSON budget", async () => {
  const { localFontRequest } = await import("../vite.config");
  const { IncomingMessage, ServerResponse } = await import("node:http");
  const { Socket } = await import("node:net");
  const held: (() => void)[] = [];
  async function send(
    options: {
      path?: string;
      ip?: string;
      host?: string;
      origin?: string;
      method?: string;
      type?: string;
      body?: string;
      hold?: boolean;
    } = {},
  ) {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", {
      value: options.ip ?? "127.0.0.1",
    });
    const request = new IncomingMessage(socket);
    request.url = options.path ?? "/api/system-fonts/resolve";
    request.method = options.method ?? "POST";
    request.headers = {
      host: options.host ?? "localhost:5173",
      origin: options.origin,
      "content-type": options.type ?? "application/json",
    };
    const bytes = Buffer.from(
      options.body ?? JSON.stringify({ ...req, text: " " }),
    );
    for (let start = 0; start < bytes.length; start += 32768)
      request.push(bytes.subarray(start, start + 32768));
    request.push(null);
    const response = new ServerResponse(request);
    let next = false;
    await localFontRequest(request, response, () => {
      next = true;
    });
    const close = () => {
      response.emit("close");
      socket.destroy();
    };
    if (options.hold) held.push(close);
    else close();
    return next ? null : response.statusCode;
  }
  assert.equal(await send({ path: "/" }), null);
  assert.equal(await send({ path: "/api/system-fonts/resolve-extra" }), null);
  assert.equal(await send({ ip: "192.0.2.1" }), 403);
  assert.equal(await send({ host: "example.org" }), 403);
  assert.equal(await send({ origin: "https://example.org" }), 403);
  assert.equal(await send({ method: "GET" }), 405);
  assert.equal(await send({ type: "text/plain" }), 415);
  assert.equal(await send({ body: "x".repeat(128 * 1024 + 1) }), 413);
  assert.equal(await send({ body: "{bad" }), 400);
  assert.equal(await send({ body: "{}" }), 400);
  assert.equal(await send(), 200);
  assert.equal(
    await send({ host: "[::1]:5173", ip: "::1", origin: "http://[::1]:5173" }),
    200,
  );
  assert.equal(await send({ hold: true }), 200);
  assert.equal(await send({ hold: true }), 200);
  assert.equal(await send(), 429);
  held.forEach((close) => close());
  assert.equal(await send(), 200);
});

// The upstream decoder's CommonJS binding exports Module only when process
// exists. Exercise the shipped browser branch: a Node-only decode misses the
// resulting never-settling onRuntimeInitialized promise.
test(
  "Vite browser WOFF2 binding initializes and decodes using only its embedded WASM",
  { timeout: 10000 },
  async () => {
    const { build } = await import("vite"),
      { default: config } = await import("../vite.config");
    const { runInNewContext } = await import("node:vm");
    const output = await build({
      configFile: false,
      plugins: config.plugins,
      logLevel: "silent",
      publicDir: false,
      build: {
        write: false,
        minify: false,
        lib: {
          entry: createRequire(import.meta.url).resolve(
            "wawoff2/decompress.js",
          ),
          name: "woff2Decode",
          formats: ["iife"],
        },
      },
    });
    const bundle = Array.isArray(output) ? output[0] : output;
    assert.ok("output" in bundle);
    const chunk = bundle.output.find((entry) => entry.type === "chunk");
    assert.ok(chunk);
    const data = await compress(fixture);
    const bytes = (await runInNewContext(
      chunk.code + "\nwoff2Decode(Uint8Array.from(input))",
      {
        window: {},
        atob,
        console,
        TextDecoder,
        TextEncoder,
        input: [...data],
        fetch: (url: string) => {
          assert.ok(url.startsWith("data:application/octet-stream;base64,"));
          return fetch(url);
        },
      },
    )) as Uint8Array;
    checkSfnt(bytes);
  },
);

function emojiFixture() {
  const bytes = Buffer.from(fixture);
  const cmap = tables(bytes).find((t) => t.tag === "cmap")!.data;
  const group = cmap.readUInt32BE(24) + 16 + 3 * 12;
  cmap.writeUInt32BE(0x1f600, group);
  cmap.writeUInt32BE(0x1f600, group + 4);
  return bytes;
}

test("a nominal emoji with empty or collinear contours retries the remaining faces or preserves the text", async () => {
  const { doc, n } = scene("A😀B");
  const embedded = await importFontBytes(fixture, "Latin.ttf");
  doc.fonts = { [embedded.id]: embedded.asset };
  n.style.fontFamily = embedded.id;
  const before = JSON.stringify(doc);
  for (const empty of [true, false]) {
    const stub = emojiFixture();
    if (empty) {
      const cmap = tables(stub).find((t) => t.tag === "cmap")!.data;
      cmap.writeUInt32BE(1, cmap.readUInt32BE(24) + 16 + 3 * 12 + 8);
    } else {
      const glyf = tables(stub).find((t) => t.tag === "glyf")!.data;
      glyf.fill(0, 20, 24); // Fixture triangle with all Y coordinates zero.
    }
    const bitmap = {
      family: "Bitmap",
      format: "ttf" as const,
      data: stub,
      faceIndex: 0,
    };
    await assert.rejects(
      outlineTextNode(doc, n.id, { resolveSystemFonts: async () => [bitmap] }),
      /矢量轮廓.*😀.*位图/,
    );
    assert.equal(JSON.stringify(doc), before);
    const d = artwork(
      await outlineTextNode(doc, n.id, {
        resolveSystemFonts: async () => [
          bitmap,
          { ...bitmap, family: "Vector", data: emojiFixture() },
        ],
      }),
    );
    assert.equal(readContours(d).length, 3);
  }
});

test("raw SFNT directories reject zero, excessive or duplicate records before metadata inspection", () => {
  for (const count of [0, 129]) {
    const font = Buffer.alloc(12 + count * 16);
    font.writeUInt32BE(0x10000);
    font.writeUInt16BE(count, 4);
    assert.throws(() => inspectFontBytes(font), /目录/);
  }
  const font = Buffer.from(fixture);
  font.write("GSUB", 12);
  font.writeUInt32BE(0, 24);
  font.write("GSUB", 28);
  assert.throws(() => inspectFontBytes(font), /重复表/);
});

test("TTC repeated directory offsets share metadata and distinct directories exhaust the cumulative budget", () => {
  const count = 3000;
  const shared = Buffer.alloc(12 + 4 * count + fixture.length);
  shared.write("ttcf");
  shared.writeUInt32BE(count, 8);
  const offset = 12 + 4 * count;
  for (let i = 0; i < count; i++) shared.writeUInt32BE(offset, 12 + i * 4);
  fixture.copy(shared, offset);
  for (const t of tables(fixture))
    shared.writeUInt32BE(offset + t.offset, offset + t.at + 8);
  const faces = listTtcFaces(shared);
  assert.equal(faces.length, count);
  assert.equal(faces[0].family, faces.at(-1)!.family);
  assert.throws(
    () => listTtcFaces(makeTtc(Array(count).fill(fixture))),
    /预算/,
  );
});

const {
  createSystemFontResolver,
}: {
  createSystemFontResolver: (
    roots: () => string[],
    byteLimit?: number,
  ) => {
    listSystemFontFamilies: typeof listSystemFontFamilies;
    resolveSystemFonts: typeof resolveSystemFonts;
  };
} = await import(new URL("../electron/system-fonts.mjs", import.meta.url).href);

test("resolver reserves raw bytes across faces, rejects an oversized primary and releases saturated slots", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "forma-font-limits-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "first.ttf"), fixture);
  await writeFile(join(root, "second.ttf"), emojiFixture());
  const query = {
    ...req,
    fontFamily: listTtcFaces(makeTtc([fixture]))[0].family,
    text: "A😀",
  };
  const resolver = createSystemFontResolver(() => [root], fixture.length);
  const first = resolver.resolveSystemFonts(query),
    second = resolver.resolveSystemFonts(query);
  await assert.rejects(resolver.resolveSystemFonts(query), { code: "BUSY" });
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.length, 1);
    assert.equal(
      Buffer.byteLength(result[0].data as string, "base64"),
      fixture.length,
    );
  }
  assert.equal((await resolver.resolveSystemFonts(query)).length, 1);
  const full = createSystemFontResolver(() => [root], fixture.length * 2);
  assert.equal((await full.resolveSystemFonts(query)).length, 2);
  const small = createSystemFontResolver(() => [root], fixture.length - 1);
  await assert.rejects(small.resolveSystemFonts(query), {
    code: "BUDGET_EXCEEDED",
  });
  await assert.rejects(small.resolveSystemFonts(query), {
    code: "BUDGET_EXCEEDED",
  });
});

test("directory mtime refresh discovers a font installed after the first scan and shares concurrent refreshes", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "forma-font-install-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  let scans = 0,
    now = Date.now();
  t.mock.method(Date, "now", () => now);
  const service = createSystemFontResolver(() => {
    scans++;
    return [root];
  });
  assert.deepEqual(await service.listSystemFontFamilies(), []);
  await writeFile(join(root, "installed.ttf"), fixture);
  assert.deepEqual(await service.listSystemFontFamilies(), []);
  now += 2001;
  const family = listTtcFaces(makeTtc([fixture]))[0].family;
  const [families, result] = await Promise.all([
    service.listSystemFontFamilies(),
    service.resolveSystemFonts({ ...req, fontFamily: family, text: "AB" }),
  ]);
  assert.ok(families.includes(family));
  assert.equal(result[0].family, family);
  assert.equal(scans, 2);
});

test("a declared system face takes priority over an embedded face, and undeclared system fallbacks come last", async () => {
  const { doc, n } = scene("AB");
  const { id, asset } = await importFontBytes(emojiFixture(), "Embedded.ttf");
  doc.fonts = { [id]: asset };
  const narrow = Buffer.from(fixture);
  tables(narrow)
    .find((t) => t.tag === "head")!
    .data.writeUInt16BE(2000, 18);
  const face = {
    family: "Helvetica",
    data: narrow,
    faceIndex: 0,
    format: "ttf" as const,
  };
  const other = emojiFixture();
  tables(other)
    .find((t) => t.tag === "head")!
    .data.writeUInt16BE(4000, 18);
  n.style.fontSize = 10;
  const resolve = async () => [{ ...face, family: "Other", data: other }, face];
  n.style.fontFamily = id;
  const embedded = artwork(await outlineTextNode(doc, n.id));
  n.style.fontFamily = "Helvetica";
  const system = artwork(
    await outlineTextNode(doc, n.id, {
      resolveSystemFonts: async () => [face],
    }),
  );
  assert.notEqual(embedded, system);
  n.style.fontFamily = "Helvetica, " + id;
  assert.equal(
    artwork(await outlineTextNode(doc, n.id, { resolveSystemFonts: resolve })),
    system,
  );
  n.text = "A😀B";
  const mixed = readContours(
    artwork(await outlineTextNode(doc, n.id, { resolveSystemFonts: resolve })),
  );
  assert.deepEqual(
    mixed.map((c) => c.anchors[0].x),
    [0, 3, 9],
  );
  n.style.fontFamily = id + ", Helvetica";
  await outlineTextNode(doc, n.id, {
    resolveSystemFonts: async () =>
      assert.fail("embedded primary covers all glyphs"),
  });
});

test("matching native baselines and Unicode character origins override wrapping and stale snapshots reflow", async () => {
  const { doc, n } = scene("A🙂B");
  const { id, asset } = await importFontBytes(fixture, "Positions.ttf");
  doc.fonts = { [id]: asset };
  Object.assign(n.style, {
    fontFamily: id,
    fontSize: 10,
    lineHeight: 12,
    width: 50,
    height: 64,
  });
  n.sourceTextLayout = {
    text: n.text,
    styleKey: textLayoutStyleKey(n.style),
    width: 50,
    height: 64,
    lines: [
      { text: "A", x: [3.25], y: 18 },
      { text: "🙂B", x: [4.5, 25.75], y: 51.5 },
    ],
  };
  const positions = async () =>
    readContours(artwork(await outlineTextNode(doc, n.id))).map((c) => [
      c.anchors[0].x,
      c.anchors[0].y,
    ]);
  const native = [
    [3.25, 18],
    [4.5, 51.5],
    [25.75, 51.5],
  ];
  assert.deepEqual(await positions(), native);
  n.sourceTextLayout.width += 2;
  assert.notDeepEqual(await positions(), native);
  n.sourceTextLayout.width -= 2;
  n.style.fontSize++;
  assert.notDeepEqual(await positions(), native);
  n.style.fontSize--;
  n.text += "A";
  assert.equal((await positions()).length, 4);
});

test(
  "PingFang SC at 20px in a 41px box keeps trailing punctuation, opening punctuation and small kana attached",
  { skip: process.platform !== "darwin" },
  async () => {
    const { doc, n } = scene("");
    Object.assign(n.style, {
      fontFamily: "PingFang SC",
      fontSize: 20,
      lineHeight: 24,
      width: 41,
      height: 96,
      widthMode: "fixed",
    });
    const faces = await resolveSystemFonts({
      ...req,
      fontFamily: "PingFang SC",
      text: "你好，世界《あぁ",
    });
    assert.equal(faces[0].family, "PingFang SC");
    const outline = async (text: string) => {
      n.text = text;
      return artwork(
        await outlineTextNode(doc, n.id, {
          resolveSystemFonts: async () => faces,
        }),
      );
    };
    for (const [text, lines] of [
      ["你好，世界", "你\n好，\n世界"],
      ["你好．世界", "你\n好．\n世界"],
      ["你好”世界", "你\n好”\n世界"],
      ["你《好世界", "你\n《好\n世界"],
      ["你あぁ世界", "你\nあぁ\n世界"],
    ]) {
      assert.equal(await outline(text), await outline(lines));
    }
  },
);

test(
  "macOS extracted Helvetica, PingFang SC and Hiragino Sans GB agree in HarfBuzz and opentype.js 2.0.0",
  { skip: process.platform !== "darwin" },
  async (t) => {
    // Prefer the project's/NODE_PATH copy. Cursor also ships the pinned parser on macOS.
    const require = [
      createRequire(import.meta.url),
      createRequire(
        "/Applications/Cursor.app/Contents/Resources/app/package.json",
      ),
    ].find((load) => {
      try {
        return load("opentype.js/package.json").version === "2.0.0";
      } catch {
        return false;
      }
    });
    if (!require)
      return t.skip(
        "set NODE_PATH to a directory containing opentype.js 2.0.0",
      );
    const { parse } = require("opentype.js") as {
      parse(data: ArrayBuffer): { charToGlyphIndex(c: string): number };
    };
    const hb = await import("harfbuzzjs");
    function verify(bytes: Uint8Array, ch: string) {
      checkSfnt(bytes);
      const hbFont = new hb.Font(new hb.Face(new hb.Blob(bytes), 0));
      const glyph = hbFont.nominalGlyph(ch.codePointAt(0)!);
      assert.ok(glyph);
      assert.equal(
        parse(Uint8Array.from(bytes).buffer).charToGlyphIndex(ch),
        glyph,
      );
    }
    for (const [family, ch] of [
      ["Helvetica", "A"],
      ["PingFang SC", "好"],
      ["Hiragino Sans GB", "设"],
    ]) {
      const [face] = await resolveSystemFonts({
        ...req,
        fontFamily: family,
        maxFaces: 1,
        text: ch,
      });
      assert.equal(face.family, family);
      verify(Buffer.from(face.data as string, "base64"), ch);
      let path =
        "/System/Library/Fonts/" +
        (family === "PingFang SC" ? "PingFang" : family) +
        ".ttc";
      if (family === "PingFang SC") {
        for await (const asset of glob(
          "/System/Library/AssetsV2/com_apple_MobileAsset_Font*/*/AssetData/PingFang.ttc",
        )) {
          path = asset;
          break;
        }
      }
      const collection = await readFile(path);
      const installed = listTtcFaces(collection)
        .filter((f) => f.family === family && !f.italic)
        .sort((a, b) => Math.abs(a.weight - 400) - Math.abs(b.weight - 400))[0];
      assert.ok(installed, family + " upright face");
      verify(
        (
          await normalizeFontBytes(collection, {
            faceIndex: installed.faceIndex,
          })
        ).bytes,
        ch,
      );
    }
  },
);

test(
  "real Helvetica and Apple Color Emoji leave A😀B editable when the bitmap face has only stub contours",
  { skip: process.platform !== "darwin" },
  async () => {
    // Read the original shaping and outline tables without allocating the 182 MiB bitmap strikes.
    const file = await open("/System/Library/Fonts/Apple Color Emoji.ttc", "r");
    async function slice(at: number, size: number) {
      const bytes = Buffer.alloc(size);
      assert.equal((await file.read(bytes, 0, size, at)).bytesRead, size);
      return bytes;
    }
    let emoji: Uint8Array;
    try {
      const offset = (await slice(12, 4)).readUInt32BE();
      const header = await slice(offset, 12);
      const dir = await slice(offset + 12, header.readUInt16BE(4) * 16);
      const records: { at: number; data: Buffer }[] = [];
      for (let at = 0; at < dir.length; at += 16) {
        if (dir.toString("latin1", at, at + 4) !== "sbix")
          records.push({
            at,
            data: await slice(
              dir.readUInt32BE(at + 8),
              dir.readUInt32BE(at + 12),
            ),
          });
      }
      let dest = 12 + records.length * 16;
      const font = Buffer.alloc(
        dest + records.reduce((sum, r) => sum + padding(r.data.length), 0),
      );
      header.copy(font);
      font.writeUInt16BE(records.length, 4);
      records.forEach(({ at, data }, i) => {
        dir.copy(font, 12 + 16 * i, at, at + 16);
        font.writeUInt32BE(dest, 12 + 16 * i + 8);
        data.copy(font, dest);
        dest += padding(data.length);
      });
      emoji = extractTtcFace(makeTtc([font]));
    } finally {
      await file.close();
    }
    const [latin] = await resolveSystemFonts({
      ...req,
      fontFamily: "Helvetica",
      text: "AB",
      maxFaces: 1,
    });
    const hb = await import("harfbuzzjs");
    assert.ok(
      new hb.Font(new hb.Face(new hb.Blob(emoji), 0)).nominalGlyph(0x1f600),
    );
    const { doc, n } = scene("A😀B");
    n.style.fontFamily = "Helvetica, Apple Color Emoji";
    const before = JSON.stringify(doc);
    await assert.rejects(
      outlineTextNode(doc, n.id, {
        resolveSystemFonts: async () => [
          latin,
          {
            family: "Apple Color Emoji",
            faceIndex: 0,
            format: "ttf",
            data: emoji,
          },
        ],
      }),
      /矢量轮廓.*😀/,
    );
    assert.equal(JSON.stringify(doc), before);
  },
);

test("document owners share registered faces, reconcile replacements and cancel pending registrations on close", async (t) => {
  const registered = new Set<object>();
  let wait: Promise<void> | undefined;
  class Face {
    async load() {
      await wait;
      return this;
    }
  }
  for (const [key, value] of Object.entries({
    FontFace: Face,
    document: { fonts: registered },
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const base = await importFontBytes(fixture, "Common.ttf"),
    other = await importFontBytes(emojiFixture(), "Other.ttf");
  const fonts = { [base.id]: base.asset },
    second = { [other.id]: other.asset };
  await loadFonts(fonts);
  const original = [...registered][0];
  await Promise.all([
    loadFonts(fonts, "first"),
    retainDocumentFonts("second", fonts),
  ]);
  await loadFonts(fonts); // A transient lookup must not pin an owned face.
  assert.deepEqual([...registered], [original]);
  await retainDocumentFonts("first", second);
  assert.equal(registered.size, 2);
  releaseDocumentFonts("second");
  assert.equal(registered.has(original), false);
  assert.equal(registered.size, 1);
  await retainDocumentFonts("first");
  assert.equal(registered.size, 0);
  await retainDocumentFonts("first", fonts);
  const replacement = [...registered][0];
  assert.notEqual(replacement, original);
  await retainDocumentFonts("first", {
    [base.id]: { ...base.asset, italic: true },
  });
  assert.equal(registered.size, 1);
  assert.ok(!registered.has(replacement));
  await assert.rejects(
    retainDocumentFonts("invalid", { [base.id]: other.asset }),
    /标识冲突/,
  );
  releaseDocumentFonts("first");
  assert.equal(registered.size, 0);
  let resume!: () => void;
  wait = new Promise<void>((r) => {
    resume = r;
  });
  const pending = retainDocumentFonts("closed", fonts);
  releaseDocumentFonts("closed");
  const reopened = retainDocumentFonts("new", fonts);
  resume();
  await Promise.all([pending, reopened]);
  assert.equal(registered.size, 1);
  releaseDocumentFonts("new");
  assert.equal(registered.size, 0);
  const assets = [];
  for (let i = 0; i < 10; i++) {
    const bytes = Buffer.from(fixture);
    tables(bytes)
      .find((t) => t.tag === "head")!
      .data.writeUInt32BE(i + 1, 32);
    const item = await importFontBytes(bytes, "Transient.ttf");
    assets.push(item);
    await loadFonts({ [item.id]: item.asset });
  }
  assert.equal(registered.size, 8);
  await retainDocumentFonts(
    "cleanup",
    Object.fromEntries(assets.map((f) => [f.id, f.asset])),
  );
  releaseDocumentFonts("cleanup");
  assert.equal(registered.size, 0);
});

test("collection import matches a shared bold italic style and asks for a face on mixed or tied styles", async () => {
  const bold = Buffer.from(fixture);
  const os2 = tables(bold).find((t) => t.tag === "OS/2")!.data;
  os2.writeUInt16BE(700, 4);
  os2.writeUInt16BE(1, 62);
  const collection = makeTtc([fixture, bold]);
  const selected = await importFontBytes(collection, "Type.ttc", {
    weight: 700,
    italic: true,
    chooseFace: async () => assert.fail("unambiguous selection"),
  });
  assert.equal(selected.asset.weight, 700);
  assert.equal(selected.asset.italic, true);
  let calls = 0;
  const chooseFace = async (faces: ReturnType<typeof listTtcFaces>) => {
    calls++;
    assert.equal(faces.length, 2);
    return 1;
  };
  assert.equal(
    (await normalizeFontBytes(collection, { chooseFace })).faceIndex,
    1,
  );
  assert.equal(
    (
      await normalizeFontBytes(makeTtc([bold, bold]), {
        weight: 700,
        italic: true,
        chooseFace,
      })
    ).faceIndex,
    1,
  );
  assert.equal(calls, 2);
});

test("a ligature whose nominal letters have ink retries the whole shaped cluster when GSUB substitutes a blank glyph", async () => {
  const bytes = Buffer.from(fixture);
  const table = tables(bytes).find((t) => t.tag === "name")!;
  bytes.write("GSUB", table.at);
  const words = (...values: number[]) => {
    const data = Buffer.alloc(2 * values.length);
    values.forEach((v, i) => data.writeUInt16BE(v, i * 2));
    return data;
  };
  const substitution = Buffer.concat([
    words(1, 0, 10, 30, 44),
    words(1),
    Buffer.from("DFLT"),
    words(8, 4, 0, 0, 0xffff, 1, 0), // default language uses feature 0
    words(1),
    Buffer.from("liga"),
    words(8, 0, 1, 0), // liga uses lookup 0
    words(1, 4, 4, 0, 1, 8), // ligature substitution, one subtable
    words(1, 18, 1, 8, 1, 4, 1, 2, 3, 1, 1, 2), // glyphs 2 + 3 substitute blank glyph 1
  ]);
  substitution.copy(table.data);
  const hb = await import("harfbuzzjs");
  const font = new hb.Font(new hb.Face(new hb.Blob(bytes), 0)),
    buffer = new hb.Buffer();
  buffer.addText("AB");
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  assert.deepEqual(
    buffer.getGlyphInfos().map((g) => g.codepoint),
    [1],
  );
  const { doc, n } = scene("AB");
  const bad = {
    family: "Ligature",
    data: bytes,
    format: "ttf" as const,
    faceIndex: 0,
  };
  n.style.fontFamily = "Ligature, Fallback";
  await assert.rejects(
    outlineTextNode(doc, n.id, { resolveSystemFonts: async () => [bad] }),
    /矢量轮廓.*A.*B/,
  );
  const good = { ...bad, family: "Fallback", data: fixture };
  const out = await outlineTextNode(doc, n.id, {
    resolveSystemFonts: async () => [good, bad],
  });
  assert.equal(readContours(artwork(out)).length, 2);
});

function installGlobals(t: TestContext, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, key, before);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

// Replace glyph 2 with real TrueType simple contours. Keep the rest of the
// fixture and point the Unicode cmap at this glyph for each requested letter.
function contourFont(contours: number[][][], characters = "O") {
  const base = Buffer.from(fixture);
  const table = (tag: string) => tables(base).find((t) => t.tag === tag)!;
  const points = contours.flat();
  const glyph = Buffer.alloc(12 + 2 * contours.length + points.length * 5);
  glyph.writeInt16BE(contours.length);
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach(
    (v, i) => glyph.writeInt16BE(v, 2 + i * 2),
  );
  let count = 0;
  contours.forEach((contour, i) => {
    count += contour.length;
    glyph.writeUInt16BE(count - 1, 10 + 2 * i);
  });
  const flags = 12 + 2 * contours.length;
  glyph.fill(1, flags, flags + points.length);
  for (const [axis, coords] of [xs, ys].entries()) {
    coords.forEach((v, i) =>
      glyph.writeInt16BE(
        v - (coords[i - 1] ?? 0),
        flags + points.length + (axis * points.length + i) * 2,
      ),
    );
  }
  const size = padding(glyph.length);
  const offset = padding(base.length);
  const font = Buffer.alloc(offset + size);
  glyph.copy(font, offset);
  const glyf = table("glyf"),
    loca = table("loca").data;
  base.writeUInt32BE(offset, glyf.at + 8);
  base.writeUInt32BE(size, glyf.at + 12);
  loca.writeUInt16BE(size / 2, 6);
  loca.writeUInt16BE(size / 2, 8);
  const cmap = table("cmap").data;
  const cps = [
    ...new Set(Array.from(characters, (c) => c.codePointAt(0)!)),
  ].sort((a, b) => a - b);
  assert.ok(28 + 12 * cps.length <= cmap.length);
  cmap.fill(0);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(10, 6);
  cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(12, 12);
  cmap.writeUInt32BE(16 + 12 * cps.length, 16);
  cmap.writeUInt32BE(cps.length, 24);
  cps.forEach((cp, i) => {
    cmap.writeUInt32BE(cp, 28 + i * 12);
    cmap.writeUInt32BE(cp, 32 + i * 12);
    cmap.writeUInt32BE(2, 36 + i * 12);
  });
  table("hmtx").data.writeUInt16BE(1000, 8);
  base.copy(font);
  return Buffer.from(extractTtcFace(makeTtc([font])));
}

const square = [
  [0, 0],
  [500, 0],
  [500, 500],
  [0, 500],
];

function filledArea(d: string) {
  const scope = new paper.PaperScope();
  scope.setup(new scope.Size(1, 1));
  const shape = new scope.CompoundPath({
    pathData: d,
    fillRule: "nonzero",
    insert: false,
  });
  const filled = shape.unite(new scope.Path({ insert: false }), {
    insert: false,
  });
  assert.ok(
    filled instanceof scope.Path || filled instanceof scope.CompoundPath,
  );
  return Math.abs(filled.area);
}

test("R3-P0-1 positioned AB takes precedence over cached ink and cancelling shapes fall through to shaping", async () => {
  const { doc, n } = scene("AB");
  const { id, asset } = await importFontBytes(
    contourFont([square], "AB"),
    "Squares.ttf",
  );
  n.style.fontFamily = id;
  doc.fonts = { [id]: asset };
  const snapshot = {
    text: "AB",
    styleKey: textLayoutStyleKey(n.style),
    width: n.style.width,
    height: n.style.height,
  };
  const layout = { ...snapshot, lines: [{ text: "AB", x: [5, 45], y: 54 }] };
  const box = "M0 0H18V18H0Z";
  for (const [d, positioned] of [
    [box + "M0 0V18H18V0Z", true],
    [box, true],
    [box + "M0 0V18H18V0Z", false],
    ["M0 0Z", false],
    ["Z", false],
  ] as const) {
    n.sourceTextShape = { ...snapshot, d };
    n.sourceTextLayout = positioned ? layout : undefined;
    const source = parseDocument(doc);
    assert.equal(outlineTextFromShapeOperations(source, n.id), null);
    const result = await outlineTextNode(source, n.id);
    const committed = transact(source, {
      baseRevision: source.revision,
      operations: result.operations,
    });
    const vector = committed.nodes.find((v) => v.id === n.id)!;
    assert.equal(vector.type, "vector");
    const path = vector.vector!.paths[0].d;
    assert.equal(filledArea(path), 648);
    if (positioned)
      assert.deepEqual(
        readContours(path).map((c) => [c.anchors[0].x, c.anchors[0].y]),
        [
          [5, 54],
          [45, 54],
        ],
      );
  }
});

test("R3-P0-1 reverse-split SVG circles fall through to font shaping and cannot be committed directly", async (t) => {
  const { doc, n } = scene("AB");
  n.style.fontFamily = "Forma Fixture";
  const resolveSystemFonts = t.mock.fn(resolver(fixture));
  const expected = artwork(
    await outlineTextNode(doc, n.id, { resolveSystemFonts }),
  );
  const first =
    "M22.80401 22A.80401 .80401 0 1 1 21.19599 22A.80401 .80401 0 1 1 22.80401 22Z";
  // The clockwise and counterclockwise contours share center (22,22).
  const reverse =
    "M22.00401 21.196A.80401 .80401 0 0 0 21.19599 22a.80401 .80401 0 1 0 1.60802 0A.80401 .80401 0 0 0 22.00401 21.196Z";
  n.sourceTextShape = {
    text: n.text,
    width: n.style.width,
    height: n.style.height,
    styleKey: textLayoutStyleKey(n.style),
    d: first + reverse,
  };
  assert.equal(n.sourceTextLayout, undefined);
  assert.equal(outlineTextFromShapeOperations(doc, n.id), null);
  resolveSystemFonts.mock.resetCalls();
  const result = await outlineTextNode(doc, n.id, { resolveSystemFonts });
  assert.equal(resolveSystemFonts.mock.callCount(), 1);
  const { nodes } = transact(doc, {
    baseRevision: doc.revision,
    operations: result.operations,
  });
  assert.equal(nodes.find((v) => v.id === n.id)?.vector?.paths[0].d, expected);
  for (const d of [first + reverse, (first + reverse).replaceAll("Z", "")])
    assert.throws(
      () =>
        createOutlinedVectorFromTextOperations(doc, n.id, d, {
          x: 21.19599,
          y: 21.19599,
          width: 1.60802,
          height: 1.60802,
        }),
      /填充区域/,
    );
  // A counter inside a visibly filled ring remains eligible for the cache.
  n.sourceTextShape.d = first + "M22.4 22a.4 .4 0 1 0 -.8 0a.4 .4 0 1 0 .8 0Z";
  assert.ok(outlineTextFromShapeOperations(doc, n.id));
});

// r² = u² + h² exactly in binary. The long arc and its two return
// segments share the center (u, r) and the top point (u, 0).
const binaryRadius = 1024 + 2 ** -38;
const binaryHalfChord = 1024 - 2 ** -38;
const binaryBaseline = binaryRadius - 2 ** -13;

for (const [label, d, bounds] of [
  [
    "R3-P0-1 single retraced circle",
    "M22.80401 22A.80401 .80401 0 1 1 21.19599 22A.80401 .80401 0 1 1 22.80401 22" +
      "A.80401 .80401 0 0 0 22.00401 21.196A.80401 .80401 0 0 0 21.19599 22a.80401 .80401 0 1 0 1.60802 0Z",
    { x: 21.19599, y: 21.19599, width: 1.60802, height: 1.60802 },
  ],
  [
    "R6-P0-1 reverse-split quadratic",
    "M0 0Q50 0 100 1Q75 .5 50 .25Q25 0 0 0Z",
    { x: 0, y: 0, width: 100, height: 1 },
  ],
  [
    "R7-P0 retraced shallow quadratic",
    "M0 50Q0 50 4000 50.00001Z",
    { x: 0, y: 50, width: 4000, height: 0.00001 },
  ],
  [
    "R7-P0 retraced semicircle with split return arcs",
    "M105.1 10A5.1 5.1 0 1 1 94.9 10 5.1 5.1 0 0 0 100 15.1 5.1 5.1 0 0 0 105.1 10Z",
    { x: 94.9, y: 10, width: 10.2, height: 5.1 },
  ],
  [
    "R8 retraced semicircle with translated decimal endpoints",
    "M635.3 0A35.3 35.3 0 1 1 564.7 0 35.3 35.3 0 0 0 600 35.3 35.3 35.3 0 0 0 635.3 0Z",
    { x: 564.7, y: 0, width: 70.6, height: 35.3 },
  ],
  [
    "R9 retraced near-semicircle with a center displaced by 0.004px",
    "M0 399.99600001A400.00000001 400.00000001 0 0 1 799.99999998 399.99600001 400.00000001 400.00000001 0 0 0 399.99999999 0 400.00000001 400.00000001 0 0 0 0 399.99600001Z",
    { x: 0, y: 0, width: 799.99999998, height: 399.99600001 },
  ],
  [
    "R10 exact binary near-diameter retrace",
    `M0 ${binaryBaseline}A${binaryRadius} ${binaryRadius} 0 0 1 ${2 * binaryHalfChord} ${binaryBaseline}A${binaryRadius} ${binaryRadius} 0 0 0 ${binaryHalfChord} 0A${binaryRadius} ${binaryRadius} 0 0 0 0 ${binaryBaseline}Z`,
    { x: 0, y: 0, width: 2 * binaryHalfChord, height: binaryBaseline },
  ],
  [
    "R13 relative arc with an absolute return across a decimal diameter",
    "M2420.3 0a450 500.3 90 0 1 -1000.6 0A450 500.3 90 0 0 2420.3 0Z",
    { x: 1419.7, y: 0, width: 1000.6, height: 450 },
  ],
  [
    "R13 absolute arc with a relative return across a decimal diameter",
    "M2420.3 0A450 500.3 90 0 1 1419.7 0a450 500.3 90 0 0 1000.6 0Z",
    { x: 1419.7, y: 0, width: 1000.6, height: 450 },
  ],
  [
    "R13 relative vertical arc with an absolute return across a decimal diameter",
    "M0 2420.3a500.3 450 90 0 1 0 -1000.6A500.3 450 90 0 0 0 2420.3Z",
    { x: -450, y: 1419.7, width: 450, height: 1000.6 },
  ],
  [
    "R13 a relative move after close restores the decimal subpath start",
    "M2420.3 0h-20Zm-1000.6 0q10 0 20 0t20 0Zm0 0a450 500.3 90 0 1 1000.6 0A450 500.3 90 0 0 1419.7 0Z",
    { x: 1419.7, y: -450, width: 1000.6, height: 450 },
  ],
  [
    "R14 implicitly closed relative move with a retraced decimal diameter",
    "M2420.3 0m-1000.6 0a450 500.3 90 0 1-1000.6 0A450 500.3 90 0 0 1419.7 0",
    { x: 419.1, y: 0, width: 1000.6, height: 450 },
  ],
  ...["Z", ""].map(
    (close) =>
      [
        `R12 ${close ? "closed" : "open"} retrace with a relative decimal diameter`,
        "M2420.3 0a450 500.3 90 0 1 -1000.6 0A450 500.3 90 0 0 1920 450A450 500.3 90 0 0 2420.3 0" +
          close,
        { x: 1419.7, y: 0, width: 1000.6, height: 450 },
      ] as const,
  ),
  ...[0, 90, 180, 270, -90].flatMap((rotation) =>
    [false, true].map((vertical) => {
      const swap = (rotation % 180 !== 0) !== vertical;
      const arc = `A${swap ? "450 500.3" : "500.3 450"} ${rotation}`;
      const [start, end, middle] = vertical
        ? ["450 1500.3", "450 499.7", "0 1000"]
        : ["1500.3 0", "499.7 0", "1000 450"];
      return [
        `R11 retraced ${vertical ? "vertical" : "horizontal"} decimal diameter at ${rotation} degrees`,
        `M${start}${arc} 1 1 ${end}${arc} 0 0 ${middle}${arc} 0 0 ${start}Z`,
        vertical
          ? { x: 0, y: 499.7, width: 450, height: 1000.6 }
          : { x: 499.7, y: 0, width: 1000.6, height: 450 },
      ] as const;
    }),
  ),
  [
    "R8 bowtie with both lobes totaling 0.0000981 square pixels",
    "M.007 0H0L.02 .018H.007Z",
    { x: 0, y: 0, width: 0.02, height: 0.018 },
  ],
] as const) {
  test(
    label + " rejects cached and final artwork and falls through to shaping",
    async (t) => {
      const { doc, n } = scene("AB");
      n.style.fontFamily = "Forma Fixture";
      const resolveSystemFonts = t.mock.fn(resolver(fixture));
      const expected = artwork(
        await outlineTextNode(doc, n.id, { resolveSystemFonts }),
      );
      n.sourceTextShape = {
        text: n.text,
        width: n.style.width,
        height: n.style.height,
        styleKey: textLayoutStyleKey(n.style),
        d,
      };
      assert.throws(
        () => createOutlinedVectorFromTextOperations(doc, n.id, d, bounds),
        /填充区域/,
      );
      assert.equal(outlineTextFromShapeOperations(doc, n.id), null);
      resolveSystemFonts.mock.resetCalls();
      assert.equal(
        artwork(await outlineTextNode(doc, n.id, { resolveSystemFonts })),
        expected,
      );
      assert.equal(resolveSystemFonts.mock.callCount(), 1);
    },
  );
}

test("R14 cached and direct output close open contours at the exact decimal move", () => {
  const { doc, n } = scene("A");
  const d = "M0 0h1v1ZM2420.3 0h1m-1001.6 0h2v2";
  n.sourceTextShape = {
    text: n.text,
    width: n.style.width,
    height: n.style.height,
    styleKey: textLayoutStyleKey(n.style),
    d,
  };
  const cached = outlineTextFromShapeOperations(doc, n.id);
  assert.ok(cached);
  const direct = createOutlinedVectorFromTextOperations(doc, n.id, d, {
    x: 0,
    y: 0,
    width: 2421.3,
    height: 2,
  });
  for (const result of [cached, direct]) {
    const contours = readContours(artwork(result));
    assert.equal(contours.length, 3);
    assert.ok(contours.every((c) => c.closed));
    assert.deepEqual(contours[2].anchors[0], { x: 1419.7, y: 0 });
  }
});

for (const [label, d, bounds, area] of [
  [
    "R6-P1-1 circle with a retraced spike",
    "M5 0A5 5 0 1 1 5 10A5 5 0 1 1 5 0L5 2000Z",
    { x: 0, y: 0, width: 10, height: 2000 },
    25 * Math.PI,
  ],
  [
    "R6-P1-2 narrow diagonal",
    "M0 0L4000 3998V4000L0 2Z",
    { x: 0, y: 0, width: 4000, height: 4000 },
    8000,
  ],
  [
    "R7-P1 cubic crossing its opposite edge at all three quarter levels",
    "M100 0H10C230 32 -30 64 190 96H100Z",
    { x: 10, y: 0, width: 180, height: 96 },
    1800,
  ],
  [
    "R8 cubics crossing at the five former quadrature nodes",
    "M0 0C200 8 0 16 200 24H194.0294C-23.0994 12 223.0994 12 5.9706 0Z",
    { x: 0, y: 0, width: 200, height: 24 },
    63.860008,
  ],
] as const) {
  test(
    label + " survives cached and direct conversion without a font",
    async (t) => {
      const { doc, n } = scene("A");
      n.sourceTextShape = {
        text: n.text,
        width: n.style.width,
        height: n.style.height,
        styleKey: textLayoutStyleKey(n.style),
        d,
      };
      assert.ok(outlineTextFromShapeOperations(doc, n.id));
      const resolveSystemFonts = t.mock.fn(async () => []);
      const cached = await outlineTextNode(doc, n.id, { resolveSystemFonts });
      assert.equal(resolveSystemFonts.mock.callCount(), 0);
      const direct = createOutlinedVectorFromTextOperations(
        doc,
        n.id,
        d,
        bounds,
      );
      for (const { operations } of [cached, direct]) {
        const saved = transact(doc, { baseRevision: doc.revision, operations });
        const path = saved.nodes.find((v) => v.id === n.id)?.vector?.paths[0].d;
        assert.ok(path);
        // Paper represents circular arcs as cubics when measuring their area.
        assert.ok(Math.abs(filledArea(path) - area) < 0.03);
      }
    },
  );
}

for (const failure of ["exception", "nonfinite"] as const) {
  test(
    "native area retains the ink threshold after a Boolean " + failure,
    (t) => {
      const { doc, n } = scene("A");
      const union = t.mock.method(paper.CompoundPath.prototype, "unite", () => {
        if (failure === "exception") throw Error("degenerate boolean");
        const invalid = new paper.Path({ insert: false });
        Object.defineProperty(invalid, "area", { value: NaN });
        return invalid;
      });
      for (const [d, accepted] of [
        ["M.007 0H0L.02 .018H.007Z", false],
        ["M0 0H.01V.01H0Z", true],
        [
          "M0 0C200 8 0 16 200 24H194.0294C-23.0994 12 223.0994 12 5.9706 0Z",
          true,
        ],
        [
          "M635.3 0A35.3 35.3 0 1 1 564.7 0 35.3 35.3 0 0 0 600 35.3 35.3 35.3 0 0 0 635.3 0Z",
          false,
        ],
        ["M5 0A5 5 0 1 1 5 10A5 5 0 1 1 5 0L5 2000Z", true],
      ] as const) {
        n.sourceTextShape = {
          text: n.text,
          width: n.style.width,
          height: n.style.height,
          styleKey: textLayoutStyleKey(n.style),
          d,
        };
        assert.equal(
          Boolean(outlineTextFromShapeOperations(doc, n.id)),
          accepted,
          d,
        );
      }
      assert.ok(union.mock.callCount() >= 5);
    },
  );
}

for (const [radius, chord, expectedArea] of [
  [589.3, 2 * 589.3 * (1 - 5e-11), 13.89],
  [4000, 7999.99999999996, 6.4],
])
  test(`cached and direct conversion retain the ${expectedArea}px² between a minor and a major arc`, async (t) => {
    const { doc, n } = scene("A");
    const y = Math.ceil(radius);
    const d = `M0 ${y}A${radius} ${radius} 0 0 1 ${chord} ${y}A${radius} ${radius} 0 1 0 0 ${y}Z`;
    n.sourceTextShape = {
      text: n.text,
      width: n.style.width,
      height: n.style.height,
      styleKey: textLayoutStyleKey(n.style),
      d,
    };
    const resolveSystemFonts = t.mock.fn(async () => []);
    const cached = await outlineTextNode(doc, n.id, { resolveSystemFonts });
    assert.equal(resolveSystemFonts.mock.callCount(), 0);
    const direct = createOutlinedVectorFromTextOperations(doc, n.id, d, {
      x: 0,
      y: 0,
      width: Math.ceil(chord),
      height: y,
    });
    for (const conversion of [cached, direct]) {
      // Measure the emitted circular segments analytically. Both share a chord,
      // so the signed chord terms cancel even if the artwork was translated.
      const segments: number[] = [];
      svgpath(artwork(conversion))
        .abs()
        .iterate((s, _, x, y) => {
          if (s[0] !== "A") return;
          const [, rx, ry, , large, sweep, ex, ey] = s;
          assert.equal(rx, ry);
          const u = Math.hypot(ex - x, ey - y) / 2;
          const minor = 2 * Math.atan2(u, Math.sqrt((rx - u) * (rx + u)));
          const angle = large ? 2 * Math.PI - minor : minor;
          segments.push(
            ((sweep ? 1 : -1) * rx * rx * (angle - Math.sin(angle))) / 2,
          );
        });
      assert.equal(segments.length, 2);
      assert.ok(
        Math.abs(Math.abs(segments[0] + segments[1]) - expectedArea) < 0.01,
      );
    }
  });

test("R9 disjoint subthreshold circles accumulate their filled areas", () => {
  const { doc, n } = scene("A");
  const circle = "a.0045 .0045 0 1 1 .009 0a.0045 .0045 0 1 1 -.009 0Z";
  n.sourceTextShape = {
    text: n.text,
    width: n.style.width,
    height: n.style.height,
    styleKey: textLayoutStyleKey(n.style),
    d: "M0 0" + circle,
  };
  assert.equal(outlineTextFromShapeOperations(doc, n.id), null);
  n.sourceTextShape.d += "M0 1" + circle;
  assert.ok(outlineTextFromShapeOperations(doc, n.id));
  // A zero-area component followed by exactly the threshold of visible ink.
  n.sourceTextShape.d =
    "M635.3 0A35.3 35.3 0 1 1 564.7 0 35.3 35.3 0 0 0 600 35.3 35.3 35.3 0 0 0 635.3 0ZM0 100h.01v.01H0Z";
  assert.ok(outlineTextFromShapeOperations(doc, n.id));
});

for (const [label, limit, strip] of [
  ...["1000 500", "1000 373"].map(
    (delta) =>
      [
        `straight l${delta}`,
        150,
        (i: number) => `M${3 * i} 0h1l${delta}h-1Z`,
      ] as const,
  ),
  [
    "grid",
    100,
    (i: number) =>
      `M${(i % 40) * 14} ${Math.floor(i / 40) * 20}a1000 1000 0 0 1 10 0v10h-10Z`,
  ],
  ...["1000 500", "1000 373", "1000 1000", "500 1000", "-1000 373"].map(
    (delta) =>
      [
        `l${delta}`,
        200,
        (i: number) => `M${3 * i} 0a1000 1000 0 0 1 1 0l${delta}h-1Z`,
      ] as const,
  ),
] as const)
  test(`600 disjoint ${label} contours convert in under ${limit}ms`, (t) => {
    const { doc, n } = scene("A");
    const d = Array.from({ length: 600 }, (_, i) => strip(i)).join("");
    n.sourceTextShape = {
      text: n.text,
      width: n.style.width,
      height: n.style.height,
      styleKey: textLayoutStyleKey(n.style),
      d,
    };
    const start = performance.now();
    const accepted = Boolean(outlineTextFromShapeOperations(doc, n.id));
    const ms = performance.now() - start;
    t.diagnostic(`600 ${label} contours: ${ms.toFixed(2)} ms`);
    assert.equal(accepted, true);
    assert.ok(ms < limit, `600 contours took ${ms.toFixed(2)} ms`);
  });

test("R11 mutual OBB axes separate strips even when a horizontal contour wins the sweep", (t) => {
  const { doc, n } = scene("A");
  // Every contour retraces itself so conversion must examine every component.
  // The long horizontal line wins on aspect ratio and overlaps every strip's AABB.
  const strips = Array.from(
    { length: 12 },
    (_, i) =>
      `M${3 * i} 0a1000 1000 0 0 1 1 0l1000 500l-1000 -500a1000 1000 0 0 0 -1 0Z`,
  );
  n.sourceTextShape = {
    text: n.text,
    width: n.style.width,
    height: n.style.height,
    styleKey: textLayoutStyleKey(n.style),
    d: "M0 200H100H0Z" + strips.join(""),
  };
  const union = t.mock.method(paper.CompoundPath.prototype, "unite");
  assert.equal(outlineTextFromShapeOperations(doc, n.id), null);
  assert.deepEqual(
    union.mock.calls.map((call) => {
      assert.ok(call.this instanceof paper.CompoundPath);
      return call.this.children.length;
    }),
    Array(13).fill(1),
  );
});

test("R5-P1-1 disjoint opposite-winding circles retain both filled regions without a font", async (t) => {
  const { doc, n } = scene("AB");
  n.sourceTextShape = {
    text: n.text,
    width: n.style.width,
    height: n.style.height,
    styleKey: textLayoutStyleKey(n.style),
    d: "M10 5a5 5 0 1 1-10 0a5 5 0 1 1 10 0zM30 5a5 5 0 1 0-10 0a5 5 0 1 0 10 0z",
  };
  const resolveSystemFonts = t.mock.fn(async () => []);
  const result = await outlineTextNode(doc, n.id, { resolveSystemFonts });
  assert.equal(resolveSystemFonts.mock.callCount(), 0);
  const saved = transact(doc, {
    baseRevision: doc.revision,
    operations: result.operations,
  });
  const d = saved.nodes.find((node) => node.id === n.id)!.vector!.paths[0].d;
  const scope = new paper.PaperScope();
  scope.setup(new scope.Size(1, 1));
  const shape = new scope.CompoundPath({
    pathData: d,
    fillRule: "nonzero",
    insert: false,
  });
  for (const [x, inside] of [
    [5, true],
    [15, false],
    [25, true],
  ] as const)
    assert.equal(shape.contains(new scope.Point(x, 5)), inside);
});

test("cached nonzero fill handles reflected curves, rotated ellipses, crossings and thin stems", () => {
  const { doc, n } = scene("A");
  const ellipse =
    "M24 22a10 5 36.86989764584402 1 1-16-12a10 5 36.86989764584402 1 1 16 12";
  for (const [d, visible] of [
    ["M10 10c0 6 8 6 8 0s8-6 8 0", true],
    ["M10 10c0 6 8 6 8 0s8-6 8 0c0-6-8-6-8 0s-8 6-8 0Z", false],
    ["M10 10q5 8 10 0t10 0", true],
    ["M10 10q5 8 10 0t10 0q-5-8-10 0t-10 0Z", false],
    [ellipse + "Z", true],
    [
      ellipse +
        "A10 5 36.86989764584402 0 0 19 12A10 5 36.86989764584402 0 0 8 10A10 5 36.86989764584402 1 0 24 22Z",
      false,
    ],
    ["M0 0L20 20H0L20 0Z", true],
    ["M0 0H.2V100H0Z", true],
    ["M0 0H100V100H0ZM0 .2V99.8H100V.2Z", true],
  ] as const) {
    n.sourceTextShape = {
      text: n.text,
      width: n.style.width,
      height: n.style.height,
      styleKey: textLayoutStyleKey(n.style),
      d,
    };
    assert.equal(!!outlineTextFromShapeOperations(doc, n.id), visible, d);
  }
});

test("R3-P0-2 overlapping opposite-winding fallback glyphs keep their full filled area", async () => {
  const { doc, n } = scene("AB");
  n.style.fontFamily = "First, Second";
  const faces = [square, [...square].reverse()].map((contour, i) => ({
    family: i ? "Second" : "First",
    faceIndex: 0,
    format: "ttf" as const,
    data: contourFont([contour], i ? "B" : "A"),
  }));
  for (const [text, x, area] of [
    ["A", [0], 324],
    ["B", [0], 324],
    ["AB", [0, 0], 324],
    ["AB", [0, 9], 486],
  ] as const) {
    n.text = text;
    n.sourceTextLayout = {
      text,
      styleKey: textLayoutStyleKey(n.style),
      width: n.style.width,
      height: n.style.height,
      lines: [{ text, x: [...x], y: 36 }],
    };
    const result = await outlineTextNode(doc, n.id, {
      resolveSystemFonts: async () => faces,
    });
    assert.equal(filledArea(artwork(result)), area);
  }
});

test("R3-P0-2 reversing a glyph swaps its exact cubic and quadratic handles and preserves its contour start", () => {
  const d = "M0 0Q3 -6 12 0C15 2 15 8 12 12H0Z";
  const normalized = normalizedGlyphPath(d);
  assert.deepEqual(readContours(normalized), [
    {
      closed: true,
      anchors: [
        { x: 0, y: 0, incoming: { x: 2, y: -4 } },
        { x: 0, y: 12 },
        { x: 12, y: 12, outgoing: { x: 15, y: 8 } },
        { x: 12, y: 0, incoming: { x: 15, y: 2 }, outgoing: { x: 6, y: -4 } },
      ],
    },
  ]);
  assert.equal(normalizedGlyphPath(normalized), normalized);
});

test("P0-2 compound nonzero fill rejects coincident reversed squares, retains a hole and equal opposite lobes", async () => {
  const { doc, n } = scene("O");
  n.style.fontFamily = "Primary, Fallback";
  const before = JSON.stringify(doc);
  const primary = {
    family: "Primary",
    format: "ttf" as const,
    faceIndex: 0,
    data: contourFont([square, [...square].reverse()]),
  };
  await assert.rejects(
    outlineTextNode(doc, n.id, { resolveSystemFonts: async () => [primary] }),
    /「O」 \(U\+4F\)/,
  );
  assert.equal(JSON.stringify(doc), before);
  for (const [area, contours] of [
    [
      243,
      [
        square,
        [...square].reverse().map(([x, y]) => [100 + x / 2, 100 + y / 2]),
      ],
    ],
    [648, [square, [...square].reverse().map(([x, y]) => [x + 500, y + 500])]],
    [
      162,
      [
        [
          [0, 0],
          [500, 500],
          [0, 500],
          [500, 0],
        ],
      ],
    ],
  ] satisfies [number, number[][][]][]) {
    const fallback = {
      ...primary,
      family: "Fallback",
      data: contourFont(contours),
    };
    const outline = async (faces: (typeof primary)[]) =>
      artwork(
        await outlineTextNode(doc, n.id, {
          resolveSystemFonts: async () => faces,
        }),
      );
    const expected = await outline([fallback]);
    // The crossing contour becomes two positive lobes; the counter stays hollow.
    assert.equal(filledArea(expected), area);
    assert.equal(await outline([primary, fallback]), expected);
  }
});

test("R2-P0-1 missing, substituted and reordered saved characters trigger full shaping", async () => {
  const { doc, n } = scene("A😀B");
  const { id, asset } = await importFontBytes(fixture, "Latin.ttf");
  doc.fonts = { [id]: asset };
  n.style.fontFamily = id;
  for (const row of ["AB", "A🙂B", "B😀A"]) {
    n.sourceTextLayout = {
      text: n.text,
      styleKey: textLayoutStyleKey(n.style),
      width: n.style.width,
      height: n.style.height,
      lines: [{ text: row, x: Array.from(row, (_, i) => i * 19), y: 77 }],
    };
    const before = JSON.stringify(doc);
    const requests: string[] = [];
    await assert.rejects(
      outlineTextNode(doc, n.id, {
        resolveSystemFonts: async (request) => {
          requests.push(request.text);
          return [];
        },
      }),
      /😀.*U\+1F600/,
    );
    assert.deepEqual(requests, ["😀"]);
    assert.equal(JSON.stringify(doc), before);
    assert.equal(
      readContours(
        artwork(
          await outlineTextNode(doc, n.id, {
            resolveSystemFonts: resolver(emojiFixture()),
          }),
        ),
      ).length,
      3,
    );
  }
});

test("R2-P0-1 transformed text accepts faithful native rows across hard breaks, soft splits and trimmed wrap space", async () => {
  const font = contourFont([square], "ABab");
  for (const [mode, input, rows] of [
    ["uppercase", "ab  \r\nba", ["A", "B", "BA"]],
    ["lowercase", "AB  BA", ["a", "b", "ba"]],
    ["capitalize", "ab ba", ["A", "b", "Ba"]],
  ] as const) {
    const { doc, n } = scene(input);
    n.style.textTransform = mode;
    n.sourceTextLayout = {
      text: input,
      width: n.style.width,
      height: n.style.height,
      styleKey: textLayoutStyleKey(n.style),
      lines: rows.map((text, i) => ({
        text,
        x: Array.from(text, (_, j) => 5 + j * 32),
        y: 100 + i * 60,
      })),
    };
    const anchors = readContours(
      artwork(
        await outlineTextNode(doc, n.id, {
          resolveSystemFonts: resolver(font),
        }),
      ),
    ).map((c) => c.anchors[0]);
    assert.deepEqual(
      anchors.map((p) => [p.x, p.y]),
      [
        [5, 100],
        [5, 160],
        [5, 220],
        [37, 220],
      ],
    );
  }
});

function namedFixture(family: string, bytes = fixture) {
  const font = Buffer.from(bytes);
  const table = tables(font).find((t) => t.tag === "name")!.data;
  for (let i = 0; i < table.readUInt16BE(2); i++) {
    const at = 6 + i * 12;
    if (![1, 4, 6].includes(table.readUInt16BE(at + 6))) continue;
    const encoded =
      table.readUInt16BE(at) === 1
        ? Buffer.from(family)
        : Buffer.from(family, "utf16le").swap16();
    assert.ok(encoded.length <= table.readUInt16BE(at + 8));
    encoded.copy(table, table.readUInt16BE(4) + table.readUInt16BE(at + 10));
    table.writeUInt16BE(encoded.length, at + 8);
  }
  return Buffer.from(extractTtcFace(makeTtc([font])));
}

test("R3 P1-1 a comma in a CSS comment preserves Helvetica as the first renderer and Electron match", async (t) => {
  const css = "Helvetica /* UI, primary */, Courier";
  const names = (list: string) =>
    parseFontFamilies(list).map((family) => family.name);
  assert.deepEqual(names(css), ["Helvetica", "Courier"]);
  assert.deepEqual(names("Helvetica/* unfinished, Courier"), ["Helvetica"]);
  assert.deepEqual(names("\"A/*,*/B\", 'C/*,*/D', E\\/*F, G"), [
    "A/*,*/B",
    "C/*,*/D",
    "E/*F",
    "G",
  ]);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "forma-css-comments-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const helvetica = namedFixture("Helvetica", contourFont([square], "AB"));
  await writeFile(join(root, "courier.ttf"), namedFixture("Courier"));
  await writeFile(join(root, "helvetica.ttf"), helvetica);
  const service = createSystemFontResolver(() => [root]);
  const faces = await service.resolveSystemFonts({
    ...req,
    fontFamily: css,
    text: "AB",
    declaredOnly: true,
  });
  assert.equal(faces[0].family, "Helvetica");
  const { doc, n } = scene("AB");
  for (const face of ["Helvetica", "Courier"]) {
    const { id, asset } = await importFontBytes(
      await readFile(join(root, face.toLowerCase() + ".ttf")),
      face + ".ttf",
    );
    (doc.fonts ??= {})[id] = asset;
  }
  n.style.fontFamily = css;
  const selected = artwork(await outlineTextNode(doc, n.id));
  n.style.fontFamily = "Helvetica";
  assert.equal(selected, artwork(await outlineTextNode(doc, n.id)));
  n.style.fontFamily = "Courier";
  assert.notEqual(selected, artwork(await outlineTextNode(doc, n.id)));
});

test("P1-1 renderer and installed font service resolve normalized CSS names in declaration order", async (t) => {
  const names = [
    [String.raw`Helvetica   Neue`, "Helvetica Neue"],
    [String.raw`Helvetica\ Neue`, "Helvetica Neue"],
    [String.raw`\48 elvetica`, "Helvetica"],
    [String.raw`\000048elvetica`, "Helvetica"],
    [String.raw`A\,B`, "A,B"],
    [String.raw`" A  \"B\", C "`, ' A  "B", C '],
    [String.raw`'A\'B'`, "A'B"],
  ];
  const { doc, n } = scene("AB");
  const { id, asset } = await importFontBytes(fixture, "Embedded.ttf");
  doc.fonts = { [id]: asset };
  n.style.fontFamily = id;
  const embedded = artwork(await outlineTextNode(doc, n.id));
  const bytes = Buffer.from(fixture);
  tables(bytes)
    .find((t) => t.tag === "head")!
    .data.writeUInt16BE(2000, 18);
  for (const [css, name] of names) {
    n.style.fontFamily = css + ", " + id;
    assert.deepEqual(
      parseFontFamilies(n.style.fontFamily).map((e) => e.name),
      [name, id],
    );
    const face = {
      family: name,
      data: bytes,
      format: "ttf" as const,
      faceIndex: 0,
    };
    const outline = () =>
      outlineTextNode(doc, n.id, {
        resolveSystemFonts: async () => [face],
      }).then(artwork);
    const actual = await outline();
    n.style.fontFamily = css;
    assert.equal(actual, await outline());
    assert.notEqual(actual, embedded);
  }
  // The resolver receives CSS directly over IPC as well as from the renderer.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "forma-css-families-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const family = listTtcFaces(makeTtc([fixture]))[0].family;
  assert.ok(family.includes(" "));
  await writeFile(join(root, "font.ttf"), fixture);
  const service = createSystemFontResolver(() => [root]);
  for (const css of [
    family.replaceAll(" ", "   "),
    family.replaceAll(" ", "\\ "),
    "\\" + family.charCodeAt(0).toString(16) + " " + family.slice(1),
  ]) {
    const result = await service.resolveSystemFonts({
      ...req,
      text: "A",
      fontFamily: "Absent, " + css,
      declaredOnly: true,
    });
    assert.equal(result[0]?.family, family);
  }
});

test("P1-2 normal and emergency wrapping attach fullwidth stops and directional quotes", async () => {
  const bytes = contourFont([square], "你好．世界“”");
  const { doc, n } = scene("");
  Object.assign(n.style, {
    width: 41,
    height: 200,
    fontSize: 20,
    lineHeight: 26,
    widthMode: "fixed",
  });
  const outline = async (text: string) => {
    n.text = text;
    return artwork(
      await outlineTextNode(doc, n.id, { resolveSystemFonts: resolver(bytes) }),
    );
  };
  for (const mark of ["．", "”"]) {
    n.style.width = 41;
    assert.equal(
      await outline("你好" + mark + "世界"),
      await outline("你\n好" + mark + "\n世界"),
    );
    n.style.width = 10;
    assert.equal(
      await outline("你好" + mark + "世界"),
      await outline("你\n好" + mark + "\n世\n界"),
    );
  }
  assert.equal(await outline("你“好世界"), await outline("你\n“好\n世\n界"));
});

test(
  "P1-2 PingFang SC keeps solidus and hyphen on the preceding row at 41px and 10px",
  { skip: process.platform !== "darwin" },
  async () => {
    const { doc, n } = scene("");
    Object.assign(n.style, {
      fontFamily: "PingFang SC",
      fontSize: 20,
      lineHeight: 26,
      height: 160,
      widthMode: "fixed",
    });
    const [face] = await resolveSystemFonts({
      ...req,
      fontFamily: "PingFang SC",
      text: "你好/-世界",
      maxFaces: 1,
    });
    assert.equal(face.family, "PingFang SC");
    const outline = async (text: string, width: number) => {
      n.text = text;
      n.style.width = width;
      return artwork(
        await outlineTextNode(doc, n.id, {
          resolveSystemFonts: async () => [face],
        }),
      );
    };
    for (const mark of ["/", "-"]) {
      for (const width of [41, 10]) {
        const rows = [
          "你",
          "好" + mark,
          ...(width === 41 ? ["世界"] : ["世", "界"]),
        ];
        // A wide box makes the hard-break reference independent of emergency wrapping.
        assert.equal(
          await outline("你好" + mark + "世界", width),
          await outline(rows.join("\n"), 200),
        );
      }
    }
  },
);

test("R3 P1-2 halfwidth CJK stops, double exclamation and middle dot stay on the preceding line at 41px and 10px", async () => {
  const { doc, n } = scene("");
  Object.assign(n.style, {
    height: 200,
    fontSize: 20,
    lineHeight: 26,
    widthMode: "fixed",
  });
  for (const mark of [
    "｡",
    "､",
    "‼",
    "・",
    "¢",
    "･",
    "～",
    "‽",
    "‑",
    "/",
    "-",
    "‒",
    "|",
    "｢",
    "￥",
  ]) {
    const resolveSystemFonts = resolver(
      contourFont([square], "你好世界" + mark),
    );
    const outline = async (text: string) => {
      n.text = text;
      return artwork(await outlineTextNode(doc, n.id, { resolveSystemFonts }));
    };
    for (const width of [41, 10]) {
      n.style.width = width;
      const last = width === 41 ? "世界" : "世\n界";
      const opener = mark === "｢" || mark === "￥";
      assert.equal(
        await outline(opener ? "你" + mark + "好世界" : "你好" + mark + "世界"),
        await outline(
          "你\n" + (opener ? mark + "好" : "好" + mark) + "\n" + last,
        ),
        mark + " at " + width,
      );
    }
  }
});

test(
  "P1-3 native Avenir Next fi positions move every contour of i by exactly 50px",
  { skip: process.platform !== "darwin" },
  async () => {
    const bytes = (
      await normalizeFontBytes(
        await readFile("/System/Library/Fonts/Avenir Next.ttc"),
        { weight: 400, italic: false },
      )
    ).bytes;
    const hb = await import("harfbuzzjs");
    const font = new hb.Font(new hb.Face(new hb.Blob(bytes), 0));
    const b = new hb.Buffer();
    b.addText("fi");
    b.guessSegmentProperties();
    hb.shape(font, b);
    assert.equal(b.getGlyphInfos().length, 1);
    const { doc, n } = scene("fi");
    const fontResolver = resolver(bytes);
    const run = async (text: string, x: number[]) => {
      n.text = text;
      n.sourceTextLayout = {
        text,
        styleKey: textLayoutStyleKey(n.style),
        width: n.style.width,
        height: n.style.height,
        lines: [{ text, x, y: 48 }],
      };
      return readContours(
        artwork(
          await outlineTextNode(doc, n.id, {
            resolveSystemFonts: fontResolver,
          }),
        ),
      );
    };
    const f = await run("f", [0]);
    const i = await run("i", [30]);
    const near = await run("fi", [0, 30]),
      far = await run("fi", [0, 80]);
    assert.deepEqual(near, [...f, ...i]);
    assert.deepEqual(far.slice(0, f.length), f);
    assert.equal(far.length, near.length);
    i.forEach(({ anchors }, ci) =>
      anchors.forEach((a, ai) => {
        const moved = far[f.length + ci].anchors[ai];
        assert.equal(moved.y, a.y);
        assert.ok(Math.abs(moved.x - a.x - 50) < 1e-6);
      }),
    );
  },
);

test("P1-7 a same-size in-place update retries within the request and shares the new index", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "forma-font-rewrite-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "same.ttf");
  await writeFile(file, fixture);
  let scans = 0,
    now = Date.now();
  t.mock.method(Date, "now", () => now);
  const service = createSystemFontResolver(() => {
    scans++;
    return [root];
  });
  const family = listTtcFaces(makeTtc([fixture]))[0].family;
  const query = { ...req, fontFamily: family, text: "AB", declaredOnly: true };
  assert.equal((await service.resolveSystemFonts(query)).length, 1);
  const parent = (await stat(root)).mtimeMs;
  const revised = emojiFixture();
  await writeFile(file, revised);
  await utimes(file, new Date(now + 10000), new Date(now + 10000));
  assert.equal((await stat(root)).mtimeMs, parent);
  now += 2001;
  for (const [face] of await Promise.all([
    service.resolveSystemFonts(query),
    service.resolveSystemFonts(query),
  ])) {
    assert.equal(face?.data, revised.toString("base64"));
  }
  assert.equal(scans, 2);
  assert.equal(
    (await service.resolveSystemFonts({ ...query, text: "😀" })).length,
    1,
  );
  assert.equal(scans, 2);
});

test("P1-7 an absent family costs zero additional scans across cooldowns until installation", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "forma-font-miss-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  let scans = 0,
    now = Date.now();
  t.mock.method(Date, "now", () => now);
  const service = createSystemFontResolver(() => {
    scans++;
    return [root];
  });
  const family = listTtcFaces(makeTtc([fixture]))[0].family;
  const query = { ...req, fontFamily: family, text: "AB", declaredOnly: true };
  for (let i = 0; i < 4; i++) {
    now += 2200;
    assert.deepEqual(await service.resolveSystemFonts(query), []);
  }
  assert.equal(scans, 1);
  await writeFile(join(root, "now-present.ttf"), fixture);
  now += 2200;
  assert.equal((await service.resolveSystemFonts(query))[0]?.family, family);
  assert.equal(scans, 2);
});

test("R3 P1-7 a negative alias refresh reparses only an in-place renamed file before fallback", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "forma-font-alias-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const changed = join(root, "z-renamed.ttf");
  await writeFile(join(root, "a-fallback.ttf"), namedFixture("Fallback"));
  await writeFile(changed, namedFixture("OldFamily"));
  const parent = (await stat(root)).mtimeMs,
    size = (await stat(changed)).size;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const opens = t.mock.method(fs, "open");
  const service = createSystemFontResolver(() => [root]);
  const query = { ...req, fontFamily: "NewFamily", text: "A" };
  assert.equal((await service.resolveSystemFonts(query))[0].family, "Fallback");
  await writeFile(changed, namedFixture("NewFamily"));
  await utimes(changed, new Date(now + 5000), new Date(now + 5000));
  assert.equal((await stat(root)).mtimeMs, parent);
  assert.equal((await stat(changed)).size, size);
  now += 2001;
  opens.mock.resetCalls();
  const result = await service.resolveSystemFonts(query);
  assert.equal(result[0].family, "NewFamily");
  assert.equal(result[0].declaredMatch, true);
  // One metadata parse plus one payload read. No unchanged font was opened.
  assert.deepEqual(
    opens.mock.calls.map((c) => c.arguments[0]),
    [changed, changed],
  );
  opens.mock.resetCalls();
  for (const fontFamily of ["OldFamily", "Absent", "Absent"]) {
    now += 2001;
    assert.deepEqual(
      await service.resolveSystemFonts({
        ...query,
        fontFamily,
        declaredOnly: true,
      }),
      [],
    );
  }
  assert.equal(opens.mock.callCount(), 0);
});

for (const mode of [
  "preserved mtime",
  "advertised family missing glyph",
  "missing first CSS family",
  "first CSS family missing glyph",
] as const) {
  test("P1-7 rechecks the fallback after cooldown with " + mode, async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "forma-font-coverage-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "z-rename.ttf"),
      fallback = join(root, "a-fallback.ttf");
    await writeFile(fallback, namedFixture("Fallback"));
    await writeFile(file, namedFixture("OldFamily"));
    if (mode.includes("missing glyph"))
      await writeFile(
        join(root, "b-partial.ttf"),
        namedFixture("NewFamily", contourFont([square], "B")),
      );
    const stamp = new Date("2026-01-01T00:00:00Z");
    await utimes(file, stamp, stamp);
    const before = await stat(file),
      parent = await stat(root);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const service = createSystemFontResolver(() => [root]);
    const query = {
      ...req,
      fontFamily: mode.includes("CSS") ? "NewFamily, Fallback" : "NewFamily",
      text: "A",
      maxFaces: 1,
    };
    assert.equal(
      (await service.resolveSystemFonts(query))[0]?.family,
      "Fallback",
    );
    const opens = t.mock.method(fs, "open");
    now += 2001;
    assert.equal(
      (await service.resolveSystemFonts(query))[0]?.family,
      "Fallback",
    );
    assert.deepEqual(
      opens.mock.calls.map((c) => c.arguments[0]),
      [fallback],
      "unchanged lookup only reads the selected payload",
    );
    await writeFile(file, namedFixture("NewFamily"));
    await utimes(
      file,
      stamp,
      mode === "preserved mtime" ? stamp : new Date(+stamp + 5000),
    );
    const after = await stat(file);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs === before.mtimeMs, mode === "preserved mtime");
    assert.ok(after.ctimeMs !== before.ctimeMs || after.ino !== before.ino);
    assert.equal((await stat(root)).mtimeMs, parent.mtimeMs);
    now += 2001;
    opens.mock.resetCalls();
    const [face] = await service.resolveSystemFonts(query);
    assert.equal(face.family, "NewFamily");
    assert.equal(face.declaredMatch, true);
    assert.deepEqual(
      opens.mock.calls.map((c) => c.arguments[0]),
      [file, file],
    );
  });
}

for (const match of ["generic family", "weight", "italic"] as const) {
  test(
    "R6-P1-3 refreshes a lower-ranked " + match + " after cooldown",
    async (t) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "forma-font-rank-")),
      );
      t.after(() => rm(root, { recursive: true, force: true }));
      const fallback = join(root, "a-fallback.ttf");
      const changed = join(root, "z-renamed.ttf");
      const generic = match === "generic family";
      const family = generic ? "Arial" : "Fixture";
      const preferred = generic ? "SF Pro Text" : family;
      const style = Buffer.from(fixture);
      const os2 = tables(style).find((table) => table.tag === "OS/2")!.data;
      if (match === "weight") os2.writeUInt16BE(700, 4);
      if (match === "italic") os2.writeUInt16BE(1, 62);
      const updated = namedFixture(preferred, style);
      await writeFile(fallback, namedFixture(family));
      await writeFile(changed, namedFixture("OldFamily", style));
      const parent = await stat(root);
      const size = (await stat(changed)).size;
      let now = Date.now();
      t.mock.method(Date, "now", () => now);
      const service = createSystemFontResolver(() => [root]);
      const query: SystemFontRequest = {
        ...req,
        fontFamily: generic ? "system-ui" : family,
        fontWeight: match === "weight" ? 700 : 400,
        fontStyle: match === "italic" ? "italic" : "normal",
        text: "A",
        declaredOnly: true,
      };
      const [original] = await service.resolveSystemFonts(query);
      assert.equal(original.family, family);
      const opens = t.mock.method(fs, "open");
      now += 2001;
      assert.equal(
        (await service.resolveSystemFonts(query))[0].faceId,
        original.faceId,
      );
      assert.deepEqual(
        opens.mock.calls.map((c) => c.arguments[0]),
        [fallback],
      );
      now += 2001;
      opens.mock.resetCalls();
      assert.deepEqual(
        await service.resolveSystemFonts({ ...query, fontFamily: "Absent" }),
        [],
      );
      assert.equal(opens.mock.callCount(), 0);

      await writeFile(changed, updated);
      await utimes(changed, new Date(now), new Date(now));
      assert.equal((await stat(root)).mtimeMs, parent.mtimeMs);
      assert.equal((await stat(changed)).size, size);
      assert.equal(
        (await service.resolveSystemFonts(query))[0].faceId,
        original.faceId,
      );
      assert.deepEqual(
        opens.mock.calls.map((c) => c.arguments[0]),
        [fallback],
      );
      opens.mock.resetCalls();
      now += 2001;
      const [selected] = await service.resolveSystemFonts(query);
      assert.equal(selected.family, preferred);
      assert.notEqual(selected.faceId, original.faceId);
      assert.equal(selected.data, updated.toString("base64"));
      assert.deepEqual(
        opens.mock.calls.map((c) => c.arguments[0]),
        [changed, changed],
      );
    },
  );
}

test("R2-P1-1 closing a legacy document preserves the first owner's original bold italic registration", async (t) => {
  class Face {
    constructor(
      readonly id: string,
      _bytes: ArrayBuffer,
      readonly descriptors: FontFaceDescriptors,
    ) {}
    async load() {
      return this;
    }
  }
  const registered = new Set<Face>();
  installGlobals(t, { FontFace: Face, document: { fonts: registered } });
  const bytes =
    process.platform === "darwin"
      ? (
          await normalizeFontBytes(
            await readFile("/System/Library/Fonts/Helvetica.ttc"),
            { weight: 700, italic: true },
          )
        ).bytes
      : fixture;
  const { id, asset } = await importFontBytes(
    bytes,
    "Helvetica Bold Italic.ttf",
  );
  const bold = { ...asset, axes: [], weight: 700, italic: true };
  const legacy = { ...asset, axes: [], weight: undefined, italic: undefined };
  try {
    await retainDocumentFonts("A", { [id]: bold });
    const first = [...registered][0];
    assert.equal(first.descriptors.weight, "700");
    assert.equal(first.descriptors.style, "italic");
    await retainDocumentFonts("B", { [id]: legacy });
    assert.ok(registered.has(first));
    releaseDocumentFonts("B");
    assert.deepEqual([...registered], [first]);
    assert.deepEqual(first.descriptors, { weight: "700", style: "italic" });
  } finally {
    releaseDocumentFonts("A");
    releaseDocumentFonts("B");
  }
  assert.equal(registered.size, 0);
});

test("R2-P2-4 a controlled desktop failure preserves the error code, message and editable source", async (t) => {
  const { doc, n } = scene("AB");
  const before = JSON.stringify(doc);
  const bridge: Pick<FormaDesktopBridge, "resolveSystemFonts"> = {
    resolveSystemFonts: async () => ({
      ok: false,
      code: "BUSY",
      error: "系统字体解析繁忙，请稍后重试",
    }),
  };
  installGlobals(t, {
    window: {
      formaDesktop: bridge,
      fetch: () => assert.fail("unexpected HTTP fallback"),
    },
  });
  for (const options of [
    {},
    { resolveSystemFonts: bridge.resolveSystemFonts },
  ]) {
    await assert.rejects(outlineTextNode(doc, n.id, options), {
      message: "系统字体解析繁忙，请稍后重试",
      code: "BUSY",
    });
  }
  assert.equal(JSON.stringify(doc), before);
});

for (const exit of [
  "unmount",
  "deactivate",
  "reactivate",
  "commit",
  "selection during load",
  "chooser tab switch",
  "chooser selection switch",
  "chooser document switch",
  "chooser same-ID session replacement",
  "session replacement during load",
  "chooser commit",
] as const) {
  test("P1-6 font import on " + exit, { timeout: 5000 }, async (t) => {
    const dom = new DOMParser().parseFromString("<html/>", "text/html");
    const events = new EventTarget();
    const create = dom.createElement.bind(dom);
    t.mock.method(dom, "createElement", (tag: string) => {
      const element = create(tag);
      Object.assign(element, {
        style: {},
        addEventListener() {},
        removeEventListener() {},
        value: "",
      });
      if (tag === "select")
        Object.defineProperty(element, "options", {
          get: () => element.getElementsByTagName("option"),
        });
      if (tag === "input")
        Object.defineProperty(element, "type", {
          get: () => element.getAttribute("type"),
          set: (v: string) => element.setAttribute("type", v),
        });
      return element;
    });
    dom.addEventListener = () => {};
    const host = dom.createElement("div");
    host.addEventListener = events.addEventListener.bind(events);
    const registered = new Set<Face>();
    const added = t.mock.method(registered, "add");
    let started!: () => void, finish!: () => void;
    const loading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let loads = 0;
    class Face {
      async load() {
        loads++;
        started();
        await gate;
        return this;
      }
    }
    Object.assign(dom, { fonts: registered });
    installGlobals(t, {
      document: dom,
      window: { document: dom, HTMLIFrameElement: class {} },
      FontFace: Face,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const root = createRoot(host);
    const { doc, n } = scene("AB");
    const other = doc.nodes[2];
    const history: { current: History } = {
      current: { present: doc, past: [], future: [] },
    };
    const owner = "picker-test-document";
    const errors: string[] = [];
    let session = 1;
    function Surface({
      active,
      selected,
    }: {
      active: boolean;
      selected: string;
    }) {
      const [fonts, setFonts] = useState(doc.fonts);
      const committed = history.current.present;
      useEffect(() => {
        void retainDocumentFonts(owner, fonts);
        return () => releaseDocumentFonts(owner);
      }, [fonts]);
      const editor = {
        doc: committed,
        committed,
        historyRef: history,
        selection: [selected],
        setError: (message: string) => errors.push(message),
        apply(operations: Parameters<EditorController["apply"]>[0]) {
          history.current = commit(
            history.current,
            transact(committed, {
              baseRevision: committed.revision,
              operations,
            }),
          );
          setFonts(history.current.present.fonts);
        },
      } as unknown as EditorController;
      return createElement(
        PopoverSurfaceContext.Provider,
        { value: active },
        createElement(
          PopoverDocumentSessionContext.Provider,
          { value: session },
          createElement(FontAssets, {
            editor,
            nodes: [committed.nodes.find((v) => v.id === selected)!],
          }),
        ),
      );
    }
    const show = (active: boolean, selected = n.id) =>
      act(() => root.render(createElement(Surface, { active, selected })));
    try {
      await show(true);
      const field = Array.from(host.getElementsByTagName("input")).find(
        (el) => el.getAttribute("type") === "file",
      );
      assert.ok(field);
      const file = new File([new Uint8Array(fixture)], "Picked.ttf");
      const reads = t.mock.method(file, "arrayBuffer");
      const clicked = t.mock.fn();
      Object.assign(field, { files: [file], click: clicked });
      const chooser = exit.startsWith("chooser");
      const canceledChooser = chooser && exit !== "chooser commit";
      if (chooser) {
        const button = Array.from(host.getElementsByTagName("button")).find(
          (b) => b.getAttribute("aria-label") === "导入字体",
        );
        assert.ok(button);
        const click = new Event("click", { bubbles: true });
        Object.defineProperty(click, "target", { value: button });
        await act(() => {
          events.dispatchEvent(click);
        });
        assert.equal(clicked.mock.callCount(), 1);
        if (exit === "chooser tab switch") {
          await show(false);
          await show(false, other.id);
          await show(true, other.id);
        } else if (exit === "chooser selection switch") {
          await show(true, other.id);
          await show(true);
        } else if (exit === "chooser document switch") {
          history.current.present = { ...doc, id: crypto.randomUUID() };
          await show(true);
        } else if (exit === "chooser same-ID session replacement") {
          history.current.present = structuredClone(doc);
          session++;
          await show(true);
        }
      }
      const event = new Event("change", { bubbles: true });
      Object.defineProperty(event, "target", { value: field });
      await act(() => {
        events.dispatchEvent(event);
      });
      if (canceledChooser) assert.equal(reads.mock.callCount(), 0);
      else await loading;
      if (exit === "selection during load") await show(true, other.id);
      if (exit === "session replacement during load") {
        history.current.present = structuredClone(doc);
        session++;
        await show(true);
      }
      if (exit === "unmount") await act(() => root.render(null));
      if (exit === "deactivate" || exit === "reactivate") await show(false);
      // Reactivating before load finishes must not revive the canceled import.
      if (exit === "reactivate") await show(true);
      await act(async () => {
        finish();
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      const commits = exit === "commit" || exit === "chooser commit" ? 1 : 0;
      assert.equal(history.current.past.length, commits);
      assert.equal(registered.size, commits);
      assert.equal(added.mock.callCount(), commits);
      assert.deepEqual(
        history.current.present.nodes.find((v) => v.id === other.id),
        other,
      );
      assert.equal(loads, canceledChooser ? 0 : 1);
      assert.deepEqual(errors, []);
    } finally {
      finish();
      await act(() => root.unmount());
    }
    assert.equal(registered.size, 0);
  });
}
