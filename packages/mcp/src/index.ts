import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateRequestDefinitionInput } from "@watasu/core";
import { z } from "zod";

export const mcpPackageName = "@watasu/mcp";

export function createWatasuMcpServer(): McpServer {
  const server = new McpServer({
    name: "watasu",
    version: "0.0.0"
  });

  server.registerTool(
    "validate_request_definition",
    {
      title: "Validate request definition",
      description: "Validate a watasu request definition document and return machine-readable status.",
      inputSchema: {
        definitionText: z.string()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ definitionText }) => {
      const validation = validateRequestDefinitionInput(definitionText);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(validation.ok ? {
              ok: true,
              request: {
                name: validation.definition.name,
                schema_version: validation.definition.schema_version,
                field_count: validation.definition.fields.length
              },
              warnings: validation.warnings
            } : {
              ok: false,
              errors: validation.errors
            })
          }
        ]
      };
    }
  );

  return server;
}
