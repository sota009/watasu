import type {
  HostedServiceIdentity,
  MetadataLedgerReader
} from "@watasu/core";

export interface HostedMetadataRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HostedMetadataResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HostedMetadataApp {
  handle(request: HostedMetadataRequest): Promise<HostedMetadataResponse>;
}

export interface CreateHostedMetadataAppInput {
  ledgerReader: MetadataLedgerReader;
  resolveServiceIdentity(request: HostedMetadataRequest): HostedServiceIdentity | undefined;
}

export function createHostedMetadataApp(input: CreateHostedMetadataAppInput): HostedMetadataApp {
  return {
    async handle(request) {
      if (request.method !== "GET") {
        return jsonResponse(404, {
          ok: false,
          error: {
            code: "not_found",
            message: "Hosted metadata route was not found."
          }
        });
      }

      const requestId = matchLedgerPath(request.path);
      if (requestId === undefined) {
        return jsonResponse(404, {
          ok: false,
          error: {
            code: "not_found",
            message: "Hosted metadata route was not found."
          }
        });
      }

      const serviceIdentity = input.resolveServiceIdentity(request);
      if (serviceIdentity === undefined) {
        return jsonResponse(401, {
          ok: false,
          status: "auth_required",
          error: {
            code: "service_identity_required",
            message: "Hosted metadata ledger reads require an authenticated service identity."
          }
        });
      }

      const result = input.ledgerReader.readDeliveryMetadata({
        serviceIdentity,
        requestId
      });
      if (!result.ok) {
        return jsonResponse(result.status === "forbidden" ? 403 : 404, {
          ok: false,
          status: result.status,
          error: result.error
        });
      }

      return jsonResponse(200, {
        ok: true,
        rows: result.rows
      });
    }
  };
}

function matchLedgerPath(path: string): string | undefined {
  const match = /^\/requests\/([^/]+)\/ledger$/.exec(path);
  if (match === null) {
    return undefined;
  }

  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return undefined;
  }
}

function jsonResponse(status: number, value: unknown): HostedMetadataResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: `${JSON.stringify(value)}\n`
  };
}
