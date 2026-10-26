import { beforeEach, describe, expect, it, vi } from "vitest";

const callJson = vi.fn();
const settingsMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
}));

vi.mock("../repositories/settings", () => settingsMocks);
vi.mock("@server/repositories/settings", () => settingsMocks);

vi.mock("./modelSelection", () => ({
  resolveLlmModel: vi.fn(async () => "test-model"),
  createConfiguredLlmService: vi.fn(async () => ({ callJson })),
}));

vi.mock("./hosted-usage", () => ({
  withHostedUsageReservation: async (
    _args: unknown,
    work: () => Promise<{ result: unknown; usedUnits: number }>,
  ) => (await work()).result,
}));

vi.mock("./writing-style", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./writing-style")>();
  return {
    ...actual,
    getWritingStyle: vi.fn(async () => ({
      tone: "professional",
      formality: "medium",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    })),
  };
});

import { getSetting } from "../repositories/settings";
import {
  EvaluationReportNotApplicableError,
  type EvaluationReportResult,
  generateEvaluationReport,
  renderEvaluationMarkdown,
} from "./evaluation-report";

const baseJob = {
  id: "job-1",
  title: "Backend Engineer",
  employer: "Acme",
  salary: null,
  employerUrl: "https://acme.com",
  deadline: null,
  jobDescription: "x".repeat(1600),
} as unknown as Parameters<typeof renderEvaluationMarkdown>[0]["job"];

const llmResult: EvaluationReportResult = {
  verdict: "apply",
  summary: "Strong backend fit.",
  scoreBreakdown: {
    match: 4,
    northStar: 4,
    comp: null,
    culture: 3,
    redFlags: 2,
  },
  evidence: [
    {
      requirement: "TypeScript",
      cvMatch: "strong",
      evidence: "6 years of TypeScript",
    },
  ],
  gaps: ["No Kubernetes"],
  basis: "minimal_jd",
  confidence: 0.9,
};

beforeEach(() => {
  callJson.mockReset();
  callJson.mockResolvedValue({ success: true, data: llmResult });
  settingsMocks.getSetting.mockResolvedValue(null);
});

describe("generateEvaluationReport", () => {
  it("degrades the basis when the description is short", async () => {
    const { meta } = await generateEvaluationReport({
      job: { ...baseJob, jobDescription: "short" },
      profile: { basics: { name: "Diego" } },
    });

    expect(meta.basis).toBe("minimal_jd");
  });

  it("keeps full_jd when the description supports it", async () => {
    callJson.mockResolvedValue({
      success: true,
      data: { ...llmResult, basis: "full_jd" },
    });

    const { meta } = await generateEvaluationReport({
      job: baseJob,
      profile: {},
    });

    expect(meta.basis).toBe("full_jd");
  });

  it("clamps confidence into 0..1", async () => {
    callJson.mockResolvedValue({
      success: true,
      data: { ...llmResult, confidence: 3 },
    });

    const { meta } = await generateEvaluationReport({
      job: baseJob,
      profile: {},
    });

    expect(meta.confidence).toBe(1);
  });

  it("rejects a job without description", async () => {
    await expect(
      generateEvaluationReport({
        job: { ...baseJob, jobDescription: null },
        profile: {},
      }),
    ).rejects.toBeInstanceOf(EvaluationReportNotApplicableError);
  });

  it("surfaces a failed LLM call as an error", async () => {
    callJson.mockResolvedValue({ success: false, error: "upstream down" });

    await expect(
      generateEvaluationReport({ job: baseJob, profile: {} }),
    ).rejects.toThrow(/upstream down/);
  });

  it("sends the sanitized profile and never the full CV", async () => {
    await generateEvaluationReport({
      job: baseJob,
      profile: {
        basics: { name: "Diego", email: "diego@example.com" },
        experience: [{ company: "Acme", email: "secret@example.com" }],
      },
    });

    const prompt = callJson.mock.calls[0]?.[0]?.messages?.[0]?.content ?? "";
    expect(prompt).toContain("Backend Engineer");
    expect(prompt).not.toContain("secret@example.com");
  });
});

describe("renderEvaluationMarkdown", () => {
  it("writes the five sections and never invents compensation", () => {
    const markdown = renderEvaluationMarkdown({
      job: baseJob,
      result: llmResult,
    });

    expect(markdown).toContain("## Veredicto");
    expect(markdown).toContain("## Evidencia JD ↔ CV");
    expect(markdown).toContain("## Gaps");
    expect(markdown).toContain("## Compensación");
    expect(markdown).toContain("## Señales de la oferta");
    expect(markdown).toContain("No verificado");
    expect(markdown).not.toMatch(/\$\d/);
  });

  it("lists the salary when the posting has one", () => {
    const markdown = renderEvaluationMarkdown({
      job: { ...baseJob, salary: "USD 120k" },
      result: llmResult,
    });

    expect(markdown).toContain("USD 120k");
  });

  it("flags a posting with no employer url and a past deadline", () => {
    const markdown = renderEvaluationMarkdown({
      job: {
        ...baseJob,
        employerUrl: null,
        deadline: "2020-01-01",
      },
      result: llmResult,
    });

    expect(markdown).toContain("sin URL del empleador");
    expect(markdown).toContain("deadline vencido");
  });

  it("escapes pipes so the evidence table cannot break", () => {
    const markdown = renderEvaluationMarkdown({
      job: baseJob,
      result: {
        ...llmResult,
        evidence: [
          {
            requirement: "SQL | ETL",
            cvMatch: "partial",
            evidence: "built a|b pipelines",
          },
        ],
      },
    });

    expect(markdown).toContain(
      "| SQL \\| ETL | partial | built a\\|b pipelines |",
    );
  });
});

describe("evaluation report prompt template", () => {
  it("is registered as a settings key with its placeholders", async () => {
    const { PROMPT_TEMPLATE_SETTING_KEYS, getDefaultPromptTemplate } =
      await import("@shared/prompt-template-definitions");

    expect(PROMPT_TEMPLATE_SETTING_KEYS).toContain(
      "evaluationReportPromptTemplate",
    );
    expect(
      getDefaultPromptTemplate("evaluationReportPromptTemplate"),
    ).toContain("{{jobDescription}}");
  });

  it("reads a stored override instead of the default", async () => {
    settingsMocks.getSetting.mockResolvedValue("CUSTOM {{jobTitle}} PROMPT");

    await generateEvaluationReport({ job: baseJob, profile: {} });

    expect(callJson.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain(
      "CUSTOM Backend Engineer PROMPT",
    );
  });
});
