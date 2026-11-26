import type { DesignDocument } from "../domain/document";
import { createStarter } from "../domain/seed";
import { assignFileToProject } from "../infrastructure/project-memory-store";
import {
  createLocalFileWithKey,
  deleteLocalFile,
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

export async function newBlankFile(projectId?: string | null) {
  const doc = createStarter();
  doc.colorProfile = preferredProfile();
  doc.name = "无标题设计";
  doc.nodes = [];
  doc.revision = 0;
  location.assign(await createBrowserFile(doc, projectId));
}
