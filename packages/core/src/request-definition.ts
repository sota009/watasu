import { parse as parseYaml } from "yaml";
import { z } from "zod";

const sensitivityLevels = ["low", "moderate", "high", "prohibited"] as const;
const trustProfiles = ["local_demo", "human_consent"] as const;
const privateJwkMembers = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);

export type Sensitivity = (typeof sensitivityLevels)[number];
export type TrustProfile = (typeof trustProfiles)[number];

export interface RequestDefinitionError {
  code: string;
  path: string;
  message: string;
}

export interface RequestFieldDefinition {
  id: string;
  type: string;
  required: boolean;
  purpose: string;
  sensitivity: Sensitivity;
  label?: string | undefined;
  format?: string | undefined;
  examples?: unknown[] | undefined;
}

export interface RequestDefinition {
  name: string;
  schema_version: string;
  description: string;
  fields: RequestFieldDefinition[];
  consent: {
    text: string;
  };
  destination: {
    type: "webhook";
    url: string;
  };
  retention: {
    destination_policy: string;
  };
  encryption: {
    mode: "required";
    algorithm: "JWE";
    key_management: string;
    content_encryption: string;
    service_key_id: string;
    public_key_jwk: Record<string, unknown>;
  };
  metadata_retention: {
    days: number;
  };
  trust_profile: TrustProfile;
}

export type RequestDefinitionValidationResult =
  | {
      ok: true;
      definition: RequestDefinition;
      canonicalJson: string;
      warnings: RequestDefinitionError[];
    }
  | {
      ok: false;
      errors: RequestDefinitionError[];
      warnings: RequestDefinitionError[];
    };

const requestFieldSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean(),
  purpose: z.string().min(1),
  sensitivity: z.enum(sensitivityLevels),
  label: z.string().min(1).optional(),
  format: z.string().min(1).optional(),
  examples: z.array(z.unknown()).optional()
});

const requestDefinitionSchema = z.object({
  name: z.string().min(1),
  schema_version: z.string().min(1),
  description: z.string().min(1),
  fields: z.array(requestFieldSchema).min(1),
  consent: z.object({
    text: z.string().min(1)
  }),
  destination: z.object({
    type: z.literal("webhook"),
    url: z.url()
  }),
  retention: z.object({
    destination_policy: z.string().min(1)
  }),
  encryption: z.object({
    mode: z.literal("required"),
    algorithm: z.literal("JWE"),
    key_management: z.string().min(1),
    content_encryption: z.string().min(1),
    service_key_id: z.string().min(1),
    public_key_jwk: z.record(z.string(), z.unknown())
  }),
  metadata_retention: z.object({
    days: z.number().int().positive()
  }),
  trust_profile: z.enum(trustProfiles)
});

const sensitivityRank: Record<Sensitivity, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  prohibited: 3
};

