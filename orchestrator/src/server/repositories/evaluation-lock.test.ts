import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("evaluation lock", () => {
  let tempDir: string;
  let jobsRepo: typeof import("./jobs");

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-lock-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    jobsRepo = await import("./jobs");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const makeJob = () =>
    jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: `https://example.com/job/${Math.random()}`,
    });

  it("grants the lock once", async () => {
    const job = await makeJob();

    expect(
      await jobsRepo.beginEvaluationIfIdle(job.id, { staleAfterSeconds: 300 }),
    ).toBe(true);
    expect(
      await jobsRepo.beginEvaluationIfIdle(job.id, { staleAfterSeconds: 300 }),
    ).toBe(false);
  });

  it("hands over a lock older than the window", async () => {
    const job = await makeJob();
    await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
      now: Math.floor(Date.now() / 1000) - 3600,
    });

    const takenOver = await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
    });

    expect(takenOver).toBe(true);
  });

  it("never grants two concurrent requests", async () => {
    const job = await makeJob();

    const results = await Promise.all([
      jobsRepo.beginEvaluationIfIdle(job.id, { staleAfterSeconds: 300 }),
      jobsRepo.beginEvaluationIfIdle(job.id, { staleAfterSeconds: 300 }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("scopes the lock to the job id", async () => {
    const first = await makeJob();
    const second = await makeJob();

    expect(
      await jobsRepo.beginEvaluationIfIdle(first.id, {
        staleAfterSeconds: 300,
      }),
    ).toBe(true);
    expect(
      await jobsRepo.beginEvaluationIfIdle(second.id, {
        staleAfterSeconds: 300,
      }),
    ).toBe(true);
  });
});
