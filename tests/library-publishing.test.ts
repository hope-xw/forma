import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { libraryServer } from "../server/library-service";
import { createStarter } from "../src/domain/seed";
import { createLibraryFromSelection } from "../src/domain/library";

test("parallel publication requires the reviewed revision and persists only the winning snapshot", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "forma-race-"));
  const origin = "http://127.0.0.1:5173";
  const server = libraryServer({
    origins: [origin],
    writeToken: "fixture",
    directory,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const info = server.address();
    assert.ok(info && typeof info !== "string");
    const source = createStarter(),
      library = createLibraryFromSelection(source, source.nodes[0].id, "Theme");
    const url = "http://127.0.0.1:" + info.port + "/libraries/" + library.id;
    const put = (version: typeof library, condition: Record<string, string>) =>
      fetch(url, {
        method: "PUT",
        headers: {
          Origin: origin,
          "content-type": "application/json",
          Authorization: "Bearer fixture",
          ...condition,
        },
        body: JSON.stringify(version),
      });
    assert.equal((await put(library, { "If-None-Match": "*" })).status, 201);
    const tag = (await fetch(url)).headers.get("etag");
    assert.ok(tag);
    const revisions = ["Amber", "Ochre"].map((name) => ({
      ...library,
      revision: 2,
      name,
    }));
    const attempts = await Promise.all(
      revisions.map((v) => put(v, { "If-Match": tag })),
    );
    assert.deepEqual(attempts.map((a) => a.status).sort(), [200, 412]);
    const winner = await (await fetch(url)).json();
    assert.equal(
      winner.name,
      revisions[attempts.findIndex((a) => a.status === 200)].name,
    );
    assert.equal(winner.revision, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
