import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { LlmConnectionStep } from "./LlmConnectionStep";

vi.mock("@client/api", () => ({
  getCurrentAuthUser: vi.fn().mockResolvedValue({
    id: "user-1",
    username: "test",
    displayName: null,
    isSystemAdmin: true,
    isDisabled: false,
    workspaceId: "tenant_default",
    workspaceName: "JobOps",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  }),
  disconnectCodexAuth: vi.fn(),
  getCodexAuthStatus: vi.fn().mockResolvedValue({
    authenticated: false,
    username: null,
    validationMessage: null,
    flowStatus: "idle",
    loginInProgress: false,
    verificationUrl: null,
    userCode: null,
    startedAt: null,
    expiresAt: null,
    flowMessage: null,
  }),
  getLlmModels: vi.fn().mockResolvedValue([]),
  startCodexAuth: vi.fn(),
}));

const noop = vi.fn();

// The LLM configuration it renders reads the current user, so it needs a query
// client like the app provides.
const renderWithQueryClient = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );

describe("LlmConnectionStep", () => {
  it("hides stale API key errors for Ollama", () => {
    renderWithQueryClient(
      <LlmConnectionStep
        apiKey=""
        baseUrl=""
        defaultModel="google/gemini-3-flash-preview"
        effectiveModel="google/gemini-3-flash-preview"
        isBusy={false}
        llmKeyHint={null}
        model=""
        savedBaseUrl={null}
        savedProvider="openrouter"
        selectedProvider="ollama"
        validation={{
          valid: false,
          message: "LLM API key is missing.",
          status: null,
          checked: true,
          hydrated: true,
        }}
        onApiKeyChange={noop}
        onBaseUrlChange={noop}
        onModelChange={noop}
        onProviderChange={noop}
      />,
    );

    expect(screen.getByLabelText("API key (optional)")).toBeInTheDocument();
    expect(
      screen.queryByText("LLM API key is missing."),
    ).not.toBeInTheDocument();
  });
});
