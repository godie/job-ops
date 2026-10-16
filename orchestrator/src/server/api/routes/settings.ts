import {
  AppError,
  badRequest,
  forbidden,
  serviceUnavailable,
  statusToCode,
  unauthorized,
  unprocessableEntity,
  upstreamError,
} from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { getRequestId, isSystemAdmin } from "@infra/request-context";
import { getJobOpsAppConfig } from "@server/config/app-mode";
import { isDemoMode, sendDemoBlocked } from "@server/config/demo";
import { getOperatorSetting, getSetting } from "@server/repositories/settings";
import { getCurrentAccountEntitlements } from "@server/services/account-entitlements";
import { enqueueAutoPdfRegenerationForSettingsChanges } from "@server/services/auto-pdf-regeneration";
import { setBackupSettings } from "@server/services/backup/index";
import { getOriginalEnvValue } from "@server/services/envSettings";
import { resetCodexSession } from "@server/services/llm/codex/client";
import {
  consumeCompletedCodexDeviceAuth,
  disconnectCodexAuth,
  getCodexDeviceAuthSnapshot,
  startCodexDeviceAuth,
} from "@server/services/llm/codex/login";
import { resolveLlmApiKey } from "@server/services/llm/credentials";
import { isHostedLocalProvider } from "@server/services/llm/hosted-policy";
import {
  assertSecureOpenCodeTransport,
  OpenCodeConfigurationError,
  openCodePasswordResolves,
  resolveEffectiveOpenCodeUrl,
  resolveEffectiveOpenCodeUrlWithSource,
} from "@server/services/llm/opencode/service";
import { LlmService } from "@server/services/llm/service";
import { clearProfileCache } from "@server/services/profile";
import {
  clearRxResumeResumeCache,
  extractProjectsFromResume,
  getResume,
  listResumes,
  RxResumeAuthConfigError,
  RxResumeRequestError,
  validateResumeSchema,
  validateCredentials as validateRxResumeCredentials,
} from "@server/services/rxresume";
import { getEffectiveSettings } from "@server/services/settings";
import { applySettingsUpdates } from "@server/services/settings-update";
import {
  ADMIN_ONLY_SETTING_KEYS,
  mapGlmProviderAlias,
  settingsRegistry,
} from "@shared/settings-registry";
import {
  type UpdateSettingsInput,
  updateSettingsSchema,
} from "@shared/settings-schema";
import {
  type AppSettings,
  LLM_PURPOSE_VALUES,
  type LlmPurpose,
} from "@shared/types";
import { type Request, type Response, Router } from "express";

export const settingsRouter = Router();

const RXRESUME_SAVE_VALIDATION_KEYS: Array<keyof UpdateSettingsInput> = [
  "rxresumeUrl",
  "rxresumeApiKey",
];
const LLM_SETTING_KEYS: Array<keyof UpdateSettingsInput> = [
  "model",
  "modelScorer",
  "modelTailoring",
  "modelProjectSelection",
  "llmProvider",
  "llmBaseUrl",
  "llmApiKey",
  "llmPurposeOverrides",
  "llmPurposeApiKeys",
];
const CLI_PROVIDERS = new Set(["codex", "gemini_cli", "claude_cli"]);

function requireSystemAdmin(res: Response): boolean {
  if (getJobOpsAppConfig().appMode === "hosted" || isSystemAdmin()) return true;
  fail(res, forbidden("System admin access is required"));
  return false;
}

// Workspace settings belong to the signed-in user's workspace. Only the
// administrator-reserved settings (backup scheduler and the outbound URLs the
// server itself calls) are refused to a non-admin, and a payload carrying one is
// refused as a whole.
function requireSettingsWriteAccess(
  res: Response,
  input: UpdateSettingsInput,
): boolean {
  if (
    getJobOpsAppConfig().appMode === "hosted" ||
    isSystemAdmin() ||
    !Object.keys(input).some((key) => ADMIN_ONLY_SETTING_KEYS.has(key))
  ) {
    return true;
  }

  fail(res, forbidden("System admin access is required"));
  return false;
}

const OPENCODE_ENDPOINT_KEYS: Array<keyof UpdateSettingsInput> = [
  "opencodeUrl",
  "opencodePassword",
];

