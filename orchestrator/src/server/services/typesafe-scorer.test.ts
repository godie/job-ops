import { createJob } from "@shared/testing/factories";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractFitAnswer,
  FIT_LEVELS,
  mapFitLevelToScore,
  scoreFitWithTypeSafe,
  TypesafeNotConfiguredError,
  TypesafeScoringError,
} from "./typesafe-scorer";

describe("mapFitLevelToScore", () => {
  it("maps the 5 levels to 0-100", () => {
    expect(mapFitLevelToScore(0)).toBe(0);
    expect(mapFitLevelToScore(2)).toBe(50);
    expect(mapFitLevelToScore(3)).toBe(75);
    expect(mapFitLevelToScore(4)).toBe(100);
  });

  it("rounds fractional positions and clamps", () => {
    expect(mapFitLevelToScore(3.2)).toBe(80);
    expect(mapFitLevelToScore(-1)).toBe(0);
    expect(mapFitLevelToScore(9)).toBe(100);
  });

  it("returns 0 without dividing by zero", () => {
    expect(mapFitLevelToScore(0, 1)).toBe(0);
  });
});

describe("extractFitAnswer", () => {
  it("reads score, confidence and probabilities", () => {
    const answer = extractFitAnswer({
      answers: {
        fit: {
          type: "score",
          score: 3,
          confidence: 0.9,
          legend: { "3": "Good fit: meets nearly all relevant requirements" },
          probabilities: { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 },
        },
      },
    });
    expect(answer.score).toBe(3);
    expect(answer.confidence).toBe(0.9);
    expect(answer.levelLabel).toBe(
      "Good fit: meets nearly all relevant requirements",
    );
  });

  it("throws on a malformed payload", () => {
    expect(() => extractFitAnswer({ answers: {} })).toThrow(
      TypesafeScoringError,
    );
  });
});

describe("scoreFitWithTypeSafe", () => {
  const job = createJob({
    id: "j1",
    title: "Backend Engineer",
    employer: "Acme",
  });
  const fitBody = (score: number, confidence: number) =>
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        fit: {
          type: "score",
          score,
          confidence,
          legend: { [String(score)]: FIT_LEVELS[score] },
          probabilities: { [String(score)]: 0.9 },
        },
      },
    });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws TypesafeNotConfiguredError without a key", async () => {
    await expect(
      scoreFitWithTypeSafe({
        job,
        profile: {},
        apiKey: null,
        model: "jev-latest",
        scoringInstructions: "",
      }),
    ).rejects.toBeInstanceOf(TypesafeNotConfiguredError);
  });

  it("returns a mapped score on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => fitBody(3, 0.88),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await scoreFitWithTypeSafe({
      job,
      profile: { skills: [] },
      apiKey: "sk-test",
      model: "jev-latest",
      scoringInstructions: "",
    });

    expect(result.score).toBe(75);
    expect(result.confidence).toBe(0.88);
    expect(result.model).toBe("jev-1.13.0");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries once on 429 then returns the mapped score", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "slow",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => fitBody(2, 0.7),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await scoreFitWithTypeSafe({
      job,
      profile: {},
      apiKey: "x",
      model: "m",
      scoringInstructions: "",
    });

    expect(result.score).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws TypesafeScoringError on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, text: async () => "no" }),
    );
    await expect(
      scoreFitWithTypeSafe({
        job,
        profile: {},
        apiKey: "x",
        model: "m",
        scoringInstructions: "",
      }),
    ).rejects.toBeInstanceOf(TypesafeScoringError);
  });

  it("retries once on 429 then fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "slow",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "slow",
      });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      scoreFitWithTypeSafe({
        job,
        profile: {},
        apiKey: "x",
        model: "m",
        scoringInstructions: "",
      }),
    ).rejects.toBeInstanceOf(TypesafeScoringError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wraps a rejected fetch in TypesafeScoringError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    await expect(
      scoreFitWithTypeSafe({
        job,
        profile: {},
        apiKey: "x",
        model: "m",
        scoringInstructions: "",
      }),
    ).rejects.toBeInstanceOf(TypesafeScoringError);
  });

  it("throws TypesafeScoringError on a non-JSON 200 body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "not json",
      }),
    );
    await expect(
      scoreFitWithTypeSafe({
        job,
        profile: {},
        apiKey: "x",
        model: "m",
        scoringInstructions: "",
      }),
    ).rejects.toBeInstanceOf(TypesafeScoringError);
  });
});
