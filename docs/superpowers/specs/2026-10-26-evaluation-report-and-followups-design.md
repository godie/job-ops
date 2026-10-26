# Informe de evaluación y cadencia de follow-ups — Diseño

- **Fecha**: 2026-10-26
- **Estado**: borrador para revisión
- **Alcance**: `orchestrator` + `shared` (job-ops). No toca `career-ops`.
- **Skills**: brainstorming (este diseño) → writing-plans → test-driven-development (implementación).

## 1. Contexto y objetivo

Un usuario final que busca trabajo no debería necesitar una TUI, un segundo puerto ni
saber qué es un MCP. La pregunta que originó este diseño era si convenía exponer
`career-ops` como endpoint o servidor MCP para mostrarlo dentro de job-ops.

La respuesta, tras comparar ambas herramientas, es que **no hace falta**: de las cinco
necesidades reales de un usuario no técnico, job-ops ya resuelve dos completas y una a
medias.

| Necesidad | job-ops hoy | career-ops hoy | Qué se hace aquí |
|---|---|---|---|
| Buscar posiciones | Extractores + pipeline + watchlist | `scan.mjs` + `portals.yml` | Nada. Ya está cubierto. |
| ¿Mi CV encaja? | `suitabilityScore`, `suitabilityConfidence`, `suitabilityReason`, `jobBrief` | Informe A-F con tabla de evidencia JD↔CV, gaps, comp, legitimidad | **Informe de evaluación** (sección 5.1) |
| Control de aplicaciones | `stage_events`, `tasks`, `interviews`, `outcome`, timeline | Tabla `applications.md` | Nada. job-ops es más rico. |
| Aplicar | No existe | `modes/apply.md` es asistente, no auto-apply | Fuera de alcance (sección 11) |
| Follow-ups | Tipo de tarea `follow_up`, sin reglas | `followup-cadence.mjs` con cadencia 7/7/máx 2 | **Cadencia de follow-ups** (sección 5.2) |

Objetivo: que el usuario vea, dentro de job-ops y en una sola app, **por qué** un job le
encaja (no solo un número) y **a quién** le toca escribir hoy.

## 2. Decisiones cerradas en brainstorming

1. **Se porta a job-ops.** Nada de sidecar REST, ni MCP, ni segundo proceso, ni segundo
   puerto. La lógica que falta se implementa en TypeScript dentro de `orchestrator`.
2. **Informe y respuestas viven en columnas de `jobs`**, no en `job_documents` ni en un
   `reports/` en disco. Hay precedente (`jobBrief`, `tailoredSummary`, `tailoredSkills`)
   y las consultas de lista ya usan una `selection` explícita, así que un markdown
   grande no se carga al listar. Esto evita además migrar `job_documents`.
3. **Una sola llamada al LLM por informe.** Sin SSE. El estado en vuelo se expone con
   un flag booleano, igual que `pdfRegenerating`.
4. **La cadencia es cálculo puro en lectura.** Sin cron, sin job de fondo, sin estado
   propio. La única escritura es la tarea que el usuario programa explícitamente.
5. **El asistente no rellena formularios todavía.** Genera respuestas con botón de
   copiar. El relleno con navegador visible es otra fase.
6. **job-ops no envía emails.** Un follow-up es un recordatorio con el texto listo, no
   un envío automático.
7. **El informe es editable por el usuario**, vía `PROMPT_TEMPLATE_DEFINITIONS`, igual
   que el prompt de scoring.

## 3. Arquitectura

```
routes/jobs/evaluation.ts        (nuevo)
  ├── POST /api/jobs/:id/evaluation
  │     ├── evaluationReport.generateEvaluationReport(job, profile)   [NUEVO services/evaluation-report.ts]
  │     │      ├── createConfiguredLlmService / resolveLlmModel
  │     │      ├── sanitizeProfileForPrompt + filterProfileProjectsForAi
  │     │      ├── withHostedUsageReservation
  │     │      └── devuelve { markdown, model } sin tocar la base de datos
  │     └── la ruta persiste evaluation_report + fechas + model y baja el flag
  └── GET  /api/jobs/:id/evaluation  → lee columnas del job

routes/follow-ups.ts             (nuevo)
  └── GET /api/follow-ups
        ├── jobsRepo.listActiveApplicationsForFollowups(scope)
        ├── applicationTracking.getStageEvents(jobId)
        ├── applicationTracking.getTasks(jobId, true)
        └── followupCadence.computeFollowupState(input)         [NUEVO services/followup-cadence.ts]

routes/jobs/evaluation.ts (segunda ruta)
  └── POST /api/jobs/:id/form-answers
        └── formAnswers.generateFormAnswers(job, profile, report)  [NUEVO services/form-answers.ts]
```

