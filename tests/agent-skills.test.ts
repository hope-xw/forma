import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { sessionRequest } from "../server/agent-sessions";
import { SkillRegistry } from "../server/skill-registry";
import {
  analyzeSkillCompatibility,
  parseSkillMarkdown,
  searchStructuredSkillContent,
  slugifySkillId,
} from "../src/agent/skills";
import { createNode, type DesignDocument } from "../src/domain/document";
import { emptyDesignSystem } from "../src/domain/design-system-schema";

const craft = "forma-design-system-craft";
const audit = "mobile-h5-accessibility-audit";
const guide = "references/guide.md";
const manifest = (name: string, description = "Design guide") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# Instructions\nUse the reference.`;
function write(dir: string, relative: string, content: string) {
  const dest = path.join(dir, relative);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, content);
}
function fixture(t: TestContext) {
  const base = mkdtempSync(path.join(tmpdir(), "forma-skills-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const configDir = path.join(base, ".forma"),
    workspaceDir = path.join(base, "workspace"),
    external = path.join(base, "external");
  const options = { configDir, workspaceDir, externalDirs: [external] };
  return {
    base,
    configDir,
    user: path.join(configDir, "skills"),
    workspace: path.join(workspaceDir, ".forma", "skills"),
    external,
    open: () => new SkillRegistry(options),
  };
}

test("frontmatter parses quoted values, folded paragraphs, metadata and inline lists without granting allowed-tools", () => {
  const raw = [
    "---",
    "name: 'team''s craft' # public name",
    "description: >-",
    "  Build layouts",
    "  with tokens.",
    "",
    "  Audit in preview.",
    "license: MIT",
    'compatibility: "Forma #1: Web"',
    "allowed-tools:",
    "- search_components",
    "- lint_design",
    "metadata:",
    '  author: "Design: Systems"',
    '  version: "01.20"',
    `  tags: [mobile, "UI, H5", 'team''s guide'] # tags`,
    "---",
    "",
    "# Rules",
    "",
    "---",
    "Keep this divider.",
  ].join("\r\n");
  assert.deepEqual(parseSkillMarkdown("\uFEFF" + raw), {
    name: "team's craft",
    description: "Build layouts with tokens.\nAudit in preview.",
    license: "MIT",
    compatibility: "Forma #1: Web",
    author: "Design: Systems",
    version: "01.20",
    tags: ["mobile", "UI, H5", "team's guide"],
    body: "# Rules\n\n---\nKeep this divider.",
  });
});

test("frontmatter supports block lists and literals, reports missing fields and malformed declarations", () => {
  const parsed = parseSkillMarkdown(
    "---\ndescription: |\n  Line one\n  # Literal heading\nmetadata:\n  tags:\n    - design\n    - 'with # hash'\n---\nbody",
    "fallback",
  );
  assert.equal(parsed.name, "fallback");
  assert.equal(parsed.description, "Line one\n# Literal heading");
  assert.deepEqual(parsed.tags, ["design", "with # hash"]);
  for (const raw of [
    "# Name",
    "---\nname: broken",
    "---\nname: n\n---",
    "---\ndescription: d\n---",
    "---\nname: []\ndescription: d\n---",
    "---\nname: n\ndescription: null\n---",
    "---\nname: n\nname: x\ndescription: d\n---",
    '---\nname: "unterminated\ndescription: d\n---',
  ])
    assert.throws(() => parseSkillMarkdown(raw), /SKILL.md/);
  assert.match(slugifySkillId("../../规范/工具"), /^[a-z0-9_-]+$/);
  assert.notEqual(slugifySkillId("规范"), slugifySkillId("示例"));
  assert.notEqual(slugifySkillId("Forma 规范"), slugifySkillId("Forma 示例"));
  assert.equal(slugifySkillId("Team Guide"), "team-guide");
});

test("inline YAML metadata handles nested tags and preserves Markdown code-block indentation", () => {
  const skill = parseSkillMarkdown(
    [
      "---",
      "name: inline",
      "description: review",
      `metadata: {author: 'Design, Inc.', version: "1.0", tags: [ui, "iOS, H5"]}`,
      "---",
      "",
      "    read guide.md",
      "",
    ].join("\n"),
  );
  assert.equal(skill.author, "Design, Inc.");
  assert.equal(skill.version, "1.0");
  assert.deepEqual(skill.tags, ["ui", "iOS, H5"]);
  assert.equal(skill.body, "    read guide.md");
});

test("discovery uses user > workspace > opted-in external > builtin; malformed skills do not mask valid records", (t) => {
  const f = fixture(t);
  write(f.external, "shadow/SKILL.md", manifest(craft, "external"));
  write(f.external, "only/SKILL.md", manifest("external-only"));
  write(f.workspace, "bad/SKILL.md", "---\nname: bad\n---");
  const registry = f.open();
  assert.equal(registry.listSkills().settings.scanExternalStandardDirs, false);
  assert.deepEqual(
    registry
      .listSkills()
      .skills.map((s) => s.id)
      .sort(),
    [craft, audit].sort(),
  );
  assert.deepEqual(registry.listSkills().settings.externalDirsDetected, [
    { dir: "external", label: "external", exists: true },
  ]);
  registry.updateSettings({ scanExternalStandardDirs: true });
  assert.equal(registry.getSkillDetail(craft)?.source, "external-standard");
  assert.equal(f.open().getSkillDetail("external-only")?.enabled, true);
  write(f.workspace, "team/SKILL.md", manifest(craft, "workspace"));
  registry.rescan();
  assert.equal(registry.getSkillDetail(craft)?.source, "workspace");
  assert.throws(() => registry.deleteUserSkill(craft), /仅可删除/);
  const user = registry.importSkill({
    skillMd: manifest(craft, "user"),
    slug: "custom-folder",
  });
  assert.equal(user.source, "user");
  assert.equal(user.location, "custom-folder");
  assert.equal(
    registry.listSkills().skills.filter((s) => s.name === craft).length,
    1,
  );
  assert.equal(
    registry.deleteUserSkill(craft).skills.find((s) => s.id === craft)
      ?.description,
    "workspace",
  );
  registry.updateSettings({ scanExternalStandardDirs: false });
  assert.equal(f.open().getSkillDetail("external-only"), null);
  assert.ok(existsSync(path.join(f.external, "only/SKILL.md")));
});

test("imports publish a complete user directory, persist enablement privately, and only delete user skills", (t) => {
  const f = fixture(t);
  const registry = f.open();
  const skillMd = manifest("Team Guide");
  const resources = [
    { path: guide, content: "8px" },
    { path: "assets/tokens.json", content: '{"space":8}' },
  ];
  const summary = registry.importSkill({ skillMd, resources });
  assert.equal(summary.id, "team-guide");
  assert.equal(summary.editable, true);
  assert.equal(summary.enabled, true);
  assert.equal(
    readFileSync(path.join(f.user, summary.id, "SKILL.md"), "utf8"),
    skillMd,
  );
  assert.equal(
    readFileSync(path.join(f.user, summary.id, guide), "utf8"),
    "8px",
  );
  assert.throws(
    () => registry.importSkill({ skillMd, slug: "another-name" }),
    /已存在/,
  );
  assert.throws(
    () =>
      registry.importSkill({
        skillMd: "---\ndescription: invalid\n---",
        slug: "fallback",
      }),
    /name/,
  );
  assert.throws(
    () =>
      registry.importSkill({ skillMd: manifest("Other"), slug: summary.id }),
    /已存在/,
  );
  assert.throws(() => registry.importSkill({ skillMd, slug: "../outside" }));
  assert.throws(
    () => registry.importSkill({ skillMd: manifest("binary") + "\0" }),
    /文本文件/,
  );
  assert.equal(existsSync(path.join(f.user, "binary")), false);
  assert.equal(
    registry.getSkillDetail(summary.id)?.instructions,
    "# Instructions\nUse the reference.",
  );
  registry.setSkillEnabled(summary.id, false);
  const state = path.join(f.configDir, "agent-skills.json");
  assert.equal(statSync(f.configDir).mode & 0o777, 0o700);
  assert.equal(statSync(state).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), {
    version: 1,
    disabledIds: [summary.id],
    scanExternalStandardDirs: false,
  });
  const reopened = f.open();
  assert.equal(reopened.getSkillDetail(summary.id)?.enabled, false);
  assert.equal(reopened.asRuntimeProvider().activateSkill("Team Guide"), null);
  reopened.setSkillEnabled(summary.id, true);
  assert.ok(reopened.asRuntimeProvider().activateSkill("Team Guide"));
  assert.throws(() => reopened.deleteUserSkill(craft), /仅可删除/);
  reopened.deleteUserSkill(summary.id);
  assert.equal(existsSync(path.join(f.user, summary.id)), false);
  assert.equal(f.open().getSkillDetail(summary.id), null);
});

test("runtime L1 summaries, L2 activation and L3 resources stay separate and respect disablement", (t) => {
  const registry = fixture(t).open();
  const runtime = registry.asRuntimeProvider();
  for (const s of runtime.listEnabledSkills()) {
    assert.deepEqual(Object.keys(s).sort(), [
      "description",
      "id",
      "name",
      "source",
    ]);
    const detail = registry.getSkillDetail(s.id)!;
    assert.equal(runtime.readSkillResource(s.id, detail.resources[0]), null);
    const activated = runtime.activateSkill(s.name)!;
    assert.match(
      activated.instructions,
      s.id === craft ? /search_components/ : /lint_design/,
    );
    assert.deepEqual(activated.resources, detail.resources);
    registry.rescan();
    for (const path of activated.resources) {
      assert.equal(
        registry.asRuntimeProvider().readSkillResource(s.id, path),
        null,
      );
      assert.ok(runtime.readSkillResource(s.id, path)?.content.startsWith("#"));
    }
    assert.equal(
      runtime.readSkillResource(s.id, "references/missing.md"),
      null,
    );
    registry.setSkillEnabled(s.id, false);
    assert.equal(runtime.activateSkill(s.id), null);
    assert.equal(runtime.readSkillResource(s.id, detail.resources[0]), null);
    assert.ok(!runtime.listEnabledSkills().some((entry) => entry.id === s.id));
  }
});

test("import and reads reject unsafe paths, oversized UTF-8 resources and post-scan file or directory links", (t) => {
  const f = fixture(t);
  const registry = f.open();
  const resource = { path: guide, content: "ok" };
  registry.importSkill({ skillMd: manifest("bounded"), resources: [resource] });
  const skillDir = path.join(f.user, "bounded");
  const file = path.join(skillDir, guide);
  const runtime = registry.asRuntimeProvider();
  runtime.activateSkill("bounded");
  for (const bad of [
    "../SKILL.md",
    "/etc/passwd",
    "references/../../secret",
    "scripts/run.sh",
    "references/tool.js",
    "references/../SKILL.md",
    "assets/..\\secret.txt",
    "C:\\outside.md",
    "references//guide.md",
    "themes/scripts/palette.csv",
    "data/AGENTS/private.md",
    "docs/.git/config.md",
    "examples/node_modules/package.json",
    "guides/.hidden.md",
    ".private.md",
    "color\u007fchart.md",
    "sKiLl.Md",
    "README-design.md",
    "LICENSE.txt",
    "Changelog-2025.md",
  ]) {
    assert.equal(runtime.readSkillResource("bounded", bad), null);
    assert.equal(
      runtime.searchSkillResources("bounded", "secret", { pathPrefix: bad })
        ?.searchedFiles ?? 0,
      0,
    );
    assert.throws(
      () =>
        registry.importSkill({
          skillMd: manifest("bad"),
          resources: [resource, { path: bad, content: "invalid" }],
        }),
      /路径/,
    );
  }
  assert.throws(
    () =>
      registry.importSkill({
        skillMd: manifest("bad"),
        resources: [{ path: guide, content: "界".repeat(88_000) }],
      }),
    /256 KiB/,
  );
  assert.deepEqual(readdirSync(f.user), ["bounded"]);
  const maxBytes = 256 * 1024;
  writeFileSync(file, "x".repeat(maxBytes - 4) + "late");
  const first = runtime.readSkillResource("bounded", guide)!;
  assert.equal(first.content.length, 32_768);
  assert.equal(first.truncated, true);
  assert.equal(first.totalChars, maxBytes);
  assert.deepEqual(
    runtime.readSkillResource("bounded", guide, {
      offset: maxBytes - 4,
      limit: 4,
    }),
    {
      path: guide,
      content: "late",
      truncated: false,
      totalChars: maxBytes,
    },
  );
  assert.match(
    runtime.searchSkillResources("bounded", "late")!.matches[0].excerpt,
    /late/,
  );
  writeFileSync(file, "x".repeat(maxBytes + 1));
  const noFiles = { matches: [], searchedFiles: 0 };
  assert.deepEqual(runtime.searchSkillResources("bounded", "x"), noFiles);
  assert.equal(runtime.readSkillResource("bounded", guide), null);
  write(f.base, "private/guide.md", "outside");
  rmSync(file);
  symlinkSync(path.join(f.base, "private/guide.md"), file);
  assert.equal(runtime.readSkillResource("bounded", guide), null);
  assert.deepEqual(runtime.searchSkillResources("bounded", "outside"), noFiles);
  rmSync(path.dirname(file), { recursive: true });
  symlinkSync(path.join(f.base, "private"), path.dirname(file), "dir");
  assert.equal(runtime.readSkillResource("bounded", guide), null);
  assert.deepEqual(runtime.searchSkillResources("bounded", "outside"), noFiles);
  assert.deepEqual(
    registry.rescan().skills.find((s) => s.id === "bounded")?.resources,
    [],
  );
  renameSync(skillDir, path.join(f.user, "moved"));
  symlinkSync(path.join(f.base, "private"), skillDir, "dir");
  assert.throws(() => registry.deleteUserSkill("bounded"));
  assert.equal(
    readFileSync(path.join(f.base, "private/guide.md"), "utf8"),
    "outside",
  );
});

test("local directory import copies only bounded data files and never follows a linked manifest, resource or user directory", (t) => {
  const f = fixture(t);
  const registry = f.open();
  const source = path.join(f.workspace, "local");
  write(source, "SKILL.md", manifest("Local"));
  write(source, guide, "rule");
  write(source, "scripts/run.sh", "unused");
  write(source, "assets/big.txt", "x".repeat(256 * 1024 + 1));
  write(source, "assets/help.css", ".form { color: red; }");
  write(source, "assets/executable.txt", "#!/bin/sh");
  chmodSync(path.join(source, "assets/executable.txt"), 0o700);
  write(source, "references/a/b/inside.md", "ok");
  write(source, "references/a/b/c/deep.md", "too deep");
  write(f.base, "private/hidden.md", "private text");
  symlinkSync(
    path.join(f.base, "private"),
    path.join(source, "assets", "secret"),
    "dir",
  );
  symlinkSync(
    path.join(f.base, "private/hidden.md"),
    path.join(source, "references", "link.md"),
  );
  registry.rescan();
  assert.equal(registry.getSkillDetail("local")?.hasScripts, true);
  const local = registry.importLocalDirectory(source);
  assert.deepEqual(local.resources.sort(), [
    "assets/help.css",
    "references/a/b/inside.md",
    guide,
  ]);
  assert.deepEqual(readdirSync(path.join(f.user, "local")).sort(), [
    ".forma-omitted-scripts",
    "SKILL.md",
    "assets",
    "references",
  ]);
  assert.equal(local.hasScripts, false);
  assert.equal(
    f.open().getSkillDetail("local")?.compatibility.level,
    "adapted",
  );
  assert.deepEqual(registry.readSkillResource("Local", guide), {
    path: guide,
    content: "rule",
    truncated: false,
    totalChars: 4,
  });
  rmSync(path.join(source, "SKILL.md"));
  symlinkSync(
    path.join(f.base, "private/hidden.md"),
    path.join(source, "SKILL.md"),
  );
  assert.throws(() => registry.importLocalDirectory(source));
  renameSync(f.user, path.join(f.configDir, "saved"));
  symlinkSync(path.join(f.base, "private"), f.user, "dir");
  assert.throws(() => registry.importSkill({ skillMd: manifest("different") }));
  assert.deepEqual(readdirSync(path.join(f.base, "private")), ["hidden.md"]);
});

test("only the first 80 eligible resources are indexed or copied", (t) => {
  const f = fixture(t);
  const dir = path.join(f.workspace, "many");
  write(dir, "SKILL.md", manifest("Many"));
  for (let i = 0; i < 85; i++)
    write(dir, `references/${String(i).padStart(2, "0")}.txt`, "text");
  const registry = f.open();
  assert.equal(registry.getSkillDetail("many")?.resources.length, 80);
  assert.equal(registry.readSkillResource("Many", "references/84.txt"), null);
  const imported = registry.importLocalDirectory(dir);
  assert.equal(readdirSync(path.join(f.user, "many/references")).length, 80);
  assert.equal(imported.resources.length, 80);
  assert.throws(() =>
    registry.importSkill({
      skillMd: manifest("Too many"),
      resources: Array.from({ length: 81 }, (_, i) => ({
        path: `references/${i}.txt`,
        content: "x",
      })),
    }),
  );
});

test("community directory imports retain themes, safe datasets and root guides, and diagnose remote-only rules", (t) => {
  const f = fixture(t);
  const registry = f.open();
  const samples: {
    name: string;
    body: string;
    level: string;
    files: Record<string, string>;
    expected: string[];
  }[] = [
    {
      name: "theme-factory",
      body: "Choose a theme.",
      level: "native",
      files: {
        "themes/ocean.md": "## Deep Ocean\nUse turquoise.",
        "theme-showcase.pdf": "%PDF",
      },
      expected: ["themes/ocean.md"],
    },
    {
      name: "ui-ux-pro-max",
      body: "Use python scripts/search.py to choose a palette.",
      level: "adapted",
      files: {
        "data/colors.csv": "Name,Accent\nForest,#337711",
        "data/stacks/web.tsv": "Stack\tFont\nWeb\tInter",
        "data/styles.json": '["ink"]',
        "data/google-fonts.csv": "x".repeat(747 * 1024),
        "scripts/search.py": "must never be copied",
        "data/binary.csv": "\0binary",
      },
      expected: ["data/colors.csv", "data/stacks/web.tsv", "data/styles.json"],
    },
    {
      name: "better-colors",
      body: "Apply accessible CSS palettes.",
      level: "native",
      files: {
        "color-usage.md": "## Palette Structure\nUse contrast.",
        "contrast.md": "Pair surfaces.",
        "figma.md": "Use variables.",
        "README.md": "skip",
        "LICENSE.md": "skip",
        ".ignored.md": "skip",
      },
      expected: ["color-usage.md", "contrast.md", "figma.md"],
    },
    {
      name: "web-design-guidelines",
      body: "Use WebFetch to retrieve https://raw.githubusercontent.com/org/repo/main/rules.md",
      level: "limited",
      files: {},
      expected: [],
    },
  ];
  for (const { name, body, files, expected, level } of samples) {
    const source = path.join(f.base, name);
    const skillMd = manifest(name) + "\n" + body;
    write(source, "SKILL.md", skillMd);
    for (const [file, content] of Object.entries(files))
      write(source, file, content);
    const imported = registry.importLocalDirectory(source);
    assert.deepEqual(imported.resources.sort(), expected);
    assert.equal(imported.compatibility.level, level);
    assert.equal(
      readFileSync(path.join(f.user, name, "SKILL.md"), "utf8"),
      skillMd,
    );
    for (const file of Object.keys(files))
      assert.equal(
        existsSync(path.join(f.user, name, file)),
        expected.includes(file),
        file,
      );
    const skill = registry.activateSkill(name)!;
    assert.deepEqual(skill.compatibility, imported.compatibility);
    assert.match(skill.formaAdaptationNote, /propose_design_changes/);
    if (expected.length)
      assert.ok(registry.readSkillResource(name, expected[0]));
  }
});

test("compatibility grades use local resources, code vocabulary and script or network requirements", () => {
  const report = (
    instructions: string,
    resources: string[] = [],
    hasScripts = false,
  ) => analyzeSkillCompatibility({ instructions, resources, hasScripts });
  const native = report("React className and CSS", [
    "a.md",
    "b.TXT",
    "data/a.CSV",
    "b.tsv",
    "a.json",
    "a.yml",
    "b.yaml",
    "v.svg",
    "s.css",
  ]);
  assert.equal(native.label, "完全兼容");
  assert.ok(native.hasCodeCentricRules);
  assert.deepEqual(native.resourceCounts, { markdown: 2, data: 5, other: 2 });
  assert.match(native.notes.join(" "), /Forma 原生图层/);
  for (const command of [
    "scripts/query",
    "python3 find",
    "python find",
    "lookup.py",
    "bash find",
  ]) {
    const adapted = report(command, ["data/a.csv"]);
    assert.equal(adapted.label, "本地检索适配");
    assert.equal(adapted.hasScriptDependency, true);
  }
  assert.match(report("Plain", [], true).notes[0], /仅加载 SKILL.md/);
  for (const body of [
    "WebFetch",
    "Fetch the latest guidelines",
    "https://raw.githubusercontent.com/a/b/main/x",
  ]) {
    const limited = report(body, [], true);
    assert.ok(limited.hasExternalUrlFetch);
    assert.equal(limited.label, "外部依赖受限");
    assert.equal(report(body, ["rules/local.md"]).level, "native");
  }
});

test("structured search ranks multilingual CSV records, quoted TSV fields and titled Markdown passages", () => {
  const csv = {
    path: "data/colors.csv",
    content:
      '\uFEFFName,Notes,Hex\r\nForest,Neutral,#222222\r\n"Forest, dusk","松绿 ""accent""\r\nwith contrast",#124536\r\nOcean,松绿,#112233\r\n',
  };
  const results = searchStructuredSkillContent([csv], "forest 松绿");
  assert.equal(results[0].location, "row 3");
  assert.deepEqual(results[0].record, {
    Name: "Forest, dusk",
    Notes: '松绿 "accent"\r\nwith contrast',
    Hex: "#124536",
  });
  assert.ok(results[0].score > results[1].score);
  assert.deepEqual(searchStructuredSkillContent([csv], "no-results"), []);
  const tsv = {
    path: "data/stacks/text.tsv",
    content: 'Theme\tTypeface\nInk\t"News\tCycle"',
  };
  assert.equal(
    searchStructuredSkillContent([tsv], "news")[0].record?.Typeface,
    "News\tCycle",
  );
  const docs = [
    {
      path: "color-usage.md",
      content:
        "# Intro\nNeutral.\n## Palette Structure\nKeep surfaces calm.\n\nUse a teal accent.\n### Type\nAvoid teal body copy.",
    },
  ];
  const [passage] = searchStructuredSkillContent(docs, "palette teal", 1);
  assert.equal(passage.location, "section: Palette Structure");
  assert.equal(passage.excerpt, "Use a teal accent.");
  const [json] = searchStructuredSkillContent(
    [
      {
        path: "data/fonts.json",
        content: JSON.stringify([{ name: "Inter" }, { name: "Manrope" }]),
      },
    ],
    "manrope",
  );
  assert.equal(json.location, "item 2");
  const [late] = searchStructuredSkillContent(
    [
      {
        path: "notes.txt",
        content: "a".repeat(2000) + "needle" + "b".repeat(2000),
      },
    ],
    "needle",
  );
  assert.match(late.excerpt, /needle/);
  assert.ok(late.excerpt.length <= 900);
});

test("search filters only the enabled session's disclosed files, rechecking paths on every call", (t) => {
  const f = fixture(t);
  const registry = f.open();
  const name = "palettes",
    dir = path.join(f.workspace, name);
  write(dir, "SKILL.md", manifest(name));
  write(dir, "themes/ink.md", "# Ink\nA deep ink surface.");
  write(dir, "data/colors.csv", "Name,Primary\nInk,#111111");
  registry.rescan();
  const runtime = registry.asRuntimeProvider();
  assert.equal(registry.searchSkillResources(name, "ink"), null);
  assert.equal(runtime.searchSkillResources(name, "ink"), null);
  runtime.activateSkill(name);
  assert.equal(
    registry.asRuntimeProvider().searchSkillResources(name, "ink"),
    null,
  );
  const data = runtime.searchSkillResources(name, "ink", {
    pathPrefix: "data/colors",
  })!;
  assert.equal(data.searchedFiles, 1);
  assert.equal(data.matches[0].record?.Primary, "#111111");
  assert.equal(
    runtime.searchSkillResources(name, "ink", { pathPrefix: "themes/" })
      ?.matches[0].location,
    "section: Ink",
  );
  assert.equal(
    runtime.searchSkillResources(name, "ink", { pathPrefix: "../" }),
    null,
  );
  write(dir, "data/new.md", "undisclosed ink");
  registry.rescan();
  assert.equal(runtime.searchSkillResources(name, "ink")?.searchedFiles, 2);
  runtime.activateSkill(name);
  assert.equal(runtime.searchSkillResources(name, "ink")?.searchedFiles, 3);
  registry.setSkillEnabled(name, false);
  assert.equal(runtime.searchSkillResources(name, "ink"), null);
});

function sessionDocument(): DesignDocument {
  const outer = createNode("frame");
  outer.id = "outside";
  const board = createNode("frame", outer.id);
  board.id = "board";
  board.style.width = 100;
  board.variableModes = { theme: "night" };
  board.styleBindings = { paint: "surface" };
  const label = createNode("text", board.id);
  label.id = "label";
  label.text = "Pay invoice";
  label.style.color = "#cccccc";
  label.style.x = 90;
  label.interaction = { actions: [{ kind: "navigate", target: outer.id }] };
  const group = createNode("frame", board.id);
  group.id = "group";
  const empty = createNode("text", group.id);
  empty.id = "empty";
  empty.text = "  ";
  const other = createNode("text", outer.id);
  other.id = "private-node";
  other.text = "Pay private invoice";
  const archived = createNode("frame");
  archived.id = "other-page-board";
  const sys = emptyDesignSystem();
  sys.collections.theme = {
    id: "theme",
    name: "Theme",
    defaultModeId: "day",
    modes: [
      { id: "day", name: "Day" },
      { id: "night", name: "Night" },
    ],
  };
  sys.variables.base = {
    id: "base",
    name: "Surface base",
    collectionId: "theme",
    type: "color",
    scopes: ["fill"],
    values: { day: "#000000", night: "#ffffff" },
    codeSyntax: "",
    description: "",
  };
  sys.variables.semantic = {
    ...sys.variables.base,
    id: "semantic",
    name: "Surface alias",
    values: { day: { alias: "base" }, night: { alias: "base" } },
  };
  sys.variables.private = {
    ...sys.variables.base,
    id: "private",
    name: "Secret theme color",
  };
  sys.styles.surface = {
    id: "surface",
    name: "Surface paint",
    kind: "paint",
    description: "",
    properties: {},
    bindings: { fill: "semantic" },
  };
  sys.styles.secret = {
    ...sys.styles.surface,
    id: "secret",
    name: "Secret style",
    bindings: { fill: "private" },
  };
  return {
    id: "paired",
    name: "Paired",
    schemaVersion: 1,
    revision: 0,
    designSystem: sys,
    tokens: {},
    activePage: "current",
    pages: [
      { id: "current", name: "Current" },
      { id: "archive", name: "Archive", nodes: [archived] },
    ],
    nodes: [outer, board, label, group, empty, other],
  };
}

function request(
  method: string,
  suffix: string,
  payload: unknown,
  headers: IncomingMessage["headers"] = {},
  originAllowed = false,
) {
  return sessionRequest(
    { method, url: "/api/agent/sessions" + suffix, headers } as IncomingMessage,
    async () => payload,
    originAllowed,
  );
}
async function pair(t: TestContext, selection: string | null) {
  const doc = sessionDocument();
  const { key, editor } = z
    .object({ key: z.string(), editor: z.string() })
    .parse(await request("POST", "", { document: doc, selection }, {}, true));
  const headers = { authorization: "Bearer " + key };
  const editorHeaders = { ...headers, "x-forma-editor": editor };
  t.after(async () => {
    await request("DELETE", "", {}, editorHeaders);
  });
  return {
    key,
    doc,
    headers,
    editorHeaders,
    query: (endpoint: string, input: unknown = {}) =>
      request("POST", "/" + endpoint, input, headers),
  };
}
const nodeResults = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      parentId: z.string().nullable().optional(),
      interaction: z.object({ actions: z.array(z.unknown()) }).optional(),
    }),
  ),
});
const issuesResult = z.object({
  issues: z.array(
    z.object({
      kind: z.string(),
      nodeId: z.string(),
      contrast: z.object({ ratio: z.number() }).optional(),
    }),
  ),
});
const systemResult = z.object({
  variables: z.array(
    z.object({
      id: z.string(),
      resolvedValue: z.union([z.string(), z.number(), z.boolean()]),
      scopes: z.array(z.string()),
    }),
  ),
  collections: z.array(
    z.object({
      id: z.string(),
      activeModeId: z.string(),
      modes: z.array(z.object({ id: z.string() })),
    }),
  ),
  styles: z.array(
    z.object({ id: z.string(), bindings: z.record(z.string(), z.string()) }),
  ),
});