function touchesOpenCodeEndpoint(input: UpdateSettingsInput): boolean {
  return OPENCODE_ENDPOINT_KEYS.some((key) => hasInputKey(input, key));
}

/**
 * The OpenCode endpoint is unavailable in hosted mode, where the platform owns LLM
 * configuration; the administrator-only rule is enforced by the shared classification.
 */
function requireOpenCodeEndpointWriteAccess(
  res: Response,
  input: UpdateSettingsInput,
): boolean {
  if (!touchesOpenCodeEndpoint(input)) return true;
  if (getJobOpsAppConfig().appMode === "hosted") {
    fail(
      res,
      forbidden("The OpenCode endpoint is not configurable in hosted mode"),
    );
    return false;
  }
  return true;
}

/**
 * Validate the URL a request will actually use: the payload value, else the stored one, else
 * the service registration file, else the environment. When nothing resolves, a partial save
 * (for example the password alone) is accepted and transport validation is deferred until a
 * URL exists.
 */
async function assertEffectiveOpenCodeUrl(
  res: Response,
  input: UpdateSettingsInput,
): Promise<boolean> {
  if (!touchesOpenCodeEndpoint(input)) return true;

  const override = hasInputKey(input, "opencodeUrl")
    ? (input.opencodeUrl ?? null)
    : undefined;
  const effectiveUrl = await resolveEffectiveOpenCodeUrl(override);
  if (!effectiveUrl) return true;

  try {
    assertSecureOpenCodeTransport(effectiveUrl);
    return true;
  } catch (error) {
    if (error instanceof OpenCodeConfigurationError) {
      fail(res, unprocessableEntity(error.message));
      return false;
    }
    throw error;
  }
}

/**
 * The OpenCode endpoint and the "a password resolves" indicator are administrator-only, and
 * hosted mode offers neither. The response never carries a character of the password.
 */
async function withOpenCodeEndpointVisibility(
  data: AppSettings,
): Promise<AppSettings> {
  const visible = getJobOpsAppConfig().appMode !== "hosted" && isSystemAdmin();
  if (visible) {
    // The section shows the effective URL as read-only context and edits only the stored
    // override, so a password-only save never creates a URL override.
    const effective = await resolveEffectiveOpenCodeUrlWithSource();
    data.opencodeUrl = effective?.url ?? null;
    data.opencodeUrlSource = effective?.source ?? null;
    data.opencodeUrlOverride =
      (await getOperatorSetting("opencodeUrl")) ?? null;
    data.opencodePasswordResolved = await openCodePasswordResolves();
    return data;
  }
  delete data.opencodeUrl;
  delete data.opencodeUrlOverride;
  delete data.opencodeUrlSource;
  delete data.opencodePasswordResolved;
  return data;
}

function hasInputKey<K extends keyof UpdateSettingsInput>(
  input: UpdateSettingsInput,
  key: K,
): boolean {
  return Object.hasOwn(input, key);
}

function shouldValidateRxResumeOnSave(input: UpdateSettingsInput): boolean {
  return RXRESUME_SAVE_VALIDATION_KEYS.some((key) => hasInputKey(input, key));
}

async function assertLlmSettingsEditable(): Promise<void> {
  if (getJobOpsAppConfig().appMode !== "hosted") return;
  if (!(await getCurrentAccountEntitlements()).userEditableLlmSettings) {
    throw forbidden("This hosted account uses the included AI provider.");
  }
}

function assertHostedProviderAllowed(
  provider: string | null | undefined,
): void {
  if (getJobOpsAppConfig().appMode !== "hosted") return;
  if (isHostedLocalProvider(provider)) {
    throw forbidden(
      "Local LLM providers are unavailable in hosted mode. Configure a supported hosted HTTPS provider.",
    );
  }
  if (CLI_PROVIDERS.has(normalizeLlmProviderValue(provider) ?? "")) {
    throw forbidden("CLI LLM providers are unavailable in hosted mode.");
  }
}

function assertHostedBaseUrlAllowed(value: string | null | undefined): void {
  if (getJobOpsAppConfig().appMode === "hosted" && value?.trim()) {
    throw forbidden(
      "Custom LLM base URLs are unavailable in hosted mode. Use a supported provider endpoint.",
    );
  }
}

