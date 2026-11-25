import { useEffect, useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import { navigate } from '../../app/router.js';
import MediaPreview from '../../components/MediaPreview.jsx';
import ReviewPanel from '../../components/ReviewPanel.jsx';
import { GpsCapture, VoiceRecorder, outcomeToast, savedLocally } from '../../components/Capture.jsx';
import {
  ActionMenu, Badge, ConfirmDialog, DataState, DetailList, Dialog, Empty, ErrorNote, Field, FilterBar, Loading, OfflineActionsNote, OnlineButton, PageHeader, Pager, Panel, RatingScale, STATE_TONE, ratingText, Segmented, Select, Stepper, SubmitBar, SyncBadge, SyncState, Table, Tabs, fmtDate, fmtDateTime, label,
} from '../../components/ui.jsx';
import {
  ArrowLeftIcon, CheckBoldIcon, ChevronRightIcon, PhoneIcon, ScanIcon, SeatIcon, Spinner, ThumbUpSolidIcon, TicketIcon, TrainSolidIcon, UserIcon,
} from '../../components/Icons.jsx';
import { useNetworkStatus } from '../../hooks/useNetworkStatus.js';
import { useAction } from '../../hooks/useAction.js';
import { canAct } from '../../services/authorization.js';
import { ONLINE_ONLY } from '../../services/operations.js';
import { deviceTimestamp } from '../../utils/capture.js';
import { classLabel } from '../../utils/coaches.js';
import { useSecurityGate } from '../../security/SecurityProvider.jsx';

const journeyDay = (j) => Math.max(1, Math.floor((Date.now() - new Date(`${j.journey_date}T00:00:00`)) / 86_400_000) + 1);
const PASSENGER_STATUS = ['draft', 'verified', 'completed', 'void'].map((s) => ({ value: s, label: label(s) }));

function useActiveJourneys() {
  const { can } = useSession();
  return useResource('/journeys', { state: 'active', mine: !can('journeys.read_all'), page_size: 100 });
}

// Question banks visible for a division: its own and the global defaults (GET /feedback/question-banks).
function useBanks(divisionId) {
  const own = useResource(divisionId ? '/feedback/question-banks' : null, { division_id: divisionId });
  const defaults = useResource(divisionId ? '/feedback/question-banks' : null);
  return [...(own.data ?? []), ...(defaults.data ?? [])];
}

// Submitted ratings with their question text (from the bank the record was answered on).
function RatingsView({ ratings, bank }) {
  if (!ratings?.length) return <p className="text-sm text-slate-500">No ratings recorded.</p>;
  const question = (id) => bank?.questions.find((q) => q.id === id);
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {ratings.map((r) => (
        <li key={r.question_id} className="flex justify-between gap-3 py-1.5">
          <span>{question(r.question_id) ? `${question(r.question_id).position}. ${question(r.question_id).text_en}` : 'Question not on this device'}</span>
          <span className="font-semibold">{ratingText(r.value, bank)}</span>
        </li>
      ))}
    </ul>
  );
}

function JourneyCoachFields({ journeys, form, set, coachRequired = true }) {
  const j = journeys.data?.items.find((x) => x.id === form.journey_id);
  return (
    <>
      <Field label="Journey" error={journeys.error?.message}>
        <Select value={form.journey_id} required placeholder={journeys.loading ? 'Loading…' : 'Select active journey'}
          onChange={(v) => { const nj = journeys.data.items.find((x) => x.id === v); set({ journey_id: v, coach_code: '', journey_day: nj ? journeyDay(nj) : 1 }); }}
          options={(journeys.data?.items ?? []).map((x) => ({ value: x.id, label: `${x.train_no} · ${x.train_name}` }))} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Coach">
          <Select value={form.coach_code} required={coachRequired} placeholder="Select coach" onChange={(v) => set({ coach_code: v })}
            options={(j?.coaches ?? []).map((c) => ({ value: c.code, label: `${c.code} (${classLabel(c.classification)})` }))} />
        </Field>
        <Field label="Journey day"><input type="number" min={1} max={30} className="input" required value={form.journey_day} onChange={(e) => set({ journey_day: Number(e.target.value) })} /></Field>
      </div>
    </>
  );
}

// Reference wizard steps. PNR and OTP ("verification code") verification belong to step 1; ratings are
// step 2; comments, voice and submission step 3 (ratings and comments are submitted together).
const PASSENGER_STEPS = ['Personal Details', 'Passenger Feedback', 'Comments'];

const journeyDays = (j) => Math.max(1, j?.operational_days ?? j?.duration_days ?? 1);

const DIR_SHORT = { 1: 'Out', 2: 'Return', 3: 'Out + return' };
const DAY_TONE = { complete: 'green', in_progress: 'brand', upcoming: 'slate', incomplete: 'amber', short: 'red', no_target: 'slate' };
const journeyLabel = (x) => `${x.train_no} · ${x.train_name} · ${fmtDate(x.journey_date)}${x.end_date && x.end_date !== x.journey_date ? ` – ${fmtDate(x.end_date)}` : ''}`;

// The journey's directions, each with its own train: "Out 12951 MMCT→NDLS · Return 12952 NDLS→MMCT".
export function LegsLine({ legs }) {
  if (!legs?.length) return null;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted" data-testid="journey-legs">
      {legs.map((l) => (
        <span key={l.direction}>{l.direction === 1 ? 'Out' : 'Return'} <b className="text-ink">{l.train_no}</b> {l.origin_code ?? '?'}→{l.destination_code ?? '?'} · Day {l.first_day}{l.last_day !== l.first_day ? `–${l.last_day}` : ''}</span>
      ))}
    </p>
  );
}

