# How it works

This is the human-facing starting point. It explains what happens in a watasu
handoff without assuming that you run developer commands yourself.

## The short version

watasu lets a service publish a machine-readable request contract. A user-side
agent can read that contract, ask the user for the requested information,
encrypt the payload, and submit it through watasu. watasu validates and forwards
the encrypted envelope while keeping plaintext payload custody out of scope.

<div class="handoff-map" aria-label="Human-facing watasu flow">
  <div>
    <span>1</span>
    <strong>Service publishes a contract</strong>
    <p>The request describes fields, consent text, schemas, endpoints, and encryption metadata.</p>
  </div>
  <div>
    <span>2</span>
    <strong>Agent reads the contract</strong>
    <p>The agent uses docs, llms files, and request-specific Agent Cards.</p>
  </div>
  <div>
    <span>3</span>
    <strong>User confirms the handoff</strong>
    <p>The user-side experience owns the consent prompt and personal context.</p>
  </div>
  <div>
    <span>4</span>
    <strong>watasu forwards safely</strong>
    <p>watasu checks the encrypted envelope and records delivery evidence without plaintext payload values.</p>
  </div>
</div>

## Concrete handoff example

Think of watasu as replacing a human form URL with an agent-readable contract
URL. The service side first defines what it needs in a request definition:

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

When that request is validated and published, watasu turns it into the surfaces
another agent can read:

```text
Agent Card URL   -> what this intake endpoint accepts and where to submit
schema URL       -> the plaintext payload shape the user must approve
submit endpoint  -> the A2A HTTP+JSON route for the encrypted envelope
```

In the local demo, those surfaces look like this:

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

At the protocol boundary, the submit request uses the A2A HTTP+JSON route:

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

## What a person should do first

Start by deciding which role you are evaluating:

| Role | Start with | Why |
| --- | --- | --- |
| Agent or integration backend | [For agents](./ai-customers) | Lists public discovery surfaces and machine-readable docs. |
| Security reviewer | [Security boundary](./security) | Explains what watasu does not decrypt, store, or own. |

## What you can try

The simplest demo path is:

```text
ask an agent -> agent reads the contract -> user confirms -> encrypted submit -> receiver-owned CSV or Sheet row
```

The visible output should be a receiver-owned destination, such as a CSV or
Sheet, with one accepted row. watasu should only show metadata-only delivery
evidence and should not show plaintext payload values.

If you want to hand this work to a service-side coding or operations agent, use
[Operator prompts](/operator-prompts). That page spells out the docs URLs,
authorization context, receiver requirements, publish output, and participant
prompt that the agent needs to complete the setup.

## What an agent should use

An agent should use the public contract surfaces that are available for the
workflow it is performing:

- This docs site and its generated `/llms.txt` and `/llms-full.txt` files.
- Request-specific Agent Cards.
- Request-specific plaintext and envelope schemas.
- Hosted API endpoints when the workflow is authorized.

## What watasu does not do

watasu does not provide the user-side personal vault, consumer dashboard,
legal-consent system, or decrypted-payload viewer in the MVP. Those belong to
the user-side product and receiver-side service.

## Access posture

Public docs can explain the protocol and discovery surfaces, but request-specific
submit, publish, MCP, and ledger routes may require authorization.
