import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentRequestHandler, type AgentHttpOptions } from "./agent-http";

export function localAgentConfigDirectory(): string {
  if (process.env.FORMA_AGENT_CONFIG_DIR) {
    return process.env.FORMA_AGENT_CONFIG_DIR;
  }
  return path.join(homedir(), ".forma");
}

export function agentServer(options: AgentHttpOptions = {}) {
  const handler = createAgentRequestHandler({
    configDir: options.configDir ?? localAgentConfigDirectory(),
    origins: options.origins,
    allowSameHostLoopback: options.allowSameHostLoopback ?? true,
    fetchImpl: options.fetchImpl,
    env: options.env,
    store: options.store,
  });
  return createServer((req, res) => {
    void handler(req, res);
  });
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const port = Number(process.env.AGENT_PORT ?? 5174);
  const handler = createAgentRequestHandler({
    configDir: localAgentConfigDirectory(),
  });
  createServer((req, res) => {
    void handler(req, res);
  }).listen(port, "127.0.0.1", () => {
    const status = handler.store.getStatus();
    console.log(
      `Agent API listening on http://127.0.0.1:${port}; model configured: ${status.configured}`,
    );
  });
}
