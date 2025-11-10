# Mobile Pilot Runbook

## Scope
Phase-0 pilot with 30–50 annotators using the `/mobile` workflow against mock (or newly flipped) Supabase data. Pilot lasts two weeks; success requires holding the SLO targets across seven consecutive days.

## SLO Targets

| Metric | Target | Notes |
| --- | --- | --- |
| Golden accuracy | ≥92% translation, ≥88% accent, ≥85% emotion | Measured on injected goldens |
| Weighted agreement (median) | ≥0.85 | Across all task types |
| Abandon rate | ≤15% | `(released + expired) / claimed` |
| Bundle completion within TTL | ≥70% | TTL = 45 minutes |
| Median task time | ≤35 seconds | P90 ≤ 75 seconds |
| Effective earnings | ≥$12/hr median | p25 ≥ $9, p75 ≥ $16 |
| Lease expiry rate | ≤5% | Should trend downward after week 1 |

## Pre-Flight Checklist

1. **Database**
   - Apply `docs/mobile_tasks.sql` via the DB migrate workflow.
   - Seed `task_prices`, at least one `media_asset`, and 12s clips with 2s overlap (≥150 rows).
   - Run golden seeding UI or `scripts/validate_goldens.mjs` + `app/api/admin/goldens/seed`.
2. **Environment**
   - Set `MOBILE_TASKS_ENABLED`, `NEXT_PUBLIC_ENABLE_MOBILE_TASKS`, `NEXT_PUBLIC_ENABLE_MOBILE_LOGIN` to `true`.
   - Provide `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   - Configure remote-config defaults (`bundle_count`, `golden_ratio`, `captions_default_on`, `context_window_ms`).
3. **Auth**
   - OTP redirect = `/mobile/welcome`.
   - First login stamps `contributors.feature_flags.mobile_tasks = true`.
4. **Smoke Tests (curl)**
   ```bash
   curl "$BASE/api/mobile/peek"
   curl "$BASE/api/mobile/bundle?count=3"
   curl -X POST "$BASE/api/mobile/tasks/submit" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: $(uuidgen)" \
     -d '{"task_id":"...","assignment_id":"...","payload":{"approved":true},"duration_ms":12000,"playback_ratio":0.9}'
   ```
5. **Monitoring**
   - `/admin/mobile/confusion` (mock until Supabase) + KPI dashboard.
   - Supabase logs for `task_assignments`, `task_responses`, `events_mobile`.

## Daily Operations Checklist

1. **Data freshness**
   - `scripts/precompute_hints.mjs --dry-run`.
   - `scripts/reprice_tasks.mjs --dry-run`.
2. **Backlog health**
   - `/api/mobile/peek` (via Postman) for backlog counts.
   - Confirm `remote-config` bundle size matches ops guidance.
3. **Lease & queue health**
   - Monitor `events_mobile` for `bundle_expired`, `lease_extended`.
   - Check worker logs for background sync failures (offline queue).
4. **Quality**
   - Review confusion heatmaps + golden accuracy from admin KPI page.
   - Spot-audit submissions (Supabase SQL or export job).

## Incident Response

| Symptom | Action |
| --- | --- |
| `/mobile` shows “Unable to create anonymous contributor” | Verify Supabase creds + anon contributor seed; restart app after fixing env. |
| Bundles stuck at 1 active per user forever | Inspect `task_bundles` for stale `state='active'` beyond TTL; run manual update to `expired`. |
| Idempotency errors flood logs | Clear `idempotency_keys` table (when implemented) or bump TTL; ensure Idempotency-Key header is unique per client request. |
| Playback ratio rejections | Confirm task detail page is sending `watched_ms` and `playback_ratio`; check `MOBILE_MIN_PLAYBACK_RATIO`. |
| Remote-config changes ignored | Refresh via `/admin/mobile/settings` “Refresh values” button; verify adapter uses Supabase once wired. |

## Rollback Plan

1. Toggle `MOBILE_TASKS_ENABLED=false` (server + client flags).
2. Invalidate OTP magic links (Supabase dashboard).
3. Pause cron jobs (`precompute_hints`, `reprice_tasks`, `export_payouts`).
4. Communicate to annotators via Slack/email; provide expected ETA.
5. Preserve DB state (no destructive writes) for postmortem.

## Communication Cadence

- **Daily**: Pilot standup (15 min) reviewing KPIs + blockers.
- **Weekly**: Ops + Engineering sync to evaluate SLOs and backlog.
- **Incident**: #mobile-pager channel + on-call rotation from Ops + Eng.

## Post-Pilot Checklist

1. Archive metrics snapshot (CSV exports + screenshots).
2. Review remote-config overrides; reset to defaults if needed.
3. Export payouts via `scripts/export_payouts.mjs`.
4. Document lessons learned in `/docs/runbook/pilot.md` (append “Retro”).
