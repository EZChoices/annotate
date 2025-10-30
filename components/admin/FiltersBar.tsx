import { useMemo } from "react";
import { CANONICAL_STATUS } from "../../lib/statusMap";

interface Filters {
  from?: string;
  to?: string;
  stage?: string;
  priority?: string;
  dialect?: string;
  country?: string;
  annotatorId?: string;
}

interface FiltersBarProps {
  filters: Filters;
  onChange: (next: Filters) => void;
  annotatorOptions?: string[];
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onResync: () => void;
  onExportCsv: () => void;
  onToggleAnnotatorView: () => void;
  annotatorViewEnabled: boolean;
}

const stageOptions = [
  { value: "", label: "All statuses" },
  { value: CANONICAL_STATUS.STAGE0_RIGHTS, label: "Stage 0 - Rights" },
  { value: CANONICAL_STATUS.STAGE1_TRIAGE, label: "Stage 1 - Triage" },
  { value: CANONICAL_STATUS.STAGE2_ANNOTATE, label: "Stage 2 - Annotate" },
  { value: CANONICAL_STATUS.QA_PENDING, label: "QA Pending" },
  { value: CANONICAL_STATUS.QA_FAIL, label: "QA Fail" },
  { value: CANONICAL_STATUS.QA_PASS, label: "QA Pass" },
  { value: CANONICAL_STATUS.DONE, label: "Done" },
  { value: CANONICAL_STATUS.FLAGGED, label: "Flagged" },
  { value: CANONICAL_STATUS.DUPLICATE, label: "Duplicate" },
];

const priorityOptions = [
  { value: "", label: "All priorities" },
  { value: "1", label: "P1" },
  { value: "2", label: "P2" },
  { value: "3", label: "P3" },
];

function toInputDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export default function FiltersBar({
  filters,
  onChange,
  annotatorOptions,
  searchQuery,
  onSearchChange,
  onResync,
  onExportCsv,
  onToggleAnnotatorView,
  annotatorViewEnabled,
}: FiltersBarProps) {
  const annotatorSelectOptions = useMemo(() => {
    const base = [{ value: "", label: "All annotators" }];
    if (!Array.isArray(annotatorOptions)) return base;
    const seen = new Set<string>();
    annotatorOptions.forEach((id) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      base.push({ value: id, label: id });
    });
    return base;
  }, [annotatorOptions]);

  const setFilter = (key: keyof Filters, value?: string) => {
    const next = { ...(filters || {}) };
    if (value) {
      if (key === "from" || key === "to") {
        const iso = new Date(value).toISOString();
        next[key] = iso;
      } else {
        next[key] = value;
      }
    } else {
      delete next[key];
    }
    onChange(next);
  };

  const resetFilters = () => onChange({});

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "12px",
        alignItems: "flex-end",
        background: "#ffffff",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "16px",
        boxShadow: "0 8px 20px -18px rgba(15, 23, 42, 0.45)",
      }}
    >
      <FilterField label="Search">
        <input
          type="text"
          placeholder="Search clip ID or annotator…"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          style={{ minWidth: "220px" }}
        />
      </FilterField>
      <FilterField label="From">
        <input
          type="date"
          value={toInputDate(filters?.from)}
          onChange={(event) => setFilter("from", event.target.value || undefined)}
        />
      </FilterField>
      <FilterField label="To">
        <input
          type="date"
          value={toInputDate(filters?.to)}
          onChange={(event) => setFilter("to", event.target.value || undefined)}
        />
      </FilterField>
      <FilterField label="Stage">
        <select
          value={filters?.stage || ""}
          onChange={(event) => setFilter("stage", event.target.value || undefined)}
        >
          {stageOptions.map((opt) => (
            <option key={opt.value || "all"} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </FilterField>
      <FilterField label="Priority">
        <select
          value={filters?.priority || ""}
          onChange={(event) => setFilter("priority", event.target.value || undefined)}
        >
          {priorityOptions.map((opt) => (
            <option key={opt.value || "all"} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </FilterField>
      <FilterField label="Dialect">
        <input
          type="text"
          placeholder="e.g. ar-gulf"
          value={filters?.dialect || ""}
          onChange={(event) => setFilter("dialect", event.target.value.trim())}
        />
      </FilterField>
      <FilterField label="Country">
        <input
          type="text"
          placeholder="e.g. MA"
          value={filters?.country || ""}
          onChange={(event) => setFilter("country", event.target.value.trim())}
        />
      </FilterField>
      <FilterField label="Annotator">
        <select
          value={filters?.annotatorId || ""}
          onChange={(event) =>
            setFilter("annotatorId", event.target.value || undefined)
          }
        >
          {annotatorSelectOptions.map((opt) => (
            <option key={opt.value || "all"} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </FilterField>
      <div style={{ marginLeft: "auto" }}>
        <button
          type="button"
          onClick={resetFilters}
          style={{
            background: "#e2e8f0",
            color: "#0f172a",
            border: "none",
            borderRadius: "6px",
            padding: "8px 14px",
            cursor: "pointer",
            fontSize: "0.85rem",
          }}
        >
          Reset
        </button>
      </div>
      <div
        style={{
          display: "flex",
          gap: "8px",
          flexWrap: "wrap",
          marginLeft: "auto",
          paddingTop: "8px",
        }}
      >
        <button
          type="button"
          onClick={onResync}
          style={primaryButtonStyle}
        >
          Re-sync
        </button>
        <button
          type="button"
          onClick={onExportCsv}
          style={secondaryButtonStyle}
        >
          Export All CSV
        </button>
        <button
          type="button"
          onClick={onToggleAnnotatorView}
          style={secondaryButtonStyle}
        >
          {annotatorViewEnabled ? "Hide" : "Show"} Per-Annotator View
        </button>
      </div>
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        fontSize: "0.8rem",
        color: "#475569",
        gap: "4px",
      }}
    >
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  background: "#1d4ed8",
  color: "#ffffff",
  border: "none",
  borderRadius: "6px",
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: "0.85rem",
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "#e2e8f0",
  color: "#0f172a",
  border: "none",
  borderRadius: "6px",
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: "0.85rem",
};
