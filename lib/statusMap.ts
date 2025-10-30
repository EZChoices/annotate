export const CANONICAL_STATUS = {
  STAGE0_RIGHTS: "STAGE0_RIGHTS",
  STAGE1_TRIAGE: "STAGE1_TRIAGE",
  STAGE2_ANNOTATE: "STAGE2_ANNOTATE",
  QA_PENDING: "QA_PENDING",
  QA_FAIL: "QA_FAIL",
  QA_PASS: "QA_PASS",
  DONE: "DONE",
  FLAGGED: "FLAGGED",
  DUPLICATE: "DUPLICATE",
} as const;

export type CanonicalStatus = (typeof CANONICAL_STATUS)[keyof typeof CANONICAL_STATUS];

const CANONICAL_FUNNEL: Record<CanonicalStatus, "RIGHTS" | "TRIAGE" | "ANNOTATE" | "QA" | "DONE" | "FLAG" | "DUP"> =
  {
    STAGE0_RIGHTS: "RIGHTS",
    STAGE1_TRIAGE: "TRIAGE",
    STAGE2_ANNOTATE: "ANNOTATE",
    QA_PENDING: "QA",
    QA_FAIL: "QA",
    QA_PASS: "QA",
    DONE: "DONE",
    FLAGGED: "FLAG",
    DUPLICATE: "DUP",
  };

const NORMALIZED_STATUS_MAP = new Map<string, CanonicalStatus>(
  ([
    ["rights_pending", CANONICAL_STATUS.STAGE0_RIGHTS],
    ["rights_required", CANONICAL_STATUS.STAGE0_RIGHTS],
    ["rights_hold", CANONICAL_STATUS.STAGE0_RIGHTS],
    ["triage", CANONICAL_STATUS.STAGE1_TRIAGE],
    ["triaged", CANONICAL_STATUS.STAGE1_TRIAGE],
    ["ready", CANONICAL_STATUS.STAGE1_TRIAGE],
    ["new", CANONICAL_STATUS.STAGE1_TRIAGE],
    ["annotating", CANONICAL_STATUS.STAGE2_ANNOTATE],
    ["in_annotation", CANONICAL_STATUS.STAGE2_ANNOTATE],
    ["qa_pending", CANONICAL_STATUS.QA_PENDING],
    ["qa_review", CANONICAL_STATUS.QA_PENDING],
    ["qa_fail", CANONICAL_STATUS.QA_FAIL],
    ["qa_failed", CANONICAL_STATUS.QA_FAIL],
    ["qa_pass", CANONICAL_STATUS.QA_PASS],
    ["qa_passed", CANONICAL_STATUS.QA_PASS],
    ["done", CANONICAL_STATUS.DONE],
    ["complete", CANONICAL_STATUS.DONE],
    ["completed", CANONICAL_STATUS.DONE],
    ["flagged", CANONICAL_STATUS.FLAGGED],
    ["flag", CANONICAL_STATUS.FLAGGED],
    ["duplicate", CANONICAL_STATUS.DUPLICATE],
    ["dup", CANONICAL_STATUS.DUPLICATE],
  ] as Array<[string, CanonicalStatus]>).map(
    ([key, value]) => [key.toLowerCase(), value] as [string, CanonicalStatus]
  )
);

const STAGE_FIELD_MAP = new Map<string, CanonicalStatus>(
  ([
    ["0", CANONICAL_STATUS.STAGE0_RIGHTS],
    ["1", CANONICAL_STATUS.STAGE1_TRIAGE],
    ["2", CANONICAL_STATUS.STAGE2_ANNOTATE],
    ["3", CANONICAL_STATUS.QA_PENDING],
    ["qa", CANONICAL_STATUS.QA_PENDING],
    ["qa_pending", CANONICAL_STATUS.QA_PENDING],
    ["qa_fail", CANONICAL_STATUS.QA_FAIL],
    ["qa_pass", CANONICAL_STATUS.QA_PASS],
    ["4", CANONICAL_STATUS.DONE],
    ["done", CANONICAL_STATUS.DONE],
  ] as Array<[string, CanonicalStatus]>).map(
    ([key, value]) =>
      [String(key).toLowerCase(), value] as [string, CanonicalStatus]
  )
);

