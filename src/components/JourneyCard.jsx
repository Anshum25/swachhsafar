// A journey as a card (reference: journey list): train icon in a pale circle, the train name, number and
// date, and the train artwork on the right. A link with `href`, a button with `onClick`.
import { TrainArt } from './Logo.jsx';
import { TrainSolidIcon } from './Icons.jsx';
import { fmtDate } from './ui.jsx';

export default function JourneyCard({ j, href, onClick, extra }) {
  const cls = 'tap relative flex w-full items-center gap-3 overflow-hidden rounded-2xl bg-white py-3.5 pl-3.5 pr-2 text-left shadow-card ring-1 ring-line/70 hover:ring-brand-200';
  const body = (
    <>
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700"><TrainSolidIcon className="h-5.5 w-5.5" /></span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[15px] font-extrabold uppercase leading-tight tracking-tight text-brand-900">{j.train_name}</span>
        <span className="mt-1 block truncate text-[12.5px] text-muted">Train No.: <b className="font-semibold text-ink">{j.train_no}</b></span>
        <span className="block truncate text-[12.5px] text-muted">Journey Date: <b className="font-semibold text-ink">{fmtDate(j.journey_date)}</b></span>
        {extra && <span className="mt-1 block text-xs text-muted">{extra}</span>}
      </span>
      <TrainArt className="pointer-events-none h-12 w-[5.5rem] shrink-0 -scale-x-100 sm:w-24" track={false} />
    </>
  );
  return href
    ? <a href={href} className={cls} data-testid="journey-card">{body}</a>
    : <button type="button" onClick={onClick} className={cls} data-testid="journey-card">{body}</button>;
}
