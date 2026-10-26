import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("job detail", () => {
  let tempDir: string;
  let jobsRepo: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-detail-test-"));
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

  it("returns the evaluation fields with safe defaults", async () => {
    const created = await jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/detail",
    });

    const job = await jobsRepo.getJobById(created.id);

    expect(job.evaluationReport).toBeNull();
    expect(job.evaluationReportGeneratedAt).toBeNull();
    expect(job.evaluationReportModel).toBeNull();
    expect(job.evaluationReportMeta).toBeNull();
    expect(job.evaluationReportGenerating).toBe(false);
  });

  it("round-trips the report meta as JSON", async () => {
    const created = await jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/detail-2",
    });

    await jobsRepo.updateJob(created.id, {
      evaluationReport: "# Informe",
      evaluationReportGeneratedAt: "2026-10-26T10:00:00.000Z",
      evaluationReportModel: "test-model",
      evaluationReportMeta: JSON.stringify({
        verdict: "apply",
        basis: "full_jd",
        confidence: 0.8,
      }),
    });

    const job = await jobsRepo.getJobById(created.id);
    expect(job.evaluationReport).toBe("# Informe");
    expect(job.evaluationReportModel).toBe("test-model");
    expect(job.evaluationReportMeta).toEqual({
      verdict: "apply",
      basis: "full_jd",
      confidence: 0.8,
    });
  });

  it("treats malformed meta as null instead of throwing", async () => {
    const created = await jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/detail-3",
    });

    await jobsRepo.updateJob(created.id, {
      evaluationReportMeta: "{not json",
    });

    const job = await jobsRepo.getJobById(created.id);
    expect(job.evaluationReportMeta).toBeNull();
  });
});
