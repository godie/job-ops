import {
  getLlmMessageText,
  type JsonSchemaDefinition,
  type LlmRequestOptions,
} from "../types";

/** OpenCode model identifiers are `providerID/modelID`. */
export function parseOpenCodeModel(
  model: string,
): { providerID: string; id: string } | undefined {
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return {
    providerID: trimmed.slice(0, slash),
    id: trimmed.slice(slash + 1),
  };
}

/** HTTP Basic header for the fixed `opencode` user. */
export function buildOpenCodeAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

/**
 * The generate endpoint takes one prompt. Flatten `system` + conversation
 * messages into a single role-labeled transcript and append the schema so the
 * model returns JSON the caller can parse (OpenCode enforces no schema).
 */
export function flattenMessagesToPrompt(
  messages: LlmRequestOptions<unknown>["messages"],
  jsonSchema?: JsonSchemaDefinition,
): string {
  const transcript = messages
    .map(
      (message, index) =>
        `Message ${index + 1} (${message.role.toUpperCase()}):\n${getLlmMessageText(message.content).trim()}`,
    )
    .join("\n\n");

  const parts = [
    "You are generating a response for JobOps.",
    "Do not run commands or tools. Answer directly.",
    "Return only valid JSON with no markdown fences or extra text.",
  ];

  if (jsonSchema) {
    parts.push(
      "The response must follow this schema exactly:",
      JSON.stringify(jsonSchema.schema, null, 2),
    );
  }

  parts.push("Conversation:", transcript);
  return parts.join("\n\n");
}

type SchemaLike = JsonSchemaDefinition["schema"];

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * Minimal recursive JSON Schema check (type/required/properties/items/
 * additionalProperties) so a schema-violating OpenCode response triggers a
 * repair instead of silently reaching the caller. Returns an error string or
 * null when valid.
 */
export function validateJsonAgainstSchema(
  value: unknown,
  schema: SchemaLike | unknown,
): string | null {
  if (!schema || typeof schema !== "object") return null;
  const node = schema as Record<string, unknown>;

  const expectedType = node.type;
  if (typeof expectedType === "string" && !matchesType(value, expectedType)) {
    return `expected ${expectedType}`;
  }
  if (
    Array.isArray(expectedType) &&
    !expectedType.some(
      (type) => typeof type === "string" && matchesType(value, type),
    )
  ) {
    return `expected one of ${expectedType.join(", ")}`;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties =
      node.properties && typeof node.properties === "object"
        ? (node.properties as Record<string, unknown>)
        : null;

    for (const key of Array.isArray(node.required) ? node.required : []) {
      if (typeof key === "string" && !(key in record)) {
        return `missing required property "${key}"`;
      }
    }

    if (properties) {
      for (const [key, subSchema] of Object.entries(properties)) {
        if (key in record) {
          const error = validateJsonAgainstSchema(record[key], subSchema);
          if (error) return `property "${key}": ${error}`;
        }
      }
    }

    if (node.additionalProperties === false && properties) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) return `unexpected property "${key}"`;
      }
    }
  }

  if (Array.isArray(value) && node.items) {
    for (let index = 0; index < value.length; index++) {
      const error = validateJsonAgainstSchema(value[index], node.items);
      if (error) return `item ${index}: ${error}`;
    }
  }

  return null;
}
