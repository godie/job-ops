import {
  buildOpenCodeAuthHeader,
  flattenMessagesToPrompt,
  parseOpenCodeModel,
} from "../opencode/prompt";
import { joinUrl } from "../utils/http";
import { getNestedValue } from "../utils/object";
import { createProviderStrategy } from "./factory";

/**
 * OpenCode runs a local server that brokers many upstream providers behind a
 * single Basic-auth HTTP API. JobOps uses only its session-less generation
 * endpoint (no sessions, no agent tools). The resolved password is passed as
 * `apiKey`; endpoint/credential discovery lives in `opencode/service.ts`.
 */
export const openCodeStrategy = createProviderStrategy({
  provider: "opencode",
  defaultBaseUrl: "",
  requiresApiKey: false,
  modes: ["text", "none"],
  validationPaths: [],
  buildRequest: ({ baseUrl, apiKey, model, messages, jsonSchema }) => ({
    url: joinUrl(baseUrl, "/api/experimental/generate"),
    headers: {
      "Content-Type": "application/json",
      Authorization: buildOpenCodeAuthHeader(apiKey ?? ""),
    },
    body: {
      prompt: flattenMessagesToPrompt(messages, jsonSchema),
      model: parseOpenCodeModel(model),
    },
  }),
  extractText: (response) => {
    const text = getNestedValue(response, ["data", "text"]);
    return typeof text === "string" ? text : null;
  },
  getValidationUrls: () => [],
});