// Each rule tags a field with the highest sensitivity its label/purpose implies.
// The comment on each entry names the category the patterns detect.
const inferenceRules: Array<{
  sensitivity: Sensitivity;
  patterns: RegExp[];
}> = [
  {
    // authentication_secret
    sensitivity: "prohibited",
    patterns: [
      /\b(api[_ -]?key|password|token|private[_ -]?key|recovery[_ -]?code|secret)\b/i
    ]
  },
  {
    // safety_sensitive_metadata
    sensitivity: "prohibited",
    patterns: [
      /\b(political|religious|union)(?:\b|[_ -])/i,
      /\b(dv[_ -]?shelter|whistleblow|anonymous[_ -]?source)\b/i
    ]
  },
  {
    // government_identity
    sensitivity: "high",
    patterns: [/\b(government[_ -]?id|passport|driver'?s?[_ -]?license|national[_ -]?id|kyc)\b/i]
  },
  {
    // financial_tax
    sensitivity: "high",
    patterns: [/\b(tax[_ -]?id|bank[_ -]?account|income|invoice|payment[_ -]?credential)\b/i]
  },
  {
    // minor_guardian
    sensitivity: "high",
    patterns: [/\b(minor[_ -]?age|under[_ -]?18|guardian|school|child)\b/i]
  },
  {
    // health_safety
    sensitivity: "high",
    patterns: [/\b(allerg(y|ies)|medication|symptom|disability|emergency[_ -]?contact)\b/i]
  },
  {
    // location_address
    sensitivity: "high",
    patterns: [/\b(address|postal[_ -]?code|precise[_ -]?location|workplace[_ -]?location)\b/i]
  },
  {
    // contact
    sensitivity: "moderate",
    patterns: [/\b(email|phone|full[_ -]?name|name|social[_ -]?handle)\b/i]
  }
];

export function validateRequestDefinitionInput(input: string): RequestDefinitionValidationResult {
  const parsed = parseRequestDefinitionInput(input);
  if (!parsed.ok) {
    return { ok: false, errors: [parsed.error], warnings: [] };
  }

  const structuralValidation = requestDefinitionSchema.safeParse(parsed.value);
  if (!structuralValidation.success) {
    return {
      ok: false,
      errors: structuralValidation.error.issues.map(toValidationError),
      warnings: []
    };
  }

  const normalizedDefinition = normalizeSensitivity(structuralValidation.data);
  const policyErrors = validatePolicy(normalizedDefinition);

  if (policyErrors.length > 0) {
    return { ok: false, errors: policyErrors, warnings: [] };
  }

  return {
    ok: true,
    definition: normalizedDefinition,
    canonicalJson: canonicalizeJson(normalizedDefinition),
    warnings: []
  };
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function parseRequestDefinitionInput(
  input: string
): { ok: true; value: unknown } | { ok: false; error: RequestDefinitionError } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    try {
      return { ok: true, value: parseYaml(input) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_request_definition",
          path: "$",
          message: error instanceof Error ? error.message : "Request definition could not be parsed."
        }
      };
    }
  }
}

function normalizeSensitivity(definition: RequestDefinition): RequestDefinition {
  return {
    ...definition,
    fields: definition.fields.map((field) => {
      const inferredSensitivity = inferFieldSensitivity(field);
      return {
        ...field,
        sensitivity: maxSensitivity(field.sensitivity, inferredSensitivity)
      };
    })
  };
}

function validatePolicy(
  normalizedDefinition: RequestDefinition
): RequestDefinitionError[] {
  const errors: RequestDefinitionError[] = [];

  normalizedDefinition.fields.forEach((field, index) => {
    if (field.sensitivity === "prohibited") {
      errors.push({
        code: "prohibited_field",
        path: `fields[${index}]`,
        message: `${field.id} is prohibited for the MVP request definition.`
      });
    }
  });

  for (const key of Object.keys(normalizedDefinition.encryption.public_key_jwk)) {
    if (privateJwkMembers.has(key)) {
      errors.push({
        code: "private_jwk_material",
        path: `encryption.public_key_jwk.${key}`,
        message: "public_key_jwk must not include private JWK material."
      });
    }
  }

  return errors;
}

function inferFieldSensitivity(field: RequestFieldDefinition): Sensitivity {
  const haystack = buildFieldPolicyHaystack(field);
  return inferenceRules.reduce<Sensitivity>((current, rule) => {
    if (!rule.patterns.some((pattern) => pattern.test(haystack))) {
      return current;
    }

    return maxSensitivity(current, rule.sensitivity);
  }, "low");
}

function buildFieldPolicyHaystack(field: RequestFieldDefinition): string {
  return [field.id, field.label, field.purpose, field.format, ...(field.examples ?? [])]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function maxSensitivity(left: Sensitivity, right: Sensitivity): Sensitivity {
  return sensitivityRank[left] >= sensitivityRank[right] ? left : right;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortJsonValue(record[key])])
    );
  }

  return value;
}

function toValidationError(issue: z.core.$ZodIssue): RequestDefinitionError {
  const path = issue.path.map(String).join(".");
  const code = path === "trust_profile" ? "invalid_trust_profile" : "invalid_request_definition";
  const message =
    issue.code === "invalid_type" && issue.input === undefined && path.length > 0
      ? `${path} is required.`
      : issue.message;

  return {
    code,
    path,
    message
  };
}
