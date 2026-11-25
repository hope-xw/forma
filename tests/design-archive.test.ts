import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { openDesignArchive } from "../src/infrastructure/design-import/archive";
import {
  isExternalDesign,
  unsupportedFigma,
} from "../src/infrastructure/design-import/types";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { importFigma } from "../src/infrastructure/design-import/figma";
import { checkImportedFonts } from "../src/infrastructure/design-import/font-check";
import { inspectImageBytes } from "../src/infrastructure/design-import/image";
import {
  configurePdfReader,
  rasterizeSketchPdf,
} from "../src/infrastructure/design-import/sketch-image";
import { inspectFontBytes } from "../src/infrastructure/font-import";
import { createNode, type DesignDocument } from "../src/domain/document";

test("设计归档按完整 Unicode 路径读取，支持存储和压缩条目", async () => {
  const paths = ["键盘/\u{100ec3}/白.png", "图标/白.png"];
  for (const level of [0, 6] as const) {
    const bytes = zipSync(
      { [paths[0]]: strToU8("甲"), [paths[1]]: strToU8("乙") },
      { level },
    );
    const archive = openDesignArchive(bytes);
    assert.deepEqual(archive.names, paths);
    assert.equal(new TextDecoder().decode(archive.read(paths[1])), "乙");
    assert.ok(
      await isExternalDesign(new File([new Uint8Array(bytes)], "design.json")),
    );
  }
});
test("设计归档拒绝无效目录、跨级路径与损坏内容", () => {
  assert.throws(() => openDesignArchive(new Uint8Array()));
  assert.throws(() =>
    openDesignArchive(zipSync({ "../document.json": strToU8("{}") })),
  );
  const bytes = zipSync({ "test.txt": strToU8("source") }, { level: 0 });
  bytes[30 + "test.txt".length] ^= 1;
  assert.throws(() => openDesignArchive(bytes).read("test.txt"), /校验/);
});

test("FigJam and Slides are recognized bare or zipped regardless of extension; the worker explains unsupported input and insecure contexts", async (t) => {
  const messages: { error?: string }[] = [];
  const worker = {
    postMessage: (m: { error?: string }) => messages.push(m),
    onmessage: undefined as unknown as (event: { data: File }) => Promise<void>,
  };
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: worker,
  });
  t.after(() => Reflect.deleteProperty(globalThis, "self"));
  const hook = registerHooks({
    resolve(spec, ctx, next) {
      if (spec.endsWith("pdfium.wasm?url"))
        return {
          url: "data:text/javascript,export default 'local.wasm'",
          shortCircuit: true,
        };
      return next(spec, ctx);
    },
  });
  t.after(() => hook.deregister());
  await import("../src/infrastructure/design-import/worker");
  for (const header of ["fig-jam.", "fig-deck"]) {
    const bytes = strToU8(header);
    for (const data of [bytes, zipSync({ "canvas.fig": bytes })]) {
      const file = new File([Uint8Array.from(data)], "local.data");
      assert.ok(await isExternalDesign(file));
      await assert.rejects(
        importFigma(data, file.name),
        (e) => e instanceof Error && e.message === unsupportedFigma,
      );
      await worker.onmessage({ data: file });
      assert.equal(messages.at(-1)?.error, unsupportedFigma);
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {},
  });
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
  await worker.onmessage({
    data: new File(
      [
        Uint8Array.from(
          zipSync({
            "document.json": strToU8("{}"),
            "meta.json": strToU8("{}"),
          }),
        ),
      ],
      "local.sketch",
    ),
  });
  assert.match(messages.at(-1)!.error!, /HTTPS.*localhost/);
});

test("font checks accept embedded resource keys and quoted family names", async () => {
  const id = "font-" + "a".repeat(64),
    n = createNode("text");
  n.style.fontFamily = '"Embedded Family", sans-serif';
  n.textRuns = [{ start: 0, end: 1, style: { fontFamily: id } }];
  const doc: DesignDocument = {
    schemaVersion: 1,
    id: "test",
    name: "test",
    revision: 0,
    tokens: {},
    nodes: [n],
    fonts: {
      [id]: {
        name: "Embedded Family",
        axes: [],
        data: "data:font/ttf;base64,AAAA",
      },
    },
  };
  assert.deepEqual(await checkImportedFonts(doc), []);
});

test("JPEG dimensions tolerate standalone markers and report truncated marker lengths as unreadable images", () => {
  for (const marker of [1, 0xd0, 0xd7, 0xd8]) {
    const bytes = Uint8Array.from([
      255,
      216,
      255,
      marker,
      255,
      192,
      0,
      7,
      8,
      0,
      12,
      0,
      15,
    ]);
    assert.deepEqual(inspectImageBytes(bytes), {
      mime: "jpeg",
      width: 15,
      height: 12,
    });
  }
  for (const tail of [
    [255, 255, 255, 255, 255],
    [255, 255, 255, 255, 192, 0],
  ]) {
    assert.throws(
      () => inspectImageBytes(Uint8Array.from([255, 216, ...tail])),
      /无法识别位图格式/,
    );
  }
});

