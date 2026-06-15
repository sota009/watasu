# Security boundary

watasu's core promise is **no payload custody**.

## What that means

watasu should not:

- receive plaintext payloads
- decrypt payloads
- store plaintext payloads
- log payload values
- retain encrypted payload bodies after a delivery attempt
- keep a payload retry queue

watasu may keep metadata-only delivery evidence, such as request id, request version, idempotency key, timestamps, delivery status, and encrypted payload hash.

## Why metadata still matters

Metadata can still become personal-related information when combined with other records. For that reason, hosted metadata paths use tenant, role, audit, and retention boundaries.

## Agent Card safety

Agent Cards can expose:

- request fields
- purpose text
- schema hash
- consent text hash
- encryption public metadata
- submit endpoint
- payload limits
- trust profile

Agent Cards must not expose:

- webhook secrets
- receiver private URLs
- private keys
- plaintext sample payload values
- database URLs
- service identity secrets

## Failure behavior

If delivery fails, watasu returns sender-actionable failure information such as `resubmit_later`. It should not keep a payload retry queue. The sender remains responsible for resubmitting when appropriate.

## Human responsibility

watasu does not guarantee legal consent, identity verification, delegated authority, regulatory compliance, or DSAR workflows. Those remain service-side or product-side responsibilities.
