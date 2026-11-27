// Run against a packaged desktop build with one or more local native design files.
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { _electron } from "playwright";

const args = process.argv.slice(2);
if (
  process.env.FORMA_DESKTOP_PID_FILE &&
  args[0] === "--verifier-pid-file=" + process.env.FORMA_DESKTOP_PID_FILE
)
  args.shift();
const paths = args.map((file) => path.resolve(file));
if (!paths.length) throw Error("请传入已固定版本的 .sketch 和 .fig 原档");
const resultFile = process.env.FORMA_DESKTOP_RESULT_FILE;
const results = [];
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const userData = await mkdtemp(
  path.join(
    resultFile ? path.dirname(resultFile) : tmpdir(),
    "forma-native-open-",
  ),
);
let app;
let child;
let watchdog;
try {
  app = await _electron.launch({
    cwd: process.cwd(),
    ...(resultFile
      ? {
          env: Object.fromEntries(
            Object.entries(process.env).filter(([key]) =>
              [
                "PATH",
                "HOME",
                "TMPDIR",
                "USER",
                "LOGNAME",
                "LANG",
                "LC_ALL",
              ].includes(key),
            ),
          ),
        }
      : {}),
    executablePath:
      process.env.FORMA_DESKTOP_EXECUTABLE ??
      path.resolve("release/mac-arm64/Forma.app/Contents/MacOS/Forma"),
    args: [
      ...(process.env.FORMA_DESKTOP_PROJECT
        ? [path.resolve(process.env.FORMA_DESKTOP_PROJECT)]
        : []),
      "--forma-offscreen-qa",
      "--user-data-dir=" + userData,
    ],
  });
  child = app.process();
  if (process.env.FORMA_DESKTOP_PID_FILE)
    await writeFile(process.env.FORMA_DESKTOP_PID_FILE, String(child.pid), {
      flag: "wx",
      mode: 0o600,
    });
  // The verifier gives this helper 180s. Leave time for launch and profile cleanup.
  if (resultFile) watchdog = setTimeout(() => child.kill("SIGKILL"), 130_000);
  const first = await app.firstWindow();
  await first.locator(".workspace-home, .editor-canvas").first().waitFor();
  assert.equal(
    await first.evaluate(() => window.formaDesktop.version),
    pkg.version,
  );
  async function storedReport(page) {
    return page.evaluate(async () => {
      const key = new URLSearchParams(location.search).get("file");
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open("forma-studio");
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      try {
        const snapshot = await new Promise((res, rej) => {
          const req = db
            .transaction("documents")
            .objectStore("documents")
            .get(key);
          req.onsuccess = () => res(req.result.current);
          req.onerror = () => rej(req.error);
        });
        const doc =
          snapshot.format === "parts-v1"
            ? await new Promise((resolve, reject) => {
                const request = db
                  .transaction("document-parts")
                  .objectStore("document-parts")
                  .get([key, snapshot.generation, 0]);
                request.onsuccess = () =>
                  resolve(
                    request.result?.find((row) => row.kind === "header")
                      ?.document,
                  );
                request.onerror = () => reject(request.error);
              })
            : snapshot;
        const totals = {
          pageNodes: 0,
          components: 0,
          instances: 0,
          pdfRasters: 0,
        };
        const countNodes = (nodes) => {
          totals.pageNodes += nodes.length;
          for (const n of nodes) if (n.instance) totals.instances++;
        };
        if (snapshot.format === "parts-v1") {
          const range = IDBKeyRange.bound(
            [key, snapshot.generation],
            [key, snapshot.generation, []],
          );
          await new Promise((resolve, reject) => {
            const req = db
              .transaction("document-parts")
              .objectStore("document-parts")
              .openCursor(range);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const cursor = req.result;
              if (!cursor) {
                resolve();
                return;
              }
              for (const part of cursor.value) {
                if (part.kind === "page") countNodes(part.nodes);
                if (part.kind === "component") totals.components++;
                if (part.kind === "issues")
                  totals.pdfRasters += part.issues.filter(
                    (q) => q.detail.includes("PDF") && q.detail.includes("PNG"),
                  ).length;
              }
              cursor.continue();
            };
          });
        } else {
          countNodes(doc.nodes);
          for (const p of doc.pages ?? []) if (p.nodes) countNodes(p.nodes);
          for (const lib of Object.values(doc.libraries ?? {}))
            totals.components += lib.components.length;
          totals.pdfRasters = doc.importReport.issues.filter(
            (q) => q.detail.includes("PDF") && q.detail.includes("PNG"),
          ).length;
        }
        return {
          protocol: location.protocol,
          ...totals,
          images: Object.keys(doc.images ?? {}).length,
          fonts: Object.keys(doc.fonts ?? {}).length,
          storageFormat: snapshot.format ?? "single",
          sha256: doc.importReport.sha256,
          format: doc.importReport.format,
          pages: doc.pages?.length ?? 1,
          sourceNodes: doc.importReport.sourceNodes,
        };
      } finally {
        db.close();
      }
    });
  }
  for (const file of paths) {
    const expected = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    const windowReady = app.waitForEvent("window");
    await app.evaluate(
      ({ app }, filename) =>
        app.emit("open-file", { preventDefault() {} }, filename),
      file,
    );
    const page = await windowReady;
    const dialog = page.getByRole("dialog", { name: "设计文件导入报告" });
    await dialog.getByText(path.basename(file), { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "导入为新文件" })
      .click({ timeout: 600000 });
    await page.waitForURL((u) => u.searchParams.has("file"), {
      timeout: 300000,
    });
    await page.locator(".editor-canvas").waitFor({ timeout: 300000 });
    await page.reload();
    await page.locator(".editor-canvas").waitFor({ timeout: 300000 });
    const report = await storedReport(page);
    assert.equal(report.sha256, expected);
    assert.ok(report.sourceNodes > 0);
    if (
      path.basename(file) === "shared-paint.fig" &&
      (resultFile ||
        expected ===
          "5ef901a1829f3013cfb218ec7a376ae4e6dc463314bd4b2586622089b3df8eab")
    ) {
      assert.deepEqual(
        [
          report.sha256,
          report.format,
          report.pages,
          report.sourceNodes,
          report.pageNodes,
        ],
        [
          "5ef901a1829f3013cfb218ec7a376ae4e6dc463314bd4b2586622089b3df8eab",
          "Figma",
          1,
          6,
          2,
        ],
      );
    }
    const appleOriginals = {
      "839ecf260025264db9000a4ce23ef2804c33c8d62642a6373ed310858ca64171": [
        36, 156, 5, 13914, 44969, 1919, 4798, 1,
      ],
      d6a0a6370b17f5c109d5ef227915ef6d59bf0da23076292e09fb87fd5e63a11a: [
        46, 420, 0, 37738, 38747, 2576, 4101, 0,
      ],
    };
    if (appleOriginals[expected]) {
      assert.deepEqual(
        [
          report.pages,
          report.images,
          report.fonts,
          report.sourceNodes,
          report.pageNodes,
          report.components,
          report.instances,
          report.pdfRasters,
        ],
        appleOriginals[expected],
      );
      assert.equal(report.storageFormat, "parts-v1");
      // Capture the real Electron DownloadItem. The application then reopens
      // the downloaded portable file through macOS' open-file handler.
      const portablePath = path.join(userData, expected + ".forma");
      await app.evaluate(({ session }, path) => {
        globalThis.formaSavedDownload = new Promise((resolve) => {
          session.defaultSession.once("will-download", (_, item) => {
            item.setSavePath(path);
            item.once("done", (_, state) => resolve(state));
          });
        });
      }, portablePath);
      await page.getByLabel("文件菜单", { exact: true }).click();
      await page.getByRole("button", { name: /保存本地副本/ }).click();
      assert.equal(
        await app.evaluate(() => globalThis.formaSavedDownload),
        "completed",
      );
      const nextReady = app.waitForEvent("window");
      await app.evaluate(
        ({ app }, file) => app.emit("open-file", { preventDefault() {} }, file),
        portablePath,
      );
      const reopened = await nextReady;
      await reopened.waitForURL((u) => u.searchParams.has("file"), {
        timeout: 300000,
      });
      await reopened.locator(".editor-canvas").waitFor({ timeout: 300000 });
      assert.notEqual(reopened.url(), page.url());
      assert.deepEqual(await storedReport(reopened), report);
      report.portableBytes = (await stat(portablePath)).size;
      report.portableReopened = true;
    }
    const result = {
      version: pkg.version,
      filename: path.basename(file),
      ...report,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  if (resultFile) {
    const temp = resultFile + "." + randomUUID();
    try {
      await writeFile(
        temp,
        JSON.stringify(results.length === 1 ? results[0] : results),
        { flag: "wx" },
      );
      await rename(temp, resultFile);
    } finally {
      await rm(temp, { force: true });
    }
  }
} finally {
  clearTimeout(watchdog);
  try {
    if (app) {
      const kill = setTimeout(() => child?.kill("SIGKILL"), 10_000);
      try {
        await app
          .evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
          )
          .catch(() => {});
        await app.close();
      } finally {
        clearTimeout(kill);
        if (child && child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
}