test("all four session queries require a paired Bearer, check browser origin and reject invalid input", async (t) => {
  const { key, headers, query } = await pair(t, "board");
  for (const [endpoint, input] of [
    ["search-nodes", {}],
    ["node-details", { ids: ["board"] }],
    ["design-system", {}],
    ["lint", {}],
  ] as const) {
    for (const auth of [
      {},
      { authorization: "Bearer unknown" },
      { authorization: key },
      { authorization: "Basic " + key },
    ])
      await assert.rejects(
        () => request("POST", "/" + endpoint, input, auth),
        /会话|Bearer/,
      );
    await assert.rejects(
      () =>
        request("POST", "/" + endpoint, input, {
          ...headers,
          origin: "https://example.invalid",
        }),
      /来源/,
    );
    await assert.rejects(() => request("GET", "/" + endpoint, input, headers));
    await query(endpoint, input);
  }
  await assert.rejects(() => query("search-nodes", { types: ["unknown"] }));
  await assert.rejects(() => query("search-nodes", { limit: -1 }));
  await assert.rejects(() => query("node-details", { ids: "board" }));
  await assert.rejects(() => query("design-system", { kind: "secrets" }));
  await assert.rejects(() => query("lint", { rootId: 2 }));
});

test("search and batch details can only enumerate the selected subtree, including nested children", async (t) => {
  const { query } = await pair(t, "board");
  const found = nodeResults.parse(
    await query("search-nodes", { query: "PAY", types: ["text"], limit: 1 }),
  );
  assert.deepEqual(
    found.nodes.map((n) => n.id),
    ["label"],
  );
  assert.deepEqual(
    nodeResults.parse(await query("search-nodes", { query: "private" })).nodes,
    [],
  );
  assert.deepEqual(
    nodeResults.parse(
      await query("node-details", {
        ids: ["outside", "other-page-board"],
        includeChildren: true,
      }),
    ).nodes,
    [],
  );
  assert.deepEqual(
    nodeResults
      .parse(await query("node-details", { ids: ["board", "outside"] }))
      .nodes.map((n) => n.id),
    ["board"],
  );
  const detail = nodeResults.parse(
    await query("node-details", {
      ids: ["board", "group", "outside"],
      includeChildren: true,
    }),
  ).nodes;
  assert.deepEqual(
    detail.map((n) => n.id),
    ["board", "label", "group", "empty"],
  );
  assert.equal(detail[0].parentId, null);
  assert.deepEqual(detail[1].interaction?.actions, []);
});

