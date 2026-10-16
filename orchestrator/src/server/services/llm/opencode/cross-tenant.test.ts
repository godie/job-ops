import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/repositories/settings", () => ({
  getAllSettings: vi.fn(),
  getOperatorSetting: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: vi.fn(),
}));

vi.mock("@server/services/account-entitlements", () => ({
  getCurrentAccountEntitlements: vi.fn(),
  FREE_HOSTED_MONTHLY_LIMITS: {},
}));

import { runWithRequestContext } from "@infra/request-context";
import * as settingsRepo from "@server/repositories/settings";
import { getCurrentAccountEntitlements } from "@server/services/account-entitlements";
import { resolveLlmRuntimeSettings } from "@server/services/modelSelection";
import { getEffectiveSettings } from "@server/services/settings";

function settingsFixture(overrides: {
  baseUrl?: string;
  purposeOverrides?: Record<string, unknown>;
}) {
  return {
    model: { value: "tenant-model", default: "tenant-model", override: null },
    modelScorer: { value: "", override: null },
    modelTailoring: { value: "", override: null },
    modelProjectSelection: { value: "", override: null },
    llmProvider: { value: "opencode", default: "opencode", override: null },
    llmBaseUrl: {
      value: overrides.baseUrl ?? "",
      default: "",
      override: overrides.baseUrl ?? null,
    },
    llmPurposeOverrides: {
      value: overrides.purposeOverrides ?? {},
      default: {},
      override: null,
    },
  };
}

describe("opencode tenant scoping", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.JOBOPS_APP_MODE;
    vi.mocked(getCurrentAccountEntitlements).mockResolvedValue({
      plan: "free",
      platformAiIncluded: false,
      userEditableLlmSettings: true,
      hostedLimits: {} as never,
      subscription: null,
    });
    vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({
      llmApiKey: "tenant-a-password",
    });
    vi.mocked(getEffectiveSettings).mockResolvedValue(
      settingsFixture({}) as never,
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("keeps the password and model tenant-scoped", async () => {
    await expect(resolveLlmRuntimeSettings()).resolves.toMatchObject({
      provider: "opencode",
      model: "tenant-model",
      apiKey: "tenant-a-password",
    });

    vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({
      llmApiKey: "tenant-b-password",
      model: "other-model",
    });
    vi.mocked(getEffectiveSettings).mockResolvedValue({
      ...settingsFixture({}),
      model: { value: "other-model", default: "other-model", override: null },
    } as never);

    const other = await resolveLlmRuntimeSettings();
    expect(other.apiKey).toBe("tenant-b-password");
    expect(other.apiKey).not.toBe("tenant-a-password");
  });

  it("never lets a tenant set the OpenCode endpoint", async () => {
    vi.mocked(getEffectiveSettings).mockResolvedValue(
      settingsFixture({
        baseUrl: "http://tenant-should-not-win.internal",
        purposeOverrides: {
          scoring: {
            provider: "opencode",
            baseUrl: "http://evil.internal",
          },
        },
      }) as never,
    );

    const global = await resolveLlmRuntimeSettings();
    expect(global.baseUrl).toBeNull();

    const scoring = await resolveLlmRuntimeSettings("scoring");
    expect(scoring.baseUrl).toBeNull();
  });

  it("resolves the same operator-level endpoint for every workspace", async () => {
    vi.mocked(settingsRepo.getOperatorSetting).mockImplementation(
      async (key: string) =>
        key === "opencodeUrl" ? "http://127.0.0.1:4096" : "operator-password",
    );

    const { resolveOpenCodeEndpoint } = await import("./service");
    const forWorkspace = (tenantId: string, userId: string) =>
      runWithRequestContext({ requestId: "test", tenantId, userId }, () =>
        resolveOpenCodeEndpoint(),
      );

    const first = await forWorkspace("tenant-a", "admin-a");
    const second = await forWorkspace("tenant-b", "admin-b");
    expect(first).toEqual({
      baseUrl: "http://127.0.0.1:4096",
      password: "operator-password",
    });
    expect(second).toEqual(first);

    // A workspace storing its own value never changes the resolved endpoint: the keys are
    // operator-level, so a member cannot write them into their own scope either.
    vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({
      opencodeUrl: "http://tenant-should-not-win.internal",
      opencodePassword: "tenant-password",
    });
    expect(await forWorkspace("tenant-b", "admin-b")).toEqual(first);
  });
});
