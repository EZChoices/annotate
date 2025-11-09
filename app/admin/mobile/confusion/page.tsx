import { ConfusionAnalytics } from "../../../../components/admin/confusion/ConfusionAnalytics";
import {
  getMockConfusionDatasets,
  getMockPilotMetrics,
} from "../../../../lib/mobile/mockAnalytics";
import { mockPeek } from "../../../../lib/mobile/mockRepo";

export default function ConfusionPage() {
  const peek = mockPeek();
  const datasets = getMockConfusionDatasets();
  const pilotMetrics = getMockPilotMetrics(peek.count);

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="space-y-1">
        <p className="text-sm text-slate-500">Dialect Data — Mobile Ops</p>
        <h1 className="text-3xl font-semibold">Confusion Analytics</h1>
        <p className="text-sm text-slate-500">
          Previewing mock data until Supabase is connected. Backlog:{" "}
          {peek.count.toLocaleString()} clips.
        </p>
      </header>

      <ConfusionAnalytics
        pilotMetrics={pilotMetrics}
        datasets={datasets}
        backlogCount={peek.count}
      />
    </main>
  );
}
