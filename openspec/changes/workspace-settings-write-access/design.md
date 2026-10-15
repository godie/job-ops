# Design

## Context

See `proposal.md` — Why. Constraints that shape the approach:

- `PATCH /api/settings` authorizes with `requireSystemAdminOrSearchSettings`:
  `appMode === "hosted" || isSystemAdmin() || every key in NON_ADMIN_SEARCH_SETTING_KEYS`
  (`orchestrator/src/server/api/routes/settings.ts`). The allowlist holds search keys only,
  so every integration and preference key is admin-only today.
- Settings rows are already tenant-scoped, and in local mode
  `privateDataScopeFilter()` filters by tenant only — so "the caller's own workspace" is the
  existing write target, not something to add.
- Every key is declared once in `shared/src/settings-registry.ts`, and the update service
  (`orchestrator/src/server/services/settings-update/registry.ts`) already derives per-key
  behavior from that registry (for example `key.startsWith("backup")`).
- The client already hides some admin-only surfaces (workspace user management, backup
  management) for non-admins.

## Goals / Non-Goals

**Goals:**

- Make a workspace member's settings writable by that member, matching the docs.
- Keep one declaration of what is administrator-reserved, shared by server and client.
- Keep the outbound-URL and backup settings out of member reach.

**Non-Goals:**

- Changing the hosted-mode authorization model.
- Adding roles: `tenant_memberships.role` stays unused.
- Making the outbound URLs member-writable, with or without a transport guard.

## Decisions

**1. Declare administrator-reserved settings in the shared registry.**
Add an optional flag to the affected entries (`backupEnabled`, `backupHour`,
`backupMaxCount`, `rxresumeUrl`, `llmBaseUrl`, `pipelineWebhookUrl`,
`jobCompleteWebhookUrl`).
*Alternatives:* a set in the route (rejected — the client would need its own copy and the two
would drift) and a second allowlist of member-writable keys (rejected — every new setting
would have to be added in two places, and forgetting one silently locks it).

**2. Turn the gate into a denylist and delete the search allowlist.**
Authorize with: hosted mode, or `isSystemAdmin()`, or a payload that contains no
administrator-reserved key. `NON_ADMIN_SEARCH_SETTING_KEYS` becomes redundant and is removed.
*Alternative:* keep the search allowlist and add an admin-only set beside it (rejected — two
rules for one question, and search keys are member-writable under the new rule anyway).

**3. Reject the whole payload.**
If a payload contains an administrator-reserved key, the request fails with `403 FORBIDDEN`
and nothing is persisted, even when other keys in it are writable.
*Alternative:* persist the writable keys and report the refused ones (rejected — partial
success needs a new response shape, and the existing gate is already all-or-nothing).

**4. The client derives visibility from the same flag.**
Member-facing Settings controls are filtered by the registry flag rather than a hardcoded
list, so a control that would be refused is not offered.
*Alternative:* leave the client untouched and let the 403 surface (rejected — that is the
current broken experience).

**5. Leave the onboarding validation routes ungated.**
Validating your own key before saving it is legitimate and is what made the failure
invisible; it stops being a trap once the save succeeds.
*Alternative:* gate validation too (rejected — it removes a useful pre-save check without
adding protection).

## Risks / Trade-offs

- [Hosted mode keeps its blanket bypass, so the administrator-reserved set is not enforced
  there] → Left unchanged deliberately to avoid changing hosted semantics; recorded as an
  open question rather than silently tightened.
- [Members can now store their own integration secrets, widening what a workspace holds] →
  Secrets stay inside the workspace's own rows and are never returned by the API; the SSRF
  surface (outbound URLs) stays administrator-only.
- [The client may briefly offer administrator-reserved controls to members until the client
  work lands] → The client task is part of the same change and is covered by a test.
- [A member can now change PDF rendering and prompt settings for their workspace] → Accepted:
  they are workspace preferences, and the docs already describe them as the user's own.

## Migration Plan

- No database migration: this changes authorization, not storage. Existing rows keep working,
  and values a member could not previously save are simply writable now.
- Rollback: restore the previous gate (search allowlist + system-admin check); no stored data
  needs reverting, though values a member saved while the change was live would remain.

## Open Questions

- Should the administrator-reserved set also be enforced in hosted mode, replacing that
  mode's blanket bypass? Deferrable: it does not change the specs, the approach, or the task
  breakdown for this change.
