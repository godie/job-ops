# TypeSafe Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Producir el `suitabilityScore` (0–100) de cada vacante con TypeSafe (modelo `jev`, primitiva `Score`), de forma opt-in por tenant y sin fallback al LLM.

**Architecture:** Nuevo servicio `orchestrator/src/server/services/typesafe-scorer.ts` que llama a `POST https://api.typesafe.ai/v1/systemone`. `scoreJobSuitability()` (en `scorer.ts`) sigue llamando al LLM para `reason`/`jobBrief`/`jobPatches` y, si `typesafeScoringEnabled` está activo, sustituye el score por el de TypeSafe y propaga la confianza. `score-jobs.ts` persiste la confianza y bloquea el auto-skip si es baja.

**Tech Stack:** TypeScript (ESM), Express, Drizzle + better-sqlite3, zod, vitest, React + react-hook-form (UI de Settings).

**Spec:** `docs/superpowers/specs/2026-10-06-typesafe-scoring-design.md`

## Global Constraints

- No se implementa fallback: si TypeSafe falla o falta la key, la vacante no se puntúa con el LLM.
- El contrato de `suitabilityScore` sigue siendo un entero 0–100; la confianza es un `number | null` en 0–1.
- La API key (`TYPESAFE_API_KEY`) nunca se loguea ni se devuelve al cliente.
- Todo es tenant-scoped por los repositorios existentes (`settings`, `jobs`).
- No se toca `career-ops`.
- Comandos de test desde la raíz `job-ops`: `npm --workspace orchestrator run test:run -- <ruta>`.
- Verificación final (CI-parity): `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace gradcracker-extractor run check:types`, `npm --workspace ukvisajobs-extractor run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.

---

## Task 1: Persistir `suitability_confidence`

**Files:**
- Modify: `orchestrator/src/server/db/migrate.ts` (array `migrations`, tras la línea de `job_brief`)
- Modify: `orchestrator/src/server/db/schema.ts:270`
- Modify: `shared/src/types/jobs.ts` (`Job` ~203, `JobListItem` ~272, `UpdateJobInput` ~565)
- Modify: `orchestrator/src/server/repositories/jobs.ts:865`
- Modify: `orchestrator/src/server/api/routes/jobs/shared.ts` (`toJobListItem`, ~ `suitabilityScore`)
- Test: `orchestrator/src/server/db/migrate.test.ts`

**Interfaces:**
- Produces: campo `suitabilityConfidence: number | null` en `Job`, `JobListItem` y `UpdateJobInput`; columna `suitability_confidence REAL`.

- [ ] **Step 1: Write the failing test**

Añade al final del `describe.sequential` de `orchestrator/src/server/db/migrate.test.ts`:

```ts
it("adds suitability_confidence to an existing jobs table", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "job-ops-migrate-"));
  const script = `
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    import Database from "better-sqlite3";

    const dbPath = join(process.env.DATA_DIR, "jobs.db");
    const sqlite = new Database(dbPath);
    sqlite.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, job_url TEXT NOT NULL DEFAULT '')");
    sqlite.close();

    await import(pathToFileURL(join(process.cwd(), "src/server/db/migrate.ts")).href);

    const migratedDb = new Database(dbPath, { readonly: true });
    const columns = migratedDb.prepare("PRAGMA table_info(jobs)").all();
    if (!columns.some((column) => column.name === "suitability_confidence")) {
      throw new Error("suitability_confidence column missing after migration");
    }
    migratedDb.close();
  `;

  execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { env: { ...process.env, DATA_DIR: tempDir }, stdio: "pipe" },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- src/server/db/migrate.test.ts`
Expected: FAIL con `suitability_confidence column missing after migration`.

- [ ] **Step 3: Add the migration**

En `orchestrator/src/server/db/migrate.ts`, en el array `migrations`, justo después de la línea `` `ALTER TABLE jobs ADD COLUMN job_brief TEXT`, ``, añade:

```ts
  // TypeSafe scoring confidence (safe to skip if already present)
  `ALTER TABLE jobs ADD COLUMN suitability_confidence REAL`,
```

- [ ] **Step 4: Add the schema/type/repo mappings**

`orchestrator/src/server/db/schema.ts` — tras `suitabilityScore: real("suitability_score"),`:

```ts
    suitabilityConfidence: real("suitability_confidence"),
```

`shared/src/types/jobs.ts` — en `Job`, tras `suitabilityScore: number | null; // 0-100 AI-generated score`:

```ts
  suitabilityConfidence: number | null; // 0-1 TypeSafe Score confidence (null when not TypeSafe)
```

En `JobListItem`, añade `| "suitabilityConfidence"` justo después de `| "suitabilityScore"`.

En `UpdateJobInput`, tras `suitabilityScore?: number | null;`:

```ts
  suitabilityConfidence?: number | null;
```

`orchestrator/src/server/repositories/jobs.ts` — en `mapRowToJob`, tras `suitabilityScore: row.suitabilityScore,`:

```ts
    suitabilityConfidence: row.suitabilityConfidence ?? null,
```

`orchestrator/src/server/api/routes/jobs/shared.ts` — en `toJobListItem`, tras `suitabilityScore: job.suitabilityScore,`:

