# Informe de evaluación y cadencia de follow-ups — Diseño

- **Fecha**: 2026-10-26
- **Estado**: borrador para revisión (reescrito tras el grilling)
- **Alcance**: `orchestrator` + `shared` (job-ops). No toca `career-ops`.
- **Skills**: brainstorming → grill-me (dos rondas) → writing-plans → test-driven-development.

## 1. Contexto y objetivo

Un usuario final que busca trabajo no debería necesitar una TUI, un segundo puerto ni saber
qué es un MCP. La pregunta que originó este diseño era si convenía exponer `career-ops` como
endpoint o servidor MCP para mostrarlo dentro de job-ops.

La respuesta es que **no hace falta**. De las cinco necesidades reales de un usuario no
técnico, job-ops ya resuelve dos completas y una a medias:

| Necesidad | job-ops hoy | career-ops hoy | Qué se hace aquí |
|---|---|---|---|
| Buscar posiciones | Extractores + pipeline + watchlist | `scan.mjs` + `portals.yml` | Nada. Ya está cubierto. |
| ¿Mi CV encaja? | `suitabilityScore`, `suitabilityConfidence`, `suitabilityReason`, `jobBrief` | Informe A-F con evidencia JD↔CV, gaps | **Informe de evaluación** (§5.1) |
| Control de aplicaciones | `stage_events`, `tasks`, `interviews`, `outcome`, timeline | Tabla `applications.md` | Nada. job-ops es más rico. |
| Aplicar | No existe | `modes/apply.md` es asistente, no auto-apply | Fuera de alcance (§12) |
| Follow-ups | Tipo de tarea `follow_up`, sin reglas | `followup-cadence.mjs` | **Cadencia de follow-ups** (§5.2) |

Objetivo: que el usuario vea, dentro de job-ops y en una sola app, **por qué** un job le
encaja (no sólo un número) y **a quién** le toca escribir hoy.

## 2. Decisiones cerradas

Del brainstorming:

1. **Se porta a job-ops.** Nada de sidecar REST, MCP, segundo proceso ni segundo puerto.
2. **El informe vive en columnas de `jobs`**, no en `job_documents` ni en un `reports/` en
   disco. Hay precedente (`jobBrief`, `tailoredSummary`) y las consultas de lista usan una
   `selection` explícita, así que el markdown no se carga al listar.
3. **Una sola llamada al LLM por informe.** Sin SSE: no hay progreso intermedio que mostrar.
4. **La cadencia es cálculo puro en lectura.** Sin cron, sin job de fondo, sin estado propio.

Del grilling, con su motivo:

