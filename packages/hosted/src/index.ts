import {
  buildOwnershipVerification,
  createMetadataLedgerReader,
  InMemoryPublishedRequestRegistry,
  InMemoryOwnershipChallengeRegistry,
  InMemoryPublishInviteStore,
  InMemoryRequestVersionRepository,
  createMigratedPostgresDeliveryLedgerStore,
  runHostedMetadataLedgerRetentionJob,
  type PostgresQueryClient,
  type PostgresDeliveryLedgerStore,
  type HostedServiceRole,
  type PublishOwnershipVerification,
  type RequestDefinition
} from "@watasu/core";
import {
  createHostedProductionBootstrapApp,
  createHostedProductionServer,
  loadHostedPublicBaseUrlConfig,
  loadHostedRuntimeConfig,
  loadHostedPostgresRuntimeConfig,
  createSignedServiceIdentityHeaders,
  createSignedServiceIdentityPrincipalResolver,
  type CreateSignedServiceIdentityHeadersInput,
  type HostedPublicBaseUrlConfig,
  type HostedRuntimeConfig,
  type HostedProductionRequest,
  type HostedPostgresRuntimeConfig
} from "@watasu/http";
import {
  buildMcpProtectedResourceMetadata,
  createHostedMcpHttpEntrypoint
} from "@watasu/mcp";
import type { Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type {
  Pool,
  PoolConfig,
  QueryResult
} from "pg";

export interface PostgresPoolLike {
  query(text: string, values: readonly unknown[]): Promise<Pick<QueryResult, "rows">>;
  end(): Promise<void>;
}

export interface HostedPostgresLedgerRuntime {
  store: PostgresDeliveryLedgerStore;
  close(): Promise<void>;
}

export interface HostedProductionServerRuntime {
  config: HostedRuntimeConfig & HostedPublicBaseUrlConfig;
  server: Server;
  close(): Promise<void>;
}

export interface HostedRetentionJobConfig {
  tenantId: string;
  retentionDays: number;
  dryRunDefault: boolean;
}

export interface HostedRetentionArgs {
  dryRun?: true | undefined;
}

export type HostedIdentityProviderConfig =
  | {
      provider: "signed_headers";
      signingSecret: string;
      maxSkewSeconds: number;
    };

export interface HostedMcpBearerTokenConfig {
  bearerToken: string;
}

export interface HostedPublishInviteConfigRecord {
  token: string;
  owner_id: string;
  tenant_id: string;
  roles: HostedServiceRole[];
  expires_at: string;
  max_publish_count: number;
  used_count?: number | undefined;
  revoked_at?: string | null | undefined;
}

export interface HostedTrialPublishConfig {
  destinationUrl: string;
  serviceKeyId: string;
  expiresAt: string;
}

export interface HostedSignedHeaderIdentityProvider {
  resolvePrincipal(request: HostedProductionRequest): ReturnType<
    ReturnType<typeof createSignedServiceIdentityPrincipalResolver>
  >;
  createHeaders(input: Omit<CreateSignedServiceIdentityHeadersInput, "signingSecret">): Record<string, string>;
}

export function loadHostedIdentityProviderConfig(
  env: Record<string, string | undefined>
): HostedIdentityProviderConfig {
  const minimumHostedSigningSecretBytes = 32;
  const maximumHostedServiceIdentitySkewSeconds = 300;
  const provider = env["WATASU_IDENTITY_PROVIDER"] ?? "signed_headers";
  if (provider !== "signed_headers") {
    throw new Error("WATASU_IDENTITY_PROVIDER must be signed_headers.");
  }

  const signingSecret = env["WATASU_SERVICE_IDENTITY_SIGNING_SECRET"]?.trim();
  if (signingSecret === undefined || signingSecret.length === 0) {
    throw new Error("WATASU_SERVICE_IDENTITY_SIGNING_SECRET is required when WATASU_IDENTITY_PROVIDER=signed_headers.");
  }
  if (Buffer.byteLength(signingSecret, "utf8") < minimumHostedSigningSecretBytes) {
    throw new Error("WATASU_SERVICE_IDENTITY_SIGNING_SECRET must be at least 32 bytes.");
  }
  if (isDocumentedPlaceholderSigningSecret(signingSecret)) {
    throw new Error("WATASU_SERVICE_IDENTITY_SIGNING_SECRET must not use a documented test or placeholder value.");
  }

  const maxSkewSeconds = parsePositiveIntegerEnv(env["WATASU_SERVICE_IDENTITY_MAX_SKEW_SECONDS"], {
    defaultValue: 60,
    name: "WATASU_SERVICE_IDENTITY_MAX_SKEW_SECONDS"
  });
  if (maxSkewSeconds > maximumHostedServiceIdentitySkewSeconds) {
    throw new Error("WATASU_SERVICE_IDENTITY_MAX_SKEW_SECONDS must be between 1 and 300.");
  }

  return {
    provider,
    signingSecret,
    maxSkewSeconds
  };
}

export function loadHostedMcpBearerTokenConfig(
  env: Record<string, string | undefined>
): HostedMcpBearerTokenConfig {
  const minimumHostedMcpBearerTokenBytes = 32;
  const bearerToken = env["WATASU_MCP_BEARER_TOKEN"]?.trim();
  if (bearerToken === undefined || bearerToken.length === 0) {
    throw new Error("WATASU_MCP_BEARER_TOKEN is required for hosted MCP transport.");
  }
  if (Buffer.byteLength(bearerToken, "utf8") < minimumHostedMcpBearerTokenBytes) {
    throw new Error("WATASU_MCP_BEARER_TOKEN must be at least 32 bytes.");
  }
  if (isDocumentedPlaceholderMcpBearerToken(bearerToken)) {
    throw new Error("WATASU_MCP_BEARER_TOKEN must not use a documented test or placeholder value.");
  }

  return {
    bearerToken
  };
}

export function loadHostedPublishInviteStoreFromEnv(
  env: Record<string, string | undefined>
): InMemoryPublishInviteStore | undefined {
  const raw = env["WATASU_HOSTED_PUBLISH_INVITES_JSON"]?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("WATASU_HOSTED_PUBLISH_INVITES_JSON must be a JSON array.");
  }

  const store = new InMemoryPublishInviteStore();
  for (const value of parsed) {
    const record = parseHostedPublishInviteConfigRecord(value);
    store.issueInvite({
      token: record.token,
      ownerId: record.owner_id,
      tenantId: record.tenant_id,
      roles: record.roles,
      expiresAt: record.expires_at,
      maxPublishCount: record.max_publish_count
    });
    for (let index = 0; index < (record.used_count ?? 0); index += 1) {
      store.incrementPublishCount(record.token);
    }
    if (record.revoked_at !== undefined && record.revoked_at !== null) {
      store.revokeToken(record.token, record.revoked_at);
    }
  }

  return store;
}

