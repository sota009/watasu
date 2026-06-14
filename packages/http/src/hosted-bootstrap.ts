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
  InMemoryIdempotencyStore,
  InMemorySubmissionRateLimiter
} from "@watasu/core";
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
  const resolveServiceIdentity = createTrustedServiceIdentityResolver({
    resolvePrincipal: input.resolvePrincipal
  });

  return createHostedProductionApp({
    publicBaseUrl: input.publicBaseUrl,
    requestVersions: input.repository,
    submitApp: createHostedSubmitApp({
      publicBaseUrl: input.publicBaseUrl,
      requestVersions: input.repository,
      deliveryClient: input.deliveryClient ?? createFetchDeliveryClient(),
      ledger: input.deliveryLedger ?? createNoopDeliveryLedger(),
      idempotencyStore: input.idempotencyStore ?? new InMemoryIdempotencyStore(),
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
      resolveSenderTrust: input.resolveSenderTrust
    }),
    publishApp: createHostedPublishApp({
      repository: input.repository,
      resolveServiceIdentity,
      resolveOwnershipVerification({ serviceIdentity, request, requestId, definition }) {
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
