import { launchQaBrowser } from "./qa-browser.mjs";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants, runInThisContext } from "node:vm";

const dir = path.dirname(fileURLToPath(import.meta.url));
const chosen = process.argv.slice(2);
const names = chosen.length
  ? chosen
  : [
      "workspace-home",
      "multi-tab",
      "mcp-agent-runtime",
      "color-profile",
      "professional-editor",
      "container-rules",
      "mixed-materials",
      "mixed-instances",
      "keyboard-authoring",
      "designer-delivery",
      "aura",
      "editing-workflow",
      "atlas",
      "cross-page",
      "responsive-player",
      "shapes",
      "smart-selection",
      "wires",
      "optional-gateway",
      "library-tokens",
      "assets-libraries",
      "library-subscription",
      "library-publish",
      "component-properties",
      "variant-authoring",
      "canvas-component-set",
      "nested-instances",
      "size-limits",
      "strokes",
      "stroke-paints",
      "figma-capsule",
      "files",
      "storage",
      "studio",
      "editor-panels",
      "inspector-layout",
      "panel-dialogs",
      "release-notes",
      "panel-parity",
      "panel-gestures",
      "panel-data-safety",
      "sizing",
      "wrap",
      "responsive",
      "prototype",
      "prototype-input",
      "images",
      "image-paint",
      "group-tint",
      "source-layout",
      "vector",
      "vector-network",
      "booleans",
      "rich-text",
      "text-position",
      "mask",
      "guides",
      "asset-import",
      "figma-new-panels",
      "agent-canvas-chat",
    ];
const engine = process.env.BROWSER_ENGINE || "chromium";
const browser = await launchQaBrowser(engine);
process.env.FORMA_REPO_ROOT = path.resolve(dir, "..");
if (engine !== "chromium") {
  const output = path.resolve("output/playwright", engine);
  await mkdir(output, { recursive: true });
  process.chdir(output);
}
await mkdir("output/playwright", { recursive: true });
try {
  for (const name of names) {
    if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid check name");
    const file =
      name === "layer-tree" || name === "complex"
        ? "bench-" + name + ".browser.js"
        : name === "assets-libraries"
          ? "check-assets-and-libraries.browser.js"
          : "check-" + name + ".browser.js";
    const source = await readFile(path.join(dir, file), "utf8");
    const run = runInThisContext(source, {
      filename: file,
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    const context = await browser.newContext({
      viewport: { width: 1460, height: 960 },
      hasTouch: name === "prototype-input",
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      if (name === "complex" && process.env.FORMA_BENCHMARK_DOCUMENT) {
        const body = await readFile(
          path.resolve(dir, "..", process.env.FORMA_BENCHMARK_DOCUMENT),
        );
        await page.route("**/examples/mobile-studio.forma.json", (route) =>
          route.fulfill({ contentType: "application/json", body }),
        );
      }
      const baseUrl = process.env.FORMA_URL || "http://127.0.0.1:5173/";
      const homeBoot = name === "workspace-home" || name === "multi-tab";
      const targetUrl =
        homeBoot || baseUrl.includes("?") ? baseUrl : baseUrl + "?editor=1";
      await page.goto(targetUrl);
      await page
        .locator(
          homeBoot ? ".workspace-home" : ".editor-canvas, [data-design-id]",
        )
        .first()
        .waitFor({ state: "attached" });
      console.log(
        JSON.stringify({
          check: name,
          result:
            name === "prototype-input"
              ? await run(page, { touch: true })
              : await run(page),
        }),
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
