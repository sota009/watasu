# Protocol surfaces

watasu exposes a small set of protocol surfaces for agents and integration
backends.

## Request definition

A request definition describes:

- request name
- schema version
- fields and purpose
- consent text
- destination policy
- encryption metadata
- metadata retention policy
- trust profile

## Discovery routes

| Route | Purpose |
| --- | --- |
| `/health` | Low-information health check |
| `/.well-known/oauth-protected-resource` | MCP protected-resource metadata |
| `/mcp` | Hosted MCP transport, Bearer auth required |

## Request-specific routes

| Route | Purpose |
| --- | --- |
| `/requests/{request_id}/agent-card.json` | Published request Agent Card |
| `/requests/{request_id}/schemas/plaintext.json` | Published plaintext payload schema |
| `/requests/{request_id}/schemas/envelope.json` | Published encrypted envelope schema |
| `/requests/{request_id}/submit` | Published encrypted submit route |

## Compatibility notes

- MCP is used for service-side agent workflows.
- A2A HTTP+JSON is used for encrypted submission.
- Agent Card is the public machine-readable contract.
- JSON Schema describes both the plaintext payload shape and the encrypted envelope shape.
