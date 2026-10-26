# Cadencia de follow-ups — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que job-ops diga, para cada aplicación abierta, a quién le toca escribir hoy y cuándo, con reglas calculadas en lectura y sin cron.

**Architecture:** una función pura calcula la fecha del siguiente follow-up a partir de la etapa, la fecha de aplicación y el último contacto (registrado como `stage_event`, porque `tasks` no tiene timestamps). Una ruta `GET /api/follow-ups` agrega por tenant, y una página nueva permite programar la tarea (`tasks`, hoy sin escritura) o marcarla enviada. No hay job de fondo ni estado propio.

**Tech Stack:** TypeScript, Express, Drizzle ORM sobre SQLite, Zod, React + react-query, Vitest.

## Global Constraints

- Todas las rutas `/api/*` devuelven `{ ok: true, data, meta: { requestId } }` o `{ ok: false, error: { code, message, details? }, meta: { requestId } }` (`AGENTS.md`).
- Los códigos HTTP siguen el mapeo de `AGENTS.md`: 404 `NOT_FOUND`, 422 `UNPROCESSABLE_ENTITY`.
- Fechas del dominio en **segundos** epoch: `tasks.due_date` y `stage_events.occurred_at` son segundos (`client/lib/utils.ts:36` multiplica por 1000 al formatear).
- `nextDueOn` se expone como `YYYY-MM-DD` en calendario local; nunca "en N días".
- Sin tope de follow-ups: la cadencia sigue mientras el job esté abierto (§2.10 del spec).
- Todo query pasa por `privateDataScopeFilter` / `getPrivateDataScope`; ningún estado de tenant en memoria.
- Sin `console.*`: usar `logger` de `@infra/logger` si hace falta registrar algo.
- Verificación final: `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.

---

### Task 1: Módulo puro de cadencia

**Files:**
- Create: `orchestrator/src/server/services/followup-cadence.ts`
- Test: `orchestrator/src/server/services/followup-cadence.test.ts`

**Interfaces:**
- Consumes: `ApplicationStage`, `JobOutcome` de `@shared/types`.
- Produces: `FOLLOWUP_RULES`, `FollowupComputeInput`, `FollowupComputation`, `computeFollowupState(input)`, `formatLocalDate(seconds)`.

- [ ] **Step 1: Write the failing test**

```ts
// orchestrator/src/server/services/followup-cadence.test.ts
import { describe, expect, it } from "vitest";
import { computeFollowupState, formatLocalDate } from "./followup-cadence";

const at = (y: number, m: number, d: number, h = 9, min = 0) =>
  Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);

