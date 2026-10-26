# Informe de evaluación — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que un usuario no técnico genere, desde la ficha de un job, un informe legible que explique por qué encaja o no, sin inventar datos que el sistema no tiene.

**Architecture:** cinco columnas nuevas en `jobs`, un tipo `JobDetail` que las expone sólo en el detalle, un servicio que hace una llamada al LLM con salida estructurada y compone el markdown con datos verificables de la fila, y un endpoint `POST` con compare-and-set y lock de 5 minutos. La UI es una vista más del `JobPage`, junto a Overview, Notes o Ghostwriter.

**Tech Stack:** TypeScript, Express, Drizzle ORM sobre SQLite, Zod, `LlmService` (`callJson` con JSON Schema), React, Vitest.

## Global Constraints

- Todas las rutas `/api/*` devuelven `{ ok: true, data, meta: { requestId } }` o `{ ok: false, error: { code, message, details? }, meta: { requestId } }` (`AGENTS.md`).
- Códigos: 404 `NOT_FOUND`, 409 `CONFLICT`, 422 `UNPROCESSABLE_ENTITY`, 502 `UPSTREAM_ERROR`, 503 `SERVICE_UNAVAILABLE` (`infra/errors.ts:3-25`).
- El LLM nunca recibe el CV completo ni el historial: sólo `jobDescription` y lo que dejan `sanitizeProfileForPrompt` / `filterProfileProjectsForAi`.
- Nunca se loguea el prompt, el CV ni el informe: sólo `{ requestId, jobId, route, status, model, durationMs, outcome }`.
- Fechas ISO en texto; `updated_at` es el reloj del lock y se compara lexicográficamente.
- `HOSTED_USAGE_ACTIONS` no tiene acción de evaluación: se usa `action: "tailoring"` y el propósito LLM `"scoring"`, que ya existen. Añadir una acción propia cambia límites y tests de facturación, fuera de esta spec.
- Sin detección de obsolescencia por fingerprint (decisión 8 del spec): sólo se muestra la fecha de generación.
- Verificación final: `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.

---

### Task 1: Esquema, migración y `JobDetail`

**Files:**
- Modify: `orchestrator/src/server/db/schema.ts` (tabla `jobs`, a partir de la línea 197)
- Modify: `orchestrator/src/server/db/migrate.ts` (junto al bloque de `pdf_regenerating`, línea ~840)
- Modify: `shared/src/types/jobs.ts` (tipos nuevos y `UpdateJobInput`)
- Modify: `orchestrator/src/server/repositories/jobs.ts` (`mapRowToJobDetail`, `getJobById`)
- Test: `orchestrator/src/server/repositories/job-detail.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `EvaluationReportMeta`, `JobDetail`, `mapRowToJobDetail(row)`, `getJobById(id): Promise<JobDetail | null>`.

- [x] **Step 1: Write the failing test**

```ts
// orchestrator/src/server/repositories/job-detail.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("job detail", () => {
  let tempDir: string;
  let jobsRepo: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-detail-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    jobsRepo = await import("./jobs");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns the evaluation fields with safe defaults", async () => {
    const created = await jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/detail",
    });

    const job = await jobsRepo.getJobById(created.id);

    expect(job.evaluationReport).toBeNull();
    expect(job.evaluationReportGeneratedAt).toBeNull();
    expect(job.evaluationReportModel).toBeNull();
    expect(job.evaluationReportMeta).toBeNull();
    expect(job.evaluationReportGenerating).toBe(false);
  });

  it("round-trips the report meta as JSON", async () => {
    const created = await jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/job/detail-2",
    });

    await jobsRepo.updateJob(created.id, {
      evaluationReport: "# Informe",
      evaluationReportGeneratedAt: "2026-10-26T10:00:00.000Z",
      evaluationReportModel: "test-model",
      evaluationReportMeta: JSON.stringify({
        verdict: "apply",
        basis: "full_jd",
        confidence: 0.8,
      }),
    });

    const job = await jobsRepo.getJobById(created.id);
    expect(job.evaluationReportMeta).toEqual({
      verdict: "apply",
      basis: "full_jd",
      confidence: 0.8,
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/server/repositories/job-detail.test.ts`
Expected: FAIL — `job.evaluationReport` es `undefined`.

- [x] **Step 3: Write minimal implementation**

`orchestrator/src/server/db/schema.ts`, dentro de `jobs`:

```ts
    evaluationReport: text("evaluation_report"),
    evaluationReportGeneratedAt: text("evaluation_report_generated_at"),
    evaluationReportModel: text("evaluation_report_model"),
    evaluationReportMeta: text("evaluation_report_meta"),
    evaluationReportGenerating: integer("evaluation_report_generating", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
```

`orchestrator/src/server/db/migrate.ts`, junto al bloque de `pdf_regenerating`:

