import { useEffect, useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";

const containerStyle = {
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

export default function DataTable({
  title,
  data,
  columns,
  emptyMessage,
  defaultSorting,
  getRowId,
  onSelectionChange,
}) {
  const [sorting, setSorting] = useState(defaultSorting || []);
  const [rowSelection, setRowSelection] = useState({});

  const selectionColumn = useMemo(
    () => ({
      id: "__select",
      header: ({ table }) => (
        <IndeterminateCheckbox
          checked={table.getIsAllRowsSelected()}
          indeterminate={table.getIsSomeRowsSelected()}
          onChange={table.getToggleAllRowsSelectedHandler()}
        />
      ),
      cell: ({ row }) => (
        <IndeterminateCheckbox
          checked={row.getIsSelected()}
          indeterminate={row.getIsSomeSelected()}
          disabled={!row.getCanSelect()}
          onChange={row.getToggleSelectedHandler()}
        />
      ),
      size: 32,
    }),
    []
  );

  const table = useReactTable({
    data: Array.isArray(data) ? data : [],
    columns: [selectionColumn, ...(columns || [])],
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId:
      getRowId ||
      ((row, index) => row.id || row.clipId || row.clip_id || String(index)),
    enableRowSelection: true,
  });

  useEffect(() => {
    if (!onSelectionChange) return;
    const selectedRows = table
      .getSelectedRowModel()
      .rows.map((row) => row.original);
    onSelectionChange(selectedRows);
  }, [rowSelection, table, onSelectionChange]);

  const rows = table.getRowModel().rows;
  const hasData = rows.length > 0;

  return (
    <div style={containerStyle}>
      <div style={{ fontWeight: 600, color: "#0f172a", marginBottom: "12px" }}>
        {title}
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
                      width: header.column.getSize(),
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
                <tr key={row.id}>
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
                  colSpan={(columns?.length || 0) + 1}
                  style={{ ...cellStyle, textAlign: "center", color: "#94a3b8" }}
                >
                  {emptyMessage || "No records found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IndeterminateCheckbox({ indeterminate, ...props }) {
  const refCallback = (input) => {
    if (input) input.indeterminate = Boolean(indeterminate);
  };
  return (
    <input
      type="checkbox"
      ref={refCallback}
      style={{ width: "16px", height: "16px" }}
      {...props}
    />
  );
}

