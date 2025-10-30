import { useEffect, useMemo, useState } from "react";
import type { InputHTMLAttributes } from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  RowSelectionState,
  SortingState,
  Table,
  useReactTable,
} from "@tanstack/react-table";

interface DataTableProps<TData> {
  title: string;
  data: TData[];
  columns: ColumnDef<TData, any>[];
  emptyMessage?: string;
  defaultSorting?: SortingState;
  getRowId?: (row: TData, index: number, parent?: { id: string }) => string;
  onSelectionChange?: (rows: TData[]) => void;
}

const containerStyle: React.CSSProperties = {
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

export default function DataTable<TData>({
  title,
  data,
  columns,
  emptyMessage,
  defaultSorting = [],
  getRowId,
  onSelectionChange,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>(defaultSorting);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const selectionColumn: ColumnDef<TData, unknown> = useMemo(
    () => ({
      id: "__select",
      header: ({ table }: { table: Table<TData> }) => (
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
      enableSorting: false,
      size: 32,
    }),
    []
  );

  const table = useReactTable({
    data: Array.isArray(data) ? data : [],
    columns: [selectionColumn, ...columns],
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel<TData>(),
    getSortedRowModel: getSortedRowModel<TData>(),
    getRowId:
      getRowId ||
      ((row, index) =>
        (row as any)?.id ||
        (row as any)?.clipId ||
        (row as any)?.clip_id ||
        String(index)),
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
      <div style={{ fontWeight: 700, color: "#0f172a", marginBottom: "12px" }}>
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
                      cursor: header.column.getCanSort()
                        ? "pointer"
                        : "default",
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
                  colSpan={columns.length + 1}
                  style={{
                    ...cellStyle,
                    textAlign: "center",
                    color: "#94a3b8",
                  }}
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

function IndeterminateCheckbox({
  indeterminate,
  ...props
}: { indeterminate?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  const refCallback = (input: HTMLInputElement | null) => {
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