test("PDF reader can retry initialization after a rejected WASM load", async () => {
  let tries = 0;
  configurePdfReader(async () => {
    tries++;
    throw Error("load " + tries);
  });
  await assert.rejects(rasterizeSketchPdf(new Uint8Array()), /load 1/);
  await assert.rejects(rasterizeSketchPdf(new Uint8Array()), /load 2/);
});

test("embedded font inspection rejects invalid axis tags, reversed ranges and excessive features", () => {
  function sfnt(tag: string, size: number) {
    const file = new Uint8Array(28 + size),
      dir = new DataView(file.buffer);
    dir.setUint32(0, 65536);
    dir.setUint16(4, 1);
    file.set(strToU8(tag), 12);
    dir.setUint32(20, 28);
    dir.setUint32(24, size);
    return { file, table: new DataView(file.buffer, 28) };
  }
  const { file, table } = sfnt("fvar", 36);
  table.setUint16(4, 16);
  table.setUint16(8, 1);
  table.setUint16(10, 20);
  file.set(strToU8("wght"), 44);
  table.setInt32(20, 0);
  table.setInt32(24, 65536);
  table.setInt32(28, 2 * 65536);
  assert.deepEqual(inspectFontBytes(file).axes, [
    { tag: "wght", min: 0, default: 1, max: 2 },
  ]);
  file[44] = 0;
  assert.throws(() => inspectFontBytes(file), /字体轴/);
  file[44] = 119;
  table.setInt32(24, -65536);
  assert.throws(() => inspectFontBytes(file), /字体轴/);
  table.setInt32(24, 3 * 65536);
  assert.throws(() => inspectFontBytes(file), /字体轴/);
  const many = sfnt("GSUB", 12 + 513 * 6);
  many.table.setUint16(6, 10);
  many.table.setUint16(10, 513);
  for (let i = 0; i < 513; i++)
    many.file.set(strToU8(i.toString(36).padStart(4, "0")), 40 + i * 6);
  assert.throws(() => inspectFontBytes(many.file), /512/);
  many.table.setUint16(10, 512);
  assert.equal(inspectFontBytes(many.file).features.length, 512);
});

test("Electron retains the initial transfer, closes its handle once on main-frame reload, and displays the underlying file error", async (t) => {
  const app = Object.assign(new EventEmitter(), {
    getAppPath: () => process.cwd(),
    setName() {},
    setAboutPanelOptions() {},
    isReady: () => true,
    whenReady: () => new Promise(() => {}),
  });
  const handlers = new Map<
    string,
    (event: { sender: EventEmitter }) => unknown
  >();
  const errors: string[] = [];
  const owner = Object.assign(new EventEmitter(), {
    setWindowOpenHandler() {},
  });
  class Window extends EventEmitter {
    webContents = owner;
    loadURL() {
      owner.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: false,
      });
      return Promise.resolve();
    }
  }
  const electron = {
    app,
    BrowserWindow: Window,
    ipcMain: {
      handle: (key: string, fn: (event: { sender: EventEmitter }) => unknown) =>
        handlers.set(key, fn),
    },
    protocol: { registerSchemesAsPrivileged() {} },
    dialog: {
      showErrorBox: (title: string, message: string) =>
        errors.push(title + " " + message),
    },
    Menu: {},
    shell: {},
  };
  const hook = registerHooks({
    resolve(spec, ctx, next) {
      if (spec === "electron")
        return {
          url: "data:text/javascript,export const {app,BrowserWindow,ipcMain,protocol,dialog,Menu,shell}=globalThis.formaElectronFixture",
          shortCircuit: true,
        };
      return next(spec, ctx);
    },
  });
  Object.assign(globalThis, { formaElectronFixture: electron });
  t.after(() => {
    hook.deregister();
    Reflect.deleteProperty(globalThis, "formaElectronFixture");
  });
  let closed = 0;
  t.mock.method(fs.promises, "open", async (file: string) => {
    if (file === "broken.fig") throw Error("无法读取原稿");
    return {
      stat: async () => ({ isFile: () => true, size: 32 }),
      close: async () => {
        closed++;
      },
    };
  });
  await import(new URL("../electron/main.mjs", import.meta.url).href);
  const opened = async (file: string) => {
    app.emit("open-file", { preventDefault() {} }, file);
    await new Promise((r) => setImmediate(r));
  };
  await opened("design.fig");
  owner.emit("did-start-navigation", {
    isMainFrame: false,
    isSameDocument: false,
  });
  owner.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: true,
  });
  assert.equal(closed, 0);
  assert.deepEqual(
    handlers.get("forma:consume-pending-file")!({ sender: owner }),
    { name: "design.fig", size: 32 },
  );
  owner.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
  });
  assert.equal(closed, 1);
  assert.equal(
    handlers.get("forma:consume-pending-file")!({ sender: owner }),
    null,
  );
  owner.emit("destroyed");
  assert.equal(closed, 1);
  await opened("broken.fig");
  assert.deepEqual(errors, ["打开设计文件失败 无法读取原稿"]);
});
