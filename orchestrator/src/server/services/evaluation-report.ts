/**
 * Evaluation report: a readable, evidence-bound explanation of why a job does
 * or does not fit the candidate. The LLM only writes the judgement; every
 * figure about the posting comes from the job row.
 */

import { randomUUID } from "node:crypto";
import { logger } from "@infra/logger";
import type { EvaluationReportMeta, Job, ResumeProfile } from "@shared/types";
import { withHostedUsageReservation } from "./hosted-usage";
import type { JsonSchemaDefinition } from "./llm/types";
import { createConfiguredLlmService, resolveLlmModel } from "./modelSelection";
import {
  getWritingLanguageLabel,
  resolveWritingOutputLanguage,
} from "./output-language";
import { sanitizeProfileForPrompt } from "./profile-prompt";
import {
  getEffectivePromptTemplate,
  renderPromptTemplate,
} from "./prompt-templates";
import { filterProfileProjectsForAi } from "./resumeProjects";
import { getWritingStyle } from "./writing-style";

const EVALUATION_LLM_TIMEOUT_MS = 120_000;

export class EvaluationReportNotApplicableError extends Error {
  constructor(message = "This job has no description to evaluate") {
    super(message);
    this.name = "EvaluationReportNotApplicableError";
  }
}

export type EvaluationReportBasis = "full_jd" | "partial_jd" | "minimal_jd";

export type EvaluationReportResult = {
  verdict: EvaluationReportMeta["verdict"];
  summary: string;
  scoreBreakdown: {
    match: number;
    northStar: number;
    comp: number | null;
    culture: number;
    redFlags: number;
  };
  evidence: Array<{
    requirement: string;
    cvMatch: "strong" | "partial" | "gap";
    evidence: string;
  }>;
  gaps: string[];
  basis: EvaluationReportBasis;
  confidence: number;
};

const EVALUATION_SCHEMA: JsonSchemaDefinition = {
  name: "evaluation_report",
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["apply", "consider", "skip"] },
      summary: { type: "string" },
      scoreBreakdown: {
        type: "object",
        properties: {
          match: { type: "number" },
          northStar: { type: "number" },
          comp: { type: ["number", "null"] },
          culture: { type: "number" },
          redFlags: { type: "number" },
        },
        required: ["match", "northStar", "comp", "culture", "redFlags"],
        additionalProperties: false,
      },
      evidence: {
        type: "array",
        maxItems: 15,
        items: {
          type: "object",
          properties: {
            requirement: { type: "string" },
            cvMatch: { type: "string", enum: ["strong", "partial", "gap"] },
            evidence: { type: "string" },
          },
          required: ["requirement", "cvMatch", "evidence"],
          additionalProperties: false,
        },
      },
      gaps: { type: "array", maxItems: 10, items: { type: "string" } },
      basis: {
        type: "string",
        enum: ["full_jd", "partial_jd", "minimal_jd"],
      },
      confidence: { type: "number" },
    },
    required: [
      "verdict",
      "summary",
      "scoreBreakdown",
      "evidence",
      "gaps",
      "basis",
      "confidence",
    ],
    additionalProperties: false,
  },
};

const BASIS_ORDER: EvaluationReportBasis[] = [
  "minimal_jd",
  "partial_jd",
  "full_jd",
];

const FULL_JD_MIN_LENGTH = 1500;
const PARTIAL_JD_MIN_LENGTH = 400;

function basisFromDescription(description: string): EvaluationReportBasis {
  if (description.length >= FULL_JD_MIN_LENGTH) return "full_jd";
  if (description.length >= PARTIAL_JD_MIN_LENGTH) return "partial_jd";
  return "minimal_jd";
}

