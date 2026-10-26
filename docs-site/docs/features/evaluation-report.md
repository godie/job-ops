---
id: evaluation-report
title: Evaluation report
description: A readable report that explains why a job fits your CV, with the evidence and the gaps, without inventing data.
sidebar_position: 11
---

## What it is

A document, generated per job, that explains the fit between the posting and your CV. It has five sections:

| Section | What it answers |
|---|---|
| Veredicto | Apply, consider or skip, with a one-paragraph reason |
| Evidencia JD ↔ CV | A table pairing each requirement with the CV evidence |
| Gaps | What the posting asks for that your CV does not show |
| Compensación | The salary on the posting, or an explicit "not verified" |
| Señales de la oferta | Expired deadline, no employer URL, no salary, very short description |

## Why it exists

The suitability score answers *how much* a job fits, not *why*. The report answers *why*, so you can decide without re-reading the posting.

It deliberately does not invent anything:

- Salary comes from the posting. When the posting has none, the report says **No verificado** instead of estimating a range.
- Company signals are computed from the job record, not from the model.
- The evidence table only cites what your profile contains; anything else is listed as a gap.

## How to use it

1. Open a job that has a description.
2. Select **Evaluation** in the left column of the job page.
3. Press **Generate report**. This takes one model call; the view switches to a progress state until it finishes.
4. Read the verdict, the evidence table and the gaps.
5. Press **Regenerate** after you update your profile or the job description.

What gets sent to the model: the job title, employer, description, and the same sanitized profile fields job-ops already sends for scoring. Contact details are never sent.

### Defaults and constraints

- One report per job; generating again replaces the previous one.
- A lock of 5 minutes prevents paying twice for the same job if you press the button twice or reload mid-run.
- The report does not expire or refresh by itself. The date it was generated is shown next to the verdict.

## Common problems

### The Generate button is disabled

The job has no description. Add one in the job details first — there is nothing to evaluate without it.

### "A report is already being generated"

A run is still in flight, or one crashed less than 5 minutes ago. Wait for the view to leave the progress state; after the 5-minute window the lock is released.

### The report says apply but the job is skipped

The report and the score are separate judgements. The view offers **Move back to ready** so you can act on the report explicitly; nothing changes status on its own.

### The report fails with an LLM error

The generation needs a configured LLM. Check **Settings → Model**. No report is stored when the call fails, and the previous one is kept.

### The date looks old

Nothing regenerates automatically. If your profile changed since, press **Regenerate**.

## Related pages

- [/docs/features/orchestrator](/docs/features/orchestrator)
- [/docs/features/ghostwriter](/docs/features/ghostwriter)
- [/docs/features/settings](/docs/features/settings)
