import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callJson = vi.fn();
const settingsMocks = vi.hoisted(() => ({ getSetting: vi.fn() }));

vi.mock("../repositories/settings", () => settingsMocks);
vi.mock("@server/repositories/settings", () => settingsMocks);

vi.mock("./modelSelection", () => ({
  resolveLlmModel: vi.fn(async () => "test-model"),
  createConfiguredLlmService: vi.fn(async () => ({ callJson })),
}));

vi.mock("./writing-style", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./writing-style")>();
  return {
    ...actual,
    getWritingStyle: vi.fn(async () => ({
      tone: "professional",
      formality: "medium",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    })),
  };
});

const baseJob = {
  id: "job-1",
  title: "Backend Engineer",
  employer: "Acme",
  salary: null,
  employerUrl: "https://acme.com",
  deadline: null,
  jobDescription: "x".repeat(1600),
} as unknown as Parameters<
  typeof import("./evaluation-report").generateEvaluationReport
>[0]["job"];

const llmResult = {
  verdict: "apply",
  summary: "Strong backend fit.",
  scoreBreakdown: {
    match: 4,
    northStar: 4,
    comp: null,
    culture: 3,
    redFlags: 2,
  },
  evidence: [
    {
      requirement: "TypeScript",
      cvMatch: "strong",
      evidence: "6 years of TypeScript",
    },
  ],
  gaps: ["No Kubernetes"],
  basis: "minimal_jd",
  confidence: 0.9,
};

describe.sequential("evaluation report metering", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-evaluation-metering-"));
    vi.resetModules();
    process.env = {
      ...originalEnv,
      DATA_DIR: tempDir,
      NODE_ENV: "test",
      JOBOPS_TEST_AUTH_BYPASS: "0",
      JOBOPS_APP_MODE: "hosted",
      JOBOPS_HOSTED_TENANT_ID: "tenant_default",
      JOBOPS_HOSTED_QUOTAS_ENABLED: "true",
    };
    await import("@server/db/migrate");
    ({ closeDb } = await import("@server/db"));

    callJson.mockReset();
    callJson.mockResolvedValue({ success: true, data: llmResult });
    settingsMocks.getSetting.mockResolvedValue(null);
  });

  afterEach(async () => {
    closeDb?.();
    closeDb = null;
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createUser(id: string): Promise<void> {
    const { db, schema } = await import("@server/db");
    await db.insert(schema.users).values({
      id,
      username: id,
      displayName: id,
      passwordHash: "hash",
      passwordSalt: "salt",
    });
    await db.insert(schema.tenantMemberships).values({
      id: `membership-${id}`,
      userId: id,
      tenantId: "tenant_default",
      role: "member",
    });
  }

  async function withUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const { runWithRequestContext } = await import("@infra/request-context");
    return runWithRequestContext(
      {
        requestId: `req-${userId}`,
        tenantId: "tenant_default",
        userId,
        username: userId,
      },
      fn,
    );
  }

  it("reserves one unit per generation, including regenerations", async () => {
    await createUser("alice");
    const usage = await import("./hosted-usage");
    const { generateEvaluationReport } = await import("./evaluation-report");

    await withUser("alice", async () => {
      await generateEvaluationReport({
        job: baseJob,
        profile: { basics: { name: "Diego" } },
      });
      await generateEvaluationReport({
        job: baseJob,
        profile: { basics: { name: "Diego" } },
      });

      const summary = await usage.getHostedUsageSummary();
      const tailoring = summary.actions.find(
        (action) => action.action === "tailoring",
      );

      // Two model calls, two units. A job-scoped idempotency key made the
      // second generation reuse the first, settled reservation and meter 1.
      expect(tailoring?.usedUnits).toBe(2);
    });
  });

  it("aborts the model call before the lock window can be stolen", async () => {
    await createUser("alice");
    const { generateEvaluationReport } = await import("./evaluation-report");

    await withUser("alice", async () => {
      await generateEvaluationReport({
        job: baseJob,
        profile: { basics: { name: "Diego" } },
      });
    });

    const request = callJson.mock.calls[0]?.[0] as { signal?: unknown };
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });
});
