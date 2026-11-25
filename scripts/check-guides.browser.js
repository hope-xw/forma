async (page) => {
  const b = (name) => page.getByRole("button", { name, exact: true });
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("Shift+R");
  const ruler = page.getByLabel("水平标尺");
  await ruler.waitFor();
  const r = await ruler.boundingBox();
  const x = r.x + r.width * 0.67,
    y = r.y + 220;
  await page.mouse.move(x, r.y + 8);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
  const guide = page.locator(".guide-y");
  await guide.waitFor();
  const initial = Number(await guide.getAttribute("data-guide-value"));
  await guide.focus();
  await page.keyboard.press("Shift+ArrowDown");
  if (Number(await guide.getAttribute("data-guide-value")) !== initial + 10)
    throw Error("Arrow nudge failed");
  await b("新建页面").click();
  if (await guide.count()) throw Error("Page guide leaked");
  await b("撤销").click();
  await guide.waitFor();
  await page.locator('[title="已保存到此浏览器"]').waitFor();
  await page.reload();
  await b("标尺与辅助线").click();
  await guide.waitFor();
  if (Number(await guide.getAttribute("data-guide-value")) !== initial + 10)
    throw Error("Guide not saved");
  let box = await guide.boundingBox();
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, r.y + 4, { steps: 6 });
  await page.mouse.up();
  if (await guide.count())
    throw Error("Returning guide to ruler did not remove it");
  await b("撤销").click();
  await guide.waitFor();
  await b("预览").click();
  if (await page.locator("[role=dialog] .ruler-guide").count())
    throw Error("Guide leaked into preview");
  return {
    coordinate: initial + 10,
    pageIsolation: true,
    restored: true,
    removedByDrag: true,
  };
};
