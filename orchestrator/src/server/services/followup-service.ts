import type {
  ApplicationStage,
  FollowupItem,
  FollowupsResponse,
  JobOutcome,
} from "@shared/types";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index";
import { privateDataScopeFilter } from "../tenancy/private-scope";
import { computeFollowupState } from "./followup-cadence";

const { jobs, stageEvents, tasks } = schema;

export async function listFollowups(now: number): Promise<FollowupsResponse> {
  const rows = await db
    .select({
      id: jobs.id,
      employer: jobs.employer,
      title: jobs.title,
      jobUrl: jobs.jobUrl,
      status: jobs.status,
      outcome: jobs.outcome,
      appliedAt: jobs.appliedAt,
    })
    .from(jobs)
    .where(
      and(
        privateDataScopeFilter(jobs),
        inArray(jobs.status, ["applied", "in_progress"]),
      ),
    );

  const due: FollowupItem[] = [];
  const upcoming: FollowupItem[] = [];

  for (const row of rows) {
    if (!row.appliedAt) continue;
    const appliedAt = Math.floor(new Date(row.appliedAt).getTime() / 1000);
    if (!Number.isFinite(appliedAt) || appliedAt <= 0) continue;

    const lastEvent = await db
      .select({
        occurredAt: stageEvents.occurredAt,
        toStage: stageEvents.toStage,
      })
      .from(stageEvents)
      .where(
        and(
          privateDataScopeFilter(stageEvents),
          eq(stageEvents.applicationId, row.id),
        ),
      )
      .orderBy(desc(stageEvents.occurredAt))
      .limit(1)
      .get();

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          privateDataScopeFilter(tasks),
          eq(tasks.applicationId, row.id),
          eq(tasks.type, "follow_up"),
          eq(tasks.isCompleted, true),
        ),
      );

    const stage =
      (lastEvent?.toStage as ApplicationStage | undefined) ?? "applied";
    const state = computeFollowupState({
      stage,
      outcome: (row.outcome as JobOutcome | null) ?? null,
      appliedAt,
      lastContactAt: Math.max(appliedAt, lastEvent?.occurredAt ?? 0),
      followUpsSent: Number(countRow?.count ?? 0),
      now,
    });

    if (state.status === "not_applicable") continue;

    const item: FollowupItem = {
      jobId: row.id,
      employer: row.employer,
      title: row.title,
      jobUrl: row.jobUrl,
      stage,
      appliedAt: row.appliedAt,
      nextDueOn: state.nextDueOn,
      status: state.status,
      step: state.step,
    };

    (state.status === "due" ? due : upcoming).push(item);
  }

  const byDate = (a: FollowupItem, b: FollowupItem) =>
    a.nextDueOn.localeCompare(b.nextDueOn);

  return { due: due.sort(byDate), upcoming: upcoming.sort(byDate) };
}
