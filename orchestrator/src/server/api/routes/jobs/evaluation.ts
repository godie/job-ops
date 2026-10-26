import {
  conflict,
  notFound,
  toAppError,
  unprocessableEntity,
} from "@infra/errors";
import { fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { getRequestId } from "@infra/request-context";
import * as jobsRepo from "@server/repositories/jobs";
import { generateEvaluationReport } from "@server/services/evaluation-report";
import { getProfile } from "@server/services/profile";
import { type Request, type Response, Router } from "express";

export const jobsEvaluationRouter = Router();

const LOCK_STALE_SECONDS = 300;
const ROUTE = "POST /api/jobs/:id/evaluation";

async function runEvaluationReport(
  jobId: string,
  requestId: string | undefined,
): Promise<void> {
  const startedAt = Date.now();
  let status = 202;
  let outcome = "success";
  let model: string | null = null;

  try {
    const job = await jobsRepo.getJobById(jobId);
    if (!job) return;

    const profile = await getProfile();
    const report = await generateEvaluationReport({
      job,
      profile: profile as unknown as Record<string, unknown>,
    });
    model = report.model;

    await jobsRepo.updateJob(jobId, {
      evaluationReport: report.markdown,
      evaluationReportGeneratedAt: new Date().toISOString(),
      evaluationReportModel: report.model,
      evaluationReportMeta: JSON.stringify(report.meta),
    });
  } catch (error) {
    status = 502;
    outcome = "error";
    logger.error("Evaluation report failed", {
      requestId: requestId ?? null,
      jobId,
      route: ROUTE,
      status,
      durationMs: Date.now() - startedAt,
      outcome,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      await jobsRepo.updateJob(jobId, { evaluationReportGenerating: false });
    } catch (error) {
      logger.error("Evaluation report lock release failed", {
        requestId: requestId ?? null,
        jobId,
        route: ROUTE,
        status,
        durationMs: Date.now() - startedAt,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (outcome === "success") {
    logger.info("Evaluation report generated", {
      requestId: requestId ?? null,
      jobId,
      route: ROUTE,
      status,
      model,
      durationMs: Date.now() - startedAt,
      outcome,
    });
  }
}

/**
 * POST /api/jobs/:id/evaluation - start generating the readable evaluation
 * report. The response is immediate; the work happens in the background and
 * the job row carries the result plus a lock flag the client can poll.
 */
jobsEvaluationRouter.post(
  "/:id/evaluation",
  async (req: Request, res: Response) => {
    try {
      const job = await jobsRepo.getJobById(req.params.id);
      if (!job) throw notFound("Job not found");

      if (!job.jobDescription?.trim()) {
        throw unprocessableEntity(
          "This job has no description. Add one before requesting an evaluation.",
        );
      }

      const started = await jobsRepo.beginEvaluationIfIdle(job.id, {
        staleAfterSeconds: LOCK_STALE_SECONDS,
      });
      if (!started) {
        throw conflict(
          "An evaluation report is already being generated for this job.",
        );
      }

      const requestId = getRequestId();
      ok(res, { jobId: job.id, status: "generating" as const }, 202);
      void runEvaluationReport(job.id, requestId);
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);