// Train Master targets per journey day (GET /journeys/{id}/feedback-plan): completed / target, direction, status.
function DayTargets({ plan }) {
  if (!plan?.days?.length) return null;
  const t = plan.totals;
  return (
    <section className="card mb-3 py-3" aria-label="Feedback targets by journey day">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <p className="font-semibold text-ink">{plan.targets_active ? `Target ${plan.daily_target} a day` : 'No feedback target for this train'}</p>
        {t.required > 0 && <p className="text-muted">Completed <b className="text-ink">{t.submitted}</b> of {t.required} · pending <b className="text-ink">{t.pending}</b> · {t.completion ?? 0}%</p>}
      </div>
      <div className="grid gap-1.5 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${plan.days.length}, minmax(4.5rem, 1fr))` }}>
        {plan.days.map((d) => (
          <div key={d.journey_day} className={`rounded-xl px-2 py-1.5 text-center ring-1 ${d.is_today ? 'ring-feedback/60 bg-feedback/5' : 'ring-line'}`}>
            <p className="text-[11px] font-semibold text-ink">Day {d.journey_day}</p>
            <p className="text-[10px] text-muted">{fmtDate(d.day_date)} · {d.direction == null ? 'Layover' : DIR_SHORT[d.direction]}</p>
            <p className="mt-0.5 text-[13px] font-bold tabular-nums text-ink">{d.required ? `${d.submitted}/${d.required}` : d.submitted}</p>
            {d.required > 0 && <Badge tone={DAY_TONE[d.status]}>{label(d.status)}</Badge>}
          </div>
        ))}
      </div>
    </section>
  );
}

export function usePlan(journeyId) {
  return useResource(journeyId ? `/journeys/${journeyId}/feedback-plan` : null);
}