test("design-system views follow selected style and alias dependencies and resolve the local collection mode", async (t) => {
  const { query } = await pair(t, "board");
  const result = systemResult.parse(await query("design-system"));
  assert.deepEqual(
    result.variables.map((v) => [v.id, v.resolvedValue, v.scopes]),
    [
      ["base", "#ffffff", ["fill"]],
      ["semantic", "#ffffff", ["fill"]],
    ],
  );
  assert.deepEqual(result.styles, [
    { id: "surface", bindings: { fill: "semantic" } },
  ]);
  assert.equal(result.collections[0].activeModeId, "night");
  assert.equal(result.collections[0].modes.length, 2);
  assert.deepEqual(
    systemResult.parse(
      await query("design-system", { kind: "styles", query: "SURF" }),
    ).styles,
    result.styles,
  );
  assert.deepEqual(
    systemResult.parse(await query("design-system", { query: "secret" })),
    { variables: [], collections: [], styles: [] },
  );
  const page = await pair(t, null);
  assert.ok(
    systemResult
      .parse(await page.query("design-system", { kind: "variables" }))
      .variables.some(
        (v) => v.id === "private" && v.resolvedValue === "#000000",
      ),
  );
});

test("lint checks contrast, literal colors, overflow and empty text only within the authorized subtree or active page", async (t) => {
  const { query } = await pair(t, "board");
  const issues = issuesResult.parse(await query("lint")).issues;
  for (const [node, kind] of [
    ["label", "low-contrast"],
    ["label", "out-of-bounds"],
    ["empty", "empty-text"],
    ["group", "unbound-color"],
  ])
    assert.ok(
      issues.some((i) => i.nodeId === node && i.kind === kind),
      kind,
    );
  assert.ok(
    !issues.some((i) => i.kind === "unbound-color" && i.nodeId === "board"),
  );
  assert.ok(
    (issues.find((i) => i.kind === "low-contrast" && i.nodeId === "label")
      ?.contrast?.ratio ?? 5) < 4.5,
  );
  assert.ok(
    issues.every((i) =>
      ["board", "label", "group", "empty"].includes(i.nodeId),
    ),
  );
  const narrow = issuesResult.parse(await query("lint", { rootId: "empty" }));
  assert.ok(
    narrow.issues.length && narrow.issues.every((i) => i.nodeId === "empty"),
  );
  for (const id of ["outside", "does-not-exist", "other-page-board"])
    await assert.rejects(() => query("lint", { rootId: id }), /范围/);
  const page = await pair(t, null);
  const ids = nodeResults
    .parse(await page.query("search-nodes"))
    .nodes.map((n) => n.id);
  assert.ok(ids.includes("private-node") && !ids.includes("other-page-board"));
  assert.ok(
    issuesResult
      .parse(await page.query("lint"))
      .issues.some((i) => i.nodeId === "private-node"),
  );
});

