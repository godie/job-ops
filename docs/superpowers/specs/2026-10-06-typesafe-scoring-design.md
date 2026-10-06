# TypeSafe como scorer de job-ops — Diseño

- **Fecha**: 2026-10-06
- **Estado**: borrador para revisión
- **Alcance**: `orchestrator` + `shared` (job-ops). No toca `career-ops`.
- **Skills**: brainstorming (este diseño) → writing-plans → test-driven-development (implementación).

## 1. Contexto y objetivo

Hoy el score de encaje de una vacante lo produce una llamada LLM
(`scoreJobSuitability` en `orchestrator/src/server/services/scorer.ts:263`), que en un
solo JSON devuelve: revisión de hechos + `jobPatches`, `jobBrief`, y la evaluación del
candidato (`score` 0–100 + `reason`).

Objetivo: que el **número** (`suitability_score`, 0–100) lo produzca TypeSafe (modelo
`jev`, primitiva `Score`), que devuelve un juicio tipado con probabilidades y
**confianza calibrada**. El LLM sigue generando `reason`, `jobBrief` y `jobPatches`.

## 2. Decisiones (cerradas en brainstorming)

1. **TypeSafe reemplaza el score del LLM.** El LLM se mantiene para `reason` /
   `jobBrief` / `patches`. Una sola llamada TypeSafe por vacante.
2. **Opt-in estricto, sin fallback.** Activable por tenant. Si falta la key, la
   pipeline se pausa con un error de configuración (como hoy con el LLM). Si TypeSafe
   falla de forma transitoria, la vacante queda sin score y se reintenta. Nunca se usa
   el score del LLM.
3. **La confianza no altera el número.** El 0–100 sale del nivel del `Score`. La
   confianza se persiste y, si es menor que un umbral, **bloquea el auto-skip**.
4. **Arquitectura A**: servicio dedicado + rama en `scoreJobSuitability`. No se
   introduce una interfaz de proveedor (YAGNI), ni se toca el prompt/schema del LLM.
5. **Persistencia**: nueva columna `suitability_confidence` (nullable), expuesta en el
   contrato.

## 3. Arquitectura (enfoque A)

```
score-jobs.ts (pipeline step)
  └── scoreJobSuitability(job, profile)          [scorer.ts]
        ├── LLM (sin cambios) ──▶ reason, jobBrief, jobPatches ──▶ patchedJob
        └── if settings.typesafeScoringEnabled
              scoreFitWithTypeSafe({ job: patchedJob, profile, ... })   [NUEVO typesafe-scorer.ts]
                 └── POST https://api.typesafe.ai/v1/systemone  ──▶ { score 0-100, confidence, level }
        └── applySalaryPenalty(score)  (sobre el score de TypeSafe)
        └── return { score, confidence, reason, jobBrief, jobUpdates }
```

Orden LLM → TypeSafe: el score usa los hechos corregidos por `jobPatches`
(semántica actual "candidate evaluation must use corrected facts"). *Trade-off: si
TypeSafe falla, la llamada LLM ya se gastó.*

## 4. Componentes

### 4.1 `orchestrator/src/server/services/typesafe-scorer.ts` (nuevo)

Tipos:

```ts
export type TypesafeFitResult = {
  score: number;          // 0-100 entero
  confidence: number;     // 0-1
  levelPosition: number;  // posición 0..N-1, puede ser fraccional (fit.score)
  levelLabel: string;     // etiqueta del nivel modal
  probabilities: Record<string, number>;
  model: string;          // p.ej. "jev-1.13.0"
  latencyMs: number;
};

export class TypesafeNotConfiguredError extends Error {}
export class TypesafeScoringError extends Error {}
```

Funciones:

- `resolveTypesafeApiKey({ storedApiKey })`: prioriza el setting secreto
  `typesafeApiKey` y cae al env `TYPESAFE_API_KEY` (patrón de
  `llm/credentials.ts`). Devuelve `string | null`; nunca se loguea.
- `buildFitQuestion({ instructions })`: devuelve el objeto `Score` (niveles + id
  `fit`).
