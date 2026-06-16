import type {
  AsyncIdempotencyStore,
  AsyncRequestVersionPublisher,
  AsyncSubmissionRateLimiter,
  DeliveryClient,
  DeliveryCircuitBreaker,
  DeliveryConcurrencyLimiter,
  DeliveryLedger,
  MetadataLedgerReader,
  PublishedRequestRegistry,
  PublishedRequestVersion,
  PublishInviteStore,
  PublishOwnershipVerification,
  RequestDefinition,
  SubmissionCapability
} from "@watasu/core";
import {
  createFetchDeliveryClient,
  InMemoryIdempotencyStore,
  InMemorySubmissionRateLimiter
} from "@watasu/core";
import {
  createTrustedServiceIdentityResolver,
  parseAuthorizationBearerToken,
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
import { createHostedRetireApp } from "./hosted-retire.js";
import { createHostedSubmitApp } from "./hosted-submit.js";

export interface CreateHostedProductionBootstrapAppInput {
  repository: AsyncRequestVersionPublisher & {
    list(requestId: string): PublishedRequestVersion[] | Promise<PublishedRequestVersion[]>;
  };
  ledgerReader: MetadataLedgerReader;
  publicBaseUrl: string;
  deliveryClient?: DeliveryClient | undefined;
  deliveryLedger?: DeliveryLedger | undefined;
  idempotencyStore?: AsyncIdempotencyStore | undefined;
  rateLimiter?: AsyncSubmissionRateLimiter | undefined;
  publishInviteStore?: PublishInviteStore | undefined;
  requestRegistry?: PublishedRequestRegistry | undefined;
  clock?: (() => Date) | undefined;
  deliverySigningSecret: string;
  deliveryCircuitBreaker?: DeliveryCircuitBreaker | undefined;
  deliveryConcurrencyLimiter?: DeliveryConcurrencyLimiter | undefined;
  resolveDeliveryHost?: ((hostname: string) => Promise<string[]>) | undefined;
  resolveSenderTrust?: HostedSenderTrustResolver | undefined;
  resolveCapability?: ((input: {
    capabilityUrl: string;
    published: PublishedRequestVersion;
    tenantId?: string | undefined;
  }) => SubmissionCapability | Promise<SubmissionCapability>) | undefined;
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
  const tenantByRequestId = new Map<string, string>();
  const pendingPublishTenants = new Map<string, string>();
  const inviteCredentialByRequest = new WeakMap<HostedProductionRequest, string>();
  const inviteAuthFailureByRequest = new WeakMap<HostedProductionRequest, {
    status: 401 | 403;
    code: string;
    message: string;
  }>();
  const resolveServiceIdentity = createTrustedServiceIdentityResolver({
    resolvePrincipal(request) {
      const principal = input.resolvePrincipal(request);
      if (principal !== undefined) {
        return principal;
      }

      if (input.publishInviteStore === undefined) {
        return undefined;
      }

      const bearerCredential = parseAuthorizationBearerToken(request.headers.authorization);
      if (bearerCredential === undefined) {
        return undefined;
      }

      const result = input.publishInviteStore.resolveToken(bearerCredential, clock());
      if (!result.ok) {
        inviteAuthFailureByRequest.set(request as HostedProductionRequest, {
          status: result.status === "auth_required" ? 401 : 403,
          code: result.error.code,
          message: result.error.message
        });
        return undefined;
      }

      inviteCredentialByRequest.set(request as HostedProductionRequest, bearerCredential);
      return {
        tenant_id: result.identity.tenant_id,
        owner_id: result.identity.owner_id,
        roles: result.identity.roles
      };
    }
  });
  const publishRepository: AsyncRequestVersionPublisher = {
    async publish(requestId, definition) {
      let published: PublishedRequestVersion;
      try {
        published = await input.repository.publish(requestId, definition);
      } catch (error) {
        pendingPublishTenants.delete(requestId);
        throw error;
      }

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
    isRequestRetired: input.requestRegistry?.isRetired.bind(input.requestRegistry),
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
      resolveSenderTrust: input.resolveSenderTrust,
      resolveCapability: input.resolveCapability,
      resolveTenantId({ published }) {
        return tenantByRequestId.get(published.request_id);
      }
    }),
    publishApp: createHostedPublishApp({
      repository: publishRepository,
      resolveServiceIdentity,
      resolveServiceIdentityFailure(request) {
        return inviteAuthFailureByRequest.get(request as HostedProductionRequest);
      },
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
      generateCapabilityToken: input.generateCapabilityToken,
      async afterSuccessfulPublish({ serviceIdentity, request, published }) {
        const bearerCredential = inviteCredentialByRequest.get(request as HostedProductionRequest);
        if (bearerCredential !== undefined) {
          input.publishInviteStore?.incrementPublishCount(bearerCredential);
        }

        await input.requestRegistry?.recordPublished({
          tenant_id: serviceIdentity.tenant_id,
          owner_id: serviceIdentity.owner_id ?? serviceIdentity.tenant_id,
          request_id: published.request_id,
          request_version: published.request_version,
          published_at: published.published_at,
          retired_at: null
        });
      }
    }),
    retireApp: input.requestRegistry === undefined
      ? undefined
      : createHostedRetireApp({
          registry: input.requestRegistry,
          resolveServiceIdentity,
          clock
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
