import type { DesignDocument } from "../domain/document";
import { createStarter } from "../domain/seed";
import {
  encodeFormaPackage,
  formaFilename,
  formaPackageBlob,
} from "../infrastructure/native-document";
import { assignFileToProject } from "../infrastructure/project-memory-store";
import {
  createLocalFileWithKey,
  deleteLocalFile,
  download,
} from "../infrastructure/storage";
import { preferredProfile } from "./ColorProfileDialog";

export function ownLibrary(
  libraries: DesignDocument["libraries"],
  id?: string | null,
) {
  return id && libraries && Object.hasOwn(libraries, id)
    ? libraries[id]
    : undefined;
}

export async function createBrowserFile(
  doc: DesignDocument,
  projectId?: string | null,
) {
  const { key, url } = await createLocalFileWithKey(doc);
  if (projectId) {
    try {
      await assignFileToProject(key, projectId, {
        migrateDraftEpisodes: false,
        requireDurable: true,
      });
    } catch (error) {
      try {
        await deleteLocalFile(key);
      } catch (cleanupError) {
        throw new Error(
          `归入项目失败（${error instanceof Error ? error.message : String(error)}），也未能确认已移除新文件「${doc.name}」：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      throw error;
    }
  }
  return url;
}

export type QuickStartPreset = "blank" | "mobile" | "desktop" | "ai";

export function homeUrl(): string {
  return "./";
}

export function editorFileUrl(
  fileUrlString: string,
  preset?: QuickStartPreset,
): string {
  // Older workspaces store the original untitled document at the root URL.
  const base = fileUrlString === "./" ? "?editor=1" : fileUrlString;
  if (!preset || preset === "blank") return base;
  const [beforeHash, hash] = base.split(/#(.*)/s);
  const [path, query] = beforeHash.split("?");
  const params = new URLSearchParams(query);
  params.delete("ai");
  params.delete("preset");
  if (preset === "ai") params.set("ai", "1");
  else params.set("preset", preset);
  return (
    path + "?" + params.toString() + (hash === undefined ? "" : "#" + hash)
  );
}

export async function newDesignFile(options?: {
  projectId?: string | null;
  preset?: QuickStartPreset;
  name?: string;
}): Promise<void> {
  const doc = createStarter();
  doc.colorProfile = preferredProfile();
  doc.name = options?.name ?? "无标题设计";
  doc.nodes = [];
  doc.revision = 0;
  const url = await createBrowserFile(doc, options?.projectId);
  location.assign(editorFileUrl(url, options?.preset));
}

export async function newBlankFile(projectId?: string | null) {
  await newDesignFile({ projectId, preset: "blank" });
}

export function downloadFormaFile(doc: DesignDocument, appVersion?: string) {
  const filename = formaFilename(doc.name);
  download(filename, formaPackageBlob(doc, { appVersion }));
  return filename;
}

export async function saveFormaDocument(
  doc: DesignDocument,
  options?: { fileKey?: string; saveAs?: boolean; appVersion?: string },
): Promise<
  | { saved: true; fileName: string; filePath?: string }
  | { saved: false; canceled: true }
> {
  const suggestedName = formaFilename(doc.name);
  const desktop =
    typeof window !== "undefined" ? window.formaDesktop : undefined;
  if (desktop?.saveNativeFile) {
    const bytes = encodeFormaPackage(doc, { appVersion: options?.appVersion });
    return desktop.saveNativeFile({
      bytes,
      suggestedName,
      fileKey: options?.fileKey,
      saveAs: options?.saveAs,
    });
  }
  download(
    suggestedName,
    formaPackageBlob(doc, { appVersion: options?.appVersion }),
  );
  return { saved: true, fileName: suggestedName };
}
