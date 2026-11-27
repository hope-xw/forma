import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { constants, runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const project = fileURLToPath(new URL("../", import.meta.url));
const version = JSON.parse(
  await readFile(path.join(project, "package.json"), "utf8"),
).version;
let executablePath =
  process.env.FORMA_DESKTOP_EXECUTABLE ??
  path.join(project, "release/mac-arm64/Forma.app/Contents/MacOS/Forma");
const work = await mkdtemp(path.join(tmpdir(), "forma-desktop-workflows-"));
// System IME is the only workflow that needs a visible, active native window.
const offscreen = !process.argv.slice(2).includes("system-pinyin");
const origin = process.cwd();
const output = path.join(work, "output/playwright");
async function closeProfile(app) {
  // Disposable test windows may have a pending beforeunload prompt after a failed assertion.
  await app
    .evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((win) => win.destroy()),
    )
    .catch(() => {});
  await app.close();
}
function observeDownloads(app, page) {
  const browserEvent = page.waitForEvent.bind(page);
  page.waitForEvent = (name, ...args) => {
    if (name !== "download") return browserEvent(name, ...args);
    return app
      .evaluate(() => globalThis.takeFormaTestDownload())
      .then(({ file, state }) => {
        assert.equal(state, "completed");
        return { path: async () => file, saveAs: (to) => copyFile(file, to) };
      });
  };
}
async function launch(profile) {
  const app = await _electron.launch({
    executablePath,
    args: [
      "--user-data-dir=" + path.join(work, profile),
      ...(offscreen ? ["--forma-offscreen-qa"] : []),
    ],
    timeout: 30000,
  });
  try {
    await app.evaluate(({ session }, dest) => {
      const completed = [],
        waiting = [];
      let serial = 0;
      // Electron owns these downloads. Accept the real native DownloadItem in
      // a disposable directory instead of presenting a system save sheet.
      session.defaultSession.on("will-download", (_event, item) => {
        const file = dest + "/native-download-" + ++serial;
        item.setSavePath(file);
        item.once("done", (_e, state) => {
          const receipt = { file, state };
          if (waiting.length) waiting.shift()(receipt);
          else completed.push(receipt);
        });
      });
      globalThis.takeFormaTestDownload = () =>
        completed.length
          ? completed.shift()
          : new Promise((resolve) => waiting.push(resolve));
    }, output);
    const page = await app.firstWindow();
    if (offscreen) {
      assert.ok(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (win) => !win.isVisible() && win.webContents.isOffscreen(),
          ),
        ),
      );
    }
    observeDownloads(app, page);
    await page.locator(".workspace-home, .editor-canvas").first().waitFor();
    assert.equal(
      await page.evaluate(() => window.formaDesktop?.version),
      version,
    );
    return { app, page };
  } catch (e) {
    await closeProfile(app);
    throw e;
  }
}
async function editorFlow(name) {
  const { app, page } = await launch(name);
  try {
    const filename = path.join(
      project,
      "scripts",
      "check-" + name + ".browser.js",
    );
    const run = runInThisContext(await readFile(filename, "utf8"), {
      filename,
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    page.setDefaultTimeout(12000);
    if (await page.locator(".workspace-home").count()) {
      await page.goto("forma://app/?editor=1");
      await page.locator(".editor-canvas").waitFor();
    }
    const newWindow = async () => {
      const opening = app.waitForEvent("window");
      await app.evaluate(({ Menu }) => {
        const command = Menu.getApplicationMenu()
          .items.flatMap((m) => m.submenu?.items ?? [])
          .find((m) => m.label === "新建窗口");
        command.click();
      });
      const other = await opening;
      observeDownloads(app, other);
      return other;
    };
    const result = await run(page, { newWindow });
    await page
      .getByTitle("已保存到本机", { exact: true })
      .waitFor({ state: "attached" });
    console.log(JSON.stringify({ check: name, result }));
  } finally {
    await closeProfile(app);
  }
}
// Opt-in because this verifies the Mac's currently selected Simplified Pinyin input source.
async function systemPinyin() {
  const keys = path.join(work, "send-keys");
  execFileSync("swiftc", [
    path.join(project, "scripts/macos-test-keys.swift"),
    "-o",
    keys,
  ]);
  const { app, page } = await launch("macos-pinyin");
  try {
    await page.getByRole("button", { name: "新建设计", exact: true }).click();
    await page.waitForURL(/file=forma\.file\./);
    await page.locator(".editor-canvas").waitFor();
    await page.locator(".editor-canvas").focus();
    for (const key of ["f", "Enter", "t", "Enter", "Enter"])
      await page.keyboard.press(key);
    const input = page.getByRole("textbox", {
      name: "画布文本编辑",
      exact: true,
    });
    await input.focus();
    await input.evaluate((el) => {
      window.imeEvents = [];
      for (const name of [
        "compositionstart",
        "compositionupdate",
        "compositionend",
        "input",
      ])
        el.addEventListener(name, (e) =>
          window.imeEvents.push([e.type, e.data]),
        );
    });
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    const send = (...codes) =>
      execFileSync(keys, [String(app.process().pid), ...codes.map(String)]);
    send(45, 34, 4, 0, 31); // n i h a o
    await page.waitForFunction(
      () => window.imeEvents.some(([kind]) => kind === "compositionstart"),
      null,
      { timeout: 3000 },
    );
    send(49); // select the candidate with Space
    await page.waitForFunction(
      () => window.imeEvents.some(([kind]) => kind === "compositionend"),
      null,
      { timeout: 3000 },
    );
    const value = (await input.innerText()).trim(),
      events = await page.evaluate(() => window.imeEvents);
    assert.equal(value, "你好");
    await page.keyboard.press("Meta+Enter");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    const layer = page.locator(".design-node").last();
    assert.notEqual(await layer.innerText(), value);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await page.getByTitle("已保存到本机", { exact: true }).waitFor();
    await page.reload();
    await page
      .locator(".design-node")
      .getByText(value, { exact: true })
      .last()
      .waitFor();
    console.log(
      JSON.stringify({
        check: "macos-pinyin",
        result: { value, events, undoRedo: true, reopened: true },
      }),
    );
  } finally {
    await closeProfile(app);
  }
}
async function openFiles() {
  const { app, page } = await launch("open-files");
  try {
    const files = ["aura-showcase", "mobile-studio"].map((n) =>
      path.join(project, "public/examples/" + n + ".forma.json"),
    );
    const docs = await Promise.all(
      files.map(async (p) => JSON.parse(await readFile(p, "utf8")).name),
    );
    const ready = Promise.all(
      docs.map(async (target) => {
        const win = await app.waitForEvent("window", async (win) => {
          try {
            await win
              .getByRole("textbox", { name: "文件名", exact: true })
              .waitFor();
            await win.waitForFunction(
              (name) =>
                document.querySelector('[aria-label="文件名"]')?.value === name,
              target,
              { timeout: 8000 },
            );
            return true;
          } catch {
            return false;
          }
        });
        return win.getByLabel("文件名", { exact: true }).inputValue();
      }),
    );
    await app.evaluate(({ app }, files) => {
      for (const file of files)
        app.emit("open-file", { preventDefault() {} }, file);
    }, files);
    assert.deepEqual(await ready, docs);
    assert.equal(
      await page.getByLabel("文件名", { exact: true }).inputValue(),
      "未命名设计文件",
    );
    console.log(
      JSON.stringify({ check: "open-files", result: { version, docs } }),
    );
  } finally {
    await closeProfile(app);
  }
}
async function publishAndReopen() {
  let { app, page } = await launch("publisher");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const blank = async () => {
    if (await page.locator(".workspace-home").count())
      await button("新建设计").click();
    else await button("新建空白文件").click();
    await page.waitForURL(/file=forma\.file\./);
    await page.locator(".editor-canvas").waitFor();
  };
  try {
    await blank();
    await page.locator(".editor-canvas").focus();
    await page.keyboard.press("f");
    await page.keyboard.press("Enter");
    await button("资源").click();
    await button("保存选区").click();
    const card = page.locator('button[aria-label^="查看 "]').last();
    const name = await card.getAttribute("aria-label");
    await card.click();
    await page.getByText("发布组件库", { exact: true }).click();
    await page.getByRole("button", { name: /^发布修订 r/ }).click();
    const link = page.getByLabel("可分享的订阅地址");
    await link.waitFor();
    const url = await link.inputValue();
    const before = await (await fetch(url)).json();
    await closeProfile(app);
    ({ app, page } = await launch("publisher"));
    const after = await (await fetch(url)).json();
    assert.equal(after.id, before.id);
    assert.equal(after.revision, before.revision);
    await blank();
    await button("资源").click();
    await button("在线组件库").click();
    await page.getByLabel("组件库地址", { exact: true }).fill(url);
    await button("订阅").click();
    await page.getByText(/已是最新版本 · 本地/).waitFor();
    await button("完成").click();
    await button(name).click();
    await button("插入组件").click();
    await page.locator(".design-node.selected").waitFor();
    console.log(
      JSON.stringify({
        check: "publish-reopen",
        result: {
          version,
          revision: after.revision,
          persistedAcrossRestart: true,
          subscriberInserted: true,
        },
      }),
    );
  } finally {
    await closeProfile(app);
  }
}
try {
  if (offscreen && process.platform === "darwin") {
    // Mark only our disposable copy background-only, before macOS launches it.
    const bundle = path.resolve(executablePath, "../../..");
    const copy = path.join(work, "Forma.app");
    execFileSync("/usr/bin/ditto", [bundle, copy]);
    execFileSync("/usr/bin/plutil", [
      "-replace",
      "LSBackgroundOnly",
      "-bool",
      "true",
      path.join(copy, "Contents/Info.plist"),
    ]);
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", copy], {
      stdio: "pipe",
    });
    executablePath = path.join(
      copy,
      "Contents/MacOS",
      path.basename(executablePath),
    );
  }
  await mkdir(output, { recursive: true });
  process.chdir(work);
  process.env.INIT_CWD = project;
  for (const check of process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        "keyboard-authoring",
        "mixed-materials",
        "professional-editor",
        "variant-authoring",
        "open-files",
        "publish-reopen",
      ]) {
    if (check === "system-pinyin") await systemPinyin();
    else if (check === "open-files") await openFiles();
    else if (check === "publish-reopen") await publishAndReopen();
    else {
      assert.match(check, /^[a-z-]+$/);
      await editorFlow(check);
    }
  }
  const requested = process.argv.slice(2);
  const exported = [
    "professional-editor",
    "variant-authoring",
    ...(requested.includes("vector-network") ? ["vector-network"] : []),
    ...(requested.includes("text-position") ? ["text-position"] : []),
  ].filter((check) => !requested.length || requested.includes(check));
  if (requested.includes("color-profile"))
    exported.push("color-profile", "color-profile-srgb");
  if (exported.length) {
    execFileSync(
      process.execPath,
      [path.join(project, "scripts/verify-exports.mjs"), ...exported],
      {
        cwd: work,
        env: { ...process.env, BROWSER_ENGINE: "chromium" },
        stdio: "inherit",
      },
    );
  }
} finally {
  process.chdir(origin);
  await rm(work, { recursive: true, force: true });
}
