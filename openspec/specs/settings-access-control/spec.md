# settings-access-control Specification

## Purpose

Who may read and write JobOps settings: which settings belong to the signed-in user's
workspace and which are reserved for the system administrator, and how a workspace write
stays inside its own workspace.

## Requirements

### Requirement: Workspace members can write their own settings

An authenticated user MUST be able to write any setting that is not reserved for the system
administrator, and the write MUST apply to the caller's own workspace only.

#### Scenario: Member saves an integration setting
- **WHEN** an authenticated non-admin user sends a workspace setting (for example `rxresumeApiKey` or `llmApiKey`) through `PATCH /api/settings`
- **THEN** the API responds `{ ok: true, data, meta: { requestId } }` and the value is persisted for that user's workspace

#### Scenario: Member write stays in their workspace
- **WHEN** a member of one workspace saves a setting
- **THEN** no other workspace's stored value changes, and the member's own resolution of that setting uses the saved value

#### Scenario: Search settings keep working for members
- **WHEN** a non-admin user saves search settings such as `searchTerms` or `locationRadiusMiles`
- **THEN** the API accepts the write exactly as before

### Requirement: Administrator-reserved settings stay administrator-only

The backup scheduler settings and the outbound URLs the server itself calls MUST be writable
only by a system administrator. A payload that contains any of them MUST be rejected in full
by a non-admin caller, and the response MUST use the standard error envelope.

#### Scenario: Member is refused an administrator setting
- **WHEN** a non-admin user sends `backupEnabled`, `rxresumeUrl`, `llmBaseUrl`, `pipelineWebhookUrl`, or `jobCompleteWebhookUrl` through `PATCH /api/settings`
- **THEN** the API responds `403 FORBIDDEN` with `{ ok: false, error: { code, message }, meta: { requestId } }` and nothing is persisted

#### Scenario: A mixed payload persists nothing
- **WHEN** a non-admin user sends a writable setting together with an administrator-reserved one in the same request
- **THEN** the request is refused with `403 FORBIDDEN` and neither value is persisted

#### Scenario: Administrator can write them
- **WHEN** a system administrator sends an administrator-reserved setting
- **THEN** the API accepts the write and the value is persisted

#### Scenario: Hosted mode keeps its existing rules
- **WHEN** the deployment runs in hosted mode
- **THEN** its existing bypass and account-entitlement checks apply unchanged

### Requirement: One classification drives server and client

Each setting MUST declare whether it is administrator-reserved in one place, and both the API
authorization and the client's controls MUST derive from that declaration, so a control the
user cannot save is not offered.

#### Scenario: Client does not offer an unreserved control
- **WHEN** a non-admin user opens Settings
- **THEN** administrator-reserved controls are not offered for editing, while workspace settings are editable

#### Scenario: Classification and enforcement agree
- **WHEN** a setting is declared administrator-reserved
- **THEN** the API refuses a member write for it, and a setting that is not declared so is accepted from a member
