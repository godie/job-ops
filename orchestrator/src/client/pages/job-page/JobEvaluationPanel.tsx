import type { Job, JobDetail } from "@shared/types.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import type React from "react";
import * as api from "@/client/api";
import { JobDescriptionMarkdown } from "@/client/components/JobDescriptionMarkdown";
import { showErrorToast } from "@/client/lib/error-toast";
import { queryKeys } from "@/client/lib/queryKeys";
import { Button } from "@/components/ui/button";

type JobEvaluationPanelProps = {
  job: JobDetail;
};

export const JobEvaluationPanel: React.FC<JobEvaluationPanelProps> = ({
  job,
}) => {
  const queryClient = useQueryClient();
  const hasDescription = Boolean(job.jobDescription?.trim());

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.jobs.detail(job.id) });

  const generate = useMutation<
    { jobId: string; status: "generating" },
    Error,
    void
  >({
    mutationFn: () => api.generateEvaluationReport(job.id),
    onSuccess: invalidate,
    onError: (error) => showErrorToast(error, "Could not generate the report"),
  });

  const reopen = useMutation<Job, Error, void>({
    mutationFn: () => api.updateJob(job.id, { status: "ready" }),
    onSuccess: invalidate,
    onError: (error) => showErrorToast(error, "Could not move the job"),
  });

  if (job.evaluationReportGenerating) {
    return (
      <section>
        <PanelHeader />
        <div className="space-y-2 p-4 text-sm">
          <p>Generating evaluation report…</p>
          <p className="text-xs text-muted-foreground">
            This takes one model call. You can leave this page and come back.
          </p>
        </div>
      </section>
    );
  }

  if (!job.evaluationReport || !job.evaluationReportMeta) {
    return (
      <section>
        <PanelHeader />
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            No evaluation report yet. It reads the job description and your
            profile, and explains the fit with the evidence and the gaps.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={generate.isPending || !hasDescription}
            onClick={() => generate.mutate()}
          >
            Generate report
          </Button>
          {!hasDescription && (
            <p className="text-xs text-muted-foreground">
              Add a job description first.
            </p>
          )}
        </div>
      </section>
    );
  }

  const meta = job.evaluationReportMeta;

  return (
    <section>
      <PanelHeader />
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="rounded-full border px-2 py-0.5">
            {meta.verdict}
          </span>
          <span>{meta.basis}</span>
          <span>confidence {meta.confidence.toFixed(1)}</span>
          {job.evaluationReportGeneratedAt && (
            <span>{job.evaluationReportGeneratedAt.slice(0, 10)}</span>
          )}
          {job.evaluationReportModel && (
            <span>{job.evaluationReportModel}</span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={generate.isPending}
            onClick={() => generate.mutate()}
          >
            Regenerate
          </Button>
        </div>

        {meta.verdict === "apply" && job.status === "skipped" && (
          <div className="rounded-md border border-amber-500/40 p-3 text-sm">
            <p className="mb-2">
              The report says apply, but this job was discarded by its score.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reopen.isPending}
              onClick={() => reopen.mutate()}
            >
              Move back to ready
            </Button>
          </div>
        )}

        <JobDescriptionMarkdown description={job.evaluationReport} />
      </div>
    </section>
  );
};

const PanelHeader: React.FC = () => (
  <div className="border-b border-border/50 px-4 py-3">
    <div className="flex items-center gap-2 text-base font-semibold">
      <ClipboardCheck className="h-4 w-4" />
      Evaluation
    </div>
  </div>
);
