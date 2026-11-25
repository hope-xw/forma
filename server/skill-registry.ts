import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  BUILTIN_SKILLS,
  analyzeSkillCompatibility,
  maxSkillResourcePageChars,
  maxSkillSearchMatches,
  parseSkillMarkdown,
  searchStructuredSkillContent,
  slugifySkillId,
  validResourcePath,
  validSkillResourcePrefix,
  withFormaSkillAdaptation,
  type SkillCatalogEntry,
  type SkillRuntimeProvider,
  type SkillResourcePageOptions,
  type SkillSearchOptions,
  type SkillsListResponse,
  type SkillSource,
  type SkillSummary,
} from "../src/agent/skills";
import { defaultAgentConfigDir } from "./agent-config-store";

const maxResourceBytes = 256 * 1024;
const maxResources = 80;
// Retain the source's script dependency across rescans without importing code.
const importedScriptsMarker = ".forma-omitted-scripts";
const maxManifestBytes = 1024 * 1024;
const stateSchema = z.object({
  version: z.literal(1),
  disabledIds: z.array(z.string()),
  scanExternalStandardDirs: z.boolean(),
});
type State = z.infer<typeof stateSchema>;

type ExternalDirectory = { dir: string; label: string };
interface RegistryOptions {
  configDir?: string;
  workspaceDir?: string;
  externalDirs?: readonly (string | ExternalDirectory)[];
}
interface SkillRecord {
  summary: Omit<SkillSummary, "enabled">;
  instructions: string;
  root?: string;
  builtinResources?: Record<string, string>;
}
const sourceLabels: Record<SkillSource, string> = {
  builtin: "Forma 内置",
  user: "用户",
  workspace: "工作区",
  "external-standard": "外部标准目录",
};

// 'root' was canonicalized at discovery. Reject replaced roots, directory
// symlinks and leaf symlinks, including links into scripts/ inside the skill.
function safeFile(root: string, relative: string) {
  const expected = path.resolve(root, relative);
  if (
    !expected.startsWith(root + path.sep) ||
    realpathSync(expected) !== expected
  )
    throw new Error("Skill 文件路径越界或包含符号链接");
  const stat = lstatSync(expected);
  if (!stat.isFile()) throw new Error("Skill 资源必须是普通文件");
  return { expected, stat };
}

function readText(root: string, relative: string, maxBytes: number): string {
  const { expected, stat } = safeFile(root, relative);
  if (stat.size > maxBytes) throw new Error("Skill 文件超出大小上限");
  const fd = openSync(
    expected,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size > maxBytes ||
      realpathSync(expected) !== expected
    )
      throw new Error("Skill 文件已变化或超出大小上限");
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > opened.size) throw new Error("Skill 文件在读取期间发生变化");
    const data = bytes.subarray(0, offset);
    if (data.includes(0)) throw new Error("Skill 资源必须是文本文件");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      data,
    );
  } finally {
    closeSync(fd);
  }
}