function assertHostedLlmInputAllowed(input: UpdateSettingsInput): void {
  if (getJobOpsAppConfig().appMode !== "hosted") return;
  assertHostedProviderAllowed(input.llmProvider);
  for (const override of Object.values(input.llmPurposeOverrides ?? {})) {
    assertHostedProviderAllowed(override?.provider);
    assertHostedBaseUrlAllowed(override?.baseUrl);
  }
  assertHostedBaseUrlAllowed(input.llmBaseUrl);
}

function isMissingRxResumeConfigValidationResult(input: {
  status: number;
  message: string;
}): boolean {
  return input.status === 400 && /not configured/i.test(input.message);
}

function buildRxResumeValidationOptions(
  input: UpdateSettingsInput,
): Parameters<typeof validateRxResumeCredentials>[0] {
  return {
    v5: {
      ...(hasInputKey(input, "rxresumeApiKey")
        ? { apiKey: input.rxresumeApiKey }
        : {}),
      ...(hasInputKey(input, "rxresumeUrl")
        ? { baseUrl: input.rxresumeUrl }
        : {}),
    },
  };
}

function toRxResumeValidationAppError(
  status: number,
  message: string,
): AppError {
  if (status === 401) {
    return unauthorized(message);
  }

  if (status === 400) {
    return badRequest(message);
  }

  return new AppError({
    status,
    code: statusToCode(status),
    message,
  });
}

function normalizeLlmProviderValue(
  provider: string | null | undefined,
): string | undefined {
  if (!provider) return undefined;
  const normalized = provider.trim().toLowerCase().replace(/[-.]/g, "_");
  const mapped = mapGlmProviderAlias(normalized);
  return mapped === "claude" ? "anthropic" : mapped;
}

function getDefaultValidationBaseUrl(
  provider: string | undefined,
): string | undefined {
  if (provider === "lmstudio") return "http://localhost:1234";
  if (provider === "ollama") return "http://localhost:11434";
  if (provider === "openai_compatible") return "https://api.openai.com";
  if (provider === "glm") return "https://api.z.ai/api/paas/v4";
  return undefined;
}

const CODEX_AUTH_VALIDATION_TTL_MS = 5_000;
let codexValidationCache: {
  value: { valid: boolean; message: string | null; username?: string | null };
  expiresAtMs: number;
} | null = null;
let codexValidationInFlight: Promise<{
  valid: boolean;
  message: string | null;
  username?: string | null;
}> | null = null;

function clearCodexValidationCache(): void {
  codexValidationCache = null;
  codexValidationInFlight = null;
}

async function validateCodexCredentials(): Promise<{
  valid: boolean;
  message: string | null;
  username?: string | null;
}> {
  return await new LlmService({ provider: "codex" }).validateCredentials();
}

async function getCachedCodexValidation(): Promise<{
  valid: boolean;
  message: string | null;
  username?: string | null;
}> {
  const now = Date.now();
  if (codexValidationCache && codexValidationCache.expiresAtMs > now) {
    return codexValidationCache.value;
  }

  if (codexValidationInFlight) {
    return await codexValidationInFlight;
  }

  codexValidationInFlight = (async () => {
    const validation = await validateCodexCredentials();
    codexValidationCache = {
      value: validation,
      expiresAtMs: Date.now() + CODEX_AUTH_VALIDATION_TTL_MS,
    };
    return validation;
  })();

  try {
    return await codexValidationInFlight;
  } finally {
    codexValidationInFlight = null;
  }
}

