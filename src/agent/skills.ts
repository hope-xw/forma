export type SkillSource =
  "builtin" | "user" | "workspace" | "external-standard";

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
}

export type SkillCompatibilityLevel = "native" | "adapted" | "limited";

export interface SkillCompatibilityReport {
  level: SkillCompatibilityLevel;
  label: string;
  notes: string[];
  hasExternalUrlFetch: boolean;
  hasScriptDependency: boolean;
  hasCodeCentricRules: boolean;
  resourceCounts: { markdown: number; data: number; other: number };
}

export interface SkillSearchMatch {
  path: string;
  score: number;
  location: string;
  excerpt: string;
  record?: Record<string, string>;
}

export interface SkillResourcePageOptions {
  offset?: number;
  limit?: number;
}

export interface SkillSearchOptions {
  pathPrefix?: string;
  limit?: number;
}

export interface ActivatedSkillPayload {
  id: string;
  name: string;
  description: string;
  instructions: string;
  resources: string[];
  hasScripts?: boolean;
  compatibility?: SkillCompatibilityReport;
  formaAdaptationNote?: string;
}

export interface SkillRuntimeProvider {
  listEnabledSkills(): SkillCatalogEntry[];
  activateSkill(nameOrId: string): ActivatedSkillPayload | null;
  readSkillResource(
    nameOrId: string,
    relativePath: string,
    options?: SkillResourcePageOptions,
  ): {
    path: string;
    content: string;
    truncated?: boolean;
    totalChars?: number;
  } | null;
  searchSkillResources?(
    nameOrId: string,
    query: string,
    options?: SkillSearchOptions,
  ): { matches: SkillSearchMatch[]; searchedFiles: number } | null;
}

export interface SkillSummary extends SkillCatalogEntry {
  sourceLabel: string;
  enabled: boolean;
  editable: boolean;
  location?: string;
  license?: string;
  author?: string;
  version?: string;
  tags: string[];
  resources: string[];
  hasScripts: boolean;
  compatibility: SkillCompatibilityReport;
}

export interface SkillSettings {
  scanExternalStandardDirs: boolean;
  externalDirsDetected: { dir: string; label: string; exists: boolean }[];
}

export interface SkillsListResponse {
  skills: SkillSummary[];
  settings: SkillSettings;
}

interface ParsedSkill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  author?: string;
  version?: string;
  tags: string[];
  body: string;
}

const resourceDirs = new Set([
  "references",
  "assets",
  "themes",
  "data",
  "rules",
  "templates",
  "docs",
  "examples",
  "guides",
]);
export const maxSkillResourcePageChars = 32_768;
export const maxSkillSearchMatches = 16;

// A prefix is only a filter on disclosed paths, never a path to open.
export function validSkillResourcePrefix(prefix: string): boolean {
  const parts = prefix.replace(/\/$/, "").split("/");
  return (
    parts.length <= (prefix.endsWith("/") ? 3 : 4) &&
    (!prefix.includes("/") || resourceDirs.has(parts[0])) &&
    !prefix.includes("..") &&
    !/[\\:\u0000-\u001f\u007f-\u009f]/.test(prefix) &&
    parts.every(
      (part) =>
        part &&
        !part.startsWith(".") &&
        !/[. ]$/.test(part) &&
        !/^(scripts|agents|node_modules)$/i.test(part),
    ) &&
    !(
      parts.length === 1 &&
      /^(skill\.md$|license|readme|changelog)/i.test(parts[0])
    )
  );
}

export function validResourcePath(value: string): boolean {
  return (
    validSkillResourcePrefix(value) &&
    /\.(md|txt|json|csv|tsv|svg|ya?ml|css)$/i.test(value)
  );
}

