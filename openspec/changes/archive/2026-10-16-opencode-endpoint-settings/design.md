# Design

## Context

See `proposal.md` — Why. Constraints that shape the approach:

- `resolveOpenCodeEndpoint()` (`orchestrator/src/server/services/llm/opencode/service.ts`)
  resolves per call, never cached, and today puts the service registration file ahead of
  everything: base URL = registration → `OPENCODE_URL`; password = registration →
  `OPENCODE_PASSWORD` → `storedPassword`, where `storedPassword` is the caller's `llmApiKey`
  (a workaround, which is why commit `0fdb30e` put the environment ahead of it). Because the
  file wins, a running `opencode serve --service` — the normal case — would make anything
  saved in Settings inert.
- `assertSecureOpenCodeTransport()` rejects plaintext for anything but loopback and the
  Docker host aliases. It validates **transport only** — it does not filter hosts, so an
  HTTPS endpoint on any host is accepted. It is not a general SSRF guard.
- Settings are tenant-scoped rows in `settings` (`tenant_id`, `user_id`, `key`, `value`). The
  operator tenant is `DEFAULT_TENANT_ID` (`tenant_default`, `server/tenancy/constants.ts`),
  and the first/system-admin user is created in it.
- `PATCH /api/settings` authorizes through the shared classification: a payload carrying an
  `adminOnly` key requires a system admin, and hosted mode bypasses that check entirely.
- Secrets are normally surfaced as a `${key}Hint` (first four characters) to every caller.

## Goals / Non-Goals

**Goals:**

- Make the OpenCode base URL and password first-class, persisted, admin-editable in local mode,
  such that saving them actually re-points the endpoint.
- Keep the endpoint operator-level: stored in the operator tenant, selected explicitly, and
  shared by every workspace.
- Keep one per-field resolution order that every caller shares (pipeline, onboarding, catalogue).

**Non-Goals:**

- Changing the transport guard, or adding a host filter.
- Reworking `llmBaseUrl` / `llmApiKey` into a generic per-provider credential model.
- Changing the OpenCode generation, model-selection, or repair behavior.

## Decisions

**1. Two dedicated settings, not the shared LLM keys.**
Add `opencodeUrl` (`kind: "string"`, `envKey: "OPENCODE_URL"`, nullable URL schema like
`rxresumeUrl`) and `opencodePassword` (`kind: "secret"`, `envKey: "OPENCODE_PASSWORD"`), both
`adminOnly: true`.
*Alternatives:* reuse `llmBaseUrl` (rejected — shared by every provider, so saving an OpenCode
URL would silently change Ollama) and reuse `llmApiKey` (rejected — provider-key semantics,
and the source of the ambiguity behind the env-first workaround).

**2. Operator-level storage: one global scope, one row per key.**
`settings` is a key/value table, so `opencodeUrl` and `opencodePassword` are two separate rows.
Both are keyed with the same global scope `(tenant_id = DEFAULT_TENANT_ID, user_id IS NULL)`.
`user_id IS NULL` is what makes them operator-level rather than per-user: neither row belongs to
whichever administrator wrote it, so every administrator and every workspace reads and updates
the same two values. Reads select those rows explicitly instead of using the per-request
workspace scope, and writes upsert them with a null `user_id` instead of the caller's, rather
than going through the generic scoped write.
*Alternatives:* store them under the calling administrator's `user_id` (rejected — a second
administrator or a different workspace would see nothing, so "operator-level" would silently
become per-user); store them in the caller's workspace (rejected — that makes the endpoint
per-tenant and breaks the current spec's operator-level guarantee); keep them environment-only
(rejected — nothing could persist from the UI).

**3. Authorization: the shared classification plus an explicit hosted rule.**
`adminOnly: true` makes `PATCH /api/settings` refuse a non-admin payload containing either key.
Hosted mode short-circuits that gate, so the handler also refuses these two keys when the
deployment is hosted: the platform owns LLM configuration there.
*Alternative:* rely on the classification alone (rejected — hosted mode would let any tenant
write the endpoint).

**4. Precedence is stored → registration file → environment, per field.**
The value the operator saved explicitly wins; the registration file and the environment are
the fallbacks while nothing is stored. Each field resolves independently, so a registration
file carrying only a URL does not discard the password fallback.
*Alternatives:* keep the registration file first (rejected — this is the contradiction the
change exists to fix: with `service.json` present, Settings could not re-point the endpoint and
the connection check would test a value the form could not change); keep the environment first
(rejected for the same reason, and because `.env` commonly defines `OPENCODE_PASSWORD`).

**5. Update semantics: omitted keeps, clearing falls through.**
A field omitted from the payload keeps its stored value. Clearing a field — `null` or an empty
string — removes the stored override so that field resolves from the registration file or the
environment again. Updating one field never writes the other.
*Alternative:* treat a missing field as "clear" (rejected — it would silently drop the password
whenever an administrator edits only the URL).

**6. The `llmApiKey` fallback is removed.**
`resolveLlmApiKey` no longer feeds the OpenCode password; the endpoint resolution becomes the
single source for both values.
*Alternative:* keep it last (rejected — it is the ambiguity that forced the env-first
workaround, and it leaves "where does my password come from?" unanswerable).

