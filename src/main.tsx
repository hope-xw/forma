import "./editor/layers.css";
import "./editor/styles.css";
import "./editor/design-system.css";
import "./editor/ui3-theme.css";
import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { configureTextMetrics } from "./domain/sizing";
import { ErrorBoundary } from "./editor/ErrorBoundary";
import { browserTextMetrics } from "./infrastructure/text-metrics";

const WorkspaceShell = lazy(() =>
  import("./editor/WorkspaceShell").then((m) => ({
    default: m.WorkspaceShell,
  })),
);

const root = createRoot(document.getElementById("root")!);
configureTextMetrics(browserTextMetrics());
try {
  const savedTheme = localStorage.getItem("forma.ui-theme");
  document.documentElement.dataset.theme =
    savedTheme === "light" ? "light" : "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}

root.render(
  <React.StrictMode>
    <ErrorBoundary scope="workspace" title="Forma 工作台遇到意外错误">
      <Suspense
        fallback={
          <main className="forma-boot-loading" role="status" aria-live="polite">
            <span className="design-import-spinner" aria-hidden="true" />
            <span>正在启动 Forma…</span>
          </main>
        }
      >
        <WorkspaceShell />
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
);