Todo dentro del mismo proceso de Express y la misma SQLite. Ninguna ruta nueva se monta
fuera de `/api`, así que hereda el middleware de auth y de tenant existente.

## 4. Datos

### 4.1 Columnas nuevas en `jobs`

Migración aditiva en `orchestrator/src/server/db/migrate.ts`, usando el guard
`tableHasColumn` que ya existe para el resto de columnas añadidas.

| Columna | Tipo SQL | Default | Propósito |
|---|---|---|---|
| `evaluation_report` | TEXT | NULL | Informe A-F en markdown |
| `evaluation_report_generated_at` | TEXT | NULL | Frescura del informe |
| `evaluation_report_model` | TEXT | NULL | Modelo que lo generó (reproducibilidad) |
| `evaluation_report_generating` | INTEGER | 0 | Generación en curso; sobrevive a un reload |
| `form_answers` | TEXT | NULL | JSON `[{ "question": string, "answer": string }]` |
| `form_answers_generated_at` | TEXT | NULL | Frescura de las respuestas |
| `form_answers_generating` | INTEGER | 0 | Generación en curso de las respuestas |

No se modifica ninguna columna existente ni se crean tablas nuevas.

### 4.2 Tipos compartidos

En `shared/src/types/jobs.ts`:

```ts
export interface FormAnswer {
  question: string;
  answer: string;
}

export interface Job {
  // ...campos existentes
  evaluationReport: string | null;
  evaluationReportGeneratedAt: string | null;
  evaluationReportModel: string | null;
  evaluationReportGenerating: boolean;
  formAnswers: FormAnswer[] | null;
  formAnswersGeneratedAt: string | null;
  formAnswersGenerating: boolean;
}

export type FollowupItem = {
  jobId: string;
  employer: string;
  title: string;
  jobUrl: string;
  stage: ApplicationStage;
  appliedAt: string;          // ISO, igual que en Job
  followUpsSent: number;
  maxFollowUps: number;
  step: number;               // = followUpsSent
  nextDueAt: number | null;   // epoch ms, igual que tasks.dueDate
  daysUntilDue: number | null;
  status: "due" | "upcoming" | "exhausted";
};

export type FollowupsResponse = {
  due: FollowupItem[];
  upcoming: FollowupItem[];
  exhausted: FollowupItem[];
};
```

`JobListItem` **no** incluye los campos nuevos: son de detalle. `mapRowToJob` en
`repositories/jobs.ts` los mapea, y `formAnswers` se parsea con un helper tolerante a
JSON inválido (devuelve `null` en lugar de lanzar).

## 5. Componentes

### 5.1 `orchestrator/src/server/services/evaluation-report.ts` (nuevo)

```ts
export class EvaluationReportNotApplicableError extends Error {} // job sin descripción

export async function generateEvaluationReport(input: {
  job: Job;
  profile: Profile;
}): Promise<{ markdown: string; model: string }>;

export function isEvaluationReportStale(job: Job, profileUpdatedAt: string | null): boolean;
```

- Prompt: nueva entrada `evaluationReportPromptTemplate` en
  `shared/src/prompt-template-definitions.ts`, con placeholders `profileJson`,
  `jobTitle`, `employer`, `jobDescription`, `outputLanguage`. Se renderiza con
  `renderPromptTemplate`, igual que `scorer.ts`.
- Salida: JSON con schema estricto (`JsonSchemaDefinition`, como en `scorer.ts`):

