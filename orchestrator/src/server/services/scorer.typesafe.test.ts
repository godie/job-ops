import { createJob } from "@shared/testing/factories";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getEffectiveSettingsMock,
  resolveLlmModelMock,
  createConfiguredLlmServiceMock,
  callJsonMock,
  scoreFitMock,
  resolveKeyMock,
  TypesafeNotConfiguredErrorMock,
  TypesafeScoringErrorMock,
} = vi.hoisted(() => {
  class TypesafeNotConfiguredError extends Error {}
  class TypesafeScoringError extends Error {}
  return {
    getEffectiveSettingsMock: vi.fn(),
    resolveLlmModelMock: vi.fn(),
    createConfiguredLlmServiceMock: vi.fn(),
    callJsonMock: vi.fn(),
    scoreFitMock: vi.fn(),
    resolveKeyMock: vi.fn(),
    TypesafeNotConfiguredErrorMock: TypesafeNotConfiguredError,
    TypesafeScoringErrorMock: TypesafeScoringError,
  };
});

vi.mock("./settings", () => ({
  getEffectiveSettings: getEffectiveSettingsMock,
}));
vi.mock("@server/repositories/settings", () => ({ getSetting: vi.fn() }));
vi.mock("./prompt-templates", () => ({ renderPromptTemplate: () => "PROMPT" }));
vi.mock("./modelSelection", () => ({
  resolveLlmModel: resolveLlmModelMock,
  createConfiguredLlmService: createConfiguredLlmServiceMock,
}));
vi.mock("./typesafe-scorer", () => ({
  scoreFitWithTypeSafe: scoreFitMock,
  resolveTypesafeApiKey: resolveKeyMock,
  TypesafeNotConfiguredError: TypesafeNotConfiguredErrorMock,
  TypesafeScoringError: TypesafeScoringErrorMock,
}));

import {
  LlmNotConfiguredError,
  ScoringUnavailableError,
  scoreJobSuitability,
} from "./scorer";

const baseSettings = {
  scoringInstructions: { value: "" },
  scoringPromptTemplate: { value: "score {{jobTitle}}" },
  penalizeMissingSalary: { value: false },
  missingSalaryPenalty: { value: 0 },
  typesafeScoringEnabled: { value: true },
  typesafeModel: { value: "jev-latest" },
};

describe("scoreJobSuitability with TypeSafe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveLlmModelMock.mockResolvedValue("gpt-x");
    createConfiguredLlmServiceMock.mockResolvedValue({
      callJson: callJsonMock,
    });
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        score: 40,
        reason: "LLM reason",
        jobBrief: { role_summary: "x" },
        jobPatches: [],
        jobWarnings: [],
      },
    });
    getEffectiveSettingsMock.mockResolvedValue(baseSettings);
    resolveKeyMock.mockResolvedValue("sk-test");
  });

  it("replaces the LLM score with TypeSafe's", async () => {
    scoreFitMock.mockResolvedValue({
      score: 75,
      confidence: 0.9,
      levelPosition: 3,
      levelLabel: "x",
      probabilities: {},
      model: "jev",
      latencyMs: 1,
    });
    const result = await scoreJobSuitability(
      createJob({ id: "j1", jobDescription: "We need Node.js" }),
      {},
      { skipHostedUsage: true },
    );
    expect(result.score).toBe(75);
    expect(result.confidence).toBe(0.9);
  });

  it("keeps the LLM score and null confidence when TypeSafe is off", async () => {
    getEffectiveSettingsMock.mockResolvedValue({
      ...baseSettings,
      typesafeScoringEnabled: { value: false },
    });
    const result = await scoreJobSuitability(
      createJob({ id: "j1", jobDescription: "We need Node.js" }),
      {},
      { skipHostedUsage: true },
    );
    expect(result.score).toBe(40);
    expect(result.confidence).toBeNull();
    expect(scoreFitMock).not.toHaveBeenCalled();
  });

  it("maps a missing key to LlmNotConfiguredError", async () => {
    scoreFitMock.mockRejectedValue(new TypesafeNotConfiguredErrorMock());
    await expect(
      scoreJobSuitability(
        createJob({ id: "j1" }),
        {},
        { skipHostedUsage: true },
      ),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("maps a TypeSafe failure to ScoringUnavailableError", async () => {
    scoreFitMock.mockRejectedValue(new TypesafeScoringErrorMock("boom"));
    await expect(
      scoreJobSuitability(
        createJob({ id: "j1" }),
        {},
        { skipHostedUsage: true },
      ),
    ).rejects.toBeInstanceOf(ScoringUnavailableError);
  });
});