async function resolveLlmConfig(input: {
  provider?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  purpose?: LlmPurpose | null;
}): Promise<{
  provider: string | undefined;
  apiKey: string | null;
  baseUrl: string | undefined;
}> {
  const hostedMode = getJobOpsAppConfig().appMode === "hosted";
  const [storedApiKey, storedProvider, storedBaseUrl, storedPurposeApiKeys] =
    await Promise.all([
      getSetting("llmApiKey"),
      getSetting("llmProvider"),
      getSetting("llmBaseUrl"),
      getSetting("llmPurposeApiKeys"),
    ]);
  const purposeApiKeys =
    settingsRegistry.llmPurposeApiKeys.parse(
      storedPurposeApiKeys ?? undefined,
    ) ?? {};
  const storedPurposeApiKey = input.purpose
    ? purposeApiKeys[input.purpose]?.trim()
    : null;

  const provider = normalizeLlmProviderValue(
    input.provider?.trim() ||
      storedProvider?.trim() ||
      (hostedMode ? "openrouter" : undefined),
  );
  const usesBaseUrl =
    provider === "lmstudio" ||
    provider === "ollama" ||
    provider === "glm" ||
    provider === "openai_compatible";
  const hasExplicitBaseUrlOverride =
    input.baseUrl !== undefined && input.baseUrl !== null;
  const baseUrl = usesBaseUrl
    ? hasExplicitBaseUrlOverride
      ? input.baseUrl?.trim() ||
        (hostedMode
          ? undefined
          : getOriginalEnvValue("LLM_BASE_URL")?.trim()) ||
        getDefaultValidationBaseUrl(provider)
      : storedBaseUrl?.trim() ||
        (hostedMode
          ? undefined
          : getOriginalEnvValue("LLM_BASE_URL")?.trim()) ||
        getDefaultValidationBaseUrl(provider)
    : undefined;
  const userBaseUrl = hasExplicitBaseUrlOverride
    ? input.baseUrl?.trim()
    : storedBaseUrl?.trim();

  const hasCustomUserBaseUrl =
    Boolean(userBaseUrl) &&
    userBaseUrl !== getDefaultValidationBaseUrl(provider);
  if (hostedMode && (isHostedLocalProvider(provider) || hasCustomUserBaseUrl)) {
    throw forbidden(
      "Hosted LLM providers must use supported public provider endpoints.",
    );
  }

  return {
    provider,
    apiKey: resolveLlmApiKey({
      storedApiKey: input.apiKey ?? storedApiKey,
      purposeApiKey: storedPurposeApiKey,
      provider,
      allowEnvironmentCredentials: !hostedMode,
    }),
    baseUrl,
  };
}

function parseLlmPurpose(value: unknown): LlmPurpose | null {
  if (typeof value !== "string") return null;
  return (LLM_PURPOSE_VALUES as readonly string[]).includes(value)
    ? (value as LlmPurpose)
    : null;
}

async function getCodexAuthResponseData(): Promise<{
  authenticated: boolean;
  username: string | null;
  validationMessage: string | null;
  flowStatus: string;
  loginInProgress: boolean;
  verificationUrl: string | null;
  userCode: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  flowMessage: string | null;
}> {
  let flow = getCodexDeviceAuthSnapshot();
  if (flow.status === "completed") {
    const completedFlow = consumeCompletedCodexDeviceAuth();
    if (completedFlow) {
      await resetCodexSession();
      clearCodexValidationCache();
      flow = completedFlow;
    } else {
      flow = getCodexDeviceAuthSnapshot();
    }
  }
  const validation = flow.loginInProgress
    ? await getCachedCodexValidation()
    : await validateCodexCredentials();
  if (!flow.loginInProgress) {
    clearCodexValidationCache();
  }

  return {
    authenticated: validation.valid,
    username: validation.username ?? null,
    validationMessage: validation.message,
    flowStatus: flow.status,
    loginInProgress: flow.loginInProgress,
    verificationUrl: flow.verificationUrl,
    userCode: flow.userCode,
    startedAt: flow.startedAt,
    expiresAt: flow.expiresAt,
    flowMessage: flow.message,
  };
}

/**
 * GET /api/settings - Get app settings (effective + defaults)
 */
settingsRouter.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const data = await getEffectiveSettings();
    ok(res, await withOpenCodeEndpointVisibility(data));
  }),
);

/**
 * PATCH /api/settings - Update settings overrides
 */
