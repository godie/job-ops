import * as api from "@client/api";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Accordion } from "@/components/ui/accordion";
import { WebhooksSection } from "./WebhooksSection";

vi.mock("@client/api", () => ({
  getCurrentAuthUser: vi.fn(),
}));

const WebhooksHarness = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const methods = useForm<UpdateSettingsInput>({
    defaultValues: {
      pipelineWebhookUrl: "https://pipeline.com",
      jobCompleteWebhookUrl: "https://job.com",
      webhookSecret: "",
    },
  });

  return (
    <QueryClientProvider client={queryClient}>
      <FormProvider {...methods}>
        <Accordion type="multiple" defaultValue={["webhooks"]}>
          <WebhooksSection
            pipelineWebhook={{
              default: "https://default-p.com",
              effective: "https://pipeline.com",
            }}
            jobCompleteWebhook={{
              default: "https://default-j.com",
              effective: "https://job.com",
            }}
            webhookSecretHint={null}
            isLoading={false}
            isSaving={false}
          />
        </Accordion>
      </FormProvider>
    </QueryClientProvider>
  );
};

const mockCurrentUser = (isSystemAdmin: boolean) => {
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
};

describe("WebhooksSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders both webhook sections and the secret field for an administrator", async () => {
    mockCurrentUser(true);
    render(<WebhooksHarness />);

    expect(await screen.findByText("Pipeline Status")).toBeInTheDocument();
    expect(screen.getByText("Job Completion")).toBeInTheDocument();

    expect(
      screen.getByDisplayValue("https://pipeline.com"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://job.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook Secret")).toBeInTheDocument();
  });

  it("does not offer the administrator-reserved webhook URLs to a member", async () => {
    mockCurrentUser(false);
    render(<WebhooksHarness />);

    expect(await screen.findByText("Webhook Secret")).toBeInTheDocument();
    expect(screen.queryByText("Pipeline Status")).not.toBeInTheDocument();
    expect(screen.queryAllByLabelText("Webhook URL")).toHaveLength(0);
  });
});
