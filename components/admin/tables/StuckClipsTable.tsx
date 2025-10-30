import type { ColumnDef } from "@tanstack/react-table";
import DataTable from "./DataTable";
import type { AdminStats } from "../../../lib/adminQueries";

type StuckRow = AdminStats["tables"]["stuck"][number];

interface StuckClipsTableProps {
  data: StuckRow[];
  loading?: boolean;
  onSelectionChange?: (rows: StuckRow[]) => void;
  onExportCsv: () => void;
  onExportJson: () => void;
}

export default function StuckClipsTable({
  data,
  loading = false,
  onSelectionChange,
  onExportCsv,
  onExportJson,
}: StuckClipsTableProps) {
  const columns: ColumnDef<StuckRow>[] = [
    { accessorKey: "clipId", header: "Clip ID" },
    { accessorKey: "stage", header: "Stage" },
    {
      accessorKey: "priority",
      header: "Priority",
      cell: (info) => info.getValue<number | null>() ?? "—",
    },
    {
      accessorKey: "assignedTo",
      header: "Annotator",
      cell: (info) => info.getValue<string>() || "unassigned",
    },
    {
      accessorKey: "lastActionAt",
      header: "Last Update",
      cell: (info) => formatDate(info.getValue<string | null>()),
    },
    {
      accessorKey: "ageDays",
      header: "Age (days)",
      cell: (info) => {
        const value = info.getValue<number | null>();
        return value != null ? value.toString() : "—";
      },
    },
  ];

  return (
    <DataTable
      title="Stuck Clips (>24h)"
      data={data}
      columns={columns}
      emptyMessage="No clips are currently stuck."
      defaultSorting={[{ id: "priority", desc: false }]}
      onSelectionChange={onSelectionChange}
      loading={loading}
      actions={
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="button" onClick={onExportCsv} style={secondaryButtonStyle}>
            Export CSV
          </button>
          <button type="button" onClick={onExportJson} style={secondaryButtonStyle}>
            Export JSONL
          </button>
        </div>
      }
    />
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", { timeZone: "UTC" });
}

const secondaryButtonStyle: React.CSSProperties = {
  background: "#e2e8f0",
  color: "#0f172a",
  border: "none",
  borderRadius: "6px",
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: "0.8rem",
};