settingsRouter.patch(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    if (isDemoMode()) {
      return sendDemoBlocked(
        res,
        "Saving settings is disabled in the public demo.",
        { route: "PATCH /api/settings" },
      );
    }

    const input = updateSettingsSchema.parse(req.body);
    if (!requireSettingsWriteAccess(res, input)) return;
    if (!requireOpenCodeEndpointWriteAccess(res, input)) return;
    if (!(await assertEffectiveOpenCodeUrl(res, input))) return;
    if (LLM_SETTING_KEYS.some((key) => hasInputKey(input, key))) {
      await assertLlmSettingsEditable();
      assertHostedLlmInputAllowed(input);
    }
    if (shouldValidateRxResumeOnSave(input)) {
      const validation = await validateRxResumeCredentials(
        buildRxResumeValidationOptions(input),
      );
      if (!validation.ok) {
        const status = validation.status ?? 0;
        if (
          isMissingRxResumeConfigValidationResult({
            status,
            message: validation.message,
          })
        ) {
          logger.info(
            "Skipping save-time Reactive Resume validation because credentials are incomplete",
            {
              requestId: getRequestId() ?? null,
              route: "PATCH /api/settings",
              rxresumeMode: validation.mode ?? null,
              status,
            },
          );
        } else if (status >= 400 && status < 500) {
          fail(res, toRxResumeValidationAppError(status, validation.message));
          return;
        } else if (status === 0 || status >= 500) {
          logger.warn(
            "Reactive Resume save-time validation could not verify upstream availability",
            {
              requestId: getRequestId() ?? null,
              route: "PATCH /api/settings",
              rxresumeMode: validation.mode ?? null,
              status,
            },
          );
        }
      }
    }

    const plan = await applySettingsUpdates(input);
    if (plan.shouldClearRxResumeCaches) {
      clearRxResumeResumeCache();
      clearProfileCache();
    }

    const data = await getEffectiveSettings();

    if (plan.shouldRefreshBackupScheduler) {
      setBackupSettings({
        enabled: data.backupEnabled.value,
        hour: data.backupHour.value,
        maxCount: data.backupMaxCount.value,
      });
    }
    ok(res, await withOpenCodeEndpointVisibility(data));

    queueMicrotask(() => {
      void enqueueAutoPdfRegenerationForSettingsChanges({
        updatedSettingKeys: plan.updatedSettingKeys,
        requestedBy: "user",
      }).catch((error) => {
        logger.warn(
          "Failed to queue auto PDF regeneration for settings change",
          {
            route: "PATCH /api/settings",
            updatedSettingKeys: plan.updatedSettingKeys,
            error,
          },
        );
      });
    });
  }),
);

settingsRouter.post(
  "/llm-models",
  asyncRoute(async (req: Request, res: Response) => {
    if (isDemoMode()) {
      ok(res, { models: [] });
      return;
    }

    const provider =
      typeof req.body?.provider === "string" ? req.body.provider : undefined;
    const apiKey =
      typeof req.body?.apiKey === "string" ? req.body.apiKey : undefined;
    const baseUrl =
      typeof req.body?.baseUrl === "string" ? req.body.baseUrl : undefined;
    const purpose = parseLlmPurpose(req.body?.purpose);
    await assertLlmSettingsEditable();
    assertHostedProviderAllowed(provider);
    const resolved = await resolveLlmConfig({
      provider,
      apiKey,
      baseUrl,
      purpose,
    });

    const llm = new LlmService({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      allowEnvironmentCredentials: getJobOpsAppConfig().appMode !== "hosted",
      allowCliProviders: getJobOpsAppConfig().appMode !== "hosted",
    });

    try {
      const models = await llm.listModels();
      ok(res, { models });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to fetch available LLM models.";
      logger.warn("LLM model discovery failed", {
        requestId: getRequestId() ?? null,
        route: "POST /api/settings/llm-models",
        provider: resolved.provider ?? null,
        hasBaseUrl: Boolean(resolved.baseUrl),
        hasApiKey: Boolean(resolved.apiKey),
        message,
      });
      fail(
        res,
        /api key is missing/i.test(message)
          ? badRequest(message)
          : upstreamError(message),
      );
    }
  }),
);

settingsRouter.get(
  "/codex-auth",
  asyncRoute(async (_req: Request, res: Response) => {
    if (getJobOpsAppConfig().appMode === "hosted") {
      throw forbidden(
        "Codex CLI authentication is unavailable in hosted mode.",
      );
    }
    const data = await getCodexAuthResponseData();
    ok(res, data);
  }),
);

