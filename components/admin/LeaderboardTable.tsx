import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from "@tanstack/react-table";
import type { AnnotatorLeaderboardRow } from "../../lib/adminQueries";

interface LeaderboardTableProps {
  data: AnnotatorLeaderboardRow[];
}

const tableContainerStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: "12px",
  border: "1px solid #e2e8f0",
  padding: "16px",
  boxShadow: "0 8px 20px -18px rgba(15, 23, 42, 0.45)",
};

const headerCellStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  color: "#64748b",
  letterSpacing: "0.05em",
  padding: "8px 12px",
  borderBottom: "1px solid #e2e8f0",
  cursor: "pointer",
};

const cellStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #e2e8f0",
  fontSize: "0.9rem",
  color: "#0f172a",
};

export default function LeaderboardTable({ data }: LeaderboardTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "clipsDone", desc: true },
  ]);

  const columns = useMemo(
    () => [
      {
        accessorKey: "annotator" as const,
        header: "Annotator",
        cell: (info: any) => info.getValue() || "Unknown",
      },
      {
        accessorKey: "clipsDone" as const,
        header: "Clips",
      },
      {
        accessorKey: "hoursDone" as const,
        header: "Hours",
        cell: (info: any) =>
          new Intl.NumberFormat("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(info.getValue() ?? 0),
      },
      {
        accessorKey: "qaPassRate" as const,
        header: "QA Pass Rate",
        cell: (info: any) =>
          `${Math.round((info.getValue() ?? 0) * 100)}%`,
      },
      {
        accessorKey: "avgTurnaroundMin" as const,
        header: "Avg Turnaround (min)",
        cell: (info: any) => info.getValue() ?? "—",
      },
    ],
    []
  );

  const table = useReactTable({
    data: Array.isArray(data) ? data : [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel<AnnotatorLeaderboardRow>(),
    getSortedRowModel: getSortedRowModel<AnnotatorLeaderboardRow>(),
  });

  const rows = table.getRowModel().rows;
  const hasData = rows.length > 0;

  return (
    <div style={tableContainerStyle}>
      <div style={{ fontWeight: 700, color: "#0f172a", marginBottom: "12px" }}>
        Annotator Leaderboard (30d)
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    style={{
                      ...headerCellStyle,
                      cursor: header.column.getCanSort() ? "pointer" : "default",
                    }}
                    onClick={
                      header.column.getCanSort()
                        ? header.column.getToggleSortingHandler()
                        : undefined
                    }
                  >
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
                    {header.column.getIsSorted() === "desc"
                      ? " ↓"
                      : header.column.getIsSorted() === "asc"
                      ? " ↑"
                      : ""}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {hasData ? (
              rows.map((row) => (
                <tr key={row.id} style={{ background: "#ffffff" }}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} style={cellStyle}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{
                    ...cellStyle,
                    textAlign: "center",
                    color: "#94a3b8",
                  }}
                >
                  No annotator activity in the selected window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

