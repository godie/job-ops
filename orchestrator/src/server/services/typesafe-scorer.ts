import { logger } from "@infra/logger";
import * as settingsRepo from "@server/repositories/settings";
import { getOriginalEnvValue } from "@server/services/envSettings";
import type { Job } from "@shared/types";
import { toStringOrNull } from "@shared/utils/type-conversion";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_TYPESAFE_MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 15000;

export const FIT_LEVELS = [
  "No fit: role, stack, or location fundamentally incompatible",
  "Poor fit: most requirements unmet",
  "Partial fit: meets essentials with notable gaps",
  "Good fit: meets nearly all relevant requirements",
  "Excellent fit: ideal role, stack-matched, conditions aligned",
] as const;

export class TypesafeNotConfiguredError extends Error {
  constructor(message = "TypeSafe API key is not configured") {
    super(message);
    this.name = "TypesafeNotConfiguredError";
  }
}

export class TypesafeScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypesafeScoringError";
  }
}

export type TypesafeFitResult = {
  score: number;
  confidence: number;
  levelPosition: number;
  levelLabel: string;
  probabilities: Record<string, number>;
  model: string;
  latencyMs: number;
};

export function mapFitLevelToScore(
  levelPosition: number,
  levelCount = FIT_LEVELS.length,
): number {
  const clamped = Math.min(levelCount - 1, Math.max(0, levelPosition));
  return Math.round((clamped / (levelCount - 1)) * 100);
}

type FitAnswer = {
  score: number;
  confidence: number;
  levelLabel: string;
  probabilities: Record<string, number>;
};

function argmaxLevel(probabilities: Record<string, number>): number {
  let best = 0;
  let bestValue = -Infinity;
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > bestValue) {
      bestValue = value;
      best = Number(key);
    }
  }
  return best;
}

export function extractFitAnswer(json: unknown): FitAnswer {
  const fit = (json as { answers?: Record<string, unknown> } | null)?.answers
    ?.fit as
    | {
        score?: unknown;
        confidence?: unknown;
        legend?: Record<string, unknown>;
        probabilities?: Record<string, unknown>;
      }
    | undefined;

  if (
    !fit ||
    typeof fit.score !== "number" ||
    typeof fit.confidence !== "number"
  ) {
    throw new TypesafeScoringError(
      "TypeSafe response is missing a numeric fit answer",
    );
  }

  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(fit.probabilities ?? {})) {
    probabilities[key] = typeof value === "number" ? value : 0;
  }
  const modalLevel = argmaxLevel(probabilities);
  const legendValue = fit.legend?.[String(modalLevel)];
  const fallbackLabel =
    FIT_LEVELS[
      Math.min(FIT_LEVELS.length - 1, Math.max(0, Math.round(fit.score)))
    ];
  const levelLabel =
    typeof legendValue === "string" ? legendValue : fallbackLabel;

  return {
    score: fit.score,
    confidence: fit.confidence,
    levelLabel,
    probabilities,
  };
}

export function buildFitQuestion(instructions: string): {
  type: "score";
  instructions: string;
  criteria: string[];
} {
  return {
    type: "score",
    instructions: [
      "How well does this candidate fit this job? Judge stack, seniority, domain, location/remote, and the stated conditions against `candidate_profile`.",
      instructions,
    ]
      .filter(Boolean)
      .join("\n"),
    criteria: [...FIT_LEVELS],
  };
}

export function buildFitState(input: {
  job: Job;
  profile: Record<string, unknown>;
  scoringInstructions: string;
}): Record<string, unknown> {
  const { job } = input;
  return {
    job: {
      title: job.title,
      employer: job.employer,
      location: job.location,
      salary: job.salary,
      job_type: job.jobType,
      work_from_home_type: job.workFromHomeType,
      job_description: (job.jobDescription ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 12000),
    },
    candidate_profile: input.profile,
    scoring_instructions: input.scoringInstructions,
  };
}

export async function resolveTypesafeApiKey(): Promise<string | null> {
  const stored = await settingsRepo.getSetting("typesafeApiKey");
  return (
    toStringOrNull(stored) ??
    toStringOrNull(getOriginalEnvValue("TYPESAFE_API_KEY"))
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function postSystemOne(
  body: unknown,
  apiKey: string,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(TYPESAFE_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timeout);
  }
}

export async function scoreFitWithTypeSafe(input: {
  job: Job;
  profile: Record<string, unknown>;
  apiKey: string | null;
  model: string;
  scoringInstructions: string;
}): Promise<TypesafeFitResult> {
  if (!input.apiKey) throw new TypesafeNotConfiguredError();

  const body = {
    state: buildFitState({
      job: input.job,
      profile: input.profile,
      scoringInstructions: input.scoringInstructions,
    }),
    model: input.model || DEFAULT_TYPESAFE_MODEL,
    questions: { fit: buildFitQuestion(input.scoringInstructions) },
  };

  const startedAt = Date.now();
  let result = await postSystemOne(body, input.apiKey);
  if (result.status === 429 || result.status === 529) {
    await sleep(500);
    result = await postSystemOne(body, input.apiKey);
  }

  if (result.status < 200 || result.status >= 300 || !result.json) {
    logger.warn("TypeSafe scoring request failed", {
      provider: "typesafe",
      status: result.status,
      jobId: input.job.id,
    });
    throw new TypesafeScoringError(
      `TypeSafe request failed with status ${result.status}`,
    );
  }

  const answer = extractFitAnswer(result.json);
  const model = (result.json as { model?: string }).model ?? input.model;
  const latencyMs = Date.now() - startedAt;

  logger.info("TypeSafe scoring completed", {
    provider: "typesafe",
    model,
    score: mapFitLevelToScore(answer.score),
    confidence: answer.confidence,
    level: answer.score,
    latencyMs,
    jobId: input.job.id,
  });

  return {
    score: mapFitLevelToScore(answer.score),
    confidence: answer.confidence,
    levelPosition: answer.score,
    levelLabel: answer.levelLabel,
    probabilities: answer.probabilities,
    model,
    latencyMs,
  };
}