settingsRouter.post(
  "/codex-auth/start",
  asyncRoute(async (req: Request, res: Response) => {
    if (!requireSystemAdmin(res)) return;

    if (isDemoMode()) {
      fail(
        res,
        serviceUnavailable("Codex sign-in is disabled in the public demo."),
      );
      return;
    }
    if (getJobOpsAppConfig().appMode === "hosted") {
      throw forbidden(
        "Codex CLI authentication is unavailable in hosted mode.",
      );
    }

    const forceRestart = req.body?.forceRestart === true;

    try {
      clearCodexValidationCache();
      await startCodexDeviceAuth(forceRestart);
      const data = await getCodexAuthResponseData();
      ok(res, data);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to start Codex sign-in.";
      logger.warn("Codex sign-in flow failed to start", {
        requestId: getRequestId() ?? null,
        route: "POST /api/settings/codex-auth/start",
        message,
      });
      fail(res, serviceUnavailable(message));
    }
  }),
);

settingsRouter.post(
  "/codex-auth/disconnect",
  asyncRoute(async (_req: Request, res: Response) => {
    if (!requireSystemAdmin(res)) return;

    if (isDemoMode()) {
      return sendDemoBlocked(
        res,
        "Codex sign-out is disabled in the public demo.",
        { route: "POST /api/settings/codex-auth/disconnect" },
      );
    }
    if (getJobOpsAppConfig().appMode === "hosted") {
      throw forbidden(
        "Codex CLI authentication is unavailable in hosted mode.",
      );
    }

    try {
      await disconnectCodexAuth();
      await resetCodexSession();
      await applySettingsUpdates({ onboardingLlmCompleted: false });
      clearCodexValidationCache();
      const data = await getCodexAuthResponseData();
      ok(res, data);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to disconnect Codex right now.";
      logger.warn("Codex sign-out failed", {
        requestId: getRequestId(),
        route: "POST /api/settings/codex-auth/disconnect",
        message,
      });
      fail(res, serviceUnavailable(message));
    }
  }),
);

/**
 * GET /api/settings/rx-resumes - Fetch list of resumes from Reactive Resume
 */
function failRxResume(res: Response, error: unknown): void {
  if (error instanceof RxResumeAuthConfigError) {
    fail(res, badRequest(error.message));
    return;
  }
  if (error instanceof RxResumeRequestError) {
    if (error.status === 401) {
      fail(
        res,
        badRequest(
          "Reactive Resume authentication failed. Check your configured mode credentials.",
        ),
      );
      return;
    }
    if (error.status && error.status >= 500) {
      fail(res, upstreamError(error.message));
      return;
    }
    if (error.status && error.status >= 400 && error.status < 500) {
      fail(
        res,
        new AppError({
          status: error.status,
          code: statusToCode(error.status),
          message: error.message,
        }),
      );
      return;
    }
    if (error.status === 0) {
      fail(
        res,
        serviceUnavailable(
          "Reactive Resume is unavailable. Check the URL and try again.",
        ),
      );
      return;
    }
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  logger.error("Reactive Resume route request failed", { message, error });
  fail(res, upstreamError(message));
}

settingsRouter.get(
  "/rx-resumes",
  asyncRoute(async (_req: Request, res: Response) => {
    try {
      const resumes = await listResumes();

      ok(res, {
        resumes: resumes.map((resume) => ({
          id: resume.id,
          name: resume.name,
        })),
      });
    } catch (error) {
      failRxResume(res, error);
    }
  }),
);

/**
 * GET /api/settings/rx-resumes/:id/projects - Fetch project catalog from Reactive Resume (v5 adapter)
 */
settingsRouter.get(
  "/rx-resumes/:id/projects",
  asyncRoute(async (req: Request, res: Response) => {
    try {
      const resumeId = req.params.id;
      if (!resumeId) {
        fail(res, badRequest("Resume id is required."));
        return;
      }

      const resume = await getResume(resumeId);
      const validated = await validateResumeSchema(resume.data ?? {});
      if (!validated.ok) {
        fail(res, badRequest(validated.message));
        return;
      }
      const { catalog } = extractProjectsFromResume(resume.data ?? {});

      ok(res, { projects: catalog });
    } catch (error) {
      failRxResume(res, error);
    }
  }),
);
