"use client";

import type { ReactNode } from "react";

interface ConfusionMatrixProps {
  title: string;
  labels: string[];
  matrix: number[][];
  total?: number;
  helper?: string;
  actions?: ReactNode;
}

export function ConfusionMatrix({
  title,
  labels,
  matrix,
  total,
  helper,
  actions,
}: ConfusionMatrixProps) {
  const maxValue = Math.max(...matrix.flat(), Number.EPSILON);
  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Confusion
          </p>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
            {title}
          </h2>
          {total != null ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {total} samples
            </p>
          ) : null}
          {helper ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {helper}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex items-center gap-2 text-sm">{actions}</div>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-xs md:text-sm">
          <thead>
            <tr>
              <th className="p-2 text-left text-slate-500 dark:text-slate-400">
                Consensus →
              </th>
              {labels.map((label) => (
                <th
                  key={label}
                  className="p-2 text-center text-slate-500 dark:text-slate-400"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row, rowIdx) => (
              <tr key={labels[rowIdx]}>
                <th className="p-2 text-left font-medium text-slate-600 dark:text-slate-300">
                  {labels[rowIdx]}
                </th>
                {row.map((value, colIdx) => {
                  const intensity = value / maxValue;
                  const background = `rgba(59,130,246,${0.08 + intensity * 0.55})`;
                  return (
                    <td
                      key={`${rowIdx}-${colIdx}`}
                      className="p-2 text-center font-semibold text-slate-900 dark:text-slate-100"
                      style={{ background }}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
