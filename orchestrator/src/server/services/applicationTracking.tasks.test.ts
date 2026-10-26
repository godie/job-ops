import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("application tasks", () => {
  let tempDir: string;
  let applicationTracking: any;
  let jobsRepo: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-tasks-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    applicationTracking = await import("./applicationTracking");
    jobsRepo = await import("../repositories/jobs");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("crea, lista y completa una tarea de follow-up", async () => {
    const job = await jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/1",
    });

    const created = await applicationTracking.createApplicationTask({
      applicationId: job.id,
      type: "follow_up",
      title: "Follow-up — Acme",
      dueDate: 1762560000,
    });
    expect(created.isCompleted).toBe(false);
    expect(created.type).toBe("follow_up");

    expect(await applicationTracking.getTasks(job.id)).toHaveLength(1);

    const completed = await applicationTracking.updateApplicationTask({
      applicationId: job.id,
      taskId: created.id,
      isCompleted: true,
    });
    expect(completed?.isCompleted).toBe(true);
    expect(await applicationTracking.getTasks(job.id)).toHaveLength(0);
    expect(await applicationTracking.getTasks(job.id, true)).toHaveLength(1);
  });

  it("devuelve null al actualizar una tarea inexistente", async () => {
    const job = await jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/2",
    });
    expect(
      await applicationTracking.updateApplicationTask({
        applicationId: job.id,
        taskId: "does-not-exist",
        isCompleted: true,
      }),
    ).toBeNull();
  });

  it("registra el follow-up enviado como nota sin cambiar de etapa", async () => {
    const job = await jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/3",
    });
    await jobsRepo.updateJob(job.id, {
      status: "applied",
      appliedAt: "2026-11-01T09:00:00.000Z",
    });

    const event = applicationTracking.recordFollowupSent(job.id, 1762560000);
    expect(event.toStage).toBe("applied");
    expect(event.metadata?.eventType).toBe("note");

    const events = await applicationTracking.getStageEvents(job.id);
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt).toBe(1762560000);
  });
});
