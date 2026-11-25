import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { mobileLibrary } from "../src/design-system/mobile.ts";

const engine = process.env.BROWSER_ENGINE ?? "chromium";
const browser = await { chromium, webkit }[engine].launch(
  engine === "chromium" ? { channel: "chrome" } : {},
);
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(process.env.FORMA_URL ?? "http://127.0.0.1:5173/");
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("资源").click();
  const checked = [];
  for (const component of mobileLibrary.components) {
    await button("查看 " + component.name).click();
    const dialog = page.locator(".library-dialog");
    for (const variant of component.variants) {
      for (const [key, value] of Object.entries(variant.properties)) {
        const select = dialog.getByLabel("预览 " + key, { exact: true });
        if ((await select.inputValue()) !== value)
          await select.selectOption(value);
      }
      const root = variant.nodes.find((n) => n.parentId === null);
      const view = dialog
        .locator(".asset-preview.large [data-node-id]")
        .first();
      const actual = await view.evaluate((el) => [
        el.offsetWidth,
        el.offsetHeight,
        el.querySelectorAll("[data-node-id]").length + 1,
      ]);
      assert.deepEqual(
        actual,
        [
          root.style.width,
          root.style.height,
          variant.nodes.filter((n) => !n.hidden).length,
        ],
        component.name + " " + variant.name,
      );
      for (const [key, value] of Object.entries(variant.properties))
        assert.equal(
          await dialog.getByLabel("预览 " + key, { exact: true }).inputValue(),
          value,
          component.name + " " + key,
        );
      checked.push([component.id, variant.id]);
    }
    await button("插入组件").click();
    await dialog.waitFor({ state: "hidden" });
  }
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  const download = page.waitForEvent("download");
  await button("设计文件").click();
  const doc = JSON.parse(await readFile(await (await download).path(), "utf8"));
  for (const c of mobileLibrary.components) {
    const instance = doc.nodes.find(
      (n) =>
        n.instance?.componentId === c.id &&
        n.instance.libraryId === mobileLibrary.id,
    );
    assert.equal(instance?.instance.variantId, c.variants.at(-1).id, c.name);
  }
  console.log(
    JSON.stringify({
      engine,
      components: mobileLibrary.components.length,
      verifiedVariants: checked,
      insertedAndReopened: mobileLibrary.components.length,
    }),
  );
} finally {
  await browser.close();
}