export function analyzeSkillCompatibility({
  instructions,
  resources,
  hasScripts = false,
}: {
  instructions: string;
  resources: readonly string[];
  hasScripts?: boolean;
}): SkillCompatibilityReport {
  const hasExternalUrlFetch =
    /\bWebFetch\b|\bfetch\b[^\n]{0,200}(?:guidelines|https?:\/\/)|https:\/\/raw\.githubusercontent\.com\b/i.test(
      instructions,
    );
  const hasScriptDependency =
    hasScripts ||
    /\bscripts\/|\b(?:python3?|bash)[ \t]+|\.py\b/i.test(instructions);
  const hasCodeCentricRules =
    /\b(?:tailwind(?:css)?|className|CSS|React|Next\.js)\b|<div\b/i.test(
      instructions,
    );
  const resourceCounts = { markdown: 0, data: 0, other: 0 };
  for (const path of resources) {
    if (/\.(md|txt)$/i.test(path)) resourceCounts.markdown++;
    else if (/\.(csv|tsv|json|ya?ml)$/i.test(path)) resourceCounts.data++;
    else if (/\.(svg|css)$/i.test(path)) resourceCounts.other++;
  }
  const flags = {
    hasExternalUrlFetch,
    hasScriptDependency,
    hasCodeCentricRules,
    resourceCounts,
  };
  if (hasExternalUrlFetch && !resources.length)
    return {
      ...flags,
      level: "limited",
      label: "外部依赖受限",
      notes: [
        "该技能要求联网拉取远端规则且未包含本地参考文件；可补充本地参考文档后离线使用",
      ],
    };
  if (hasScriptDependency)
    return {
      ...flags,
      level: "adapted",
      label: "本地检索适配",
      notes: [
        resources.length
          ? "已安全禁用本地脚本，模型可通过内置只读检索工具查询本地 data/themes/references 数据"
          : "已安全禁用本地脚本，当前仅加载 SKILL.md 正文规范",
      ],
    };
  return {
    ...flags,
    level: "native",
    label: "完全兼容",
    notes: hasCodeCentricRules
      ? ["其中的视觉、配色与排版规范将自动映射为 Forma 原生图层与设计系统属性"]
      : [],
  };
}

export function buildFormaSkillAdaptationNote(
  name: string,
  compatibility: SkillCompatibilityReport,
  resources: readonly string[],
): string {
  return [
    "Apply " +
      name +
      " within the designer's canvas scope. Map its aesthetics and anti-template rules to native Forma layers: bind palette colors to fills or variables, set text styles for hierarchy, and express spacing with auto-layout padding and gap.",
    "Use propose_design_changes when tools are available, or return the Forma Blueprint JSON in single-response mode. Never output HTML/CSS/Tailwind code as the final answer.",
    "For a clear design request, generate a previewable artboard directly without pausing for a skill's confirmation step. Never run Python, Bash or WebFetch.",
    resources.length
      ? "With tools available, use search_skill_resources for local CSV/JSON or multi-file searches. Use read_skill_resource for listed themes/*.md, references/*.md and root companion guides."
      : "Use the supplied SKILL.md guidance.",
    compatibility.level === "limited"
      ? "Remote rules are unavailable offline. Do not claim to have consulted them."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// Supply the same canvas contract to providers written before compatibility reports.
export function withFormaSkillAdaptation(skill: ActivatedSkillPayload) {
  const compatibility = skill.compatibility ?? analyzeSkillCompatibility(skill);
  return {
    ...skill,
    compatibility,
    formaAdaptationNote:
      skill.formaAdaptationNote ??
      buildFormaSkillAdaptationNote(skill.name, compatibility, skill.resources),
  };
}

// Row numbers are logical records, including the header. Quoted CRLFs are data.
function* delimitedRows(text: string, delimiter: string) {
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && !field) quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      yield row;
      row = [];
      field = "";
    } else field += c;
  }
  if (!quoted && (field || row.length)) yield [...row, field];
}