// Feedback overview (reference): one card per coach of the journey, a pink thumbs-up per journey day with the
// number of passenger feedbacks already taken there. A day opens the passenger form for that coach and day.
// Above the cards, Train Master's target for each day with its progress; a coach target shows as n/target.
function FeedbackOverview({ journeyId }) {
  const journeys = useActiveJourneys();
  const list = journeys.data?.items ?? [];
  const [picked, setPicked] = useState(journeyId ?? '');
  const id = picked || journeyId || list[0]?.id || '';
  const fromList = list.find((x) => x.id === id);
  const one = useResource(id && !fromList ? `/journeys/${id}` : null);
  const journey = fromList ?? one.data;
  const res = useResource(id ? '/feedback/passenger' : null, { journey_id: id, page_size: 200 });
  const summary = useResource(id ? `/journeys/${id}/summary` : null);
  const plan = usePlan(id).data;

  if (journeys.loading && !journeys.data && !journeyId) return <Loading />;
  if (!id) return journeys.error ? <ErrorNote error={journeys.error} onRetry={journeys.reload} /> : <Empty title="No active journeys are assigned to you." />;
  if (!journey) return one.error ? <ErrorNote error={one.error} onRetry={one.reload} /> : <Loading />;

  const days = journeyDays(journey);
  const today = Math.min(days, journeyDay(journey));
  const count = new Map();
  for (const f of res.data?.items ?? []) {
    if (f.status === 'void') continue;
    const k = `${f.coach_code}|${f.journey_day}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const coachTarget = new Map();
  for (const c of plan?.coaches ?? []) for (const d of c.days) if (d.required) coachTarget.set(`${c.code}|${d.journey_day}`, d.required);
  const windowed = (d) => !plan || (d >= plan.feedback_from_day && d <= (plan.feedback_to_day ?? 30));
  const disabled = plan ? !plan.feedback_enabled : journey.feedback_enabled === false;
  const open = (coach, day) => !disabled && windowed(day) && navigate(`/feedback/new/${journey.id}/${encodeURIComponent(coach)}/${day}`);
  const recent = (res.data?.items ?? []).filter((f) => f.status !== 'completed' && f.status !== 'void').slice(0, 6);

  return (
    <>
      {list.length > 1 && (
        <div className="mb-3">
          <Field label="Journey"><Select value={id} onChange={setPicked}
            options={list.map((x) => ({ value: x.id, label: journeyLabel(x) }))} /></Field>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2 font-semibold text-brand-900"><TrainSolidIcon className="h-4.5 w-4.5 shrink-0 text-brand-700" /><span className="truncate">{journey.train_name} · {journey.train_no}</span></p>
          <p className="text-xs text-muted">{fmtDate(journey.journey_date)}{journey.end_date !== journey.journey_date ? ` – ${fmtDate(journey.end_date)}` : ''} · {days} journey day{days === 1 ? '' : 's'}</p>
          <LegsLine legs={plan?.legs ?? journey.legs} />
        </div>
        {summary.data && <p className="text-xs font-medium text-muted">Passenger: <b className="text-ink">{summary.data.passenger_feedback_completed}</b> &nbsp;|&nbsp; Railway: <b className="text-ink">{summary.data.railway_feedback}</b></p>}
      </div>
      {disabled && <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200" role="status">Passenger feedback is turned off for this train in Train Master.</p>}
      <DayTargets plan={plan} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
        {journey.coaches.map((c) => (
          <section key={c.code} className="card flex items-center gap-2 py-3 pl-3 pr-1.5" aria-label={`Coach ${c.code}`}>
            <div className="flex w-14 shrink-0 flex-col items-center gap-0.5 self-stretch justify-center">
              <TrainSolidIcon className="h-7 w-7 text-brand-700" />
              <p className="text-[15px] font-extrabold text-brand-900">{c.code}</p>
            </div>
            <div className="min-w-0 flex-1 overflow-x-auto">
              <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${days}, minmax(3.25rem, 1fr))` }}>
                {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
                  const n = count.get(`${c.code}|${d}`) ?? 0;
                  const target = coachTarget.get(`${c.code}|${d}`);
                  const off = disabled || !windowed(d);
                  return (
                    <button key={d} type="button" onClick={() => open(c.code, d)} disabled={off}
                      aria-label={`Coach ${c.code} day ${d}, ${n} feedback${target ? ` of ${target}` : ''}${off ? ', not collected' : ''}`}
                      className="flex flex-col items-center gap-1 rounded-xl py-1 transition duration-150 hover:bg-feedback/5 active:scale-90 disabled:opacity-35 disabled:active:scale-100">
                      <span className={`text-[12px] font-semibold ${d === today ? 'text-feedback' : 'text-ink'}`}>Day {d}</span>
                      <span className={`relative grid h-[30px] w-[30px] place-items-center rounded-full text-white shadow-[0_3px_8px_rgba(243,67,131,0.35)] ${target && n >= target ? 'bg-gradient-to-br from-emerald-400 to-success' : 'bg-gradient-to-br from-[#ff6b9d] to-feedback'}`}>
                        <ThumbUpSolidIcon className="h-4 w-4" />
                        {(n > 0 || target) && <span className="absolute -right-2 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-white px-1 text-[10px] font-bold text-feedback ring-1 ring-feedback/40">{target ? `${n}/${target}` : n}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <button type="button" className="icon-btn h-9 w-7 shrink-0 text-slate-400" onClick={() => open(c.code, today)} aria-label={`Coach ${c.code}: feedback for today`}>
              <ChevronRightIcon className="h-5 w-5" />
            </button>
          </section>
        ))}
      </div>
      {recent.length > 0 && (
        <Panel title="Waiting for verification" className="mt-4">
          <ul className="divide-y divide-line/70">
            {recent.map((f) => (
              <li key={f.id}>
                <a href={`#/feedback/passenger/${f.id}`} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1"><b className="block truncate text-ink">{f.passenger_name}</b><span className="text-xs text-muted">Coach {f.coach_code} · Day {f.journey_day} · {f.mobile_masked}</span></span>
                  {f.sync_status === 'pending' ? <Badge tone="amber">Not synced</Badge> : <Badge tone={STATE_TONE[f.status]}>{label(f.status)}</Badge>}
                  <ChevronRightIcon className="h-4 w-4 text-slate-400" />
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

// A general (unreserved) coach has no PNR: only its seat number is asked, and it is required. A reserved coach
// asks the PNR; its seat may be left empty (the berth is then taken from the ticket).
const DETAILS_RULES = {
  seat_no: (v, general) => (general && !v.trim() ? 'Enter the passenger’s seat number.' : v.length > 10 ? 'Seat number is at most 10 characters.' : null),
  pnr: (v, general) => (!general && v && !/^\d{10}$/.test(v) ? 'PNR is 10 digits.' : null),
  mobile: (v) => (!/^[6-9]\d{9}$/.test(v) ? 'Enter a 10-digit Indian mobile number (starts with 6–9).' : null),
  passenger_name: (v) => (v.trim().length < 2 ? 'Enter the passenger’s name.' : null),
};
const EMPTY_DETAILS = { passenger_name: '', mobile: '', pnr: '', seat_no: '' };

// Step 1 (reference: Feedback (H1) · Personal Details) for a coach and day picked on the overview. What is
// typed is kept for this coach/day while the user goes back and forth (session storage, this tab only).
function PassengerStart({ journeyId, coach, day }) {
  const { queue } = useSession();
  const notify = useNotify();
  const journey = useResource(`/journeys/${journeyId}`);
  const draftKey = `swachh.feedback.draft:${journeyId}:${coach}:${day}`;
  const [form, setForm] = useState(() => {
    try { return { ...EMPTY_DETAILS, ...JSON.parse(sessionStorage.getItem(draftKey) ?? '{}') }; } catch { return EMPTY_DETAILS; }
  });
  const [errors, setErrors] = useState({});
  const [gps, setGps] = useState(null);
  const [busy, setBusy] = useState(false);
  const [savedOffline, setSavedOffline] = useState(false);
  const gate = useSecurityGate('location');
  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify(form)); } catch { /* storage unavailable */ }
  }, [draftKey, form]);
  const set = (k) => (e) => { const v = e.target.value; setForm((f) => ({ ...f, [k]: v })); setErrors((x) => ({ ...x, [k]: null })); };
  const j = journey.data;
  const known = j?.coaches.find((c) => c.code === coach);
  const plan = usePlan(journeyId).data;
  const dayPlan = plan?.days.find((d) => d.journey_day === day);
  const coachDay = plan?.coaches.find((c) => c.code === coach)?.days.find((d) => d.journey_day === day);
  const general = known?.classification === 'GEN';

  async function submit(e) {
    e.preventDefault();
    const found = Object.fromEntries(Object.entries(DETAILS_RULES).map(([k, rule]) => [k, rule(form[k] ?? '', general)]).filter(([, v]) => v));
    setErrors(found);
    if (Object.keys(found).length || busy) return;
    setBusy(true);
    const id = crypto.randomUUID();
    const outcome = await queue.submit({
      type: 'feedback.passenger.start',
      payload: {
        id, journey_id: journeyId, coach_code: coach, journey_day: day, passenger_name: form.passenger_name.trim(), mobile: form.mobile,
        pnr: general ? null : form.pnr || null, seat_no: form.seat_no.trim() || null, device_timestamp: deviceTimestamp(), ...gps,
      },
    });
    setBusy(false);
    outcomeToast(notify, outcome, 'Passenger details');
    if (!savedLocally(outcome)) return;
    try { sessionStorage.removeItem(draftKey); } catch { /* storage unavailable */ }
    if (outcome.status === 'synced') navigate(`/feedback/passenger/${id}`);
    else { setForm(EMPTY_DETAILS); setSavedOffline(true); }
  }

  return (
    <>
      <PageHeader back={`#/feedback/journey/${journeyId}`} title={`Feedback (${coach})`} />
      <div className="card mx-auto max-w-xl px-4 pb-5 pt-4">
        <Stepper steps={PASSENGER_STEPS} current={0} />
        {journey.error && !j && <ErrorNote error={journey.error} onRetry={journey.reload} />}
        {j && (
          <p className="-mt-1 mb-4 rounded-xl bg-canvas px-3 py-2 text-center text-xs font-medium text-muted">
            {j.train_no} · {j.train_name} · Coach <b className="text-ink">{coach}</b>{known ? ` (${classLabel(known.classification)})` : ''} · Day <b className="text-ink">{day}</b>
          </p>
        )}
        {dayPlan && dayPlan.required > 0 && (
          <p className="-mt-2 mb-4 text-center text-xs text-muted" data-testid="day-target">
            Day {day} ({dayPlan.direction == null ? 'layover' : DIR_SHORT[dayPlan.direction].toLowerCase()}): <b className="text-ink">{dayPlan.submitted}</b> of {dayPlan.required} completed, {dayPlan.pending} to go
            {coachDay?.required ? ` · coach ${coach}: ${coachDay.submitted} of ${coachDay.required}` : ''}
          </p>
        )}
        {j && !known && <ErrorNote error={{ message: `Coach ${coach} is not on this journey.` }} />}
        {savedOffline && (
          <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200" role="status">
            Details saved on this device. Verification starts once they reach the server: continue from the Feedback overview.
          </p>
        )}
        <form onSubmit={submit} noValidate className="space-y-4">
          <Field icon={SeatIcon} label="Seat No." hint={general ? 'General coach: no PNR is asked.' : 'Optional: taken from the ticket when left empty.'} error={errors.seat_no}>
            <input className="input" maxLength={10} required={general} value={form.seat_no} onChange={set('seat_no')} />
          </Field>
          {!general && (
            <Field icon={TicketIcon} label="PNR" hint="10 digits. Train, date, coach and berth are checked against the ticket; the coach is taken from it." error={errors.pnr}><input className="input tracking-wide" inputMode="numeric" maxLength={10} value={form.pnr} onChange={set('pnr')} /></Field>
          )}
          <Field icon={PhoneIcon} label="Mobile" hint="Verification code is sent here" error={errors.mobile}><input className="input tracking-wide" type="tel" inputMode="numeric" autoComplete="off" maxLength={10} required value={form.mobile} onChange={set('mobile')} /></Field>
          <Field icon={UserIcon} label="Name" error={errors.passenger_name}><input className="input" autoComplete="off" required value={form.passenger_name} onChange={set('passenger_name')} /></Field>
          <GpsCapture value={gps} onChange={setGps} />
          {gate.notice}
          <button type="submit" className="btn-primary w-full" disabled={busy || !gps || (j && !known) || !gate.allowed}>
            {busy ? <Spinner /> : <ScanIcon className="h-5 w-5" />} Save &amp; Generate Verification Code
          </button>
          {!gps && <p className="text-center text-xs text-muted">Capture the GPS location to continue.</p>}
        </form>
      </div>
    </>
  );
}

const CHECK_TONE = { ok: 'green', moved: 'brand', unknown: 'slate', mismatch: 'red' };
const CHECK_TEXT = { ok: 'matches', moved: 'taken from ticket', unknown: 'not given by the PNR service', mismatch: 'does not match' };

// What the PNR service returned, as kept on the record (no passenger names are returned or stored).
function PnrDetails({ fb }) {
  const d = fb.pnr_details;
  const route = [d.boarding ?? d.from, d.upto ?? d.to].filter(Boolean).join(' → ');
  return (
    <Panel title="Ticket (PNR)">
      <DetailList items={[
        ['Train', d.train_number ? `${d.train_number}${d.train_name ? ` · ${d.train_name}` : ''}` : null],
        ['Journey date', d.journey_date ? fmtDate(d.journey_date) : null],
        ['Boarding → up to', route || null],
        ['Class', d.class],
        ['Chart', d.chart_status],
        ['Coach', fb.pnr_status === 'valid' ? <>{fb.coach_code} {fb.coach_source === 'pnr' && <Badge tone="brand">Identified from ticket</Badge>}{!fb.coach_verified && <Badge tone="amber">Not confirmed by ticket</Badge>}</> : (d.coach_ids?.join(', ') || null)],
        ['Berth', d.berth],
        ['Passengers', d.passengers?.length ? d.passengers.map((x) => `${x.serial}: ${x.status ?? '?'}${x.coach ? ` ${x.coach}` : ''}${x.berth ? `/${x.berth}` : ''}`).join(' · ') : null],
      ]} />
      {d.checks && Object.keys(d.checks).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">{Object.entries(d.checks).map(([k, v]) => <Badge key={k} tone={CHECK_TONE[v]}>{label(k)}: {CHECK_TEXT[v] ?? v}</Badge>)}</div>
      )}
    </Panel>
  );
}

