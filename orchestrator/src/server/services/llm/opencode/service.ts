import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as settingsRepo from "@server/repositories/settings";
import { getOriginalEnvValue } from "@server/services/envSettings";
import { openCodeStrategy } from "../providers/opencode";
import type {
  JsonSchemaDefinition,
  LlmApiError,
  LlmMessage,
  LlmRequestOptions,
  LlmValidationResult,
} from "../types";
import { joinUrl } from "../utils/http";
import { parseJsonContent } from "../utils/json";
import { truncate } from "../utils/string";
import { buildOpenCodeAuthHeader, validateJsonAgainstSchema } from "./prompt";

export class OpenCodeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeConfigurationError";
  }
}

export type OpenCodeEndpoint = { baseUrl: string; password: string };

function resolveServiceFilePath(): string {
  const stateHome = process.env.XDG_STATE_HOME?.trim();
  const base = stateHome || join(homedir(), ".local", "state");
  return join(base, "opencode", "service.json");
}

async function readServiceRegistration(): Promise<{
  url?: string;
  password?: string;
} | null> {
  try {
    const raw = await readFile(resolveServiceFilePath(), "utf8");
    const parsed = JSON.parse(raw) as { url?: unknown; password?: unknown };
    const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
    const password =
      typeof parsed.password === "string" ? parsed.password.trim() : "";
    if (!url && !password) return null;
    return { url: url || undefined, password: password || undefined };
  } catch {
    return null;
  }
}

/**
 * Hosts JobOps treats as local/trusted for plaintext Basic auth: loopback, plus
 * the Docker host aliases (`host.docker.internal`, `gateway.docker.internal`),
 * which reach the host over Docker's internal network rather than a public one.
 */
export function isTrustedLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host === "host.docker.internal" ||
    host === "gateway.docker.internal"
  );
}

/**
 * The server is expected on loopback. A remote server must use TLS so Basic credentials never
 * cross a network in plaintext, and the URL must not carry credentials of its own because the
 * value can be serialized into a settings response. This validates transport and credentials,
 * not the host: an HTTPS endpoint on any host is accepted.
 */
export function assertSecureOpenCodeTransport(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new OpenCodeConfigurationError(
      "OpenCode server URL is not a valid URL.",
    );
  }
  if (url.username || url.password) {
    throw new OpenCodeConfigurationError(
      "OpenCode server URL carries embedded credentials; refusing to use it.",
    );
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isTrustedLocalHost(url.hostname)) return;
  throw new OpenCodeConfigurationError(
    "OpenCode server is not local; refusing to send Basic credentials over plaintext. Use an HTTPS endpoint or a tunnel.",
  );
}

