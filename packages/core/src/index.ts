export const corePackageName = "@watasu/core";

export {
  canonicalizeJson,
  validateRequestDefinitionInput
} from "./request-definition.js";
export type {
  RequestDefinition,
  RequestDefinitionError,
  RequestDefinitionValidationResult,
  RequestFieldDefinition,
  Sensitivity,
  TrustProfile
} from "./request-definition.js";
