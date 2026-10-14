# Design

## Context

JobOps already has an LLM provider abstraction: each provider is a `ProviderStrategy`
(`orchestrator/src/server/services/llm/providers/*`) consumed by `LlmService`
(`orchestrator/src/server/services/llm/service.ts`). Most providers are pure HTTP
strategies (`buildRequest` → `fetch` → `extractText`). Two shapes already exist for
non-hosted providers:

- **Local-process providers** (`codex`, `gemini_cli`, `claude_cli`) are stubs whose real
  call path lives in `LlmService` (special-cased by provider id), because they don't fit
  a single hosted HTTP request.
- The provider set is enumerated in `shared/src/types/settings.ts`
  (`LLM_PROVIDER_VALUES`), the settings registry, and the client provider list
  (`orchestrator/src/client/pages/settings/utils.ts`).

OpenCode 2.x runs a local server that brokers many upstream providers. Relevant API
surface (verified against `https://opencode.ai/v2/openapi.json`, server v2.0.24):

- `POST /api/experimental/generate` — "Run one stateless model generation … return the
  assistant text". Body `{ prompt: string, model?: { providerID, id, variant? } }`,
  response `{ data: { text: string } }`. This is the one-shot text path JobOps needs.
- `GET /api/model` — model catalogue (`providerID`, `modelID`, …).
- Every route requires HTTP **Basic** auth (`opencode:<password>`).
- `opencode serve` prints a random password per run; `OPENCODE_PASSWORD` pins it.
- `opencode serve --service` binds a fixed port and writes
  `$XDG_STATE_HOME/opencode/service.json` with `{ id, version, url, pid, password }`.

OpenCode v2 has **no server-side structured output**; the `json_schema` prompt contract
was removed. See proposal.md — Why for motivation.

## Goals / Non-Goals

**Goals:**

- Add an `opencode` provider usable by every LLM-backed flow with no changes to those
  flows' prompts or contracts.
- Resolve the server endpoint and credential automatically from the local service
  registration, with a configurable fallback.
- Keep structured-output reliability close to today's `json_schema` providers despite
  the server not enforcing schemas.

**Non-Goals:**

- Streaming, tools, file/image inputs, or session reuse.
- Managing the OpenCode server lifecycle (start/stop/install).
- Native `json_schema` enforcement.
- Changing existing providers or the scoring/tailoring prompt text.

## Decisions

### D1 — Native provider, not a bridge or the Vercel AI SDK

Implement `opencode` as a first-class provider: a `ProviderStrategy` for the
request/response mapping plus a small resolution hook in `LlmService` for discovery and
auth (mirroring how `codex`/CLI providers are special-cased).

- **Alternative — external OpenAI-compatible bridge:** a separate local proxy exposing
  `/v1/chat/completions` would let JobOps reuse the `openai_compatible` provider with
  zero JobOps code, but adds a process the operator must run and maintain.
- **Alternative — adopt the Vercel AI SDK** (`ai-sdk-provider-opencode-sdk`): works, but
  requires adding `ai@^7` and reworking `LlmService`, which is built on its own fetch
  abstraction. Rejected as disproportionate.

### D2 — Use the session-less generate endpoint

Call `POST /api/experimental/generate` with `{ prompt, model }`. It is synchronous,
stateless, and returns text — the closest match to `buildRequest`/`extractText`.

- **Alternative — session create + prompt + read:** the general OpenCode path is
  asynchronous and session-based, and can execute tools. Rejected: heavier, and JobOps
  only needs plain generation.

### D3 — Discovery from `service.json`, with fallback

Resolve the base URL and password by reading `$XDG_STATE_HOME/opencode/service.json`
(`{ url, password }`). Fall back to a configured base URL plus `OPENCODE_PASSWORD` (env
or stored setting). Never hard-fail when the file is missing and a fallback exists.

- **Alternative — require manual base URL + password in Settings:** simplest, but the
  operator asked for discovery; the registration file is the intended mechanism.

### D4 — Basic auth with strict redaction

Send `Authorization: Basic base64("opencode:" + password)`. Route the password and
header through the existing sanitizer; never log or return them. The provider resolves
the password at call time and does not store it in module-level state.

### D5 — Structured output: prompt + parse + repair

