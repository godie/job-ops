import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { loggerErrorMock, loggerWarnMock, loggerInfoMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
}));

vi.mock("@infra/logger", () => ({
  logger: {
    error: loggerErrorMock,
    warn: loggerWarnMock,
    info: loggerInfoMock,
    debug: vi.fn(),
  },
}));

import {
  buildOpenCodeAuthHeader,
  flattenMessagesToPrompt,
  parseOpenCodeModel,
  validateJsonAgainstSchema,
} from "../opencode/prompt";
import {
  assertSecureOpenCodeTransport,
  OpenCodeClient,
  OpenCodeConfigurationError,
  resolveOpenCodeEndpoint,
} from "../opencode/service";
import { isConfigurationFailure } from "../policies/configuration-error";
import { shouldRetryAttempt } from "../policies/retry-policy";
import { LlmService } from "../service";
import type { JsonSchemaDefinition } from "../types";
import { openCodeStrategy } from "./opencode";

const PASSWORD = "super-secret-password";

let stateDir: string;
let serviceJsonPath: string;

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "jobops-opencode-"));
  serviceJsonPath = join(stateDir, "opencode", "service.json");
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Never read the machine's real OpenCode service registration in tests.
  process.env.XDG_STATE_HOME = stateDir;
  await rm(join(stateDir, "opencode"), { recursive: true, force: true });
});

async function writeServiceJson(value: unknown): Promise<void> {
  await mkdir(join(stateDir, "opencode"), { recursive: true });
  await writeFile(serviceJsonPath, JSON.stringify(value));
}

