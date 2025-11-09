"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

const DEFAULT_KEYS = [
  {
    key: "est_wait_seconds",
    label: "Estimated wait (seconds)",
    helper: "Used by /api/mobile/peek",
    fallback: 30,
  },
  {
    key: "bundle_size",
    label: "Bundle size",
    helper: "Suggested number of clips per bundle",
    fallback: 3,
  },
  {
    key: "captions_default",
    label: "Captions opt-in",
    helper: "true/false to enable captions by default",
    fallback: true,
  },
];

type ConfigRecord = Record<string, unknown>;

export default function RemoteConfigSettingsPage() {
  const [values, setValues] = useState<ConfigRecord>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const keyList = useMemo(() => {
    const known = DEFAULT_KEYS.map((preset) => preset.key);
    const dynamicKeys = Object.keys(values).filter(
      (key) => !known.includes(key)
    );
    return [
      ...DEFAULT_KEYS.map((preset) => ({
        ...preset,
        value: values[preset.key] ?? preset.fallback,
      })),
      ...dynamicKeys.map((key) => ({
        key,
        label: key,
        helper: "Custom key",
        fallback: null,
        value: values[key],
      })),
    ];
  }, [values]);

  useEffect(() => {
    const params = new URLSearchParams();
    DEFAULT_KEYS.forEach((preset) => params.append("key", preset.key));
    fetch(`/api/admin/remote-config?${params.toString()}`)
      .then((res) => res.json())
      .then((data) => setValues(data.values || {}))
      .catch(() => setMessage("Unable to load remote config cache"))
      .finally(() => setLoading(false));
  }, []);

  const saveKey = async (key: string, inputValue: string) => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setMessage("Value cannot be empty");
      return;
    }
    let parsed: unknown = trimmed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = trimmed;
    }
    setSavingKey(key);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/remote-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: parsed }),
      });
      if (!response.ok) {
        throw new Error("save failed");
      }
      setValues((prev) => ({ ...prev, [key]: parsed }));
      setMessage(`Saved ${key}`);
    } catch {
      setMessage(`Failed to save ${key}`);
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-6">
        <p className="text-sm text-slate-500">Loading remote config…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      <header className="space-y-2">
        <p className="text-sm uppercase tracking-wide text-slate-500">
          Dialect Data · Mobile Ops
        </p>
        <h1 className="text-3xl font-semibold">Remote Config</h1>
        <p className="text-sm text-slate-500">
          Values are stored in-memory for this deployment. Use this page to test
          throttle and UX switches before wiring Supabase.
        </p>
      </header>

      {message ? (
        <motion.p
          layout
          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900"
        >
          {message}
        </motion.p>
      ) : null}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {keyList.map((entry) => (
          <RemoteConfigCard
            key={entry.key}
            entry={entry}
            onSave={saveKey}
            saving={savingKey === entry.key}
          />
        ))}
      </section>

      <AddCustomKeyCard
        onSave={(key, value) => {
          setValues((prev) => ({ ...prev, [key]: value }));
        }}
        refresh={() => {
          const params = new URLSearchParams();
          DEFAULT_KEYS.forEach((preset) => params.append("key", preset.key));
          fetch(`/api/admin/remote-config?${params.toString()}`)
            .then((res) => res.json())
            .then((data) => setValues(data.values || {}));
        }}
      />
    </main>
  );
}

function RemoteConfigCard({
  entry,
  onSave,
  saving,
}: {
  entry: { key: string; label: string; helper?: string; value: unknown };
  onSave: (key: string, value: string) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(() =>
    entry.value === undefined
      ? ""
      : typeof entry.value === "string"
      ? entry.value
      : JSON.stringify(entry.value)
  );
  useEffect(() => {
    setDraft(
      entry.value === undefined
        ? ""
        : typeof entry.value === "string"
        ? entry.value
        : JSON.stringify(entry.value)
    );
  }, [entry.value]);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs uppercase tracking-wide text-slate-500">
        {entry.key}
      </p>
      <h3 className="text-lg font-semibold">{entry.label}</h3>
      {entry.helper ? (
        <p className="text-xs text-slate-500">{entry.helper}</p>
      ) : null}
      <textarea
        className="mt-3 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        className="mt-3 w-full rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
        onClick={() => onSave(entry.key, draft)}
        disabled={saving}
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function AddCustomKeyCard({
  onSave,
  refresh,
}: {
  onSave: (key: string, value: unknown) => void;
  refresh: () => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [valueInput, setValueInput] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!keyInput.trim()) return;
    setSaving(true);
    let parsed: unknown = valueInput.trim();
    try {
      parsed = JSON.parse(valueInput);
    } catch {
      parsed = valueInput.trim();
    }
    try {
      const response = await fetch("/api/admin/remote-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyInput.trim(), value: parsed }),
      });
      if (!response.ok) throw new Error("save failed");
      onSave(keyInput.trim(), parsed);
      refresh();
      setKeyInput("");
      setValueInput("");
    } catch {
      // swallow for now
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-dashed border-slate-300 p-4 shadow-inner dark:border-slate-700">
      <h3 className="text-lg font-semibold">Add custom key</h3>
      <p className="text-xs text-slate-500">
        Useful for testing new flags before wiring the backend.
      </p>
      <input
        className="mt-3 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        placeholder="key_name"
        value={keyInput}
        onChange={(event) => setKeyInput(event.target.value)}
      />
      <textarea
        className="mt-2 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        placeholder='Value (plain text or JSON, e.g. {"enabled":true})'
        rows={3}
        value={valueInput}
        onChange={(event) => setValueInput(event.target.value)}
      />
      <button
        className="mt-3 w-full rounded-lg border border-blue-200 bg-white py-2 text-sm font-semibold text-blue-600 transition hover:bg-blue-50 dark:bg-blue-500/10 dark:text-blue-200"
        onClick={submit}
        disabled={saving}
      >
        {saving ? "Adding…" : "Add key"}
      </button>
    </div>
  );
}