```ts
          suitabilityConfidence: job.suitabilityConfidence ?? null,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- src/server/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/server/db/migrate.ts orchestrator/src/server/db/schema.ts shared/src/types/jobs.ts orchestrator/src/server/repositories/jobs.ts orchestrator/src/server/api/routes/jobs/shared.ts orchestrator/src/server/db/migrate.test.ts
git commit -m "feat(jobs): add suitability_confidence column and type"
```

---

## Task 2: `typesafe-scorer.ts` (mapeo puro + llamada a la API)

**Files:**
- Create: `orchestrator/src/server/services/typesafe-scorer.ts`
- Test: `orchestrator/src/server/services/typesafe-scorer.test.ts`

**Interfaces:**
- Produces: `FIT_LEVELS` (`readonly string[]`), `TypesafeFitResult`, `TypesafeNotConfiguredError`, `TypesafeScoringError`, `mapFitLevelToScore(levelPosition, levelCount?)`, `extractFitAnswer(json)`, `buildFitQuestion(instructions)`, `buildFitState({ job, profile, scoringInstructions })`, `resolveTypesafeApiKey()`, `scoreFitWithTypeSafe({ job, profile, apiKey, model, scoringInstructions })`.

- [ ] **Step 1: Write the failing tests**

Create `orchestrator/src/server/services/typesafe-scorer.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  FIT_LEVELS,
  mapFitLevelToScore,
  extractFitAnswer,
  scoreFitWithTypeSafe,
  TypesafeNotConfiguredError,
  TypesafeScoringError,
} from "./typesafe-scorer";
import { createJob } from "@shared/testing/factories";

describe("mapFitLevelToScore", () => {
  it("maps the 5 levels to 0-100", () => {
    expect(mapFitLevelToScore(0)).toBe(0);
    expect(mapFitLevelToScore(2)).toBe(50);
    expect(mapFitLevelToScore(3)).toBe(75);
    expect(mapFitLevelToScore(4)).toBe(100);
  });

  it("rounds fractional positions and clamps", () => {
    expect(mapFitLevelToScore(3.2)).toBe(80);
    expect(mapFitLevelToScore(-1)).toBe(0);
    expect(mapFitLevelToScore(9)).toBe(100);
  });
});

describe("extractFitAnswer", () => {
  it("reads score, confidence and probabilities", () => {
    const answer = extractFitAnswer({
      answers: {
        fit: {
          type: "score",
          score: 3,
          confidence: 0.9,
          legend: { "3": "Good fit: meets nearly all relevant requirements" },
          probabilities: { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 },
        },
      },
    });
    expect(answer.score).toBe(3);
    expect(answer.confidence).toBe(0.9);
    expect(answer.levelLabel).toBe("Good fit: meets nearly all relevant requirements");
  });

  it("throws on a malformed payload", () => {
    expect(() => extractFitAnswer({ answers: {} })).toThrow(TypesafeScoringError);
  });
});

describe("scoreFitWithTypeSafe", () => {
  const job = createJob({ id: "j1", title: "Backend Engineer", employer: "Acme" });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws TypesafeNotConfiguredError without a key", async () => {
    await expect(
      scoreFitWithTypeSafe({
        job,
        profile: {},
        apiKey: null,
        model: "jev-latest",
        scoringInstructions: "",
      }),
    ).rejects.toBeInstanceOf(TypesafeNotConfiguredError);
  });

  it("returns a mapped score on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            fit: {
              type: "score",
              score: 3,
              confidence: 0.88,
              legend: { "3": FIT_LEVELS[3] },
              probabilities: { "3": 0.9, "4": 0.1 },
            },
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await scoreFitWithTypeSafe({
      job,
      profile: { skills: [] },
      apiKey: "sk-test",
      model: "jev-latest",
      scoringInstructions: "",
    });

    expect(result.score).toBe(75);
    expect(result.confidence).toBe(0.88);
    expect(result.model).toBe("jev-1.13.0");
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("throws TypesafeScoringError on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "no" }),
    );
    await expect(
      scoreFitWithTypeSafe({ job, profile: {}, apiKey: "x", model: "m", scoringInstructions: "" }),
    ).rejects.toBeInstanceOf(TypesafeScoringError);
    vi.unstubAllGlobals();
  });

  it("retries once on 429 then fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "slow" })
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "slow" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      scoreFitWithTypeSafe({ job, profile: {}, apiKey: "x", model: "m", scoringInstructions: "" }),
    ).rejects.toBeInstanceOf(TypesafeScoringError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --workspace orchestrator run test:run -- src/server/services/typesafe-scorer.test.ts`
Expected: FAIL con "Failed to resolve import ./typesafe-scorer".

- [ ] **Step 3: Implement the service**

Create `orchestrator/src/server/services/typesafe-scorer.ts`:

