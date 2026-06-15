# Protocol surfaces

watasu exposes a small set of protocol surfaces. The same concepts appear in local demo, CLI, MCP, and hosted private-alpha runtime.

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

The sample lives at:

```bash
packages/fixtures/requests/event-attendee.yaml
```

## CLI commands

| Command | Purpose |
| --- | --- |
| `validate` | Validate a request definition |
| `schema` | Generate plaintext payload and encrypted envelope schemas |
| `publish --confirm` | Publish a local request version |
| `agent-card --confirm` | Generate the Agent Card |
| `ledger --confirm` | Show metadata-only delivery rows |
| `inspect-delivery --confirm` | Show one delivery attempt |
| `submit-fixture --payload ... --confirm` | Run a local sender fixture |

## Local HTTP demo

| Route | Purpose |
| --- | --- |
| `/.well-known/agent-card.json` | Agent Card for the local fixture |
| `/schemas/plaintext.json` | Plaintext payload JSON Schema |
| `/schemas/envelope.json` | Encrypted envelope JSON Schema |
| `POST /submit` | A2A HTTP+JSON encrypted submission |
| `/ledger` | Metadata-only delivery ledger |

## Hosted private-alpha routes

| Route | Purpose |
| --- | --- |
| `/health` | Low-information health check |
| `/.well-known/oauth-protected-resource` | MCP protected-resource metadata |
| `/mcp` | Hosted MCP transport, Bearer auth required |
| `/requests/{request_id}/publish` | Authenticated publish boundary |
| `/requests/{request_id}/agent-card.json` | Published request Agent Card |
| `/requests/{request_id}/schemas/plaintext.json` | Published plaintext payload schema |
| `/requests/{request_id}/schemas/envelope.json` | Published encrypted envelope schema |
| `/requests/{request_id}/submit` | Published encrypted submit route |
| `/requests/{request_id}/ledger` | Authenticated metadata-only ledger read |

## Compatibility notes

- MCP is used for service-side agent workflows.
- A2A HTTP+JSON is used for encrypted submission.
- Agent Card is the public machine-readable contract.
- JSON Schema describes both the plaintext payload shape and the encrypted envelope shape.
