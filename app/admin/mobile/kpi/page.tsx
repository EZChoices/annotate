import { PilotKpiCards } from "../../../../components/admin/kpi/PilotKpiCards";
import {
  getMockConfusionDatasets,
  getMockPilotMetrics,
} from "../../../../lib/mobile/mockAnalytics";
import { mockPeek } from "../../../../lib/mobile/mockRepo";
import { downloadKpiCsvAction } from "./actions";

export const dynamic = "force-dynamic";

function MockTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<Record<string, string | number>>;
}) {
  if (!rows.length) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {title}: no data yet.
      </section>
    );
  }
  const headers = Object.keys(rows[0]);
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
        {title}
      </h2>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr>
              {headers.map((header) => (
                <th
                  key={header}
                  className="border-b border-slate-200 px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr
                key={`${title}-${idx}`}
                className="odd:bg-slate-50/70 dark:odd:bg-slate-800/40"
              >
                {headers.map((header) => (
                  <td
                    key={header}
                    className="px-3 py-2 text-slate-700 dark:text-slate-200"
                  >
                    {row[header]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function MobileKpiPage() {
  const peek = mockPeek();
  const datasets = getMockConfusionDatasets();
  const pilotMetrics = getMockPilotMetrics(peek.count);
  const funnel = datasets.map((dataset) => ({
    stage: dataset.title,
    count: dataset.matrix
      .map((row) => row.reduce((sum, value) => sum + value, 0))
      .reduce((sum, value) => sum + value, 0),
  }));
  const backlogRows = Object.entries(peek.backlog_by_type).map(
    ([type, count]) => ({
      task_type: type,
      backlog: count,
      hours: (count * 12) / 3600,
    })
  );
  const leaseRows = [
    { metric: "Active bundles", value: 12 },
    { metric: "Lease expiries (24h)", value: 5 },
    { metric: "Avg lease extension", value: "11m" },
  ];

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="space-y-1">
        <p className="text-sm text-slate-500">Dialect Data - Mobile Ops</p>
        <h1 className="text-3xl font-semibold">Mobile KPI Dashboard</h1>
        <p className="text-sm text-slate-500">
          Mock analytics snapshot. Backlog: {peek.count.toLocaleString()} clips.
        </p>
        <form action={downloadKpiCsvAction}>
          <button
            type="submit"
            className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            Download CSV
          </button>
        </form>
      </header>

      <PilotKpiCards metrics={pilotMetrics} />

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
          Funnel preview
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {funnel.map((entry) => (
            <div
              key={entry.stage}
              className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-center dark:border-slate-700 dark:bg-slate-800/40"
            >
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {entry.stage}
              </p>
              <p className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
                {entry.count}
              </p>
            </div>
          ))}
        </div>
      </section>

      <MockTable title="Backlog by task type" rows={backlogRows} />
      <MockTable title="Lease health" rows={leaseRows} />
    </main>
  );
}
