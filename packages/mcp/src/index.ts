import {
  McpServer,
  ResourceTemplate
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildAgentCard,
  generateEncryptedEnvelopeSchema,
  generatePlaintextPayloadSchema,
  InMemoryRequestVersionRepository,
  publishRequestVersion,
  validateRequestDefinitionInput,
  type DeliveryLedgerRow,
  type PublishedRequestVersion,
  type RequestDefinitionError
} from "@watasu/core";
import { z } from "zod";

export const mcpPackageName = "@watasu/mcp";

export function createWatasuMcpServer(): McpServer {
  const repository = new InMemoryRequestVersionRepository();
  const latestPublishedByRequestId = new Map<string, PublishedRequestVersion>();
  const ledgerRowsByRequestId = new Map<string, DeliveryLedgerRow[]>();
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

  server.registerTool(
    "publish_request",
    {
      title: "Publish request",
      description:
        "Publish a validated watasu request definition into the local MCP workspace after explicit confirmation.",
      inputSchema: {
        definitionText: z.string(),
        confirmed: z.boolean()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ definitionText, confirmed }) => {
      const validation = validateRequestDefinitionInput(definitionText);
      if (!validation.ok) {
        return jsonToolResponse({
          ok: false,
          errors: validation.errors
        });
      }

      const publishResult = publishRequestVersion({
        requestId: validation.definition.name,
        definition: validation.definition,
        confirmed,
        mode: "local_demo",
        repository
      });

      if (!publishResult.ok) {
        return jsonToolResponse({
          ok: false,
          error: publishResult.error
        });
      }

      latestPublishedByRequestId.set(publishResult.published.request_id, publishResult.published);
      ledgerRowsByRequestId.set(publishResult.published.request_id, []);

      return jsonToolResponse({
        ok: true,
        published: summarizePublishedRequest(publishResult.published),
        warnings: validation.warnings
      });
    }
  );

  server.registerTool(
    "get_agent_card",
    {
      title: "Get Agent Card",
      description: "Return the Agent Card for a published local MCP request.",
      inputSchema: {
        requestId: z.string(),
        endpointUrl: z.string().url()
      },
      annotations: readToolAnnotations()
    },
    async ({ requestId, endpointUrl }) => {
      const published = latestPublishedByRequestId.get(requestId);
      if (published === undefined) {
        return jsonToolResponse(notFoundError(requestId));
      }

      return jsonToolResponse({
        ok: true,
        agent_card: buildAgentCard({
          published,
          endpointUrl
        })
      });
    }
  );

  server.registerTool(
    "get_plaintext_schema",
    {
      title: "Get plaintext schema",
      description: "Return the plaintext payload JSON Schema for a published local MCP request.",
      inputSchema: {
        requestId: z.string()
      },
      annotations: readToolAnnotations()
    },
    async ({ requestId }) => {
      const published = latestPublishedByRequestId.get(requestId);
      if (published === undefined) {
        return jsonToolResponse(notFoundError(requestId));
      }

      return jsonToolResponse({
        ok: true,
        schema: generatePlaintextPayloadSchema(published.definition)
      });
    }
  );

  server.registerTool(
    "get_envelope_schema",
    {
      title: "Get envelope schema",
      description: "Return the encrypted envelope JSON Schema for a published local MCP request.",
      inputSchema: {
        requestId: z.string()
      },
      annotations: readToolAnnotations()
    },
    async ({ requestId }) => {
      const published = latestPublishedByRequestId.get(requestId);
      if (published === undefined) {
        return jsonToolResponse(notFoundError(requestId));
      }

      return jsonToolResponse({
        ok: true,
        schema: generateEncryptedEnvelopeSchema(published.definition, published.hashes)
      });
    }
  );

  server.registerTool(
    "list_delivery_ledger",
    {
      title: "List delivery ledger",
      description: "Return metadata-only delivery ledger rows for a published local MCP request.",
      inputSchema: {
        requestId: z.string()
      },
      annotations: readToolAnnotations()
    },
    async ({ requestId }) => {
      if (!latestPublishedByRequestId.has(requestId)) {
        return jsonToolResponse(notFoundError(requestId));
      }

      return jsonToolResponse({
        ok: true,
        ledger: ledgerRowsByRequestId.get(requestId) ?? []
      });
    }
  );

  server.registerResource(
    "watasu_agent_card",
    new ResourceTemplate("watasu://requests/{requestId}/agent-card", {
      list: async () => ({
        resources: [...latestPublishedByRequestId.values()].map((published) => ({
          uri: resourceUri(published.request_id, "agent-card"),
          name: `watasu Agent Card for ${published.request_id}`,
          mimeType: "application/json"
        }))
      })
    }),
    {
      title: "watasu Agent Card",
      description: "A2A-compatible Agent Card for a published watasu request.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const requestId = stringVariable(variables.requestId);
      const published = latestPublishedByRequestId.get(requestId);
      if (published === undefined) {
        return resourceJson(uri, notFoundError(requestId), "application/json");
      }

      return resourceJson(
        uri,
        buildAgentCard({
          published,
          endpointUrl: defaultEndpointUrl(published)
        }),
        "application/json"
      );
    }
  );

  server.registerResource(
    "watasu_plaintext_schema",
    new ResourceTemplate("watasu://requests/{requestId}/schemas/plaintext", {
      list: async () => ({
        resources: [...latestPublishedByRequestId.values()].map((published) => ({
          uri: resourceUri(published.request_id, "schemas/plaintext"),
          name: `watasu plaintext schema for ${published.request_id}`,
          mimeType: "application/schema+json"
        }))
      })
    }),
    {
      title: "watasu plaintext payload schema",
      description: "Plaintext payload JSON Schema for a published watasu request.",
      mimeType: "application/schema+json"
    },
    async (uri, variables) => {
      const requestId = stringVariable(variables.requestId);
      const published = latestPublishedByRequestId.get(requestId);
      if (published === undefined) {
        return resourceJson(uri, notFoundError(requestId), "application/json");
      }

      return resourceJson(uri, generatePlaintextPayloadSchema(published.definition), "application/schema+json");
    }
  );

  server.registerResource(
    "watasu_envelope_schema",
    new ResourceTemplate("watasu://requests/{requestId}/schemas/envelope", {
      list: async () => ({
        resources: [...latestPublishedByRequestId.values()].map((published) => ({
          uri: resourceUri(published.request_id, "schemas/envelope"),
          name: `watasu envelope schema for ${published.request_id}`,
          mimeType: "application/schema+json"
        }))
      })
    }),
    {
      title: "watasu encrypted envelope schema",
      description: "Encrypted envelope JSON Schema for a published watasu request.",
      mimeType: "application/schema+json"
    },
    async (uri, variables) => {
      const requestId = stringVariable(variables.requestId);
      const published = latestPublishedByRequestId.get(requestId);
      if (published === undefined) {
        return resourceJson(uri, notFoundError(requestId), "application/json");
      }

      return resourceJson(
        uri,
        generateEncryptedEnvelopeSchema(published.definition, published.hashes),
        "application/schema+json"
      );
    }
  );

  server.registerResource(
    "watasu_delivery_ledger",
    new ResourceTemplate("watasu://requests/{requestId}/ledger", {
      list: async () => ({
        resources: [...latestPublishedByRequestId.values()].map((published) => ({
          uri: resourceUri(published.request_id, "ledger"),
          name: `watasu delivery ledger for ${published.request_id}`,
          mimeType: "application/json"
        }))
      })
    }),
    {
      title: "watasu metadata-only delivery ledger",
      description: "Metadata-only delivery ledger rows for a published watasu request.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const requestId = stringVariable(variables.requestId);
      if (!latestPublishedByRequestId.has(requestId)) {
        return resourceJson(uri, notFoundError(requestId), "application/json");
      }

      return resourceJson(
        uri,
        {
          ok: true,
          ledger: ledgerRowsByRequestId.get(requestId) ?? []
        },
        "application/json"
      );
    }
  );

  return server;
}

function jsonToolResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value)
      }
    ]
  };
}

function readToolAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };
}

function notFoundError(requestId: string): {
  ok: false;
  error: RequestDefinitionError;
} {
  return {
    ok: false,
    error: {
      code: "request_not_published",
      path: "$.requestId",
      message: `Request has not been published in this MCP workspace: ${requestId}`
    }
  };
}

function summarizePublishedRequest(published: PublishedRequestVersion) {
  return {
    request_id: published.request_id,
    request_version: published.request_version,
    hashes: published.hashes
  };
}

function resourceJson(uri: URL, value: unknown, mimeType: string) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType,
        text: JSON.stringify(value)
      }
    ]
  };
}

function resourceUri(requestId: string, suffix: string): string {
  return `watasu://requests/${encodeURIComponent(requestId)}/${suffix}`;
}

function defaultEndpointUrl(published: PublishedRequestVersion): string {
  return `https://api.watasu.dev/a2a/requests/${encodeURIComponent(
    published.request_id
  )}/${encodeURIComponent(published.request_version)}`;
}

function stringVariable(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
