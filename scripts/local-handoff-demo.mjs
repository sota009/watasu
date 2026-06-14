import { createLocalDemoApp, localDemoSubmitPath } from "../packages/http/dist/index.js";
import {
  buildSenderFixtureSubmission,
  verifyReceiverFixtureDelivery
} from "../packages/fixtures/dist/index.js";

const baseUrl = "http://127.0.0.1:8787";
const signingSecret = "local-handoff-demo-secret";
const now = new Date("2026-06-14T12:00:00.000Z");
const samplePayload = {
  full_name: "Alice Example",
  email: "alice@example.com"
};

let plaintextSchema;
let receiverResult;

const app = createLocalDemoApp({
  baseUrl,
  signingSecret,
  clock: () => now,
  deliveryClient: {
    async post(request) {
      if (plaintextSchema === undefined) {
        return { status: 500 };
      }

      receiverResult = verifyReceiverFixtureDelivery({
        request,
        signingSecret,
        plaintextSchema,
        now,
        decryptPayload() {
          return samplePayload;
        }
      });

      return {
        status: receiverResult.ok ? 204 : 400
      };
    }
  }
});

const agentCard = await getJson("/.well-known/agent-card.json");
plaintextSchema = await getJson("/schemas/plaintext.json");

const submission = buildSenderFixtureSubmission({
  agentCard,
  plaintextSchema,
  payload: samplePayload,
  idempotencyKey: "local-handoff-demo-001",
  submittedAt: now.toISOString(),
  encryptPayload() {
    return {
      protected: "base64url-protected",
      iv: "base64url-iv",
      ciphertext: "base64url-ciphertext",
      tag: "base64url-tag"
    };
  }
});

const submitResponse = await app.handle({
  method: "POST",
  path: new URL(submission.url).pathname,
  headers: submission.headers,
  body: JSON.stringify(submission.body)
});
const submitBody = JSON.parse(submitResponse.body);
const ledgerResponse = await app.handle({
  method: "GET",
  path: "/ledger",
  headers: {},
  body: ""
});
const ledgerBody = JSON.parse(ledgerResponse.body);
const ledgerJson = JSON.stringify(ledgerBody);
const submitJson = JSON.stringify(submitBody);

const output = {
  ok: submitResponse.status === 202 && receiverResult?.ok === true,
  sender: {
    endpoint: submission.url,
    payload_values_sent_to_watasu: false
  },
  watasu: {
    submit_status: submitResponse.status,
    delivery_status: submitBody.status,
    ledger_rows: Array.isArray(ledgerBody.ledger) ? ledgerBody.ledger.length : 0,
    ledger_contains_payload_body: containsPayloadBody(ledgerJson),
    response_contains_plaintext_payload: containsPlaintextPayload(submitJson)
  },
  receiver: {
    accepted: receiverResult?.ok === true,
    request_id: receiverResult?.ok === true ? receiverResult.metadata.request_id : undefined,
    request_version: receiverResult?.ok === true ? receiverResult.metadata.request_version : undefined
  }
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

if (!output.ok || output.watasu.ledger_contains_payload_body || output.watasu.response_contains_plaintext_payload) {
  process.exitCode = 1;
}

async function getJson(path) {
  const response = await app.handle({
    method: "GET",
    path,
    headers: {},
    body: ""
  });

  if (response.status !== 200) {
    throw new Error(`Expected ${path} to return 200, got ${response.status}.`);
  }

  return JSON.parse(response.body);
}

function containsPayloadBody(value) {
  return (
    value.includes("\"encrypted_payload\"") ||
    value.includes("\"protected\"") ||
    value.includes("\"ciphertext\"") ||
    value.includes("\"tag\"")
  );
}

function containsPlaintextPayload(value) {
  return value.includes(samplePayload.full_name) || value.includes(samplePayload.email);
}
