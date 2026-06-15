# Getting started

This guide starts from zero and shows the smallest useful watasu loop.

## How it works

watasu replaces a human form URL with an agent-readable contract URL.

The service side first defines what it needs in a request definition. For
example, an event service can ask for only the attendee fields it needs:

```yaml
name: event-attendee-intake
description: Collect attendee details for ExampleConf.
fields:
  - id: full_name
    type: string
    required: true
    purpose: Confirm attendees at reception.
  - id: email
    type: string
    format: email
    required: true
    purpose: Send event updates.
consent:
  text: ExampleConf uses this information only for event operations.
destination:
  type: webhook
  url: https://example.com/watasu/intake
encryption:
  mode: required
  algorithm: JWE
trust_profile: verified_sender
```

When that request is validated and published, watasu turns it into three things
that another agent can read:

```text
Agent Card URL   -> what this intake endpoint accepts and where to submit
schema URL       -> the plaintext payload shape the user must approve
submit endpoint  -> the A2A HTTP+JSON route for the encrypted envelope
```

In the local demo, those URLs are:

```text
GET  http://127.0.0.1:8787/.well-known/agent-card.json
GET  http://127.0.0.1:8787/schemas/plaintext.json
POST http://127.0.0.1:8787/submit
```

In hosted private alpha, the same idea is request-specific:

```text
GET  https://api.watasu.ai/requests/<request-id>/agent-card.json
GET  https://api.watasu.ai/requests/<request-id>/schemas/plaintext.json
POST https://api.watasu.ai/requests/<request-id>/submit
```

The handoff to the user-side agent is the Agent Card URL, usually with the
schema URL or a schema link inside the Agent Card. The user-side agent fetches
those URLs, shows the requested fields and consent text to the user, collects or
maps the approved values from the user's own context, encrypts the payload
outside watasu, then submits an A2A message to the submit endpoint.

The submit request is shaped like this at the protocol boundary:

```http
POST /submit
Content-Type: application/a2a+json
A2A-Version: 1.0
A2A-Extensions: https://watasu.dev/extensions/encrypted-intake/v1
```

```json
{
  "message": {
    "role": "ROLE_USER",
    "messageId": "submission-001",
    "parts": [
      {
        "type": "data",
        "mediaType": "application/json",
        "data": {
          "request_id": "event-attendee-intake",
          "request_version": "v1",
          "schema_hash": "sha256:...",
          "consent_receipt_hash": "sha256:...",
          "idempotency_key": "submit-001",
          "submitted_at": "2026-06-16T00:00:00.000Z",
          "service_key_id": "jwk-thumbprint:sha256:example",
          "encrypted_payload": {
            "protected": "base64url-protected",
            "iv": "base64url-iv",
            "ciphertext": "base64url-ciphertext",
            "tag": "base64url-tag"
          },
          "encrypted_payload_hash": "sha256:..."
        }
      }
    ]
  }
}
```

watasu validates the protocol headers, request version, schema hash, consent
hash, payload limits, idempotency, and encrypted envelope metadata. If the
submission is valid, watasu forwards the encrypted envelope to the service
receiver. The service receiver decrypts and acts on the data. watasu keeps
metadata-only delivery evidence and does not keep plaintext payload custody.

That split is the core product boundary:

```text
service-side agent
  defines request -> publishes Agent Card/schema/submit endpoint

user-side agent
  reads Agent Card/schema -> asks the user -> encrypts approved values -> submits

watasu
  validates encrypted submission -> forwards to receiver -> records metadata only

service receiver
  decrypts with its private key -> updates its own system
```

This is why the Agent Card is the important handoff artifact. A normal form link
tells a human what to type. A watasu Agent Card tells an agent what is being
requested, which version and hashes to bind to, which encryption requirements
apply, and which endpoint receives the encrypted envelope. It can be shared with
the user-side agent without exposing webhook secrets, private keys, receiver
internals, or real personal data.

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
