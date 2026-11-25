import type { DesignDocument } from "../domain/document";
import { openPage, pageList } from "../domain/pages";
import { linkedPrototypeScene, nodeInteractions } from "../domain/prototype";
import { ancestors } from "../domain/tree";
import {
  exportInteractiveReact,
  reactProjectBase,
  unwrapSectionsAndSlices,
} from "./runtime";

/** Generated pages expose (layerId, value) as their business integration API. */
export function wireProjectActions(source: string) {
  return source.replace(
    'import { PrototypePlayer } from "./PrototypePlayer";',
    'import { ProjectPrototypePlayer as PrototypePlayer } from "./PrototypePlayer";',
  );
}
/** Compile each page into a lazy route and retain the editable file alongside its shared runtime. */
export function reactFileProject(
  doc: DesignDocument,
  selection: string[],
  runtime: string,
  player: Record<string, string>,
  router: string,
  includeDesign = true,
) {
  const files = reactProjectBase(doc, runtime, includeDesign);
  Object.assign(files, player);
  files["src/FileRouter.tsx"] = router;
  const manifest: string[] = [];
  let start = "";
  for (const [index, entry] of pageList(doc).entries()) {
    const page = openPage(doc, entry.id);
    const unwrapped = unwrapSectionsAndSlices(page);
    const roots = unwrapped.nodes.filter((n) => !n.parentId);
    const scope = linkedPrototypeScene(page);
    const moduleName = "Page" + (index + 1);
    try {
      files["src/" + moduleName + ".tsx"] = wireProjectActions(
        exportInteractiveReact(scope, true, true, {
          module: moduleName,
          files,
        }),
      );
    } catch (error) {
      throw Error(
        entry.name +
          " · " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    const active = entry.id === (doc.activePage ?? pageList(doc)[0].id);
    const selected =
      active &&
      selection.length &&
      unwrapped.nodes.some((n) => n.id === selection[0])
        ? (ancestors(unwrapped, selection[0]).at(-1)?.id ?? selection[0])
        : "";
    const first =
      roots.find((n) => n.id === selected)?.id ??
      roots.find((n) => nodeInteractions(n).some((r) => r.flow))?.id ??
      roots[0]?.id;
    if (first && (active || !start)) start = first;
    manifest.push(
      "{ id: " +
        JSON.stringify(entry.id) +
        ", name: " +
        JSON.stringify(entry.name) +
        ", screens: " +
        JSON.stringify(roots.map(({ id, name }) => ({ id, name }))) +
        ', load: () => import("./' +
        moduleName +
        '") }',
    );
  }
  files["src/pages.ts"] =
    'import type { ExportedPage } from "./FileRouter";\nexport const pages: ExportedPage[] = [\n  ' +
    manifest.join(",\n  ") +
    "\n];\nexport const start = " +
    JSON.stringify(start) +
    ";\n";
  files["src/DesignPage.tsx"] =
    'import type { DesignAction } from "./FormaRuntime";\nimport { FileRouter } from "./FileRouter";\nimport { pages, start } from "./pages";\nexport default function DesignPage({ screen, onAction }: {screen?: string; onAction?: DesignAction}) { return <FileRouter pages={pages} start={start} screen={screen} onAction={onAction}/>; }\n';
  files["README.md"] +=
    "\nThe complete file is split into lazy page modules. Open /#screens for the artboard directory, or /#screen=<URL-encoded layer ID> for a direct link. src/pages.ts maps each page and artboard to its module. Pass a stable screen ID to <DesignPage screen={screenId}/> to use an application-owned route without changing its URL. Import a page component and pass flow and onAction to embed it without the file router.\n";
  return files;
}
