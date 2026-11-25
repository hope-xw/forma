import test from "node:test";
import assert from "node:assert/strict";
import { CompatibleProvider, validateProposal } from "../src/agent/provider";
import { createStarter } from "../src/domain/seed";
import { createNode } from "../src/domain/document";

test("scoped agent cannot edit or create outside its selection", () => {
  const document = createStarter();
  const context = {
    document,
    selection: document.nodes[0].id,
    prompt: "change",
  };
  assert.throws(
    () =>
      validateProposal(context, {
        baseRevision: 0,
        operations: [
          {
            type: "update",
            id: document.nodes.at(-1)!.id,
            patch: { text: "outside" },
          },
        ],
      }),
    /选区/,
  );
  assert.throws(
    () =>
      validateProposal(context, {
        baseRevision: 0,
        operations: [{ type: "create", node: createNode("frame") }],
      }),
    /选区/,
  );
});
test("agent can create nested native objects inside selection", () => {
  const document = createStarter();
  const frame = createNode("frame", document.nodes[0].id);
  const text = createNode("text", frame.id);
  const transaction = {
    baseRevision: 0,
    operations: [
      { type: "create", node: frame },
      { type: "create", node: text },
    ],
  };
  assert.equal(
    validateProposal(
      { document, selection: document.nodes[0].id, prompt: "card" },
      transaction,
    ).operations.length,
    2,
  );
});
test("agent cannot move a selected descendant outside its subtree", () => {
  const document = createStarter();
  assert.throws(
    () =>
      validateProposal(
        { document, selection: document.nodes[0].id, prompt: "" },
        {
          baseRevision: 0,
          operations: [
            { type: "move", id: document.nodes[1].id, parentId: null },
          ],
        },
      ),
    /选区/,
  );
});
test("compatible adapter sends configured model and schema, parses provider output", async () => {
  let payload: {
    model: string;
    response_format: { type: string };
    messages: { content: string }[];
  } = { model: "", response_format: { type: "" }, messages: [] };
  const provider = new CompatibleProvider(
    {
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key",
      model: "configured-model",
    },
    async (url, init) => {
      assert.equal(String(url), "https://example.invalid/v1/chat/completions");
      payload = JSON.parse(String(init?.body));
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer test-key",
      );
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"baseRevision":0,"operations":[]}' } },
          ],
        }),
        { status: 200 },
      );
    },
  );
  const output = await provider.generate(
    { document: createStarter(), selection: null, prompt: "design" },
    new AbortController().signal,
  );
  assert.equal(payload.model, "configured-model");
  assert.equal(payload.response_format.type, "json_object");
  assert.ok(payload.messages[0].content.includes("baseRevision"));
  assert.deepEqual(output, { baseRevision: 0, operations: [] });
});
test("provider errors omit response body and credentials", async () => {
  const provider = new CompatibleProvider(
    { baseUrl: "https://example.invalid", apiKey: "secret", model: "model" },
    async () => new Response("secret reflected by vendor", { status: 401 }),
  );
  await assert.rejects(
    () =>
      provider.generate(
        { document: createStarter(), selection: null, prompt: "" },
        new AbortController().signal,
      ),
    (error) =>
      error instanceof Error &&
      error.message.includes("401") &&
      !error.message.includes("secret"),
  );
});
test("malformed model output is rejected", async () => {
  const provider = new CompatibleProvider(
    { baseUrl: "https://example.invalid", apiKey: "key", model: "model" },
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "```not json```" } }],
        }),
      ),
  );
  await assert.rejects(
    () =>
      provider.generate(
        { document: createStarter(), selection: null, prompt: "" },
        new AbortController().signal,
      ),
    /格式无效/,
  );
});
