import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

const generateEvaluationReport = vi.fn();

vi.mock("@server/services/evaluation-report", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@server/services/evaluation-report")>();
  return { ...actual, generateEvaluationReport };
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.sequential("evaluation API", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    generateEvaluationReport.mockResolvedValue({
      markdown: "# Informe\n\n## Veredicto",
      model: "test-model",
      meta: { verdict: "apply", basis: "full_jd", confidence: 0.8 },
    });
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  const makeJob = async (jobDescription: string | null) => {
    const { createJob } = await import("@server/repositories/jobs");
    return createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: `https://example.com/job/${Math.random()}`,
      jobDescription: jobDescription ?? undefined,
    });
  };

  it("accepts the request and stores the report when done", async () => {
    const job = await makeJob("A long description");

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, {
      method: "POST",
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ jobId: job.id, status: "generating" });
    expect(typeof body.meta.requestId).toBe("string");

    await wait(50);
    const { getJobById } = await import("@server/repositories/jobs");
    const updated = await getJobById(job.id);

    expect(updated?.evaluationReportGenerating).toBe(false);
    expect(updated?.evaluationReport).toBe("# Informe\n\n## Veredicto");
    expect(updated?.evaluationReportModel).toBe("test-model");
    expect(updated?.evaluationReportMeta).toEqual({
      verdict: "apply",
      basis: "full_jd",
      confidence: 0.8,
    });
  });

  it("returns 409 while a generation is in flight", async () => {
    const job = await makeJob("A long description");
    generateEvaluationReport.mockImplementation(() => new Promise(() => {}));

    const first = await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, {
      method: "POST",
    });
    const second = await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, {
      method: "POST",
    });
    const body = await second.json();

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("returns 422 without a description", async () => {
    const job = await makeJob(null);

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, {
      method: "POST",
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(generateEvaluationReport).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown job", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/nope/evaluation`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });

  it("clears the lock and keeps the old report when generation fails", async () => {
    const job = await makeJob("A long description");
    generateEvaluationReport.mockRejectedValue(new Error("boom"));

    await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, { method: "POST" });
    await wait(50);

    const { getJobById } = await import("@server/repositories/jobs");
    const updated = await getJobById(job.id);

    expect(updated?.evaluationReportGenerating).toBe(false);
    expect(updated?.evaluationReport).toBeNull();
  });
});
