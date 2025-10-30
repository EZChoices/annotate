import type { ColumnDef } from "@tanstack/react-table";
import DataTable from "./DataTable";
import type { AdminStats } from "../../../lib/adminQueries";

type FlagRow = AdminStats["tables"]["recentFlags"][number];

interface RecentFlagsTableProps {
  data: FlagRow[];
  loading?: boolean;
  onSelectionChange?: (rows: FlagRow[]) => void;
  onExportCsv: () => void;
  onExportJson: () => void;
}

export default function RecentFlagsTable({
  data,
  loading = false,
  onSelectionChange,
  onExportCsv,
  onExportJson,
}: RecentFlagsTableProps) {
  const columns: ColumnDef<FlagRow>[] = [
    { accessorKey: "clipId", header: "Clip ID" },
    {
      accessorKey: "type",
      header: "Flag Type",
      cell: (info) => (info.getValue<string>() || "").toUpperCase(),
    },
    {
      accessorKey: "note",
      header: "Note",
      cell: (info) => info.getValue<string>() || "—",
    },
    {
      accessorKey: "createdAt",
      header: "Created At",
      cell: (info) => formatDate(info.getValue<string | null>()),
    },
  ];

  return (
    <DataTable
      title="Recent Flags"
      data={data}
      columns={columns}
      emptyMessage="No new flags."
      defaultSorting={[{ id: "createdAt", desc: true }]}
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

