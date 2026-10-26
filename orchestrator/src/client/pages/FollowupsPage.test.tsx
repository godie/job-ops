import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { renderWithQueryClient } from "../test/renderWithQueryClient";
import { FollowupsPage } from "./FollowupsPage";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, fetchFollowups: vi.fn(), createJobTask: vi.fn() };
});

describe("FollowupsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows due applications with a concrete date", async () => {
    vi.mocked(api.fetchFollowups).mockResolvedValue({
      due: [
        {
          jobId: "job-1",
          employer: "Acme",
          title: "Backend Engineer",
          jobUrl: "https://example.com/job/1",
          stage: "applied",
          appliedAt: "2026-11-01T09:00:00.000Z",
          nextDueOn: "2026-11-08",
          status: "due",
          step: 0,
        },
      ],
      upcoming: [],
    });

    renderWithQueryClient(<FollowupsPage />);

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("2026-11-08")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark as sent/i })).toBeEnabled();
  });

  it("shows an empty state when nothing is due", async () => {
    vi.mocked(api.fetchFollowups).mockResolvedValue({ due: [], upcoming: [] });

    renderWithQueryClient(<FollowupsPage />);

    await waitFor(() => {
      expect(screen.getByText(/no follow-ups yet/i)).toBeInTheDocument();
    });
  });
});
