import type { FollowupItem } from "@shared/types.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import * as api from "../api";
import { showErrorToast } from "../lib/error-toast";
import { queryKeys } from "../lib/queryKeys";

const toEpochSeconds = (date: string): number =>
  Math.floor(new Date(`${date}T09:00:00`).getTime() / 1000);

const FollowupRow: React.FC<{ item: FollowupItem }> = ({ item }) => {
  const queryClient = useQueryClient();

  const send = useMutation({
    mutationFn: async () => {
      const task = await api.createJobTask(item.jobId, {
        type: "follow_up",
        title: `Follow-up — ${item.employer}`,
        dueDate: toEpochSeconds(item.nextDueOn),
      });
      await api.updateJobTask(item.jobId, task.id, { isCompleted: true });
      await api.recordFollowupSent(item.jobId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.jobs.followups(),
      });
    },
    onError: showErrorToast,
  });

  return (
    <li className="flex items-center justify-between rounded-lg border border-border/50 p-3">
      <div>
        <div className="text-sm font-medium">{item.employer}</div>
        <div className="text-xs text-muted-foreground">{item.title}</div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs tabular-nums">{item.nextDueOn}</span>
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-xs"
          disabled={send.isPending}
          onClick={() => send.mutate(undefined)}
        >
          Mark as sent
        </button>
      </div>
    </li>
  );
};

const FollowupSection: React.FC<{ title: string; items: FollowupItem[] }> = ({
  title,
  items,
}) =>
  items.length === 0 ? null : (
    <section>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      <ul className="space-y-2">
        {items.map((item) => (
          <FollowupRow key={item.jobId} item={item} />
        ))}
      </ul>
    </section>
  );

export const FollowupsPage: React.FC = () => {
  const query = useQuery({
    queryKey: queryKeys.jobs.followups(),
    queryFn: api.fetchFollowups,
  });

  if (query.isLoading) {
    return <div className="p-6 text-sm">Loading…</div>;
  }
  if (query.error) {
    return <div className="p-6 text-sm">Could not load follow-ups.</div>;
  }

  const due = query.data?.due ?? [];
  const upcoming = query.data?.upcoming ?? [];

  if (due.length === 0 && upcoming.length === 0) {
    return <div className="p-6 text-sm">No follow-ups yet.</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        <CalendarClock className="h-5 w-5" /> Follow-ups
      </h1>
      <FollowupSection title="Due" items={due} />
      <FollowupSection title="Upcoming" items={upcoming} />
    </div>
  );
};