/** First non-empty candidate, so each field resolves independently of the other. */
function firstResolved(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Resolve the OpenCode base URL and password per call (never cached), **per field**, in the
 * order: the operator-level setting (one global row per key, shared by every workspace), then
 * the service registration file, then the matching environment variable. A value the operator
 * saved therefore re-points an endpoint that a running `opencode serve --service` already
 * published. A field that resolves to a value failing validation fails closed rather than
 * falling through to a lower source, and the value is never included in the error.
 */
export async function resolveOpenCodeEndpoint(): Promise<OpenCodeEndpoint> {
  const registration = await readServiceRegistration();
  const storedUrl = await settingsRepo.getOperatorSetting("opencodeUrl");
  const storedPassword =
    await settingsRepo.getOperatorSetting("opencodePassword");

  const baseUrl = firstResolved(
    storedUrl,
    registration?.url,
    getOriginalEnvValue("OPENCODE_URL"),
  );
  const password = firstResolved(
    storedPassword,
    registration?.password,
    getOriginalEnvValue("OPENCODE_PASSWORD"),
  );

  if (!baseUrl) {
    throw new OpenCodeConfigurationError(
      "OpenCode server is not configured: no stored URL, no service.json URL and OPENCODE_URL is unset.",
    );
  }
  if (!password) {
    throw new OpenCodeConfigurationError(
      "OpenCode credentials are not configured: no stored password, no service.json password and OPENCODE_PASSWORD is unset.",
    );
  }

  assertSecureOpenCodeTransport(baseUrl);
  return { baseUrl, password };
}

export type OpenCodeUrlSource =
  | "setting"
  | "service-registration"
  | "environment";

/**
 * The URL a request would use and where it came from, or null when no source provides one.
 * Never throws: the caller decides how to validate the result.
 */
export async function resolveEffectiveOpenCodeUrlWithSource(
  override?: string | null,
): Promise<{ url: string; source: OpenCodeUrlSource } | null> {
  const registration = await readServiceRegistration();
  const candidates: Array<[string | null | undefined, OpenCodeUrlSource]> = [
    [override, "setting"],
    [await settingsRepo.getOperatorSetting("opencodeUrl"), "setting"],
    [registration?.url, "service-registration"],
    [getOriginalEnvValue("OPENCODE_URL"), "environment"],
  ];

  for (const [candidate, source] of candidates) {
    const value = candidate?.trim();
    if (value) return { url: value, source };
  }
  return null;
}

/**
 * The URL a request would use, or null when no source provides one. Never throws: the caller
 * decides how to validate the result.
 */
export async function resolveEffectiveOpenCodeUrl(
  override?: string | null,
): Promise<string | null> {
  const resolved = await resolveEffectiveOpenCodeUrlWithSource(override);
  return resolved?.url ?? null;
}

/** Whether an OpenCode password resolves from any source. Never returns or reveals it. */
export async function openCodePasswordResolves(): Promise<boolean> {
  const registration = await readServiceRegistration();
  return Boolean(
    firstResolved(
      await settingsRepo.getOperatorSetting("opencodePassword"),
      registration?.password,
      getOriginalEnvValue("OPENCODE_PASSWORD"),
    ),
  );
}

function openCodeHeaders(password: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: buildOpenCodeAuthHeader(password),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OpenCodeClient {
  private resolveEndpoint(): Promise<OpenCodeEndpoint> {
    return resolveOpenCodeEndpoint();
  }

  private async generate<T>(
    endpoint: OpenCodeEndpoint,
    options: LlmRequestOptions<T>,
    messages: LlmRequestOptions<T>["messages"],
  ): Promise<string> {
    const { url, headers, body } = openCodeStrategy.buildRequest({
      mode: "text",
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.password,
      model: options.model,
      messages,
      jsonSchema: options.jsonSchema,
    });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        throw new OpenCodeConfigurationError(
          `OpenCode server rejected credentials (LLM API error: ${response.status}).`,
        );
      }
      const error = new Error(
        `LLM API error: ${response.status}`,
      ) as LlmApiError;
      error.status = response.status;
      error.body = truncate(errorBody, 600);
      throw error;
    }

    const data = await response.json();
    const text = openCodeStrategy.extractText(data);
    if (!text) {
      throw new Error("No content in response");
    }
    return text;
  }

  private parseAndValidate<T>(
    text: string,
    jsonSchema: JsonSchemaDefinition,
    jobId?: string,
  ): { ok: true; data: T } | { ok: false; error: string } {
    let parsed: T;
    try {
      parsed = parseJsonContent<T>(text, jobId);
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    const validationError = validateJsonAgainstSchema(
      parsed,
      jsonSchema.schema,
    );
    if (validationError) return { ok: false, error: validationError };
    return { ok: true, data: parsed };
  }

  /**
   * One-shot generation with prompt + parse + a single bounded schema repair.
   * A still-invalid result throws instead of returning unvalidated data.
   */
  async callJson<T>(options: LlmRequestOptions<T>): Promise<T> {
    const endpoint = await this.resolveEndpoint();
    const firstText = await this.generate(endpoint, options, options.messages);
    const first = this.parseAndValidate<T>(
      firstText,
      options.jsonSchema,
      options.jobId,
    );
    if (first.ok) return first.data;

    const repairedText = await this.generate(
      endpoint,
      options,
      buildRepairMessages(options, firstText, first.error),
    );
    const repaired = this.parseAndValidate<T>(
      repairedText,
      options.jsonSchema,
      options.jobId,
    );
    if (repaired.ok) return repaired.data;

    throw new Error(`Failed to parse JSON response: ${repaired.error}`);
  }

  async validateCredentials(): Promise<LlmValidationResult> {
    let endpoint: OpenCodeEndpoint;
    try {
      endpoint = await this.resolveEndpoint();
    } catch (error) {
      return { valid: false, message: errorMessage(error) };
    }

    try {
      const response = await fetch(joinUrl(endpoint.baseUrl, "/api/model"), {
        method: "GET",
        headers: openCodeHeaders(endpoint.password),
      });
      if (response.ok) return { valid: true, message: null };
      if (response.status === 401 || response.status === 403) {
        return {
          valid: false,
          message:
            "OpenCode server rejected credentials. Check the password or service.json.",
        };
      }
      return {
        valid: false,
        message: `OpenCode server returned ${response.status}.`,
      };
    } catch (error) {
      return { valid: false, message: errorMessage(error) };
    }
  }

  async listModels(): Promise<string[]> {
    const endpoint = await this.resolveEndpoint();
    const response = await fetch(joinUrl(endpoint.baseUrl, "/api/model"), {
      method: "GET",
      headers: openCodeHeaders(endpoint.password),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("OpenCode server rejected credentials.");
      }
      throw new Error(`OpenCode server returned ${response.status}.`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ providerID?: string | null; modelID?: string | null }>;
    };
    return Array.from(
      new Set(
        (payload.data ?? [])
          .map(
            (entry) =>
              `${entry.providerID?.trim() ?? ""}/${entry.modelID?.trim() ?? ""}`,
          )
          .filter((model) => !model.startsWith("/") && !model.endsWith("/")),
      ),
    );
  }
}

function buildRepairMessages<T>(
  options: LlmRequestOptions<T>,
  invalidText: string,
  reason: string,
): LlmMessage[] {
  return [
    ...options.messages,
    { role: "assistant", content: invalidText },
    {
      role: "user",
      content: `The previous response was invalid (${reason}). Return only corrected JSON that matches the required schema. Do not include markdown fences or extra text.`,
    },
  ];
}
