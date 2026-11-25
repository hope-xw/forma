import { readNativeDocument } from "./infrastructure/native-document";
import { isExternalDesign } from "./infrastructure/design-import/types";
import { loadFonts } from "./infrastructure/font-import";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./editor/App";
import "./editor/styles.css";
import "./editor/design-system.css";
import "./editor/ui3-theme.css";
import {
  BrowserDocumentRepository,
  createLocalFile,
} from "./infrastructure/storage";
import { openPage } from "./domain/pages";
import { parseDocument } from "./domain/document";
import { configureTextMetrics } from "./domain/sizing";
import { browserTextMetrics } from "./infrastructure/text-metrics";
import type { EditorFileOptions } from "./editor/useDocument";
const root = createRoot(document.getElementById("root")!);
configureTextMetrics(browserTextMetrics());
try {
  const savedTheme = localStorage.getItem("forma.ui-theme");
  document.documentElement.dataset.theme =
    savedTheme === "light" ? "light" : "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}
function renderBootState(message: string) {
  root.render(
    <main className="forma-boot-loading" role="status" aria-live="polite">
      <span className="design-import-spinner" aria-hidden="true" />
      <span>{message}</span>
    </main>,
  );
}
async function launch() {
  const params = new URLSearchParams(location.search);
  const openingFile = params.has("file") || !!window.formaDesktop;
  if (openingFile) renderBootState("正在载入设计文件…");
  let selected: File | undefined;
  try {
    const bridge = window.formaDesktop;
    const pending = await bridge?.consumePendingFile();
    if (bridge && pending) {
      renderBootState(`正在读取 ${pending.name}…`);
      const parts: Blob[] = [];
      let received = 0;
      while (received < pending.size) {
        const chunk = await bridge.readPendingChunk();
        if (!chunk.length || received + chunk.length > pending.size)
          throw Error("文件长度不符");
        parts.push(new Blob([chunk]));
        received += chunk.length;
      }
      selected = new File(parts, pending.name);
    }
  } catch (error) {
    root.render(
      <main role="alert">
        打开文件失败。{error instanceof Error ? error.message : String(error)}{" "}
        <a href="./">返回工作台</a>
      </main>,
    );
    return;
  }
  if (selected && !(await isExternalDesign(selected))) {
    try {
      renderBootState(`正在打开 ${selected.name}…`);
      const doc = await readNativeDocument(selected);
      location.replace(await createLocalFile(doc));
    } catch (error) {
      root.render(
        <main role="alert">
          打开 {selected.name} 失败。
          {error instanceof Error ? error.message : String(error)}{" "}
          <a href="./">返回工作台</a>
        </main>,
      );
    }
    return;
  }
  const example = params.get("example");
  const sample = example === "mobile-studio" || example === "aura-showcase";
  const repository = new BrowserDocumentRepository(
    example === "aura-showcase"
      ? "forma.example.aura-showcase.v1"
      : example === "mobile-studio"
        ? params.get("edition") === "atlas"
          ? "forma.example.mobile-studio.atlas"
          : params.get("edition") === "flows"
            ? "forma.example.mobile-studio.flows"
            : "forma.example.mobile-studio.v1"
        : /^forma\.file\.[a-f0-9-]{36}$/.test(params.get("file") ?? "")
          ? params.get("file")!
          : undefined,
  );
  const options: EditorFileOptions = {
    repository,
    fileKey: repository.key,
    externalFile: selected,
  };
  try {
    options.initialDocument = (await repository.load()) ?? undefined;
  } catch {
    options.loadError =
      "本机文件无法读取。可以从文件菜单下载存储备份，或恢复上个版本。";
  }
  if (sample && !options.initialDocument && !options.loadError) {
    const response = await fetch(
      import.meta.env.BASE_URL +
        (example === "aura-showcase"
          ? "examples/aura-showcase.forma.json"
          : "examples/mobile-studio.forma.json"),
    );
    if (!response.ok) throw new Error("未能加载设计样例");
    options.initialDocument = parseDocument(await response.json());
    options.initialSaved = false;
  }
  await loadFonts(options.initialDocument?.fonts);
  const doc = options.initialDocument,
    page = params.get("page"),
    node = params.get("node");
  if (doc && page && doc.pages?.some((p) => p.id === page))
    options.initialDocument = openPage(doc, page);
  if (node && options.initialDocument?.nodes.some((n) => n.id === node))
    options.initialSelection = [node];
  root.render(
    <React.StrictMode>
      <App {...options} />
    </React.StrictMode>,
  );
}
launch().catch(() =>
  root.render(
    <main role="alert">
      文件加载失败。<a href="./">返回工作台</a>
    </main>,
  ),
);