```json
{
  "verdict": "apply | consider | skip",
  "summary": "string",
  "scoreBreakdown": {
    "match": 0-5, "northStar": 0-5, "comp": 0-5, "culture": 0-5, "redFlags": 0-5
  },
  "evidence": [{ "requirement": "string", "cvMatch": "strong | partial | gap", "evidence": "string" }],
  "gaps": ["string"],
  "comp": "string",
  "legitimacy": "proceed | caution | avoid",
  "legitimacyReason": "string"
}
```

- `generateEvaluationReport` **no** toca la base de datos: devuelve markdown y modelo.
  La persistencia la hace la ruta, para que el servicio sea testeable sin migraciones.
- `renderEvaluationMarkdown(result)` (exportada y testeada aparte) produce las secciones
  con encabezados estables: `## Veredicto`, `## Evidencia JD ↔ CV`, `## Gaps`,
  `## Compensación`, `## Legitimidad`.
- `isEvaluationReportStale` compara `evaluationReportGeneratedAt` contra la fecha de
  actualización del perfil; si el perfil cambió después, el informe es viejo.
- Errores: si el job no tiene `jobDescription`, lanza
  `EvaluationReportNotApplicableError`; si el LLM no está configurado, se propaga el
  error de configuración existente (`isConfigurationFailure`) para mapearlo a 503.

### 5.2 `orchestrator/src/server/services/followup-cadence.ts` (nuevo)

Función pura, sin imports de base de datos.

```ts
export const FOLLOWUP_RULES = {
  appliedFirstDays: 7,
  appliedSubsequentDays: 7,
  appliedMaxFollowUps: 2,
  respondedFirstDays: 1,
  respondedSubsequentDays: 3,
  interviewThankYouDays: 1,
} as const;

export type FollowupComputeInput = {
  stage: ApplicationStage;
  outcome: JobOutcome | null;
  appliedAt: number;
  lastContactAt: number; // max(último stage_event.occurredAt, última tarea follow_up completada)
  followUpsSent: number; // tareas type=follow_up completadas
  now: number;           // inyectado para poder testear
};

export type FollowupComputation =
  | { status: "not_applicable"; reason: "closed" | "not_started" }
  | { status: "exhausted"; followUpsSent: number; maxFollowUps: number }
  | {
      status: "due" | "upcoming";
      nextDueAt: number;
      daysUntilDue: number;
      step: number;
      followUpsSent: number;
      maxFollowUps: number;
    };

export function computeFollowupState(input: FollowupComputeInput): FollowupComputation;
```

Mapeo de etapas de job-ops a la cadencia de career-ops (job-ops tiene etapas más finas):

| Etapa de job-ops | Regla aplicada |
|---|---|
| `applied` | 7 días la primera, 7 las siguientes, máximo 2 |
| `recruiter_screen`, `assessment`, `hiring_manager_screen` | 1 día la inicial, 3 las siguientes |
| `technical_interview`, `onsite`, `offer` | 1 día (agradecimiento) |
| `closed`, o `outcome !== null` | `not_applicable` |

Fórmula, explícita para no dejar ambigüedad:

```
step          = followUpsSent
firstDays     = etapa respondida ? 1 : 7
subsequentDays = etapa respondida ? 3 : 7
days          = step === 0 ? firstDays : subsequentDays
nextDueAt     = lastContactAt + days * 86_400_000
daysUntilDue  = floor((nextDueAt - now) / 86_400_000)
status        = nextDueAt <= now ? "due" : "upcoming"
```

Si `followUpsSent >= maxFollowUps` → `exhausted`, sin `nextDueAt`.
`daysUntilDue` se calcula sobre días naturales (no horas) para que "vence hoy" sea
estable y no cambie a mitad del día según la zona horaria.

### 5.3 `orchestrator/src/server/services/form-answers.ts` (nuevo)

```ts
export async function generateFormAnswers(input: {
  job: Job;
  profile: Profile;
  evaluationReport: string; // requerido
}): Promise<{ answers: FormAnswer[]; model: string }>;
```

- Una llamada al LLM con schema `{ answers: [{ question, answer }] }`.
- Preguntas base fijas (por qué te interesa, expectativa salarial, autorización de
  trabajo / sponsorship, disponibilidad, notice period) más las que se puedan inferir
  de la descripción del job.
- Prohibido inventar experiencia: la instrucción del prompt lo dice explícitamente y el
  informe es la fuente de la evidencia.