function VoidDialog({ open, onClose, onVoid, busy }) {
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog open={open} title="Void passenger feedback" confirmLabel="Void feedback" danger busy={busy} disabled={reason.trim().length < 3}
      onClose={onClose} onConfirm={() => onVoid(reason)}>
      <p>A voided record is kept but not counted in reports. This cannot be undone.</p>
      <Field label="Reason" hint="3 to 200 characters"><textarea className="input h-20 py-3" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <OfflineActionsNote reason={ONLINE_ONLY.feedback} />
    </ConfirmDialog>
  );
}

function PassengerFlow({ id }) {
  const { ops, me } = useSession();
  const notify = useNotify();
  const online = useNetworkStatus();
  const res = useResource(`/feedback/passenger/${id}`);
  const fb = res.data;
  const journey = useResource(fb ? `/journeys/${fb.journey_id}` : null);
  const questions = useResource(fb && fb.status === 'verified' ? '/feedback/questions' : null, { journey_id: fb?.journey_id, coach_code: fb?.coach_code });
  const banks = useBanks(fb?.division_id);
  const [otp, setOtp] = useState('');
  const [otpInfo, setOtpInfo] = useState(null);
  const [ratings, setRatings] = useState({});
  const [comments, setComments] = useState('');
  const [voice, setVoice] = useState(null);
  const [voiding, setVoiding] = useState(false);
  const [stage, setStage] = useState('ratings'); // within a verified record: 'ratings' (step 2) or 'comments' (step 3)
  const { busy, error, run } = useAction();

  if (res.loading && !fb) return <Loading />;
  if (!fb) return <ErrorNote error={res.error} onRetry={res.reload} />;
  const bank = banks.find((b) => b.id === fb.bank_id);
  const collector = canAct(me, 'feedback.passenger.collect', fb);
  const onServer = fb.sync_status !== 'pending';
  const step = async (name, fn, ok) => {
    const out = await run(name, fn, ok);
    if (out) res.reload();
    return out;
  };
  const current = fb.status === 'completed' ? PASSENGER_STEPS.length : fb.status === 'verified' ? (stage === 'comments' ? 2 : 1) : 0;
  const missing = (questions.data ?? []).filter((q) => q.required && ratings[q.id] === undefined).length;
  const j = journey.data;

  return (
    <>
      <PageHeader back={`#/feedback/journey/${fb.journey_id}`} title={`Feedback (${fb.coach_code})`}
        barAction={canAct(me, 'feedback.passenger.void', fb) && onServer && fb.status !== 'void' && (
          <ActionMenu items={[{ label: 'Void feedback', danger: true, onClick: () => setVoiding(true), disabled: !online, hint: online ? undefined : ONLINE_ONLY.feedback }]} />
        )} />
      <div className="mx-auto max-w-xl space-y-4">
        <div className="card px-4 pb-4 pt-4">
          {fb.status !== 'void' && <Stepper steps={PASSENGER_STEPS} current={current} />}
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700"><UserIcon className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-bold text-ink">{fb.passenger_name}</p>
              <p className="truncate text-xs text-muted">Seat {fb.seat_no ?? '—'}{fb.coach_class === 'GEN' ? '' : ` · PNR ${fb.pnr ?? '—'}`} · {fb.mobile_masked}</p>
            </div>
          </div>
          <p className="mt-3 rounded-xl bg-canvas px-3 py-2 text-xs font-medium text-muted">
            {fb.train_no ?? j?.train_no ? `${fb.train_no ?? j.train_no} · ` : ''}{j ? `${fmtDate(j.journey_date)} · ` : ''}Coach <b className="text-ink">{fb.coach_code}</b> ({classLabel(fb.coach_class)}) · Day <b className="text-ink">{fb.journey_day}</b>
            {fb.direction ? ` · ${DIR_SHORT[fb.direction]}` : ''}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge tone={STATE_TONE[fb.status]}>{label(fb.status)}</Badge>
            <Badge>PNR: {label(fb.pnr_status)}</Badge>
            <Badge>OTP: {label(fb.otp_status)}</Badge>
            <SyncBadge status={fb.sync_status} error={fb.last_sync_error} />
          </div>
          {fb.void_reason && <p className="mt-2 text-sm text-red-700">Voided: {fb.void_reason}</p>}
        </div>
        <ErrorNote error={error} />
        {!onServer && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
            Saved on this device, waiting to sync. PNR and OTP verification start once the server has this record.
          </p>
        )}
        {onServer && fb.status !== 'completed' && fb.status !== 'void' && collector && <OfflineActionsNote reason={ONLINE_ONLY.pnr} />}
        {!collector && fb.status !== 'completed' && fb.status !== 'void' && (
          <p className="text-sm text-muted">Only the staff member who collected this feedback can verify and complete it.</p>
        )}
        {collector && onServer && fb.status === 'draft' && ['not_sent', 'sent'].includes(fb.otp_status) && (
          <Panel title="1 · Verify mobile number">
            <p className="mb-3 text-sm text-muted">A one-time code is sent by SMS to the passenger’s mobile {fb.mobile_masked}.</p>
            <OnlineButton className={fb.otp_status === 'sent' ? 'btn-secondary h-11 w-full' : 'btn-primary w-full'} disabled={!!busy}
              onClick={async () => { const out = await step('send', () => ops.passengerFeedback.sendOtp(id)); if (out) { setOtpInfo(out); notify('info', `OTP sent to ${out.mobile_masked}.`); } }}>
              {busy === 'send' ? <Spinner /> : <ScanIcon className="h-5 w-5" />} {fb.otp_status === 'sent' ? 'Resend OTP' : 'Send OTP'}
            </OnlineButton>
            {fb.otp_status === 'sent' && (
              <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); step('otp', () => ops.passengerFeedback.verifyOtp(id, otp)); }}>
                <input className="input min-w-0 flex-1 text-center text-lg font-semibold tracking-[0.4em]" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="••••••" aria-label="OTP code" value={otp} onChange={(e) => setOtp(e.target.value)} required />
                <button type="submit" className="btn-primary" disabled={!!busy}>{busy === 'otp' && <Spinner />} Verify</button>
              </form>
            )}
            {otpInfo && <p className="mt-2 text-xs text-muted">{otpInfo.sends_remaining} resends left · expires {fmtDateTime(otpInfo.expires_at)}</p>}
            {fb.pnr_status === 'pending' && <p className="mt-2 text-xs text-muted">The PNR is checked next, once the mobile number is verified.</p>}
          </Panel>
        )}
        {collector && onServer && fb.status === 'draft' && fb.pnr_status === 'pending' && !['not_sent', 'sent'].includes(fb.otp_status) && (
          <Panel title={fb.otp_status === 'verified' ? '2 · Verify PNR' : 'Verify PNR'}>
            {fb.otp_status === 'verified' && <p className="mb-2 flex items-center gap-2 text-sm text-success"><CheckBoldIcon className="h-4 w-4" /> Mobile {fb.mobile_masked} verified</p>}
            <p className="mb-3 text-sm text-muted">PNR {fb.pnr ?? '—'} is checked with the railway PNR service: its train, date, stations and coach must fit this journey. The coach is taken from the ticket when it names one of this journey’s coaches.</p>
            <OnlineButton className="btn-primary w-full" disabled={!!busy} onClick={() => step('pnr', () => ops.passengerFeedback.verifyPnr(id))}>{busy === 'pnr' && <Spinner />} Verify PNR</OnlineButton>
          </Panel>
        )}
        {fb.pnr_details?.found && <PnrDetails fb={fb} />}
        {fb.status === 'draft' && (fb.pnr_status === 'invalid' || fb.otp_status === 'locked') && (
          <ErrorNote error={{ message: fb.pnr_status === 'invalid' ? 'PNR is not valid for this journey. This feedback cannot be counted.' : 'Too many wrong OTP attempts. OTP verification is locked.' }} />
        )}
        {collector && fb.status === 'verified' && (questions.loading || !bank ? <Loading label="Loading questions…" /> : questions.error ? <ErrorNote error={questions.error} /> : (
          <form className="space-y-4" onSubmit={(e) => {
            e.preventDefault();
            if (stage !== 'comments') { setStage('comments'); return; }
            // Completion is a server step: the voice file is uploaded (and acknowledged) first, then claimed.
            step('complete', async () => {
              const voiceId = voice ? (await ops.media.upload({ value: voice, kind: 'feedback_voice', divisionId: fb.division_id, journeyId: fb.journey_id })) : null;
              return ops.passengerFeedback.complete(id, ratings, comments, voiceId);
            }, 'Feedback completed.');
          }}>
            {stage !== 'comments' ? (
              <div className="animate-rise-in space-y-3">
                <h2 className="text-[15px] font-bold text-ink">Passenger Feedback{!bank.option_labels?.length && <span className="font-medium text-muted"> · rate {bank.scale_min}–{bank.scale_max}</span>}</h2>
                {questions.data.map((q) => (
                  <div key={q.id} className="card py-3.5">
                    <p className="mb-1 text-sm font-semibold text-ink">{q.position}. {q.text_en}{q.required && <span className="text-red-600"> *</span>}</p>
                    {q.text_hi && <p className="mb-2 text-xs text-muted">{q.text_hi}</p>}
                    <RatingScale min={bank.scale_min} max={bank.scale_max} options={bank.option_labels} value={ratings[q.id]} label={`Rating for question ${q.position}`}
                      onChange={(v) => setRatings((r) => ({ ...r, [q.id]: v }))} />
                  </div>
                ))}
                <button type="submit" className="btn-primary w-full" disabled={missing > 0}>
                  {missing ? `${missing} required question${missing > 1 ? 's' : ''} left` : 'Next: Comments'} {!missing && <ChevronRightIcon className="h-5 w-5" />}
                </button>
              </div>
            ) : (
              <div className="card animate-rise-in space-y-4">
                <h2 className="text-[15px] font-bold text-ink">Comments</h2>
                <Field label="Comments"><textarea className="input" rows={4} maxLength={2000} placeholder="What did the passenger say?" value={comments} onChange={(e) => setComments(e.target.value)} /></Field>
                <Field label="Voice comment"><VoiceRecorder value={voice} onChange={setVoice} /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" className="btn-secondary h-12" onClick={() => setStage('ratings')}><ArrowLeftIcon /> Back</button>
                  <button type="submit" className="btn-primary px-3" disabled={!!busy || missing > 0}>{busy === 'complete' ? <Spinner /> : <CheckBoldIcon />} Submit feedback</button>
                </div>
              </div>
            )}
          </form>
        ))}
        {fb.status === 'completed' && (
          <Panel title="Feedback completed">
            <p className="mb-3 flex items-center gap-2 text-sm text-muted"><span className="grid h-6 w-6 place-items-center rounded-full bg-success text-white"><CheckBoldIcon className="h-3.5 w-3.5" /></span>Submitted {fmtDateTime(fb.completed_at)} with {fb.ratings.length} rating(s).</p>
            <RatingsView ratings={fb.ratings} bank={bank} />
            {fb.comments && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{fb.comments}</p>}
            {fb.voice_media_id && <div className="mt-3"><MediaPreview id={fb.voice_media_id} kind="audio" label="Voice comment" /></div>}
          </Panel>
        )}
      </div>
      <VoidDialog open={voiding} busy={busy === 'void'} onClose={() => setVoiding(false)}
        onVoid={async (reason) => { if (await step('void', () => ops.passengerFeedback.void(id, reason), 'Feedback voided.')) setVoiding(false); }} />
    </>
  );
}