```ts
if (!tableHasColumn("jobs", "evaluation_report")) {
  sqlite.exec("ALTER TABLE jobs ADD COLUMN evaluation_report TEXT");
}
if (!tableHasColumn("jobs", "evaluation_report_generated_at")) {
  sqlite.exec("ALTER TABLE jobs ADD COLUMN evaluation_report_generated_at TEXT");
}
if (!tableHasColumn("jobs", "evaluation_report_model")) {
  sqlite.exec("ALTER TABLE jobs ADD COLUMN evaluation_report_model TEXT");
}
if (!tableHasColumn("jobs", "evaluation_report_meta")) {
  sqlite.exec("ALTER TABLE jobs ADD COLUMN evaluation_report_meta TEXT");
}
if (!tableHasColumn("jobs", "evaluation_report_generating")) {
  sqlite.exec(
    "ALTER TABLE jobs ADD COLUMN evaluation_report_generating INTEGER NOT NULL DEFAULT 0",
  );
}
```

`shared/src/types/jobs.ts`:

```ts
export interface EvaluationReportMeta {
  basis: "full_jd" | "partial_jd" | "minimal_jd";
  confidence: number; // 0-1
  verdict: "apply" | "consider" | "skip";
}

export interface JobDetail extends Job {
  evaluationReport: string | null;
  evaluationReportGeneratedAt: string | null;
  evaluationReportModel: string | null;
  evaluationReportMeta: EvaluationReportMeta | null;
  evaluationReportGenerating: boolean;
}
```

Y en `UpdateJobInput` (implementado: el meta se persiste como JSON string):

```ts
  evaluationReport?: string | null;
  evaluationReportGeneratedAt?: string | null;
  evaluationReportModel?: string | null;
  evaluationReportMeta?: string | null;
  evaluationReportGenerating?: boolean;
```

`orchestrator/src/server/repositories/jobs.ts`:

```ts
function parseEvaluationReportMeta(
  raw: string | null,
): JobDetail["evaluationReportMeta"] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const meta = parsed as Record<string, unknown>;
    if (
      (meta.verdict !== "apply" && meta.verdict !== "consider" && meta.verdict !== "skip") ||
      (meta.basis !== "full_jd" && meta.basis !== "partial_jd" && meta.basis !== "minimal_jd") ||
      typeof meta.confidence !== "number"
    ) {
      return null;
    }
    return {
      verdict: meta.verdict,
      basis: meta.basis,
      confidence: meta.confidence,
    };
  } catch {
    return null;
  }
}

export function mapRowToJobDetail(row: typeof jobs.$inferSelect): JobDetail {
  return {
    ...mapRowToJob(row),
    evaluationReport: row.evaluationReport ?? null,
    evaluationReportGeneratedAt: row.evaluationReportGeneratedAt ?? null,
    evaluationReportModel: row.evaluationReportModel ?? null,
    evaluationReportMeta: parseEvaluationReportMeta(row.evaluationReportMeta),
    evaluationReportGenerating: row.evaluationReportGenerating ?? false,
  };
}
```

Y cambiar `getJobById` para devolver `JobDetail | null` usando `mapRowToJobDetail(row)`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/server/repositories/job-detail.test.ts`
Expected: PASS — 2 tests.

- [x] **Step 5: Run the type check**

Run: `npm --workspace orchestrator run check:types`
Expected: sin errores. Si algún consumidor de `getJobById` se queja, es porque asumía `Job`; `JobDetail extends Job`, así que sólo fallará si construye el tipo a mano.

- [x] **Step 6: Commit**

```bash
git add orchestrator/src/server/db/schema.ts orchestrator/src/server/db/migrate.ts shared/src/types/jobs.ts orchestrator/src/server/repositories/jobs.ts orchestrator/src/server/repositories/job-detail.test.ts
git commit -m "feat(jobs): store evaluation report fields on JobDetail"
```

---

### Task 2: Plantilla de prompt y servicio de informe

**Files:**
- Modify: `shared/src/prompt-template-definitions.ts` (nueva plantilla)
- Modify: `orchestrator/src/server/services/scorer.ts` (exportar `sanitizeProfileForPrompt`)
- Create: `orchestrator/src/server/services/evaluation-report.ts`
- Test: `orchestrator/src/server/services/evaluation-report.test.ts`

**Interfaces:**
- Consumes: `getEffectivePromptTemplate`, `renderPromptTemplate`, `getWritingStyle`, `resolveWritingOutputLanguage`, `getWritingLanguageLabel`, `createConfiguredLlmService`, `resolveLlmModel`, `withHostedUsageReservation`, `filterProfileProjectsForAi`, `sanitizeProfileForPrompt`.
- Produces:
  - `generateEvaluationReport(input: { job: Job; profile: Record<string, unknown> }): Promise<{ markdown: string; model: string; meta: Omit<EvaluationReportMeta, "generatedAt" | "model"> }>`
  - `renderEvaluationMarkdown(input: { job: Job; result: EvaluationReportResult }): string`
  - `EvaluationReportNotApplicableError`

- [ ] **Step 1: Write the failing test**

```ts
// orchestrator/src/server/services/evaluation-report.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvaluationReportNotApplicableError,
  generateEvaluationReport,
  renderEvaluationMarkdown,
} from "./evaluation-report";

const callJson = vi.fn();