const SCHEMA: JsonSchemaDefinition = {
  name: "test",
  schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

function generateResponse(text: string): Response {
  return new Response(JSON.stringify({ data: { text } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function envSetup(): void {
  process.env.XDG_STATE_HOME = stateDir;
  process.env.OPENCODE_URL = "http://127.0.0.1:4096";
  process.env.OPENCODE_PASSWORD = PASSWORD;
}

describe("opencode provider mapping", () => {
  it("builds the session-less generate request", () => {
    const request = openCodeStrategy.buildRequest({
      mode: "text",
      baseUrl: "http://127.0.0.1:4096",
      apiKey: PASSWORD,
      model: "opencode/space-bunny-free",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      jsonSchema: SCHEMA,
    });

    expect(request.url).toBe("http://127.0.0.1:4096/api/experimental/generate");
    expect(request.headers.Authorization).toBe(
      `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`,
    );
    const body = request.body as {
      prompt: string;
      model: { providerID: string; id: string };
    };
    expect(body.model).toEqual({
      providerID: "opencode",
      id: "space-bunny-free",
    });
    expect(body.prompt).toContain("Message 1 (SYSTEM)");
    expect(body.prompt).toContain("Message 2 (USER)");
    expect(body.prompt).toContain("You are helpful.");
    expect(body.prompt).toContain("Hello");
  });

  it("extracts assistant text and tolerates a missing field", () => {
    expect(openCodeStrategy.extractText({ data: { text: "hi" } })).toBe("hi");
    expect(openCodeStrategy.extractText({ data: {} })).toBeNull();
    expect(openCodeStrategy.extractText({})).toBeNull();
  });

  it("flattens system and conversation messages into one prompt", () => {
    const prompt = flattenMessagesToPrompt(
      [
        { role: "system", content: "rules" },
        { role: "user", content: "question" },
      ],
      SCHEMA,
    );
    expect(prompt).toContain("SYSTEM");
    expect(prompt).toContain("rules");
    expect(prompt).toContain("USER");
    expect(prompt).toContain("question");
    expect(prompt.indexOf("rules")).toBeLessThan(prompt.indexOf("question"));
    expect(prompt).toContain(JSON.stringify(SCHEMA.schema, null, 2));
  });

  it("parses providerID/modelID identifiers", () => {
    expect(parseOpenCodeModel("opencode/space-bunny-free")).toEqual({
      providerID: "opencode",
      id: "space-bunny-free",
    });
    expect(parseOpenCodeModel("no-slash")).toBeUndefined();
    expect(parseOpenCodeModel("")).toBeUndefined();
  });

  it("builds the fixed opencode Basic header", () => {
    expect(buildOpenCodeAuthHeader("pw")).toBe(
      `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
    );
  });
});

describe("opencode JSON schema validation", () => {
  it("accepts a matching object and rejects mismatches", () => {
    expect(validateJsonAgainstSchema({ value: "x" }, SCHEMA.schema)).toBeNull();
    expect(validateJsonAgainstSchema({}, SCHEMA.schema)).toContain("value");
    expect(validateJsonAgainstSchema({ value: 1 }, SCHEMA.schema)).toContain(
      "expected string",
    );
    expect(
      validateJsonAgainstSchema({ value: "x", extra: true }, SCHEMA.schema),
    ).toContain("extra");
  });
});

describe("opencode endpoint discovery", () => {
  beforeEach(() => {
    delete process.env.OPENCODE_URL;
    delete process.env.OPENCODE_PASSWORD;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCODE_URL;
    delete process.env.OPENCODE_PASSWORD;
  });

  it("uses the service registration file when present", async () => {
    await writeServiceJson({
      url: "http://127.0.0.1:5123",
      password: "file-pw",
    });
    await expect(resolveOpenCodeEndpoint()).resolves.toEqual({
      baseUrl: "http://127.0.0.1:5123",
      password: "file-pw",
    });
  });

  it("falls back to env base URL and password", async () => {
    envSetup();
    await expect(resolveOpenCodeEndpoint()).resolves.toEqual({
      baseUrl: "http://127.0.0.1:4096",
      password: PASSWORD,
    });
  });

  it("fails with a configuration error when nothing is configured", async () => {
    await expect(resolveOpenCodeEndpoint()).rejects.toBeInstanceOf(
      OpenCodeConfigurationError,
    );
    await expect(resolveOpenCodeEndpoint()).rejects.toThrow(/not configured/i);
  });

  it("rejects a non-loopback plaintext endpoint and accepts secure/loopback ones", () => {
    expect(() =>
      assertSecureOpenCodeTransport("http://internal.example.com"),
    ).toThrow(OpenCodeConfigurationError);
    expect(() =>
      assertSecureOpenCodeTransport("https://internal.example.com"),
    ).not.toThrow();
    expect(() =>
      assertSecureOpenCodeTransport("http://127.0.0.1:4096"),
    ).not.toThrow();
    expect(() =>
      assertSecureOpenCodeTransport("http://localhost:4096"),
    ).not.toThrow();
  });
});

describe("opencode generation and error classification", () => {
  beforeEach(() => {
    envSetup();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCODE_URL;
    delete process.env.OPENCODE_PASSWORD;
  });

  it("uses only the session-less generate endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue(
      generateResponse(JSON.stringify({ value: "ok" })),
    );

    const client = new OpenCodeClient(PASSWORD);
    await expect(
      client.callJson<string>({
        model: "opencode/space-bunny-free",
        messages: [{ role: "user", content: "hi" }],
        jsonSchema: SCHEMA,
      }),
    ).resolves.toEqual({ value: "ok" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toBe("http://127.0.0.1:4096/api/experimental/generate");
    expect(url).not.toMatch(/session|agent/i);
  });

  it("repairs invalid JSON once through the same endpoint", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(generateResponse("not json"))
      .mockResolvedValueOnce(generateResponse(JSON.stringify({ value: "ok" })));

    const client = new OpenCodeClient(PASSWORD);
    await expect(
      client.callJson<string>({
        model: "opencode/space-bunny-free",
        messages: [{ role: "user", content: "hi" }],
        jsonSchema: SCHEMA,
      }),
    ).resolves.toEqual({ value: "ok" });

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(fetch).mock.calls) {
      expect(String(call[0])).toBe(
        "http://127.0.0.1:4096/api/experimental/generate",
      );
    }
  });

  it("surfaces an error when repair still fails", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(generateResponse("still not json")),
    );

    const client = new OpenCodeClient(PASSWORD);
    await expect(
      client.callJson<string>({
        model: "opencode/space-bunny-free",
        messages: [{ role: "user", content: "hi" }],
        jsonSchema: SCHEMA,
      }),
    ).rejects.toThrow(/Failed to parse JSON response/);
    expect(fetch).toHaveBeenCalledTimes(2);
    // Confirms the logger is actually intercepted (so the redaction checks are meaningful).
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("classifies a 401 as a configuration error and never leaks the password", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );

    const llm = new LlmService({ provider: "opencode" });
    const result = await llm.callJson({
      model: "opencode/space-bunny-free",
      messages: [{ role: "user", content: "hi" }],
      jsonSchema: SCHEMA,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toContain("401");
    expect(isConfigurationFailure(result.error)).toBe(true);

    const logged = JSON.stringify([
      loggerErrorMock.mock.calls,
      loggerWarnMock.mock.calls,
      loggerInfoMock.mock.calls,
    ]);
    expect(logged).not.toContain(PASSWORD);
    expect(result.error).not.toContain(PASSWORD);
  });

  it("classifies a 5xx as retryable", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("boom", { status: 503 }));

    const llm = new LlmService({ provider: "opencode" });
    const result = await llm.callJson({
      model: "opencode/space-bunny-free",
      messages: [{ role: "user", content: "hi" }],
      jsonSchema: SCHEMA,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error).toContain("503");
    expect(shouldRetryAttempt({ message: result.error, status: 503 })).toBe(
      true,
    );
  });

  it("never logs the password on a successful call", async () => {
    vi.mocked(fetch).mockResolvedValue(
      generateResponse(JSON.stringify({ value: "ok" })),
    );

    const client = new OpenCodeClient(PASSWORD);
    await client.callJson<string>({
      model: "opencode/space-bunny-free",
      messages: [{ role: "user", content: "hi" }],
      jsonSchema: SCHEMA,
    });

    const logged = JSON.stringify([
      loggerErrorMock.mock.calls,
      loggerWarnMock.mock.calls,
      loggerInfoMock.mock.calls,
    ]);
    expect(logged).not.toContain(PASSWORD);
  });
});

describe("opencode model catalogue", () => {
  beforeEach(() => {
    envSetup();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCODE_URL;
    delete process.env.OPENCODE_PASSWORD;
  });

  it("maps the catalogue to providerID/modelID suggestions", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { providerID: "opencode", modelID: "space-bunny-free" },
            { providerID: "opencode-go", modelID: "grok-4.7" },
          ],
        }),
        { status: 200 },
      ),
    );

    const models = await new OpenCodeClient(PASSWORD).listModels();
    expect(models).toContain("opencode/space-bunny-free");
    expect(models).toContain("opencode-go/grok-4.7");
  });
});
