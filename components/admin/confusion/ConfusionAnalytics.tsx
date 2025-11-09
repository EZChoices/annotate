"use client";

import { useMemo, useState } from "react";
import { ConfusionMatrix } from "./ConfusionMatrix";
import { PilotKpiCards } from "../kpi/PilotKpiCards";
import type { ConfusionDataset } from "../../../lib/mobile/mockAnalytics";
import { exportAsCSV } from "../../../lib/csv";

interface ConfusionAnalyticsProps {
  pilotMetrics: { label: string; value: string; helper?: string }[];
  datasets: ConfusionDataset[];
  backlogCount: number;
}

function buildCsvRows(labels: string[], matrix: number[][]) {
  return matrix.map((row, rowIdx) => {
    const record: Record<string, string | number> = {
      consensus: labels[rowIdx],
    };
    labels.forEach((label, colIdx) => {
      record[label] = row[colIdx];
    });
    return record;
  });
}

export function ConfusionAnalytics({
  pilotMetrics,
  datasets,
  backlogCount,
}: ConfusionAnalyticsProps) {
  const [activeSlug, setActiveSlug] = useState(datasets[0]?.slug ?? "");
  const activeDataset = useMemo(
    () => datasets.find((entry) => entry.slug === activeSlug) ?? datasets[0],
    [datasets, activeSlug]
  );

  const exportCsv = () => {
    if (!activeDataset) return;
    const rows = buildCsvRows(activeDataset.labels, activeDataset.matrix);
    exportAsCSV(`${activeDataset.slug}-confusion.csv`, rows);
  };

  if (!activeDataset) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
        No datasets available yet.
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <PilotKpiCards metrics={pilotMetrics} />

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Datasets
            </p>
            <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
              Confusion heatmaps
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Backlog preview: {backlogCount.toLocaleString()} clips (mock)
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {datasets.map((entry) => {
              const active = entry.slug === activeDataset.slug;
              return (
                <button
                  key={entry.slug}
                  type="button"
                  onClick={() => setActiveSlug(entry.slug)}
                  className={`rounded-full px-3 py-1 text-sm font-semibold transition ${
                    active
                      ? "bg-blue-600 text-white"
                      : "bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                  }`}
                >
                  {entry.title}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <ConfusionMatrix
        title={activeDataset.title}
        labels={activeDataset.labels}
        matrix={activeDataset.matrix}
        total={activeDataset.total}
        helper={activeDataset.helper}
        actions={
          <button
            type="button"
            onClick={exportCsv}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Export CSV
          </button>
        }
      />
    </section>
  );
}
