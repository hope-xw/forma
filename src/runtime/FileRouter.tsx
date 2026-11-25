import {
  lazy,
  Suspense,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import type { DesignAction } from "./FormaRuntime";

export type ExportedPage = {
  id: string;
  name: string;
  screens: { id: string; name: string }[];
  load: () => Promise<{
    default: ComponentType<{ flow?: string; onAction?: DesignAction }>;
  }>;
};
function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
export function FileRouter({
  pages,
  start,
  screen,
  onAction,
}: {
  pages: ExportedPage[];
  start: string;
  screen?: string;
  onAction?: DesignAction;
}) {
  const hash = useSyncExternalStore(
    subscribe,
    () => location.hash.slice(1),
    () => "",
  );
  const flow =
    screen ?? (hash ? new URLSearchParams(hash).get("screen") : start);
  const owner = pages.find((page) =>
    page.screens.some((screen) => screen.id === flow),
  );
  const View = useMemo(() => owner && lazy(owner.load), [owner]);
  if (View && flow)
    return (
      <Suspense fallback={<main aria-busy="true" />}>
        <View key={flow} flow={flow} onAction={onAction} />
      </Suspense>
    );
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        margin: "3rem auto",
        maxWidth: 720,
        padding: "0 1.5rem",
      }}
    >
      <h1>画板目录</h1>
      {pages.map((page) => (
        <section key={page.id}>
          <h2>{page.name}</h2>
          <ul>
            {page.screens.map((screen) => (
              <li key={screen.id}>
                <a href={"#screen=" + encodeURIComponent(screen.id)}>
                  {screen.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
