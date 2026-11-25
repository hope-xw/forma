import { createServer } from "node:http";
import { createAgentRequestHandler } from "./agent-http";

const port = Number(process.env.AGENT_PORT ?? 5174);
const handler = createAgentRequestHandler();

createServer((req, res) => {
  void handler(req, res);
}).listen(port, "127.0.0.1", () => {
  const status = handler.store.getStatus();
  console.log(
    `Agent API listening on http://127.0.0.1:${port}; model configured: ${status.configured}`,
  );
});
