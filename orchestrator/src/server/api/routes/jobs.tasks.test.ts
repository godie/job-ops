import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("job tasks API", () => {
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

  it("creates and completes a task", async () => {
    const { createJob } = await import("@server/repositories/jobs");
    const job = await createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/tasks",
    });

    const createRes = await fetch(`${baseUrl}/api/jobs/${job.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "follow_up",
        title: "Follow-up — Acme",
        dueDate: 1762560000,
      }),
    });
    const createBody = await createRes.json();
    expect(createRes.status).toBe(201);
    expect(createBody.ok).toBe(true);
    expect(createBody.data.title).toBe("Follow-up — Acme");
    expect(typeof createBody.meta.requestId).toBe("string");

    const patchRes = await fetch(
      `${baseUrl}/api/jobs/${job.id}/tasks/${createBody.data.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isCompleted: true }),
      },
    );
    const patchBody = await patchRes.json();
    expect(patchRes.status).toBe(200);
    expect(patchBody.data.isCompleted).toBe(true);
  });

  it("returns 400 for an invalid task body", async () => {
    const { createJob } = await import("@server/repositories/jobs");
    const job = await createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/tasks-2",
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "nope", title: "" }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 404 for an unknown task", async () => {
    const { createJob } = await import("@server/repositories/jobs");
    const job = await createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/tasks-3",
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/tasks/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isCompleted: true }),
    });
    expect(res.status).toBe(404);
  });

  it("records a follow-up note without changing the stage", async () => {
    const { createJob, updateJob } = await import("@server/repositories/jobs");
    const job = await createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/events",
    });
    await updateJob(job.id, {
      status: "applied",
      appliedAt: "2026-11-01T09:00:00.000Z",
    });

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventType: "note",
        eventLabel: "Follow-up enviado",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.toStage).toBe("applied");
    expect(body.data.metadata.eventType).toBe("note");
  });
});
