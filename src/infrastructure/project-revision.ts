import { strFromU8, strToU8, unzipSync } from "fflate";
import { z } from "zod";

type Files = Record<string, Uint8Array>;
export const maxProjectZipBytes = 512 * 1024 * 1024;
const maxExpandedProjectBytes = 1024 * 1024 * 1024;
const manifestName = "forma-project.json";
const manifestSchema = z.object({
  format: z.literal("forma/react-project/1"),
  documentId: z.string(),
  pageId: z.string(),
  scope: z.enum(["selection", "file"]),
  selection: z.array(z.string()),
  localDeletions: z.array(z.string()).optional(),
  generated: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
type Manifest = z.infer<typeof manifestSchema>;
export type ProjectIdentity = Omit<
  Manifest,
  "format" | "generated" | "localDeletions"
>;
const developerFiles = new Set([
  "src/main.tsx",
  "src/business.ts",
  "README.md",
  "package.json",
  "index.html",
  "tsconfig.json",
]);
const generatedPath = (p: string) =>
  /^(?:design(?:\.forma|-system)\.json|src\/(?:tokens\.(?:css|ts)|design-images\.ts|prototype-machine\.ts|pages\.ts|(?:Page[1-9]\d*|DesignPage)\.nodes\.json|(?:DesignPage|FormaRuntime|FileRouter|PrototypePlayer|Page[1-9]\d*)\.tsx|components\/[a-z0-9-]+-[a-f0-9]{16}\.tsx|assets\/[^/]+))$/.test(
    p,
  );
async function hash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function withProjectManifest(
  files: Files,
  identity: ProjectIdentity,
): Promise<Files> {
  const generated: Record<string, string> = {};
  for (const [p, bytes] of Object.entries(files)) {
    if (developerFiles.has(p)) continue;
    if (!generatedPath(p)) throw Error("未登记的生成文件：" + p);
    generated[p] = await hash(bytes);
  }
  const manifest: Manifest = {
    format: "forma/react-project/1",
    ...identity,
    generated,
  };
  return {
    ...files,
    [manifestName]: strToU8(JSON.stringify(manifest, null, 2)),
  };
}
export function readSourceProject(bytes: Uint8Array) {
  if (bytes.byteLength > maxProjectZipBytes)
    throw Error("源码 ZIP 超过 512 MiB");
  let total = 0;
  const entries = unzipSync(bytes, {
    filter: (info) => {
      const path = info.name;
      if (
        path.includes("\\") ||
        path.startsWith("/") ||
        /^(?:[A-Za-z]:)/.test(path) ||
        path.includes("\0") ||
        path.includes("//") ||
        path.split("/").some((p) => p === ".." || p === ".")
      )
        throw Error("工程包含无效路径：" + path);
      if (
        path.startsWith("__MACOSX/") ||
        path.endsWith("/") ||
        path.endsWith(".DS_Store")
      )
        return false;
      if (
        path
          .split("/")
          .some((p) => ["node_modules", ".git", "dist"].includes(p))
      )
        throw Error("请压缩工程源码，排除 node_modules、dist 和 .git。");
      total += info.originalSize;
      if (total > maxExpandedProjectBytes) throw Error("工程解压后超过 1 GiB");
      return true;
    },
  });
  const manifests = Object.keys(entries).filter(
    (p) => p.split("/").at(-1) === manifestName,
  );
  if (manifests.length !== 1)
    throw Error(
      "请选择含 forma-project.json 的 Forma 源码工程 ZIP。旧版工程请先导出新工程，再接入原有业务入口。",
    );
  const prefix = manifests[0].slice(0, -manifestName.length);
  const files: Files = Object.create(null);
  for (const [p, data] of Object.entries(entries)) {
    if (!p.startsWith(prefix)) throw Error("ZIP 中包含多个工程目录");
    files[p.slice(prefix.length)] = data;
  }
  const manifest = manifestSchema.parse(
    JSON.parse(strFromU8(files[manifestName])),
  );
  if (Object.keys(manifest.generated).some((p) => !generatedPath(p)))
    throw Error("工程清单包含非生成文件");
  return { files, manifest };
}
export type ProjectConflict = {
  path: string;
  localContent: string;
  incomingContent: string;
};
export type ProjectRevisionPreview = {
  added: string[];
  modified: string[];
  removed: string[];
  preserved: string[];
  conflicts: ProjectConflict[];
};
type NextFiles = Record<string, string | Uint8Array>;
type SourceProject = ReturnType<typeof readSourceProject>;
function previewContent(data?: Uint8Array) {
  if (!data) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return (
      "data:application/octet-stream;base64," + btoa(strFromU8(data, true))
    );
  }
}
async function revision(previous: SourceProject, nextFiles: NextFiles) {
  let files: Files = Object.fromEntries(
    Object.entries(nextFiles).map(([p, data]) => [
      p,
      typeof data === "string" ? strToU8(data) : data,
    ]),
  );
  if (!Object.hasOwn(files, manifestName)) {
    const { documentId, pageId, scope, selection } = previous.manifest;
    files = await withProjectManifest(files, {
      documentId,
      pageId,
      scope,
      selection,
    });
  }
  const nextManifest = manifestSchema.parse(
    JSON.parse(strFromU8(files[manifestName])),
  );
  if (previous.manifest.documentId !== nextManifest.documentId)
    throw Error("工程来自另一份设计文件");
  const preview: ProjectRevisionPreview = {
    added: [],
    modified: [],
    removed: [],
    preserved: [],
    conflicts: [],
  };
  const paths = new Set([
    ...Object.keys(previous.files),
    ...Object.keys(previous.manifest.generated),
    ...Object.keys(nextManifest.generated),
  ]);
  paths.delete(manifestName);
  const acceptedDeletions = new Set(previous.manifest.localDeletions);
  for (const path of [...paths].sort()) {
    const old = Object.hasOwn(previous.manifest.generated, path)
        ? previous.manifest.generated[path]
        : undefined,
      incoming = Object.hasOwn(nextManifest.generated, path)
        ? nextManifest.generated[path]
        : undefined;
    if (
      incoming &&
      (!generatedPath(path) ||
        !Object.hasOwn(files, path) ||
        (await hash(files[path])) !== incoming)
    )
      throw Error("工程清单与生成文件不符：" + path);
    const localBytes = previous.files[path];
    if (
      old === incoming &&
      (!incoming || localBytes || acceptedDeletions.has(path))
    ) {
      preview.preserved.push(path);
      continue;
    }
    const local = localBytes ? await hash(localBytes) : undefined;
    if (
      (old === incoming && !localBytes) ||
      (local !== old && local !== incoming)
    ) {
      preview.conflicts.push({
        path,
        localContent: previewContent(localBytes),
        incomingContent: previewContent(incoming ? files[path] : undefined),
      });
    } else if (!incoming) preview.removed.push(path);
    else if (!old) preview.added.push(path);
    else preview.modified.push(path);
  }
  return { files, preview, nextManifest };
}
export async function inspectProjectRevision(
  previousArchive: Uint8Array,
  nextFiles: NextFiles,
): Promise<ProjectRevisionPreview> {
  return inspectSourceRevision(readSourceProject(previousArchive), nextFiles);
}
export async function inspectSourceRevision(
  source: SourceProject,
  nextFiles: NextFiles,
): Promise<ProjectRevisionPreview> {
  return (await revision(source, nextFiles)).preview;
}
export async function mergeProjectRevision(
  previous: SourceProject | Uint8Array,
  next: NextFiles,
  resolutions?: Record<string, "local" | "incoming">,
): Promise<Files> {
  const source =
    previous instanceof Uint8Array ? readSourceProject(previous) : previous;
  const { files, preview, nextManifest } = await revision(source, next);
  const output: Files = Object.assign(Object.create(null), source.files);
  for (const { path } of preview.conflicts) {
    const decision =
      resolutions && Object.hasOwn(resolutions, path) && resolutions[path];
    if (decision === "local") continue;
    if (decision !== "incoming")
      throw Error(
        (source.files[path]
          ? "生成文件含本地改动，请先合并："
          : "工程缺少生成文件，请先恢复：") + path,
      );
    if (Object.hasOwn(files, path)) output[path] = files[path];
    else delete output[path];
  }
  for (const path of [...preview.added, ...preview.modified])
    output[path] = files[path];
  for (const path of preview.removed) delete output[path];
  // Record deliberate local deletions against the incoming baseline so a retry
  // succeeds. A later upstream change to that path prompts for a new decision.
  const localDeletions = Object.keys(nextManifest.generated)
    .filter((path) => !Object.hasOwn(output, path))
    .sort();
  if (localDeletions.length) {
    output[manifestName] = strToU8(
      JSON.stringify({ ...nextManifest, localDeletions }, null, 2),
    );
  } else output[manifestName] = files[manifestName];
  return output;
}
