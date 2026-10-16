import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_ONLY_SETTING_KEYS } from "@shared/settings-registry";
import { updateSettingsSchema } from "@shared/settings-schema.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/services/rxresume", () => ({
  clearRxResumeResumeCache: vi.fn(),
  listResumes: vi.fn(),
  getResume: vi.fn(),
  validateCredentials: vi.fn(async () => ({
    ok: true,
    mode: "v5",
  })),
  validateResumeSchema: vi.fn(async (data: unknown) => ({
    ok: true,
    data,
  })),
  extractProjectsFromResume: vi.fn((data: unknown) => {
    const root = (data ?? {}) as Record<string, unknown>;
    const sections = (root.sections ?? {}) as Record<string, unknown>;
    const projects = (sections.projects ?? {}) as Record<string, unknown>;
    const items = Array.isArray(projects.items) ? projects.items : [];
    return {
      mode: "v5",
      catalog: items.map((item) => {
        const project = item as Record<string, unknown>;
        return {
          id: String(project.id ?? ""),
          name: String(project.name ?? ""),
          description: String(project.description ?? ""),
          date: String(project.period ?? ""),
          isVisibleInBase: !project.hidden,
        };
      }),
    };
  }),
  RxResumeAuthConfigError: class RxResumeAuthConfigError extends Error {
    constructor(message = "Reactive Resume auth config missing") {
      super(message);
      this.name = "RxResumeAuthConfigError";
    }
  },
  RxResumeRequestError: class RxResumeRequestError extends Error {
    status: number | null;
    constructor(
      message = "Reactive Resume request failed",
      status: number | null = null,
    ) {
      super(message);
      this.name = "RxResumeRequestError";
      this.status = status;
    }
  },
}));

const { listModelsMock } = vi.hoisted(() => ({
  listModelsMock: vi.fn().mockResolvedValue(["model-a"]),
}));

vi.mock("@server/services/llm/service", () => ({
  LlmService: vi.fn().mockImplementation(function MockLlmService(
    this: { options: unknown; listModels: typeof listModelsMock },
    options,
  ) {
    this.options = options;
    this.listModels = listModelsMock;
  }),
}));

import { LlmService } from "@server/services/llm/service";
import {
  extractProjectsFromResume,
  getResume,
  validateCredentials,
} from "@server/services/rxresume";
import { getDefaultPromptTemplate } from "@shared/prompt-template-definitions.js";
import { startServer, stopServer } from "./test-utils";

const AUTH_ENV = {
  BASIC_AUTH_USER: "admin",
  BASIC_AUTH_PASSWORD: "secret",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
  JOBOPS_TEST_AUTH_BYPASS: "0",
};

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  expect(res.status).toBe(200);
  return body.data.token as string;
}