function parseHostedPublishInviteConfigRecord(value: unknown): HostedPublishInviteConfigRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("WATASU_HOSTED_PUBLISH_INVITES_JSON entries must be objects.");
  }

  const record = value as Record<string, unknown>;
  const roles = record.roles;
  if (
    typeof record.token !== "string" ||
    typeof record.owner_id !== "string" ||
    typeof record.tenant_id !== "string" ||
    !Array.isArray(roles) ||
    !roles.every((role): role is HostedServiceRole => role === "publisher") ||
    typeof record.expires_at !== "string" ||
    typeof record.max_publish_count !== "number" ||
    !Number.isInteger(record.max_publish_count)
  ) {
    throw new Error("WATASU_HOSTED_PUBLISH_INVITES_JSON entries are invalid.");
  }

  return {
    token: record.token,
    owner_id: record.owner_id,
    tenant_id: record.tenant_id,
    roles,
    expires_at: record.expires_at,
    max_publish_count: record.max_publish_count,
    used_count: typeof record.used_count === "number" ? record.used_count : undefined,
    revoked_at: typeof record.revoked_at === "string" ? record.revoked_at : null
  };
}

export function loadHostedTrialPublishConfigFromEnv(
  env: Record<string, string | undefined>
): HostedTrialPublishConfig | undefined {
  const destinationUrl = env["WATASU_HOSTED_TRIAL_DESTINATION_URL"]?.trim();
  const serviceKeyId = env["WATASU_HOSTED_TRIAL_SERVICE_KEY_ID"]?.trim();
  const expiresAt = env["WATASU_HOSTED_TRIAL_EXPIRES_AT"]?.trim();
  const values = [destinationUrl, serviceKeyId, expiresAt];
  if (values.every((value) => value === undefined || value.length === 0)) {
    return undefined;
  }

  if (destinationUrl === undefined || destinationUrl.length === 0 ||
    serviceKeyId === undefined || serviceKeyId.length === 0 ||
    expiresAt === undefined || expiresAt.length === 0) {
    throw new Error("Hosted trial publish env vars must be set together.");
  }

  const parsedUrl = new URL(destinationUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
    throw new Error("WATASU_HOSTED_TRIAL_DESTINATION_URL must be an HTTPS URL without credentials.");
  }

  if (Number.isNaN(new Date(expiresAt).getTime())) {
    throw new Error("WATASU_HOSTED_TRIAL_EXPIRES_AT must be a valid date-time.");
  }

  return {
    destinationUrl,
    serviceKeyId,
    expiresAt
  };
}