vi.mock("./modelSelection", () => ({
  resolveLlmModel: vi.fn(async () => "test-model"),
  createConfiguredLlmService: vi.fn(async () => ({ callJson })),
}));

vi.mock("./hosted-usage", () => ({
  withHostedUsageReservation: async (
    _args: unknown,
    work: () => Promise<{ result: unknown; usedUnits: number }>,
  ) => (await work()).result,
}));

const baseJob = {
  id: "job-1",
  title: "Backend Engineer",
  employer: "Acme",
  salary: null,
  employerUrl: "https://acme.com",
  deadline: null,
  jobDescription: "x".repeat(1600),
} as any;

const llmResult = {
  verdict: "apply",
  summary: "Strong backend fit.",
  scoreBreakdown: {
    match: 4,
    northStar: 4,
    comp: null,
    culture: 3,
    redFlags: 2,
  },
  evidence: [
    {
      requirement: "TypeScript",
      cvMatch: "strong",
      evidence: "6 years of TypeScript",
    },
  ],
  gaps: ["No Kubernetes"],
  basis: "minimal_jd",
  confidence: 0.9,
};

beforeEach(() => {
  callJson.mockReset();
  callJson.mockResolvedValue({ success: true, data: llmResult });
});

describe("generateEvaluationReport", () => {
  it("degrades the basis when the description is short", async () => {
    const { meta } = await generateEvaluationReport({
      job: { ...baseJob, jobDescription: "short" },
      profile: { basics: { name: "Diego" } },
    });
    expect(meta.basis).toBe("minimal_jd");
  });

  it("keeps full_jd when the description supports it", async () => {
    callJson.mockResolvedValue({
      success: true,
      data: { ...llmResult, basis: "full_jd" },
    });
    const { meta } = await generateEvaluationReport({
      job: baseJob,
      profile: {},
    });
    expect(meta.basis).toBe("full_jd");
  });

  it("clamps confidence into 0..1", async () => {
    callJson.mockResolvedValue({
      success: true,
      data: { ...llmResult, confidence: 3 },
    });
    const { meta } = await generateEvaluationReport({
      job: baseJob,
      profile: {},
    });
    expect(meta.confidence).toBe(1);
  });

  it("rejects a job without description", async () => {
    await expect(
      generateEvaluationReport({
        job: { ...baseJob, jobDescription: null },
        profile: {},
      }),
    ).rejects.toBeInstanceOf(EvaluationReportNotApplicableError);
  });
});