function weakerBasis(
  a: EvaluationReportBasis,
  b: EvaluationReportBasis,
): EvaluationReportBasis {
  return BASIS_ORDER.indexOf(a) <= BASIS_ORDER.indexOf(b) ? a : b;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderEvaluationMarkdown(input: {
  job: Job;
  result: EvaluationReportResult;
}): string {
  const { job, result } = input;
  const lines: string[] = [];

  lines.push(
    "## Veredicto",
    "",
    `**${result.verdict}** — ${result.summary}`,
    "",
  );
  lines.push(
    `Match ${result.scoreBreakdown.match}/5 · North Star ${result.scoreBreakdown.northStar}/5 · Comp ${
      result.scoreBreakdown.comp === null
        ? "—"
        : `${result.scoreBreakdown.comp}/5`
    } · Culture ${result.scoreBreakdown.culture}/5 · Red flags ${result.scoreBreakdown.redFlags}/5`,
    "",
  );

  lines.push("## Evidencia JD ↔ CV", "");
  if (result.evidence.length === 0) {
    lines.push("El modelo no devolvió evidencia.", "");
  } else {
    lines.push("| Requisito | Match | Evidencia |", "|---|---|---|");
    for (const row of result.evidence) {
      lines.push(
        `| ${escapeTableCell(row.requirement)} | ${row.cvMatch} | ${escapeTableCell(row.evidence)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Gaps", "");
  if (result.gaps.length === 0) {
    lines.push("Sin gaps declarados.", "");
  } else {
    lines.push(...result.gaps.map((gap) => `- ${gap}`), "");
  }

  lines.push("## Compensación", "");
  lines.push(
    job.salary?.trim()
      ? `Según la oferta: ${job.salary.trim()}.`
      : "No verificado: la oferta no publica salario y el sistema no estima rangos.",
    "",
  );

  const signals: string[] = [];
  if (job.deadline && job.deadline < new Date().toISOString().slice(0, 10)) {
    signals.push(`deadline vencido (${job.deadline})`);
  }
  if (!job.employerUrl) signals.push("sin URL del empleador");
  if (!job.salary) signals.push("sin salario publicado");
  if ((job.jobDescription?.length ?? 0) < PARTIAL_JD_MIN_LENGTH) {
    signals.push("descripción muy corta");
  }

  lines.push("## Señales de la oferta", "");
  lines.push(
    signals.length === 0
      ? "Sin señales de alerta en los datos de la oferta."
      : signals.map((signal) => `- ${signal}`).join("\n"),
    "",
  );

  return lines.join("\n").trimEnd();
}

export async function generateEvaluationReport(input: {
  job: Job;
  profile: Record<string, unknown>;
}): Promise<{
  markdown: string;
  model: string;
  meta: EvaluationReportMeta;
}> {
  const description = input.job.jobDescription?.trim() ?? "";
  if (!description) throw new EvaluationReportNotApplicableError();

  const [model, template, aiProfile, writingStyle] = await Promise.all([
    resolveLlmModel("scoring"),
    getEffectivePromptTemplate("evaluationReportPromptTemplate"),
    filterProfileProjectsForAi(input.profile),
    getWritingStyle(),
  ]);

  const resolvedLanguage = resolveWritingOutputLanguage({
    style: writingStyle,
    profile: aiProfile as ResumeProfile,
    jobDescription: description,
  });

  const prompt = renderPromptTemplate(template, {
    profileJson: JSON.stringify(sanitizeProfileForPrompt(aiProfile)),
    jobTitle: input.job.title,
    employer: input.job.employer,
    jobDescription: description,
    outputLanguage: getWritingLanguageLabel(resolvedLanguage.language),
  });

  return withHostedUsageReservation(
    {
      action: "tailoring",
      // Per attempt, not per job: a distinct key means a regeneration reserves
      // (and checks the limit for) its own unit. A job-scoped key would find the
      // previous, already settled reservation and skip both.
      idempotencyKey: `${input.job.id}:${model}:${randomUUID()}`,
    },
    async () => {
      const llm = await createConfiguredLlmService("scoring");
      const result = await llm.callJson<EvaluationReportResult>({
        model,
        messages: [{ role: "user", content: prompt }],
        jsonSchema: EVALUATION_SCHEMA,
        maxRetries: 2,
        jobId: input.job.id,
        // Shorter than the lock window: a hung provider aborts and releases the
        // lock instead of letting a second attempt take over mid-flight.
        signal: AbortSignal.timeout(EVALUATION_LLM_TIMEOUT_MS),
      });

      if (!result.success) {
        logger.warn("Evaluation report failed", {
          jobId: input.job.id,
          model,
          error: result.error,
        });
        throw new Error(`Evaluation report failed: ${result.error}`);
      }

      const data = result.data;
      const basis = weakerBasis(data.basis, basisFromDescription(description));
      const meta: EvaluationReportMeta = {
        verdict: data.verdict,
        basis,
        confidence: Math.min(1, Math.max(0, Number(data.confidence) || 0)),
      };

      return {
        result: {
          markdown: renderEvaluationMarkdown({
            job: input.job,
            result: { ...data, basis },
          }),
          model,
          meta,
        },
        usedUnits: 1,
      };
    },
  );
}
