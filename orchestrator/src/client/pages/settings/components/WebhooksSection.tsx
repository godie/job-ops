import { useIsSystemAdmin } from "@client/hooks/useIsSystemAdmin";
import { SettingsInput } from "@client/pages/settings/components/SettingsInput";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import type { WebhookValues } from "@client/pages/settings/types";
import { formatSecretHint } from "@client/pages/settings/utils";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type React from "react";
import { useFormContext } from "react-hook-form";
import { Separator } from "@/components/ui/separator";

type WebhooksSectionProps = {
  pipelineWebhook: WebhookValues;
  jobCompleteWebhook: WebhookValues;
  webhookSecretHint: string | null;
  isLoading: boolean;
  isSaving: boolean;
  layoutMode?: "accordion" | "panel";
};

export const WebhooksSection: React.FC<WebhooksSectionProps> = ({
  pipelineWebhook,
  jobCompleteWebhook,
  webhookSecretHint,
  isLoading,
  isSaving,
  layoutMode,
}) => {
  const {
    register,
    formState: { errors },
  } = useFormContext<UpdateSettingsInput>();
  // The webhook destinations are administrator-reserved (the server posts to them),
  // so a workspace member is not offered them; the shared secret stays theirs.
  const isSystemAdmin = useIsSystemAdmin();

  return (
    <SettingsSectionFrame mode={layoutMode} title="Webhooks" value="webhooks">
      <div className="space-y-6">
        {isSystemAdmin ? (
          <div className="space-y-4">
            <div className="text-sm font-medium">Pipeline Status</div>
            <SettingsInput
              label="Webhook URL"
              inputProps={register("pipelineWebhookUrl")}
              placeholder={pipelineWebhook.default || "https://..."}
              disabled={isLoading || isSaving}
              error={errors.pipelineWebhookUrl?.message as string | undefined}
              helper={`When set, the server sends a POST on pipeline completion/failure. Default: ${pipelineWebhook.default || "—"}.`}
              current={pipelineWebhook.effective || "—"}
            />
          </div>
        ) : null}

        <Separator />

        <div className="space-y-4">
          <div className="text-sm font-medium">Job Completion</div>
          <div className="space-y-4">
            {isSystemAdmin ? (
              <SettingsInput
                label="Webhook URL"
                inputProps={register("jobCompleteWebhookUrl")}
                placeholder={jobCompleteWebhook.default || "https://..."}
                disabled={isLoading || isSaving}
                error={
                  errors.jobCompleteWebhookUrl?.message as string | undefined
                }
                helper={`When set, the server sends a POST when you mark a job as applied (includes the job description). Default: ${jobCompleteWebhook.default || "—"}.`}
                current={jobCompleteWebhook.effective || "—"}
              />
            ) : null}

            <SettingsInput
              label="Webhook Secret"
              inputProps={register("webhookSecret")}
              type="password"
              placeholder="Enter new secret"
              disabled={isLoading || isSaving}
              error={errors.webhookSecret?.message as string | undefined}
              helper="Secret sent to webhook (Bearer token)"
              current={formatSecretHint(webhookSecretHint)}
            />
          </div>
        </div>
      </div>
    </SettingsSectionFrame>
  );
};
