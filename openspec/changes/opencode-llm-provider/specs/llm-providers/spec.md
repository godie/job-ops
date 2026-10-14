# Spec Delta

## Purpose

The set of LLM provider integrations JobOps can call, and the behavior each provider
must honor: how it resolves configuration, authenticates, maps requests and responses,
selects models, handles structured output, and surfaces errors to the scoring,
tailoring, and other LLM-backed flows.

## ADDED Requirements

### Requirement: OpenCode provider is selectable

JobOps MUST expose an `opencode` provider anywhere an LLM provider is chosen (global
provider, per-purpose overrides, and onboarding), and selecting it MUST route LLM calls
through a local OpenCode server instead of a hosted provider API.

#### Scenario: Provider appears in the selection list
- **WHEN** a user opens the provider selector in Settings → Model
- **THEN** an "OpenCode" option is listed alongside the existing providers

#### Scenario: Selecting OpenCode routes calls to the server
- **WHEN** the active provider is `opencode` and an LLM-backed flow runs
- **THEN** the request is sent to the local OpenCode server, not to any other provider

### Requirement: Endpoint and credential discovery

The provider MUST resolve the OpenCode server base URL and password from the local
OpenCode service registration file, and MUST fall back to configured values (a stored
base URL/password or the `OPENCODE_PASSWORD` environment variable) when that file is
absent or unreadable. Discovery MUST NOT fail the flow when the file is missing and a
fallback is configured.

#### Scenario: Service registration present
- **WHEN** the OpenCode service registration file exists and contains `url` and `password`
- **THEN** the provider uses that URL and password without requiring manual configuration

#### Scenario: Service registration missing but fallback configured
- **WHEN** the service registration file is absent and a base URL and password are configured
- **THEN** the provider uses the configured values

#### Scenario: Neither discovery nor fallback available
- **WHEN** no server URL or password can be resolved
- **THEN** the flow fails with a configuration error and does not attempt a request

### Requirement: Basic authentication with redaction

Requests to the OpenCode server MUST authenticate with HTTP Basic auth using username
`opencode` and the resolved password. The password and the `Authorization` header MUST
NEVER be written to logs, returned in API error details, or included in a crash report.

#### Scenario: Authenticated request
- **WHEN** the provider sends a generation request
- **THEN** the request carries an `Authorization: Basic …` header for user `opencode`

#### Scenario: No credential leakage
- **WHEN** a request fails and the error is logged or surfaced
- **THEN** neither the password nor the `Authorization` header appears in the log or the error payload

### Requirement: One-shot text generation

The provider MUST generate text by sending a single prompt to the OpenCode server's
session-less generation endpoint and returning the assistant text it responds with. It
MUST NOT create or reuse sessions for ordinary generation.

#### Scenario: Successful generation
- **WHEN** the provider sends a prompt and the server responds with assistant text
- **THEN** the provider returns that text to the calling flow

#### Scenario: Server unreachable
- **WHEN** the OpenCode server cannot be reached
- **THEN** the provider surfaces an error that the calling flow treats as retryable, without crashing the process

### Requirement: Model selection and catalogue

The provider MUST accept model identifiers in the form `providerID/modelID` and MUST
apply a configurable default model when none is set. The default MUST be a model usable
through the server's API: OpenCode's free-tier models (`providerID` `opencode`) are
restricted to the OpenCode app and are rejected with a 503 over the API, so the default
is a subscription/provider model. The provider MUST be able to list the server's
available models so the UI can offer suggestions.

#### Scenario: Default model applied
- **WHEN** no model is configured for the provider
- **THEN** the provider uses its configured default model, which is usable over the API

#### Scenario: Free-tier model rejected
- **WHEN** a free-tier model (`opencode/*-free`) is selected
- **THEN** the server rejects it and the provider surfaces a retryable error rather than silently failing

#### Scenario: Catalogue available for suggestions
- **WHEN** the UI requests model suggestions for the `opencode` provider
- **THEN** the provider returns the model identifiers from the server's catalogue

### Requirement: Structured output without native schema enforcement

Because the OpenCode server does not enforce a response schema, the provider MUST
request JSON through the prompt, parse the returned text with the existing JSON parser,
and MUST be able to validate the parsed result and request a repair when validation
fails. A validation or repair failure MUST surface as an error, not as silently wrong
data.

#### Scenario: Model returns valid JSON
- **WHEN** the model returns text containing a valid JSON object
- **THEN** the provider yields the parsed object to the calling flow

#### Scenario: Model returns invalid JSON
- **WHEN** the model's first response is not valid JSON or fails schema validation
- **THEN** the provider requests a repair and yields the repaired, validated result

#### Scenario: Repair fails
- **WHEN** the repaired response still fails validation
- **THEN** the provider surfaces an error instead of returning unvalidated data

### Requirement: Error surfacing follows existing policy

The provider MUST distinguish configuration failures from transient failures so the
existing flow policy applies: a missing configuration pauses the flow with a
configuration error, while a transient server failure leaves the item unprocessed and
retryable.

#### Scenario: Authentication rejected
- **WHEN** the server rejects the credentials with a 401
- **THEN** the provider surfaces a configuration error

#### Scenario: Transient server failure
- **WHEN** the server returns a transient failure (for example a 5xx or a network error)
- **THEN** the provider surfaces a retryable error and the item is left unprocessed

### Requirement: Generation does not execute tools

The provider MUST generate text only through the server's session-less generation
endpoint and MUST NOT create sessions or use the agent path. A generation request
originated by JobOps MUST NOT run shell commands, edit files, or access the network on
the server host.

#### Scenario: Tool-free generation
- **WHEN** JobOps requests text from the OpenCode provider
- **THEN** the request uses only the session-less generation endpoint and no agent or tool execution is started

### Requirement: Endpoint scope and transport

The OpenCode server endpoint MUST be operator-level configuration that a tenant cannot
set or override, so a tenant cannot use JobOps to reach an arbitrary internal host. The
server is expected to listen on loopback, or to be reached through Docker's host aliases
(`host.docker.internal` / `gateway.docker.internal`), which are treated as local because
they reach the host over Docker's internal network rather than a public one. When JobOps
connects to a server on any other host, the connection MUST use a secure transport (TLS
or a tunnel) and MUST NOT send the credential in plaintext.

#### Scenario: Tenants cannot redirect the endpoint
- **WHEN** a tenant configures their workspace
- **THEN** they cannot set or override the OpenCode server endpoint

#### Scenario: Local or Docker-host endpoint allowed over plaintext
- **WHEN** the OpenCode server is on loopback or a Docker host alias
- **THEN** the connection is allowed over http

#### Scenario: Remote endpoint uses secure transport
- **WHEN** the OpenCode server is configured on a host other than loopback or a Docker host alias
- **THEN** the connection uses a secure transport and the credential is not sent in plaintext
