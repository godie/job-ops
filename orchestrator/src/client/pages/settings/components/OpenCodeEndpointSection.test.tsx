import * as api from "@client/api";
import type { ModelValues } from "@client/pages/settings/types";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeEndpointSection } from "./OpenCodeEndpointSection";

vi.mock("@client/api", () => ({
  getAppStatus: vi.fn(),
  getCurrentAuthUser: vi.fn(),
  getLlmModels: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const modelValues = (overrides: Partial<ModelValues> = {}): ModelValues =>
  ({
    effective: "opencode-go/grok-4.7",
    default: "opencode-go/grok-4.7",
    scorer: "",
    tailoring: "",
    projectSelection: "",
    llmProvider: "opencode",
    llmBaseUrl: "",
    llmApiKeyHint: null,
    llmPurposeOverrides: {},
    llmPurposeApiKeyHints: {},
    opencodeUrl: null,
    opencodeUrlOverride: null,
    opencodeUrlSource: null,
    opencodePasswordResolved: false,
    ...overrides,
  }) as ModelValues;

let setValueRef: ((name: "opencodePassword", value: string) => void) | null =
  null;

const Harness = ({ values }: { values: ModelValues }) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const methods = useForm<UpdateSettingsInput>({
    defaultValues: {},
  });
  setValueRef = (name, value) =>
    methods.setValue(name, value, { shouldDirty: true });

  return (
    <QueryClientProvider client={queryClient}>
      <FormProvider {...methods}>
        <OpenCodeEndpointSection values={values} disabled={false} />
      </FormProvider>
    </QueryClientProvider>
  );
};

const mockUser = (isSystemAdmin: boolean) =>
  vi.mocked(api.getCurrentAuthUser).mockResolvedValue({
    id: "user",
    username: "user",
    displayName: "User",
    isSystemAdmin,
    isDisabled: false,
    workspaceId: "tenant",
    workspaceName: "Workspace",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
  });

const mockMode = (appMode: "local" | "hosted") =>
  vi.mocked(api.getAppStatus).mockResolvedValue({
    appMode,
    capabilities: {
      hostedSignups: false,
      platformLlm: false,
      quotas: false,
      userEditableLlmSettings: true,
    },
    hostedTenantConfigured: appMode === "hosted",
  });

describe("OpenCodeEndpointSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMode("local");
    vi.mocked(api.getLlmModels).mockResolvedValue([]);
  });

  it("offers the section to an admin in local mode and shows the inherited URL as context", async () => {
    mockUser(true);
    render(
      <Harness
        values={modelValues({
          opencodeUrl: "http://127.0.0.1:5123",
          opencodeUrlSource: "service-registration",
          opencodePasswordResolved: true,
        })}
      />,
    );

    expect(await screen.findByText("OpenCode server")).toBeInTheDocument();
    // The input edits only the stored override, so it stays empty.
    expect(screen.getByLabelText("Server URL")).toHaveValue("");
    expect(
      screen.getByText(/Effective URL: http:\/\/127\.0\.0\.1:5123/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/from the OpenCode service registration/),
    ).toBeInTheDocument();
    // The password is represented by its state, never by characters.
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/./)).toBeNull();
  });

  it("is absent for a non-admin and in hosted mode", async () => {
    mockUser(false);
    const { unmount } = render(<Harness values={modelValues()} />);
    await screen.findByText("Model", { exact: false }).catch(() => null);
    expect(screen.queryByText("OpenCode server")).toBeNull();
    unmount();

    mockUser(true);
    mockMode("hosted");
    render(<Harness values={modelValues()} />);
    await screen.findByText("Model", { exact: false }).catch(() => null);
    expect(screen.queryByText("OpenCode server")).toBeNull();
  });

  it("clears the password only through the explicit control", async () => {
    mockUser(true);
    render(
      <Harness values={modelValues({ opencodePasswordResolved: true })} />,
    );

    const clear = await screen.findByRole("button", {
      name: /clear password/i,
    });
    fireEvent.click(clear);

    // The control sets an empty, dirty value, which the save turns into an explicit clear.
    expect(
      await screen.findByText(/will be deleted when you save/i),
    ).toBeInTheDocument();
    expect(setValueRef).not.toBeNull();
  });

  it("checks the saved configuration and says so", async () => {
    mockUser(true);
    vi.mocked(api.getLlmModels).mockResolvedValue(["model-a", "model-b"]);
    render(
      <Harness
        values={modelValues({
          opencodeUrl: "http://127.0.0.1:5123",
          opencodeUrlSource: "service-registration",
        })}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /test connection/i }),
    );

    await waitFor(() =>
      expect(api.getLlmModels).toHaveBeenCalledWith({ provider: "opencode" }),
    );
    expect(toast.success).toHaveBeenCalled();
    expect(
      screen.getByText(/Tests the saved configuration, not unsaved edits/),
    ).toBeInTheDocument();
  });

  it("surfaces a readable failure when the saved server is unreachable", async () => {
    mockUser(true);
    vi.mocked(api.getLlmModels).mockRejectedValue(
      new Error("connect ECONNREFUSED"),
    );
    render(<Harness values={modelValues()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: /test connection/i }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
