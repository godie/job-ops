# Arreglar los 12 tests rojos — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dejar `npm --workspace orchestrator run test:run` en verde **en cualquier zona horaria (incluido UTC+14) y con cualquier credencial exportada en el shell**, sin tocar aserciones para "que pasen".

**Contexto que el plan anterior no decía:** CI ejecuta `npm run test:all` sobre un checkout limpio, en UTC y sin `.env` (`.github/workflows/ci.yml:44`). Los 12 rojos **no existen en CI**: son un problema de la máquina del desarrollador más dos bugs de UI reales (husos negativos y DST). Conviene no venderlo como "poner CI en verde".

**Architecture:** cuatro causas independientes.

1. `orchestrator/vite.config.ts` carga el `.env` del desarrollador también bajo vitest, y `envSettings.ts` congela `process.env` en `envDefaults` al importar. Resultado: los tests que dicen "no hay credencial" encuentran una. Se arregla (a) no cargando `.env` en modo test y (b) escribiendo `= ""` en vez de `delete` donde un test quiere decir "ausente", porque un `delete` cae al snapshot congelado.
2. `job-posting-age.ts` parsea fechas sin hora (`2026-05-25`) como medianoche **UTC**, lo que al oeste de Greenwich las corre un día; se parsean como día de calendario local.
3. `getCalendarAgeDays` divide ms entre `86_400_000` y hace `floor`: un día local de 23 h (spring-forward) da 0.958 → `0`, y una oferta de ayer se muestra como "today". Se redondea al día más cercano.
4. `ApplicationsPerDayChart` agrupa por día **local** (correcto para el usuario) pero los tests construyen sus datos como instantes absolutos de enero, que en husos extremos caen fuera de la ventana; se derivan del `now` mockeado.

**Tech Stack:** TypeScript, Vite/Vitest (`orchestrator/vite.config.ts`), dotenv, React + Recharts (tests de cliente), Biome.

## Global Constraints

- Comandos desde la raíz del repo. Tests: `npm --workspace orchestrator run test:run -- <ruta>`.
- **Todo comando que filtre salida con un pipe lleva `set -o pipefail;` delante.** Sin eso `... | tail -5` devuelve 0 con la suite en rojo y el paso "pasa" mintiendo.
- No relajar ni borrar aserciones. Cambian **datos de entrada** (Task 3), **estado de `process.env`** (Task 1) y se **añaden** 2 aserciones/tests (Task 2: tooltip y DST).
- `envSettings.ts` captura `envDefaults` al importar el módulo: `delete process.env.X` **no basta** mientras el valor esté en el snapshot. Por eso el patrón es `process.env.X = ""`, no `delete`.
- El modo test de vitest se llama exactamente `"test"`; `npm run test:run` es `vitest run` sin `--config`, así que usa `orchestrator/vite.config.ts` (verificado).
- `npm run dev` (tsx + vite) debe seguir leyendo `.env`; sólo se salta en modo test, y eso **se verifica** en el Task 1 Step 5, no se asume.
- **El árbol de trabajo ya trae cambios ajenos** (`openspec/`, `.env.example`, `package.json`, `skills-lock.json`, `.agents/skills/*`). Todos los commits de este plan van con `git add` por archivo: nunca `git commit -a` ni `git add -A`.
- Verificación final (AGENTS.md): `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace gradcracker-extractor run check:types`, `npm --workspace ukvisajobs-extractor run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.

## Mapa de fallos → tarea

Estado medido en esta máquina (macOS, `America/Los_Angeles`, `.env` presente):

```
Test Files  7 failed | 307 passed (314)
Tests  12 failed | 2239 passed | 6 skipped (2257)
```

| Archivo | Rojos | Causa | Tarea |
|---|---|---|---|
| `src/server/services/llm-service.test.ts` | 1 | `.env` (`LLM_API_KEY`) | 1 |
| `src/server/services/manualJob.test.ts` | 1 | `.env` (`LLM_API_KEY`) | 1 |
| `src/server/services/ai-resilience.test.ts` | 1 | `.env` (`LLM_API_KEY`) | 1 |
| `src/server/services/modelSelection.test.ts` | 1 | `.env` (`LLM_API_KEY` gana a `OPENROUTER_API_KEY` vía snapshot) | 1 |
| `src/server/services/llm/providers/opencode.test.ts` | 4 | `.env` (`OPENCODE_URL`/`OPENCODE_PASSWORD`) | 1 |
| `src/client/lib/job-posting-age.test.ts` | 2 | fecha sin hora parseada como UTC | 2 |
| `src/client/components/charts/ApplicationsPerDayChart.test.tsx` | 2 | fixtures absolutos, bucketing local | 3 |

Después del plan: 12 rojos + 1 test DST nuevo que arranca en rojo donde duele = `Tests 2252 passed | 6 skipped (2258)`, `Test Files 314 passed (314)`.

## File Structure

- `orchestrator/vite.config.ts` — cargador de `.env` para puertos de dev; pasa a cargar sólo fuera de modo test. Nada más cambia.
- `orchestrator/src/server/services/{llm-service,manualJob,ai-resilience,modelSelection}.test.ts` y `llm/providers/opencode.test.ts` — el "ausente" se expresa con `= ""`, que es lo que el runtime interpreta como credencial no configurada (`toStringOrNull("") === null`).
- `orchestrator/src/client/lib/job-posting-age.ts` — parseo de fecha sin hora + edad de calendario en días DST.
- `orchestrator/src/client/lib/job-posting-age.test.ts` — aserción de tooltip + test de DST.
- `orchestrator/src/client/components/charts/ApplicationsPerDayChart.test.tsx` — sólo fixtures; el componente **no** cambia.

---

### Task 1: Aislar vitest del entorno del desarrollador

**Files:**
- Modify: `orchestrator/vite.config.ts:12` y `:43`, más el cierre del archivo.
- Modify: los 5 archivos de test del mapa de arriba (sólo líneas de entorno).
- Test: esos mismos 5 archivos, que ya fallan (ese es el rojo).

**Interfaces:**
- Consumes: `getOriginalEnvValue` de `@server/services/envSettings` (sin cambios).
- Produces: contrato nuevo — bajo vitest, `process.env` no contiene claves del `.env` del repo, y `process.env.X = ""` gana sobre `envDefaults` (porque `getOriginalEnvValue` prefiere el valor vivo cuando no es `undefined`).

- [x] **Step 1: Registrar el rojo (8 tests, nombres exactos)**

Run:
```bash
set -o pipefail; npm --workspace orchestrator run test:run -- \
  src/server/services/llm-service.test.ts \
  src/server/services/manualJob.test.ts \
  src/server/services/ai-resilience.test.ts \
  src/server/services/modelSelection.test.ts \
  src/server/services/llm/providers/opencode.test.ts 2>&1 | grep -E "FAIL|Tests "
