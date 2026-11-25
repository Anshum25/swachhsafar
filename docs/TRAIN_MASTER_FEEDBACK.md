# Train Master–driven passenger feedback

Train Master is the single source of the passenger feedback lifecycle. An administrator registers a train,
switches passenger feedback on and sets how many submissions are needed per journey day. From there:

```
Train Master ──► RailRadar timetable, each direction from its own train page (services/timetable.py)
             ──► journeys planned daily, or created by hand (services/railway.py, services/journeys.py)
             ──► journey legs + journey-day targets (services/feedback_plan.py)
             ──► passenger: coach card + day ─► details ─► OTP ─► PNR (RapidAPI) ─► coach from ticket ─► ratings
             ──► reports: train / direction / date / journey day / coach, PNR-OTP failures, sync status
```

## 1. Train Master configuration

Each train (`trains`, migration 0022) carries its own settings, edited under **Master data → Trains & coaches**:

| Setting | Meaning |
|---|---|
| Collect passenger feedback (`feedback_enabled`) | Off: staff cannot start passenger feedback on the train's journeys (`feedback_disabled`). |
| Feedback per day (`feedback_daily_target`) | Required submissions on each journey day, whole train together. Empty = no target. |
| Per coach per day (`feedback_coach_daily_target`) | Optional, and **separate**: 10 a day across the train is not 10 in every coach. |
| Daily minimum (`feedback_min_daily`) | Optional floor; a past day under it is "short", between it and the target "incomplete". |
| Collect from / until day (`feedback_from_day`, `feedback_to_day`) | Collection window in journey days. Outside it nothing is collected (`day_outside_window`) or targeted. |
| Target on (`feedback_days`) | `all` journey days, or `running` days only (a layover day, with no leg running, gets no target). |
| Targets active (`feedback_targets_active`) | Configuration status. Off: journeys carry no target (feedback may still be taken). |

Example: train 5113, 10 a day, a 4-day journey → Day 1–4 each need 10, **40** in all.

## 2. Timetables in both directions

`POST /trains/{id}/timetable/refresh` (one train), `POST /trains/timetable/refresh` (bulk, background) and
`python -m app.cli sync-timetables` (scheduled) read RailRadar's train-status page for the train **and, separately,
for its return train** (`returnTrain` on the page). The return is never built by reversing the outbound list:
stops, times and run days differ. Missing return trains are added to Train Master automatically (not planned on
their own) and get the outbound rake until their own page gives one.

Each reading is validated before it is stored (`timetable.validate_run`): an origin and a destination, the first
station departing and the last arriving, stations in route order, the clock never running backwards across days,
the arrival day matching the last station's day. A reading that fails is **rejected**; a page that cannot be read
**failed**. Either way the stored timetable is kept. A valid reading with the same hash is **unchanged**.

Every halt is kept (`train_stops`) with arrival/departure and their day of the run, so overnight runs keep their
dates and a station visited twice appears twice. Every attempt is logged (`train_sync_runs`) with what changed.

Scheduling (`deploy/systemd/swachhsafar-sync-timetables.timer`, every 6 hours, ≤ 60 trains a run): trains never
read, read more than 7 days ago, or failed and past their retry delay (1 h after the 1st failure, 6 h after the
2nd, 24 h after that). Each train commits on its own, so a run interrupted by a restart loses nothing.

**Authorisation and limits.** RailRadar's Terms (§9) forbid scraping without permission; this deployment uses
the pages under the operator's written permission from RailRadar (recorded in `app/providers/railradar.py`). The
client fetches `robots.txt` first (checked 2026-11-25: `Allow: /`, only `/api/v1/` and `/app/v1/` disallowed),
identifies itself, waits 3 s between requests, and stops — never retries or works round — on 403/451, CAPTCHA
pages or 429. A bulk run ends at the first such answer. If that permission lapses, set `RAILRADAR_ENABLED=false`:
reads then fail as `config`, stored timetables stay, and journeys are dated from Train Master's own fields.

