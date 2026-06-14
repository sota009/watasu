import type {
  MetadataLedgerReader,
  PublishedRequestVersion,
  PublishOwnershipVerification,
  RequestDefinition,
  RequestVersionPublisher
} from "@watasu/core";
import {
  createTrustedServiceIdentityResolver,
  type TrustedServicePrincipal
} from "./hosted-identity.js";
import { createHostedMetadataApp } from "./hosted-metadata.js";
import {
  createHostedProductionApp,
  type HostedProductionApp,
  type HostedProductionRequest
} from "./hosted-production.js";
import { createHostedPublishApp } from "./hosted-publish.js";

export interface CreateHostedProductionBootstrapAppInput {
  repository: RequestVersionPublisher & {
    list(requestId: string): PublishedRequestVersion[];
  };
  ledgerReader: MetadataLedgerReader;
  publicBaseUrl: string;
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
  const resolveServiceIdentity = createTrustedServiceIdentityResolver({
    resolvePrincipal: input.resolvePrincipal
  });

  return createHostedProductionApp({
    publicBaseUrl: input.publicBaseUrl,
    requestVersions: input.repository,
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