test("legacy context, components, proposal review and editor-only close keep their existing pairing contract", async (t) => {
  const { headers, editorHeaders } = await pair(t, "board");
  const context = z
    .object({
      revision: z.number(),
      selection: z.string(),
      nodes: z.array(z.object({ id: z.string() })),
    })
    .parse(await request("GET", "/context", undefined, headers));
  assert.equal(context.selection, "board");
  assert.equal(context.revision, 0);
  assert.deepEqual(
    context.nodes.map((n) => n.id),
    ["board", "label", "group", "empty"],
  );
  assert.deepEqual(await request("GET", "/components", undefined, headers), []);
  const tx = {
    baseRevision: 0,
    operations: [{ type: "update", id: "label", patch: { text: "Updated" } }],
  };
  await request("POST", "/proposal", tx, headers);
  await assert.rejects(
    () => request("POST", "/proposal", tx, headers),
    /待处理/,
  );
  await assert.rejects(
    () => request("GET", "/proposal", undefined, headers),
    /编辑器/,
  );
  await assert.rejects(
    () => request("DELETE", "", undefined, headers),
    /编辑器/,
  );
  const pending = z
    .object({ proposal: z.object({ transaction: z.unknown() }) })
    .parse(await request("GET", "/proposal", undefined, editorHeaders));
  assert.deepEqual(pending.proposal.transaction, tx);
});