- `buildFitState({ job, profile, scoringInstructions })`: objeto `state` (ver §5).
- `scoreFitWithTypeSafe({ job, profile, apiKey, model, minConfidence,
  scoringInstructions, signal }): Promise<TypesafeFitResult>`:
  1. Sin `apiKey` → `throw new TypesafeNotConfiguredError()`.
  2. `POST /v1/systemone` con `{ state, model, questions: { fit } }`,
     `Authorization: Bearer <key>` (nunca logueado), timeout (`AbortController`).
  3. Reintento con backoff ante `429`/`529` (1 reintento; documentar). Otros
     `4xx`/`5xx`/parse inválido → `TypesafeScoringError`.
  4. Lee `answers.fit` (`score`, `confidence`, `legend`, `probabilities`).
     Ausente o no numérico → `TypesafeScoringError`.
  5. Mapeo determinista: `levelPosition = fit.score` (posiblemente fraccional),
     `score = round(levelPosition / (N - 1) * 100)` (`N = 5` ⇒ ×25), y
     `levelLabel = legend[String(argmax(probabilities))]` (la etiqueta del nivel con
     mayor probabilidad).
  6. Devuelve `TypesafeFitResult`.

El mapeo y la lectura de la respuesta son **funciones puras exportadas** para poder
testearlas en aislamiento sin red (TDD).

### 4.2 `scorer.ts` (editar)

- `SuitabilityResult` añade `confidence: number | null`.
- En `scoreJobSuitability`, tras aplicar patches y tener `patchedJob`:
  - si `settings.typesafeScoringEnabled`:
    - `const fit = await scoreFitWithTypeSafe(...)`
    - `score = fit.score` (se descarta el del LLM)
    - `confidence = fit.confidence`
    - `TypesafeNotConfiguredError` → `throw new LlmNotConfiguredError(<msg que apunta
      a Settings → Integrations>)`.
    - `TypesafeScoringError` → `throw new ScoringUnavailableError(...)`.
  - si no: `confidence = null`, comportamiento actual.
- `applySalaryPenalty` se aplica igual (sobre el score efectivo).
- `withHostedUsageReservation({ action: "tailoring" })` se mantiene; **una unidad por
  job**.

### 4.3 `pipeline/steps/score-jobs.ts` (editar)

- Pasa a `updateJob` el nuevo campo `suitabilityConfidence`.
- `shouldAutoSkip` añade `&& (confidence === null || confidence >=
  settings.typesafeMinConfidence)`. Es decir: en modo TypeSafe con confianza baja, no
  se auto-skip aunque el score esté bajo el umbral.

## 5. La pregunta TypeSafe

`state` (nombres en JSON, referenciados con backticks en `instructions`):

```jsonc
{
  "job": {
    "title": "...", "employer": "...", "location": "...", "salary": "...",
    "job_type": "...", "work_from_home_type": "...", "job_description": "<texto plano, truncado>"
  },
  "candidate_profile": { /* mismo sanitizeProfileForPrompt(): sin nombre/email/teléfono/enlaces */ },
  "scoring_instructions": "<scoringInstructions o ''>"
}
```

Pregunta (una sola, `id: "fit"`, tipo `score`):

- `instructions`: "How well does this candidate fit this job? Judge stack, seniority,
  domain, location/remote, and the stated conditions against `candidate_profile`." +
  (si existen) las `scoring_instructions` del usuario.
- `criteria` (5 niveles descriptivos, inglés como el resto del scorer):
  - 0 "No fit: role, stack, or location fundamentally incompatible"
  - 1 "Poor fit: most requirements unmet"
  - 2 "Partial fit: meets essentials with notable gaps"
  - 3 "Good fit: meets nearly all relevant requirements"
  - 4 "Excellent fit: ideal role, stack-matched, conditions aligned"

Respuesta: `answers.fit.score` (0–4) ×25 → 0–100; `answers.fit.confidence`.

## 6. Settings (nuevos keys, por tenant)

En `shared/src/settings-registry.ts`:

| key | kind | default | envKey |
|---|---|---|---|
| `typesafeScoringEnabled` | typed `boolean` | `false` | — |
| `typesafeApiKey` | `secret` | — | `TYPESAFE_API_KEY` |
| `typesafeMinConfidence` | typed `number` 0..1 | `0.7` | — |
| `typesafeModel` | typed `string` | `"jev-latest"` | — |

UI: bloque en Settings → Integrations (toggle + umbral; la key se trata como los demás
secretos). Cambios de settings quedan tenant-scoped por el repositorio existente.

## 7. Persistencia

- `orchestrator/src/server/db/migrate.ts`: migración idempotente que añade
  `suitability_confidence REAL` a `jobs` (patrón de las migraciones existentes).
- `orchestrator/src/server/db/schema.ts`: `suitabilityConfidence:
  real("suitability_confidence")`.
