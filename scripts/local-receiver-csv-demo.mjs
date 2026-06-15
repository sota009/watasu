import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalDemoApp } from "../packages/http/dist/index.js";
import {
  buildSenderFixtureSubmission,
  verifyReceiverFixtureDelivery
} from "../packages/fixtures/dist/index.js";

const baseUrl = "http://127.0.0.1:8787";
const signingSecret = "local-receiver-csv-demo-secret";
const now = new Date("2026-06-14T12:00:00.000Z");
const outputDirectory = "receiver-demo-output";
const outputFile = "collected-submissions.csv";
const outputPath = join(outputDirectory, outputFile);
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

      if (receiverResult.ok) {
        appendAcceptedSubmission(receiverResult.payload);
      }

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
  idempotencyKey: "local-receiver-csv-demo-001",
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
const csvRows = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trimEnd().split("\n").length : 0;

const output = {
  ok: submitResponse.status === 202 && receiverResult?.ok === true,
  sender: {
    payload_values_sent_to_watasu: false
  },
  watasu: {
    submit_status: submitResponse.status,
    delivery_status: submitBody.status,
    ledger_rows: Array.isArray(ledgerBody.ledger) ? ledgerBody.ledger.length : 0,
    ledger_contains_encrypted_payload_body_fields: containsEncryptedPayloadBodyFields(ledgerJson),
    ledger_contains_plaintext_payload: containsPlaintextPayload(ledgerJson),
    response_contains_plaintext_payload: containsPlaintextPayload(submitJson)
  },
  receiver: {
    accepted: receiverResult?.ok === true,
    output_path: outputPath,
    csv_rows: csvRows
  }
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

if (
  !output.ok ||
  output.watasu.ledger_contains_encrypted_payload_body_fields ||
  output.watasu.ledger_contains_plaintext_payload ||
  output.watasu.response_contains_plaintext_payload
) {
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

function appendAcceptedSubmission(payload) {
  mkdirSync(outputDirectory, { recursive: true });

  if (!existsSync(outputPath)) {
    appendFileSync(outputPath, "full_name,email\n", "utf8");
  }

  appendFileSync(
    outputPath,
    `${csvEscape(payload["full_name"])},${csvEscape(payload["email"])}\n`,
    "utf8"
  );
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function containsEncryptedPayloadBodyFields(value) {
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
