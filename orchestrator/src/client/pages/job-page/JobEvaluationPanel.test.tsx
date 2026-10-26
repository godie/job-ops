import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import { createJobDetail } from "@shared/testing/factories.js";
import type { JobDetail } from "@shared/types";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobEvaluationPanel } from "./JobEvaluationPanel";

vi.mock("@/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/client/api")>();
  return {
    ...actual,
    generateEvaluationReport: vi.fn(),
    updateJob: vi.fn(),
  };
});

const makeJob = (overrides: Partial<JobDetail> = {}): JobDetail =>
  createJobDetail({
    id: "job-1",
    title: "Backend Engineer",
    employer: "Acme",
    status: "ready",
    jobDescription: "A description",
    ...overrides,
  });

describe("JobEvaluationPanel", () => {
  it("offers to generate when there is no report", () => {
    renderWithQueryClient(<JobEvaluationPanel job={makeJob()} />);

    expect(
      screen.getByRole("button", { name: /generate report/i }),
    ).toBeInTheDocument();
  });

  it("renders the report with basis and confidence", () => {
    renderWithQueryClient(
      <JobEvaluationPanel
        job={makeJob({
          evaluationReport: "## Veredicto\n\n**apply** — Strong fit.",
          evaluationReportMeta: {
            verdict: "apply",
            basis: "full_jd",
            confidence: 0.8,
          },
        })}
      />,
    );

    expect(screen.getByText(/strong fit/i)).toBeInTheDocument();
    expect(screen.getByText(/full_jd/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.8/)).toBeInTheDocument();
  });

  it("offers to reopen a skipped job when the verdict says apply", () => {
    renderWithQueryClient(
      <JobEvaluationPanel
        job={makeJob({
          status: "skipped",
          evaluationReport: "## Veredicto",
          evaluationReportMeta: {
            verdict: "apply",
            basis: "full_jd",
            confidence: 0.9,
          },
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: /move back to ready/i }),
    ).toBeInTheDocument();
  });

  it("shows progress while a report is generating", () => {
    renderWithQueryClient(
      <JobEvaluationPanel
        job={makeJob({ evaluationReportGenerating: true })}
      />,
    );

    expect(screen.getByText(/generating/i)).toBeInTheDocument();
  });

  it("asks for a description before generating", () => {
    renderWithQueryClient(
      <JobEvaluationPanel job={makeJob({ jobDescription: null })} />,
    );

    expect(
      screen.getByText(/add a job description first/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /generate report/i }),
    ).toBeDisabled();
  });
});