- `shared/src/types/jobs.ts`: `Job.suitabilityConfidence: number | null` y añadirlo a
  `JobListItem`.
- `orchestrator/src/server/repositories/jobs.ts`: mapear la columna al leer (los
  puntos donde hoy se mapea `suitabilityScore`) y aceptarla en updates.
- `orchestrator/src/server/api/routes/jobs/shared.ts` (`toJobListItem`): exponerla.
- Valor `null` cuando no es scoring TypeSafe o no aplica.

## 8. Errores, degradación y hosted

- **Sin fallback** al score del LLM.
- Sin key → `LlmNotConfiguredError` (pausa la pipeline con mensaje accionable, igual que
  hoy cuando el LLM está mal configurado).
- Fallo TypeSafe (red/HTTP/parse) → `ScoringUnavailableError` (job sin score; el pool
  continúa; se reintenta en el próximo run).
- Reintentos: `429`/`529` con backoff; timeout con `AbortController`.
- `withHostedUsageReservation({ action: "tailoring" })` sin cambios; una unidad por job.
- Logging (`@infra/logger`): `provider`, `model`, `score`, `confidence`, `level`,
  `latencyMs`, `jobId`, `requestId`. La key y el header `Authorization` nunca se
  loguean; errores pasan por `sanitizeUnknown`/redacción.

## 9. Seguridad, PII y multi-tenancy

- El `state` reutiliza `sanitizeProfileForPrompt()` (sin `basics.email`, `phone`,
  `url`, ni enlaces de `profiles`). Mismo nivel de PII que el payload LLM actual.
- La key vive en settings secretos por tenant (o env). No se devuelve al cliente.
- Todo el flujo es tenant-scoped por el repositorio de settings/jobs existente; el
  score y la confianza se escriben en el job del tenant activo.
- Sin nuevas rutas públicas; el toggle se expone por `PATCH /api/settings` (contrato
  existente).

## 10. Plan de tests (TDD — primero el test que falla)

`typesafe-scorer.test.ts` (fetch mockeado):
1. Sin key → `TypesafeNotConfiguredError`.
2. Respuesta válida → `score` mapeado (nivel 3 ⇒ 75), `confidence`, `levelLabel`.
3. `401` → `TypesafeScoringError`.
4. `429` → reintenta y luego `TypesafeScoringError` (o éxito en el reintento).
5. JSON inválido / sin `answers.fit` → `TypesafeScoringError`.
6. Confianza baja se propaga tal cual (no altera `score`).

`scorer.test.ts`:
7. `typesafeScoringEnabled=false` → comportamiento actual, `confidence === null`.
8. `=true` → usa el score de TypeSafe (≠ score del LLM) y su confianza.
9. `TypesafeNotConfiguredError` → `LlmNotConfiguredError`.
10. `TypesafeScoringError` → `ScoringUnavailableError`.

`score-jobs.test.ts`:
11. Confianza < umbral ⇒ NO se auto-skip aunque el score < umbral.
12. Confianza ≥ umbral ⇒ auto-skip como hoy.
13. Persiste `suitabilityConfidence`.

`settings-registry.test.ts` / `settings-schema.test.ts`:
14. Defaults (`false`, `0.7`, `"jev-latest"`) y validación del rango 0..1.

Migración/repositorio:
15. La migración añade la columna de forma idempotente.
16. Round-trip de `suitabilityConfidence` en el repositorio.

## 11. Docs

- `docs-site/docs/features/settings.md`: nuevo bloque "AI scoring with TypeSafe"
  (estructura de 5 secciones + frontmatter `id/title/description/sidebar_position`).
- `docs-site/docs/features/orchestrator.md`: nota del scoring step si aplica.

## 12. Fuera de alcance

- Cambiar el contrato `score` 0–100 o migrar jobs existentes.
- Quitar el `score` del prompt/schema del LLM (refinamiento posterior, opción C).
- Interfaz genérica de proveedor de scoring (opción B, YAGNI).
- UI de cliente más allá de Settings.

## 13. Verificación (CI-parity, AGENTS.md)

`./orchestrator/node_modules/.bin/biome ci .` · `npm run check:types:shared` ·
`npm --workspace orchestrator run check:types` · `npm --workspace
gradcracker-extractor run check:types` · `npm --workspace ukvisajobs-extractor run
check:types` · `npm --workspace orchestrator run build:client` · `npm --workspace
orchestrator run test:run`.
