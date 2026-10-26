import { describe, expect, it } from "vitest";
import { computeFollowupState, formatLocalDate } from "./followup-cadence";

const at = (y: number, m: number, d: number, h = 9, min = 0) =>
  Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);

describe("computeFollowupState", () => {
  it("programa el primer follow-up a 7 días de la aplicación", () => {
    const state = computeFollowupState({
      stage: "applied",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 1),
      followUpsSent: 0,
      now: at(2026, 11, 8),
    });
    expect(state).toEqual({ status: "due", nextDueOn: "2026-11-08", step: 0 });
  });

  it("queda upcoming el día anterior", () => {
    const state = computeFollowupState({
      stage: "applied",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 1),
      followUpsSent: 0,
      now: at(2026, 11, 7),
    });
    expect(state).toEqual({
      status: "upcoming",
      nextDueOn: "2026-11-08",
      step: 0,
    });
  });

  it("usa 7 días para los siguientes follow-ups de una aplicación", () => {
    const state = computeFollowupState({
      stage: "applied",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 5),
      followUpsSent: 1,
      now: at(2026, 11, 11),
    });
    expect(state).toEqual({
      status: "upcoming",
      nextDueOn: "2026-11-12",
      step: 1,
    });
  });

  it("no tiene tope: el follow-up 10 sigue programándose", () => {
    const state = computeFollowupState({
      stage: "applied",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 5),
      followUpsSent: 10,
      now: at(2026, 11, 12),
    });
    expect(state).toEqual({ status: "due", nextDueOn: "2026-11-12", step: 10 });
  });

  it("usa 1 día y luego 3 cuando la empresa respondió", () => {
    const first = computeFollowupState({
      stage: "recruiter_screen",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 5),
      followUpsSent: 0,
      now: at(2026, 11, 5),
    });
    expect(first).toEqual({
      status: "upcoming",
      nextDueOn: "2026-11-06",
      step: 0,
    });

    const second = computeFollowupState({
      stage: "recruiter_screen",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 5),
      followUpsSent: 1,
      now: at(2026, 11, 5),
    });
    expect(second).toEqual({
      status: "upcoming",
      nextDueOn: "2026-11-08",
      step: 1,
    });
  });

  it("usa el agradecimiento a 1 día en entrevistas", () => {
    const state = computeFollowupState({
      stage: "technical_interview",
      outcome: null,
      appliedAt: at(2026, 11, 1),
      lastContactAt: at(2026, 11, 5),
      followUpsSent: 0,
      now: at(2026, 11, 5),
    });
    expect(state).toEqual({
      status: "upcoming",
      nextDueOn: "2026-11-06",
      step: 0,
    });
  });

  it("no aplica a jobs cerrados o con resultado", () => {
    expect(
      computeFollowupState({
        stage: "closed",
        outcome: null,
        appliedAt: at(2026, 11, 1),
        lastContactAt: at(2026, 11, 1),
        followUpsSent: 0,
        now: at(2026, 11, 5),
      }),
    ).toEqual({ status: "not_applicable", reason: "closed" });

    expect(
      computeFollowupState({
        stage: "applied",
        outcome: "rejected",
        appliedAt: at(2026, 11, 1),
        lastContactAt: at(2026, 11, 1),
        followUpsSent: 0,
        now: at(2026, 11, 5),
      }),
    ).toEqual({ status: "not_applicable", reason: "closed" });
  });

  it("no aplica si todavía no se aplicó", () => {
    expect(
      computeFollowupState({
        stage: "applied",
        outcome: null,
        appliedAt: 0,
        lastContactAt: 0,
        followUpsSent: 0,
        now: at(2026, 11, 5),
      }),
    ).toEqual({ status: "not_applicable", reason: "not_started" });
  });

  it("no cambia de fecha según la hora del día", () => {
    const base = {
      stage: "applied" as const,
      outcome: null,
      appliedAt: at(2026, 11, 1, 23, 50),
      lastContactAt: at(2026, 11, 1, 23, 50),
      followUpsSent: 0,
    };

    expect(
      computeFollowupState({ ...base, now: at(2026, 11, 7, 23, 59) }),
    ).toEqual({ status: "upcoming", nextDueOn: "2026-11-08", step: 0 });
    expect(
      computeFollowupState({ ...base, now: at(2026, 11, 8, 0, 1) }),
    ).toEqual({ status: "due", nextDueOn: "2026-11-08", step: 0 });
  });

  it("formatea en calendario local", () => {
    expect(formatLocalDate(at(2026, 11, 8, 0, 1))).toBe("2026-11-08");
  });
});
