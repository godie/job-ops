# Proposal

## Why

An operator running JobOps against a local OpenCode server can only point JobOps at it by
editing the OpenCode service registration file or the process environment
(`OPENCODE_URL`, `OPENCODE_PASSWORD`) and restarting the deployment. Neither value is
visible or editable from the app, while Ollama's base URL is already editable in
Settings → Model. That asymmetry makes OpenCode the only LLM provider that cannot be
re-pointed without shell access to the server.

## What Changes

- Add two operator-scoped settings: `opencodeUrl` (string, URL) and `opencodePassword`
  (secret), registered like the existing LLM settings with `OPENCODE_URL` and
  `OPENCODE_PASSWORD` as their environment fallbacks.
- Add an admin-only **OpenCode server** section to Settings → Model with **Server URL**
  and **Password** fields plus a connection check, writing those settings.
- Extend the endpoint/credential resolution order to include the stored settings:
  service registration file → stored setting → environment variable. This changes the
  current password precedence, which today prefers the environment variable over any
  stored value.
- Keep the existing transport guard unchanged: plaintext only for loopback and Docker
  host aliases; any other host must use TLS.
- Make the stored password write-only through the API: never returned in a response
  body, never logged, never included in error `details`.
- Update `docs-site/docs/features/settings.md` with the new section.

**Out of scope**

- Per-tenant (non-admin) endpoint configuration, and any relaxation of the
  transport/SSRF guard.
- OpenCode model selection and the model catalogue (already covered by
  `llm-providers`).
- Onboarding changes, new environment variable names, and a general "test any
  provider" refactor of the Settings page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `llm-providers`: endpoint and credential resolution gains a persisted,
  operator-configured source, and the endpoint becomes editable from an admin-only
  Settings surface while staying out of tenant reach.

## Impact

- **Code**: `shared/src/settings-registry.ts` (two new settings);
  `orchestrator/src/server/api/routes/settings.ts` and the client Settings → Model
  page; `orchestrator/src/server/services/llm/credentials.ts` and
  `orchestrator/src/server/services/llm/opencode/service.ts` (resolution order);
  `docs-site/docs/features/settings.md`.
- **Multi-tenant impact**: both settings live in the tenant-scoped settings table but
  are **admin-only to write** through the existing system-admin gating. A non-admin
  tenant receives `403 FORBIDDEN` and can never read the password value. The endpoint
  remains operator-level, so one tenant cannot redirect LLM traffic to an arbitrary
  host.
- **`/api/*` contract**: `PUT /api/settings` gains two keys and keeps
  `{ ok: true, data, meta: { requestId } }`; a non-admin write stays `403 FORBIDDEN`
  with the standard error envelope. The settings read response must not include the
  password value.
- **Payloads**: no webhook payload changes. LLM prompts are unchanged; the resolved
  password travels only as an `Authorization: Basic` header to the configured OpenCode
  server.
- **Dependencies**: none new.
