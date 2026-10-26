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

  it("grants the lock once and returns an ownership token", async () => {
    const job = await makeJob();

    const token = await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
    });
    expect(typeof token).toBe("string");
    expect(
      await jobsRepo.beginEvaluationIfIdle(job.id, { staleAfterSeconds: 300 }),
    ).toBeNull();

    const stored = await jobsRepo.getJobById(job.id);
    expect(stored?.evaluationReportGenerating).toBe(true);
  });

  it("hands over a lock older than the window, with a new token", async () => {
    const job = await makeJob();
    const staleToken = await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
      now: Math.floor(Date.now() / 1000) - 3600,
    });

    const freshToken = await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
    });

    expect(freshToken).toEqual(expect.any(String));
    expect(freshToken).not.toBe(staleToken);
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
    ).toEqual(expect.any(String));
    expect(
      await jobsRepo.beginEvaluationIfIdle(second.id, {
        staleAfterSeconds: 300,
      }),
    ).toEqual(expect.any(String));
  });

  it("does not let a superseded attempt release the lock it lost", async () => {
    const job = await makeJob();
    const staleToken = await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
      now: Math.floor(Date.now() / 1000) - 3600,
    });
    const freshToken = await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
    });
    expect(staleToken).not.toBeNull();
    expect(freshToken).not.toBeNull();

    const released = await jobsRepo.releaseEvaluationLock(
      job.id,
      staleToken as string,
    );

    expect(released).toBe(false);
    const stored = await jobsRepo.getJobById(job.id);
    expect(stored?.evaluationReportGenerating).toBe(true);

    // The current owner can still release it.
    expect(
      await jobsRepo.releaseEvaluationLock(job.id, freshToken as string),
    ).toBe(true);
  });

  it("does not let a superseded attempt store a report", async () => {
    const job = await makeJob();
    const staleToken = await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
      now: Math.floor(Date.now() / 1000) - 3600,
    });
    await jobsRepo.beginEvaluationIfIdle(job.id, { staleAfterSeconds: 300 });

    const stored = await jobsRepo.finalizeEvaluationReport({
      id: job.id,
      token: staleToken as string,
      report: "# stale",
      model: "stale-model",
      meta: "{}",
      generatedAt: new Date().toISOString(),
    });

    expect(stored).toBe(false);
    const after = await jobsRepo.getJobById(job.id);
    expect(after?.evaluationReport).toBeNull();
    expect(after?.evaluationReportGenerating).toBe(true);
  });

  it("stores the report and frees the lock for the owner", async () => {
    const job = await makeJob();
    const token = await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
    });
    const generatedAt = new Date().toISOString();

    const stored = await jobsRepo.finalizeEvaluationReport({
      id: job.id,
      token: token as string,
      report: "# fresh",
      model: "test-model",
      meta: JSON.stringify({ verdict: "apply" }),
      generatedAt,
    });

    expect(stored).toBe(true);
    const after = await jobsRepo.getJobById(job.id);
    expect(after?.evaluationReport).toBe("# fresh");
    expect(after?.evaluationReportGenerating).toBe(false);
    expect(after?.evaluationReportGeneratedAt).toBe(generatedAt);

    // Finalizing already released the lock, so a retry cannot settle twice.
    expect(
      await jobsRepo.finalizeEvaluationReport({
        id: job.id,
        token: token as string,
        report: "# duplicate",
        model: "test-model",
        meta: "{}",
        generatedAt,
      }),
    ).toBe(false);
  });

  it("keeps the lock stale even when an unrelated write touches the row", async () => {
    const job = await makeJob();
    const staleAt = Math.floor(Date.now() / 1000) - 3600;
    await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
      now: staleAt,
    });

    // Any other update refreshes `updated_at`. Staleness must not depend on it.
    await jobsRepo.updateJob(job.id, { status: "applied" });

    const takeover = await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
    });

    expect(takeover).toEqual(expect.any(String));
  });
});