function RailwayForm() {
  const { queue } = useSession();
  const notify = useNotify();
  const journeys = useActiveJourneys();
  const [form, setForm] = useState({ journey_id: '', coach_code: '', journey_day: 1, railway_employee_id: '', official_name: '', designation: '', comments: '' });
  const [ratings, setRatings] = useState({});
  const [gps, setGps] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const j = journeys.data?.items.find((x) => x.id === form.journey_id);
  const questions = useResource(j ? '/feedback/questions' : null, { journey_id: form.journey_id, audience: 'railway' });
  const bank = useBanks(j?.division_id).find((b) => b.audience === 'railway' && b.is_active);
  const gate = useSecurityGate('location');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const outcome = await queue.submit({
      type: 'feedback.railway.create',
      payload: {
        id: crypto.randomUUID(), ...form, coach_code: form.coach_code || null, designation: form.designation || null, comments: form.comments || null,
        ratings: Object.entries(ratings).map(([question_id, value]) => ({ question_id, value })), device_timestamp: deviceTimestamp(), ...gps,
      },
    });
    setBusy(false);
    outcomeToast(notify, outcome, 'Railway feedback');
    if (savedLocally(outcome)) { setRatings({}); set({ railway_employee_id: '', official_name: '', designation: '', comments: '' }); }
  }

  return (
    <Panel title="Railway official feedback">
      <form onSubmit={submit} className="space-y-3">
        <JourneyCoachFields journeys={journeys} form={form} set={set} coachRequired={false} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Railway employee ID"><input className="input" required minLength={2} value={form.railway_employee_id} onChange={(e) => set({ railway_employee_id: e.target.value })} /></Field>
          <Field label="Official name"><input className="input" required minLength={2} value={form.official_name} onChange={(e) => set({ official_name: e.target.value })} /></Field>
          <Field label="Designation"><input className="input" value={form.designation} onChange={(e) => set({ designation: e.target.value })} /></Field>
        </div>
        {j && (questions.loading ? <Loading label="Loading questions…" /> : questions.error ? <ErrorNote error={questions.error} /> : (
          <div className="space-y-3">
            {(questions.data ?? []).map((q) => (
              <div key={q.id}>
                <p className="mb-1.5 text-sm font-medium">{q.position}. {q.text_en}</p>
                {bank && <RatingScale min={bank.scale_min} max={bank.scale_max} options={bank.option_labels} value={ratings[q.id]} label={`Rating for question ${q.position}`}
                  onChange={(v) => setRatings((r) => ({ ...r, [q.id]: v }))} />}
              </div>
            ))}
          </div>
        ))}
        <Field label="Comments"><textarea className="input h-20 py-3" value={form.comments} onChange={(e) => set({ comments: e.target.value })} /></Field>
        <GpsCapture value={gps} onChange={setGps} />
        {gate.notice}
        <p className="text-xs text-slate-500">Photo or voice attachments are not part of railway feedback on the server yet.</p>
        <SubmitBar busy={busy} disabled={!gps || !Object.keys(ratings).length || !gate.allowed} label="Submit" />
      </form>
    </Panel>
  );
}

