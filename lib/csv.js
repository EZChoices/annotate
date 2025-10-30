function escapeCsvValue(value) {
  if (value == null) return "";
  const str =
    typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function arrayToCSV(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const headers = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row || {}).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );
  const lines = [headers.join(",")];
  rows.forEach((row) => {
    const values = headers.map((key) => escapeCsvValue(row?.[key]));
    lines.push(values.join(","));
  });
  return lines.join("\n");
}

export function arrayToJSONL(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  return rows
    .map((row) => JSON.stringify(row ?? {}, (_key, value) => value ?? null))
    .join("\n");
}

function downloadBlob(filename, mimeType, content) {
  if (typeof window === "undefined" || !window?.URL?.createObjectURL) return;
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
}

export function exportAsCSV(filename, rows) {
  const csv = arrayToCSV(rows);
  if (!csv) return;
  downloadBlob(filename, "text/csv;charset=utf-8", csv);
}

export function exportAsJSONL(filename, rows) {
  const jsonl = arrayToJSONL(rows);
  if (!jsonl) return;
  downloadBlob(filename, "application/json", `${jsonl}\n`);
}

