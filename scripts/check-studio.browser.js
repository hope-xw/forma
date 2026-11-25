async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const doc = () =>
    page.evaluate(async () => {
      const request = indexedDB.open("forma-studio");
      const database = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const read = database
          .transaction("documents")
          .objectStore("documents")
          .get("forma.document.v1");
        return await new Promise((resolve, reject) => {
          read.onsuccess = () => resolve(read.result.current);
          read.onerror = () => reject(read.error);
        });
      } finally {
        database.close();
      }
    });
  const settled = () => page.waitForTimeout(400);
  await page.reload();
  await button("打开移动设计样例").click();
  await settled();
  await page.getByRole("button", { name: /03 Soundspace/ }).click();
  const choose = page.getByRole("button", { name: /选择图层.*声场/ }).first();
  await choose.click();
  const root = page.locator(".design-node.selected[data-node-id]").first(),
    rootId = await root.getAttribute("data-node-id");
  const xpos = page.getByLabel("X", { exact: true });
  const original = Number(await xpos.inputValue()),
    latencies = [];
  for (let i = 0; i < 8; i++) {
    const value = original + 10 + i;
    await xpos.fill(String(value));
    await page.evaluate(() => (window.__studioT = performance.now()));
    await xpos.press("Enter");
    await page.waitForFunction(
      ({ id, value }) =>
        document.querySelector('[data-node-id="' + id + '"]').style.left ===
        value + "px",
      { id: rootId, value },
    );
    latencies.push(
      Math.round(
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                  resolve(performance.now() - window.__studioT),
                ),
              ),
            ),
        ),
      ),
    );
  }
  await settled();
  if (
    (await doc()).nodes.find((n) => n.id === rootId).style.x !==
    original + 17
  )
    throw Error("edit was not saved");
  await button("放大").click();
  const zoom = await page.getByTitle("缩放至 100%").innerText();
  await page.getByRole("button", { name: /01 iPad/ }).click();
  await page.getByRole("button", { name: /03 Soundspace/ }).click();
  if ((await page.getByTitle("缩放至 100%").innerText()) !== zoom)
    throw Error("lost page zoom");
  await button("复制页面").click();
  await settled();
  const copy = await doc();
  if (
    copy.pages.length !== 5 ||
    copy.nodes.length !== 622 ||
    copy.nodes.some((n) => n.id === rootId)
  )
    throw Error("invalid duplicate");
  await page.locator(".file-page.current").hover();
  await button("重命名页面").click();
  await page.getByLabel("页面名称").fill("校验副本");
  await page.getByLabel("页面名称").press("Enter");
  await button("删除此页（可撤销）").click();
  await button("撤销").click();
  await button("校验副本").waitFor();
  await button("新建页面").click();
  await settled();
  if ((await doc()).nodes.length !== 0) throw Error("new page not empty");
  await button("撤销").click();
  await settled();
  await page.reload();
  await button("校验副本").waitFor();
  if (errors.length) throw Error(errors.join(";"));
  return {
    editSamplesMs: latencies,
    checked: [
      "编辑并保存坐标",
      "返回页面保留缩放",
      "622层独立复制",
      "改名",
      "删除与撤销",
      "新增空页",
      "刷新恢复",
    ],
    runtimeErrors: errors,
  };
};