// Journeys for the record filters: every journey the user can see, newest first.
function useJourneyOptions() {
  const res = useResource('/journeys', { page_size: 200 });
  return (res.data?.items ?? []).map((j) => ({ value: j.id, label: `${j.train_no} · ${fmtDate(j.journey_date)}` }));
}

function PassengerRecords() {
  const journeys = useJourneyOptions();
  const [journeyId, setJourneyId] = useState('');
  const [status, setStatus] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const res = useResource('/feedback/passenger', { journey_id: journeyId, status, page: pageNo, page_size: 50 });
  const filter = (fn) => (v) => { fn(v); setPageNo(1); };
  return (
    <>
      <FilterBar>
        <Field label="Journey filter"><Select value={journeyId} onChange={filter(setJourneyId)} placeholder="All journeys" options={journeys} /></Field>
        <Field label="Status"><Select value={status} onChange={filter(setStatus)} placeholder="Any status" options={PASSENGER_STATUS} /></Field>
      </FilterBar>
      <DataState res={res} empty="No passenger feedback recorded yet.">
        {(page) => (
          <>
            <Table rows={page.items} onRowClick={(f) => navigate(`/feedback/passenger/${f.id}`)} columns={[
              { key: 'passenger_name', label: 'Passenger' },
              { key: 'coach', label: 'Coach / day', render: (f) => `${f.coach_code} · D${f.journey_day}` },
              { key: 'mobile_masked', label: 'Mobile' },
              { key: 'status', label: 'Status', render: (f) => (f.sync_status === 'pending' ? <Badge tone="amber">Not synced</Badge> : <Badge tone={STATE_TONE[f.status]}>{label(f.status)}</Badge>) },
              { key: 'when', label: 'Captured', render: (f) => fmtDateTime(f.device_timestamp) },
            ]} />
            <Pager data={page} onPage={setPageNo} />
          </>
        )}
      </DataState>
    </>
  );
}

