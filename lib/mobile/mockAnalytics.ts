import { mockPeek } from "./mockRepo";

export interface ConfusionDataset {
  slug: string;
  title: string;
  helper?: string;
  labels: string[];
  matrix: number[][];
  total: number;
}

function buildMockMatrix(labels: string[]) {
  return labels.map((_, rowIdx) =>
    labels.map((__, colIdx) =>
      rowIdx === colIdx
        ? 12 + rowIdx * 3
        : Math.max(0, 5 - Math.abs(rowIdx - colIdx))
    )
  );
}

export function getMockConfusionDatasets(): ConfusionDataset[] {
  const accentLabels = ["Maghreb", "Levant", "Gulf", "Egypt"];
  const emotionLabels = ["Happy", "Neutral", "Sad", "Angry"];
  const accentMatrix = buildMockMatrix(accentLabels);
  const emotionMatrix = buildMockMatrix(emotionLabels);
  return [
    {
      slug: "accent",
      title: "Accent tagging",
      helper: "Consensus vs annotator prediction",
      labels: accentLabels,
      matrix: accentMatrix,
      total: accentLabels.length * accentLabels.length,
    },
    {
      slug: "emotion",
      title: "Emotion tagging",
      helper: "Consensus vs annotator prediction",
      labels: emotionLabels,
      matrix: emotionMatrix,
      total: emotionLabels.length * emotionLabels.length,
    },
  ];
}

export function getMockPilotMetrics(backlogCount: number) {
  const backlogLabel =
    backlogCount >= 1000
      ? `${(backlogCount / 1000).toFixed(1)}k clips`
      : backlogCount.toString();
  return [
    { label: "Golden accuracy", value: "92%", helper: "Target >= 90%" },
    { label: "Bundle completion", value: "74%", helper: "TTL 45m" },
    { label: "Abandon rate", value: "13%", helper: "Last 7 days" },
    { label: "Weighted agreement", value: "0.87", helper: "P50 across types" },
    { label: "P50 task time", value: "00:34", helper: "P90 01:05" },
    { label: "Earnings (median)", value: "$12.40/hr", helper: "p25 $9.10 / p75 $16.80" },
    { label: "Active backlog", value: backlogLabel, helper: "mock peek estimate" },
  ];
}

export function getMockPeekCount() {
  return mockPeek().count;
}

function escapeCsvValue(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function getMockKpiCsv() {
  const peek = mockPeek();
  const metrics = getMockPilotMetrics(peek.count);
  const backlogRows = Object.entries(peek.backlog_by_type).map(
    ([type, count]) => ({
      type,
      clips: count,
      hours: ((count * 12) / 3600).toFixed(2),
    })
  );
  const sections: string[] = [];
  sections.push(["Metric", "Value", "Helper"].map(escapeCsvValue).join(","));
  metrics.forEach((metric) => {
    sections.push(
      [
        escapeCsvValue(metric.label),
        escapeCsvValue(metric.value),
        escapeCsvValue(metric.helper ?? ""),
      ].join(",")
    );
  });
  sections.push("");
  sections.push(["Backlog Type", "Clips", "Hours"].map(escapeCsvValue).join(","));
  backlogRows.forEach((row) => {
    sections.push(
      [
        escapeCsvValue(row.type),
        escapeCsvValue(row.clips),
        escapeCsvValue(row.hours),
      ].join(",")
    );
  });
  return sections.join("\n");
}
