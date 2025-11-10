# Mobile API Contracts

All routes live under `/api/mobile/*`. Requests require a Supabase JWT bearer token except where noted (mock mode allows anonymous fallback).

Common headers:
- `Authorization: Bearer <supabase access token>`
- `Idempotency-Key: <uuid>` (for POST `/tasks/submit`)

Common errors (JSON): `{ "error": "CODE", "message": "details" }`
```
BUNDLE_ACTIVE | LEASE_CONFLICT | LEASE_EXPIRED | CAPABILITY_MISMATCH |
FEATURE_DISABLED | IDEMPOTENCY_REPLAY | RATE_LIMIT | VALIDATION_FAILED
```

---

## GET `/api/mobile/peek?cap=<task_type>`
Preview backlog without claiming.

Response:
```json
{
  "count": 0,
  "backlog_by_type": {
    "translation_check": 0,
    "accent_tag": 0,
    "emotion_tag": 0
  },
  "est_wait_seconds": 0
}
```
Headers: `x-mobile-mock-data: true` (in mock mode), `x-est-wait`, `x-user`.

---

## GET `/api/mobile/bundle?count=3`
Claims or returns an active bundle (max 1 active per contributor).

Response: `{ "bundle_id": "uuid", "tasks": [ ...MobileClaimResponse ] }`
Headers: `x-mobile-mock-data: true` when mock fallback used.

Errors: `BUNDLE_ACTIVE`, `RATE_LIMIT`.

---

## POST `/api/mobile/tasks/next`
Claims a single task outside the bundle flow (rate-limited).

Body: none.

Response: `MobileClaimResponse`.

Errors: `NO_TASKS`, `RATE_LIMIT`.

---

## POST `/api/mobile/tasks/release`
Releases a lease immediately.

Body:
```json
{
  "assignment_id": "uuid",
  "reason": "not_confident|low_audio|wrong_lang|other"
}
```

Response: `{ "ok": true }`

Errors: `VALIDATION_FAILED`.

---

## POST `/api/mobile/tasks/heartbeat`
Extends lease during playback (>= 60s since last event).

Body:
```json
{ "assignment_id": "uuid", "playback_ratio": 0.8, "watched_ms": 9000 }
```

Response: `{ "ok": true, "lease_expires_at": "ISO" }`

Errors: `VALIDATION_FAILED`, `LEASE_EXPIRED`.

---

## POST `/api/mobile/tasks/submit`
Persists payload + duration; idempotent via `Idempotency-Key`.

Body:
```ts
type SubmitBody = {
  task_id: string;
  assignment_id: string;
  payload: Record<string, any>;
  duration_ms: number;
  playback_ratio: number;
  client_ts?: string;
  watched_ms?: number;
  seeking_events?: number;
};
```

Response:
```json
{
  "ok": true,
  "green_count": 4,
  "status": "submitted",
  "agreement_score": 0.91
}
```

Errors: `RATE_LIMIT`, `IDEMPOTENCY_REPLAY`, `PLAYBACK_TOO_SHORT`, `LEASE_CONFLICT`.

---

## GET `/api/mobile/context?clip_id=<id>`
Returns ±24 s context window.

Response:
```json
{
  "clip_id": "...",
  "prev": { "start_ms": 0, "end_ms": 12000, "audio_url": "..." },
  "next": { "start_ms": 12000, "end_ms": 24000, "audio_url": "..." },
  "transcript_snippet": "...",
  "translation_snippet": "...",
  "diarization": ["A", "B"]
}
```

Errors: `VALIDATION_FAILED`.

---

## Remote Config Schema

```json
{
  "bundle_count": 3,
  "golden_ratio": 0.02,
  "captions_default_on": true,
  "context_window_ms": 24000
}
```

Access via `/admin/mobile/settings` (in-memory now; Supabase adapter pending).
