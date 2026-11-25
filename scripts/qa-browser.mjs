import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";

export async function launchQaBrowser(engine) {
  if (engine === "chromium")
    return chromium.launch({
      channel: process.env.BROWSER_CHANNEL || "chrome",
    });
  if (engine === "webkit") return webkit.launch();
  if (engine !== "firefox") throw Error("Unknown browser engine " + engine);
  if (process.platform !== "darwin") return firefox.launch();
  // Gecko initializes its application registries separately from -profile.
  // Keep both inside this test run, including when macOS protects Application Support.
  const root = await mkdtemp(path.join(tmpdir(), "forma-firefox-"));
  try {
    const data = path.join(root, "data"),
      cache = path.join(root, "cache");
    await Promise.all([mkdir(data), mkdir(cache)]);
    const browser = await firefox.launch({
      env: { ...process.env, MOZ_APP_DATA: data, MOZ_LOCAL_APP_DATA: cache },
    });
    browser.once("disconnected", () =>
      rm(root, { recursive: true, force: true }).catch(() => {}),
    );
    return browser;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
