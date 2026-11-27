import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { transactionSchema } from "../src/domain/commands";
import { sessionToolSchemas } from "./agent-sessions";
import {
  delegateDesignTaskSchema,
  exportReactCodeSchema,
  renderArtboardPreviewSchema,
  type DelegateDesignTaskInput,
  type ExportReactCodeInput,
  type RenderArtboardPreviewInput,
} from "./runtime-capabilities";

export interface FormaMcpBackend {
  readDesign(): Promise<unknown>;
  listComponents(): Promise<unknown>;
  searchNodes(
    input: z.input<(typeof sessionToolSchemas)["search-nodes"]>,
  ): Promise<unknown>;
  getNodeDetails(
    input: z.input<(typeof sessionToolSchemas)["node-details"]>,
  ): Promise<unknown>;
  getDesignSystem(
    input: z.input<(typeof sessionToolSchemas)["design-system"]>,
  ): Promise<unknown>;
  lintDesign(input: z.input<typeof sessionToolSchemas.lint>): Promise<unknown>;
  listOpenTabs(): Promise<unknown>;
  renderArtboardPreview(input: RenderArtboardPreviewInput): Promise<unknown>;
  exportReactCode(input: ExportReactCodeInput): Promise<unknown>;
  proposeDesign(input: z.input<typeof transactionSchema>): Promise<unknown>;
  delegateDesignTask(input: DelegateDesignTaskInput): Promise<unknown>;
}

function tool<S extends z.ZodObject>(
  description: string,
  inputSchema: S,
  readOnlyHint = true,
) {
  return { description, inputSchema, annotations: { readOnlyHint } };
}

async function textResult(result: Promise<unknown>) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await result) }],
    };
  } catch (error) {
    // Tool execution failures travel inside the JSON-RPC result, including over SSE.
    if (error instanceof Error && "status" in error && error.status === 503)
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ status: 503, error: error.message }),
          },
        ],
      };
    throw error;
  }
}

export function createFormaMcpServer(
  backend: FormaMcpBackend,
  serverInfo?: { version?: string },
): McpServer {
  const server = new McpServer({
    name: "forma-design",
    version: serverInfo?.version ?? "1.0.0",
  });
  const empty = z.object({});
  server.registerTool(
    "read_design",
    tool(
      "Read the paired editor scope, native layers, variables and base revision.",
      empty,
    ),
    () => textResult(backend.readDesign()),
  );
  server.registerTool(
    "list_components",
    tool("Find installed component and variant IDs.", empty),
    () => textResult(backend.listComponents()),
  );
  server.registerTool(
    "search_nodes",
    tool(
      "Find matching layers in the paired selection or active page. Returns up to 40 matches by default.",
      sessionToolSchemas["search-nodes"],
    ),
    (args) => textResult(backend.searchNodes(args)),
  );
  server.registerTool(
    "get_node_details",
    tool(
      "Read native layer properties by ID. Set includeChildren to include descendants within the paired scope.",
      sessionToolSchemas["node-details"],
    ),
    (args) => textResult(backend.getNodeDetails(args)),
  );
  server.registerTool(
    "get_design_system",
    tool(
      "Read variables with resolved values, styles and collection modes within the paired scope.",
      sessionToolSchemas["design-system"],
    ),
    (args) => textResult(backend.getDesignSystem(args)),
  );
  server.registerTool(
    "lint_design",
    tool(
      "Audit a subtree, selection or active page for contrast, unbound colors, overflow and empty text.",
      sessionToolSchemas.lint,
    ),
    (args) => textResult(backend.lintDesign(args)),
  );
  server.registerTool(
    "list_open_tabs",
    tool(
      "List open workspace tabs and identify the active document and selection.",
      empty,
    ),
    () => textResult(backend.listOpenTabs()),
  );
  server.registerTool(
    "render_artboard_preview",
    tool(
      "Render an artboard or layer as SVG at the requested scale.",
      renderArtboardPreviewSchema,
    ),
    (args) => textResult(backend.renderArtboardPreview(args)),
  );
  server.registerTool(
    "export_react_code",
    tool(
      "Compile React and TypeScript source for a layer, selection or active page, with optional components and tokens.",
      exportReactCodeSchema,
    ),
    (args) => textResult(backend.exportReactCode(args)),
  );
  server.registerTool(
    "propose_design",
    tool(
      "Submit an atomic design transaction under the paired editor's approval policy.",
      transactionSchema,
      false,
    ),
    (args) => textResult(backend.proposeDesign(args)),
  );
  server.registerTool(
    "delegate_design_task",
    tool(
      "Delegate a design instruction to Forma's configured model and queue its validated proposal.",
      delegateDesignTaskSchema,
      false,
    ),
    (args) => textResult(backend.delegateDesignTask(args)),
  );
  return server;
}
