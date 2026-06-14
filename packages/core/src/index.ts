export const corePackageName = "@watasu/core";

export {
  canonicalizeJson,
  validateRequestDefinitionInput
} from "./request-definition.js";
export { sha256Hash } from "./hash.js";
export {
  InMemoryRequestVersionRepository,
  createRequestVersionHashes
} from "./request-version.js";
export type { Sha256Hash } from "./hash.js";
export type {
  RequestDefinition,
  RequestDefinitionError,
  RequestDefinitionValidationResult,
  RequestFieldDefinition,
  Sensitivity,
  TrustProfile
} from "./request-definition.js";
export type {
  PublishedRequestVersion,
  RequestVersionHashes
} from "./request-version.js";
