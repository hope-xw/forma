import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  publishedReleaseNotes,
  releaseUpdates,
  type ReleaseUpdate,
} from "../src/editor/release-notes";

test("every release has a dated project record and every stable milestone has a public entry", () => {
  const changelog = readFileSync(
    new URL("../docs/CHANGELOG.md", import.meta.url),
    "utf8",
  );
  const sections = changelog.split(/^## /m).slice(1);
  assert.deepEqual(
    sections.map((section) => section.split("\n")[0]),
    releaseUpdates.map(({ version, date }) => version + " · " + date).reverse(),
  );
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(releaseUpdates.at(-1)?.version, pkg.version);
  assert.equal(
    new Set(releaseUpdates.map((r) => r.version)).size,
    sections.length,
  );
  for (const [
    i,
    { version, date, title, summary, highlights },
  ] of releaseUpdates.entries()) {
    assert.equal(new Date(date).toISOString().slice(0, 10), date);
    if (i) assert.ok(releaseUpdates[i - 1].date <= date);
    if (title !== undefined) assert.ok(title.trim() && summary.trim(), version);
    if (highlights !== undefined) {
      assert.ok(
        highlights.every((item) => item.trim().length > 0),
        version,
      );
    }
    if (/^\d+\.\d+\.0$/.test(version)) assert.ok(title, version);
    assert.match(sections[sections.length - 1 - i], /^- \S.+$/m);
  }
});

test("patches wait for the next published update and are included exactly once", () => {
  const entry = (
    version: string,
    summary: string,
    title?: string,
  ): ReleaseUpdate => ({ version, date: "2026-11-23", title, summary });
  const history = [
    entry("1.0.0", "first", "Release"),
    entry("1.0.1", "fix one"),
    entry("1.0.2", "fix two"),
    entry("1.0.3", ""), // Internal maintenance with no user-facing change.
  ];
  assert.deepEqual(
    publishedReleaseNotes(history).map((r) => r.changes),
    [["first"]],
  );
  history.push(
    {
      version: "1.0.4",
      date: "2026-11-23",
      title: "Important patch",
      summary: "new capability",
      highlights: ["extra highlight"],
    },
    entry("1.1.0", "next", "Milestone"),
  );
  const groups = publishedReleaseNotes(history);
  assert.deepEqual(
    groups.map((r) => r.version),
    ["1.1.0", "1.0.4", "1.0.0"],
  );
  assert.deepEqual(
    groups.map((r) => r.changes),
    [
      ["next"],
      ["new capability", "extra highlight", "fix one", "fix two"],
      ["first"],
    ],
  );
});