function buildHostedTrialPublishOwnership(input: {
  config: HostedTrialPublishConfig | undefined;
  definition: RequestDefinition;
  now: Date;
}): PublishOwnershipVerification | undefined {
  if (input.config === undefined) {
    return undefined;
  }

  if (new Date(input.config.expiresAt).getTime() <= input.now.getTime()) {
    return undefined;
  }

  if (input.definition.destination.url !== input.config.destinationUrl) {
    return undefined;
  }

  if (input.definition.encryption.service_key_id !== input.config.serviceKeyId) {
    return undefined;
  }

  if (!isLowRiskTrialRequest(input.definition)) {
    return undefined;
  }

  return {
    verifiedServiceKeyIds: [input.config.serviceKeyId],
    verifiedWebhookOrigins: [new URL(input.config.destinationUrl).origin]
  };
}

function mergeOwnershipVerification(
  base: PublishOwnershipVerification,
  extra: PublishOwnershipVerification | undefined
): PublishOwnershipVerification {
  if (extra === undefined) {
    return base;
  }

  return {
    verifiedServiceKeyIds: [...new Set([...base.verifiedServiceKeyIds, ...extra.verifiedServiceKeyIds])],
    verifiedWebhookOrigins: [...new Set([...base.verifiedWebhookOrigins, ...extra.verifiedWebhookOrigins])]
  };
}

function isLowRiskTrialRequest(definition: RequestDefinition): boolean {
  const allowedFieldIds = new Set(["email", "display_name"]);
  return definition.fields.length > 0 &&
    definition.fields.every((field) =>
      allowedFieldIds.has(field.id) &&
      (field.sensitivity === "low" || field.sensitivity === "moderate")
    );
}

function isDocumentedPlaceholderSigningSecret(signingSecret: string): boolean {
  return signingSecret === "test-deployment-identity-secret-with-enough-entropy" ||
    signingSecret === "local-demo-signing-secret" ||
    signingSecret === "sample-secret-value";
}

function isDocumentedPlaceholderMcpBearerToken(bearerToken: string): boolean {
  return bearerToken === "test-hosted-mcp-bearer-token-with-enough-entropy" ||
    bearerToken === "local-demo-mcp-bearer-token" ||
    bearerToken === "sample-mcp-bearer-token";
}

export function createSignedHeaderIdentityProviderFromEnv(input: {
  env: Record<string, string | undefined>;
  now: () => Date;
}): HostedSignedHeaderIdentityProvider {
  const config = loadHostedIdentityProviderConfig(input.env);
  const resolvePrincipal = createSignedServiceIdentityPrincipalResolver({
    signingSecret: config.signingSecret,
    now: input.now,
    maxSkewSeconds: config.maxSkewSeconds
  });

  return {
    resolvePrincipal,
    createHeaders(headerInput) {
      return createSignedServiceIdentityHeaders({
        ...headerInput,
        signingSecret: config.signingSecret
      });
    }
  };
}

export function loadHostedRetentionJobConfig(env: Record<string, string | undefined>): HostedRetentionJobConfig {
  const tenantId = env["WATASU_RETENTION_TENANT_ID"]?.trim();
  if (tenantId === undefined || tenantId.length === 0) {
    throw new Error("WATASU_RETENTION_TENANT_ID is required.");
  }

  return {
    tenantId,
    retentionDays: parsePositiveIntegerEnv(env["WATASU_METADATA_RETENTION_DAYS"], {
      defaultValue: 90,
      name: "WATASU_METADATA_RETENTION_DAYS"
    }),
    dryRunDefault: parseBooleanEnv(env["WATASU_RETENTION_DRY_RUN"], {
      defaultValue: false,
      name: "WATASU_RETENTION_DRY_RUN"
    })
  };
}

