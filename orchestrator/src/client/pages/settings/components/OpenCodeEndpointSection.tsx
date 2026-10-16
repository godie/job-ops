import * as api from "@client/api";
import { useIsSystemAdmin } from "@client/hooks/useIsSystemAdmin";
import { queryKeys } from "@client/lib/queryKeys";
import { SettingsInput } from "@client/pages/settings/components/SettingsInput";
import type { ModelValues } from "@client/pages/settings/types";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import { useQuery } from "@tanstack/react-query";
import type React from "react";
import { useState } from "react";
import { useFormContext } from "react-hook-form";
import { toast } from "sonner";
import { showErrorToast } from "@/client/lib/error-toast";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const SOURCE_LABELS: Record<string, string> = {
  setting: "set here",
  "service-registration": "from the OpenCode service registration",
  environment: "from the OPENCODE_URL environment variable",
};

type OpenCodeEndpointSectionProps = {
  values: ModelValues;
  disabled: boolean;
};

/**
 * Operator-level OpenCode endpoint. Shown only in local mode to a system administrator, and
 * it edits only the stored override: the effective URL is read-only context, leaving the
 * password field untouched keeps the stored password, and clearing it is an explicit action.
 */
export const OpenCodeEndpointSection: React.FC<
  OpenCodeEndpointSectionProps
> = ({ values, disabled }) => {
  const isSystemAdmin = useIsSystemAdmin();
  const appStatusQuery = useQuery({
    queryKey: queryKeys.app.status(),
    queryFn: api.getAppStatus,
  });
  const {
    register,
    setValue,
    watch,
    formState: { errors, dirtyFields },
  } = useFormContext<UpdateSettingsInput>();
  const [isChecking, setIsChecking] = useState(false);

  if (!isSystemAdmin || appStatusQuery.data?.appMode === "hosted") return null;

  const passwordTouched = Boolean(dirtyFields.opencodePassword);
  const passwordWillBeCleared =
    passwordTouched && (watch("opencodePassword") ?? "") === "";
  const effectiveSource =
    SOURCE_LABELS[values.opencodeUrlSource ?? "setting"] ??
    SOURCE_LABELS.setting;

  const checkConnection = async () => {
    setIsChecking(true);
    try {
      const models = await api.getLlmModels({ provider: "opencode" });
      toast.success(
        models.length > 0
          ? `Connected. ${models.length} models available.`
          : "Connected.",
      );
    } catch (error) {
      showErrorToast(error, "Could not reach the saved OpenCode server");
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className="space-y-4">
      <Separator />
      <div className="space-y-1">
        <div className="text-sm font-semibold">OpenCode server</div>
        <p className="text-sm text-muted-foreground">
          Operator-level: every workspace uses the same endpoint. The URL field
          stores an override for this deployment; leaving the password untouched
          keeps the stored one.
        </p>
      </div>

      <SettingsInput
        label="Server URL"
        inputProps={register("opencodeUrl")}
        placeholder="http://host.docker.internal:49374"
        disabled={disabled}
        error={errors.opencodeUrl?.message as string | undefined}
        helper={
          values.opencodeUrl
            ? `Effective URL: ${values.opencodeUrl} (${effectiveSource}).`
            : "No URL resolves yet: set one here, or configure the OpenCode service registration or OPENCODE_URL."
        }
        current={values.opencodeUrl ?? "—"}
      />

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <SettingsInput
          label="Password"
          inputProps={register("opencodePassword")}
          type="password"
          placeholder="Enter a new password"
          disabled={disabled}
          error={errors.opencodePassword?.message as string | undefined}
          helper={
            passwordWillBeCleared
              ? "The stored password will be deleted when you save."
              : "Leave untouched to keep the stored password."
          }
          current={
            values.opencodePasswordResolved ? "Configured" : "Not configured"
          }
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || !values.opencodePasswordResolved}
          onClick={() =>
            setValue("opencodePassword", "", {
              shouldDirty: true,
              shouldValidate: true,
            })
          }
        >
          Clear password
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || isChecking}
          onClick={checkConnection}
        >
          {isChecking ? "Checking…" : "Test connection"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Tests the saved configuration, not unsaved edits.
        </span>
      </div>
    </div>
  );
};
