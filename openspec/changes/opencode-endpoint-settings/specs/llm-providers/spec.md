# Spec Delta

## MODIFIED Requirements

### Requirement: Endpoint and credential discovery

The provider MUST resolve the OpenCode server base URL and password from the local
OpenCode service registration file, and MUST fall back, when that file is absent or
unreadable, to the operator-configured stored setting and then to the `OPENCODE_URL` /
`OPENCODE_PASSWORD` environment variable. Discovery MUST NOT fail the flow when the file
is missing and a fallback is configured.

#### Scenario: Service registration present
- **WHEN** the OpenCode service registration file exists and contains `url` and `password`
- **THEN** the provider uses that URL and password without requiring manual configuration

#### Scenario: Service registration missing but fallback configured
- **WHEN** the service registration file is absent and a base URL and password are configured
- **THEN** the provider uses the configured values

#### Scenario: Stored setting preferred over the environment
- **WHEN** a base URL or password is stored in Settings and the matching environment variable is also set
- **THEN** the provider uses the stored value

#### Scenario: Environment used when nothing is stored
- **WHEN** no base URL or password is stored and the matching environment variable is set
- **THEN** the provider uses the environment value

#### Scenario: Neither discovery nor fallback available
- **WHEN** no server URL or password can be resolved
- **THEN** the flow fails with a configuration error and does not attempt a request

## ADDED Requirements

### Requirement: Operator can configure the endpoint from Settings

A system administrator MUST be able to set the OpenCode server base URL and password from
Settings, and both MUST persist. Writing either value MUST require system-admin access.
The password MUST never be readable: no response may carry its value, at most a masked
hint.

#### Scenario: Admin saves the endpoint
- **WHEN** a system administrator saves a server URL and password through `PATCH /api/settings`
- **THEN** the API responds `{ ok: true, data, meta: { requestId } }` and later resolutions use the saved values

#### Scenario: Non-admin write is rejected
- **WHEN** a caller that is not a system administrator (including a tenant) sends either key through `PATCH /api/settings`
- **THEN** the API responds `403 FORBIDDEN` with `{ ok: false, error: { code, message }, meta: { requestId } }` and nothing is persisted

#### Scenario: Password is never returned
- **WHEN** any caller reads settings
- **THEN** the response carries no password value, only a masked hint or a not-set marker

#### Scenario: Invalid URL is rejected
- **WHEN** an administrator saves a value that is not a valid URL
- **THEN** the API responds `400 INVALID_REQUEST` and nothing is persisted