- Lanza `FormAnswersRequireReportError` si no hay informe.

## 6. API

Rutas nuevas (montadas desde `routes/jobs/index.ts` y `routes/index.ts`):

| Método | Ruta | Éxito | Errores |
|---|---|---|---|
| POST | `/api/jobs/:id/evaluation` | `202 { jobId, status: "generating" }` | 404, 409, 422, 502, 503 |
| GET | `/api/jobs/:id/evaluation` | `200 { markdown, generatedAt, model, stale }` o `data: null` | 404 |
| POST | `/api/jobs/:id/form-answers` | `202 { jobId, status: "generating" }` | 404, 409, 422, 502, 503 |
| GET | `/api/follow-ups` | `200 FollowupsResponse` | — |

Comportamiento del POST de evaluación:

1. Carga el job con scope de tenant; si no existe → `notFound`.
2. Si `evaluationReportGenerating` es `true` → `conflict("Ya hay un informe en curso")`.
3. Si no hay `jobDescription` → `unprocessableEntity("Este job no tiene descripción...")`.
4. Marca `evaluationReportGenerating = 1` y responde `202` **antes** de generar.
5. En segundo plano: genera, persiste markdown + fecha + modelo, baja el flag.
6. Si falla: baja el flag y registra el error. No se persiste un informe parcial.

El estado en vuelo lo consulta el cliente con la query del job (`evaluationReportGenerating`),
que ya se refresca al hacer foco. No hay endpoint de progreso.

## 7. UI

- **`JobEvaluationPanel.tsx`** (nuevo, en `orchestrator/src/client/pages/job-page/`):
  veredicto y desglose, informe renderizado con `JobDescriptionMarkdown`, gaps,
  legitimidad, aviso de "informe desactualizado", botón Generar/Regenerar, y la lista de
  respuestas de formulario con botón de copiar por respuesta.
- **Vista nueva en `JobPage`**: `evaluation`, siguiendo el patrón de `normalizeMemoryView`
  (`JobPage.tsx:92`) y la navegación lateral existente. Ruta `/job/:id/evaluation`.
- **`FollowupsPage.tsx`** (nuevo, en `orchestrator/src/client/pages/`): tres bloques —
  Vencidos, Próximos, Agotados — con empresa, rol, días desde la aplicación, estado y dos
  acciones: **Programar** (crea tarea `follow_up` con `dueDate`) y **Marcar enviado**
  (crea la tarea ya completada). Entrada en la navegación principal.
