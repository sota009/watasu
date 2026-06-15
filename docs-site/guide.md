# Getting started

This guide starts from zero and shows the smallest useful watasu loop.

## What you need

- Node.js 22 or newer
- pnpm 10.31.0 or newer
- This repository cloned locally

## 1. Run the handoff demo

```bash
pnpm install
pnpm demo:handoff
```

You should see `ok: true`, `delivery_status: "delivered"`, and no payload body in the ledger.

## 2. Inspect the sample request

The sample request lives at:

```bash
packages/fixtures/requests/event-attendee.yaml
```

It asks for a full name and email address for an event attendee. It is intentionally small so you can inspect every output.

## 3. Validate the request

```bash
pnpm --filter @watasu/cli watasu validate packages/fixtures/requests/event-attendee.yaml
```

Expected shape:

```json
{
  "ok": true,
  "command": "validate",
  "request": {
    "name": "event-attendee-intake",
    "field_count": 2
  }
}
```

## 4. Generate schemas and Agent Card

```bash
pnpm --filter @watasu/cli watasu schema packages/fixtures/requests/event-attendee.yaml
pnpm --filter @watasu/cli watasu agent-card packages/fixtures/requests/event-attendee.yaml --confirm
```

The schema describes payload shape. The Agent Card tells an agent where to submit, which hashes to bind, and which encrypted-intake extension to use.

## 5. Run the local HTTP demo

```bash
pnpm typecheck
pnpm --filter @watasu/http demo
```

In another terminal:

```bash
curl http://127.0.0.1:8787/.well-known/agent-card.json
curl http://127.0.0.1:8787/schemas/plaintext.json
curl http://127.0.0.1:8787/schemas/envelope.json
```

## What you built

You verified the local loop:

```text
request definition -> schema -> Agent Card -> encrypted submit -> delivery -> metadata-only ledger
```

Next, read [AI customers](./ai-customers) if your caller is an agent, or [Security boundary](./security) if you are checking whether watasu can safely handle sensitive intake workflows.
