import { fetchMobileAdminStats } from "../../../lib/mobile/adminStats";

export const revalidate = 60;

export default async function MobileAdminPage() {
  const stats = await fetchMobileAdminStats();
  const {
    kpis,
    charts: { dailyCompletions },
    tables: { topContributors, recentEvents },
  } = stats;

  const summary = [
    { label: "Contributors", value: kpis.contributorsTotal },
    { label: "Active (24h)", value: kpis.contributorsActive24h },
    { label: "Tasks Pending", value: kpis.tasksPending },
    { label: "In Progress", value: kpis.tasksInProgress },
    { label: "Needs Review", value: kpis.tasksNeedsReview },
    { label: "Auto Approved", value: kpis.tasksAutoApproved },
    { label: "Live Assignments", value: kpis.assignmentsActive },
    { label: "Active Bundles", value: kpis.bundlesActive },
    {
      label: "Avg EWMA",
      value: `${(kpis.avgEwma * 100).toFixed(1)}%`,
    },
    {
      label: "Golden Accuracy",
      value:
        kpis.goldenAccuracy != null
          ? `${(kpis.goldenAccuracy * 100).toFixed(1)}%`
          : "—",
    },
  ];

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-8">
      <header>
        <p className="text-sm text-slate-500">Dialect Data · Ops</p>
        <h1 className="text-3xl font-semibold">Mobile Task Ops Dashboard</h1>
        <p className="text-sm text-slate-500">
          Generated {new Date(stats.generatedAt).toLocaleString()}
        </p>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {summary.map((card) => (
          <div
            key={card.label}
            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">
              {card.label}
            </p>
            <p className="text-2xl font-semibold mt-1">
              {typeof card.value === "number"
                ? card.value.toLocaleString()
                : card.value}
            </p>
          </div>
        ))}
      </section>

      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Throughput
            </p>
            <h2 className="text-xl font-semibold">Daily Completions (30d)</h2>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">Auto Approved</th>
                <th className="py-2 pr-4">Needs Review</th>
              </tr>
            </thead>
            <tbody>
              {dailyCompletions.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-4 text-center text-slate-400">
                    No completions recorded yet.
                  </td>
                </tr>
              ) : (
                dailyCompletions.map((row) => (
                  <tr key={row.date} className="border-b last:border-none">
                    <td className="py-2 pr-4 font-medium">{row.date}</td>
                    <td className="py-2 pr-4">
                      {row.autoApproved.toLocaleString()}
                    </td>
                    <td className="py-2 pr-4">
                      {row.needsReview.toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Contributors
            </p>
            <h2 className="text-xl font-semibold">Top Annotators</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b">
                  <th className="py-2 pr-4">Handle</th>
                  <th className="py-2 pr-4">Tasks</th>
                  <th className="py-2 pr-4">Agreement</th>
                  <th className="py-2 pr-4">Golden</th>
                </tr>
              </thead>
              <tbody>
                {topContributors.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-slate-400">
                      No contributors yet.
                    </td>
                  </tr>
                ) : (
                  topContributors.map((row) => (
                    <tr key={row.contributor_id} className="border-b last:border-none">
                      <td className="py-2 pr-4">
                        <p className="font-semibold">
                          {row.handle || "—"}
                        </p>
                        <p className="text-xs text-slate-500">
                          {row.tier || "tier?"}
                        </p>
                      </td>
                      <td className="py-2 pr-4">{row.tasks_total.toLocaleString()}</td>
                      <td className="py-2 pr-4">
                        {(row.ewma_agreement * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 pr-4">
                        {row.golden_accuracy != null
                          ? `${(row.golden_accuracy * 100).toFixed(1)}%`
                          : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Telemetry
            </p>
            <h2 className="text-xl font-semibold">Recent Events</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b">
                  <th className="py-2 pr-4">Time</th>
                  <th className="py-2 pr-4">Event</th>
                  <th className="py-2 pr-4">Contributor</th>
                </tr>
              </thead>
              <tbody>
                {recentEvents.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-4 text-center text-slate-400">
                      No events logged.
                    </td>
                  </tr>
                ) : (
                  recentEvents.map((event) => (
                    <tr key={event.id} className="border-b last:border-none">
                      <td className="py-2 pr-4">
                        {new Date(event.ts).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 font-semibold">{event.name}</td>
                      <td className="py-2 pr-4">
                        {event.contributor_id ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}

