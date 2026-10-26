import type { ApplicationStage, JobOutcome } from "@shared/types";

export const FOLLOWUP_RULES = {
  appliedFirstDays: 7,
  appliedSubsequentDays: 7,
  respondedFirstDays: 1,
  respondedSubsequentDays: 3,
  interviewThankYouDays: 1,
} as const;

export type FollowupComputeInput = {
  stage: ApplicationStage;
  outcome: JobOutcome | null;
  /** epoch segundos */
  appliedAt: number;
  /** epoch segundos: max(appliedAt, último stage_event.occurredAt) */
  lastContactAt: number;
  followUpsSent: number;
  /** epoch segundos */
  now: number;
};

export type FollowupComputation =
  | { status: "not_applicable"; reason: "closed" | "not_started" }
  | { status: "due" | "upcoming"; nextDueOn: string; step: number };

const RESPONDED_STAGES = new Set<ApplicationStage>([
  "recruiter_screen",
  "assessment",
  "hiring_manager_screen",
]);

const INTERVIEW_STAGES = new Set<ApplicationStage>([
  "technical_interview",
  "onsite",
  "offer",
]);

const pad = (value: number): string => value.toString().padStart(2, "0");

export function formatLocalDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addLocalDays(seconds: number, days: number): number {
  const date = new Date(seconds * 1000);
  return Math.floor(
    new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + days,
    ).getTime() / 1000,
  );
}

function daysFor(input: FollowupComputeInput): number {
  if (RESPONDED_STAGES.has(input.stage)) {
    return input.followUpsSent === 0
      ? FOLLOWUP_RULES.respondedFirstDays
      : FOLLOWUP_RULES.respondedSubsequentDays;
  }
  if (INTERVIEW_STAGES.has(input.stage)) {
    return input.followUpsSent === 0
      ? FOLLOWUP_RULES.interviewThankYouDays
      : FOLLOWUP_RULES.respondedSubsequentDays;
  }
  return input.followUpsSent === 0
    ? FOLLOWUP_RULES.appliedFirstDays
    : FOLLOWUP_RULES.appliedSubsequentDays;
}

export function computeFollowupState(
  input: FollowupComputeInput,
): FollowupComputation {
  if (input.outcome !== null || input.stage === "closed") {
    return { status: "not_applicable", reason: "closed" };
  }
  if (!input.appliedAt) {
    return { status: "not_applicable", reason: "not_started" };
  }

  const nextDueOn = formatLocalDate(
    addLocalDays(input.lastContactAt, daysFor(input)),
  );
  const today = formatLocalDate(input.now);

  return {
    status: nextDueOn <= today ? "due" : "upcoming",
    nextDueOn,
    step: input.followUpsSent,
  };
}
