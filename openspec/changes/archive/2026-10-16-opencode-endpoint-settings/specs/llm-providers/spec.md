# Spec Delta

## MODIFIED Requirements

### Requirement: Endpoint and credential discovery

The provider MUST resolve the OpenCode server URL and password per field: stored operator
setting, then the local service registration file, then the matching `OPENCODE_URL` /
`OPENCODE_PASSWORD` environment variable. A saved value therefore wins over a published
registration file. A field missing from a higher source MUST NOT discard the other field's
fallback, and an absent, unreadable, or malformed file MUST NOT fail discovery when a
fallback resolves. The stored `llmApiKey` MUST NOT be used as the password.

#### Scenario: Service registration present
- **WHEN** the registration file exists and contains `url` and `password`, and neither field is stored in Settings
- **THEN** the provider uses that URL and password without requiring manual configuration

#### Scenario: Service registration missing but fallback configured
- **WHEN** the service registration file is absent and a base URL and password are configured
- **THEN** the provider uses the configured values

#### Scenario: Neither discovery nor fallback available
- **WHEN** either the server URL or the password cannot be resolved, whether or not the other resolves
- **THEN** the flow fails with a configuration error and does not attempt a request

#### Scenario: URL cannot be resolved
- **WHEN** no source provides a server URL while a password resolves
- **THEN** the flow fails with the configuration error and no request is attempted

#### Scenario: Password cannot be resolved
- **WHEN** no source provides a password while a server URL resolves
- **THEN** the flow fails with the configuration error and no request is attempted

#### Scenario: Stored setting wins over the service registration file
- **WHEN** a base URL or password is stored in Settings and the registration file also provides that field
- **THEN** the provider uses the stored value for that field, so the endpoint can be re-pointed without editing the registration file

#### Scenario: Stored setting wins over the environment
- **WHEN** a base URL or password is stored in Settings and the matching environment variable is also set
- **THEN** the provider uses the stored value for that field

#### Scenario: Registration file used when nothing is stored
- **WHEN** no base URL or password is stored and the registration file provides that field
- **THEN** the provider uses the registration file's value for that field

#### Scenario: Environment used when nothing is stored
- **WHEN** no base URL or password is stored, the registration file does not provide that field, and the matching environment variable is set
- **THEN** the provider uses the environment value

#### Scenario: Registration file supplies only one field
- **WHEN** the registration file contains a URL but no password, or a password but no URL
- **THEN** the missing field resolves from the stored setting or the matching environment variable when one of those is configured

#### Scenario: Partial registration with no other source
- **WHEN** the registration file provides only one field and no other source provides the missing one
- **THEN** the flow fails with the configuration error and does not attempt a request

#### Scenario: Unreadable or malformed registration file
- **WHEN** the registration file cannot be read or does not parse
- **THEN** discovery continues with the stored setting and the environment variable rather than failing

#### Scenario: Clearing a setting restores the fallback
- **WHEN** a stored base URL or password is cleared
- **THEN** that field resolves from the registration file when the file provides it, and from the environment variable otherwise

#### Scenario: Stored LLM key is not a password source
- **WHEN** only `llmApiKey` is stored and no OpenCode password resolves otherwise
- **THEN** the flow fails with a configuration error instead of using the LLM key as the password

## ADDED Requirements

### Requirement: Operator can configure the endpoint from Settings

A system administrator MUST be able to set the OpenCode server URL and password from
Settings in local mode, and both MUST persist in the operator tenant so every workspace
resolves them. The feature MUST be unavailable in hosted mode. A field omitted from an update
MUST keep its stored value, and clearing a field MUST remove the override so that field falls
through to the next source.

#### Scenario: Admin saves the endpoint
- **WHEN** a system administrator saves a server URL and password through `PATCH /api/settings`
- **THEN** the API responds `{ ok: true, data, meta: { requestId } }` and later resolutions in every workspace use the saved values

#### Scenario: Non-admin write is rejected
- **WHEN** a caller that is not a system administrator (including a tenant) sends either key through `PATCH /api/settings`
- **THEN** the API responds `403 FORBIDDEN` with `{ ok: false, error: { code, message }, meta: { requestId } }` and nothing is persisted

#### Scenario: Hosted mode does not offer the feature
- **WHEN** the deployment runs in hosted mode
- **THEN** the settings response offers no OpenCode endpoint values and a write to either key is refused with `403 FORBIDDEN`

#### Scenario: Omitted field keeps its stored value
- **WHEN** an administrator sends only one of the two keys
- **THEN** the omitted key keeps its stored value and is not cleared

#### Scenario: Clearing a field falls back
- **WHEN** an administrator clears a field with `null` or an empty string
- **THEN** the stored override is removed and that field resolves from the registration file or the environment again

#### Scenario: Changing one field leaves the other untouched
- **WHEN** an administrator changes only the server URL, or only the password
- **THEN** the other field keeps its stored value and its resolution is unchanged