```
Expected: `Tests  8 failed | 60 passed (68)` y estos 8:
- `ai-resilience.test.ts > ... > should throw LlmNotConfiguredError if API Key is missing`
- `llm-service.test.ts > LlmService > returns error when API key is missing`
- `manualJob.test.ts > manual job inference > returns a warning when the API key is missing`
- `modelSelection.test.ts > Model Selection Logic > Tailoring Service > resolves OPENROUTER_API_KEY from env when no stored key is set`
- `opencode.test.ts > opencode endpoint discovery > fails when a partial registration has no other source for the missing field`
- `opencode.test.ts > opencode endpoint discovery > fails when the URL is missing while a password resolves`
- `opencode.test.ts > opencode endpoint discovery > fails when the password is missing while a URL resolves`
- `opencode.test.ts > opencode endpoint discovery > does not treat a stored LLM key as the OpenCode password`

- [x] **Step 2: Comprobar el mecanismo (dos pruebas, ninguna con valores sensibles)**

Run:
```bash
node -e "const{config}=require('dotenv');const r=config({path:'.env'});console.log(Object.keys(r.parsed||{}).sort().join(','))"
```
Expected: la lista incluye `LLM_API_KEY`, `OPENCODE_PASSWORD` y `OPENCODE_URL` (sólo nombres).

Ahora la prueba de que `""` equivale a "ausente" y gana al `.env` (dotenv **no** sobreescribe claves ya presentes en `process.env`):

```bash
LLM_API_KEY= OPENROUTER_API_KEY= OPENCODE_URL= OPENCODE_PASSWORD= \
  npx --prefix orchestrator vitest run --root orchestrator \
  src/server/services/llm-service.test.ts \
  src/server/services/manualJob.test.ts \
  src/server/services/ai-resilience.test.ts \
  src/server/services/modelSelection.test.ts \
  src/server/services/llm/providers/opencode.test.ts 2>&1 | grep -E "Tests "
