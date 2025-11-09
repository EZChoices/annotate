interface KpiCard {
  label: string;
  value: string;
  helper?: string;
}

interface PilotKpiCardsProps {
  metrics: KpiCard[];
}

export function PilotKpiCards({ metrics }: PilotKpiCardsProps) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          Pilot health
        </p>
        <h2 className="text-xl font-semibold">Runway KPIs</h2>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="rounded-xl border border-slate-100 bg-slate-50/80 p-4"
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">
              {metric.label}
            </p>
            <p className="text-2xl font-semibold text-slate-900">
              {metric.value}
            </p>
            {metric.helper ? (
              <p className="text-[11px] text-slate-500">{metric.helper}</p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