#### Scenario: Untouched password field keeps the stored password
- **WHEN** an administrator edits only the server URL and leaves the password field untouched
- **THEN** the request omits `opencodePassword`, the stored password is preserved, and the empty field implies no clear

#### Scenario: Clearing the password is an explicit action
- **WHEN** an administrator uses the section's clear action for the password
- **THEN** the request sends the explicit clear value, the override is removed, and the password then resolves from the registration file or the environment

#### Scenario: Connection check uses the effective endpoint
- **WHEN** an administrator runs the section's connection check
- **THEN** it exercises the same resolved endpoint and credentials the LLM flows use, not unsaved edits in the form

#### Scenario: Inherited URL is shown without becoming an override
- **WHEN** an administrator opens the section while the URL comes from the registration file or the environment
- **THEN** the section shows that effective URL as read-only context, the URL input holds only the stored override, and saving only the password stores no URL override

#### Scenario: Two administrators share the operator-level configuration
- **WHEN** one system administrator updates the server URL or the password
- **THEN** the other system administrator, in a different workspace, resolves the same effective configuration — as does every workspace — while still receiving only the permitted server URL and the password indicator, never the password

### Requirement: Endpoint credentials are write-only

No response MUST carry the OpenCode password or any part of it, for any caller. A response to a
system administrator MUST report only whether an OpenCode password resolves from any source —
the stored override, the registration file, or the environment — never its value and never which
source provides it. The server URL and that indicator MUST be visible only to a system
administrator: a non-admin MUST receive neither.

#### Scenario: Password is write-only for every caller
- **WHEN** any caller reads settings
- **THEN** no response carries the password or any character of its value, and only a system administrator's response reports whether one resolves

#### Scenario: Indicator reflects a resolved password
- **WHEN** a system administrator reads settings and no password override is stored but the registration file or the environment provides one
- **THEN** that administrator's response reports the password as resolved, without revealing its value or which source provides it

#### Scenario: Indicator after clearing the override
- **WHEN** an administrator clears the stored password override
- **THEN** the indicator reflects whatever still resolves — true while the registration file or the environment provides one, false otherwise

#### Scenario: Non-admin read exposes neither value
- **WHEN** a non-admin reads settings
- **THEN** the response carries neither the password, nor an indicator that one resolves, nor the server URL

#### Scenario: No credential leakage
- **WHEN** a request fails and the error is logged or surfaced
- **THEN** neither the password, nor the `Authorization` header, nor a server URL carrying embedded credentials appears in the log, in `error.details`, or in the response

### Requirement: Endpoint values are validated before use

Whatever its source — the stored setting, the registration file, or the environment — the URL a
request will use MUST pass the transport rule before that request. A source that provides a
value which fails the rule MUST fail closed with the configuration error, rather than falling
through to a lower source or being used. A partial update MUST be validated against the URL
that will actually be used.

#### Scenario: Malformed or credential-bearing URL is rejected
- **WHEN** an administrator saves a value that is not a valid URL, or a URL that carries embedded credentials
- **THEN** the API responds `400 INVALID_REQUEST` and nothing is persisted

#### Scenario: Remote plaintext endpoint is rejected
- **WHEN** an administrator saves an `http://` URL that is not loopback or a Docker host alias
- **THEN** the API responds `422 UNPROCESSABLE_ENTITY` and nothing is persisted

#### Scenario: Registration-file URL is validated before use
- **WHEN** the URL resolves from the registration file and it is a remote `http://` endpoint
- **THEN** the flow fails with the configuration error and no request is attempted

#### Scenario: Environment URL is validated before use
- **WHEN** the URL resolves from the environment variable and it is a remote `http://` endpoint
- **THEN** the flow fails with the configuration error and no request is attempted

#### Scenario: Inherited URL with embedded credentials fails closed
- **WHEN** the URL that resolves from the registration file or the environment carries embedded credentials
- **THEN** the flow fails with the configuration error, no request is attempted, and the URL is not surfaced in any response

#### Scenario: Malformed inherited URL fails closed
- **WHEN** the URL that resolves from the registration file or the environment cannot be parsed as a URL
- **THEN** the flow fails with the configuration error, no request is attempted, and the value is not surfaced in any response

#### Scenario: Partial update validates the effective URL
- **WHEN** an administrator changes only the password while a stored, registration-file, or environment URL already applies
- **THEN** the guard validates that effective URL, the update is accepted only when it passes, and no URL is required in the payload

#### Scenario: Partial update is refused when the effective URL is insecure
- **WHEN** an administrator changes only the password and the effective URL is a remote `http://` endpoint
- **THEN** the API responds `422 UNPROCESSABLE_ENTITY` and nothing is persisted

#### Scenario: Password saved before any effective URL exists
- **WHEN** an administrator saves only the password and no URL resolves from any source
- **THEN** the password is persisted, transport validation is deferred until a URL resolves, and no request is attempted until a URL and a password resolve and the URL passes the guard