type ClipRow = Record<string, unknown>;

function normalize(value: unknown): string | null {
  if (value == null) return null;
  return String(value).trim().toLowerCase();
}

export function toCanonical(source: unknown): CanonicalStatus {
  if (!source) return CANONICAL_STATUS.STAGE1_TRIAGE;

  if (typeof source === "object") {
    const row = source as ClipRow;
    const candidateStatuses = [
      row.status,
      row.stage_status,
      row.stage,
      row.clip_status,
      row.current_status,
      row.state,
    ]
      .map(normalize)
      .filter(Boolean) as string[];

    for (const status of candidateStatuses) {
      const mapped = NORMALIZED_STATUS_MAP.get(status);
      if (mapped) return mapped;
      const stageMapped = STAGE_FIELD_MAP.get(status);
      if (stageMapped) return stageMapped;
    }

    const rights = normalize(
      (row.rights_consent_status as string | undefined) ??
        (row.rightsConsentStatus as string | undefined)
    );
    if (rights && rights.startsWith("pending")) {
      return CANONICAL_STATUS.STAGE0_RIGHTS;
    }

    if (row.is_duplicate || row.duplicate_group_id) {
      return CANONICAL_STATUS.DUPLICATE;
    }

    if (Array.isArray(row.flags) && row.flags.length > 0) {
      return CANONICAL_STATUS.FLAGGED;
    }

    return CANONICAL_STATUS.STAGE1_TRIAGE;
  }

  const status = normalize(source);
  if (status) {
    const mapped = NORMALIZED_STATUS_MAP.get(status);
    if (mapped) return mapped;
    const stageMapped = STAGE_FIELD_MAP.get(status);
    if (stageMapped) return stageMapped;
  }
  return CANONICAL_STATUS.STAGE1_TRIAGE;
}

export function toFunnelStage(
  canonicalStatus: CanonicalStatus | null | undefined
): "RIGHTS" | "TRIAGE" | "ANNOTATE" | "QA" | "DONE" | "FLAG" | "DUP" {
  if (!canonicalStatus) return "TRIAGE";
  return CANONICAL_FUNNEL[canonicalStatus] ?? "TRIAGE";
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isStuck(clipRow: ClipRow, now: Date = new Date()): boolean {
  const canonical = toCanonical(clipRow);
  if (
    canonical === CANONICAL_STATUS.DONE ||
    canonical === CANONICAL_STATUS.DUPLICATE ||
    canonical === CANONICAL_STATUS.FLAGGED
  ) {
    return false;
  }

  const lastAction =
    (clipRow?.last_action_at as string | undefined) ??
    (clipRow?.lastActionAt as string | undefined) ??
    (clipRow?.updated_at as string | undefined) ??
    (clipRow?.updatedAt as string | undefined) ??
    (clipRow?.created_at as string | undefined) ??
    (clipRow?.createdAt as string | undefined);

  if (!lastAction) return false;

  const ts = new Date(lastAction);
  if (Number.isNaN(ts.getTime())) return false;

  return now.getTime() - ts.getTime() > DAY_MS;
}

export function isBacklog(canonicalStatus: CanonicalStatus): boolean {
  return (
    canonicalStatus === CANONICAL_STATUS.STAGE0_RIGHTS ||
    canonicalStatus === CANONICAL_STATUS.STAGE1_TRIAGE
  );
}

export function isDone(canonicalStatus: CanonicalStatus): boolean {
  return canonicalStatus === CANONICAL_STATUS.DONE;
}

export function isInAnnotation(canonicalStatus: CanonicalStatus): boolean {
  return canonicalStatus === CANONICAL_STATUS.STAGE2_ANNOTATE;
}