function* textPassages(path: string, text: string) {
  if (/\.json$/i.test(path) && text.trimStart().startsWith("[")) {
    try {
      const items: unknown[] = JSON.parse(text);
      for (const [index, item] of items.entries())
        yield {
          title: "",
          location: "item " + (index + 1),
          body: JSON.stringify(item),
        };
      return;
    } catch {
      /* Malformed JSON is still searchable as local text. */
    }
  }
  let paragraph = 0;
  for (const section of text.split(/^(?=#{1,6}[ \t]+)/m)) {
    const heading = /^(#{1,6})[ \t]+([^\r\n]+)/.exec(section);
    const title = heading?.[2].trim() ?? "";
    const body = section.slice(heading?.[0].length ?? 0).trim();
    for (const piece of body.split(/\r?\n[ \t]*\r?\n/)) {
      if (!piece && !title) continue;
      paragraph++;
      yield {
        title,
        location: title ? "section: " + title : "paragraph " + paragraph,
        body: piece,
      };
    }
  }
}

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
export function searchStructuredSkillContent(
  files: { path: string; content: string }[],
  query: string,
  limit = 8,
): SkillSearchMatch[] {
  const phrase = query.trim().toLowerCase();
  const terms = [
    ...new Set(
      Array.from(segmenter.segment(phrase))
        .filter((s) => s.isWordLike)
        .map((s) => s.segment),
    ),
  ];
  if (!terms.length || !Number.isSafeInteger(limit) || limit < 1) return [];
  const count = Math.min(limit, maxSkillSearchMatches);
  const matches: SkillSearchMatch[] = [];
  function consider(
    path: string,
    location: string,
    body: string,
    title: string,
    record?: () => Record<string, string>,
  ) {
    const lower = body.toLowerCase(),
      heading = title.toLowerCase();
    let score = 0,
      first = Infinity;
    for (const term of terms) {
      const index = lower.indexOf(term);
      const inHeading = heading.includes(term);
      if (index >= 0 || inHeading) {
        score += 8 + (inHeading ? 2 : 0);
        if (index >= 0) first = Math.min(first, index);
      }
    }
    if (!score) return;
    if (lower.includes(phrase) || heading.includes(phrase)) score += 3;
    if (matches.length === count && matches[count - 1].score >= score) return;
    const start = Number.isFinite(first) ? Math.max(0, first - 120) : 0;
    matches.push({
      path,
      location,
      score,
      excerpt: (body || title).slice(start, start + 900),
      ...(record && { record: record() }),
    });
    matches.sort((a, b) => b.score - a.score);
    if (matches.length > count) matches.pop();
  }
  for (const { path, content } of files) {
    if (/\.(csv|tsv)$/i.test(path)) {
      const rows = delimitedRows(content, /\.tsv$/i.test(path) ? "\t" : ",");
      const first = rows.next();
      if (first.done) continue;
      const headers = first.value.map((s) => s.trim());
      let number = 1;
      for (const row of rows) {
        number++;
        if (!row.some(Boolean)) continue;
        consider(path, "row " + number, row.join(" | "), row[0], () =>
          Object.fromEntries(
            row.slice(0, headers.length).map((value, i) => [headers[i], value]),
          ),
        );
      }
    } else {
      for (const { title, location, body } of textPassages(path, content))
        consider(path, location, body, title);
    }
  }
  return matches;
}

// Parse the data-only subset used by SKILL.md. Keys are held in Maps so even
// third-party metadata named "__proto__" remains ordinary data.
type Fields = Map<string, string | string[]>;
const invalidYaml = () => new Error("SKILL.md 的 YAML frontmatter 格式无效");

function scalar(input: string): string {
  const value = input.trim();
  if (value.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/s.exec(value);
    if (!match) throw invalidYaml();
    try {
      return JSON.parse(match[1]) as string;
    } catch {
      throw invalidYaml();
    }
  }
  if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'\s*(?:#.*)?$/s.exec(value);
    if (!match) throw invalidYaml();
    return match[1].replaceAll("''", "'");
  }
  const plain = value.replace(/(?:^|\s+)#.*$/, "").trimEnd();
  return /^(?:null|~)$/i.test(plain) ? "" : plain;
}

// Split flow collections only at unquoted, top-level commas. This also
// accepts the common inline metadata form with a nested tags array.
function flowEntries(text: string, open: string, close: string): string[] {
  const end = text.lastIndexOf(close);
  if (
    text[0] !== open ||
    end < 1 ||
    !/^\s*(?:#.*)?$/s.test(text.slice(end + 1))
  )
    throw invalidYaml();
  const contents = text.slice(1, end);
  const items: string[] = [];
  let start = 0,
    depth = 0,
    quote = "";
  let atValueStart = true;
  for (let i = 0; i < contents.length; i++) {
    const ch = contents[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (quote === "'" && ch === "'" && contents[i + 1] === "'") i++;
      else if (ch === quote) quote = "";
    } else if (atValueStart && (ch === '"' || ch === "'")) {
      quote = ch;
      atValueStart = false;
    } else if (ch === "[" || ch === "{") {
      depth++;
      atValueStart = true;
    } else if (ch === "]" || ch === "}") {
      if (--depth < 0) throw invalidYaml();
      atValueStart = false;
    } else if (ch === ",") {
      if (depth === 0) {
        items.push(contents.slice(start, i).trim());
        start = i + 1;
      }
      atValueStart = true;
    } else if (!/\s/.test(ch)) atValueStart = ch === ":";
  }
  if (quote || depth) throw invalidYaml();
  if (contents.slice(start).trim()) items.push(contents.slice(start).trim());
  return items;
}

function inlineValue(text: string): string | string[] {
  return text.startsWith("[")
    ? flowEntries(text, "[", "]").map(scalar)
    : scalar(text);
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => /^\s*(?:#|$)/.test(line);

function blockText(lines: string[], folded: boolean): string {
  const indent = lines.reduce(
    (min, line) => (line.trim() ? Math.min(min, indentOf(line)) : min),
    Infinity,
  );
  const parts = lines.map((line) => line.slice(indent));
  if (!folded) return parts.join("\n").trimEnd();
  let result = "";
  let previous = "";
  let breaks = 0;
  for (const part of parts) {
    if (part.length) {
      if (breaks && previous && !/^\s/.test(previous) && !/^\s/.test(part))
        result += breaks === 1 ? " " : "\n".repeat(breaks - 1);
      else result += "\n".repeat(breaks);
      result += part;
      previous = part;
      breaks = 0;
    }
    breaks++;
  }
  return result;
}

function parseFields(
  lines: string[],
  indent: number,
  metadata?: Fields,
): Fields {
  const fields: Fields = new Map();
  for (let i = 0; i < lines.length;) {
    const line = lines[i++];
    if (isComment(line)) continue;
    const pair = /^([\w.-]+):(?:\s+(.*)|$)/.exec(line.slice(indent));
    if (indentOf(line) !== indent || !pair) throw invalidYaml();
    const [, key, raw = ""] = pair;
    if (fields.has(key)) throw invalidYaml();
    const nested: string[] = [];
    while (
      i < lines.length &&
      (isComment(lines[i]) ||
        indentOf(lines[i]) > indent ||
        (indentOf(lines[i]) === indent &&
          /^-(?:\s|$)/.test(lines[i].trimStart())))
    ) {
      nested.push(lines[i++]);
    }
    const header = raw.trim();
    const data = nested.filter((entry) => !isComment(entry));
    if (key === "metadata" && metadata && header.startsWith("{")) {
      const pairs = flowEntries(
        [header, ...data.map((line) => line.trim())].join(" "),
        "{",
        "}",
      );
      for (const [k, v] of parseFields(pairs, 0)) metadata.set(k, v);
      fields.set(key, "");
    } else if (!header || header.startsWith("#")) {
      if (key === "metadata" && metadata && data.length) {
        for (const [k, v] of parseFields(nested, indentOf(data[0])))
          metadata.set(k, v);
      }
      if (data.length && data[0].trimStart().startsWith("-")) {
        fields.set(
          key,
          data.map((entry) => {
            const item = /^-\s+(.*)$/.exec(entry.trim());
            if (!item) throw invalidYaml();
            return scalar(item[1]);
          }),
        );
      } else {
        const continuation =
          key !== "metadata" && !/^\s*[\w.-]+:(?:\s|$)/.test(data[0] ?? "")
            ? data.map((line) => line.trim()).join(" ")
            : "";
        fields.set(key, inlineValue(continuation));
      }
    } else if (/^[|>][-+]?\s*(?:#.*)?$/.test(header)) {
      fields.set(
        key,
        blockText(
          nested.filter((line) => !line.trim() || indentOf(line) > indent),
          header[0] === ">",
        ),
      );
    } else {
      fields.set(
        key,
        inlineValue([header, ...data.map((entry) => entry.trim())].join(" ")),
      );
    }
  }
  return fields;
}

export function parseSkillMarkdown(
  raw: string,
  fallbackName?: string,
): ParsedSkill {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const close = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line));
  if (!/^---\s*$/.test(lines[0]) || close < 0) throw invalidYaml();
  let bodyStart = close + 1,
    bodyEnd = lines.length;
  while (bodyStart < bodyEnd && !lines[bodyStart].trim()) bodyStart++;
  while (bodyEnd > bodyStart && !lines[bodyEnd - 1].trim()) bodyEnd--;
  const metadata: Fields = new Map();
  const fields = parseFields(lines.slice(1, close), 0, metadata);
  const value = (map: Fields, key: string) => {
    const field = map.get(key);
    if (Array.isArray(field)) throw new Error(`SKILL.md 的 ${key} 必须是文本`);
    return field?.trim() || undefined;
  };
  const name = value(fields, "name") ?? fallbackName?.trim();
  const description = value(fields, "description");
  if (!name || !description)
    throw new Error("SKILL.md 必须包含非空的 name 和 description");
  const tags = metadata.get("tags") ?? fields.get("tags") ?? [];
  return {
    name,
    description,
    license: value(fields, "license"),
    compatibility: value(fields, "compatibility"),
    author: value(metadata, "author"),
    version: value(metadata, "version"),
    tags: (Array.isArray(tags) ? tags : tags.split(","))
      .map((tag) => tag.trim())
      .filter(Boolean),
    body: lines.slice(bodyStart, bodyEnd).join("\n"),
  };
}

export function slugifySkillId(name: string): string {
  const normalized = name
    .trim()
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{Mark}/gu, "");
  const slug = normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug && slug.length <= 120 && !/[^\x00-\x7f]/.test(normalized))
    return slug;
  // Keep mixed-script names distinct even when they share the same Latin prefix.
  let hash = 2166136261;
  for (const char of normalized)
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return (slug.slice(0, 109) || "skill") + "-" + (hash >>> 0).toString(36);
}

interface BuiltinSkill {
  name: string;
  description: string;
  tags: string[];
  instructions: string;
  resources: Record<string, string>;
}

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  {
    name: "forma-design-system-craft",
    description:
      "在 Forma 搭建页面、组件或响应式画板时，复用已有组件和设计变量，建立清楚的排版层级、间距节奏与实例覆写。",
    tags: ["Forma", "设计系统", "自动布局"],
    instructions: `先用 search_components 查找设计意图对应的组件，记录 libraryId、componentId、variantId 和暴露属性。调用 get_design_system 核对颜色、字号和间距变量的作用域与当前模式。
先确定页面主操作，再用 8px 栅格组织区块。优先用自动布局表达内容关系，让正文区域 Fill，占用剩余宽度，让标签、按钮与纵向内容容器 Hug。用长标题和窄屏复查换行与对齐。
编辑现有实例前读取节点详情。只覆写公开文案、外观和插槽，保留主件关系与受保护的内部结构。提交提案时说明选用的变体，以及需要设计师确认的例外。`,
    resources: {
      "references/spacing-and-typography.md": `# 间距与排版
以 8px 为基本单位。图标与短标签可用 4px，列表项间隔从 8px 开始，卡片内边距从 16px 开始，大区块用 24px 或 32px 拉开层级。已有产品的间距变量优先。
正文可从 16/24px（字号/行高）起步，辅助文案用 14/20px，区块标题用 24/32px。把对应的本地文字样式绑定到文本。列容器用 Fill 宽度、Hug 高度，确认两行标题不会挤出操作按钮。`,
      "references/component-reuse-checklist.md": `# 组件复用核对
1. 用 search_components 按用途检索，核对精确变体 ID、状态、主题及可公开调整的属性。
2. 用 get_design_system 读取变量类型、作用域和当前模式，分别为表面、正文与强调色绑定语义变量。
3. 用已有变体表达状态，用公开的 templateKey 更新文案，用插槽替换图标。需要改变内部结构时先交由设计师决定是否分离实例。
4. 在默认、长文案、窄屏和局部深色模式下检查对齐、换行、触控区域与变量解析。`,
    },
  },
  {
    name: "mobile-h5-accessibility-audit",
    description:
      "审查移动 H5 与 iOS 风格界面的触控、安全区、文字对比度和表单焦点，为设计师提供可定位、可复验的修复提案。",
    tags: ["H5", "iOS", "无障碍"],
    instructions: `先调用 lint_design 检查目标画板，记录问题所在的 nodeId 与测得的文字对比度。按用户完成任务的顺序，从导航、输入到提交逐一复核。优先修复读不清的正文、难以命中的控件和丢失的焦点。
使用 references/wcag-contrast-and-touch.md 核对 44×44pt 热区、安全区、字号阶梯、WCAG AA 对比度和表单状态。每条发现给出节点、当前表现、建议值与复验操作。运行时才能确认的键盘顺序与软键盘遮挡，留到 H5 预览验证。`,
    resources: {
      "references/wcag-contrast-and-touch.md": `# 移动端核对表
- iOS 风格交互目标至少预留 44×44pt；H5 在默认缩放下可按 44×44 CSS px 设计。24px 图标可置于更大的可点击容器中，检查相邻目标的热区是否重叠。
- 固定顶栏与底栏计入 safe-area-inset-top 与 safe-area-inset-bottom。在横屏、带底部手势条及软键盘展开时检查最后一个输入框与提交按钮。
- 从辅助文案 14/20、正文 16/24、标题 24/32（字号/行高，CSS px）建立阶梯。放大文字后检查换行、滚动与控件高度。
- WCAG AA 普通文本对比度至少 4.5:1，大文本至少 3:1（24 CSS px 或约 18.67 CSS px 粗体）。用最终背景和透明度计算；错误状态同时提供文字提示。
- 表单保留可见标签、清晰的键盘焦点和符合阅读顺序的 Tab 导航。提交失败后将焦点移到首个错误项，确认读屏能读出标签与错误原因。`,
    },
  },
];
