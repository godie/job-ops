# Proposal

## Why

The docs promise that each user gets a private workspace and that "normal users can use
their private workspace settings" (`docs-site/docs/features/settings.md`), and every setting
row is already scoped to the caller's tenant. The code contradicts that: `PATCH
/api/settings` calls `requireSystemAdminOrSearchSettings`, which only lets a system admin
write, except for an allowlist of *search* keys. A normal user therefore cannot save their
own RxResume key, LLM key, integrations, prompts, or scoring preferences — they get `403
FORBIDDEN`.

The failure is also invisible: `/api/onboarding/validate/*` is not gated, so validating a key
reports success while the save that follows is rejected. The user only discovers the problem
later, when PDF generation fails with "Reactive Resume API key is not configured".

## What Changes

- Classify settings as **workspace-writable** (the default) or **admin-only**, declared once
  in the shared registry so the server gate and the client controls agree.
- Admin-only is limited to the settings that are not workspace data:
  - the backup scheduler (`backupEnabled`, `backupHour`, `backupMaxCount`);
  - the outbound URLs the server itself calls or posts to (`rxresumeUrl`, `llmBaseUrl`,
    `pipelineWebhookUrl`, `jobCompleteWebhookUrl`), which are SSRF surface rather than
    workspace preference.
- Change `PATCH /api/settings` so an authenticated non-admin is allowed whenever the payload
  touches no admin-only key, and still receives `403 FORBIDDEN` when it does. The
  search-only allowlist becomes redundant and is removed.
- Hide (or disable) the admin-only controls for non-admins in the client, so the UI stops
  offering saves that will be refused.
- Update `docs-site/docs/features/settings.md` to name the admin-only settings explicitly.

**Out of scope**

- Relaxing the transport/SSRF guard or opening the outbound URLs to workspaces.
- Backup permissions and the backup UI beyond hiding it for non-admins.
- The OpenCode endpoint settings (separate change, `opencode-endpoint-settings`).
- Per-member roles: `tenant_memberships.role` stays unused for authorization.

## Capabilities

### New Capabilities

- `settings-access-control`: who may read and write which settings, and how a workspace
  member's writes stay inside their own workspace.

### Modified Capabilities

None.

## Impact

- **Code**: `shared/src/settings-registry.ts` (admin-only classification);
  `orchestrator/src/server/api/routes/settings.ts` (the gate);
  `orchestrator/src/server/services/settings-update/registry.ts` (if the classification is
  consumed there); the client Settings pages (hide admin-only controls); the docs page.
- **Multi-tenant impact**: writes remain scoped to the caller's workspace by the existing
  settings scope filter, so opening the gate does not let one workspace read or write
  another's rows. Admin-only keys stay operator-controlled, so a member cannot redirect the
  server's outbound calls or change the backup schedule.
- **`/api/*` contract**: `PATCH /api/settings` keeps `{ ok: true, data, meta: { requestId } }`
  on success; it answers `403 FORBIDDEN` only when the payload contains an admin-only key,
  with the standard error envelope. No response shape changes.
- **Payloads**: no webhook or LLM payload changes. The values a workspace may now save are
  the same ones the admin could already save on its behalf.
- **Dependencies**: none new.
