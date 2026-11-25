async (page) => {
  const requests = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/agent/"))
      requests.push(r.method() + " " + new URL(r.url()).pathname);
  });
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await page.locator(".editor-canvas").waitFor();
  await page.getByRole("button", { name: "AI 设计助手", exact: true }).click();
  await page.getByText("未连接模型", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "设计需求" }).fill("创建一张卡片");
  if (!(await page.getByRole("button", { name: "生成设计" }).isDisabled()))
    throw Error("Offline generation enabled");
  if (requests.length)
    throw Error("Unexpected gateway access: " + JSON.stringify(requests));
  await page.getByRole("button", { name: "图层", exact: true }).click();
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("Shift+1");
  return { modelRequests: requests.length, manualEditor: true };
};