```ts
import { logger } from "@infra/logger";
import { getOriginalEnvValue } from "@server/services/envSettings";
import * as settingsRepo from "@server/repositories/settings";
import { toStringOrNull } from "@shared/utils/type-conversion";
import type { Job } from "@shared/types";

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
  const fit = (json as { answers?: Record<string, unknown> } | null)?.answers?.fit as
    | {
        score?: unknown;
        confidence?: unknown;
        legend?: Record<string, unknown>;
        probabilities?: Record<string, unknown>;
      }
    | undefined;

  if (!fit || typeof fit.score !== "number" || typeof fit.confidence !== "number") {
    throw new TypesafeScoringError("TypeSafe response is missing a numeric fit answer");
  }

  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(fit.probabilities ?? {})) {
    probabilities[key] = typeof value === "number" ? value : 0;
  }
  const modalLevel = argmaxLevel(probabilities);
  const legendValue = fit.legend?.[String(modalLevel)];
  const fallbackLabel = FIT_LEVELS[Math.min(FIT_LEVELS.length - 1, Math.max(0, Math.round(fit.score)))];
  const levelLabel =
    typeof legendValue === "string" ? legendValue : fallbackLabel;

  return { score: fit.score, confidence: fit.confidence, levelLabel, probabilities };
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
      job_description: (job.jobDescription ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 12000),
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
    throw new TypesafeScoringError(`TypeSafe request failed with status ${result.status}`);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --workspace orchestrator run test:run -- src/server/services/typesafe-scorer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/server/services/typesafe-scorer.ts orchestrator/src/server/services/typesafe-scorer.test.ts
git commit -m "feat(scoring): add TypeSafe fit scorer service"
```

---

## Task 3: Settings de TypeSafe (registry + tipos)

