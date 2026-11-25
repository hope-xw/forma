import assert from "node:assert/strict";
import test from "node:test";
import { inferModelCapabilities } from "../src/agent/capabilities";
import { buildDesignContextPayload } from "../src/agent/context-builder";
import { FormaToolExecutor } from "../src/agent/forma-tools";
import { antd5Library } from "../src/design-system/antd5";
import { material3Library } from "../src/design-system/material3";
import { mobileLibrary } from "../src/design-system/mobile";
import { shadcnLibrary } from "../src/design-system/shadcn";
import type { ComponentLibrary } from "../src/domain/library-schema";
import { createStarter } from "../src/domain/seed";

const installed = [material3Library, antd5Library, shadcnLibrary];
const platforms = ["android", "web-enterprise", "web-modern"];
function context(libraries = installed) {
  return {
    document: {
      ...createStarter(),
      libraries: Object.fromEntries(libraries.map((lib) => [lib.id, lib])),
    },
    prompt: "搜索已安装的组件库",
    selection: null,
  };
}

function search(query: string, libraries?: ComponentLibrary[], offset = 0) {
  const result = new FormaToolExecutor(context(libraries)).execute(
    "search_components",
    { query, offset },
  );
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.components));
  return {
    total: result.total,
    installedLibraries: result.installedLibraries,
    components: result.components,
    hint: result.hint,
  };
}

test("component search matches the library name and ID and reports the entire installed catalog", () => {
  for (const query of ["Ant Design", "forma-antd5-v1"]) {
    const result = search(query);
    assert.equal(result.total, antd5Library.components.length);
    assert.ok(result.components.length > 0);
    assert.ok(
      result.components.every(
        (c) =>
          c.libraryId === "forma-antd5-v1" && c.libraryName === "Ant Design 5",
      ),
    );
    assert.deepEqual(
      result.installedLibraries,
      installed.map((lib, i) => ({
        id: lib.id,
        name: lib.name,
        revision: lib.revision,
        componentCount: lib.components.length,
        platform: platforms[i],
      })),
    );
    assert.equal(result.hint, undefined);
  }
});

for (const [query, libraryId, componentId] of [
  ["FAB", "forma-material3-v1", "m3-fab"],
  ["Command", "forma-shadcn-v1", "shadcn-command"],
]) {
  test(
    "component search locates " + query + " in its installed library",
    () => {
      const match = search(query).components.find(
        (c) => c.componentId === componentId,
      );
      assert.equal(match?.libraryId, libraryId);
      assert.ok(match.variants.length > 0);
    },
  );
}

test("platform lookup covers iOS and Android and preserves installed revision snapshots", () => {
  const snapshot = {
    ...mobileLibrary,
    name: "团队移动库",
    revision: 8,
    components: mobileLibrary.components.slice(0, 2),
  };
  const ios = search("iOS", [...installed, snapshot]);
  assert.deepEqual(
    ios.components.map((c) => c.componentId),
    snapshot.components.map((c) => c.id),
  );
  assert.ok(ios.components.every((c) => c.libraryName === snapshot.name));
  assert.ok(Array.isArray(ios.installedLibraries));
  assert.deepEqual(
    ios.installedLibraries.find((lib) => lib.id === snapshot.id),
    {
      id: snapshot.id,
      name: snapshot.name,
      revision: 8,
      platform: "ios",
      componentCount: 2,
    },
  );
  assert.equal(search("Android").total, material3Library.components.length);
});

test("a genuine miss suggests built-in kits and the manager, but a past-end page has no hint", () => {
  for (const libraries of [installed, []]) {
    const result = search("不存在的组件", libraries);
    assert.deepEqual(result.components, []);
    assert.equal(result.total, 0);
    assert.equal(typeof result.hint, "string");
    for (const name of [
      "组件库管理",
      "Forma Mobile",
      "Material Design 3",
      "Ant Design 5",
      "shadcn/ui",
    ])
      assert.ok(String(result.hint).includes(name));
  }
  const pastEnd = search(
    "Ant Design",
    installed,
    antd5Library.components.length,
  );
  assert.deepEqual(pastEnd.components, []);
  assert.equal(pastEnd.hint, undefined);
});

test("get_design_system reports revision, platform, component counts and distinct categories for every installed library", () => {
  const result = new FormaToolExecutor(context()).execute(
    "get_design_system",
    {},
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.libraries,
    installed.map((lib, i) => ({
      id: lib.id,
      name: lib.name,
      revision: lib.revision,
      platform: platforms[i],
      componentCount: lib.components.length,
      categories: [...new Set(lib.components.map((c) => c.category))],
    })),
  );
});

test("context includes a separate revision, count, and component catalog for each installed library", () => {
  const { componentCatalog } = buildDesignContextPayload(
    context(),
    inferModelCapabilities("openai", "openai-chat", "gpt-4.1"),
  );
  assert.deepEqual(
    componentCatalog.map(({ components, ...metadata }) => ({
      ...metadata,
      ids: components.map((c) => c.componentId),
    })),
    installed.map((lib) => ({
      libraryId: lib.id,
      libraryName: lib.name,
      revision: lib.revision,
      componentCount: lib.components.length,
      ids: lib.components.map((c) => c.id),
    })),
  );
});