// The verification state of a railway feedback record as this device knows it. Only a status received from
// the server is shown as verified or rejected; nothing is assumed.
export function railwayStatus(f) {
  if (f.sync_status === 'rejected' || f.sync_status === 'conflict') return { key: 'sync_rejected', label: 'Rejected by server (not saved)', tone: 'red' };
  if (f.sync_status !== 'synced') return { key: 'not_synced', label: 'Saved on device, not yet submitted', tone: 'amber' };
  if (f.verification_status === 'verified') return { key: 'verified', label: 'Verified', tone: 'green' };
  if (f.verification_status === 'rejected') return { key: 'rejected', label: 'Rejected in review', tone: 'red' };
  if (f.verification_status === 'submitted') return { key: 'submitted', label: 'Awaiting verification', tone: 'amber' };
  return { key: 'unknown', label: 'Status unknown (not yet received)', tone: 'slate' };
}

const RailwayStatusBadge = ({ record }) => {
  const s = railwayStatus(record);
  return <Badge tone={s.tone}>{s.label}</Badge>;
};

// No GET /feedback/railway/{id} exists on the server: the detail is the list row.
function RailwayDetail({ record, onClose, onChanged }) {
  const { me, ops } = useSession();
  const bank = useBanks(record.division_id).find((b) => b.id === record.bank_id);
  return (
    <Dialog open title={`${record.official_name} · ${record.railway_employee_id}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2"><SyncBadge status={record.sync_status} error={record.last_sync_error} /><RailwayStatusBadge record={record} /></div>
        <DetailList items={[
          ['Verified', record.verified_at ? fmtDateTime(record.verified_at) : null],
          ['Designation', record.designation],
          ['Coach', record.coach_code],
          ['Journey day', record.journey_day],
          ['Captured', fmtDateTime(record.device_timestamp)],
          ['Comments', record.comments],
        ]} />
        <RatingsView ratings={record.ratings} bank={bank} />
        <ReviewPanel record={record} allowed={canAct(me, 'feedback.railway.review', record)}
          onReview={(status, remarks) => ops.railwayFeedback.review(record.id, status, remarks)} onDone={onChanged} />
      </div>
    </Dialog>
  );
}

function RailwayRecords() {
  const journeys = useJourneyOptions();
  const [journeyId, setJourneyId] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [open, setOpen] = useState(null);
  const res = useResource('/feedback/railway', { journey_id: journeyId, page: pageNo, page_size: 50 });
  return (
    <>
      <FilterBar>
        <Field label="Journey filter"><Select value={journeyId} onChange={(v) => { setJourneyId(v); setPageNo(1); }} placeholder="All journeys" options={journeys} /></Field>
      </FilterBar>
      <DataState res={res} empty="No railway official feedback recorded yet.">
        {(page) => (
          <>
            <Table rows={page.items} onRowClick={setOpen} columns={[
              { key: 'official_name', label: 'Official', render: (f) => <>{f.official_name}<span className="block text-xs text-slate-500">{f.railway_employee_id}</span></> },
              { key: 'coach', label: 'Coach / day', render: (f) => `${f.coach_code ?? '—'} · D${f.journey_day}` },
              { key: 'ratings', label: 'Ratings', render: (f) => f.ratings?.length ?? 0 },
              { key: 'sync', label: 'Sync', render: (f) => <SyncState record={f} /> },
              { key: 'verification', label: 'Verification', render: (f) => <RailwayStatusBadge record={f} /> },
            ]} />
            <Pager data={page} onPage={setPageNo} />
          </>
        )}
      </DataState>
      {open && <RailwayDetail record={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); res.reload(); }} />}
    </>
  );
}

function FeedbackRecords() {
  const [audience, setAudience] = useState('passenger');
  return (
    <Panel>
      <div className="mb-4"><Segmented label="Feedback type" value={audience} onChange={setAudience}
        options={[{ value: 'passenger', label: 'Passenger' }, { value: 'railway', label: 'Railway official' }]} /></div>
      {audience === 'passenger' ? <PassengerRecords /> : <RailwayRecords />}
    </Panel>
  );
}

// Routes: #/feedback (overview), #/feedback/journey/<id> (overview of a journey), #/feedback/new/<journey>/<coach>/<day>
// (passenger step 1), #/feedback/passenger/<id> (a passenger record: verification, ratings, comments).
export default function Feedback({ parts }) {
  const { can } = useSession();
  const tabs = [
    can('feedback.collect') && { value: 'passenger', label: 'Passenger' },
    can('feedback.railway.submit') && { value: 'railway', label: 'Railway official' },
    can('feedback.read') && { value: 'list', label: 'Records' },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]?.value);
  if (parts[0] === 'passenger' && parts[1]) return <PassengerFlow id={parts[1]} key={parts[1]} />;
  if (parts[0] === 'new' && parts[3]) {
    return <PassengerStart journeyId={parts[1]} coach={decodeURIComponent(parts[2])} day={Math.max(1, Number(parts[3]) || 1)} key={parts.join('/')} />;
  }
  const journeyId = parts[0] === 'journey' ? parts[1] : undefined;
  return (
    <>
      <PageHeader title="Feedback" back={journeyId ? `#/journeys/${journeyId}` : '#/'} />
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      {tab === 'passenger' && <FeedbackOverview journeyId={journeyId} key={journeyId ?? 'all'} />}
      {tab === 'railway' && <RailwayForm />}
      {tab === 'list' && <FeedbackRecords />}
    </>
  );
}
