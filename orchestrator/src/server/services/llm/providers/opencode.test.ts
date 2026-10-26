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

// The operator-level store is a database read; these tests drive it directly.
const { operatorSettingsMock } = vi.hoisted(() => ({
  operatorSettingsMock: {
    url: null as string | null,
    password: null as string | null,
  },
}));

vi.mock("@server/repositories/settings", () => ({
  // Plain functions (not vi.fn) so `vi.restoreAllMocks()` cannot wipe them.
  getOperatorSetting: async (key: string) =>
    key === "opencodeUrl"
      ? operatorSettingsMock.url
      : operatorSettingsMock.password,
  getAllSettings: async () => ({}),
  getSetting: async () => null,
  setSetting: async () => undefined,
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
    // "" reads as "absent"; deleting would fall back to the frozen snapshot.
    process.env.OPENCODE_URL = "";
    process.env.OPENCODE_PASSWORD = "";
    operatorSettingsMock.url = null;
    operatorSettingsMock.password = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.OPENCODE_URL = "";
    process.env.OPENCODE_PASSWORD = "";
  });

  it("uses the service registration file when nothing is stored", async () => {
    await writeServiceJson({
      url: "http://127.0.0.1:5123",
      password: "file-pw",
    });
    await expect(resolveOpenCodeEndpoint()).resolves.toEqual({
      baseUrl: "http://127.0.0.1:5123",
      password: "file-pw",
    });
  });

  it("lets a stored value win over the registration file, per field", async () => {
    await writeServiceJson({
      url: "http://127.0.0.1:5123",
      password: "file-pw",
    });
    operatorSettingsMock.url = "https://stored.example.com";
    await expect(resolveOpenCodeEndpoint()).resolves.toEqual({
      baseUrl: "https://stored.example.com",
      password: "file-pw",
    });
  });

  it("lets a stored value win over the environment, per field", async () => {
    envSetup();
    operatorSettingsMock.password = "stored-pw";
    await expect(resolveOpenCodeEndpoint()).resolves.toEqual({
      baseUrl: "http://127.0.0.1:4096",
      password: "stored-pw",
    });
  });

  it("uses the environment when nothing is stored and no registration exists", async () => {
    envSetup();
    await expect(resolveOpenCodeEndpoint()).resolves.toEqual({
      baseUrl: "http://127.0.0.1:4096",
      password: PASSWORD,
    });
  });

  it("resolves one field independently when only it has a value", async () => {
    await writeServiceJson({ url: "http://127.0.0.1:5123" });
    operatorSettingsMock.password = "stored-pw";
    await expect(resolveOpenCodeEndpoint()).resolves.toEqual({
      baseUrl: "http://127.0.0.1:5123",
      password: "stored-pw",
    });
  });

  it("fails when a partial registration has no other source for the missing field", async () => {
    await writeServiceJson({ url: "http://127.0.0.1:5123" });
    await expect(resolveOpenCodeEndpoint()).rejects.toThrow(/not configured/i);
  });

  it("fails when the URL is missing while a password resolves", async () => {
    operatorSettingsMock.password = "stored-pw";
    await expect(resolveOpenCodeEndpoint()).rejects.toThrow(/not configured/i);
  });

  it("fails when the password is missing while a URL resolves", async () => {
    operatorSettingsMock.url = "http://127.0.0.1:4096";
    await expect(resolveOpenCodeEndpoint()).rejects.toThrow(/not configured/i);
  });

  it("does not treat a stored LLM key as the OpenCode password", async () => {
    // Nothing stored, no env and no registration: the OpenCode flow has no password at all.
    await expect(resolveOpenCodeEndpoint()).rejects.toBeInstanceOf(
      OpenCodeConfigurationError,
    );
  });

  it("fails closed for an inherited insecure, credential-bearing or malformed URL", async () => {
    envSetup();

    process.env.OPENCODE_URL = "http://internal.example.com";
    await expect(resolveOpenCodeEndpoint()).rejects.toBeInstanceOf(
      OpenCodeConfigurationError,
    );

    process.env.OPENCODE_URL = "https://user:pass@internal.example.com";
    await expect(resolveOpenCodeEndpoint()).rejects.toThrow(
      /embedded credentials/i,
    );

    process.env.OPENCODE_URL = "not-a-url";
    await expect(resolveOpenCodeEndpoint()).rejects.toThrow(/not a valid URL/i);
  });

  it("rejects a non-local plaintext endpoint and accepts secure/loopback/docker-host ones", () => {
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
    expect(() =>
      assertSecureOpenCodeTransport("http://host.docker.internal:49374"),
    ).not.toThrow();
    expect(() =>
      assertSecureOpenCodeTransport("http://gateway.docker.internal:49374"),
    ).not.toThrow();
    expect(() =>
      assertSecureOpenCodeTransport("https://user:pass@internal.example.com"),
    ).toThrow(/embedded credentials/i);
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

    const client = new OpenCodeClient();
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

    const client = new OpenCodeClient();
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

    const client = new OpenCodeClient();
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

    const client = new OpenCodeClient();
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

    const models = await new OpenCodeClient().listModels();
    expect(models).toContain("opencode/space-bunny-free");
    expect(models).toContain("opencode-go/grok-4.7");
  });
});