function isDirectory(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function* resourcePaths(
  root: string,
  importing = false,
  relativeDir = "",
): Generator<string> {
  const dir = path.join(root, relativeDir);
  let entries: Dirent[];
  try {
    if (!isDirectory(dir) || realpathSync(dir) !== dir) return;
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = relativeDir ? relativeDir + "/" + entry.name : entry.name;
    if (entry.isDirectory() && validSkillResourcePrefix(relative + "/"))
      yield* resourcePaths(root, importing, relative);
    else if (entry.isFile() && validResourcePath(relative)) {
      try {
        const { stat } = safeFile(root, relative);
        if (stat.size > maxResourceBytes || (importing && stat.mode & 0o111))
          continue;
      } catch {
        continue;
      }
      yield relative;
    }
  }
}

function diskRecord(
  root: string,
  source: Exclude<SkillSource, "builtin">,
): SkillRecord {
  const { name, description, body, tags, license, author, version } =
    parseSkillMarkdown(readText(root, "SKILL.md", maxManifestBytes));
  const resources: string[] = [];
  for (const file of resourcePaths(root)) {
    resources.push(file);
    if (resources.length === maxResources) break;
  }
  const hasScripts = isDirectory(path.join(root, "scripts"));
  const omittedScripts =
    source === "user" &&
    lstatSync(path.join(root, importedScriptsMarker), {
      throwIfNoEntry: false,
    })?.isFile();
  return {
    root,
    instructions: body,
    summary: {
      id: slugifySkillId(name),
      name,
      description,
      source,
      sourceLabel: sourceLabels[source],
      editable: source === "user",
      location: path.basename(root),
      tags,
      license,
      author,
      version,
      resources,
      hasScripts,
      compatibility: analyzeSkillCompatibility({
        instructions: body,
        resources,
        hasScripts: hasScripts || omittedScripts,
      }),
    },
  };
}

const importSchema = z.object({
  skillMd: z.string(),
  slug: z
    .string()
    .regex(/^[a-z0-9_-]{1,120}$/, "Skill 目录名无效")
    .optional(),
  resources: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .max(maxResources)
    .optional(),
});
type ImportInput = z.infer<typeof importSchema>;

export class SkillRegistry {
  private readonly configDir: string;
  private readonly workspaceDir: string;
  private readonly externalDirs: ExternalDirectory[];
  private state: State;
  private records = new Map<string, SkillRecord>();

  constructor(options: RegistryOptions = {}) {
    this.configDir = path.resolve(options.configDir ?? defaultAgentConfigDir());
    this.workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
    const external =
      options.externalDirs ??
      [".agents", ".claude", ".codex", ".cursor"].map((tool) => ({
        dir: path.join(homedir(), tool, "skills"),
        label: "~/" + tool + "/skills",
      }));
    this.externalDirs = external.map((item) =>
      typeof item === "string"
        ? { dir: path.resolve(item), label: path.basename(item) }
        : { dir: path.resolve(item.dir), label: item.label },
    );
    this.state = this.readState();
    this.discover();
  }

  private readState(): State {
    try {
      return stateSchema.parse(
        JSON.parse(
          readFileSync(path.join(this.configDir, "agent-skills.json"), "utf8"),
        ),
      );
    } catch {
      return { version: 1, disabledIds: [], scanExternalStandardDirs: false };
    }
  }

  private save(state: State) {
    mkdirSync(this.configDir, { mode: 0o700, recursive: true });
    const target = path.join(this.configDir, "agent-skills.json");
    const tmp = target + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(tmp, target);
    } finally {
      rmSync(tmp, { force: true });
    }
    this.state = state;
  }

  private discover() {
    const records = new Map<string, SkillRecord>();
    const scan = (dir: string, source: Exclude<SkillSource, "builtin">) => {
      try {
        if (!isDirectory(dir)) return;
        const root = realpathSync(dir);
        for (const entry of readdirSync(root, { withFileTypes: true }).sort(
          (a, b) => a.name.localeCompare(b.name),
        )) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          try {
            const record = diskRecord(path.join(root, entry.name), source);
            if (!records.has(record.summary.id))
              records.set(record.summary.id, record);
          } catch {
            // A missing, unreadable or malformed skill must not hide its siblings.
          }
        }
      } catch {
        // Optional roots can be missing, inaccessible, or removed during discovery.
      }
    };
    scan(path.join(this.configDir, "skills"), "user");
    const projectConfig = path.join(this.workspaceDir, ".forma");
    if (isDirectory(projectConfig))
      scan(path.join(projectConfig, "skills"), "workspace");
    if (this.state.scanExternalStandardDirs)
      for (const { dir } of this.externalDirs) scan(dir, "external-standard");
    for (const skill of BUILTIN_SKILLS) {
      const id = skill.name;
      const resources = Object.keys(skill.resources);
      if (!records.has(id))
        records.set(id, {
          summary: {
            id,
            name: skill.name,
            description: skill.description,
            source: "builtin",
            sourceLabel: sourceLabels.builtin,
            editable: false,
            tags: skill.tags,
            hasScripts: false,
            resources,
            compatibility: analyzeSkillCompatibility({
              instructions: skill.instructions,
              resources,
            }),
          },
          instructions: skill.instructions,
          builtinResources: skill.resources,
        });
    }
    this.records = records;
  }

  private summary(record: SkillRecord): SkillSummary {
    const s = record.summary;
    return {
      ...s,
      compatibility: structuredClone(s.compatibility),
      resources: [...s.resources],
      tags: [...s.tags],
      enabled: !this.state.disabledIds.includes(s.id),
    };
  }

  listSkills(): SkillsListResponse {
    return {
      skills: Array.from(this.records.values(), (record) =>
        this.summary(record),
      ),
      settings: {
        scanExternalStandardDirs: this.state.scanExternalStandardDirs,
        externalDirsDetected: this.externalDirs.map(({ dir, label }) => ({
          dir: dir.startsWith(homedir() + path.sep)
            ? "~/" + path.relative(homedir(), dir)
            : path.basename(dir),
          label,
          exists: isDirectory(dir),
        })),
      },
    };
  }

  rescan(): SkillsListResponse {
    this.state = this.readState();
    this.discover();
    return this.listSkills();
  }

  importSkill(input: ImportInput): SkillSummary {
    return this.publishSkill(input, false);
  }

  private publishSkill(
    input: ImportInput,
    omittedScripts: boolean,
  ): SkillSummary {
    const { skillMd, slug, resources = [] } = importSchema.parse(input);
    if (Buffer.byteLength(skillMd) > maxManifestBytes)
      throw new Error("SKILL.md 超出大小上限");
    if (skillMd.includes("\0")) throw new Error("SKILL.md 必须是文本文件");
    const id = slugifySkillId(parseSkillMarkdown(skillMd).name);
    const paths = new Set<string>();
    for (const resource of resources) {
      if (!validResourcePath(resource.path) || paths.has(resource.path))
        throw new Error("Skill 资源路径无效或重复");
      if (Buffer.byteLength(resource.content) > maxResourceBytes)
        throw new Error("Skill 资源超过 256 KiB");
      if (resource.content.includes("\0"))
        throw new Error("Skill 资源必须是文本文件");
      paths.add(resource.path);
    }

    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    const userRoot = path.join(realpathSync(this.configDir), "skills");
    mkdirSync(userRoot, { recursive: true, mode: 0o700 });
    if (!isDirectory(userRoot) || realpathSync(userRoot) !== userRoot)
      throw new Error("Skill 用户目录无效");
    this.discover();
    const dest = path.join(userRoot, slug ?? id);
    if (
      this.records.get(id)?.summary.source === "user" ||
      lstatSync(dest, { throwIfNoEntry: false })
    )
      throw new Error("同名用户 Skill 或目录已存在");
    const staging = mkdtempSync(path.join(userRoot, ".import-"));
    try {
      writeFileSync(path.join(staging, "SKILL.md"), skillMd, {
        mode: 0o600,
        flag: "wx",
      });
      if (omittedScripts)
        writeFileSync(path.join(staging, importedScriptsMarker), "", {
          mode: 0o600,
          flag: "wx",
        });
      for (const resource of resources) {
        const file = path.join(staging, resource.path);
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, resource.content, { mode: 0o600, flag: "wx" });
      }
      renameSync(staging, dest);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    this.rescan();
    const imported = this.records.get(id);
    if (imported?.root !== dest) throw new Error("导入后未能索引此 Skill");
    return this.summary(imported);
  }

  importLocalDirectory(dirPath: string): SkillSummary {
    if (!isDirectory(dirPath)) throw new Error("请选择普通 Skill 目录");
    const root = realpathSync(dirPath);
    const skillMd = readText(root, "SKILL.md", maxManifestBytes);
    parseSkillMarkdown(skillMd);
    const resources = [];
    for (const file of resourcePaths(root, true)) {
      try {
        resources.push({
          path: file,
          content: readText(root, file, maxResourceBytes),
        });
      } catch {
        // A binary, oversized or replaced companion must not discard the manifest.
        continue;
      }
      if (resources.length === maxResources) break;
    }
    return this.publishSkill(
      { skillMd, resources },
      isDirectory(path.join(root, "scripts")),
    );
  }

  setSkillEnabled(id: string, enabled: boolean): SkillsListResponse {
    if (!this.records.has(id)) throw new Error("Skill 不存在");
    const state = this.readState();
    const disabled = new Set(state.disabledIds);
    if (z.boolean().parse(enabled)) disabled.delete(id);
    else disabled.add(id);
    this.save({ ...state, disabledIds: [...disabled] });
    this.discover();
    return this.listSkills();
  }

  updateSettings(patch: {
    scanExternalStandardDirs?: boolean;
  }): SkillsListResponse {
    const { scanExternalStandardDirs } = stateSchema
      .pick({ scanExternalStandardDirs: true })
      .partial()
      .parse(patch);
    const state = this.readState();
    if (scanExternalStandardDirs !== undefined)
      this.save({ ...state, scanExternalStandardDirs });
    return this.rescan();
  }

  deleteUserSkill(id: string): SkillsListResponse {
    const record = this.records.get(id);
    if (record?.summary.source !== "user" || !record.root)
      throw new Error("仅可删除用户 Skill");
    const root = record.root;
    const userRoot = path.join(realpathSync(this.configDir), "skills");
    if (
      path.dirname(root) !== userRoot ||
      realpathSync(root) !== root ||
      diskRecord(root, "user").summary.id !== id
    )
      throw new Error("Skill 目录已更改，请重新扫描");
    rmSync(root, { recursive: true });
    return this.rescan();
  }

  getSkillDetail(id: string): (SkillSummary & { instructions: string }) | null {
    const record = this.records.get(id);
    return record
      ? { ...this.summary(record), instructions: record.instructions }
      : null;
  }

  private enabledRecord(nameOrId: string) {
    const record =
      this.records.get(nameOrId) ?? this.records.get(slugifySkillId(nameOrId));
    if (
      record &&
      (record.summary.name === nameOrId || record.summary.id === nameOrId) &&
      !this.state.disabledIds.includes(record.summary.id)
    )
      return record;
    return null;
  }

  private resourceContent(record: SkillRecord, relativePath: string) {
    if (
      !validResourcePath(relativePath) ||
      !record.summary.resources.includes(relativePath)
    )
      return null;
    try {
      return record.root
        ? readText(record.root, relativePath, maxResourceBytes)
        : record.builtinResources![relativePath];
    } catch {
      return null;
    }
  }

  readSkillResource(
    nameOrId: string,
    relativePath: string,
    options: SkillResourcePageOptions = {},
  ) {
    const { offset = 0, limit = maxSkillResourcePageChars } = options;
    const record = this.enabledRecord(nameOrId);
    if (
      !record ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      return null;
    const text = this.resourceContent(record, relativePath);
    if (text === null) return null;
    const end = offset + Math.min(limit, maxSkillResourcePageChars);
    return {
      path: relativePath,
      content: text.slice(offset, end),
      truncated: end < text.length,
      totalChars: text.length,
    };
  }

  // Direct callers share this registry-local session. Each model conversation
  // receives a fresh session from asRuntimeProvider().
  private readonly directRuntime = this.asRuntimeProvider();

  activateSkill(nameOrId: string) {
    return this.directRuntime.activateSkill(nameOrId);
  }

  searchSkillResources(
    nameOrId: string,
    query: string,
    options?: SkillSearchOptions,
  ) {
    return this.directRuntime.searchSkillResources(nameOrId, query, options);
  }

  asRuntimeProvider() {
    const activated = new Map<string, SkillRecord>();
    const activeRecord = (nameOrId: string) => {
      const current = this.enabledRecord(nameOrId);
      if (!current) return null;
      const active = activated.get(current.summary.id);
      // Another chat may rescan the catalog. Only resources already disclosed
      // by the same skill may survive that rescan.
      return active &&
        active.root === current.root &&
        active.instructions === current.instructions
        ? { active, current }
        : null;
    };
    return {
      listEnabledSkills: (): SkillCatalogEntry[] =>
        Array.from(this.records.values())
          .filter(({ summary }) => !this.state.disabledIds.includes(summary.id))
          .map(({ summary: { id, name, description, source } }) => ({
            id,
            name,
            description,
            source,
          })),
      activateSkill: (nameOrId) => {
        const record = this.enabledRecord(nameOrId);
        if (!record) return null;
        const { id, name, description, resources, hasScripts, compatibility } =
          record.summary;
        activated.set(id, record);
        return withFormaSkillAdaptation({
          id,
          name,
          description,
          resources: [...resources],
          hasScripts,
          compatibility: structuredClone(compatibility),
          instructions: record.instructions,
        });
      },
      readSkillResource: (
        nameOrId,
        relativePath,
        options: SkillResourcePageOptions = {},
      ) => {
        if (
          !activeRecord(nameOrId)?.active.summary.resources.includes(
            relativePath,
          )
        )
          return null;
        return this.readSkillResource(nameOrId, relativePath, options);
      },
      searchSkillResources: (
        nameOrId,
        query,
        options: SkillSearchOptions = {},
      ) => {
        const session = activeRecord(nameOrId);
        const { pathPrefix, limit = 8 } = options;
        if (
          !session ||
          !query.trim() ||
          query.length > 500 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > maxSkillSearchMatches ||
          (pathPrefix !== undefined && !validSkillResourcePrefix(pathPrefix))
        )
          return null;
        const files = [];
        for (const path of session.active.summary.resources) {
          if (pathPrefix && !path.startsWith(pathPrefix)) continue;
          const content = this.resourceContent(session.current, path);
          if (content !== null) files.push({ path, content });
        }
        return {
          matches: searchStructuredSkillContent(files, query, limit),
          searchedFiles: files.length,
        };
      },
    } satisfies SkillRuntimeProvider;
  }
}