describe("computeFollowupState", () => {
  it("programa el primer follow-up a 7 días de la aplicación", () => {
    const state = computeFollowupState({
      stage: "applied",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 1),
      followUpsSent: 0,
      now: at(2026, 11, 8),
    });
    expect(state).toEqual({ status: "due", nextDueOn: "2026-11-08", step: 0 });
  });

  it("queda upcoming el día anterior", () => {
    const state = computeFollowupState({
      stage: "applied",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 1),
      followUpsSent: 0,
      now: at(2026, 11, 7),
    });
    expect(state).toEqual({
      status: "upcoming",
      nextDueOn: "2026-11-08",
      step: 0,
    });
  });

  it("usa 7 días para los siguientes follow-ups de una aplicación", () => {
    const state = computeFollowupState({
      stage: "applied",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 5),
      followUpsSent: 1,
      now: at(2026, 11, 11),
    });
    expect(state).toEqual({
      status: "upcoming",
      nextDueOn: "2026-11-12",
      step: 1,
    });
  });

  it("no tiene tope: el follow-up 10 sigue programándose", () => {
    const state = computeFollowupState({
      stage: "applied",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 5),
      followUpsSent: 10,
      now: at(2026, 11, 12),
    });
    expect(state).toEqual({ status: "due", nextDueOn: "2026-11-12", step: 10 });
  });

  it("usa 1 día y luego 3 cuando la empresa respondió", () => {
    const first = computeFollowupState({
      stage: "recruiter_screen",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 5),
      followUpsSent: 0,
      now: at(2026, 11, 5),
    });
    expect(first.nextDueOn).toBe("2026-11-06");

    const second = computeFollowupState({
      stage: "recruiter_screen",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 5),
      followUpsSent: 1,
      now: at(2026, 11, 5),
    });
    expect(second.nextDueOn).toBe("2026-11-08");
  });

  it("usa el agradecimiento a 1 día en entrevistas", () => {
    const state = computeFollowupState({
      stage: "technical_interview",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 5),
      followUpsSent: 0,
      now: at(2026, 11, 5),
    });
    expect(state.nextDueOn).toBe("2026-11-06");
  });

  it("no aplica a jobs cerrados o con resultado", () => {
    expect(
      computeFollowupState({
        stage: "closed",
        outcome: null,
        appliedAt: at(2026, 11, 1),
        lastContactAt: at(2026, 11, 1),
        followUpsSent: 0,
        now: at(2026, 11, 5),
      }),
    ).toEqual({ status: "not_applicable", reason: "closed" });

    expect(
      computeFollowupState({
        stage: "applied",
        outcome: "rejected",
        appliedAt: at(2026, 11, 1),
        lastContactAt: at(2026, 11, 1),
        followUpsSent: 0,
        now: at(2026, 11, 5),
      }),
    ).toEqual({ status: "not_applicable", reason: "closed" });
  });

  it("no aplica si todavía no se aplicó", () => {
    expect(
      computeFollowupState({
        stage: "applied",
        outcome: null,
        appliedAt: 0,
        lastContactAt: 0,
        followUpsSent: 0,
        now: at(2026, 11, 5),
      }),
    ).toEqual({ status: "not_applicable", reason: "not_started" });
  });

  it("no cambia de fecha según la hora del día", () => {
    const base = {
      stage: "applied" as const,
      outcome: null,
      appliedAt: at(2026, 11, 1, 23, 50),
      lastContactAt: at(2026, 11, 1, 23, 50),
      followUpsSent: 0,
    };

    expect(
      computeFollowupState({ ...base, now: at(2026, 11, 7, 23, 59) }),
    ).toEqual({ status: "upcoming", nextDueOn: "2026-11-08", step: 0 });
    expect(
      computeFollowupState({ ...base, now: at(2026, 11, 8, 0, 1) }),
    ).toEqual({ status: "due", nextDueOn: "2026-11-08", step: 0 });
  });

  it("formatea en calendario local", () => {
    expect(formatLocalDate(at(2026, 11, 8, 0, 1))).toBe("2026-11-08");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/server/services/followup-cadence.test.ts`
Expected: FAIL — `Failed to resolve import "./followup-cadence"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// orchestrator/src/server/services/followup-cadence.ts
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
    new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime() /
      1000,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/server/services/followup-cadence.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/server/services/followup-cadence.ts orchestrator/src/server/services/followup-cadence.test.ts
git commit -m "feat(followups): compute follow-up dates from stage and last contact"
```

---

### Task 2: Escritura de tareas (hoy sólo existe lectura)

**Files:**
- Modify: `orchestrator/src/server/services/applicationTracking.ts` (añadir dos funciones al final, junto a `getTasks`)
- Test: `orchestrator/src/server/services/applicationTracking.tasks.test.ts`

**Interfaces:**
- Consumes: `getTasks`, `tasksScopeFilter`, `getPrivateDataScope` (ya en el archivo).
- Produces:
  - `createApplicationTask(input: { applicationId: string; type: ApplicationTaskType; title: string; dueDate: number | null; notes?: string | null; isCompleted?: boolean }): Promise<ApplicationTask>`
  - `updateApplicationTask(input: { applicationId: string; taskId: string; isCompleted?: boolean; dueDate?: number | null; notes?: string | null }): Promise<ApplicationTask | null>`
  - `recordFollowupSent(applicationId: string, occurredAt: number): StageEvent` (usa `transitionStage` con `no_change`)

- [ ] **Step 1: Write the failing test**

```ts
// orchestrator/src/server/services/applicationTracking.tasks.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/server/services/applicationTracking.tasks.test.ts`
Expected: FAIL — `applicationTracking.createApplicationTask is not a function`.

- [ ] **Step 3: Write minimal implementation**

Añadir al final de `orchestrator/src/server/services/applicationTracking.ts`:

```ts
export async function createApplicationTask(input: {
  applicationId: string;
  type: ApplicationTaskType;
  title: string;
  dueDate: number | null;
  notes?: string | null;
  isCompleted?: boolean;
}): Promise<ApplicationTask> {
  const scope = getPrivateDataScope();
  const task: ApplicationTask = {
    id: randomUUID(),
    applicationId: input.applicationId,
    type: input.type,
    title: input.title,
    dueDate: input.dueDate,
    isCompleted: input.isCompleted ?? false,
    notes: input.notes ?? null,
  };

  await db.insert(tasks).values({
    id: task.id,
    tenantId: scope.tenantId,
    userId: scope.userId,
    applicationId: task.applicationId,
    type: task.type,
    title: task.title,
    dueDate: task.dueDate,
    isCompleted: task.isCompleted,
    notes: task.notes,
  });

  return task;
}

export async function updateApplicationTask(input: {
  applicationId: string;
  taskId: string;
  isCompleted?: boolean;
  dueDate?: number | null;
  notes?: string | null;
}): Promise<ApplicationTask | null> {
  const existing = await db
    .select()
    .from(tasks)
    .where(
      and(tasksScopeFilter(), eq(tasks.id, input.taskId), eq(tasks.applicationId, input.applicationId)),
    )
    .get();

  if (!existing) return null;

  const next = {
    isCompleted: input.isCompleted ?? existing.isCompleted ?? false,
    dueDate: input.dueDate === undefined ? existing.dueDate : input.dueDate,
    notes: input.notes === undefined ? existing.notes : input.notes,
  };

  await db
    .update(tasks)
    .set(next)
    .where(and(tasksScopeFilter(), eq(tasks.id, input.taskId)));

  return {
    id: existing.id,
    applicationId: existing.applicationId,
    type: existing.type as ApplicationTaskType,
    title: existing.title,
    dueDate: next.dueDate,
    isCompleted: next.isCompleted,
    notes: next.notes,
  };
}

export function recordFollowupSent(
  applicationId: string,
  occurredAt: number,
): StageEvent {
  return transitionStage(applicationId, "no_change", occurredAt, {
    eventType: "note",
    eventLabel: "Follow-up enviado",
    actor: "user",
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/server/services/applicationTracking.tasks.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/server/services/applicationTracking.ts orchestrator/src/server/services/applicationTracking.tasks.test.ts
git commit -m "feat(tasks): add create, complete and follow-up note writes"
```

---

### Task 3: Endpoints de tareas

**Files:**
- Modify: `orchestrator/src/server/api/routes/jobs/stages.ts`
- Test: `orchestrator/src/server/api/routes/jobs.tasks.test.ts`

**Interfaces:**
- Consumes: `createApplicationTask`, `updateApplicationTask`, `transitionStage` (Task 2), `jobsRepo.getJobById`.
- Produces: `POST /api/jobs/:id/tasks` → `201 ApplicationTask`; `PATCH /api/jobs/:id/tasks/:taskId` → `200 ApplicationTask`; `POST /api/jobs/:id/events` → `201 StageEvent` (sólo notas).

- [ ] **Step 1: Write the failing test**

```ts
// orchestrator/src/server/api/routes/jobs.tasks.test.ts
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

  it("returns 422 for an invalid task body", async () => {
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
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("UNPROCESSABLE_ENTITY");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/server/api/routes/jobs.tasks.test.ts`
Expected: FAIL — 404 en el POST (la ruta no existe).

- [ ] **Step 3: Write minimal implementation**

En `orchestrator/src/server/api/routes/jobs/stages.ts`:

1. Ampliar el import de `applicationTracking`:

```ts
import {
  createApplicationTask,
  deleteStageEvent,
  getStageEvents,
  getTasks,
  transitionStage,
  updateApplicationTask,
  updateStageEvent,
} from "@server/services/applicationTracking";
import { APPLICATION_TASK_TYPES } from "@shared/types";
```

2. Añadir los schemas junto a los que ya existen al final del archivo:

```ts
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
```

3. Añadir los handlers después del `GET /:id/tasks`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/server/api/routes/jobs.tasks.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/server/api/routes/jobs/stages.ts orchestrator/src/server/api/routes/jobs.tasks.test.ts
git commit -m "feat(api): expose job task creation and completion"
```

---

### Task 4: `GET /api/follow-ups`

**Files:**
- Create: `orchestrator/src/server/services/followup-service.ts`
- Create: `orchestrator/src/server/api/routes/follow-ups.ts`
- Modify: `orchestrator/src/server/api/routes.ts` (montar el router)
- Modify: `shared/src/types/jobs.ts` (tipos `FollowupItem`, `FollowupsResponse`)
- Test: `orchestrator/src/server/api/routes/follow-ups.test.ts`

**Interfaces:**
- Consumes: `computeFollowupState`, `createApplicationTask`, `updateApplicationTask`, `recordFollowupSent`.
- Produces: `listFollowups(now: number): Promise<FollowupsResponse>`; `GET /api/follow-ups`.

- [ ] **Step 1: Write the failing test**

```ts
// orchestrator/src/server/api/routes/follow-ups.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/server/api/routes/follow-ups.test.ts`
Expected: FAIL — 404, la ruta no existe.

- [ ] **Step 3: Write minimal implementation**

`shared/src/types/jobs.ts`, al final:

```ts
export type FollowupItem = {
  jobId: string;
  employer: string;
  title: string;
  jobUrl: string;
  stage: ApplicationStage;
  appliedAt: string;
  nextDueOn: string;
  status: "due" | "upcoming";
  step: number;
};

export type FollowupsResponse = {
  due: FollowupItem[];
  upcoming: FollowupItem[];
};
```

`orchestrator/src/server/services/followup-service.ts`:

```ts
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
      .select({ occurredAt: stageEvents.occurredAt, toStage: stageEvents.toStage })
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

    const stage = (lastEvent?.toStage as ApplicationStage | undefined) ?? "applied";
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
```

`orchestrator/src/server/api/routes/follow-ups.ts`:

```ts
import { toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { listFollowups } from "@server/services/followup-service";
import { type Request, type Response, Router } from "express";

export const followUpsRouter = Router();

followUpsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    ok(res, await listFollowups(Math.floor(Date.now() / 1000)));
  } catch (error) {
    fail(res, toAppError(error));
  }
});
```

`orchestrator/src/server/api/routes.ts`:

```ts
import { followUpsRouter } from "./routes/follow-ups";
// ...
apiRouter.use("/follow-ups", followUpsRouter);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/server/api/routes/follow-ups.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Añadir el caso de aislamiento entre tenants**

En `orchestrator/src/server/api/routes/tenant-isolation.test.ts`, dentro del `describe.sequential`
existente (que ya aplica `AUTH_ENV` y expone `signup`, `importManualJob` y `authHeaders`):

```ts
  it("does not list another tenant's follow-ups", async () => {
    const tokenA = await signup(baseUrl, "tenant-fu-a", "password-fu-a");
    const tokenB = await signup(baseUrl, "tenant-fu-b", "password-fu-b");
    const job = await importManualJob(baseUrl, tokenA, "Follow-up isolation role");

    const applyRes = await fetch(`${baseUrl}/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: authHeaders(tokenA),
      body: JSON.stringify({
        status: "applied",
        appliedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      }),
    });
    expect(applyRes.status).toBe(200);

    const ownRes = await fetch(`${baseUrl}/api/follow-ups`, {
      headers: authHeaders(tokenA),
    });
    const ownBody = await ownRes.json();
    expect(ownBody.data.due).toHaveLength(1);

    const otherRes = await fetch(`${baseUrl}/api/follow-ups`, {
      headers: authHeaders(tokenB),
    });
    const otherBody = await otherRes.json();
    expect(otherBody.data.due).toHaveLength(0);
    expect(otherBody.data.upcoming).toHaveLength(0);
  });
```

Run: `npm --workspace orchestrator run test:run -- src/server/api/routes/tenant-isolation.test.ts`
Expected: PASS, incluido el caso nuevo.

- [ ] **Step 6: Commit**

```bash
git add shared/src/types/jobs.ts orchestrator/src/server/services/followup-service.ts orchestrator/src/server/api/routes/follow-ups.ts orchestrator/src/server/api/routes.ts orchestrator/src/server/api/routes/follow-ups.test.ts
git commit -m "feat(followups): add follow-ups endpoint scoped by tenant"
```

---

### Task 5: Página de follow-ups

**Files:**
- Modify: `orchestrator/src/client/api/jobs.ts` (tres funciones nuevas)
- Modify: `orchestrator/src/client/lib/queryKeys.ts` (`followups`)
- Create: `orchestrator/src/client/pages/FollowupsPage.tsx`
- Modify: `orchestrator/src/client/App.tsx` (ruta `/follow-ups`)
- Modify: `orchestrator/src/client/navigation.ts` (entrada de menú)
- Test: `orchestrator/src/client/pages/FollowupsPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/follow-ups`, `POST /api/jobs/:id/tasks`, `PATCH /api/jobs/:id/tasks/:taskId`.
- Produces: `fetchFollowups()`, `createJobTask(jobId, input)`, `updateJobTask(jobId, taskId, input)`, `<FollowupsPage />`.

- [ ] **Step 1: Write the failing test**

```tsx
// orchestrator/src/client/pages/FollowupsPage.test.tsx
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { renderWithQueryClient } from "../test/renderWithQueryClient";
import { FollowupsPage } from "./FollowupsPage";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, fetchFollowups: vi.fn(), createJobTask: vi.fn() };
});

describe("FollowupsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows due applications with a concrete date", async () => {
    vi.mocked(api.fetchFollowups).mockResolvedValue({
      due: [
        {
          jobId: "job-1",
          employer: "Acme",
          title: "Backend Engineer",
          jobUrl: "https://example.com/job/1",
          stage: "applied",
          appliedAt: "2026-11-01T09:00:00.000Z",
          nextDueOn: "2026-11-08",
          status: "due",
          step: 0,
        },
      ],
      upcoming: [],
    });

    renderWithQueryClient(<FollowupsPage />);

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("2026-11-08")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark as sent/i })).toBeEnabled();
  });

  it("shows an empty state when nothing is due", async () => {
    vi.mocked(api.fetchFollowups).mockResolvedValue({ due: [], upcoming: [] });

    renderWithQueryClient(<FollowupsPage />);

    await waitFor(() => {
      expect(screen.getByText(/no follow-ups yet/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/client/pages/FollowupsPage.test.tsx`
Expected: FAIL — no existe `./FollowupsPage`.

- [ ] **Step 3: Write minimal implementation**

`orchestrator/src/client/api/jobs.ts` (junto a `fetchJobTasks`):

```ts
export async function fetchFollowups(): Promise<FollowupsResponse> {
  return fetchApi<FollowupsResponse>("/follow-ups");
}

export async function createJobTask(
  jobId: string,
  input: {
    type: ApplicationTaskType;
    title: string;
    dueDate: number | null;
    notes?: string | null;
  },
): Promise<ApplicationTask> {
  return fetchApi<ApplicationTask>(`/jobs/${jobId}/tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateJobTask(
  jobId: string,
  taskId: string,
  input: { isCompleted?: boolean; dueDate?: number | null; notes?: string | null },
): Promise<ApplicationTask> {
  return fetchApi<ApplicationTask>(`/jobs/${jobId}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
```

Añadir a los imports de tipos del mismo archivo: `ApplicationTaskType`, `FollowupsResponse`.

`orchestrator/src/client/lib/queryKeys.ts`, dentro de `jobs`:

```ts
followups: () => [...queryKeys.jobs.all, "followups"] as const,
```

`orchestrator/src/client/pages/FollowupsPage.tsx`:

```tsx
import type { FollowupItem } from "@shared/types.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import * as api from "../api";
import { queryKeys } from "../lib/queryKeys";
import { showErrorToast } from "../lib/error-toast";

const toEpochSeconds = (date: string): number =>
  Math.floor(new Date(`${date}T09:00:00`).getTime() / 1000);

const FollowupRow: React.FC<{ item: FollowupItem }> = ({ item }) => {
  const queryClient = useQueryClient();

  const send = useMutation({
    mutationFn: async () => {
      const task = await api.createJobTask(item.jobId, {
        type: "follow_up",
        title: `Follow-up — ${item.employer}`,
        dueDate: toEpochSeconds(item.nextDueOn),
      });
      await api.updateJobTask(item.jobId, task.id, { isCompleted: true });
      await api.recordFollowupSent(item.jobId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.jobs.followups(),
      });
    },
    onError: showErrorToast,
  });

  return (
    <li className="flex items-center justify-between rounded-lg border border-border/50 p-3">
      <div>
        <div className="text-sm font-medium">{item.employer}</div>
        <div className="text-xs text-muted-foreground">{item.title}</div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs tabular-nums">{item.nextDueOn}</span>
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-xs"
          disabled={send.isPending}
          onClick={() => send.mutate()}
        >
          Mark as sent
        </button>
      </div>
    </li>
  );
};

export const FollowupsPage: React.FC = () => {
  const query = useQuery({
    queryKey: queryKeys.jobs.followups(),
    queryFn: api.fetchFollowups,
  });

  if (query.isLoading) return <div className="p-6">Loading…</div>;
  if (query.error) return <div className="p-6">Could not load follow-ups.</div>;

  const due = query.data?.due ?? [];
  const upcoming = query.data?.upcoming ?? [];

  if (due.length === 0 && upcoming.length === 0) {
    return <div className="p-6">No follow-ups yet.</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        <CalendarClock className="h-5 w-5" /> Follow-ups
      </h1>
      <section>
        <h2 className="mb-2 text-sm font-semibold">Due</h2>
        <ul className="space-y-2">
          {due.map((item) => (
            <FollowupRow key={item.jobId} item={item} />
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold">Upcoming</h2>
        <ul className="space-y-2">
          {upcoming.map((item) => (
            <FollowupRow key={item.jobId} item={item} />
          ))}
        </ul>
      </section>
    </div>
  );
};
```

Añadir también `recordFollowupSent` al cliente, junto a las anteriores:

```ts
export async function recordFollowupSent(jobId: string): Promise<StageEvent> {
  return fetchApi<StageEvent>(`/jobs/${jobId}/events`, {
    method: "POST",
    body: JSON.stringify({ eventType: "note", eventLabel: "Follow-up enviado" }),
  });
}
```

El endpoint `POST /api/jobs/:id/events` ya se implementó en la Task 3; sin él, `recordFollowupSent`
declararía una llamada a una ruta inexistente.

`orchestrator/src/client/App.tsx`, junto a `/tracking-inbox`:

```tsx
<Route path="/follow-ups" element={<FollowupsPage />} />
```

`orchestrator/src/client/navigation.ts`: añadir la entrada `{ to: "/follow-ups", label: "Follow-ups" }` siguiendo la forma exacta de las entradas existentes del archivo.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/client/pages/FollowupsPage.test.tsx`
Expected: PASS — 2 tests.

- [ ] **Step 5: Run the type check**

Run: `npm --workspace orchestrator run check:types`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/client/api/jobs.ts orchestrator/src/client/lib/queryKeys.ts orchestrator/src/client/pages/FollowupsPage.tsx orchestrator/src/client/pages/FollowupsPage.test.tsx orchestrator/src/client/App.tsx orchestrator/src/client/navigation.ts orchestrator/src/server/api/routes/jobs/stages.ts
git commit -m "feat(followups): add follow-ups page with schedule and mark-sent actions"
```

---

### Task 6: Documentación

**Files:**
- Create: `docs-site/docs/features/follow-ups.md`
- Modify: `docs-site/docs/features/overview.md` (enlace)

**Interfaces:**
- Consumes: nada.
- Produces: página publicada en el docs-site.

- [ ] **Step 1: Escribir la página**

```markdown
---
id: follow-ups
title: Follow-ups
description: Know which applications need a follow-up and when, using a fixed cadence instead of memory.
sidebar_position: 12
---

## What it is

A list of your open applications with the date of your next follow-up. Overdue ones come first.

## Why it exists

Applying is the easy part; remembering to chase is what gets dropped. The cadence is fixed, so you do not have to decide when to write.

| Stage | First follow-up | Then every |
|---|---|---|
| Applied | 7 days | 7 days |
| Recruiter screen, assessment, team match | 1 day | 3 days |
| Interview, final round, offer | 1 day (thank-you) | 3 days |

There is no maximum: the cadence continues while the application stays open, and stops when you close it or record an outcome.

## How to use it

1. Apply to a job in job-ops so it moves to `applied`.
2. Open **Follow-ups**. Each row shows the company, the role and the date it is due.
3. Press **Mark as sent** after you write. This records the follow-up and schedules the next one.

Dates are calendar dates, not "in two days": a follow-up due on 8 November says `2026-11-08` all day.

## Common problems

- **An application does not appear.** Only `applied` and `in_progress` jobs are listed, and only once they have an application date.
- **The date is in the past.** The last contact was long ago; send the follow-up or record an outcome.
- **I sent it outside job-ops.** Use **Mark as sent** anyway, so the cadence advances. job-ops does not read your email and will not detect it.

## Related pages

- [/docs/features/post-application-tracking](/docs/features/post-application-tracking)
- [/docs/features/in-progress-board](/docs/features/in-progress-board)
- [/docs/features/evaluation-report](/docs/features/evaluation-report)
```

- [ ] **Step 2: Enlazar desde el índice**

En `docs-site/docs/features/overview.md`, añadir en la lista de features:

```markdown
- [Follow-ups](/docs/features/follow-ups) — the date of your next follow-up for every open application.
```

- [ ] **Step 3: Build del docs-site**

Run: `npm --prefix docs-site run build`
Expected: build correcto, sin enlaces roto.

- [ ] **Step 4: Commit**

```bash
git add docs-site/docs/features/follow-ups.md docs-site/docs/features/overview.md
git commit -m "docs(followups): document the cadence and its limits"
```

---

## Verificación final

```bash
./orchestrator/node_modules/.bin/biome ci .
npm run check:types:shared
npm --workspace orchestrator run check:types
npm --workspace orchestrator run build:client
npm --workspace orchestrator run test:run
```

Si `test:run` falla por ABI de `better-sqlite3`: `npm --workspace orchestrator rebuild better-sqlite3`.
