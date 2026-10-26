import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("follow-ups API", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("lists an applied job as due after seven days and excludes closed ones", async () => {
    const { createJob, updateJob } = await import("@server/repositories/jobs");
    const appliedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();

    const dueJob = await createJob({
      source: "manual",
      employer: "Acme",
      title: "Backend Engineer",
      jobUrl: "https://example.com/job/due",
    });
    await updateJob(dueJob.id, { status: "applied", appliedAt });

    const closedJob = await createJob({
      source: "manual",
      employer: "Globex",
      title: "Platform Engineer",
      jobUrl: "https://example.com/job/closed",
    });
    await updateJob(closedJob.id, {
      status: "applied",
      appliedAt,
      outcome: "rejected",
    });

    const res = await fetch(`${baseUrl}/api/follow-ups`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.due).toHaveLength(1);
    expect(body.data.due[0].jobId).toBe(dueJob.id);
    expect(body.data.due[0].nextDueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.data.upcoming).toHaveLength(0);
  });

  it("moves the date forward when a follow-up was sent", async () => {
    const { createJob, updateJob } = await import("@server/repositories/jobs");
    const { recordFollowupSent } = await import(
      "@server/services/applicationTracking"
    );

    const appliedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const job = await createJob({
      source: "manual",
      employer: "Initech",
      title: "Full Stack Engineer",
      jobUrl: "https://example.com/job/initech",
    });
    await updateJob(job.id, { status: "applied", appliedAt });
    recordFollowupSent(job.id, Math.floor(Date.now() / 1000));

    const res = await fetch(`${baseUrl}/api/follow-ups`);
    const body = await res.json();

    expect(body.data.due).toHaveLength(0);
    expect(body.data.upcoming).toHaveLength(1);
    expect(body.data.upcoming[0].step).toBe(0);
  });
});