## 3. Journeys, legs and journey days

A journey is a round trip: out with its train, back with its linked train. `journey_legs` holds each direction
(1 outbound, 2 return) with its own dates and a snapshot of its own train's stops. Each journey day falls on the
outbound leg, the return leg, both (the rake turns round that day) or neither (a layover). Journey days count from
the departure date; legs follow the timetable until the journey starts, then keep the route it actually ran.

Journeys are created as before — the daily planner (`plan-journeys`, one per train per running day, never twice:
`uq_journeys_auto_train_date`) or by hand — and every path now also creates the legs and the day targets. The
planner also back-fills journeys created before this feature.

## 4. Daily targets

`journey_feedback_targets` has one row per journey day: required, per-coach target, minimum, direction and the
train numbers running that day. **Submitted, verified, pending and rejected are never stored**; they are counted
from `passenger_feedback` each time (`GET /journeys/{id}/feedback-plan`):

- submitted = completed; verified = completed with a valid PNR or an OTP-verified mobile;
- in progress = started, not completed; rejected = voided; pending = max(target − submitted, 0) per day.

When Train Master or the timetable changes, days still ahead take the new values; **a day that has begun keeps its
target**, and no feedback record is touched.

## 5. Passenger workflow

The Passenger / Railway official / Records tabs and the three-step form are unchanged in shape.

1. **Journey** — active journeys with train, date range, journey days, both directions and the day-by-day target
   strip (completed / target, status).
2. **Coach and day** — coach cards from the journey's actual coaches; each day shows taken (or taken/target when a
   coach target is set). Days outside the collection window, or a train with feedback off, cannot be opened.
3. **Personal details** — seat, PNR, mobile, name, GPS; the day's and coach's progress is shown. Saved offline if
   needed (queued; the server re-checks everything on arrival).
4. **Verify mobile (OTP)**, then **verify PNR**, then ratings and comments.

### OTP (existing mechanism, reused)

HMAC-stored 6-digit code (`OTP_PEPPER`), `OTP_TTL_SECONDS` expiry, `OTP_RESEND_COOLDOWN_SECONDS`,
`OTP_MAX_SENDS`, `OTP_MAX_ATTEMPTS` (then the feedback is voided), per-user rate limits on the endpoints, one
challenge per feedback (resends rotate the code). The OTP may now be sent before the PNR check. Verification is
decided only by the server. SMS outages are logged for the failure report.

### PNR (existing RapidAPI integration, extended)

Provider: RapidAPI "IRCTC Indian Railway PNR Status" (`PNR_API_URL`, `PNR_API_HOST`, `PNR_API_KEY`; the key stays
on the server). The response is mapped field by field (`external.parse_rapidapi_pnr`): train, journey (boarding)
date, boarding / from / to / reserved-up-to stations, class, chart status, train-cancelled flag and each passenger's
current (else booking) status, coach and berth. A field the provider does not return is left empty, never guessed.

The ticket must fit the journey (`feedback.match_pnr`):

| Check | Rule | Rejected as |
|---|---|---|
| Found | the provider knows the PNR | PNR not found |
| Cancelled | train cancelled / every passenger CAN | The train is cancelled… / The ticket … is cancelled |
| Train | one of the trains running on the feedback day (its leg) | PNR is for a different train |
| Date | boarding date within that leg's run, and not after the feedback date | PNR is for another date of this train / The passenger boards after the feedback date |
| Stations | boarding before alighting, both on that leg's route | PNR stations are not on this train's route |
| Coach | a live passenger's coach is one of the journey's coaches | PNR coach does not match / The ticket is waitlisted, not confirmed |

