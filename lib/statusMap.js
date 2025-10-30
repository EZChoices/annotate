const CANONICAL = {
  STAGE0_RIGHTS: "STAGE0_RIGHTS",
  STAGE1_TRIAGE: "STAGE1_TRIAGE",
  STAGE2_ANNOTATE: "STAGE2_ANNOTATE",
  QA_PENDING: "QA_PENDING",
  QA_FAIL: "QA_FAIL",
  QA_PASS: "QA_PASS",
  DONE: "DONE",
  FLAGGED: "FLAGGED",
  DUPLICATE: "DUPLICATE",
};

const CANONICAL_FUNNEL = {
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

const NORMALIZED_STATUS_MAP = new Map(
  [
    ["rights_pending", CANONICAL.STAGE0_RIGHTS],
    ["rights_required", CANONICAL.STAGE0_RIGHTS],
    ["rights_hold", CANONICAL.STAGE0_RIGHTS],
    ["triage", CANONICAL.STAGE1_TRIAGE],
    ["triaged", CANONICAL.STAGE1_TRIAGE],
    ["ready", CANONICAL.STAGE1_TRIAGE],
    ["new", CANONICAL.STAGE1_TRIAGE],
    ["annotating", CANONICAL.STAGE2_ANNOTATE],
    ["in_annotation", CANONICAL.STAGE2_ANNOTATE],
    ["qa_pending", CANONICAL.QA_PENDING],
    ["qa_review", CANONICAL.QA_PENDING],
    ["qa_fail", CANONICAL.QA_FAIL],
    ["qa_failed", CANONICAL.QA_FAIL],
    ["qa_pass", CANONICAL.QA_PASS],
    ["qa_passed", CANONICAL.QA_PASS],
    ["done", CANONICAL.DONE],
    ["complete", CANONICAL.DONE],
    ["completed", CANONICAL.DONE],
    ["flagged", CANONICAL.FLAGGED],
    ["flag", CANONICAL.FLAGGED],
    ["duplicate", CANONICAL.DUPLICATE],
    ["dup", CANONICAL.DUPLICATE],
  ].map(([key, value]) => [key.toLowerCase(), value])
);

const STAGE_FIELD_MAP = new Map(
  [
    ["0", CANONICAL.STAGE0_RIGHTS],
    ["1", CANONICAL.STAGE1_TRIAGE],
    ["2", CANONICAL.STAGE2_ANNOTATE],
    ["3", CANONICAL.QA_PENDING],
    ["qa", CANONICAL.QA_PENDING],
    ["qa_pending", CANONICAL.QA_PENDING],
    ["qa_fail", CANONICAL.QA_FAIL],
    ["qa_pass", CANONICAL.QA_PASS],
    ["4", CANONICAL.DONE],
    ["done", CANONICAL.DONE],
  ].map(([key, value]) => [String(key).toLowerCase(), value])
);

function normalize(value) {
  if (value == null) return null;
  return String(value).trim().toLowerCase();
}

export const CANONICAL_STATUS = CANONICAL;

export function toCanonical(source, options = {}) {
  if (!source && !options) return CANONICAL.STAGE1_TRIAGE;

  if (source && typeof source === "object") {
    const row = source;
    const statusFields = [
      row.status,
      row.stage_status,
      row.stage,
      row.clip_status,
      row.current_status,
      row.state,
    ]
      .map(normalize)
      .filter(Boolean);

    for (const status of statusFields) {
      const mapped = NORMALIZED_STATUS_MAP.get(status);
      if (mapped) return mapped;
      const stageMapped = STAGE_FIELD_MAP.get(status);
      if (stageMapped) return stageMapped;
    }

    const rights = normalize(
      row.rights_consent_status || row.rightsConsentStatus
    );
    if (rights && rights.startsWith("pending")) {
      return CANONICAL.STAGE0_RIGHTS;
    }

    if (row.is_duplicate || row.duplicate_group_id) {
      return CANONICAL.DUPLICATE;
    }

    if (Array.isArray(row.flags) && row.flags.length) {
      return CANONICAL.FLAGGED;
    }

    return CANONICAL.STAGE1_TRIAGE;
  }

  const status = normalize(source);
  if (status) {
    const mapped = NORMALIZED_STATUS_MAP.get(status);
    if (mapped) return mapped;
    const stageMapped = STAGE_FIELD_MAP.get(status);
    if (stageMapped) return stageMapped;
  }
  return CANONICAL.STAGE1_TRIAGE;
}

export function toFunnelStage(canonicalStatus) {
  if (!canonicalStatus) return "TRIAGE";
  const stage = CANONICAL_FUNNEL[canonicalStatus];
  return stage || "TRIAGE";
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isStuck(clipRow, now = new Date()) {
  const canonical = toCanonical(clipRow);
  if (
    canonical === CANONICAL.DONE ||
    canonical === CANONICAL.DUPLICATE ||
    canonical === CANONICAL.FLAGGED
  ) {
    return false;
  }

  const lastAction =
    clipRow?.last_action_at ||
    clipRow?.lastActionAt ||
    clipRow?.updated_at ||
    clipRow?.updatedAt ||
    clipRow?.created_at ||
    clipRow?.createdAt;

  if (!lastAction) return false;

  const ts = new Date(lastAction);
  if (Number.isNaN(ts.getTime())) return false;

  return now.getTime() - ts.getTime() > DAY_MS;
}

export function isBacklog(canonicalStatus) {
  return (
    canonicalStatus === CANONICAL.STAGE0_RIGHTS ||
    canonicalStatus === CANONICAL.STAGE1_TRIAGE
  );
}

export function isDone(canonicalStatus) {
  return canonicalStatus === CANONICAL.DONE;
}

export function isInAnnotation(canonicalStatus) {
  return canonicalStatus === CANONICAL.STAGE2_ANNOTATE;
}

