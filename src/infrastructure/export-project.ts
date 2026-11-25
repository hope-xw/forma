import { nativeDocumentBlob } from "./native-document";
import { decodeBase64 } from "../domain/asset-bytes";
import { changeProfile } from "../domain/color-profile";
import {
  withProjectManifest,
  maxProjectZipBytes,
  readSourceProject,
  mergeProjectRevision,
  inspectSourceRevision,
} from "./project-revision";
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";
import runtimeSource from "../runtime/FormaRuntime.tsx?raw";
import playerSource from "../runtime/PrototypePlayer.tsx?raw";
import machineSource from "../runtime/prototype-machine.ts?raw";
import routerSource from "../runtime/FileRouter.tsx?raw";
import {
  reactProjectFiles,
  pageForExport,
  imageFilename,
} from "../compiler/runtime";
import { reactFileProject, wireProjectActions } from "../compiler/file-project";
import { openPage, pageList } from "../domain/pages";
import { ancestors } from "../domain/tree";
import type { DesignDocument } from "../domain/document";

async function projectArchive(
  document: DesignDocument,
  selection: string[] = [],
  scope: "selection" | "file" = "selection",
) {
  const player = {
    "src/PrototypePlayer.tsx": playerSource,
    "src/prototype-machine.ts": machineSource,
  };
  const original =
    scope === "file" ? document : pageForExport(document, selection);
  const doc = original.exportColorProfile
    ? changeProfile(original, original.exportColorProfile, "export")
    : original;
  const files =
    scope === "file"
      ? reactFileProject(
          doc,
          selection,
          runtimeSource,
          player,
          routerSource,
          false,
        )
      : reactProjectFiles(doc, runtimeSource, player, false);
  if (scope === "selection")
    files["src/DesignPage.tsx"] = wireProjectActions(
      files["src/DesignPage.tsx"],
    );

  const entries = Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, strToU8(content)]),
  );
  entries["design.forma.json"] = new Uint8Array(
    await nativeDocumentBlob(original).arrayBuffer(),
  );
  for (const [id, asset] of Object.entries(doc.images ?? {})) {
    entries["src/assets/" + imageFilename(id, asset.data)] = decodeBase64(
      asset.data,
    );
  }
  for (const [id, font] of Object.entries(doc.fonts ?? {})) {
    const ext = font.data.startsWith("data:font/otf") ? "otf" : "ttf";
    entries["src/assets/" + id + "." + ext] = decodeBase64(font.data);
  }
  return withProjectManifest(entries, {
    documentId: document.id,
    pageId: document.activePage ?? pageList(document)[0].id,
    scope,
    selection: [
      ...new Set(
        selection.map((id) => ancestors(document, id).at(-1)?.id ?? id),
      ),
    ],
  });
}
// Stream one entry at a time so exporting an embedded design and its original
// images does not require a second contiguous buffer as large as the entire ZIP.
async function saveArchive(entries: Record<string, Uint8Array>, name: string) {
  const parts: Blob[] = [];
  const archive = new Zip((error, bytes) => {
    if (error) throw error;
    if (bytes.length) parts.push(new Blob([new Uint8Array(bytes)]));
  });
  let sliceStart = performance.now();
  for (const [filename, bytes] of Object.entries(entries)) {
    const file = /\.(png|jpe?g|gif|webp|woff2?)$/i.test(filename)
      ? new ZipPassThrough(filename)
      : new ZipDeflate(filename, { level: 4 });
    archive.add(file);
    for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
      const end = Math.min(bytes.length, offset + 512 * 1024);
      file.push(bytes.subarray(offset, end), end === bytes.length);
      if (performance.now() - sliceStart > 40) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
    if (!bytes.length) file.push(bytes, true);
  }
  archive.end();
  const blob = new Blob(parts, { type: "application/zip" });
  const url = URL.createObjectURL(blob),
    anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadReactProject(
  document: DesignDocument,
  selection: string[] = [],
  scope: "selection" | "file" = "selection",
) {
  await saveArchive(
    await projectArchive(document, selection, scope),
    scope === "file" ? "forma-react-file.zip" : "forma-react-project.zip",
  );
}
async function prepareUpdate(document: DesignDocument, zipBytes: Uint8Array) {
  const previous = readSourceProject(zipBytes);
  const { scope, selection, documentId } = previous.manifest;
  if (document.id !== documentId) throw Error("工程来自另一份设计文件");
  if (
    scope === "selection" ||
    pageList(document).some((p) => p.id === previous.manifest.pageId)
  )
    document = openPage(document, previous.manifest.pageId);
  if (
    scope === "selection" &&
    selection.length &&
    !selection.every((id) => document.nodes.some((n) => n.id === id))
  )
    throw Error("请切换至首次导出的页面并确认原选区仍存在");
  const next = await projectArchive(document, selection, scope);
  return { previous, next };
}
export async function previewReactProjectUpdate(
  doc: DesignDocument,
  zipBytes: Uint8Array,
) {
  const { previous, next } = await prepareUpdate(doc, zipBytes);
  return inspectSourceRevision(previous, next);
}
export async function applyReactProjectUpdate(
  doc: DesignDocument,
  zipBytes: Uint8Array,
  resolutions: Record<string, "local" | "incoming">,
): Promise<void> {
  const { previous, next } = await prepareUpdate(doc, zipBytes);
  await saveArchive(
    await mergeProjectRevision(previous, next, resolutions),
    "forma-react-updated.zip",
  );
}
export async function updateReactProject(document: DesignDocument, file: File) {
  if (file.size > maxProjectZipBytes) throw Error("源码 ZIP 超过 512 MiB");
  await applyReactProjectUpdate(
    document,
    new Uint8Array(await file.arrayBuffer()),
    {},
  );
}
