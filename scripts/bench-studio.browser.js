async (page) => {
  const figma = new URL(page.url()).hostname.endsWith("figma.com");
  const paint = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(performance.now() - window.__formaStart),
            ),
          ),
        ),
    );
  const start = () =>
    page.evaluate(() =>
      document.addEventListener(
        "pointerdown",
        () => {
          window.__formaStart = performance.now();
        },
        { capture: true, once: true },
      ),
    );
  const samples = { selection: [], pageSwitch: [] };
  if (!figma) {
    await page
      .getByRole("button", { name: "打开移动设计样例", exact: true })
      .click();
    await page.getByRole("button", { name: /01 iPad/ }).waitFor();
    const pages = [/03 Soundspace/, /02 iPhone/, /01 iPad/],
      counts = await page.evaluate(async () => {
        const doc = await (
          await fetch("/examples/mobile-studio.forma.json")
        ).json();
        return ["sound", "iphone", "ipad"].map(
          (id) =>
            (doc.pages.find((p) => p.id === id).nodes ?? doc.nodes).filter(
              (n) => !n.hidden,
            ).length,
        );
      });
    for (let i = 0; i < 12; i++) {
      const index = i % 3;
      await start();
      await page.getByRole("button", { name: pages[index] }).click();
      await page.waitForFunction(
        (count) => document.querySelectorAll("[data-node-id]").length === count,
        counts[index],
      );
      samples.pageSwitch.push(await paint());
    }
  }
  const names = figma
    ? ["Examples/Sidebar", "Examples/Activity View"]
    : ["分栏导航 · Light", "协作分享 · Light"];
  for (let i = 0; i < 12; i++) {
    const name = names[i % 2];
    const row = figma
      ? page.getByRole("gridcell", { name, exact: true })
      : page.getByRole("button", { name: "选择图层 " + name, exact: true });
    await start();
    await row.click();
    await page.waitForFunction(
      ({ figma, name }) =>
        figma
          ? [...document.querySelectorAll("h1")].some(
              (n) => n.textContent === name,
            )
          : document.querySelector('input[aria-label="名称"]')?.value === name,
      { figma, name },
    );
    samples.selection.push(await paint());
  }
  return Object.fromEntries(
    Object.entries(samples)
      .filter(([, values]) => values.length)
      .map(([key, values]) => {
        const sorted = values.slice().sort((a, b) => a - b);
        return [
          key,
          {
            samples: values.map(Math.round),
            medianMs: Math.round((sorted[5] + sorted[6]) / 2),
            p95Ms: Math.round(sorted[11]),
          },
        ];
      }),
  );
};