test(
  "stdio handshake advertises seven tools and forwards each new query with its Bearer and JSON payload",
  { timeout: 12_000 },
  async (t) => {
    // Use the actual MCP entry point and JSON-RPC transport. Echo the last HTTP
    // hop so this test also runs on hosts that prohibit loopback listeners.
    const echo = `globalThis.fetch = async (url, init) => Response.json({path:new URL(url).pathname,method:init.method,authorization:init.headers.Authorization,body:JSON.parse(init.body)})`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "data:text/javascript," + encodeURIComponent(echo),
        "server/mcp.ts",
      ],
      {
        env: { ...process.env, FORMA_SESSION: "paired-test" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    t.after(() => {
      child.stdin.end();
      child.kill();
    });
    const lines = createInterface({ input: child.stdout })[
      Symbol.asyncIterator
    ]();
    let sequence = 0;
    function send(value: object) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
    }
    async function rpc(method: string, params: object) {
      const id = ++sequence;
      send({ id, method, params });
      for (;;) {
        const line = await lines.next();
        assert.ok(!line.done, "stdio closed before reply");
        const msg = JSON.parse(line.value);
        if (msg.id !== id) continue;
        assert.equal(msg.error, undefined);
        assert.ok(!msg.result.isError);
        return msg.result;
      }
    }
    await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "forma-test", version: "1" },
    });
    send({ method: "notifications/initialized" });
    const names = z
      .object({ tools: z.array(z.object({ name: z.string() })) })
      .parse(await rpc("tools/list", {}))
      .tools.map((t) => t.name);
    assert.deepEqual(
      names.sort(),
      [
        "read_design",
        "list_components",
        "propose_design",
        "search_nodes",
        "get_node_details",
        "get_design_system",
        "lint_design",
      ].sort(),
    );
    for (const [name, endpoint, args] of [
      ["search_nodes", "search-nodes", { query: "button", limit: 2 }],
      [
        "get_node_details",
        "node-details",
        { ids: ["board"], includeChildren: true },
      ],
      ["get_design_system", "design-system", { kind: "styles" }],
      ["lint_design", "lint", { rootId: "board" }],
    ] as const) {
      const answer = await rpc("tools/call", { name, arguments: args });
      assert.deepEqual(JSON.parse(answer.content[0].text), {
        path: "/api/agent/sessions/" + endpoint,
        method: "POST",
        authorization: "Bearer paired-test",
        body: args,
      });
    }
  },
);