**Files:**
- Modify: `shared/src/settings-registry.ts` (tras `autoSkipScoreThreshold`, ~894)
- Modify: `shared/src/types/settings.ts` (`AppSettings`, ~306)
- Test: `shared/src/settings-registry.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: keys `typesafeScoringEnabled` (bool, default `false`), `typesafeMinConfidence` (number 0..1, default `0.7`), `typesafeModel` (string, default `"jev-latest"`), `typesafeApiKey` (secret, env `TYPESAFE_API_KEY`). En `AppSettings`: `typesafeScoringEnabled: Resolved<boolean>`, `typesafeMinConfidence: Resolved<number>`, `typesafeModel: Resolved<string>`, `typesafeApiKeyHint: string | null`.

- [ ] **Step 1: Write the failing test**

En `shared/src/settings-registry.test.ts`, añade un `describe`:

```ts
describe("typesafe scoring settings", () => {
  it("has safe defaults", () => {
    expect(settingsRegistry.typesafeScoringEnabled.default()).toBe(false);
    expect(settingsRegistry.typesafeMinConfidence.default()).toBe(0.7);
    expect(settingsRegistry.typesafeModel.default()).toBe("jev-latest");
  });

  it("clamps typesafeMinConfidence to 0..1", () => {
    expect(settingsRegistry.typesafeMinConfidence.parse("2")).toBe(1);
    expect(settingsRegistry.typesafeMinConfidence.parse("-1")).toBe(0);
    expect(settingsRegistry.typesafeMinConfidence.parse("0.62")).toBe(0.62);
  });

  it("declares typesafeApiKey as an env-backed secret", () => {
    expect(settingsRegistry.typesafeApiKey.kind).toBe("secret");
    expect(settingsRegistry.typesafeApiKey.envKey).toBe("TYPESAFE_API_KEY");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace orchestrator run test:run -- ../shared/src/settings-registry.test.ts`
Expected: FAIL con "Cannot read properties of undefined (reading 'default')".

- [ ] **Step 3: Add the registry entries**

En `shared/src/settings-registry.ts`, dentro del objeto `settingsRegistry`, justo después del bloque `autoSkipScoreThreshold: { ... },` añade:

```ts
  // --- TypeSafe scoring ---
  typesafeScoringEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  typesafeMinConfidence: {
    kind: "typed" as const,
    schema: z.number().min(0).max(1),
    default: (): number => 0.7,
    parse: (raw: string | undefined): number | null => {
      if (raw === undefined || raw === "") return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : null;
    },
    serialize: serializeNullableNumber,
  },
  typesafeModel: {
    kind: "typed" as const,
    schema: z.string().trim().min(1).max(200),
    default: (): string => "jev-latest",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null => value ?? null,
  },
  typesafeApiKey: {
    kind: "secret" as const,
    envKey: "TYPESAFE_API_KEY",
    schema: z.string().trim().max(2000),
  },
```

- [ ] **Step 4: Add the `AppSettings` fields**

En `shared/src/types/settings.ts`, en `interface AppSettings`, tras `autoSkipScoreThreshold: Resolved<number | null>;`:

```ts
  typesafeScoringEnabled: Resolved<boolean>;
  typesafeMinConfidence: Resolved<number>;
  typesafeModel: Resolved<string>;
  typesafeApiKeyHint: string | null;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --workspace orchestrator run test:run -- ../shared/src/settings-registry.test.ts`
Expected: PASS. (`getEffectiveSettings` resuelve los keys `typed` de forma genérica y `getEnvSettingsData` genera `typesafeApiKeyHint` para el secreto con `envKey`.)

- [ ] **Step 6: Commit**

```bash
git add shared/src/settings-registry.ts shared/src/types/settings.ts shared/src/settings-registry.test.ts
git commit -m "feat(settings): add TypeSafe scoring settings"
```

---

## Task 4: Integrar TypeSafe en `scoreJobSuitability()`

**Files:**
- Modify: `orchestrator/src/server/services/scorer.ts` (`SuitabilityResult` ~42, imports ~18, `scoreJobSuitability` ~360)
- Test: `orchestrator/src/server/services/scorer.typesafe.test.ts` (nuevo)

**Interfaces:**
- Consumes: `scoreFitWithTypeSafe`, `resolveTypesafeApiKey`, `TypesafeNotConfiguredError`, `TypesafeScoringError` (Task 2); `settings.typesafeScoringEnabled.value`, `settings.typesafeModel.value` (Task 3).
- Produces: `SuitabilityResult` con `confidence: number | null`.

- [ ] **Step 1: Write the failing tests**

Create `orchestrator/src/server/services/scorer.typesafe.test.ts`:

```ts
import { createJob } from "@shared/testing/factories";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getEffectiveSettingsMock,
  resolveLlmModelMock,
  createConfiguredLlmServiceMock,
  callJsonMock,
  scoreFitMock,
  resolveKeyMock,
  TypesafeNotConfiguredErrorMock,
  TypesafeScoringErrorMock,
} = vi.hoisted(() => {
  class TypesafeNotConfiguredError extends Error {}
  class TypesafeScoringError extends Error {}
  return {
    getEffectiveSettingsMock: vi.fn(),
    resolveLlmModelMock: vi.fn(),
    createConfiguredLlmServiceMock: vi.fn(),
    callJsonMock: vi.fn(),
    scoreFitMock: vi.fn(),
    resolveKeyMock: vi.fn(),
    TypesafeNotConfiguredErrorMock: TypesafeNotConfiguredError,
    TypesafeScoringErrorMock: TypesafeScoringError,
  };
});

vi.mock("./settings", () => ({ getEffectiveSettings: getEffectiveSettingsMock }));
vi.mock("@server/repositories/settings", () => ({ getSetting: vi.fn() }));
vi.mock("./prompt-templates", () => ({ renderPromptTemplate: () => "PROMPT" }));
vi.mock("./modelSelection", () => ({
  resolveLlmModel: resolveLlmModelMock,
  createConfiguredLlmService: createConfiguredLlmServiceMock,
}));
vi.mock("./typesafe-scorer", () => ({
  scoreFitWithTypeSafe: scoreFitMock,
  resolveTypesafeApiKey: resolveKeyMock,
  TypesafeNotConfiguredError: TypesafeNotConfiguredErrorMock,
  TypesafeScoringError: TypesafeScoringErrorMock,
}));

import {
  scoreJobSuitability,
  LlmNotConfiguredError,
  ScoringUnavailableError,
} from "./scorer";

const baseSettings = {
  scoringInstructions: { value: "" },
  scoringPromptTemplate: { value: "score {{jobTitle}}" },
  penalizeMissingSalary: { value: false },
  missingSalaryPenalty: { value: 0 },
  typesafeScoringEnabled: { value: true },
  typesafeModel: { value: "jev-latest" },
};

describe("scoreJobSuitability with TypeSafe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveLlmModelMock.mockResolvedValue("gpt-x");
    createConfiguredLlmServiceMock.mockResolvedValue({ callJson: callJsonMock });
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        score: 40,
        reason: "LLM reason",
        jobBrief: { role_summary: "x" },
        jobPatches: [],
        jobWarnings: [],
      },
    });
    getEffectiveSettingsMock.mockResolvedValue(baseSettings);
    resolveKeyMock.mockResolvedValue("sk-test");
  });

  it("replaces the LLM score with TypeSafe's", async () => {
    scoreFitMock.mockResolvedValue({ score: 75, confidence: 0.9, levelPosition: 3, levelLabel: "x", probabilities: {}, model: "jev", latencyMs: 1 });
    const result = await scoreJobSuitability(
      createJob({ id: "j1", jobDescription: "We need Node.js" }),
      {},
      { skipHostedUsage: true },
    );
    expect(result.score).toBe(75);
    expect(result.confidence).toBe(0.9);
  });

  it("keeps the LLM score and null confidence when TypeSafe is off", async () => {
    getEffectiveSettingsMock.mockResolvedValue({
      ...baseSettings,
      typesafeScoringEnabled: { value: false },
    });
    const result = await scoreJobSuitability(
      createJob({ id: "j1", jobDescription: "We need Node.js" }),
      {},
      { skipHostedUsage: true },
    );
    expect(result.score).toBe(40);
    expect(result.confidence).toBeNull();
    expect(scoreFitMock).not.toHaveBeenCalled();
  });

  it("maps a missing key to LlmNotConfiguredError", async () => {
    scoreFitMock.mockRejectedValue(new TypesafeNotConfiguredErrorMock());
    await expect(
      scoreJobSuitability(createJob({ id: "j1" }), {}, { skipHostedUsage: true }),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("maps a TypeSafe failure to ScoringUnavailableError", async () => {
    scoreFitMock.mockRejectedValue(new TypesafeScoringErrorMock("boom"));
    await expect(
      scoreJobSuitability(createJob({ id: "j1" }), {}, { skipHostedUsage: true }),
    ).rejects.toBeInstanceOf(ScoringUnavailableError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --workspace orchestrator run test:run -- src/server/services/scorer.typesafe.test.ts`
Expected: FAIL — `result.confidence` es `undefined` y TypeSafe no se llama.

- [ ] **Step 3: Implement the integration**

En `orchestrator/src/server/services/scorer.ts`:

1) Imports (junto a los demás):

```ts
import {
  resolveTypesafeApiKey,
  scoreFitWithTypeSafe,
  TypesafeNotConfiguredError,
} from "./typesafe-scorer";
```

2) `SuitabilityResult`:

```ts
interface SuitabilityResult {
  score: number | null;
  confidence: number | null;
  reason: string;
  jobBrief: string | null;
  jobUpdates?: UpdateJobInput;
}
```

3) En `scoreJobSuitability`, tras `const patchResult = validateAndApplyJobPatches(job, result.data.jobPatches ?? []);` y antes de `applySalaryPenalty`, inserta:

```ts
  let effectiveScore = clampedScore;
  let confidence: number | null = null;

  if (settings.typesafeScoringEnabled.value) {
    const apiKey = await resolveTypesafeApiKey();
    try {
      const fit = await scoreFitWithTypeSafe({
        job: patchResult.patchedJob,
        profile: sanitizeProfileForPrompt(aiProfile),
        apiKey,
        model: settings.typesafeModel.value,
        scoringInstructions,
      });
      effectiveScore = fit.score;
      confidence = fit.confidence;
    } catch (error) {
      if (error instanceof TypesafeNotConfiguredError) {
        throw new LlmNotConfiguredError(
          "TypeSafe scoring is enabled but not configured. Add your API key in Settings → Integrations, or turn off TypeSafe scoring.",
        );
      }
      throw new ScoringUnavailableError(
        `TypeSafe scoring failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
```

4) Cambia la llamada a `applySalaryPenalty` para usar `effectiveScore`, y el `return` final:

```ts
  const penaltyResult = applySalaryPenalty(
    patchResult.patchedJob,
    effectiveScore,
    clampedReason,
    {
      penalizeMissingSalary: settings.penalizeMissingSalary.value,
      missingSalaryPenalty: settings.missingSalaryPenalty.value,
    },
  );

  return {
    score: penaltyResult.score,
    confidence,
    reason: penaltyResult.reason,
    jobBrief:
      job.jobDescription?.trim() && result.data.jobBrief
        ? JSON.stringify(result.data.jobBrief)
        : null,
    jobUpdates: patchResult.updates,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --workspace orchestrator run test:run -- src/server/services/scorer.typesafe.test.ts src/server/services/scorer.test.ts`
Expected: PASS (el test nuevo y los existentes).

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/server/services/scorer.ts orchestrator/src/server/services/scorer.typesafe.test.ts
git commit -m "feat(scoring): use TypeSafe score in scoreJobSuitability"
```

---

## Task 5: Auto-skip bloqueado por confianza baja + persistencia

**Files:**
- Modify: `orchestrator/src/server/pipeline/steps/score-jobs.ts` (`scoreJobsStep` ~38, ~135-170)
- Test: `orchestrator/src/server/pipeline/steps/score-jobs.test.ts`

**Interfaces:**
- Consumes: `SuitabilityResult.confidence` (Task 4); setting `typesafeMinConfidence` (Task 3).
- Produces: `updateJob` recibe `suitabilityConfidence`.

- [ ] **Step 1: Write the failing tests**

Añade a `orchestrator/src/server/pipeline/steps/score-jobs.test.ts` (dentro del `describe` existente o uno nuevo, reutilizando los mocks ya declarados):

```ts
it("does not auto-skip on low score when TypeSafe confidence is below the threshold", async () => {
  const jobsRepo = await import("@server/repositories/jobs");
  const settingsRepo = await import("@server/repositories/settings");
  const scorer = await import("@server/services/scorer");
  const visaSponsors = await import("@server/services/visa-sponsors/index");

  vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockResolvedValue([
    createJob({ id: "j1", status: "discovered", employer: "Acme" }),
  ]);
  vi.mocked(settingsRepo.getSetting).mockImplementation(async (key: string) => {
    if (key === "autoSkipScoreThreshold") return "60";
    if (key === "typesafeMinConfidence") return "0.7";
    return null;
  });
  vi.mocked(scorer.scoreJobSuitability).mockResolvedValue({
    score: 30,
    confidence: 0.4,
    reason: "r",
    jobBrief: null,
  });
  vi.mocked(visaSponsors.searchSponsors).mockResolvedValue([]);
  vi.mocked(visaSponsors.calculateSponsorMatchSummary).mockReturnValue({
    sponsorMatchScore: 0,
    sponsorMatchNames: null,
  } as never);

  await scoreJobsStep({ profile: {} });

  const updateArgs = vi.mocked(jobsRepo.updateJob).mock.calls[0][1];
  expect(updateArgs.suitabilityConfidence).toBe(0.4);
  expect(updateArgs.status).toBeUndefined();
});

it("auto-skips on low score when confidence is high enough", async () => {
  const jobsRepo = await import("@server/repositories/jobs");
  const settingsRepo = await import("@server/repositories/settings");
  const scorer = await import("@server/services/scorer");
  const visaSponsors = await import("@server/services/visa-sponsors/index");

  vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockResolvedValue([
    createJob({ id: "j2", status: "discovered", employer: "Acme" }),
  ]);
  vi.mocked(settingsRepo.getSetting).mockImplementation(async (key: string) => {
    if (key === "autoSkipScoreThreshold") return "60";
    if (key === "typesafeMinConfidence") return "0.7";
    return null;
  });
  vi.mocked(scorer.scoreJobSuitability).mockResolvedValue({
    score: 30,
    confidence: 0.9,
    reason: "r",
    jobBrief: null,
  });
  vi.mocked(visaSponsors.searchSponsors).mockResolvedValue([]);
  vi.mocked(visaSponsors.calculateSponsorMatchSummary).mockReturnValue({
    sponsorMatchScore: 0,
    sponsorMatchNames: null,
  } as never);

  await scoreJobsStep({ profile: {} });

  const updateArgs = vi.mocked(jobsRepo.updateJob).mock.calls[0][1];
  expect(updateArgs.status).toBe("skipped");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --workspace orchestrator run test:run -- src/server/pipeline/steps/score-jobs.test.ts`
Expected: FAIL — `suitabilityConfidence` es `undefined` y/o el primer test auto-skipea.

- [ ] **Step 3: Implement**

En `orchestrator/src/server/pipeline/steps/score-jobs.ts`:

Lee el umbral junto al `autoSkipThreshold`:

```ts
  const typesafeMinConfidenceRaw = await settingsRepo.getSetting(
    "typesafeMinConfidence",
  );
  const typesafeMinConfidence =
    typesafeMinConfidenceRaw != null &&
    !Number.isNaN(Number(typesafeMinConfidenceRaw))
      ? Number(typesafeMinConfidenceRaw)
      : 0.7;
```

Desestructura `confidence` del resultado del scorer:

```ts
      const { score, confidence, reason, jobBrief, jobUpdates = {} } = scoringResult;
```

Amplía `shouldAutoSkip`:

```ts
      const shouldAutoSkip =
        job.status !== "applied" &&
        score !== null &&
        autoSkipThreshold !== null &&
        !Number.isNaN(autoSkipThreshold) &&
        score < autoSkipThreshold &&
        (confidence === null || confidence >= typesafeMinConfidence);
```

Añade `suitabilityConfidence` al `updateJob`:

```ts
      await jobsRepo.updateJob(job.id, {
        ...jobUpdates,
        suitabilityScore: score,
        suitabilityConfidence: confidence,
        suitabilityReason: reason,
        jobBrief,
        sponsorMatchScore,
        sponsorMatchNames,
        ...(shouldAutoSkip ? { status: "skipped" } : {}),
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --workspace orchestrator run test:run -- src/server/pipeline/steps/score-jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/server/pipeline/steps/score-jobs.ts orchestrator/src/server/pipeline/steps/score-jobs.test.ts
git commit -m "feat(scoring): persist confidence and gate auto-skip on it"
```

---

## Task 6: UI de Settings (toggle, umbral, modelo, API key)

> **Nota TDD:** esta tarea es cableado de formulario/UI. El código de producción aquí es
> JSX + plumbing de formularios; el comportamiento testeable (defaults, validación,
> resolución por tenant) ya está en las Tasks 3 y 5. La validación de esta tarea es
> `build:client` (typecheck) + la suite existente de `SettingsPage.test.tsx`. Si prefieres
> un test de UI dedicado, dilo antes de ejecutarla.

**Files:**
- Modify: `orchestrator/src/client/pages/settings/types.ts` (`ScoringValues`)
- Modify: `orchestrator/src/client/pages/SettingsPage.tsx` (`DEFAULT_FORM_VALUES` ~110, `NULL_SETTINGS_PAYLOAD` ~457, `mapSettingsToForm` ~481, `SECTION_FIELD_MAP.scoring` ~334, `buildSettingsValues` ~752, payload builder ~1290)
- Modify: `orchestrator/src/client/pages/settings/components/ScoringSettingsSection.tsx`

**Interfaces:**
- Consumes: keys de Task 3 (`typesafeScoringEnabled`, `typesafeMinConfidence`, `typesafeModel`, `typesafeApiKey`) y `typesafeApiKeyHint`.
- Produces: nada consumido por otras tareas.

- [ ] **Step 1: Extend `ScoringValues`**

En `orchestrator/src/client/pages/settings/types.ts`:

```ts
export type ScoringValues = {
  penalizeMissingSalary: EffectiveDefault<boolean>;
  missingSalaryPenalty: EffectiveDefault<number>;
  autoSkipScoreThreshold: EffectiveDefault<number | null>;
  blockedCompanyKeywords: EffectiveDefault<string[]>;
  typesafeScoringEnabled: EffectiveDefault<boolean>;
  typesafeMinConfidence: EffectiveDefault<number>;
  typesafeModel: EffectiveDefault<string>;
  typesafeApiKeyHint: string | null;
};
```

- [ ] **Step 2: Wire the form plumbing in `SettingsPage.tsx`**

`SECTION_FIELD_MAP.scoring`:

```ts
  scoring: [
    "penalizeMissingSalary",
    "missingSalaryPenalty",
    "autoSkipScoreThreshold",
    "blockedCompanyKeywords",
    "typesafeScoringEnabled",
    "typesafeMinConfidence",
    "typesafeModel",
    "typesafeApiKey",
  ],
```

`DEFAULT_FORM_VALUES` (tras `blockedCompanyKeywords: [],`):

```ts
  typesafeScoringEnabled: null,
  typesafeMinConfidence: null,
  typesafeModel: "",
  typesafeApiKey: "",
```

`NULL_SETTINGS_PAYLOAD` (tras `blockedCompanyKeywords: null,`):

```ts
  typesafeScoringEnabled: null,
  typesafeMinConfidence: null,
  typesafeModel: null,
  typesafeApiKey: null,
```

`mapSettingsToForm` (tras `blockedCompanyKeywords: data.blockedCompanyKeywords.override ?? [],`):

```ts
  typesafeScoringEnabled: data.typesafeScoringEnabled.override,
  typesafeMinConfidence: data.typesafeMinConfidence.override,
  typesafeModel: data.typesafeModel.override,
  typesafeApiKey: "",
```

`buildSettingsValues` — en el bloque `scoring: { ... }` (tras `blockedCompanyKeywords`):

```ts
      typesafeScoringEnabled: {
        effective: settings?.typesafeScoringEnabled?.value ?? false,
        default: settings?.typesafeScoringEnabled?.default ?? false,
      },
      typesafeMinConfidence: {
        effective: settings?.typesafeMinConfidence?.value ?? 0.7,
        default: settings?.typesafeMinConfidence?.default ?? 0.7,
      },
      typesafeModel: {
        effective: settings?.typesafeModel?.value ?? "jev-latest",
        default: settings?.typesafeModel?.default ?? "jev-latest",
      },
      typesafeApiKeyHint: settings?.typesafeApiKeyHint ?? null,
```

Payload builder (tras el bloque `blockedCompanyKeywords:`):

```ts
        typesafeScoringEnabled: nullIfSame(
          data.typesafeScoringEnabled,
          scoring.typesafeScoringEnabled.default,
        ),
        typesafeMinConfidence: nullIfSame(
          data.typesafeMinConfidence,
          scoring.typesafeMinConfidence.default,
        ),
        typesafeModel: nullIfSame(
          normalizeString(data.typesafeModel),
          scoring.typesafeModel.default,
        ),
        typesafeApiKey: normalizePrivateInput(data.typesafeApiKey),
```

- [ ] **Step 3: Render the section**

En `orchestrator/src/client/pages/settings/components/ScoringSettingsSection.tsx`:

- Añade a la desestructuración de `values`: `typesafeScoringEnabled, typesafeMinConfidence, typesafeModel, typesafeApiKeyHint`.
- Añade `const currentTypesafeEnabled = watch("typesafeScoringEnabled") ?? typesafeScoringEnabled.default;` junto a los otros `watch`.
- Inserta el bloque siguiente justo antes del `<Separator />` que precede a "Effective/Default values display":

```tsx
        <Separator />

        <div className="flex items-start space-x-3">
          <Controller
            name="typesafeScoringEnabled"
            control={control}
            render={({ field }) => (
              <Checkbox
                id="typesafeScoringEnabled"
                checked={field.value ?? typesafeScoringEnabled.default}
                onCheckedChange={(checked) =>
                  field.onChange(checked === "indeterminate" ? null : checked === true)
                }
                disabled={isLoading || isSaving}
              />
            )}
          />
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="typesafeScoringEnabled"
              className="text-sm font-medium leading-none cursor-pointer"
            >
              Use TypeSafe for scoring
            </label>
            <p className="text-xs text-muted-foreground">
              Score fit with TypeSafe (calibrated confidence) instead of the LLM.
              The LLM still writes the brief and reason. No fallback: if TypeSafe
              fails, the job is left unscored.
            </p>
          </div>
        </div>

        {currentTypesafeEnabled && (
          <div className="space-y-3 pl-7">
            <Controller
              name="typesafeMinConfidence"
              control={control}
              render={({ field }) => (
                <SettingsInput
                  label="Minimum TypeSafe Confidence"
                  type="number"
                  inputProps={{
                    ...field,
                    inputMode: "decimal",
                    min: 0,
                    max: 1,
                    step: 0.05,
                    value: field.value ?? typesafeMinConfidence.default,
                    onChange: (event) => {
                      const value = Number(event.target.value);
                      field.onChange(Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null);
                    },
                  }}
                  disabled={isLoading || isSaving}
                  helper="Jobs below the auto-skip threshold are not skipped when TypeSafe confidence is lower than this. (0-1)"
                  current={`Effective: ${typesafeMinConfidence.effective} | Default: ${typesafeMinConfidence.default}`}
                />
              )}
            />
            <Controller
              name="typesafeModel"
              control={control}
              render={({ field }) => (
                <SettingsInput
                  label="TypeSafe Model"
                  inputProps={{
                    ...field,
                    value: field.value ?? typesafeModel.default,
                    onChange: (event) => field.onChange(event.target.value),
                  }}
                  disabled={isLoading || isSaving}
                  helper={`TypeSafe model id. Default: ${typesafeModel.default}.`}
                  current={`Effective: ${typesafeModel.effective} | Default: ${typesafeModel.default}`}
                />
              )}
            />
            <Controller
              name="typesafeApiKey"
              control={control}
              render={({ field }) => (
                <SettingsInput
                  label="TypeSafe API Key"
                  type="password"
                  inputProps={{ ...field, value: field.value ?? "", autoComplete: "off" }}
                  disabled={isLoading || isSaving}
                  helper="Stored per workspace. Leave blank to keep the current key."
                  current={`Configured: ${typesafeApiKeyHint ? "Yes" : "No"}`}
                />
              )}
            />
          </div>
        )}
```

- [ ] **Step 4: Typecheck + existing tests**

Run: `npm --workspace orchestrator run build:client`
Expected: PASS (sin errores de tipo).
Run: `npm --workspace orchestrator run test:run -- src/client/pages/SettingsPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/client/pages/settings/types.ts orchestrator/src/client/pages/SettingsPage.tsx orchestrator/src/client/pages/settings/components/ScoringSettingsSection.tsx
git commit -m "feat(settings): expose TypeSafe scoring controls"
```

---

## Task 7: Docs + verificación CI-parity

**Files:**
- Modify: `docs-site/docs/features/settings.md`

**Interfaces:** ninguna.

- [ ] **Step 1: Add the docs section**

En `docs-site/docs/features/settings.md`, añade una sección (respeta frontmatter y estructura de 5 secciones de AGENTS.md):

```md
## AI scoring with TypeSafe

### What it is

An optional scoring mode where the suitability score (0–100) comes from TypeSafe's
`jev` model as a `Score` question, instead of the LLM.

### Why it exists

TypeSafe returns a calibrated confidence for each judgment. The score is a position on
five described levels; the confidence tells you how concentrated that judgment was.

### How to use it

1. Go to **Settings → Scoring**.
2. Enable **Use TypeSafe for scoring**.
3. Paste your TypeSafe API key (from https://console.typesafe.ai/keys).
4. Optionally set **Minimum TypeSafe Confidence** (default `0.7`).

When enabled, the LLM still writes the job brief and reason, but the score is
TypeSafe's. If TypeSafe is not configured or fails, the job is left unscored and
retried on the next run — there is no fallback to the LLM score.

### Common problems

- **Jobs stay unscored:** the API key is missing or invalid, or the TypeSafe API is
  failing. Check **Settings → Scoring** and the server logs.
- **Jobs are not auto-skipped:** the auto-skip threshold is set, but TypeSafe
  confidence was below **Minimum TypeSafe Confidence**, so the job is kept for review.

### Related pages

- [Orchestrator pipeline](/docs/features/orchestrator)
- [Settings](/docs/features/settings)
```

- [ ] **Step 2: Run the full CI-parity suite**

```bash
./orchestrator/node_modules/.bin/biome ci .
npm run check:types:shared
npm --workspace orchestrator run check:types
npm --workspace gradcracker-extractor run check:types
npm --workspace ukvisajobs-extractor run check:types
npm --workspace orchestrator run build:client
npm --workspace orchestrator run test:run
```
Expected: todos PASS.

- [ ] **Step 3: Commit**

```bash
git add docs-site/docs/features/settings.md
git commit -m "docs(settings): document TypeSafe scoring"
```

---

## Self-Review

**Spec coverage:**
- §3 Arquitectura A / flujo → Tasks 2, 4. ✅
- §4.1 `typesafe-scorer.ts` (tipos, mapeo, errores) → Task 2. ✅
- §4.2 `scorer.ts` (rama, errores, confidence) → Task 4. ✅
- §4.3 `score-jobs.ts` (auto-skip, persistir) → Task 5. ✅
- §5 Pregunta `Score` + `state` → Task 2 (`FIT_LEVELS`, `buildFitState`). ✅
- §6 Settings → Task 3. ✅
- §7 Persistencia → Task 1. ✅
- §8 Errores/hosted → Task 4 (mapeo) + Task 5 (auto-skip); hosted se mantiene intacto. ✅
- §9 Seguridad/PII/multi-tenancy → Task 2 (`buildFitState` solo sanitiza perfil) + Task 3 (secreto por tenant). ✅
- §10 Tests → Tasks 1-5. ✅
- §11 Docs → Task 7. ✅
- §12 Fuera de alcance → respetado. ✅
- §13 Verificación → Task 7 step 2. ✅

**Placeholder scan:** sin TBD/TODO. Task 6 está marcada explícitamente como tarea de cableado UI con su justificación.

**Type consistency:** `TypesafeFitResult` (Task 2) usa `score/confidence/levelPosition/levelLabel/probabilities/model/latencyMs`; Task 4 consume `score` y `confidence`. `SuitabilityResult.confidence` (Task 4) lo consume Task 5. `typesafeScoringEnabled`/`typesafeModel`/`typesafeMinConfidence`/`typesafeApiKey`/`typesafeApiKeyHint` (Task 3) los consumen Tasks 4, 5 y 6 con los mismos nombres.
