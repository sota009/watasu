# Target demo flow

This page describes the user-facing flow watasu should make easy to demonstrate.
It is intentionally split into what works today and what is the next demo slice.

## Story

```text
1. User
   asks their own agent in natural language

2. User-side agent
   reads this docs site, llms.txt, and the request-specific Agent Card

3. User-side agent
   writes a request YAML for the service-side intake

4. watasu CLI
   validates the request YAML and generates schemas plus an Agent Card

5. Sender fixture
   submits as if user information was collected successfully

6. Receiver demo
   appends one accepted row to CSV or Sheet

7. User
   opens the collected rows and checks what arrived
```

## Diagram

```text
User
  natural-language request
      |
      v
User-side agent
  understands watasu from docs / llms.txt / Agent Card
      |
      v
request YAML
      |
      v
watasu CLI
  validates request and publishes schema + Agent Card
      |
      v
sender fixture
  submits encrypted envelope
      |
      v
receiver demo
  decrypts and appends CSV / Sheet row
      |
      v
User
  views collected data
```

## Ready today

| Step | Status |
| --- | --- |
| AI-readable docs entry | Ready: this site generates `/llms.txt` and `/llms-full.txt` |
| Request YAML validation | Ready in CLI |
| Schema generation | Ready in CLI |
| Agent Card generation | Ready in CLI and local HTTP demo |
| Sender fixture submission | Ready for local handoff smoke tests |
| Receiver accepted response | Ready in local demo as metadata-only delivery evidence |
| Receiver CSV append | Ready: `pnpm demo:receiver-csv` writes to `receiver-demo-output/collected-submissions.csv` |
| Plaintext payload custody inside watasu | Intentionally not supported |

## Receiver CSV demo

The first user-visible destination is implemented as a local receiver-owned CSV
append demo:

```bash
pnpm demo:receiver-csv
```

It writes accepted demo rows to:

```text
receiver-demo-output/collected-submissions.csv
```

The `receiver-demo-output/` directory is ignored by Git. The CSV belongs to the
receiver demo, not to watasu's payload custody boundary.

## Next demo slice

The next destination slice can add a receiver-owned external destination:

| Destination | Recommended first scope |
| --- | --- |
| Google Sheets | Explicit credentials, explicit scopes, no secrets in docs or logs |

Google Sheets should stay outside watasu's payload custody boundary. The receiver
adapter owns credentials, decrypted payload validation, and row append behavior.

## Boundary

watasu should not become the user's personal data store or a dashboard for
reading decrypted payloads. The receiver demo owns decryption and row append.
watasu owns the request contract, Agent Card, encrypted submission validation,
delivery, and metadata-only evidence.

## Acceptance check for the demo

The demo is complete when a user can:

1. Ask an agent for a watasu-compatible intake in natural language.
2. See the generated request YAML.
3. Run a watasu CLI command that produces an Agent Card.
4. Run a sender fixture that submits one successful encrypted envelope.
5. Open a CSV file or Sheet and see one new row.
6. Confirm watasu logs and ledger output do not contain plaintext payload values.
