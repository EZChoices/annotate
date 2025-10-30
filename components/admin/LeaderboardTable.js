import { useMemo, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from "@tanstack/react-table";

const tableContainerStyle = {
  background: "#ffffff",
  borderRadius: "8px",
  border: "1px solid #e2e8f0",
  padding: "16px",
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.08)",
};

const headerCellStyle = {
  textAlign: "left",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  color: "#64748b",
  letterSpacing: "0.05em",
  padding: "8px 12px",
  borderBottom: "1px solid #e2e8f0",
};

const cellStyle = {
  padding: "10px 12px",
  borderBottom: "1px solid #e2e8f0",
  fontSize: "0.9rem",
  color: "#0f172a",
};

export default function LeaderboardTable({ data }) {
  const [sorting, setSorting] = useState([
    { id: "clipsDone", desc: true },
  ]);

  const columns = useMemo(
    () => [
      {
        accessorKey: "annotator",
        header: "Annotator",
        cell: (info) => info.getValue() || "Unknown",
      },
      {
        accessorKey: "clipsDone",
        header: "Clips",
        enableSorting: true,
      },
      {
        accessorKey: "hoursDone",
        header: "Hours",
        enableSorting: true,
        cell: (info) => (info.getValue() ?? 0).toFixed(2),
      },
      {
        accessorKey: "qaPassRate",
        header: "QA Pass Rate",
        enableSorting: true,
        cell: (info) => `${Math.round((info.getValue() || 0) * 100)}%`,
      },
      {
        accessorKey: "avgTurnaroundMin",
        header: "Avg Turnaround (min)",
        enableSorting: true,
        cell: (info) => info.getValue() ?? "—",
      },
    ],
    []
  );

  const table = useReactTable({
    data: Array.isArray(data) ? data : [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;
  const hasData = rows.length > 0;

  return (
    <div style={tableContainerStyle}>
      <div style={{ fontWeight: 600, color: "#0f172a", marginBottom: "12px" }}>
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
                    style={headerCellStyle}
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
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length} style={{ ...cellStyle, textAlign: "center", color: "#94a3b8" }}>
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