export function parseHostedRetentionArgs(argv: readonly string[]): HostedRetentionArgs {
  const args = argv.slice(2);
  if (args.length === 0) {
    return {};
  }

  if (args.length === 1 && args[0] === "--dry-run") {
    return {
      dryRun: true
    };
  }

  throw new Error("Usage: pnpm --filter @watasu/hosted retention -- [--dry-run]");
}

export function formatHostedCommandError(error: unknown, fallbackMessage: string): string {
  if (!(error instanceof Error)) {
    return fallbackMessage;
  }

  const message = error.message;
  if (containsSecretLikeHostedCommandFragment(message)) {
    return fallbackMessage;
  }

  if (/^(PORT|WATASU_[A-Z0-9_]+|Usage: )/.test(message)) {
    return message;
  }

  return fallbackMessage;
}

function containsSecretLikeHostedCommandFragment(message: string): boolean {
  return /postgres(?:ql)?:\/\//i.test(message) ||
    /\b(?:password|token|secret|private[_ -]?key)\b/i.test(message);
}

export function createHostedProductionServerFromEnv(input: {
  env: Record<string, string | undefined>;
  now: () => Date;
}): HostedProductionServerRuntime {
  const config = {
    ...loadHostedRuntimeConfig(input.env),
    ...loadHostedPublicBaseUrlConfig(input.env)
  };
  const webLedgerConfig = loadHostedPostgresRuntimeConfig(input.env);
  if (webLedgerConfig.mode !== "disabled") {
    throw new Error("WATASU_METADATA_LEDGER_STORE must be disabled for hosted production web runtime.");
  }
  if (input.env["WATASU_POSTGRES_URL"]?.trim()) {
    throw new Error("WATASU_POSTGRES_URL must not be set for hosted production web runtime.");
  }

  const identityProviderConfig = loadHostedIdentityProviderConfig(input.env);
  const mcpBearerTokenConfig = loadHostedMcpBearerTokenConfig(input.env);
  const publishInviteStore = loadHostedPublishInviteStoreFromEnv(input.env);
  const trialPublishConfig = loadHostedTrialPublishConfigFromEnv(input.env);
  const identityProvider = createSignedHeaderIdentityProviderFromEnv(input);
  const ownershipRegistry = new InMemoryOwnershipChallengeRegistry({
    clock: input.now
  });
  const requestRegistry = new InMemoryPublishedRequestRegistry();
  const app = createHostedProductionBootstrapApp({
    repository: new InMemoryRequestVersionRepository(),
    publishInviteStore,
    requestRegistry,
    publicBaseUrl: config.publicBaseUrl,
    deliverySigningSecret: identityProviderConfig.signingSecret,
    ledgerReader: createMetadataLedgerReader({
      rows: [],
      requestTenants: {},
      auditLog: {
        write() {}
      }
    }),
    resolvePrincipal: identityProvider.resolvePrincipal,
    resolveOwnershipVerification({ principal, definition }) {
      const registryOwnership = buildOwnershipVerification({
        tenant_id: principal.tenant_id,
        registry: ownershipRegistry
      });
      const trialOwnership = buildHostedTrialPublishOwnership({
        config: trialPublishConfig,
        definition,
        now: input.now()
      });

      return mergeOwnershipVerification(registryOwnership, trialOwnership);
    }
  });
  const mcpEntrypoint = createHostedMcpHttpEntrypoint({
    endpointPath: "/mcp",
    allowedOrigins: [config.publicBaseUrl],
    resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
    scopes: ["watasu:publish", "watasu:ledger:read"],
    authorizeBearerToken({ token, requiredScopes }) {
      if (!timingSafeStringEqual(token, mcpBearerTokenConfig.bearerToken)) {
        return {
          ok: false
        };
      }

      return {
        ok: true,
        scopes: [...requiredScopes]
      };
    }
  });
  const mcpProtectedResourceMetadata = buildMcpProtectedResourceMetadata({
    resource: `${config.publicBaseUrl}/mcp`,
    authorizationServers: [config.publicBaseUrl],
    scopesSupported: ["watasu:publish", "watasu:ledger:read"]
  });
  const server = createHostedProductionServer(app, {
    async beforeAppRequest(request, response) {
      const path = request.url === undefined ? "/" : new URL(request.url, config.publicBaseUrl).pathname;
      if (path === "/.well-known/oauth-protected-resource") {
        if (request.method !== "GET") {
          response.writeHead(405, {
            allow: "GET",
            "content-type": "application/json; charset=utf-8"
          });
          response.end(`${JSON.stringify({
            ok: false,
            error: {
              code: "method_not_allowed",
              message: "MCP protected-resource metadata supports GET."
            }
          })}\n`);
          return true;
        }

        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8"
        });
        response.end(`${JSON.stringify(mcpProtectedResourceMetadata)}\n`);
        return true;
      }

      if (path !== "/mcp") {
        return false;
      }

      await mcpEntrypoint(request, response);
      return true;
    }
  });

  return {
    config,
    server,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }

          reject(error);
        });
      });
    }
  };
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createPostgresPoolQueryClient(pool: {
  query(text: string, values: readonly unknown[]): Promise<Pick<QueryResult, "rows">>;
}): PostgresQueryClient {
  return {
    async query(text, values) {
      return pool.query(text, values);
    }
  };
}