The provider advertises `modes: ["text", "none"]`. For calls that need JSON, the prompt
already instructs JSON-only output; the result is parsed with `parseJsonFromContent`.
Additionally, when a schema is supplied, validate the parsed object against it and, on
failure, ask the same generate endpoint to repair the output (bounded attempts); a
still-invalid result is an error, never silently returned.

- **Alternative — accept whatever text comes back:** rejected; scoring needs a
  well-formed object, and silent garbage is worse than a surfaced error.

### D6 — Models as `providerID/modelID`

Accept the OpenCode model identifier verbatim (`opencode/space-bunny-free`,
`opencode-go/grok-4.7`, …). A configurable default (a free model by default) applies
when unset. Expose `GET /api/model` for UI suggestions.

### D7 — Flatten messages to one prompt

The generate endpoint takes a single `prompt`. The provider concatenates `system` and
other messages into one prompt string (as the CLI providers already do), preserving
ordering and role labels.

### D8 — Endpoint is operator-level, not per-tenant

Resolve the OpenCode base URL from operator-level configuration (environment / a global
setting), never from per-tenant settings. This prevents a tenant from pointing JobOps at
an arbitrary internal host and using it as an SSRF proxy, and matches the fact that the
server is an operator-owned local resource. Only the model (and, if desired, a stored
password) is tenant-scoped.

- **Alternative — per-tenant base URL:** more flexible, but any tenant could redirect
  the LLM call to an internal service. Rejected.

### D9 — Tool-free generation only

JobOps calls only the session-less generation endpoint; it never creates sessions or
uses the agent path. A JobOps-initiated request therefore cannot execute the server's
tools (shell, file edits, web), keeping the blast radius of a compromised JobOps to text
generation.

- **Alternative — session/agent path:** richer, but runs tools server-side. Rejected as
  unnecessary for plain generation and riskier.

### D10 — Transport: local by default, secure when remote

The OpenCode server binds to loopback by default (verified: `opencode serve` listens on
`127.0.0.1`, not reachable on the LAN). JobOps allows plaintext Basic auth to loopback
and to Docker's host aliases (`host.docker.internal` / `gateway.docker.internal`), which
reach the host over Docker's internal network rather than a public one (verified: a
container reaches the host server at `host.docker.internal:49374`). Any other host must
use TLS or a tunnel; Basic credentials must never cross a public network in plaintext.

## Risks / Trade-offs

- **`/api/experimental/generate` is experimental** → it can change across OpenCode
  releases. Mitigation: isolate it behind the provider, cover it with a unit test that
  asserts the request/response mapping, and keep the mapping in one place.
- **Free-model quality/latency** → weaker or slower output than hosted models.
  Mitigation: the default model is configurable; document the trade-off.
- **JSON reliability without a schema** → the model may deviate. Mitigation: prompt +
  parse + bounded repair (D5); surface failures.
- **`service.json` location varies** (`$XDG_STATE_HOME` vs default) → resolve the
  documented path and fall back to configuration; never assume the file exists.
- **Server must be running** → a missing server is a configuration error with a clear
  message, not a crash.
- **Upstream rate limits** (subscription/zen) → handled by the existing retry/backoff
  policy in `LlmService`; the provider only needs to classify errors correctly (D4 /
  spec "Error surfacing").
- **SSRF via a tenant-controlled endpoint** → mitigated by D8: the base URL is
  operator-level, so a tenant cannot redirect the LLM call to an internal host.
- **The credential is high-value** → the password grants access to every server route,
  including the agent/tools, so a leak is effectively host RCE. Mitigated by D9 (JobOps
  only generates, never runs tools), loopback binding (D10), and strict redaction (D4).
- **Remote transport exposure** → Basic credentials in plaintext across a network.
  Mitigated by D10 (TLS or a tunnel when the host is not loopback).
- **Multi-tenancy** → provider selection and model remain tenant-scoped settings; the
  endpoint is operator-level (D8) and the discovery file is machine-level, read per
  call, never cached in tenant-independent state.

## Migration Plan

- No data migration: adding a provider does not change stored job data.
- Rollback: remove the `opencode` entry from the provider list and registry; no other
  provider is affected.

## Open Questions

- Which free model is the built-in default (`opencode/space-bunny-free` proposed)? This
  is a one-line default and does not change the specs, approach, or task breakdown.
- Whether the Settings UI should show discovery status (found/not found) for the local
  server. Nice-to-have; deferrable without changing behavior.
