import { useResource, useSession } from '../app/session.jsx';
import { navigate } from '../app/router.js';
import { DataState } from './ui.jsx';
import JourneyCard from './JourneyCard.jsx';

// Active journeys the user works on; screens route to `${base}/${journeyId}` on pick.
export default function JourneyPicker({ base, title = 'Select an active journey' }) {
  const { can } = useSession();
  const res = useResource('/journeys', { state: 'active', mine: !can('journeys.read_all'), page_size: 100 });
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <DataState res={res} empty="No active journeys are assigned to you.">
        {(page) => (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2 xl:grid-cols-3">
            {page.items.map((j) => (
              <li key={j.id}>
                <JourneyCard j={j} onClick={() => navigate(`${base}/${j.id}`)} extra={`${j.coaches.length} coaches · ${j.staff?.filter((s) => !s.removed_at).length ?? 0} staff`} />
              </li>
            ))}
          </ul>
        )}
      </DataState>
    </section>
  );
}
