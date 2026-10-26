import { badRequest, notFound, toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { resolveRequestOrigin } from "@server/infra/request-origin";
import * as jobsRepo from "@server/repositories/jobs";
import { reconcileActivationMilestonesFromHistorySafely } from "@server/services/activation-funnel";
import {
  createApplicationTask,
  deleteStageEvent,
  getStageEvents,
  getTasks,
  transitionStage,
  updateApplicationTask,
  updateStageEvent,
} from "@server/services/applicationTracking";
import { trackApplicationAcceptedIfNeeded } from "@server/services/jobs/analytics";
import { APPLICATION_TASK_TYPES } from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import {
  hydrateJobPdfFreshness,
  transitionStageSchema,
  updateOutcomeSchema,
  updateStageEventSchema,
} from "./shared";

export const jobsStagesRouter = Router();

jobsStagesRouter.get("/:id/events", async (req: Request, res: Response) => {
  try {
    const events = await getStageEvents(req.params.id);
    ok(res, events);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

const createTaskSchema = z.object({
  type: z.enum(APPLICATION_TASK_TYPES),
  title: z.string().trim().min(1).max(120),
  dueDate: z.number().int().positive().nullable(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const updateTaskSchema = z
  .object({
    isCompleted: z.boolean().optional(),
    dueDate: z.number().int().positive().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const noteEventSchema = z
  .object({
    eventType: z.literal("note"),
    eventLabel: z.string().trim().min(1).max(120),
    occurredAt: z.number().int().positive().optional(),
  })
  .strict();

jobsStagesRouter.get("/:id/tasks", async (req: Request, res: Response) => {
  try {
    const includeCompleted =
      req.query.includeCompleted === "1" ||
      req.query.includeCompleted === "true";
    const tasks = await getTasks(req.params.id, includeCompleted);
    ok(res, tasks);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

jobsStagesRouter.post("/:id/tasks", async (req: Request, res: Response) => {
  try {
    const input = createTaskSchema.parse(req.body);
    const job = await jobsRepo.getJobById(req.params.id);
    if (!job) throw notFound("Job not found");

    const task = await createApplicationTask({
      applicationId: job.id,
      type: input.type,
      title: input.title,
      dueDate: input.dueDate,
      notes: input.notes ?? null,
    });

    ok(res, task, 201);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

jobsStagesRouter.patch(
  "/:id/tasks/:taskId",
  async (req: Request, res: Response) => {
    try {
      const input = updateTaskSchema.parse(req.body);
      const task = await updateApplicationTask({
        applicationId: req.params.id,
        taskId: req.params.taskId,
        ...input,
      });
      if (!task) throw notFound("Task not found");

      ok(res, task);
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

jobsStagesRouter.post("/:id/events", async (req: Request, res: Response) => {
  try {
    const input = noteEventSchema.parse(req.body);
    const event = transitionStage(
      req.params.id,
      "no_change",
      input.occurredAt ?? Math.floor(Date.now() / 1000),
      { eventType: "note", eventLabel: input.eventLabel, actor: "user" },
    );

    ok(res, event, 201);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

jobsStagesRouter.post("/:id/stages", async (req: Request, res: Response) => {
  try {
    const input = transitionStageSchema.parse(req.body);
    const event = transitionStage(
      req.params.id,
      input.toStage,
      input.occurredAt ?? undefined,
      input.metadata ?? null,
      input.outcome ?? null,
    );
    ok(res, event);
    queueMicrotask(() => {
      void reconcileActivationMilestonesFromHistorySafely({
        route: "POST /api/jobs/:id/stages",
        jobId: req.params.id,
      });
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(res, toAppError(error));
  }
});

jobsStagesRouter.patch(
  "/:id/events/:eventId",
  async (req: Request, res: Response) => {
    try {
      const input = updateStageEventSchema.parse(req.body);
      updateStageEvent(req.params.eventId, input);
      ok(res, null);
      queueMicrotask(() => {
        void reconcileActivationMilestonesFromHistorySafely({
          route: "PATCH /api/jobs/:id/events/:eventId",
          jobId: req.params.id,
          eventId: req.params.eventId,
        });
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return fail(res, badRequest(error.message, error.flatten()));
      }
      fail(res, toAppError(error));
    }
  },
);

jobsStagesRouter.delete(
  "/:id/events/:eventId",
  async (req: Request, res: Response) => {
    try {
      deleteStageEvent(req.params.eventId);
      ok(res, null);
      queueMicrotask(() => {
        void reconcileActivationMilestonesFromHistorySafely({
          route: "DELETE /api/jobs/:id/events/:eventId",
          jobId: req.params.id,
          eventId: req.params.eventId,
        });
      });
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

jobsStagesRouter.patch("/:id/outcome", async (req: Request, res: Response) => {
  try {
    const input = updateOutcomeSchema.parse(req.body);
    const currentJob = await jobsRepo.getJobById(req.params.id);
    if (!currentJob) {
      return fail(res, notFound("Job not found"));
    }
    const closedAt = input.outcome
      ? (input.closedAt ?? Math.floor(Date.now() / 1000))
      : null;
    const job = await jobsRepo.updateJob(req.params.id, {
      outcome: input.outcome,
      closedAt,
    });

    if (!job) {
      return fail(res, notFound("Job not found"));
    }

    trackApplicationAcceptedIfNeeded({
      closedAt: job.closedAt,
      nextOutcome: job.outcome,
      previousOutcome: currentJob.outcome,
      requestOrigin: resolveRequestOrigin(req),
      source: "jobs_outcome_route",
    });

    ok(res, await hydrateJobPdfFreshness(job));
    queueMicrotask(() => {
      void reconcileActivationMilestonesFromHistorySafely({
        route: "PATCH /api/jobs/:id/outcome",
        jobId: req.params.id,
      });
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(res, toAppError(error));
  }
});
