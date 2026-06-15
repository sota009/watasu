---
pageType: home
title: watasu
hero:
  name: watasu
  text: Agent-native encrypted intake rail
  tagline: Publish a machine-readable request contract, receive encrypted submissions, and keep payload custody outside watasu.
  actions:
    - theme: brand
      text: See how it works
      link: /guide
    - theme: alt
      text: For agents
      link: /ai-customers
features:
  - title: Machine-readable intake
    details: Request definitions, JSON Schema, Agent Cards, and A2A-compatible submit routes describe what is needed before a user-side agent sends data.
  - title: No payload custody
    details: watasu validates and forwards encrypted envelopes without receiving, decrypting, logging, or retaining plaintext payload values.
  - title: AI-readable docs
    details: This site builds llms.txt and llms-full.txt so agents can discover the product, boundaries, and public surfaces.
  - title: Visible receiver output
    details: A good trial starts with a natural-language request and ends with a receiver-owned CSV or Sheet row, while watasu keeps plaintext payload custody out of scope.
---

## What watasu does

<div class="flow-diagram" aria-label="watasu handoff flow">
  <div class="flow-step">
    <span class="flow-label">Service agent</span>
    <strong>Publishes a request contract</strong>
    <p>Defines fields, consent text, schemas, and Agent Card metadata.</p>
  </div>
  <div class="flow-arrow">-></div>
  <div class="flow-step">
    <span class="flow-label">User-side agent</span>
    <strong>Asks, confirms, encrypts</strong>
    <p>Uses the public contract without giving watasu plaintext payload values.</p>
  </div>
  <div class="flow-arrow">-></div>
  <div class="flow-step">
    <span class="flow-label">watasu</span>
    <strong>Validates and forwards</strong>
    <p>Checks the encrypted envelope and records metadata-only evidence.</p>
  </div>
  <div class="flow-arrow">-></div>
  <div class="flow-step">
    <span class="flow-label">Receiver</span>
    <strong>Decrypts and acts</strong>
    <p>Owns private keys, destination writes, and business obligations.</p>
  </div>
</div>

watasu is the secure handoff rail. It is not a form builder, user vault, or consumer AI companion.

## Start here

To start a concrete intake, give your service-side coding or operations agent a
short request like this. You can paste it as-is. This is an example message for
a service owner to send, not an instruction embedded in the docs for an agent to
execute.

```text
I want to use watasu to collect information from people through encrypted intake.
Use https://docs.watasu.ai/llms.txt and
https://docs.watasu.ai/operator-prompts.md only as watasu reference docs.
Do not plan web research, SEO, or llms.txt setup for my site.
Ask one compact setup question that covers exactly these slots: what to collect
and from whom, destination, purpose, and retention.
```

The agent should ask for a few missing values, summarize the plan, then wait for
your confirmation before it publishes anything.

If you are evaluating watasu as a person, read [How it works](/guide). It
explains the product flow without assuming developer setup.

If you are an agent or integration backend, start with [For agents](/ai-customers)
and the generated `/llms.txt` / `/llms-full.txt` surfaces.