5. **Fuera el asistente de respuestas de formulario.** No cumple lo que se pedía ("rellena,
   tú envías"), no tiene disparador y depende del informe que aún no existe. Vuelve en otra
   spec. Esta queda en **dos** features.
6. **Comp no se genera.** Un LLM sin herramientas inventa rangos salariales. Se toma
   `job.salary` cuando existe y se muestra "no verificado" cuando no.
7. **Legitimidad pasa a "señales de la oferta"**: deadline vencido, sin URL de empleador, sin
   salario, descripción muy corta. Todo verificable con lo que ya está en la fila.
8. **Sin fingerprint de obsolescencia.** El perfil viene de RxResume y no tiene fecha fiable
   (`routes/profile.ts:6,38`), y job-ops no debe inventar una. Se guarda y se muestra la fecha
   de generación; el usuario decide si está viejo. Esto elimina también la discusión sobre si
   la plantilla del prompt entra en el hash.
9. **Fechas concretas, no "en N días".** `nextDueOn` es una fecha local `YYYY-MM-DD`; la UI
   muestra "3 nov". Se acaba el redondeo de 24 h que marcaba vencido algo que vence mañana.
10. **Sin tope de follow-ups.** La cadencia continúa mientras el job esté abierto; el usuario
    decide cuándo parar. Desaparece el estado "agotado".
11. **Un job descartado por score puede recibir informe**, y si el veredicto es "apply" el
    panel ofrece devolverlo a `ready`. Acción explícita, nunca automática.
12. **Sólo POST.** El detalle del job ya trae el informe; un GET dedicado sería superficie
    muerta y la descarga como archivo queda fuera.
13. **Generación sólo manual**, un botón por job. Sin lote ni disparo automático al pasar a
    `ready`; multiplicar el costo por cada vacante del pipeline no está justificado.
14. **El score manda; el informe explica.** `suitabilityScore` sigue siendo el número. El
    desglose A-F lo explica. Si el veredicto lo contradice, se muestra discrepancia explícita:
    no se promedia ni se esconde.
15. **Compare-and-set para el flag.** Leer y luego escribir permite dos generaciones
    simultáneas. Se usa un `UPDATE ... WHERE generating = 0` con comprobación de filas.
16. **Lock con vencimiento de 5 minutos.** No hay barrido al arrancar: `pdfRegenerating` se
    limpia dentro del flujo del pipeline (`pipeline/orchestrator.ts:891-1007`), no en el boot.
    Un crash dejaría el job bloqueado para siempre.
17. **`idempotencyKey` en la reserva de uso hosted**: `${tenantId}:${jobId}:${model}`. Un
    reintento del mismo informe no vuelve a cobrar.
18. **`JobDetail extends Job`.** Los campos del informe no entran en `Job`, así que `createJob`
    (`shared/src/testing/factories.ts:11`) y los ~25 sitios que construyen el tipo siguen
    igual.
19. **`basis` y `confidence` en el schema.** Un "apply" basado en un anuncio de tres líneas no
    se presenta con la misma autoridad que uno basado en una descripción completa.
20. **Tests obligatorios de concurrencia y lock vencido**, además de los de mapeo.

## 3. Arquitectura

```
routes/jobs/evaluation.ts                        (nuevo)
  └── POST /api/jobs/:id/evaluation
        ├── jobsRepo.beginEvaluationIfIdle(id)   [NUEVO: UPDATE ... WHERE generating = 0]
        ├── evaluationReport.generateEvaluationReport({ job, profile })
        │      ├── createConfiguredLlmService / resolveLlmModel
        │      ├── sanitizeProfileForPrompt + filterProfileProjectsForAi
        │      ├── withHostedUsageReservation({ idempotencyKey })
        │      └── devuelve { markdown, model } sin tocar la base de datos
        └── la ruta persiste markdown + fecha + modelo y baja el flag

routes/follow-ups.ts                             (nuevo)
  └── GET /api/follow-ups
        ├── jobsRepo.listOpenApplications(scope)
        ├── applicationTracking.getStageEvents(jobId)
        ├── applicationTracking.getTasks(jobId, true)
        └── followupCadence.computeFollowupState(input)   [NUEVO, función pura]
```

Todo en el mismo proceso de Express y la misma SQLite. Ninguna ruta nueva se monta fuera de
`/api`, así que hereda auth y tenant.

## 4. Datos

### 4.1 Columnas nuevas en `jobs`

Migración aditiva con el guard `tableHasColumn` que ya usa `migrate.ts`.

| Columna | Tipo | Default | Propósito |
|---|---|---|---|
| `evaluation_report` | TEXT | NULL | Informe en markdown |
| `evaluation_report_generated_at` | TEXT | NULL | Fecha de generación que ve el usuario |
| `evaluation_report_model` | TEXT | NULL | Modelo usado; parte de la clave de idempotencia |
| `evaluation_report_meta` | TEXT | NULL | JSON con `verdict`, `basis`, `confidence` |
| `evaluation_report_generating` | INTEGER | 0 | Lock con vencimiento |

`updated_at` de la fila hace de reloj del lock: si `evaluation_report_generating = 1` y
`updated_at` tiene más de 5 minutos, la siguiente petición toma el control.

No hay columnas de respuestas de formulario, ni de fingerprint.

### 4.2 Tipos compartidos

`shared/src/types/jobs.ts`:

```ts
export interface EvaluationReportMeta {
  basis: "full_jd" | "partial_jd" | "minimal_jd";
  confidence: number; // 0-1
  verdict: "apply" | "consider" | "skip";
}

// `generatedAt` y `model` viven en sus columnas (`evaluation_report_generated_at`,
// `evaluation_report_model`), no en el JSON de meta.
export interface JobDetail extends Job {
  evaluationReport: string | null;
  evaluationReportGeneratedAt: string | null;
  evaluationReportModel: string | null;
  evaluationReportMeta: EvaluationReportMeta | null;
  evaluationReportGenerating: boolean;
}

export type FollowupItem = {
  jobId: string;
  employer: string;
  title: string;
  jobUrl: string;
  stage: ApplicationStage;
  appliedAt: string;   // ISO, igual que en Job
  nextDueOn: string;   // YYYY-MM-DD en calendario local
  status: "due" | "upcoming";
  step: number;        // follow-ups ya enviados
};

export type FollowupsResponse = { due: FollowupItem[]; upcoming: FollowupItem[] };
```

`JobListItem` no cambia. `mapRowToJob` sigue devolviendo `Job`; un `mapRowToJobDetail` nuevo
devuelve `JobDetail` y parsea `evaluationReportMeta` desde columnas, con fallback a `null`
si el JSON es inválido en vez de lanzar. La ruta de detalle (`GET /api/jobs/:id`) pasa a
devolver `JobDetail`; el resto de rutas sigue con `Job`.

## 5. Componentes

### 5.1 `orchestrator/src/server/services/evaluation-report.ts` (nuevo)

```ts
export class EvaluationReportNotApplicableError extends Error {}

export async function generateEvaluationReport(input: {
  job: Job;
  profile: Profile;
}): Promise<{ markdown: string; model: string; meta: EvaluationReportMeta }>;

export function renderEvaluationMarkdown(input: {
  result: EvaluationReportResult;
  job: Job;
}): string;
```

Salida estructurada del LLM (`JsonSchemaDefinition`, como en `scorer.ts`):

```json
{
  "verdict": "apply | consider | skip",
  "summary": "string",
  "scoreBreakdown": {
    "match": 0, "northStar": 0, "comp": null, "culture": 0, "redFlags": 0
  },
  "evidence": [
    { "requirement": "string", "cvMatch": "strong | partial | gap", "evidence": "string" }
  ],
  "gaps": ["string"],
  "basis": "full_jd | partial_jd | minimal_jd",
  "confidence": 0
}
```

Reglas del schema:

- `scoreBreakdown.comp` es `null` cuando `job.salary` es nulo. Sin dato salarial no se puntúa
  compensación; la UI muestra "—" en lugar de un número inventado.
- **Comp no lo escribe el LLM.** El markdown toma `job.salary` literal o "no verificado".
- **Legitimidad no la escribe el LLM.** `renderEvaluationMarkdown` calcula las señales con
  datos de la fila: deadline anterior a hoy, `employerUrl` nulo, `salary` nulo, descripción de
  menos de 400 caracteres.
- `basis` se valida contra el tamaño real de `jobDescription` en el servicio; si el LLM
  devuelve `full_jd` con 200 caracteres de descripción, se degrada a `minimal_jd`.
- `confidence` se acota a `[0, 1]` y se guarda; no altera el `suitabilityScore`.

`renderEvaluationMarkdown` produce encabezados estables: `## Veredicto`,
`## Evidencia JD ↔ CV`, `## Gaps`, `## Compensación`, `## Señales de la oferta`.

Errores: `EvaluationReportNotApplicableError` si no hay `jobDescription`; los fallos de
configuración del LLM se propagan tal cual (`isConfigurationFailure`) para mapearlos a 503.

### 5.2 `orchestrator/src/server/services/followup-cadence.ts` (nuevo)

Función pura, sin imports de base de datos ni de relojes: `now` se inyecta.

```ts
export const FOLLOWUP_RULES = {
  appliedFirstDays: 7,
  appliedSubsequentDays: 7,
  respondedFirstDays: 1,
  respondedSubsequentDays: 3,
  interviewThankYouDays: 1,
} as const;

// `appliedAt`, `lastContactAt` y `now` en epoch **segundos**, igual que
// `tasks.due_date` y `stage_events.occurred_at` (formatTimestamp multiplica por 1000).
// El contrato HTTP expone `appliedAt` en ISO y `nextDueOn` como `YYYY-MM-DD`.
export type FollowupComputeInput = {
  stage: ApplicationStage;
  outcome: JobOutcome | null;
  appliedAt: number;
  // max(appliedAt, último stage_event.occurredAt). Las tareas no tienen timestamps
  // (`tasks` no tiene created_at), así que el contacto se registra como stage_event.
  followUpsSent: number;
  now: number;
};

export type FollowupComputation =
  | { status: "not_applicable"; reason: "closed" | "not_started" }
  | { status: "due" | "upcoming"; nextDueOn: string; step: number };

export function computeFollowupState(input: FollowupComputeInput): FollowupComputation;
```

Reglas por etapa:

| Etapa | Día del primer follow-up | Siguientes |
|---|---|---|
| `applied` | 7 | 7 |
| `recruiter_screen`, `assessment`, `hiring_manager_screen` | 1 | 3 |
| `technical_interview`, `onsite`, `offer` | 1 (agradecimiento) | 3 |
| `closed`, o `outcome !== null` | `not_applicable` | — |

**Supuesto declarado:** career-ops sólo definía el agradecimiento de entrevista, sin día
siguiente. Aquí los follow-ups posteriores a la entrevista usan 3 días, el mismo intervalo que
"respondió", para que un job en proceso no desaparezca de la página. Es una decisión de
implementación, no una herencia; se documenta y es revisable.

Aritmética de fechas, sin redondeos:

```ts
const startOfLocalDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const formatLocalDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

nextDueOn = formatLocalDate(addDays(startOfLocalDay(lastContactAt), days));
status    = nextDueOn <= formatLocalDate(now) ? "due" : "upcoming";
```

La comparación es lexicográfica sobre `YYYY-MM-DD`, que para ISO es correcta. Si el cálculo cae
en el pasado (por ejemplo, se registró ayer una respuesta que ocurrió hace cinco días), el
estado es `due` y la fecha mostrada es la real: "vencido desde el 2 nov", no una fecha mañana.

## 6. API

| Método | Ruta | Éxito | Errores |
|---|---|---|---|
| POST | `/api/jobs/:id/evaluation` | `202 { jobId, status: "generating" }` | 404, 409, 422, 502, 503 |
| GET | `/api/follow-ups` | `200 FollowupsResponse` | — |
| POST | `/api/jobs/:id/tasks` | `201 ApplicationTask` | 404, 422 |
| PATCH | `/api/jobs/:id/tasks/:taskId` | `200 ApplicationTask` | 404, 422 |

POST de evaluación:

1. Carga el job con scope de tenant; si no existe → `notFound`.
2. Si no hay `jobDescription` → `unprocessableEntity`.
3. `beginEvaluationIfIdle(id)`:
   `UPDATE jobs SET evaluation_report_generating = 1, updated_at = now WHERE id = ? AND tenant_id = ? AND (evaluation_report_generating = 0 OR updated_at < now - 5min)`.
   Si afecta 0 filas → `conflict("Ya hay un informe en curso")`.
4. Responde `202` y genera en segundo plano.
5. Al terminar: persiste markdown, meta, `generated_at`, modelo y baja el flag.
6. Si falla: baja el flag siempre (`finally`), no persiste informe parcial, y el error va al
   log con `requestId`, nunca al cliente con el body del proveedor.

La idempotencia de cobro se pasa a `withHostedUsageReservation` como
`${tenantId}:${jobId}:${model}`, dentro del trabajo posterior al compare-and-set.

### 6.1 Endpoints de tareas (nuevos, no existían)

`tasks` sólo tenía lectura (`GET /api/jobs/:id/tasks` en `routes/jobs/stages.ts:34`); no hay
ninguna escritura de tareas en el servidor. La cadencia necesita crear y completar tareas, así
que entra en esta feature:

| Método | Ruta | Cuerpo | Devuelve |
|---|---|---|---|
| POST | `/api/jobs/:id/tasks` | `{ type, title, dueDate, notes? }` | `201 ApplicationTask` |
| PATCH | `/api/jobs/:id/tasks/:taskId` | `{ isCompleted?, dueDate?, notes? }` | `200 ApplicationTask` |

Ambas validan con Zod (`type` contra `APPLICATION_TASK_TYPES`), comprueban que el job y la tarea
pertenecen al tenant (`notFound` si no), y usan `applicationTracking.ts` como única puerta a la
tabla. `dueDate` va en segundos, como el resto del dominio. El sidebar del job ya renderiza
"Upcoming tasks" (`JobPageRightSidebar.tsx:288`), así que las tareas creadas por la cadencia
aparecen ahí sin tocar esa vista.

El "follow-up enviado" no modifica la etapa: se registra con
`transitionStage(id, "no_change", ts, { eventType: "note", eventLabel: "Follow-up enviado" })`,
que ya existe y acepta notas sin cambiar de etapa.

## 7. UI

- **`JobEvaluationPanel.tsx`** (nuevo, `client/pages/job-page/`): veredicto con `basis` y
  `confidence`, desglose A-F (con "—" en comp cuando no hay salario), informe renderizado con
  `JobDescriptionMarkdown`, gaps, señales de la oferta, fecha de generación y botón
  Generar/Regenerar.
- **Discrepancia**: si `verdict === "apply"` y `status === "skipped"`, el panel muestra un aviso
  con la acción **"Devolver a ready"**. Si el veredicto y el score se contradicen, se dice
  explícitamente; no se reordena nada ni se cambia el score.
- **Vista nueva en `JobPage`**: `evaluation`, siguiendo `normalizeMemoryView`
  (`JobPage.tsx:91`) y la navegación lateral. Ruta `/job/:id/evaluation`.
- **`FollowupsPage.tsx`** (nuevo): bloques **Vencidos** y **Próximos**, ordenados por
  `nextDueOn`. Cada fila muestra empresa, rol, etapa, fecha de aplicación, `nextDueOn` como
  fecha ("3 nov") y dos acciones: **Programar** (crea tarea `follow_up` con `dueDate` en
  segundos) y **Marcar enviado** (crea la tarea ya completada **y** registra un `stage_event`
  con `eventType: "note"` y título "Follow-up enviado", que es lo que mueve `lastContactAt`
  y aparece en el timeline). No hay bloque de agotados.
- Botones deshabilitados con `TooltipWhenDisabled` y su motivo ("falta la descripción del job").

## 8. Score frente a informe

`job-ops` calcula `suitabilityScore` en el pipeline y puede descartar un job por
`autoSkipScoreThreshold` (`pipeline/steps/score-jobs.ts:169-175`) antes de que exista informe.

Reglas acordadas:

- El `suitabilityScore` **no se toca**. Es el número que ordena y el que decide el auto-skip.
- El desglose A-F es explicación; no se convierte en score ni se promedia con él.
- Un job `skipped` **puede** recibir informe, y un veredicto "apply" ofrece devolverlo a
  `ready` con una acción explícita del usuario.
- Cuando veredicto y score discrepan, se muestra la discrepancia en el panel. No se oculta ni
  se resuelve por el usuario.

## 9. Multi-tenancy, logs y payload externo

- **Tenancy**: todo pasa por las funciones existentes del repositorio y por los
  `*ScopeFilter()` / `getPrivateDataScope()`. El compare-and-set incluye `tenant_id` en el
  `WHERE`, no sólo `id`.
- **Sin estado de tenant en memoria**: el lock vive en la fila del job.
- **Logs** (`infra/logger`, nunca `console`): `{ requestId, jobId, route, status, model,
  durationMs, outcome, lockTakenOver }`. Nunca el prompt, el CV ni el informe.
- **Payload al LLM**: sólo `jobDescription`, los campos que ya filtra `sanitizeProfileForPrompt`
  y los proyectos que deja `filterProfileProjectsForAi`. Nada de historial, notas ni emails.
- **Errores**: body del proveedor envuelto con `upstreamError` y `details` saneados.

## 10. Pruebas

| Archivo | Qué cubre |
|---|---|
| `services/followup-cadence.test.ts` (nuevo) | 7/7 en aplicado; 1/3 en respondido; 1/3 en entrevista; `closed`/`outcome` → `not_applicable`; `nextDueOn` en calendario local; fecha pasada → `due` con la fecha real; sin tope (10 follow-ups siguen programando) |
| `services/evaluation-report.test.ts` (nuevo) | Prompt con perfil saneado; JSON válido → markdown con las 5 secciones; job sin descripción lanza `EvaluationReportNotApplicableError`; `basis` degradado si la descripción es corta; `comp` es `null` sin `salary` y el markdown dice "no verificado"; `confidence` acotado a 0-1 |
| `api/routes/jobs.evaluation.test.ts` (nuevo) | 202 + flag a 1; **dos POST concurrentes → una sola llamada al LLM (test de concurrencia)**; **flag viejo (>5 min) → toma de control (test de lock vencido)**; 409 con lock fresco; 422 sin descripción; 404 job de otro tenant; flag vuelve a 0 tras fallo; `{ ok, meta.requestId }` y header `x-request-id` |
| `api/routes/follow-ups.test.ts` (nuevo) | Agrupa en due/upcoming; excluye cerrados; cuenta follow-ups completados; `nextDueOn` como `YYYY-MM-DD` |
| `api/routes/tenant-isolation.test.ts` (extender) | El informe del tenant A no es legible desde el tenant B; el compare-and-set no cruza tenants |
| `client/pages/job-page/JobEvaluationPanel.test.tsx` (nuevo) | Vacío, generando, informe renderizado, `basis`/`confidence` visibles, aviso de discrepancia con acción de reabrir |

Los tests de ruta siguen el patrón de `routes/test-utils.ts`. No se añade un test de factory
para `JobDetail`: al ser un tipo separado, `createJob` no cambia.

## 11. Documentación

Dos páginas nuevas en `docs-site/docs/features/`, con frontmatter `id`, `title`, `description`,
`sidebar_position` y la estructura de cinco secciones:

- `evaluation-report.md` — qué es, por qué existe, cómo usarlo (generar, leer, devolver a
  ready), qué se envía al LLM y qué **no** se genera (comp y legitimidad son datos, no
  invenciones), problemas comunes (LLM sin configurar, job sin descripción, "el informe está
  viejo porque cambió mi CV"), páginas relacionadas.
- `follow-ups.md` — qué es, por qué existe, cómo usarlo (programar, marcar enviado), la tabla de
  cadencia, por qué no hay tope, problemas comunes, relacionadas.

Enlazar desde `docs-site/docs/features/overview.md`.

Además, al añadir `evaluationReportPromptTemplate` a `PROMPT_TEMPLATE_DEFINITIONS`, revisar
`client/pages/settings/components/PromptTemplatesSection.test.tsx`, que enumera las plantillas.

## 12. Fuera de alcance

- Asistente de respuestas de formulario y relleno en navegador (base disponible:
  `challenge-viewer.ts`, `xvfb`/`x11vnc`/`noVNC` en `Dockerfile:153`).
- Envío de emails de follow-up.
- Generación en lote o automática al pasar a `ready`.
- Detección de obsolescencia por fingerprint.
- Descarga del informe como archivo.
- Historial de versiones del informe.
- Modos `scan`, `batch`, `apply`, `deep` de career-ops y cualquier sidecar REST o MCP.

## 13. Riesgos

| Riesgo | Mitigación |
|---|---|
| El usuario lee un informe viejo sin saberlo | `evaluationReportMeta.generatedAt` visible y fecha en el panel; sin detección automática, por decisión 8 |
| Coste de regenerar por inercia | 409 con lock fresco, compare-and-set e idempotencia de cobro |
| Crash durante la generación | Lock de 5 minutos con toma de control; flag bajado en `finally` |
| Comp y legitimidad inventadas | No las genera el LLM: salen de `job.salary` y de señales de la fila, o se declaran no verificadas |
| El markdown crece sin control | Truncado en código tras parsear (el schema JSON no limita longitud) y fuera de las respuestas de lista |
| Cadencia de entrevista sin respaldo en career-ops | Supuesto declarado en §5.2, revisable |

## 14. Criterios de aceptación

1. Desde `/job/:id/evaluation`, un usuario no técnico genera un informe y ve veredicto, `basis`,
   `confidence`, evidencia JD↔CV, gaps, compensación y señales de la oferta, sin salir de job-ops.
2. Dos POST concurrentes producen una sola llamada al LLM; el segundo recibe 409.
3. Un flag con más de 5 minutos no bloquea: la petición toma el control y genera.
4. Un job sin descripción explica qué falta; uno de otro tenant devuelve 404.
5. Comp y legitimidad nunca aparecen inventadas: sin salario se lee "no verificado".
6. Un job `skipped` con veredicto "apply" puede volver a `ready` desde el panel, por acción del
   usuario.
7. `/follow-ups` lista vencidos y próximos con fecha concreta, sin tope de follow-ups, y permite
   programar o marcar enviado.
8. El `suitabilityScore` no cambia por generar un informe; una discrepancia se muestra.
9. Ninguna feature expone datos de otro tenant (test de aislamiento en verde).
10. `./orchestrator/node_modules/.bin/biome ci .`, los tres `check:types`, `build:client` y
    `test:run` pasan.
