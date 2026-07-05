import type {
  DeliveryClient,
  DeliveryCircuitBreaker,
  DeliveryConcurrencyLimiter,
  DeliveryLedger,
  IdempotencyStore,
  SubmissionRateLimiter,
  MetadataLedgerReader,
  PublishedRequestVersion,
  PublishOwnershipVerification,
  RequestDefinition,
  RequestVersionPublisher
} from "@watasu/core";
import {
  createFetchDeliveryClient,
  InMemoryConsentApprovalStore,
  InMemoryIdempotencyStore,
  InMemorySubmissionRateLimiter,
  type ConsentApprovalStore
} from "@watasu/core";
import type { JsonWebKey } from "node:crypto";
import {
  createTrustedServiceIdentityResolver,
  type TrustedServicePrincipal
} from "./hosted-identity.js";
import type { HostedSenderTrustResolver } from "./hosted-sender-auth.js";
import { createHostedMetadataApp } from "./hosted-metadata.js";
import {
  createHostedProductionApp,
  type HostedProductionApp,
  type HostedProductionRequest
} from "./hosted-production.js";
import { createHostedPublishApp } from "./hosted-publish.js";
import { createHostedSubmitApp } from "./hosted-submit.js";
import {
  createHostedConsentApp,
  type ConsentCredentialResolverInput
} from "./hosted-consent.js";

export interface CreateHostedProductionBootstrapAppInput {
  repository: RequestVersionPublisher & {
    list(requestId: string): PublishedRequestVersion[];
  };
  ledgerReader: MetadataLedgerReader;
  publicBaseUrl: string;
  deliveryClient?: DeliveryClient | undefined;
  deliveryLedger?: DeliveryLedger | undefined;
  idempotencyStore?: IdempotencyStore | undefined;
  rateLimiter?: SubmissionRateLimiter | undefined;
  clock?: (() => Date) | undefined;
  deliverySigningSecret: string;
  deliveryCircuitBreaker?: DeliveryCircuitBreaker | undefined;
  deliveryConcurrencyLimiter?: DeliveryConcurrencyLimiter | undefined;
  resolveDeliveryHost?: ((hostname: string) => Promise<string[]>) | undefined;
  resolveSenderTrust?: HostedSenderTrustResolver | undefined;
  consentAllowedOrigins?: readonly string[] | undefined;
  consentApprovalStore?: ConsentApprovalStore | undefined;
  consentTtlSeconds?: number | undefined;
  consentReceiptTtlSeconds?: number | undefined;
  resolveConsentCredentialPublicKey?: ((
    input: ConsentCredentialResolverInput
  ) => JsonWebKey | undefined | Promise<JsonWebKey | undefined>) | undefined;
  resolvePrincipal(request: HostedProductionRequest): TrustedServicePrincipal | undefined;
  resolveOwnershipVerification(input: {
    principal: TrustedServicePrincipal;
    request: HostedProductionRequest;
    requestId: string;
    definition: RequestDefinition;
  }): PublishOwnershipVerification;
  generateCapabilityToken?: (() => string) | undefined;
}

export function createHostedProductionBootstrapApp(
  input: CreateHostedProductionBootstrapAppInput
): HostedProductionApp {
  const clock = input.clock ?? (() => new Date());
  const idempotencyStore = input.idempotencyStore ?? new InMemoryIdempotencyStore();
  const consentApprovalStore = input.consentApprovalStore ?? new InMemoryConsentApprovalStore();
  const consentAllowedOrigins = input.consentAllowedOrigins ?? [new URL(input.publicBaseUrl).origin];
  const tenantByRequestId = new Map<string, string>();
  const pendingPublishTenants = new Map<string, string>();
  const resolveServiceIdentity = createTrustedServiceIdentityResolver({
    resolvePrincipal: input.resolvePrincipal
  });
  const publishRepository: RequestVersionPublisher = {
    publish(requestId, definition) {
      const published = input.repository.publish(requestId, definition);
      const tenantId = pendingPublishTenants.get(requestId);
      if (tenantId !== undefined) {
        tenantByRequestId.set(requestId, tenantId);
        pendingPublishTenants.delete(requestId);
      }

      return published;
    }
  };

  return createHostedProductionApp({
    publicBaseUrl: input.publicBaseUrl,
    requestVersions: input.repository,
    submitApp: createHostedSubmitApp({
      publicBaseUrl: input.publicBaseUrl,
      requestVersions: input.repository,
      deliveryClient: input.deliveryClient ?? createFetchDeliveryClient(),
      ledger: input.deliveryLedger ?? createNoopDeliveryLedger(),
      idempotencyStore,
      rateLimiter: input.rateLimiter ?? new InMemorySubmissionRateLimiter({
        limit: 60,
        windowMs: 60_000,
        clock
      }),
      resolveDeliveryHost: input.resolveDeliveryHost,
      clock,
      signingSecret: input.deliverySigningSecret,
      deliveryCircuitBreaker: input.deliveryCircuitBreaker,
      deliveryConcurrencyLimiter: input.deliveryConcurrencyLimiter,
      resolveSenderTrust: input.resolveSenderTrust,
      consentTtlSeconds: input.consentTtlSeconds,
      resolveTenantId({ published }) {
        return tenantByRequestId.get(published.request_id);
      }
    }),
    consentApp: createHostedConsentApp({
      publicBaseUrl: input.publicBaseUrl,
      signingSecret: input.deliverySigningSecret,
      clock,
      allowedOrigins: consentAllowedOrigins,
      idempotencyStore,
      approvalStore: consentApprovalStore,
      resolveCredentialPublicKey:
        input.resolveConsentCredentialPublicKey ?? (() => undefined),
      receiptTtlSeconds: input.consentReceiptTtlSeconds
    }),
    publishApp: createHostedPublishApp({
      repository: publishRepository,
      resolveServiceIdentity,
      authorizeRequestId({ serviceIdentity, requestId }) {
        const existingTenantId = tenantByRequestId.get(requestId);
        if (existingTenantId === undefined || existingTenantId === serviceIdentity.tenant_id) {
          return { ok: true };
        }

        return {
          ok: false,
          status: "forbidden",
          error: {
            code: "request_id_tenant_mismatch",
            message: "Hosted request_id is owned by a different tenant."
          }
        };
      },
      resolveOwnershipVerification({ serviceIdentity, request, requestId, definition }) {
        pendingPublishTenants.set(requestId, serviceIdentity.tenant_id);
        return input.resolveOwnershipVerification({
          principal: {
            tenant_id: serviceIdentity.tenant_id,
            roles: serviceIdentity.roles
          },
          request,
          requestId,
          definition
        });
      },
      generateCapabilityToken: input.generateCapabilityToken
    }),
    metadataApp: createHostedMetadataApp({
      ledgerReader: input.ledgerReader,
      resolveServiceIdentity
    })
  });
}

function createNoopDeliveryLedger(): DeliveryLedger {
  return {
    writeDeliveryAttempt() {}
  };
}