describe("renderEvaluationMarkdown", () => {
  it("writes the five sections and never invents compensation", () => {
    const markdown = renderEvaluationMarkdown({
      job: baseJob,
      result: llmResult as any,
    });

    expect(markdown).toContain("## Veredicto");
    expect(markdown).toContain("## Evidencia JD ↔ CV");
    expect(markdown).toContain("## Gaps");
    expect(markdown).toContain("## Compensación");
    expect(markdown).toContain("## Señales de la oferta");
    expect(markdown).toContain("No verificado");
    expect(markdown).not.toMatch(/\$\d/);
  });

  it("lists the salary when the posting has one", () => {
    const markdown = renderEvaluationMarkdown({
      job: { ...baseJob, salary: "USD 120k" },
      result: llmResult as any,
    });
    expect(markdown).toContain("USD 120k");
  });

  it("flags a posting with no employer url and a past deadline", () => {
    const markdown = renderEvaluationMarkdown({
      job: {
        ...baseJob,
        employerUrl: null,
        deadline: "2020-01-01",
      },
      result: llmResult as any,
    });
    expect(markdown).toContain("sin URL del empleador");
    expect(markdown).toContain("deadline vencido");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/server/services/evaluation-report.test.ts`
Expected: FAIL — no existe `./evaluation-report`.

- [ ] **Step 3: Write minimal implementation**

`shared/src/prompt-template-definitions.ts`, dentro de `PROMPT_TEMPLATE_DEFINITIONS`:

```ts
  evaluationReportPromptTemplate: {
    label: "Evaluation report prompt",
    description:
      "Controls the readable A-F evaluation written for a single job. The job data and the output contract are appended automatically.",
    placeholders: [
      "profileJson",
      "jobTitle",
      "employer",
      "jobDescription",
      "outputLanguage",
    ] as const,
    defaultTemplate: `
You are evaluating a job posting against a candidate's CV for that candidate.

JOB TITLE: {{jobTitle}}
EMPLOYER: {{employer}}
JOB DESCRIPTION:
{{jobDescription}}

CANDIDATE PROFILE:
{{profileJson}}

Write in {{outputLanguage}}.

Rules:
- Use only evidence present in the profile. If the CV does not support a requirement, mark it as a gap.
- Never estimate salary, funding, company size or legitimacy. Those come from the job record, not from you.
- "comp" in scoreBreakdown must be null when the job record has no salary.
- "basis" is full_jd when the description is complete, partial_jd when it is truncated, minimal_jd when it is a stub.
- "confidence" is 0..1 and expresses how much the posting supports your verdict.
- Respond with ONLY valid JSON matching the provided schema.
`.trim(),
  },
```

`orchestrator/src/server/services/evaluation-report.ts`:

```ts
import { logger } from "@infra/logger";
import type {
  EvaluationReportMeta,
  Job,
  ResumeProfile,
} from "@shared/types";
import { createConfiguredLlmService, resolveLlmModel } from "./modelSelection";
import { withHostedUsageReservation } from "./hosted-usage";
import {
  getEffectivePromptTemplate,
  renderPromptTemplate,
} from "./prompt-templates";
import { filterProfileProjectsForAi } from "./resumeProjects";
import { sanitizeProfileForPrompt } from "./scorer";
import {
  getWritingLanguageLabel,
  resolveWritingOutputLanguage,
} from "./output-language";
import { getWritingStyle } from "./writing-style";

export class EvaluationReportNotApplicableError extends Error {
  constructor(message = "This job has no description to evaluate") {
    super(message);
  }
}

export type EvaluationReportResult = {
  verdict: "apply" | "consider" | "skip";
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
  basis: "full_jd" | "partial_jd" | "minimal_jd";
  confidence: number;
};

const EVALUATION_SCHEMA = {
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
} as const;

const BASIS_ORDER = ["minimal_jd", "partial_jd", "full_jd"] as const;

function basisFromDescription(description: string): EvaluationReportResult["basis"] {
  if (description.length >= 1500) return "full_jd";
  if (description.length >= 400) return "partial_jd";
  return "minimal_jd";
}

function weakerBasis(
  a: EvaluationReportResult["basis"],
  b: EvaluationReportResult["basis"],
): EvaluationReportResult["basis"] {
  return BASIS_ORDER.indexOf(a) <= BASIS_ORDER.indexOf(b) ? a : b;
}

export function renderEvaluationMarkdown(input: {
  job: Job;
  result: EvaluationReportResult;
}): string {
  const { job, result } = input;
  const lines: string[] = [];

  lines.push("## Veredicto", "", `**${result.verdict}** — ${result.summary}`, "");
  lines.push(
    `Match ${result.scoreBreakdown.match}/5 · North Star ${result.scoreBreakdown.northStar}/5 · Comp ${
      result.scoreBreakdown.comp === null ? "—" : `${result.scoreBreakdown.comp}/5`
    } · Culture ${result.scoreBreakdown.culture}/5 · Red flags ${result.scoreBreakdown.redFlags}/5`,
    "",
  );

  lines.push("## Evidencia JD ↔ CV", "");
  if (result.evidence.length === 0) {
    lines.push("El modelo no devolvió evidencia.", "");
  } else {
    lines.push("| Requisito | Match | Evidencia |", "|---|---|---|");
    for (const row of result.evidence) {
      lines.push(`| ${row.requirement} | ${row.cvMatch} | ${row.evidence} |`);
    }
    lines.push("");
  }

  lines.push("## Gaps", "");
  if (result.gaps.length === 0) lines.push("Sin gaps declarados.", "");
  else lines.push(...result.gaps.map((gap) => `- ${gap}`), "");

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
  if ((job.jobDescription?.length ?? 0) < 400) {
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
  meta: Omit<EvaluationReportMeta, "generatedAt" | "model">;
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
      idempotencyKey: `${input.job.id}:${model}`,
    },
    async () => {
      const llm = await createConfiguredLlmService("scoring");
      const result = await llm.callJson<EvaluationReportResult>({
        model,
        messages: [{ role: "user", content: prompt }],
        jsonSchema: EVALUATION_SCHEMA,
        maxRetries: 2,
        jobId: input.job.id,
      });

      if (!result.success) {
        logger.warn("Evaluation report failed", {
          jobId: input.job.id,
          error: result.error,
        });
        throw new Error(`Evaluation report failed: ${result.error}`);
      }

      const data = result.data;
      const meta = {
        verdict: data.verdict,
        basis: weakerBasis(data.basis, basisFromDescription(description)),
        confidence: Math.min(1, Math.max(0, data.confidence)),
      };

      return {
        result: {
          markdown: renderEvaluationMarkdown({ job: input.job, result: data }),
          model,
          meta,
        },
        usedUnits: 1,
      };
    },
  );
}
```

En `orchestrator/src/server/services/scorer.ts`, cambiar la declaración de la función privada (línea ~545) para que sea importable:

```ts
export function sanitizeProfileForPrompt(profile: Record<string, unknown>) {
  // sin cambios en el cuerpo
}
```

Es la única forma de reutilizarla sin duplicar la lógica de saneado ni refactorizar `scorer.ts` en esta spec.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/server/services/evaluation-report.test.ts`
Expected: PASS — 8 tests. El mock de `./modelSelection` y `./hosted-usage` evita cualquier llamada real.

Además, añadir al final del mismo archivo de test un caso que verifique que el prompt no incluye el perfil crudo:

```ts
it("sends only the sanitized profile to the model", async () => {
  await generateEvaluationReport({
    job: baseJob,
    profile: { basics: { name: "Diego", email: "diego@example.com" } },
  });
  const call = callJson.mock.calls[0][0];
  expect(call.messages[0].content).not.toContain("diego@example.com");
});
```

La aserción es estable: `sanitizeBasics` sólo conserva `label`, `headline`, `summary` y `location` (`scorer.ts:630-633`), así que el email nunca llega al prompt. No relajar la aserción si falla: si falla, el saneado cambió y hay que mirarlo.

- [ ] **Step 5: Run the settings component test (la plantilla nueva se renderiza sola)**

Run: `npm --workspace orchestrator run test:run -- src/client/pages/settings/components/PromptTemplatesSection.test.tsx`
Expected: PASS. Si falla porque el test enumera una lista fija de plantillas, actualizar esa lista para incluir `evaluationReportPromptTemplate`.

- [ ] **Step 6: Commit**

```bash
git add shared/src/prompt-template-definitions.ts orchestrator/src/server/services/evaluation-report.ts orchestrator/src/server/services/evaluation-report.test.ts
git commit -m "feat(evaluation): generate a readable report from job and profile"
```

---

### Task 3: Compare-and-set y lock de 5 minutos

**Files:**
- Modify: `orchestrator/src/server/repositories/jobs.ts` (nueva función junto a `updateJob`)
- Test: `orchestrator/src/server/repositories/evaluation-lock.test.ts`

**Interfaces:**
- Consumes: `jobsScopeFilter` (ya en el archivo).
- Produces: `beginEvaluationIfIdle(id: string, options: { staleAfterSeconds: number; now?: number }): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```ts
// orchestrator/src/server/repositories/evaluation-lock.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("evaluation lock", () => {
  let tempDir: string;
  let jobsRepo: any;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-lock-test-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    jobsRepo = await import("./jobs");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const makeJob = () =>
    jobsRepo.createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: `https://example.com/job/${Math.random()}`,
    });

  it("grants the lock once", async () => {
    const job = await makeJob();
    expect(await jobsRepo.beginEvaluationIfIdle(job.id, { staleAfterSeconds: 300 })).toBe(
      true,
    );
    expect(await jobsRepo.beginEvaluationIfIdle(job.id, { staleAfterSeconds: 300 })).toBe(
      false,
    );
  });

  it("hands over a lock older than the window", async () => {
    const job = await makeJob();
    await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
      now: Math.floor(Date.now() / 1000) - 3600,
    });

    const takenOver = await jobsRepo.beginEvaluationIfIdle(job.id, {
      staleAfterSeconds: 300,
    });
    expect(takenOver).toBe(true);
  });

  it("never grants two concurrent requests", async () => {
    const job = await makeJob();
    const results = await Promise.all([
      jobsRepo.beginEvaluationIfIdle(job.id, { staleAfterSeconds: 300 }),
      jobsRepo.beginEvaluationIfIdle(job.id, { staleAfterSeconds: 300 }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/server/repositories/evaluation-lock.test.ts`
Expected: FAIL — `beginEvaluationIfIdle is not a function`.

- [ ] **Step 3: Write minimal implementation**

En `orchestrator/src/server/repositories/jobs.ts`, junto a `updateJob`:

```ts
export async function beginEvaluationIfIdle(
  id: string,
  options: { staleAfterSeconds: number; now?: number },
): Promise<boolean> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const nowIso = new Date(now * 1000).toISOString();
  const cutoffIso = new Date((now - options.staleAfterSeconds) * 1000).toISOString();

  const result = db
    .update(jobs)
    .set({ evaluationReportGenerating: true, updatedAt: nowIso })
    .where(
      and(
        jobsScopeFilter(),
        eq(jobs.id, id),
        or(
          eq(jobs.evaluationReportGenerating, false),
          lt(jobs.updatedAt, cutoffIso),
        ),
      ),
    )
    .run();

  return (result.changes ?? 0) === 1;
}
```

Añadir `lt` y `or` a los imports de `drizzle-orm` del archivo.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/server/repositories/evaluation-lock.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/server/repositories/jobs.ts orchestrator/src/server/repositories/evaluation-lock.test.ts
git commit -m "feat(evaluation): guard report generation with a compare-and-set lock"
```

---

### Task 4: `POST /api/jobs/:id/evaluation`

**Files:**
- Create: `orchestrator/src/server/api/routes/jobs/evaluation.ts`
- Modify: `orchestrator/src/server/api/routes/jobs/index.ts` (montar el router)
- Test: `orchestrator/src/server/api/routes/jobs.evaluation.test.ts`

**Interfaces:**
- Consumes: `beginEvaluationIfIdle` (Task 3), `generateEvaluationReport` (Task 2), `getJobById`, `updateJob`, `getProfile`.
- Produces: `POST /api/jobs/:id/evaluation` → `202 { jobId, status: "generating" }`.

- [ ] **Step 1: Write the failing test**

```ts
// orchestrator/src/server/api/routes/jobs.evaluation.test.ts
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

const generateEvaluationReport = vi.fn();

vi.mock("@server/services/evaluation-report", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@server/services/evaluation-report")
  >();
  return { ...actual, generateEvaluationReport };
});

vi.mock("@server/services/profile", () => ({
  getProfile: vi.fn(async () => ({ basics: { name: "Diego" } })),
  clearProfileCache: vi.fn(),
}));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.sequential("evaluation API", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    generateEvaluationReport.mockResolvedValue({
      markdown: "# Informe\n\n## Veredicto",
      model: "test-model",
      meta: { verdict: "apply", basis: "full_jd", confidence: 0.8 },
    });
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  const makeJob = async (jobDescription: string | null) => {
    const { createJob } = await import("@server/repositories/jobs");
    return createJob({
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: `https://example.com/job/${Math.random()}`,
      jobDescription: jobDescription ?? undefined,
    });
  };

  it("accepts the request and clears the lock when done", async () => {
    const job = await makeJob("A long description");

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, {
      method: "POST",
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.data).toEqual({ jobId: job.id, status: "generating" });

    await wait(50);
    const { getJobById } = await import("@server/repositories/jobs");
    const updated = await getJobById(job.id);
    expect(updated.evaluationReportGenerating).toBe(false);
    expect(updated.evaluationReport).toBe("# Informe\n\n## Veredicto");
    expect(updated.evaluationReportMeta).toEqual({
      verdict: "apply",
      basis: "full_jd",
      confidence: 0.8,
    });
  });

  it("returns 409 while a generation is in flight", async () => {
    const job = await makeJob("A long description");
    generateEvaluationReport.mockImplementation(() => new Promise(() => {}));

    const first = await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, {
      method: "POST",
    });
    const second = await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, {
      method: "POST",
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
  });

  it("returns 422 without a description", async () => {
    const job = await makeJob(null);
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, {
      method: "POST",
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error.code).toBe("UNPROCESSABLE_ENTITY");
  });

  it("returns 404 for an unknown job", async () => {
    const res = await fetch(`${baseUrl}/api/jobs/nope/evaluation`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("clears the lock when generation fails", async () => {
    const job = await makeJob("A long description");
    generateEvaluationReport.mockRejectedValue(new Error("boom"));

    await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, { method: "POST" });
    await wait(50);

    const { getJobById } = await import("@server/repositories/jobs");
    const updated = await getJobById(job.id);
    expect(updated.evaluationReportGenerating).toBe(false);
    expect(updated.evaluationReport).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/server/api/routes/jobs.evaluation.test.ts`
Expected: FAIL — 404 en el POST.

- [ ] **Step 3: Write minimal implementation**

`orchestrator/src/server/api/routes/jobs/evaluation.ts`:

```ts
import { conflict, notFound, toAppError, unprocessableEntity } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import { generateEvaluationReport } from "@server/services/evaluation-report";
import { getProfile } from "@server/services/profile";
import { getRequestId } from "@infra/request-context";
import { type Request, type Response, Router } from "express";

export const jobsEvaluationRouter = Router();

const LOCK_STALE_SECONDS = 300;

async function runEvaluationReport(jobId: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const job = await jobsRepo.getJobById(jobId);
    if (!job) return;

    const profile = await getProfile();
    const { markdown, model, meta } = await generateEvaluationReport({
      job,
      profile,
    });

    await jobsRepo.updateJob(jobId, {
      evaluationReport: markdown,
      evaluationReportGeneratedAt: new Date().toISOString(),
      evaluationReportModel: model,
      evaluationReportMeta: JSON.stringify(meta),
    });

    logger.info("Evaluation report generated", {
      requestId: getRequestId() ?? null,
      jobId,
      route: "POST /api/jobs/:id/evaluation",
      status: 202,
      model,
      durationMs: Date.now() - startedAt,
      outcome: "success",
    });
  } catch (error) {
    logger.error("Evaluation report failed", {
      requestId: getRequestId() ?? null,
      jobId,
      route: "POST /api/jobs/:id/evaluation",
      status: 502,
      durationMs: Date.now() - startedAt,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await jobsRepo.updateJob(jobId, { evaluationReportGenerating: false });
  }
}

jobsEvaluationRouter.post("/:id/evaluation", async (req: Request, res: Response) => {
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
      throw conflict("An evaluation report is already being generated for this job.");
    }

    ok(res, { jobId: job.id, status: "generating" }, 202);
    void runEvaluationReport(job.id);
  } catch (error) {
    fail(res, toAppError(error));
  }
});
```

`orchestrator/src/server/api/routes/jobs/index.ts`: importar y usar.

```ts
import { jobsEvaluationRouter } from "./evaluation";
// ...
jobsRouter.use(jobsEvaluationRouter);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/server/api/routes/jobs.evaluation.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Añadir el caso de aislamiento entre tenants**

En `orchestrator/src/server/api/routes/tenant-isolation.test.ts`, dentro del `describe.sequential`
existente (que ya aplica `AUTH_ENV` y tiene los helpers `signup`, `importManualJob` y
`authHeaders`), añadir:

```ts
  it("does not expose another tenant's evaluation report", async () => {
    const tokenA = await signup(baseUrl, "tenant-eval-a", "password-eval-a");
    const tokenB = await signup(baseUrl, "tenant-eval-b", "password-eval-b");
    const job = await importManualJob(
      baseUrl,
      tokenA,
      "Evaluation isolation role",
    );

    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/evaluation`, {
      method: "POST",
      headers: authHeaders(tokenB),
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
```

Run: `npm --workspace orchestrator run test:run -- src/server/api/routes/tenant-isolation.test.ts`
Expected: PASS, incluido el caso nuevo.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/server/api/routes/jobs/evaluation.ts orchestrator/src/server/api/routes/jobs/index.ts orchestrator/src/server/api/routes/jobs.evaluation.test.ts
git commit -m "feat(api): add report generation endpoint with lock and error mapping"
```

---

### Task 5: Panel de evaluación en la ficha del job

**Files:**
- Modify: `orchestrator/src/client/api/jobs.ts` (`generateEvaluationReport`)
- Modify: `orchestrator/src/client/pages/JobPage.tsx` (vista `evaluation`, tipo `JobDetail`)
- Modify: `orchestrator/src/client/pages/job-page/JobPageLeftSidebar.tsx` (tipo y enlace)
- Create: `orchestrator/src/client/pages/job-page/JobEvaluationPanel.tsx`
- Test: `orchestrator/src/client/pages/job-page/JobEvaluationPanel.test.tsx`

**Interfaces:**
- Consumes: `POST /api/jobs/:id/evaluation`, `api.updateJob`.
- Produces: `<JobEvaluationPanel job={job} />`, vista `"evaluation"`.

- [ ] **Step 1: Write the failing test**

```tsx
// orchestrator/src/client/pages/job-page/JobEvaluationPanel.test.tsx
import type { JobDetail } from "@shared/types";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQueryClient } from "../../test/renderWithQueryClient";
import { JobEvaluationPanel } from "./JobEvaluationPanel";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, generateEvaluationReport: vi.fn(), updateJob: vi.fn() };
});

const makeJob = (overrides: Partial<JobDetail> = {}): JobDetail =>
  ({
    id: "job-1",
    title: "Backend Engineer",
    employer: "Acme",
    status: "ready",
    jobDescription: "A description",
    evaluationReport: null,
    evaluationReportMeta: null,
    evaluationReportGenerating: false,
    ...overrides,
  }) as JobDetail;

describe("JobEvaluationPanel", () => {
  it("offers to generate when there is no report", () => {
    renderWithQueryClient(<JobEvaluationPanel job={makeJob()} />);
    expect(
      screen.getByRole("button", { name: /generate report/i }),
    ).toBeInTheDocument();
  });

  it("renders the report with basis and confidence", () => {
    renderWithQueryClient(
      <JobEvaluationPanel
        job={makeJob({
          evaluationReport: "## Veredicto\n\n**apply** — Strong fit.",
          evaluationReportMeta: {
            verdict: "apply",
            basis: "full_jd",
            confidence: 0.8,
          },
        })}
      />,
    );
    expect(screen.getByText(/strong fit/i)).toBeInTheDocument();
    expect(screen.getByText(/full_jd/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.8/)).toBeInTheDocument();
  });

  it("offers to reopen a skipped job when the verdict says apply", () => {
    renderWithQueryClient(
      <JobEvaluationPanel
        job={makeJob({
          status: "skipped",
          evaluationReport: "## Veredicto",
          evaluationReportMeta: {
            verdict: "apply",
            basis: "full_jd",
            confidence: 0.9,
          },
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: /move back to ready/i }),
    ).toBeInTheDocument();
  });

  it("disables generation while one is running", () => {
    renderWithQueryClient(
      <JobEvaluationPanel job={makeJob({ evaluationReportGenerating: true })} />,
    );
    expect(screen.getByText(/generating/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/client/pages/job-page/JobEvaluationPanel.test.tsx`
Expected: FAIL — no existe el componente.

- [ ] **Step 3: Write minimal implementation**

`orchestrator/src/client/api/jobs.ts`:

```ts
export async function generateEvaluationReport(
  jobId: string,
): Promise<{ jobId: string; status: "generating" }> {
  return fetchApi<{ jobId: string; status: "generating" }>(
    `/jobs/${jobId}/evaluation`,
    { method: "POST" },
  );
}
```

`orchestrator/src/client/pages/job-page/JobEvaluationPanel.tsx`:

```tsx
import type { JobDetail } from "@shared/types.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../../api";
import { JobDescriptionMarkdown } from "@/client/components/JobDescriptionMarkdown";
import { queryKeys } from "@/client/lib/queryKeys";
import { showErrorToast } from "@/client/lib/error-toast";

export const JobEvaluationPanel: React.FC<{ job: JobDetail }> = ({ job }) => {
  const queryClient = useQueryClient();

  const generate = useMutation({
    mutationFn: () => api.generateEvaluationReport(job.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.detail(job.id) }),
    onError: showErrorToast,
  });

  const reopen = useMutation({
    mutationFn: () => api.updateJob(job.id, { status: "ready" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.detail(job.id) }),
    onError: showErrorToast,
  });

  if (job.evaluationReportGenerating) {
    return <div className="p-4 text-sm">Generating evaluation report…</div>;
  }

  if (!job.evaluationReport || !job.evaluationReportMeta) {
    return (
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          No evaluation report yet. It reads the job description and your profile.
        </p>
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-sm"
          disabled={generate.isPending || !job.jobDescription}
          onClick={() => generate.mutate()}
        >
          Generate report
        </button>
        {!job.jobDescription && (
          <p className="text-xs text-muted-foreground">
            Add a job description first.
          </p>
        )}
      </div>
    );
  }

  const meta = job.evaluationReportMeta;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{meta.basis}</span>
        <span>{meta.confidence.toFixed(1)}</span>
        {job.evaluationReportGeneratedAt && (
          <span>{job.evaluationReportGeneratedAt.slice(0, 10)}</span>
        )}
        <button
          type="button"
          className="rounded-md border px-2 py-1"
          disabled={generate.isPending}
          onClick={() => generate.mutate()}
        >
          Regenerate
        </button>
      </div>

      {meta.verdict === "apply" && job.status === "skipped" && (
        <div className="rounded-md border border-amber-500/40 p-3 text-sm">
          <p className="mb-2">
            The report says apply but this job was discarded by its score.
          </p>
          <button
            type="button"
            className="rounded-md border px-2 py-1 text-xs"
            disabled={reopen.isPending}
            onClick={() => reopen.mutate()}
          >
            Move back to ready
          </button>
        </div>
      )}

      <JobDescriptionMarkdown content={job.evaluationReport} />
    </div>
  );
};
```

`orchestrator/src/client/pages/job-page/JobPageLeftSidebar.tsx`:

```ts
export type JobMemoryView =
  | "overview"
  | "note"
  | "documents"
  | "timeline"
  | "emails"
  | "evaluation"
  | "ghostwriter";
```

Y en `memoryLinks`, después de `emails`:

```ts
  {
    id: "evaluation" as const,
    label: "Evaluation",
    icon: ClipboardCheck,
  },
```

`orchestrator/src/client/pages/JobPage.tsx`:

1. `normalizeMemoryView` acepta `"evaluation"`.
2. Renderiza `<JobEvaluationPanel job={job} />` cuando `activeMemoryView === "evaluation"`.
3. La query del job pasa a `useQuery<JobDetail>` para que el panel reciba el tipo completo.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/client/pages/job-page/JobEvaluationPanel.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 5: Build del cliente**

Run: `npm --workspace orchestrator run build:client`
Expected: build correcto.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/client/api/jobs.ts orchestrator/src/client/pages/job-page/JobEvaluationPanel.tsx orchestrator/src/client/pages/job-page/JobEvaluationPanel.test.tsx orchestrator/src/client/pages/job-page/JobPageLeftSidebar.tsx orchestrator/src/client/pages/JobPage.tsx
git commit -m "feat(evaluation): show the report in a job page view"
```

---

### Task 6: Documentación

**Files:**
- Create: `docs-site/docs/features/evaluation-report.md`
- Modify: `docs-site/docs/features/overview.md` (enlace)

**Interfaces:**
- Consumes: nada.
- Produces: página publicada en el docs-site.

- [ ] **Step 1: Escribir la página**

```markdown
---
id: evaluation-report
title: Evaluation report
description: A readable report that explains why a job fits your CV, with the evidence and the gaps, without inventing data.
sidebar_position: 11
---

## What it is

A document, generated per job, that explains the fit between the posting and your CV: verdict, evidence table, gaps, compensation and posting signals.

## Why it exists

The suitability score answers "how much", not "why". The report answers "why", so you can decide without re-reading the posting.

It deliberately does **not** invent anything: salary comes from the posting or says "not verified", and the posting signals are computed from the job record (expired deadline, no employer URL, no salary, very short description).

## How to use it

1. Open a job with a description.
2. Go to the **Evaluation** view.
3. Press **Generate report**. It takes one model call; the button disables while it runs.
4. Read the verdict, the evidence table and the gaps.

What gets sent to the model: the job description and the profile fields job-ops already sends for scoring. Nothing else.

## Common problems

- **The button is disabled.** The job has no description; add one first.
- **"A report is already being generated".** There is a lock of 5 minutes to avoid paying twice.
- **The date looks old.** Nothing is regenerated automatically. Your profile may have changed since; press **Regenerate**.
- **The report says apply but the job is skipped.** The score is still the score. The report offers **Move back to ready** so you decide, explicitly.

## Related pages

- [/docs/features/orchestrator](/docs/features/orchestrator)
- [/docs/features/ghostwriter](/docs/features/ghostwriter)
- [/docs/features/follow-ups](/docs/features/follow-ups)
```

- [ ] **Step 2: Enlazar desde el índice**

En `docs-site/docs/features/overview.md`, añadir:

```markdown
- [Evaluation report](/docs/features/evaluation-report) — why a job fits your CV, with evidence and gaps.
```

- [ ] **Step 3: Build del docs-site**

Run: `npm --prefix docs-site run build`
Expected: build correcto, sin enlaces roto.

- [ ] **Step 4: Commit**

```bash
git add docs-site/docs/features/evaluation-report.md docs-site/docs/features/overview.md
git commit -m "docs(evaluation): explain the report and what it will not invent"
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