When the ticket names a coach of this journey other than the card picked, the feedback **moves to the ticket's
coach** (and its AC / Non-AC / General question set): `coach_source = pnr`, `coach_verified = true`. An empty seat
field is filled from the ticket's berth. Checks the provider could not support are recorded as `unknown` in
`pnr_details.checks`. With the division policy `pnr_coach_match_required` off, a coach the ticket does not confirm
is accepted but marked unverified.

Provider handling: a 15 s timeout (`EXTERNAL_TIMEOUT_SECONDS`), one retry after a network error or 5xx, no
retry on 429, and 401/403 (a bad key or lapsed subscription) treated as an outage — the feedback stays pending
instead of being voided as "not found" (previously it was voided). Logs name the failure, never the PNR.

### Duplicate policy

- One counted (verified/completed) feedback per **PNR per journey** — a second passenger on the same PNR is refused
  (`duplicate_pnr`). Another journey, or the return direction of another journey, is not blocked.
- One per **mobile per journey per day** (`duplicate_mobile`).
- A network retry of the same record (same device id and payload) returns the stored record (200); the same id
  with a different payload is refused (409).
- Enforced by partial unique indexes as well as checks, and inside transactions.
- Optional per-coach-per-day cap (division policy `passenger_feedback_per_coach_day`) is re-checked when the PNR
  moves the feedback to another coach.

## 6. Reports

Reports → **Feedback targets** (`GET /reports/feedback-targets?group_by=train|direction|date|day|coach`),
**PNR / OTP** (`GET /reports/feedback-verification`) and **Timetables** (`GET /reports/timetable-sync`). All figures
come from the database; journeys without targets are counted separately, not invented. Extraction failures are
also listed at `GET /trains/timetable/runs?outcome=failed`.

## 7. Offline

| Works offline | Needs the server |
|---|---|
| Viewing the last loaded journey plan, timetable and reports (cached responses, marked stale) | Timetable refresh |
| Starting passenger feedback (queued; idempotent replay) | OTP send/verify |
| Railway official feedback (queued) | PNR verification (RapidAPI) |
|  | Ratings submission, Train Master edits |

Live OTP and PNR checks never run offline; a feedback saved offline is verified only after it reaches the server.

## 8. Deployment

1. Deploy the backend; `alembic upgrade head` runs migration **0022** (adds columns and tables; nothing removed).
2. Install the new timer: `deploy/scripts/install-server.sh` does it, or
   `install -m 644 deploy/systemd/swachhsafar-sync-timetables.{service,timer} /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now swachhsafar-sync-timetables.timer`.
3. First fill: `sudo -u swachhsafar .venv/bin/python -m app.cli sync-timetables --all` (or **Refresh timetables**
   on the Trains screen), then `python -m app.cli plan-journeys` to create legs and targets for existing journeys.
4. Set each train's feedback target in Train Master.
5. Confirm `/etc/swachhsafar/backend.env` has `PNR_PROVIDER=rapidapi` with the RapidAPI URL, host and key, and an
   SMS provider for OTPs. With `PNR_PROVIDER=disabled` PNR verification answers "unavailable" and feedback stays
   pending; nothing is faked.

## 9. API summary

| Method | Path | Purpose |
|---|---|---|
| PATCH | `/trains/{id}` | feedback settings (with the existing train fields) |
| GET | `/trains/{id}/timetable` | both directions' stops, sync state, recent reads |
| POST | `/trains/{id}/timetable/refresh` | read this train and its return train now |
| POST | `/trains/timetable/refresh` | bulk refresh in the background (`only_due` for due trains only) |
| GET | `/trains/timetable/runs` | extraction log (`outcome=failed` for the failure report) |
| GET | `/journeys/{id}/feedback-plan` | legs, day targets and live progress, overall and per coach |
| POST | `/feedback/passenger/{id}/send-otp`, `/verify-otp`, `/verify-pnr` | unchanged paths; PNR now matches train, date, stations, coach |
| GET | `/reports/feedback-targets`, `/reports/feedback-verification`, `/reports/timetable-sync` | reports |