- Los botones deshabilitados usan `TooltipWhenDisabled` con el motivo (por ejemplo, "falta
  la descripción del job"), que es el patrón existente en la app.

## 8. Multi-tenancy, logs y payload externo

- **Tenancy**: lecturas y escrituras usan las funciones existentes y
  `getPrivateDataScope()` / los `*ScopeFilter()` del repositorio. No se introduce ninguna
  caché módulo-nivel; el estado vive en la fila del job.
- **Logs** (`infra/logger`, nunca `console`): un evento por generación con
  `{ requestId, jobId, route, status, model, durationMs, outcome }`. **Nunca** se loguea el
  prompt, el CV ni el informe completo.
- **Payload al LLM**: solo `jobDescription`, los campos del perfil que ya filtra
  `sanitizeProfileForPrompt` y los proyectos que deja `filterProfileProjectsForAi`. Nada
  de historial de aplicaciones ni de emails.
- **Errores**: los cuerpos del proveedor se envuelven con `upstreamError` y `details`
  saneados; no se devuelve ni se loguea el body crudo.

## 9. Pruebas

| Archivo | Qué cubre |
|---|---|
| `services/followup-cadence.test.ts` (nuevo) | 7 días inicial; 7 siguientes; tope de 2; etapa respondida 1/3; entrevista +1; `closed`/`outcome` → `not_applicable`; `daysUntilDue` estable por día natural; `now` inyectado |
| `services/evaluation-report.test.ts` (nuevo) | LLM mockeado: el prompt incluye perfil saneado y descripción; el JSON se valida y se convierte a markdown con las 5 secciones; job sin descripción lanza `EvaluationReportNotApplicableError`; fallo de configuración se propaga |
| `services/form-answers.test.ts` (nuevo) | Requiere informe; devuelve pares pregunta/respuesta; JSON inválido del LLM no rompe la respuesta al cliente |
| `api/routes/jobs.evaluation.test.ts` (nuevo) | 202 + flag a 1; 409 en segunda llamada (informe y respuestas); 422 sin descripción; 422 en respuestas sin informe; 404 job ajeno; `{ ok, meta.requestId }` y header `x-request-id`; flag vuelve a 0 tras fallo |
| `api/routes/follow-ups.test.ts` (nuevo) | Agrupa en due/upcoming/exhausted; excluye jobs cerrados; cuenta follow-ups completados |
| `api/routes/tenant-isolation.test.ts` (extender) | El informe del tenant A no es legible desde el tenant B |
| `client/pages/job-page/JobEvaluationPanel.test.tsx` (nuevo) | Estado vacío, estado generando, informe renderizado, aviso de desactualizado |

Los tests de ruta siguen el patrón de `routes/test-utils.ts` y los de repositorio usan la
base en memoria que ya usa la suite.

## 10. Documentación

Dos páginas nuevas en `docs-site/docs/features/`, con frontmatter `id`, `title`,
`description`, `sidebar_position` y la estructura de cinco secciones:

- `evaluation-report.md` — qué es, por qué existe, cómo usarlo (generar, leer, regenerar,
  qué se envía al LLM), problemas comunes (LLM sin configurar, informe desactualizado, job
  sin descripción), páginas relacionadas.
- `follow-ups.md` — qué es, por qué existe, cómo usarlo (programar, marcar enviado),
  problemas comunes (por qué no aparece un job, por qué está agotado), relacionadas.

Enlazar ambas desde `docs-site/docs/features/overview.md` y desde
`in-progress-board.md` donde corresponda.

## 11. Fuera de alcance

- Relleno de formularios en navegador (base disponible: `challenge-viewer.ts` y
  `xvfb`/`x11vnc`/`noVNC` en `Dockerfile:153`).
- Envío de emails de follow-up.
- Modos `scan`, `batch`, `apply`, `deep` de career-ops.
- Exponer career-ops como REST o MCP.
- Historial de versiones del informe (si se pide, se resuelve con `job_documents` y una
  columna `kind`, no antes).
- Descarga del informe como archivo (sería `GET /api/jobs/:id/evaluation?format=md`).

## 12. Riesgos

| Riesgo | Mitigación |
|---|---|
| El informe cuesta tokens y el usuario regenera por inercia | Confirmación al regenerar si ya existe; `409` si hay una en curso; flag persistido |
| Un informe viejo se lee como actual | `isEvaluationReportStale` compara con el perfil y avisa en la UI |
| El markdown generado es enorme y ralentiza el detalle del job | Límite de tamaño en el schema y truncado defensivo al renderizar; no se incluye en respuestas de lista |
| Reglas de cadencia sesgadas a un mercado | Constantes en `FOLLOWUP_RULES`, documentadas y fáciles de ajustar |
| Job-ops se reinicia a mitad de generación y el flag queda a 1 | Al arrancar, el mismo patrón que `pdfRegenerating`: se resetean `evaluation_report_generating` y `form_answers_generating` huérfanos a 0 |

## 13. Criterios de aceptación

1. Desde `/job/:id/evaluation`, un usuario sin conocimientos técnicos genera un informe y
   ve veredicto, evidencia JD↔CV, gaps, comp y legitimidad, sin salir de job-ops.
2. Regenerar con una generación en curso devuelve 409 y no consume tokens.
3. Un job sin descripción explica qué falta en lugar de fallar de forma genérica.
4. Un informe generado antes de un cambio de perfil se marca como desactualizado.
5. `/follow-ups` lista, para cada aplicación activa, a quién toca escribir hoy, con
   cadencia 7/7/máx 2 y sus variantes, y permite programar o marcar enviado.
6. Ninguna de las dos features expone datos de otro tenant (test de aislamiento en verde).
7. Las respuestas de formulario exigen informe y se copian una a una.
8. `./orchestrator/node_modules/.bin/biome ci .`, los tres `check:types`, `build:client` y
   `test:run` pasan.