**7. Secrets and URL visibility, restricted to the administrator.**
No response carries the password or any part of it, for any caller including a system
administrator. A system administrator's response reports a single boolean meaning **an OpenCode
password resolves from any source** — the stored override, the registration file, or the
environment — and never its value, nor which source provides it. That boolean and the server URL
are administrator-only: a non-admin's response carries neither of them, and never the password.
The password, the `Authorization` header, and any server URL carrying embedded credentials never
reach logs, `error.details`, or responses.
*Alternative:* emit the indicator to every caller (rejected — the whole section is admin-only, so
a non-admin would learn about operator-level configuration they cannot see or change).
*Alternative:* reuse the four-character hint (rejected — it leaks characters of an
operator-level secret, and the change wants a strict write-only password). *Alternative:* report
only whether an override is stored (rejected — it would read "not configured" while the
environment authenticates fine, and would contradict the connection check).

**8. Validation uses the effective URL, and the connection check uses the effective endpoint.**
The URL schema requires a valid absolute URL without `userinfo`, so a value carrying `user:pass@`
is `400 INVALID_REQUEST`. When a URL resolves, the handler validates the **effective** URL —
payload value, else stored value, else registration file, else environment — with
`assertSecureOpenCodeTransport()`, so a partial update is validated against the URL that will
actually be used and a remote plaintext URL is `422 UNPROCESSABLE_ENTITY`. When no URL resolves
at all, a partial save (for example the password alone) is still accepted and transport
validation is deferred until a URL exists. A partial save is allowed, but no request is
attempted until a URL and a password resolve and the guard passes; the guard also runs at
resolution time as the authoritative check, for **every** source, so no URL — stored, from the
registration file, or from the environment — can reach a request without passing it. An
inherited remote-plaintext URL fails as a configuration error instead of being used, and a URL
carrying embedded credentials is never used or surfaced: a stored one is rejected at save with
`400 INVALID_REQUEST`, an inherited one is refused at resolution. A source that provides a value
failing the rule **fails closed** — it is an error, not an absence, so resolution does not fall
through to a lower source and no request is attempted. The section's connection
check reuses `POST /api/settings/llm-models`, which resolves the provider configuration
server-side, so it exercises that same effective endpoint rather than the form.
*Alternative:* validate only the payload's URL (rejected — changing just the password would then
skip the guard, and the check could pass for a URL the flows never use).

**9. The section edits only the stored override, and distinguishes "untouched" from "clear".**
The Server URL input holds the stored override and stays empty when nothing is stored; the
effective URL and its source (setting, registration file, or environment) are shown as
read-only context, next to the boolean that reports whether a password resolves. Saving only
the password therefore stores no URL override, and an inherited URL is never silently promoted
into one. The password field never renders a value, so an empty field cannot mean both "leave
it alone" and "delete it": leaving it untouched omits `opencodePassword` from the request (the
stored password is preserved), and removing it requires the section's explicit clear action,
which sends the clear value.
*Alternatives:* prefill the URL input with the effective URL (rejected — saving the password
alone would persist an inherited URL as an override and freeze it against later changes to the
registration file); treat an empty password field as a clear (rejected — editing the URL alone
would silently delete a working password).

**10. Observability stays as it is.**
The route keeps `getRequestId()` and the shared logger
(`orchestrator/src/server/infra/logger.ts`) for the new validation failure, with `requestId`
and `route` context. No new transport, so no SSE helper changes.

## Risks / Trade-offs

- [A stored value shadows a registration file that changes later — for example when
  `opencode serve` picks a new port, a stale saved URL keeps winning] → The administrator's
  section shows the effective URL and its source as read-only context, and the connection check
  surfaces a stale one; clearing the field restores the registration file immediately.
  Documented with the precedence.
- [Stored value now beats the environment and the registration file, which can surprise a
  deployment that relied on either] → Documented. Clearing a field falls back to the
  registration file first and to the environment only when the file does not provide that
  field, so a cleared value restores the previous behaviour in that order.
- [Dropping the `llmApiKey` password fallback breaks a setup that depended on it] → A
  deployment that resolved its password **only** through `llmApiKey` does not keep working by
  itself: it needs a manual migration to the new setting, to `service.json`, or to
  `OPENCODE_PASSWORD`. Documented as a migration step, not as a covered case.
- [Hosted mode cannot configure the OpenCode endpoint] → Deliberate: the platform owns LLM
  configuration there, and the spec states the feature is unavailable.
- [The password is stored in the database in plaintext] → Same storage and trust boundary as
  `llmApiKey` / `typesafeApiKey`; it is never returned, logged, or placed in error details.
- [Non-admins cannot see the URL, so they cannot self-diagnose an unreachable server] →
  Accepted: the endpoint is operator-level, and the administrator's section shows it.

## Migration Plan

- No database migration: settings are key/value rows, and the new keys appear on first save.
  Defaults come from the registry `envKey` fallbacks.
- Deploy by rebuilding the orchestrator image; existing `service.json` / env configuration keeps
  working unchanged until an administrator saves a value, at which point the saved value takes
  precedence for that field.
- Migration for the removed fallback: a deployment whose OpenCode password came **only** from
  the stored `llmApiKey` must set it through the new setting, `service.json`, or
  `OPENCODE_PASSWORD`. Nothing migrates it automatically, and until it is set the OpenCode flow
  fails with the configuration error.
- Rollback: remove the two keys from the registry; any stored values become inert and the
  service registration / environment take over again.