```
Expected: `Tests  68 passed (68)`. Medido hoy: con esas cuatro vacías los 68 pasan **incluso con `.env` presente**. Eso es lo que hace válido el patrón del Step 6.

- [x] **Step 3: Saltar el `.env` en modo test**

En `orchestrator/vite.config.ts`, sustituir:

```ts
// Reuse the root .env (same file the server loads) so dev ports are configurable.
loadDotenv({ path: path.resolve(__dirname, "..", ".env") });
const apiPort = process.env.PORT || "3001";
const webPort = Number(process.env.WEB_PORT || "5173");
```

por:

```ts
const apiPort = process.env.PORT || "3001";
const webPort = Number(process.env.WEB_PORT || "5173");
```

> **Corrección de ejecución:** los dos `const` **también** bajan al cuerpo del callback, después de la carga condicional (ver el snippet siguiente). Si se quedan en el ámbito del módulo se leen antes de que `loadDotenv` corra, y el `.env` de la raíz define `PORT`/`WEB_PORT` (`server_port` pasó a default 5173 en vez de 9140 durante la implementación).

Después, cambiar:

```ts
export default defineConfig({
  plugins: [react(), tailwindcss()],
```

por:

```ts
export default defineConfig(({ mode }) => {
  if (mode !== "test") {
    loadDotenv({ path: path.resolve(__dirname, "..", ".env") });
  }

  {
  // Reuse the root .env (same file the server loads) so dev ports are configurable.
  // Vitest loads this same config with mode "test"; skipping the file there keeps
  // the developer's credentials out of `process.env`. CI has no .env, so tests
  // must pass without one.
  if (mode !== "test") {
    loadDotenv({ path: path.resolve(__dirname, "..", ".env") });
  }

  const apiPort = process.env.PORT || "3001";
  const webPort = Number(process.env.WEB_PORT || "5173");

  return {
    plugins: [react(), tailwindcss()],
```

(el `{` suelto de arriba es lo que ya había antes del `plugins`; el cuerpo del callback empieza con el bloque de carga condicional y termina en `return {`)

y el cierre:

```ts
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
});
```

por:

```ts
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
  };
});
```

(La indentación interna del objeto puede quedar como está: Biome la reindenta en el Step 7. Lo que no puede quedar es una propiedad fuera del `return`.)

- [x] **Step 4: Verde de los 5 archivos**

Run: el mismo comando del Step 1.
Expected: `Tests  68 passed (68)`, 0 rojos.

- [x] **Step 5: Verificar los dos lados del guard (dev sigue leyendo `.env`)**

Run:
```bash
node --input-type=module -e '
import { loadConfigFromFile } from "vite";
for (const mode of ["test", "development"]) {
  delete process.env.LLM_API_KEY;
  const loaded = await loadConfigFromFile(
    { command: "serve", mode },
    "./orchestrator/vite.config.ts",
  );
  console.log(
    mode.padEnd(12),
    "config_loaded=", Boolean(loaded?.config),
    "llm_api_key_from_dotenv=", Boolean(process.env.LLM_API_KEY),
  );
}
'
```
Expected **después** del Step 3 (medido, añadiendo `port` al probe):
```
test         config_loaded= true llm_api_key_from_dotenv= false port_from_dotenv= (default) server_port= 5173
development  config_loaded= true llm_api_key_from_dotenv= true port_from_dotenv= 4100 server_port= 9140
```
`server_port= 9140` es el `WEB_PORT` del `.env`: prueba de que mover los puertos dentro del callback no rompió `npm run dev`.
Antes del Step 3 (medido) imprime `true` en ambos modos: ése es el leak. Si `development` sale `false`, el guard está de más ancho y `npm run dev` perdería el `.env`.

- [x] **Step 6: Hacer herméticos los 5 archivos (`= ""`, no `delete`)**

> Nota deliberada: **no** se usa `vi.stubEnv`. Dos de estos archivos reasignan `process.env` entero (`process.env = { ...originalEnv }`), lo que descarta el registro interno de stubs de vitest; y el mecanismo que el runtime ya respeta es `""` → `toStringOrNull` → `null`. Mismo efecto, sin pelearse con el archivo.

**6a. `llm-service.test.ts`** — en `beforeEach`:

```ts
    process.env.LLM_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "test-api-key";
    delete process.env.LLM_API_KEY;
```
→
```ts
    process.env.LLM_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "test-api-key";
    // "" means "absent": deleting falls back to the envSettings snapshot that
    // was frozen when the module was imported.
    process.env.LLM_API_KEY = "";
```

y en el test `returns error when API key is missing`:

```ts
  it("returns error when API key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
```
→
```ts
  it("returns error when API key is missing", async () => {
    process.env.OPENROUTER_API_KEY = "";
```

**6b. `manualJob.test.ts`** — en `beforeEach`:

```ts
    process.env = { ...originalEnv, OPENROUTER_API_KEY: "test-key" };
```
→
```ts
    process.env = {
      ...originalEnv,
      // Absent credentials are "" here: a delete would fall back to
      // envSettings' frozen snapshot of the developer's .env.
      LLM_API_KEY: "",
      OPENROUTER_API_KEY: "test-key",
    };
```

y en el test `returns a warning when the API key is missing`:

```ts
    delete process.env.OPENROUTER_API_KEY;
```
→
```ts
    process.env.OPENROUTER_API_KEY = "";
```

**6c. `ai-resilience.test.ts`** — en `beforeEach`:

```ts
    delete process.env.LLM_API_KEY;
    process.env.OPENROUTER_API_KEY = "mock-key"; // Ensure logic tries to call API
```
→
```ts
    // "" means "absent": deleting falls back to the frozen envSettings snapshot.
    process.env.LLM_API_KEY = "";
    process.env.OPENROUTER_API_KEY = "mock-key"; // Ensure logic tries to call API
```

y en el test `should throw LlmNotConfiguredError if API Key is missing`:

```ts
      delete process.env.OPENROUTER_API_KEY;
```
→
```ts
      process.env.OPENROUTER_API_KEY = "";
```

**6d. `modelSelection.test.ts`** — en `beforeEach`:

```ts
    process.env = {
      ...originalEnv,
      OPENROUTER_API_KEY: "test-key",
      MODEL: "env-model",
    };
```
→
```ts
    process.env = {
      ...originalEnv,
      // "" beats the envSettings snapshot; a delete would fall back to it.
      LLM_API_KEY: "",
      OPENROUTER_API_KEY: "test-key",
      MODEL: "env-model",
    };
```

y en el test `resolves OPENROUTER_API_KEY from env when no stored key is set`:

```ts
      delete process.env.LLM_API_KEY;
      process.env.OPENROUTER_API_KEY = "sk-openrouter-only";
```
→
```ts
      process.env.LLM_API_KEY = "";
      process.env.OPENROUTER_API_KEY = "sk-openrouter-only";
```

**6e. `llm/providers/opencode.test.ts`** — hay dos bloques idénticos (`beforeEach` y `afterEach`):

```ts
    delete process.env.OPENCODE_URL;
    delete process.env.OPENCODE_PASSWORD;
```
→
```ts
    // "" reads as "absent"; deleting would fall back to the frozen snapshot.
    process.env.OPENCODE_URL = "";
    process.env.OPENCODE_PASSWORD = "";
```
en **ambos** bloques. `envSetup()` sigue asignando valores reales y gana, porque escribe después.

- [x] **Step 7: Verde y hermeticidad bajo entorno hostil**

Run:
```bash
set -o pipefail; npx --prefix orchestrator vitest run --root orchestrator \
  src/server/services/llm-service.test.ts \
  src/server/services/manualJob.test.ts \
  src/server/services/ai-resilience.test.ts \
  src/server/services/modelSelection.test.ts \
  src/server/services/llm/providers/opencode.test.ts 2>&1 | grep -E "Tests "
```
Expected: `Tests  68 passed (68)`.

Ahora con credenciales exportadas en el shell (lo que el Step 3 ya **no** neutraliza):

```bash
set -o pipefail; LLM_API_KEY=ollama OPENROUTER_API_KEY=hostile-key \
  OPENCODE_URL=http://127.0.0.1:4096 OPENCODE_PASSWORD=hostile \
  npx --prefix orchestrator vitest run --root orchestrator \
  src/server/services/llm-service.test.ts \
  src/server/services/manualJob.test.ts \
  src/server/services/ai-resilience.test.ts \
  src/server/services/modelSelection.test.ts \
  src/server/services/llm/providers/opencode.test.ts 2>&1 | grep -E "Tests "
```
Expected: `Tests  68 passed (68)` otra vez. Si algo se rompe aquí, el archivo culpable todavía depende del entorno: se arregla con `= ""` en su propio `beforeEach`, nunca recargando `.env`.

- [x] **Step 8: Formato y tipos**

Run:
```bash
set -o pipefail; ./orchestrator/node_modules/.bin/biome check --write orchestrator/vite.config.ts orchestrator/src/server/services/llm-service.test.ts orchestrator/src/server/services/manualJob.test.ts orchestrator/src/server/services/ai-resilience.test.ts orchestrator/src/server/services/modelSelection.test.ts orchestrator/src/server/services/llm/providers/opencode.test.ts
set -o pipefail; npm --workspace orchestrator run check:types
```
Expected: sin errores (Biome puede reformatear la indentación del objeto devuelto).

- [x] **Step 9: Verificar que no aparece caída colateral**

Run:
```bash
set -o pipefail; npm --workspace orchestrator run test:run 2>&1 | tail -5
echo "exit=$?"
```
Expected: `Tests  4 failed | ...` — **el comando sale 1, y eso es lo correcto**. Sólo deben quedar los 2 de `job-posting-age` y los 2 de `ApplicationsPerDayChart` (Tareas 2 y 3). Si falla cualquier otro archivo, dependía de `.env`: anótalo y trátalo como test que asumía credenciales.

- [x] **Step 10: Commit**

```bash
git add orchestrator/vite.config.ts \
  orchestrator/src/server/services/llm-service.test.ts \
  orchestrator/src/server/services/manualJob.test.ts \
  orchestrator/src/server/services/ai-resilience.test.ts \
  orchestrator/src/server/services/modelSelection.test.ts \
  orchestrator/src/server/services/llm/providers/opencode.test.ts
git commit -m "fix(test): keep the developer environment out of the vitest run"
```

---

### Task 2: Fecha sin hora = día local, y edad de calendario correcta en DST

**Files:**
- Modify: `orchestrator/src/client/lib/job-posting-age.ts` (`parsePostingDate`, `getCalendarAgeDays`, etiqueta absoluta de `formatPostingAgeLabel`)
- Test: `orchestrator/src/client/lib/job-posting-age.test.ts` (8 tests hoy; se añade 1 y una aserción de tooltip)

**Interfaces:**
- Consumes: `formatDate`/`formatDateTime` de `@/lib/utils` (sin cambios).
- Produces: `parsePostingDate` (privada) devuelve medianoche **local** para `YYYY-MM-DD`; `getCalendarAgeDays` devuelve días de calendario redondeados, correctos con días de 23 h y 25 h.

- [x] **Step 1: Registrar el rojo (2 tests) y añadir el test de DST (rojo sólo donde duele)**

Run:
```bash
set -o pipefail; npm --workspace orchestrator run test:run -- src/client/lib/job-posting-age.test.ts 2>&1 | grep -E "FAIL|Tests "
```
Expected: `Tests  2 failed | 6 passed (8)` en
`formats date-only values by calendar age` y `marks jobs from 5 to 14 days old as aging`.
En un huso UTC o positivo esos dos pasan: el bug sólo se ve al oeste de Greenwich.

Añade ahora, dentro de `describe("formatPostingAgeLabel")` y justo detrás de `formats date-only values by calendar age`:

```ts
  it("keeps yesterday as yesterday across a DST spring-forward", () => {
    // 8 Mar 2026 is a 23-hour local day in zones that observe DST. Dividing
    // milliseconds rounds down to 0 days and the label becomes "today".
    const nowAfterDst = new Date(2026, 2, 9, 12, 0, 0, 0);
    expect(formatPostingAgeLabel("2026-03-08", nowAfterDst)).toEqual(
      expect.objectContaining({
        label: "yesterday",
        inlineLabel: "Posted yesterday",
        tone: "fresh",
      }),
    );
  });
```

Run:
```bash
set -o pipefail; TZ=America/Los_Angeles npm --workspace orchestrator run test:run -- src/client/lib/job-posting-age.test.ts 2>&1 | grep -E "FAIL|Tests "
```
Expected: `Tests  2 failed | 7 passed (9)`. **Corrección de ejecución:** el test de DST **no** enrojece aquí, porque el bug de parseo UTC lo enmascara (`2026-03-08` como medianoche UTC cae el 7 de marzo 16:00 local → 2 días menos 1 h → `floor` = 1 → "yesterday" por casualidad). Se vuelve rojo justo **después** del Step 2, que es donde el `floor` queda expuesto. Verificado revirtiendo `Math.round` → `Math.floor` una vez aplicado el Step 3: `expected { label: 'today' }`.

- [x] **Step 2: Parsear la fecha sin hora como día local**

En `orchestrator/src/client/lib/job-posting-age.ts`, sustituir:

```ts
function parsePostingDate(value: string): Date | null {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
```

por:

```ts
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parsePostingDate(value: string): Date | null {
  const dateOnly = DATE_ONLY_PATTERN.exec(value);
  if (dateOnly) {
    // A date-only value is a calendar day from the source, not an instant.
    // Parsing it as UTC midnight shifts it one day in negative-offset zones.
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
    );
  }

  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
```

- [x] **Step 3: Contar días de calendario, no de 24 h**

Sustituir:

```ts
function getCalendarAgeDays(date: Date, now: Date): number {
  return Math.max(
    0,
    Math.floor(
      (startOfLocalDay(now).getTime() - startOfLocalDay(date).getTime()) /
        86_400_000,
    ),
  );
}
```

por:

```ts
function getCalendarAgeDays(date: Date, now: Date): number {
  const elapsedMs =
    startOfLocalDay(now).getTime() - startOfLocalDay(date).getTime();
  // Local days are 23h or 25h across a DST transition; rounding to the nearest
  // day keeps yesterday as yesterday when the clocks move.
  return Math.max(0, Math.round(elapsedMs / 86_400_000));
}
```

Valores medidos en `America/Los_Angeles` (antes → después): `08 Mar vs 09 Mar` `0 → 1`; `09 Mar vs 10 Mar` `1 → 1`; `25 May vs 27 May` `2 → 2`; `01 Nov vs 02 Nov` `1 → 1`. Sólo cambia el caso DST.

- [x] **Step 4: Formatear la etiqueta absoluta desde la fecha ya parseada**

En la misma función `formatPostingAgeLabel`, sustituir:

```ts
  const absolute =
    raw.length === 10
      ? (formatDate(raw) ?? raw)
      : (formatDateTime(parsed.toISOString()) ?? raw);
```

por:

```ts
  const absolute = DATE_ONLY_PATTERN.test(raw)
    ? (formatDate(parsed.toISOString()) ?? raw)
    : (formatDateTime(parsed.toISOString()) ?? raw);
```

`formatDate` re-parsea `YYYY-MM-DD` como UTC (mismo bug), así que se le pasa el ISO de la medianoche local ya parseada: `parsed.toISOString()` contiene `T`, `formatDate` lo respeta y renderiza el mismo día en local.

- [x] **Step 5: Fijar el tooltip en el test**

En `orchestrator/src/client/lib/job-posting-age.test.ts`, dentro de `formats date-only values by calendar age`, sustituir:

```ts
    expect(formatPostingAgeLabel("2026-05-25", NOW)).toEqual(
      expect.objectContaining({
        label: "2d ago",
        inlineLabel: "Posted 2d ago",
        tone: "fresh",
      }),
    );
```

por:

```ts
    expect(formatPostingAgeLabel("2026-05-25", NOW)).toEqual(
      expect.objectContaining({
        label: "2d ago",
        inlineLabel: "Posted 2d ago",
        tooltip: "Source posting date: 25 May 2026",
        tone: "fresh",
      }),
    );
```

Es una aserción **nueva**, no relajada: el tooltip también estaba un día atrasado (`24 May 2026`).

- [x] **Step 5b: Anclar los fixtures del propio test a un reloj local**

> **Corrección de ejecución:** con el parseo ya local, el `NOW` del archivo (`2026-05-27T12:00:00.000Z`) sigue siendo un instante UTC. En UTC+14 ese "ahora" local es el 28, y el archivo pasa a tener **3 rojos** (`3d ago` vs `2d ago`, `6d ago` vs `5d ago`, y el caso ISO cae en el día anterior). Se ancla a un reloj de pared y el fixture ISO se calcula relativo:

```ts
// A local wall-clock moment: posting age is measured against the user's
// calendar, not a UTC instant. Anchoring it locally keeps the expectations
// stable in every timezone (27 May noon UTC is already the 28th in UTC+14).
const NOW = new Date(2026, 4, 27, 12, 0, 0, 0);
```

y en `formats recent ISO timestamps as hours ago`:

```ts
  it("formats recent ISO timestamps as hours ago", () => {
    const threeHoursAgo = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    expect(formatPostingAgeLabel(threeHoursAgo, NOW)).toEqual(
```

- [x] **Step 6: Verde en cinco husos**

Run:
```bash
for TZ in "" America/Los_Angeles Asia/Tokyo Pacific/Kiritimati Pacific/Apia; do
  TZ=$TZ npx --prefix orchestrator vitest run --root orchestrator src/client/lib/job-posting-age.test.ts 2>&1 | grep -E "Tests " | tail -1
done
```
Expected: `Tests  9 passed (9)` en los cinco (8 previos + el de DST). El segundo prueba el DST; Kiritimati y Apia prueban que el archivo no asume que "hoy" es el día UTC.

- [x] **Step 7: Commit**

```bash
git add orchestrator/src/client/lib/job-posting-age.ts orchestrator/src/client/lib/job-posting-age.test.ts
git commit -m "fix(posting-age): read date-only postings as local calendar days"
```

---

### Task 3: Fixtures del gráfico anclados al "ahora" mockeado

**Files:**
- Modify: `orchestrator/src/client/components/charts/ApplicationsPerDayChart.test.tsx` (helper + tres `it`)
- Componente: **no se toca** `ApplicationsPerDayChart.tsx`.

**Interfaces:**
- Consumes: `ApplicationsPerDayChart` (`appliedAt: Array<string | null>`, `daysToShow: number`), `vi.setSystemTime(mockDate)`.
- Produces: nada; sólo cambia la construcción de los datos de prueba.

**Por qué es el test y no el componente:** el gráfico agrupa por día **local** (`toDateKey` usa `getFullYear/getMonth/getDate`) y la ventana es "los últimos N días" del calendario del usuario. Eso es lo correcto. Los tests construían `"2025-01-09T00:00:00Z"`, que en `America/Los_Angeles` es el 8 de enero a las 16:00 y cae fuera de la ventana; por eso el total daba 6 en vez de 7 y la tendencia se invertía.

- [x] **Step 1: Registrar el rojo (2 tests, mensajes exactos)**

Run:
```bash
set -o pipefail; TZ=America/Los_Angeles npm --workspace orchestrator run test:run -- src/client/components/charts/ApplicationsPerDayChart.test.tsx 2>&1 | grep -E "FAIL|Tests "
```
Expected: `Tests  2 failed | 15 passed (17)`:
- `shows down trend for significant negative trend` → `Unable to find an element by: [data-testid="trending-down"]` (el total cayó a 1 porque los 3 del 9 de enero quedaron fuera)
- `handles applications spread across different days in range` → `Unable to find an element with the text: /Last 7 days · 7 total/` (aparece `Last 7 days · 6 total`)

- [x] **Step 2: Añadir el helper anclado a `mockDate`**

> No usar `new Date(2025, 0, day, 12)`: eso arregla |offset| ≤ 12 y **sigue fallando en UTC+13/+14**, donde el día local de `mockDate` ya es el 16 (verificado: en `Pacific/Kiritimati` la ventana es 10–16 y un fixture del día 9 queda fuera).

En `orchestrator/src/client/components/charts/ApplicationsPerDayChart.test.tsx`, después de:

```ts
  const mockDate = new Date("2025-01-15T12:00:00Z");
```

añadir:

```ts
  // The chart buckets by local calendar day and derives its window from "now",
  // so fixtures are anchored to the mocked now instead of absolute dates. In
  // UTC+13/+14 the local day of `mockDate` is already tomorrow, which would
  // push absolute January dates out of the 7-day window.
  const dayInRange = (daysBack: number) => {
    const day = new Date(mockDate);
    day.setDate(day.getDate() - daysBack);
    day.setHours(12, 0, 0, 0);
    return day.toISOString();
  };
```

Con `daysToShow={7}`, el primer tercio de la ventana son los días `-6..-4` y la segunda mitad `-3..0`: por eso `dayInRange(6)` es "first half" y `dayInRange(0)` es "second half" en cualquier huso.

- [x] **Step 3: Usar el helper en los tres casos afectados**

`calculates trend percentage correctly for positive trend`:

```ts
      const dates = [
        "2025-01-09T00:00:00Z", // First half
        "2025-01-15T00:00:00Z", // Second half
        "2025-01-15T00:00:00Z",
        "2025-01-15T00:00:00Z",
      ];
```
→
```ts
      const dates = [
        dayInRange(6), // First half
        dayInRange(0), // Second half
        dayInRange(0),
        dayInRange(0),
      ];
```

`shows down trend for significant negative trend`:

```ts
      const dates = [
        "2025-01-09T00:00:00Z", // First half - 3 apps
        "2025-01-09T00:00:00Z",
        "2025-01-09T00:00:00Z",
        "2025-01-15T00:00:00Z", // Second half - 1 app
      ];
```
→
```ts
      const dates = [
        dayInRange(6), // First half - 3 apps
        dayInRange(6),
        dayInRange(6),
        dayInRange(0), // Second half - 1 app
      ];
```

`handles applications spread across different days in range`:

```ts
      const dates = [
        "2025-01-09T00:00:00Z",
        "2025-01-10T00:00:00Z",
        "2025-01-10T00:00:00Z",
        "2025-01-11T00:00:00Z",
        "2025-01-11T00:00:00Z",
        "2025-01-11T00:00:00Z",
        "2025-01-15T00:00:00Z",
      ];
```
→
```ts
      const dates = [
        dayInRange(6),
        dayInRange(5),
        dayInRange(5),
        dayInRange(4),
        dayInRange(4),
        dayInRange(4),
        dayInRange(0),
      ];
```

- [x] **Step 4: Verde en cuatro husos**

Run:
```bash
set -o pipefail; npm --workspace orchestrator run test:run -- src/client/components/charts/ApplicationsPerDayChart.test.tsx 2>&1 | grep -E "Tests "
set -o pipefail; TZ=America/Los_Angeles npm --workspace orchestrator run test:run -- src/client/components/charts/ApplicationsPerDayChart.test.tsx 2>&1 | grep -E "Tests "
set -o pipefail; TZ=Asia/Tokyo npm --workspace orchestrator run test:run -- src/client/components/charts/ApplicationsPerDayChart.test.tsx 2>&1 | grep -E "Tests "
set -o pipefail; TZ=Pacific/Kiritimati npm --workspace orchestrator run test:run -- src/client/components/charts/ApplicationsPerDayChart.test.tsx 2>&1 | grep -E "Tests "
```
Expected: `Tests  17 passed (17)` en los cuatro. Kiritimati (UTC+14) es el que distingue este helper del atajo `new Date(2025, 0, day, 12)`.

- [x] **Step 5: Commit**

```bash
git add orchestrator/src/client/components/charts/ApplicationsPerDayChart.test.tsx
git commit -m "test(charts): anchor per-day fixtures to the mocked now"
```

---

### Task 4: Verificación CI-parity y cierre

**Files:** ninguno (sólo verificación).

**Interfaces:**
- Consumes: Tareas 1-3.
- Produces: suite en verde y lista de checks de AGENTS.md completa.

- [x] **Step 1: Biome**

Run: `set -o pipefail; ./orchestrator/node_modules/.bin/biome ci .`
Expected: `Checked N files`, sin errores ni warnings.

- [x] **Step 2: Tipos (los cuatro workspaces del checklist)**

Run:
```bash
set -o pipefail; npm run check:types:shared
set -o pipefail; npm --workspace orchestrator run check:types
set -o pipefail; npm run check:types:gradcracker
set -o pipefail; npm run check:types:ukvisajobs
```
Expected: sin salida de errores. Los dos extractores no se tocan en este plan, pero `AGENTS.md` los exige para cualquier cambio y son dos comandos de segundos.

- [x] **Step 3: Build del cliente**

Run: `set -o pipefail; npm --workspace orchestrator run build:client`
Expected: `✓ built in …`.

- [x] **Step 4: Suite completa en tres husos**

Run:
```bash
set -o pipefail; npm --workspace orchestrator run test:run 2>&1 | tail -4
set -o pipefail; TZ=America/Los_Angeles npm --workspace orchestrator run test:run 2>&1 | tail -4
set -o pipefail; TZ=Asia/Tokyo npm --workspace orchestrator run test:run 2>&1 | tail -4
```
Expected en los tres:
```
Test Files  314 passed (314)
     Tests  2252 passed | 6 skipped (2258)
```
(2257 actuales + el test de DST del Task 2; 12 rojos convertidos en verdes.) Si aparece 1 archivo rojo, es una condición no cubierta: para y repórtalo con el nombre del archivo y su TZ.

- [x] **Step 5: Commit del plan con los checkboxes marcados**

```bash
git add docs/superpowers/plans/2026-10-26-fix-failing-tests.md
git commit -m "chore: mark the failing-tests plan complete"
```

---

## Riesgos conocidos

- **Un test que hoy pasa gracias al `.env`.** El Step 9 del Task 1 lo detecta: la suite completa debe quedar con exactamente 4 rojos (y salir 1). Si aparece un rojo nuevo, ese test leía `process.env` esperando un valor: se arregla declarándolo (`= ""` o valor explícito), nunca recargando `.env`.
- **`.env` con `LLM_API_KEY=ollama`** explica el `apiKey: "ollama"` de `modelSelection`: `getOriginalEnvValue` cae al snapshot congelado cuando se `delete` la clave viva. Por eso el arreglo es `= ""`.
- **Husos positivos.** El bug de `job-posting-age` no se reproduce en `Asia/Tokyo`; por eso se verifica en `America/Los_Angeles` (bug de fecha) y en `Pacific/Kiritimati` (ventana del gráfico).
- **DST fuera de EE. UU.** El test de DST usa medianoches locales de marzo; en husos sin transición ese día pasa trivialmente (24 h → 1 día). No es un test inútil: enrojece exactamente donde el `floor` miente.
- **No tocar `ApplicationsPerDayChart.tsx`**: cambiar el bucketing a UTC haría pasar los fixtures viejos y rompería la semántica ("últimos 7 días" del calendario del usuario).
- **Fuera de alcance, a propósito:** `getPostingDateSortValue` sigue devolviendo el instante de la medianoche local; el orden relativo entre ofertas no cambia, y este plan no toca la API de ordenación.

---

## Ejecución — resultado y desviaciones (2026-10-26)

Ejecutado en la máquina del autor, con `.env` presente y partiendo de 12 rojos.

| Check | Resultado |
|---|---|
| `biome ci .` | `Checked 1086 files. No fixes applied.` (exit 0) |
| `npm run check:types:shared` | exit 0 |
| `orchestrator check:types` | exit 0 |
| `check:types:gradcracker` | exit 0 |
| `check:types:ukvisajobs` | exit 0 |
| `build:client` | `✓ built in 5.15s` |
| suite, 3 husos | `Test Files 314 passed (314)` · `Tests 2252 passed \| 6 skipped (2258)` en los tres |

Desviaciones respecto a este documento, con la evidencia de cada una:

1. **Los puertos bajan al cuerpo del callback** (Task 1 Step 3). Dejarlos en el ámbito del módulo los leía antes de `loadDotenv`, y el `.env` define `PORT`/`WEB_PORT`: el probe mostró `server_port= 5173` (default) en vez de `9140`.
2. **`llm-service.test.ts`: la aserción de "no mutación" cambió de forma, no de fuerza.** `expect(process.env.LLM_API_KEY).toBeUndefined()` chocaba con el nuevo `""`. Ahora compara antes/después de construir (`envKeyBeforeConstruct`): sigue fallando si el constructor escribe la clave, y además detecta si la borra.
3. **El test de DST queda enmascarado** hasta el fix de parseo (Task 2 Step 1). Verificado haciendo `Math.round` → `Math.floor` después del Step 3: `expected { label: 'today' }`.
4. **`NOW` de `job-posting-age.test.ts` anclado a reloj local** (Task 2 Step 5b): con `2026-05-27T12:00:00.000Z`, `Pacific/Kiritimati` rojeaba 3 tests.

Prueba de que los dos fixes nuevos son load-bearing, no decorativos:

- `Math.round` → `Math.floor` en `getCalendarAgeDays`: 1 rojo (`label: 'today'` esperando `'yesterday'`), en `America/Los_Angeles`.
- `dayInRange` → fechas absolutas de enero: 2 rojos en `America/Los_Angeles` (`trending-down` ausente, `6 total`).