describe.sequential("Settings API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(validateCredentials).mockResolvedValue({
      ok: true,
      mode: "v5",
    });
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: {
        LLM_API_KEY: "secret-key",
        RXRESUME_API_KEY: "resume-api-key",
        RXRESUME_URL: "https://env.rxresume.example.com",
      },
    }));
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("returns settings with defaults", async () => {
    const res = await fetch(`${baseUrl}/api/settings`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.model.default).toBe("test-model");
    expect(Array.isArray(body.data.searchTerms.value)).toBe(true);
    expect(body.data.rxresumeApiKeyHint).toBe("resu");
    expect(body.data.rxresumeUrl).toBe("https://env.rxresume.example.com");
    expect(body.data.pdfRenderer.value).toBe("rxresume");
    expect(body.data.pdfRenderer.default).toBe("rxresume");
    expect(body.data.llmApiKeyHint).toBe("secr");
    expect(body.data).not.toHaveProperty("basicAuthUser");
    expect(body.data).not.toHaveProperty("basicAuthPassword");
    expect(body.data).not.toHaveProperty("basicAuthPasswordHint");
    expect(body.data).not.toHaveProperty("basicAuthActive");
    expect(body.data).not.toHaveProperty("onboardingBasicAuthDecision");
    expect(body.data.ghostwriterSystemPromptTemplate.value).toBe(
      getDefaultPromptTemplate("ghostwriterSystemPromptTemplate"),
    );
    expect(body.data.tailoringPromptTemplate.value).toBe(
      getDefaultPromptTemplate("tailoringPromptTemplate"),
    );
    expect(body.data.scoringPromptTemplate.value).toBe(
      getDefaultPromptTemplate("scoringPromptTemplate"),
    );
  });

  it("does not expose Basic Auth env values through settings", async () => {
    const legacyBasicAuth = await startServer({
      env: {
        BASIC_AUTH_PASSWORD: "legacy-secret",
        BASIC_AUTH_USER: "legacy-admin",
        LLM_API_KEY: "secret-key",
        RXRESUME_API_KEY: "resume-api-key",
      },
    });

    try {
      const res = await fetch(`${legacyBasicAuth.baseUrl}/api/settings`);
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data).not.toHaveProperty("basicAuthUser");
      expect(body.data).not.toHaveProperty("basicAuthPassword");
      expect(body.data).not.toHaveProperty("basicAuthPasswordHint");
      expect(body.data).not.toHaveProperty("basicAuthActive");
    } finally {
      await stopServer(legacyBasicAuth);
    }
  });

  it("normalizes hyphenated openai-compatible env defaults", async () => {
    const hyphenated = await startServer({
      env: {
        LLM_API_KEY: "secret-key",
        LLM_PROVIDER: "openai-compatible",
        RXRESUME_API_KEY: "resume-api-key",
      },
    });

    try {
      const res = await fetch(`${hyphenated.baseUrl}/api/settings`);
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.llmProvider.default).toBe("openai_compatible");
      expect(body.data.llmProvider.value).toBe("openai_compatible");
      expect(body.data.llmBaseUrl.default).toBe("https://api.openai.com");
    } finally {
      await stopServer(hyphenated);
    }
  });

  it("uses GLM env defaults and base URL", async () => {
    const glmDefaults = await startServer({
      env: {
        MODEL: undefined,
        LLM_API_KEY: "secret-key",
        LLM_PROVIDER: "glm",
        RXRESUME_API_KEY: "resume-api-key",
      },
    });

    try {
      const res = await fetch(`${glmDefaults.baseUrl}/api/settings`);
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.llmProvider.default).toBe("glm");
      expect(body.data.llmProvider.value).toBe("glm");
      expect(body.data.llmBaseUrl.default).toBe("https://api.z.ai/api/paas/v4");
      expect(body.data.model.default).toBe("glm-5.1");
      expect(body.data.model.value).toBe("glm-5.1");
    } finally {
      await stopServer(glmDefaults);
    }
  });

  it("uses the provider default model when MODEL is unset", async () => {
    const openAiDefaults = await startServer({
      env: {
        MODEL: undefined,
        LLM_API_KEY: "secret-key",
        LLM_PROVIDER: "openai",
        RXRESUME_API_KEY: "resume-api-key",
      },
    });

    try {
      const res = await fetch(`${openAiDefaults.baseUrl}/api/settings`);
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.model.default).toBe("gpt-5.4-mini");
      expect(body.data.model.value).toBe("gpt-5.4-mini");
    } finally {
      await stopServer(openAiDefaults);
    }
  });

  it("updates the effective default model when llmProvider changes", async () => {
    const providerAware = await startServer({
      env: {
        MODEL: undefined,
        LLM_API_KEY: "secret-key",
        RXRESUME_API_KEY: "resume-api-key",
      },
    });

    try {
      const patchRes = await fetch(`${providerAware.baseUrl}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llmProvider: "openai",
        }),
      });
      const patchBody = await patchRes.json();

      expect(patchRes.status).toBe(200);
      expect(patchBody.ok).toBe(true);
      expect(patchBody.data.llmProvider.value).toBe("openai");
      expect(patchBody.data.model.default).toBe("gpt-5.4-mini");
      expect(patchBody.data.model.value).toBe("gpt-5.4-mini");
    } finally {
      await stopServer(providerAware);
    }
  });

  it("ignores incompatible model overrides when the provider changes", async () => {
    const providerAware = await startServer({
      env: {
        MODEL: undefined,
        LLM_API_KEY: "secret-key",
        RXRESUME_API_KEY: "resume-api-key",
      },
    });

    try {
      const patchRes = await fetch(`${providerAware.baseUrl}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llmProvider: "openai",
          modelTailoring: "google/gemini-3-flash-preview",
        }),
      });
      const patchBody = await patchRes.json();

      expect(patchRes.status).toBe(200);
      expect(patchBody.ok).toBe(true);
      expect(patchBody.data.model.default).toBe("gpt-5.4-mini");
      expect(patchBody.data.modelTailoring.value).toBe("gpt-5.4-mini");
      expect(patchBody.data.modelTailoring.override).toBeNull();
    } finally {
      await stopServer(providerAware);
    }
  });

  it("rejects invalid settings updates and persists overrides", async () => {
    const badPatch = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobspyResultsWanted: 9999 }),
    });
    expect(badPatch.status).toBe(400);

    const patchRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdfRenderer: "latex",
        searchTerms: ["engineer"],
        rxresumeApiKey: "updated-key",
        rxresumeUrl: "https://resume.example.com",
        llmApiKey: "updated-secret",
        basicAuthUser: "admin",
        basicAuthPassword: "letmein",
        ghostwriterSystemPromptTemplate: "Custom Ghostwriter {{tone}}",
      }),
    });
    const patchBody = await patchRes.json();
    expect(patchBody.ok).toBe(true);
    expect(patchBody.data.pdfRenderer.value).toBe("latex");
    expect(patchBody.data.pdfRenderer.override).toBe("latex");
    expect(patchBody.data.searchTerms.value).toEqual(["engineer"]);
    expect(patchBody.data.searchTerms.override).toEqual(["engineer"]);
    expect(patchBody.data.rxresumeApiKeyHint).toBe("upda");
    expect(patchBody.data.rxresumeUrl).toBe("https://resume.example.com");
    expect(patchBody.data.llmApiKeyHint).toBe("upda");
    expect(patchBody.data).not.toHaveProperty("basicAuthUser");
    expect(patchBody.data).not.toHaveProperty("basicAuthPassword");
    expect(patchBody.data.ghostwriterSystemPromptTemplate.override).toBe(
      "Custom Ghostwriter {{tone}}",
    );
  });

  it("ignores malformed stored purpose API keys when listing models", async () => {
    const { setSetting } = await import("@server/repositories/settings");
    await setSetting("llmPurposeApiKeys", JSON.stringify({ tailoring: 123 }));

    const res = await fetch(`${baseUrl}/api/settings/llm-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        purpose: "tailoring",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.models).toEqual(["model-a"]);
    expect(LlmService).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "secret-key",
        provider: "openai",
      }),
    );
  });

  it("blocks saving when the configured Reactive Resume v5 API key is invalid", async () => {
    vi.mocked(validateCredentials).mockResolvedValue({
      ok: false,
      mode: "v5",
      status: 401,
      message:
        "Reactive Resume v5 API key is invalid. Update the API key and try again.",
    });

    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rxresumeApiKey: "invalid-key",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("API key");

    const settingsRes = await fetch(`${baseUrl}/api/settings`);
    const settingsBody = await settingsRes.json();
    expect(settingsBody.data.rxresumeApiKeyHint).toBe("resu");
  });

  it("blocks saving when Reactive Resume returns another 4xx validation failure", async () => {
    vi.mocked(validateCredentials).mockResolvedValue({
      ok: false,
      mode: "v5",
      status: 404,
      message:
        "Reactive Resume returned HTTP 404 from https://resume.example.com. Check the configured URL and selected mode.",
    });

    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rxresumeUrl: "https://resume.example.com",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");

    const settingsRes = await fetch(`${baseUrl}/api/settings`);
    const settingsBody = await settingsRes.json();
    expect(settingsBody.data.rxresumeUrl).toBe(
      "https://env.rxresume.example.com",
    );
  });

  it("allows saving when Reactive Resume is temporarily unavailable", async () => {
    vi.mocked(validateCredentials).mockResolvedValue({
      ok: false,
      mode: "v5",
      status: 0,
      message:
        "JobOps could not verify Reactive Resume because the instance is unavailable.",
    });

    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rxresumeApiKey: "rr-v5-warning-key",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.rxresumeApiKeyHint).toBe("rr-v");
  });

  it("does not run Reactive Resume validation for unrelated settings saves", async () => {
    vi.mocked(validateCredentials).mockResolvedValue({
      ok: false,
      mode: "v5",
      status: 401,
      message: "should not run",
    });

    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(validateCredentials).not.toHaveBeenCalled();
  });

  it("ignores removed Basic Auth settings fields", async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enableBasicAuth: true,
        basicAuthUser: "",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).not.toHaveProperty("basicAuthUser");
    expect(body.data).not.toHaveProperty("basicAuthPassword");
    expect(body.data).not.toHaveProperty("basicAuthActive");
  });

  it("handles salary penalty settings with validation", async () => {
    // Get initial settings
    const initialRes = await fetch(`${baseUrl}/api/settings`);
    const initialBody = await initialRes.json();
    expect(initialBody.ok).toBe(true);
    expect(initialBody.data.penalizeMissingSalary.value).toBe(false);
    expect(initialBody.data.missingSalaryPenalty.value).toBe(10);

    // Test invalid penalty values
    const invalidRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missingSalaryPenalty: 150 }),
    });
    expect(invalidRes.status).toBe(400);

    const negativeRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missingSalaryPenalty: -10 }),
    });
    expect(negativeRes.status).toBe(400);

    // Test valid settings update
    const validRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        penalizeMissingSalary: true,
        missingSalaryPenalty: 20,
      }),
    });
    const validBody = await validRes.json();
    expect(validBody.ok).toBe(true);
    expect(validBody.data.penalizeMissingSalary.value).toBe(true);
    expect(validBody.data.penalizeMissingSalary.override).toBe(true);
    expect(validBody.data.missingSalaryPenalty.value).toBe(20);
    expect(validBody.data.missingSalaryPenalty.override).toBe(20);

    // Verify persistence
    const getRes = await fetch(`${baseUrl}/api/settings`);
    const getBody = await getRes.json();
    expect(getBody.ok).toBe(true);
    expect(getBody.data.penalizeMissingSalary.value).toBe(true);
    expect(getBody.data.missingSalaryPenalty.value).toBe(20);
  });

  it("lets a non-admin update workspace settings but not administrator-reserved ones", async () => {
    await stopServer({ server, closeDb, tempDir });
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: AUTH_ENV,
    }));

    const adminToken = await login(baseUrl, "admin", "secret");
    const createUserRes = await fetch(`${baseUrl}/api/workspaces/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "regular",
        password: "regular-secret",
      }),
    });
    expect(createUserRes.status).toBe(201);

    const regularToken = await login(baseUrl, "regular", "regular-secret");
    const searchSettingsRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${regularToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchTerms: ["backend engineer"],
        workplaceTypes: ["remote"],
        jobspyCountryIndeed: "united kingdom",
        searchCities: "London",
      }),
    });
    const searchSettingsBody = await searchSettingsRes.json();

    expect(searchSettingsRes.status).toBe(200);
    expect(searchSettingsBody.ok).toBe(true);
    expect(searchSettingsBody.data.searchTerms.value).toEqual([
      "backend engineer",
    ]);
    expect(searchSettingsBody.data.searchCities.value).toBe("London");

    const workspaceSettingsRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${regularToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rxresumeApiKey: "member-owned-key" }),
    });
    const workspaceSettingsBody = await workspaceSettingsRes.json();

    expect(workspaceSettingsRes.status).toBe(200);
    expect(workspaceSettingsBody.ok).toBe(true);
    expect(workspaceSettingsBody.data.rxresumeApiKeyHint).toBe("memb");

    const reservedSettingsRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${regularToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchTerms: ["should not persist"],
        backupEnabled: true,
      }),
    });
    const reservedSettingsBody = await reservedSettingsRes.json();

    expect(reservedSettingsRes.status).toBe(403);
    expect(reservedSettingsBody.error.code).toBe("FORBIDDEN");

    const afterRes = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${regularToken}` },
    });
    const afterBody = await afterRes.json();
    expect(afterBody.data.searchTerms.value).toEqual(["backend engineer"]);
    expect(afterBody.data.backupEnabled.value).toBe(false);
  });

  it("refuses every administrator-reserved setting to a non-admin", async () => {
    await stopServer({ server, closeDb, tempDir });
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: AUTH_ENV,
    }));

    const adminToken = await login(baseUrl, "admin", "secret");
    const createUserRes = await fetch(`${baseUrl}/api/workspaces/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "regular", password: "regular-secret" }),
    });
    expect(createUserRes.status).toBe(201);

    const regularToken = await login(baseUrl, "regular", "regular-secret");
    const reservedValues: Record<string, unknown> = {
      backupEnabled: true,
      backupHour: 3,
      backupMaxCount: 2,
      rxresumeUrl: "https://rxresu.me",
      llmBaseUrl: "https://example.test",
      pipelineWebhookUrl: "https://example.test/hook",
      jobCompleteWebhookUrl: "https://example.test/hook",
    };

    for (const [key, value] of Object.entries(reservedValues)) {
      const memberRes = await fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${regularToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ [key]: value }),
      });
      expect(memberRes.status, `member write of ${key}`).toBe(403);
      const memberBody = await memberRes.json();
      expect(memberBody.error.code).toBe("FORBIDDEN");
    }

    for (const [key, value] of Object.entries(reservedValues)) {
      const adminRes = await fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ [key]: value }),
      });
      expect(adminRes.status, `admin write of ${key}`).toBe(200);
    }
  });

  it("keeps a member's workspace settings inside their own workspace", async () => {
    await stopServer({ server, closeDb, tempDir });
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: AUTH_ENV,
    }));

    const adminToken = await login(baseUrl, "admin", "secret");
    for (const username of ["first", "second"]) {
      const res = await fetch(`${baseUrl}/api/workspaces/users`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password: `${username}-secret` }),
      });
      expect(res.status).toBe(201);
    }

    const firstToken = await login(baseUrl, "first", "first-secret");
    const secondToken = await login(baseUrl, "second", "second-secret");

    for (const [token, secret] of [
      [firstToken, "aaaa-member-secret"],
      [secondToken, "bbbb-member-secret"],
    ] as const) {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rxresumeApiKey: secret }),
      });
      expect(res.status).toBe(200);
    }

    const firstSettings = await (
      await fetch(`${baseUrl}/api/settings`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      })
    ).json();
    const secondSettings = await (
      await fetch(`${baseUrl}/api/settings`, {
        headers: { Authorization: `Bearer ${secondToken}` },
      })
    ).json();

    expect(firstSettings.data.rxresumeApiKeyHint).toBe("aaaa");
    expect(secondSettings.data.rxresumeApiKeyHint).toBe("bbbb");
  });

  it("reserves exactly the backup and server-URL settings for administrators", () => {
    expect([...ADMIN_ONLY_SETTING_KEYS].sort()).toEqual([
      "backupEnabled",
      "backupHour",
      "backupMaxCount",
      "jobCompleteWebhookUrl",
      "llmBaseUrl",
      "opencodePassword",
      "opencodeUrl",
      "pipelineWebhookUrl",
      "rxresumeUrl",
    ]);
  });

  it("rejects an OpenCode URL carrying embedded credentials", () => {
    expect(
      updateSettingsSchema.safeParse({
        opencodeUrl: "https://user:pass@opencode.example.com",
      }).success,
    ).toBe(false);
    expect(
      updateSettingsSchema.safeParse({
        opencodeUrl: "https://opencode.example.com",
      }).success,
    ).toBe(true);
  });

  describe("OpenCode endpoint settings", () => {
    let stateDir: string;

    beforeEach(async () => {
      stateDir = await mkdtemp(join(tmpdir(), "job-ops-opencode-state-"));
      // Never read the machine's real OpenCode service registration.
      process.env.XDG_STATE_HOME = stateDir;
    });

    afterEach(async () => {
      delete process.env.XDG_STATE_HOME;
      delete process.env.OPENCODE_URL;
      delete process.env.OPENCODE_PASSWORD;
      await rm(stateDir, { recursive: true, force: true });
    });

    const writeServiceJson = async (value: unknown) => {
      await mkdir(join(stateDir, "opencode"), { recursive: true });
      await writeFile(
        join(stateDir, "opencode", "service.json"),
        JSON.stringify(value),
      );
    };

    const restartServer = async (env: Record<string, string> = AUTH_ENV) => {
      await stopServer({ server, closeDb, tempDir });
      ({ server, baseUrl, closeDb, tempDir } = await startServer({
        // The server replaces process.env, so the state dir must travel with it.
        env: { ...env, XDG_STATE_HOME: stateDir },
      }));
    };

    const createMember = async (adminToken: string) => {
      const created = await fetch(`${baseUrl}/api/workspaces/users`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: "regular",
          password: "regular-secret",
        }),
      });
      expect(created.status).toBe(201);
      return login(baseUrl, "regular", "regular-secret");
    };

    const patchSettings = (token: string, body: unknown) =>
      fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const readSettings = async (token: string) =>
      (
        await fetch(`${baseUrl}/api/settings`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();

    it("lets an admin save the endpoint and refuses a non-admin", async () => {
      await restartServer();
      const adminToken = await login(baseUrl, "admin", "secret");
      const memberToken = await createMember(adminToken);

      const saved = await patchSettings(adminToken, {
        opencodeUrl: "http://127.0.0.1:4096",
        opencodePassword: "admin-owned-pw",
      });
      expect(saved.status).toBe(200);
      const savedBody = await saved.json();
      expect(savedBody.data.opencodeUrl).toBe("http://127.0.0.1:4096");
      expect(savedBody.data.opencodePasswordResolved).toBe(true);
      expect(JSON.stringify(savedBody)).not.toContain("admin-owned-pw");

      const refused = await patchSettings(memberToken, {
        opencodePassword: "member-pw",
      });
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.code).toBe("FORBIDDEN");
    });

    it("refuses both keys in hosted mode", async () => {
      await restartServer({
        ...AUTH_ENV,
        JOBOPS_APP_MODE: "hosted",
        JOBOPS_HOSTED_TENANT_ID: "tenant_default",
      });
      const adminToken = await login(baseUrl, "admin", "secret");

      const refused = await patchSettings(adminToken, {
        opencodeUrl: "http://127.0.0.1:4096",
      });
      expect(refused.status).toBe(403);

      const body = await readSettings(adminToken);
      expect(body.data.opencodeUrl).toBeUndefined();
      expect(body.data.opencodePasswordResolved).toBeUndefined();
    });

    it("rejects a malformed, credential-bearing or remote plaintext URL", async () => {
      await restartServer();
      const adminToken = await login(baseUrl, "admin", "secret");

      expect(
        (await patchSettings(adminToken, { opencodeUrl: "not-a-url" })).status,
      ).toBe(400);
      const credentialUrl = "https://user:pw@remote.example.com";
      const credentialRes = await patchSettings(adminToken, {
        opencodeUrl: credentialUrl,
      });
      expect(credentialRes.status).toBe(400);
      expect(JSON.stringify(await credentialRes.json())).not.toContain(
        credentialUrl,
      );
      expect(
        (
          await patchSettings(adminToken, {
            opencodeUrl: "http://remote.example.com",
          })
        ).status,
      ).toBe(422);
    });

    it("refuses a password-only update when the effective URL is an inherited plaintext remote", async () => {
      await writeServiceJson({
        url: "http://remote.example.com",
        password: "file-pw",
      });
      await restartServer();
      const adminToken = await login(baseUrl, "admin", "secret");

      expect(
        (await patchSettings(adminToken, { opencodePassword: "pw" })).status,
      ).toBe(422);
    });

    it("accepts both save orders and a password-only save with no URL at all", async () => {
      await restartServer();
      const adminToken = await login(baseUrl, "admin", "secret");

      // Password first, then URL.
      expect(
        (await patchSettings(adminToken, { opencodePassword: "pw" })).status,
      ).toBe(200);
      expect(
        (
          await patchSettings(adminToken, {
            opencodeUrl: "http://127.0.0.1:4096",
          })
        ).status,
      ).toBe(200);

      // URL first, then password, against the effective URL.
      expect(
        (
          await patchSettings(adminToken, {
            opencodeUrl: "http://127.0.0.1:4097",
          })
        ).status,
      ).toBe(200);
      expect(
        (await patchSettings(adminToken, { opencodePassword: "pw2" })).status,
      ).toBe(200);
    });

    it("reports the indicator to an admin, hides it from a member, and never a character", async () => {
      await writeServiceJson({
        url: "http://127.0.0.1:5123",
        password: "file-password",
      });
      await restartServer();
      const adminToken = await login(baseUrl, "admin", "secret");
      const memberToken = await createMember(adminToken);

      const adminBody = await readSettings(adminToken);
      // The password resolves from the registration file, so the indicator is true.
      expect(adminBody.data.opencodePasswordResolved).toBe(true);
      // The effective URL is context; the input edits only the stored override.
      expect(adminBody.data.opencodeUrl).toBe("http://127.0.0.1:5123");
      expect(adminBody.data.opencodeUrlSource).toBe("service-registration");
      expect(adminBody.data.opencodeUrlOverride).toBeNull();
      const adminJson = JSON.stringify(adminBody);
      expect(adminJson).not.toContain("file-password");
      expect(adminJson).not.toContain("opencodePasswordHint");

      const memberBody = await readSettings(memberToken);
      expect(memberBody.data.opencodePasswordResolved).toBeUndefined();
      expect(memberBody.data.opencodeUrl).toBeUndefined();
    });

    it("keeps the stored password when only the URL is sent, and clears it on the clear value", async () => {
      await restartServer();
      const adminToken = await login(baseUrl, "admin", "secret");

      await patchSettings(adminToken, {
        opencodeUrl: "http://127.0.0.1:4096",
        opencodePassword: "pw",
      });

      // Editing only the URL omits the password, so the stored one survives.
      await patchSettings(adminToken, {
        opencodeUrl: "http://127.0.0.1:4097",
      });
      expect(
        (await readSettings(adminToken)).data.opencodePasswordResolved,
      ).toBe(true);

      // The explicit clear value removes the override.
      await patchSettings(adminToken, { opencodePassword: null });
      expect(
        (await readSettings(adminToken)).data.opencodePasswordResolved,
      ).toBe(false);
    });
  });

  it("preserves upstream 404 from Reactive Resume project lookup", async () => {
    const { RxResumeRequestError } = await import("@server/services/rxresume");
    vi.mocked(getResume).mockRejectedValue(
      new RxResumeRequestError(
        "Reactive Resume API error (404): Resume not found",
        404,
      ),
    );

    const res = await fetch(
      `${baseUrl}/api/settings/rx-resumes/missing/projects`,
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("404");
  });

  it("returns project catalog for v5-shaped Reactive Resume payloads", async () => {
    vi.mocked(getResume).mockResolvedValue({
      id: "resume-v5",
      name: "Resume v5",
      mode: "v5",
      data: {
        sections: {
          projects: {
            title: "Projects",
            columns: 1,
            hidden: false,
            items: [
              {
                id: "p1",
                hidden: false,
                name: "JobOps",
                period: "2024",
                website: { url: "https://example.com", label: "Example" },
                description: "Project description",
              },
            ],
          },
        },
        summary: {},
      },
    } as any);

    const res = await fetch(
      `${baseUrl}/api/settings/rx-resumes/resume-v5/projects?mode=v5`,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.projects).toEqual([
      {
        id: "p1",
        name: "JobOps",
        description: "Project description",
        date: "2024",
        isVisibleInBase: true,
      },
    ]);
    expect(extractProjectsFromResume).toHaveBeenCalled();
  });

  it("keeps platform credentials private and rejects LLM edits for hosted Free", async () => {
    await stopServer({ server, closeDb, tempDir });
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: {
        JOBOPS_APP_MODE: "hosted",
        JOBOPS_HOSTED_TENANT_ID: "tenant_default",
        JOBOPS_HOSTED_PLATFORM_LLM_ENABLED: "true",
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "sk-platform-secret",
        STRIPE_PRO_PRICE_ID: "price_pro",
      },
    }));

    const settingsRes = await fetch(`${baseUrl}/api/settings`);
    const settingsBody = await settingsRes.json();
    expect(settingsBody.ok).toBe(true);
    expect(settingsBody.data.llmApiKeyHint).toBeNull();

    const updateRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llmProvider: "codex" }),
    });
    expect(updateRes.status).toBe(403);
    await expect(updateRes.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });

  it("rejects LLM setting changes for hosted Pro", async () => {
    await stopServer({ server, closeDb, tempDir });
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: {
        JOBOPS_APP_MODE: "hosted",
        JOBOPS_HOSTED_TENANT_ID: "tenant_default",
        JOBOPS_HOSTED_PLATFORM_LLM_ENABLED: "true",
        STRIPE_PRO_PRICE_ID: "price_pro",
      },
    }));
    const { db, schema } = await import("@server/db");
    await db.insert(schema.users).values({
      id: "test-user",
      username: "test-user",
      displayName: "Test User",
      passwordHash: "hash",
      passwordSalt: "salt",
    });
    await db.insert(schema.tenantMemberships).values({
      id: "membership-test-user",
      tenantId: "tenant_default",
      userId: "test-user",
      role: "member",
    });
    await db.insert(schema.accountSubscriptions).values({
      tenantId: "tenant_default",
      userId: "test-user",
      stripeCustomerId: "cus_test_user",
      stripeSubscriptionId: "sub_test_user",
      stripeSubscriptionCreatedAt: 100,
      stripePriceId: "price_pro",
      stripeStatus: "active",
    });

    const response = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "client-selected-model" }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });
});
