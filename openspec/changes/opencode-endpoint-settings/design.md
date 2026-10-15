# Design

## Context

See `proposal.md` — Why. Constraints that shape the approach:

- `resolveOpenCodeEndpoint()` (`orchestrator/src/server/services/llm/opencode/service.ts`)
  resolves per call, never cached: base URL = service registration → `OPENCODE_URL`;
  password = service registration → `OPENCODE_PASSWORD` → `storedPassword`, where
  `storedPassword` is the tenant's `llmApiKey` (a workaround, which is why commit
  `0fdb30e` put the environment ahead of it).
- `assertSecureOpenCodeTransport()` already rejects plaintext for anything but loopback
  and the Docker host aliases; it is the guard that keeps the endpoint SSRF-safe.
- Settings live in the tenant-scoped `settings` table (`tenant_id`, `user_id`, `key`,
  `value`) and are declared in `shared/src/settings-registry.ts` with a `kind`
  (`typed` / `string` / `secret` / `model`) and an optional `envKey` fallback.
- `PATCH /api/settings` gates non-admin writes through
  `requireSystemAdminOrSearchSettings` + `NON_ADMIN_SEARCH_SETTING_KEYS`.
- Secrets never leave the server: `envSettings.ts` emits only a `${key}Hint` (first four
  characters) and the client renders `${hint}********` (`client/pages/settings/utils.ts`).

## Goals / Non-Goals

**Goals:**

- Make the OpenCode base URL and password first-class, persisted, admin-editable settings.
- Keep the endpoint operator-level: no tenant can write it or read the password value.
- Keep one resolution order that every caller shares (pipeline, onboarding, model catalogue).

**Non-Goals:**

- Changing the transport guard, or allowing remote plaintext endpoints.
- Reworking `llmBaseUrl` / `llmApiKey` into a generic per-provider credential model.
- Changing the OpenCode generation, model-selection, or repair behavior.

## Decisions

**1. Two dedicated settings, not the shared LLM keys.**
Add `opencodeUrl` (`kind: "string"`, `envKey: "OPENCODE_URL"`, nullable URL schema like
`rxresumeUrl`) and `opencodePassword` (`kind: "secret"`, `envKey: "OPENCODE_PASSWORD"`,
`z.string().trim().max(2000)`).
*Alternatives:* reuse `llmBaseUrl` (rejected — it is shared by every provider, so saving an
OpenCode URL would silently change Ollama) and reuse `llmApiKey` (rejected — provider-key
semantics; the ambiguity is what forced the env-first workaround).

**2. Admin-only through the existing gate.**
Simply do not add the two keys to `NON_ADMIN_SEARCH_SETTING_KEYS`, so
`requireSystemAdminOrSearchSettings` answers `403 FORBIDDEN` with the standard error
envelope. *Alternative:* a new admin middleware (rejected — duplicates existing gating and
splits the rule across two places).

**3. Resolution order becomes registration → stored setting → environment.**
`resolveOpenCodeEndpoint()` takes a stored URL and password and puts them ahead of the
environment variables, and the `llmApiKey` fallback is dropped.
*Alternative:* keep the environment first (12-factor). Rejected: in the deployment this
change targets, `.env` already defines `OPENCODE_PASSWORD`, so an env-first order would make
the new Settings field inert — the exact complaint that motivated the change.

**4. The password reuses the existing secret mechanism.**
`opencodePassword` gets an `opencodePasswordHint` (first four characters) and the value is
never serialized into a response, logged, or attached to error `details`.
*Alternative:* hide even the hint from non-admins (deferred — see Open Questions).

**5. One save path, validated at save time.**
The `PATCH /api/settings` handler runs `assertSecureOpenCodeTransport()` when either key is
present, so a remote plaintext endpoint is rejected at save with `422
UNPROCESSABLE_ENTITY` instead of failing later during scoring; a malformed URL fails the
registry schema with `400 INVALID_REQUEST`. The guard still runs at resolution time as the
authoritative check.

**6. UI: an admin-only "OpenCode server" section in Settings → Model.**
Shown when the provider is OpenCode and the caller is a system administrator, reusing the
existing base-URL field pattern and save flow. Its "Test connection" action reuses the
existing model-catalogue route (`POST /api/settings/llm-models`) rather than adding an
endpoint.

**7. Tenant scoping and observability stay as they are.**
The rows live in the tenant-scoped `settings` table but the endpoint remains operator-level:
a tenant cannot write either key and never receives the password value. The route keeps
using `getRequestId()` and the shared logger (`orchestrator/src/server/infra/logger.ts`) for
the new validation failure, with `requestId` and `route` context. No new transport, so no
SSE helper changes.

## Risks / Trade-offs

- [Stored value now beats the environment, which can surprise a deployment that relied on
  env-override] → Documented in `docs-site/docs/features/settings.md`; the environment is
  still used whenever nothing is stored, and clearing the setting restores env behavior.
- [Dropping the `llmApiKey` password fallback breaks a setup that depended on it] →
  Documented, and the `OPENCODE_PASSWORD` fallback still covers the same case.
- [A four-character hint of an operator-level secret is visible to every tenant] → Accepted
  for consistency with `llmApiKey`; tracked as an open question if it needs tightening.
- [The password is stored in the database in plaintext] → Same storage and trust boundary as
  `llmApiKey` / `typesafeApiKey`; it is never returned, logged, or placed in error details.

## Migration Plan

- No database migration: settings are key/value rows, and the new keys simply appear on first
  save. Defaults come from the registry `envKey` fallbacks.
- Deploy by rebuilding the orchestrator image; existing `service.json` / env configuration
  keeps working unchanged until an administrator saves a value.
- Rollback: remove the two keys from the registry; any stored values become inert and the
  environment / service registration take over again.

## Open Questions

- Should the OpenCode section be hidden entirely from non-admins (not even the masked hint)?
  Deferrable: it does not change the specs, the approach, or the task breakdown.
