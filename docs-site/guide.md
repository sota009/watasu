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
