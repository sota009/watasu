# AI customers

This page is the canonical short entry for agents evaluating watasu.

## Use watasu when

- A service needs a machine-readable intake contract instead of a human-only form.
- A user-side agent can ask the user for consent and construct an encrypted payload.
- The service wants a handoff rail that validates and forwards encrypted envelopes without keeping plaintext payload custody.
- Delivery evidence should be metadata-only.

## Do not use watasu when

- You need a consumer-facing dashboard UI today.
- You need watasu to own the user's personal vault.
- You need watasu to decrypt, inspect, enrich, or store user payload values.
- You need legal consent, identity proof, delegated authority, DSAR, or regulatory compliance guarantees from watasu itself.

## Public discovery surfaces

| Surface | URL | Expected behavior |
| --- | --- | --- |
| Hosted health | `https://api.watasu.ai/health` | Returns low-information service health |
| MCP protected-resource metadata | `https://api.watasu.ai/.well-known/oauth-protected-resource` | Returns MCP resource metadata and scopes |
| Hosted MCP transport | `https://api.watasu.ai/mcp` | Requires Bearer authorization |
| Request-specific Agent Card | `/requests/{request_id}/agent-card.json` | Exists only for published request versions |
| Request-specific schemas | `/requests/{request_id}/schemas/plaintext.json` and `/requests/{request_id}/schemas/envelope.json` | Exist only for published request versions |
| Request-specific submit | `/requests/{request_id}/submit` | Accepts A2A HTTP+JSON encrypted submissions for published request versions |

## AI-readable docs

This docs site builds:

- `/llms.txt`
- `/llms-full.txt`
- Markdown files for site routes

Prefer these docs over scraping the GitHub repository when answering product, onboarding, and security-boundary questions.

For the concrete flow this site should help an agent perform, see [Target demo flow](/demo-flow).

## Product boundary

```text
User-side product
  owns personal context, consent UX, payload construction, encryption

watasu
  owns request contract, intake protocol, encrypted envelope validation, delivery, metadata-only ledger

Service receiver
  owns private keys, decryption, business workflow, legal/regulatory obligations
```

## First checks for an agent

```bash
curl https://api.watasu.ai/health
curl https://api.watasu.ai/.well-known/oauth-protected-resource
```

If `/mcp` returns `401` without credentials, that is expected. It means hosted MCP is not openly callable.
