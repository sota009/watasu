---
pageType: home
title: watasu
hero:
  name: watasu
  text: Agent-native encrypted intake rail
  tagline: Publish a machine-readable request contract, receive encrypted submissions, and keep payload custody outside watasu.
  actions:
    - theme: brand
      text: Start the guide
      link: /guide
    - theme: alt
      text: AI-readable entry
      link: /ai-customers
features:
  - title: Machine-readable intake
    details: Request definitions, JSON Schema, Agent Cards, and A2A-compatible submit routes describe what is needed before a user-side agent sends data.
  - title: No payload custody
    details: watasu validates and forwards encrypted envelopes without receiving, decrypting, logging, or retaining plaintext payload values.
  - title: AI-readable docs
    details: This site builds llms.txt and llms-full.txt so agents can discover the product, boundaries, and public surfaces without scraping repository internals.
---

## Current status

| Surface | Status |
| --- | --- |
| Local protocol demo | Ready |
| CLI | Ready |
| Local HTTP demo | Ready |
| Hosted API | Private-alpha ready at `https://api.watasu.ai` |
| Hosted MCP | Auth required |
| Human dashboard UI | Not in MVP scope |
| User-side personal vault / agent | Not in MVP scope |

## What watasu does

```text
Service-side agent
  defines request
      |
      v
watasu
  publishes request definition, schemas, Agent Card
      |
      v
User-side agent
  asks the user, encrypts payload
      |
      v
watasu submit endpoint
  validates encrypted envelope, forwards it
      |
      v
Service receiver
  decrypts and acts
```

watasu is the secure handoff rail. It is not a form builder, user vault, or consumer AI companion.

## Try it locally

```bash
pnpm install
pnpm demo:handoff
```

The important output fields are:

```json
{
  "ok": true,
  "sender": {
    "payload_values_sent_to_watasu": false
  },
  "watasu": {
    "delivery_status": "delivered",
    "ledger_contains_payload_body": false,
    "response_contains_plaintext_payload": false
  }
}
```