function parsePositiveIntegerEnv(value: string | undefined, input: {
  defaultValue: number;
  name: string;
}): number {
  if (value === undefined) {
    return input.defaultValue;
  }

  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${input.name} must be a positive integer.`);
  }

  return parsed;
}

function parseStrictPositiveInteger(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBooleanEnv(value: string | undefined, input: {
  defaultValue: boolean;
  name: string;
}): boolean {
  if (value === undefined) {
    return input.defaultValue;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${input.name} must be true or false.`);
}

export function createNodePostgresPoolConfig(input: Extract<
  HostedPostgresRuntimeConfig,
  { mode: "postgres" }
>): PoolConfig {
  return {
    connectionString: input.databaseUrl,
    max: input.poolMax,
    ssl: input.ssl === "require"
      ? {
          rejectUnauthorized: true
        }
      : false
  };
}

export async function createNodePostgresPool(input: Extract<
  HostedPostgresRuntimeConfig,
  { mode: "postgres" }
>): Promise<Pool> {
  const pg = await import("pg");
  return new pg.Pool(createNodePostgresPoolConfig(input));
}

export async function createHostedPostgresLedgerStoreFromEnv(input: {
  env: Record<string, string | undefined>;
  tenantId: string;
  createPool?: ((config: PoolConfig) => PostgresPoolLike) | undefined;
}): Promise<HostedPostgresLedgerRuntime> {
  const config = loadHostedPostgresRuntimeConfig(input.env);
  if (config.mode !== "postgres") {
    throw new Error("WATASU_METADATA_LEDGER_STORE must be postgres for hosted Postgres runtime wiring.");
  }

  const pool = input.createPool === undefined
    ? await createNodePostgresPool(config)
    : input.createPool(createNodePostgresPoolConfig(config));
  const queryClient = createPostgresPoolQueryClient(pool);
  const store = await createMigratedPostgresDeliveryLedgerStore({
    tenantId: input.tenantId,
    queryClient,
    runMigration: config.runMigrations
  });

  return {
    store,
    async close() {
      await pool.end();
    }
  };
}

export async function runHostedPostgresRetentionJobFromEnv(input: {
  dryRun?: boolean | undefined;
  env: Record<string, string | undefined>;
  now: () => Date;
  createPool?: ((config: PoolConfig) => PostgresPoolLike) | undefined;
}) {
  const config = loadHostedRetentionJobConfig(input.env);
  const postgresConfig = loadHostedPostgresRuntimeConfig(input.env);
  if (postgresConfig.mode !== "postgres") {
    throw new Error("WATASU_METADATA_LEDGER_STORE must be postgres for hosted retention runtime.");
  }
  if (input.env["WATASU_SERVICE_IDENTITY_SIGNING_SECRET"]?.trim()) {
    throw new Error("WATASU_SERVICE_IDENTITY_SIGNING_SECRET must not be set for hosted retention runtime.");
  }

  const runtime = await createHostedPostgresLedgerStoreFromEnv({
    env: input.env,
    tenantId: config.tenantId,
    createPool: input.createPool
  });

  try {
    const now = input.now();
    const result = await runHostedMetadataLedgerRetentionJob({
      dryRun: input.dryRun ?? config.dryRunDefault,
      serviceIdentity: {
        tenant_id: config.tenantId,
        roles: ["auditor"]
      },
      now,
      retentionDays: config.retentionDays,
      store: runtime.store
    });

    return {
      ...result,
      checked_at: now.toISOString(),
      retention_days: config.retentionDays
    };
  } finally {
    await runtime.close();
  }
}
