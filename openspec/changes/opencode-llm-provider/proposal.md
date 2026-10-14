# Proposal

## Why

JobOps supports many LLM providers, but each needs its own API key and endpoint, and
free tiers are tight (for example, a Gemini preview model capped at 5 RPM / 20 RPD).
The operator already runs an **OpenCode server** locally that brokers many providers
(the OpenCode Go subscription, OpenRouter, Ollama Cloud, and free Zen models) behind a
single Basic-auth HTTP API. Adding OpenCode as a JobOps provider lets every LLM-backed
feature (scoring, tailoring, ghostwriter, email classification) reuse that one server
and its model catalogue — including a free model — instead of juggling keys and
per-provider quotas.

## What Changes

- Add a new **`opencode` LLM provider** to the existing provider set, selectable
  wherever a provider is chosen today (Settings → Model, purpose overrides,
  onboarding).
- The provider talks to a local OpenCode 2.x server over its **session-less text
  generation** endpoint (`POST /api/experimental/generate`), mapping one prompt to the
  returned assistant text.
- **Endpoint + credential discovery**: read the OpenCode service registration file
  (`service.json` → `{ url, password }`), with an environment fallback
  (`OPENCODE_PASSWORD`) and a configurable base URL. Authenticate with HTTP **Basic**
  (`opencode:<password>`).
- **Models** are `providerID/modelID` strings from the server catalogue
  (`GET /api/model`); a configurable default (a free model by default).
- **Structured output is not enforced server-side** by OpenCode v2. The provider
  requests JSON through the prompt, parses it with the existing JSON parser, and
  optionally validates and **repairs** it through the same generation endpoint.
- No change to existing providers, the scoring/tailoring prompts, or the `/api/*`
  contract.

## Capabilities

### New Capabilities

- `llm-providers`: the set of LLM provider integrations the server can call, and the
  behavior each provider must honor (configuration resolution, authentication, request
  and response mapping, model selection, structured-output handling, and error
  surfacing).

### Modified Capabilities

_None. This change adds a provider; it does not alter the requirements of any existing
capability._

## Impact

- **Code**: `orchestrator/src/server/services/llm/` (new provider strategy, service
  call path, endpoint discovery), `shared/src/types/settings.ts` and
  `shared/src/settings-registry.ts` (provider enum + settings), and
  `orchestrator/src/client/pages/settings/` (provider list, hints, model suggestions).
- **APIs**: no new JobOps `/api/*` route. The provider calls an **external** local
  OpenCode server.
- **External payloads / LLM prompts**: prompts are sent to the local OpenCode server
  (which forwards them to the selected upstream model). Payload content is unchanged
  from today's provider prompts; no new PII fields are added. The OpenCode password
  and `Authorization` header must never be logged.
- **Multi-tenant impact**: provider selection and model remain tenant-scoped settings;
  the OpenCode **endpoint is operator-level** (global), so a tenant cannot redirect the
  LLM call to an arbitrary internal host (SSRF). The service registration file is
  machine-level and read per call, never cached in tenant-independent state.
- **Security posture**: JobOps calls only the server's session-less generation endpoint,
  so a JobOps-initiated request never runs the server's tools (no shell/file/network
  execution). The server listens on loopback by default; a remote connection requires a
  secure transport (TLS/tunnel). The Basic password and `Authorization` header are never
  logged or returned.
- **Docs**: a user-facing Settings section describing how to point JobOps at an
  OpenCode server.

## Out of Scope

- Streaming responses, tool execution, image/file inputs, and session reuse (JobOps
  only needs one-shot text generation).
- Native `json_schema` enforcement (OpenCode v2 does not expose it).
- Bundling, installing, or managing the OpenCode server process itself; the operator
  runs it.
- Changing any existing provider's behavior or the scoring/tailoring prompt contracts.
