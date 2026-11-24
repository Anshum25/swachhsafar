import { coachBreakdown } from '../utils/coaches.js';

// A train's coaches as three small tables, AC, Non-AC and General, each grouped by class with a count.
export default function CoachBreakdown({ coaches, className = '' }) {
  const b = coachBreakdown(coaches);
  if (!b.ac.total && !b.nonAc.total && !b.gen.total) return null;
  return (
    <div className={`grid gap-2 sm:grid-cols-3 ${className}`}>
      <Side title="AC coaches" side={b.ac} tone="text-sky-800" />
      <Side title="Non-AC coaches" side={b.nonAc} tone="text-amber-800" />
      <Side title="General coaches" side={b.gen} tone="text-emerald-800" />
    </div>
  );
}

function Side({ title, side, tone }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2">
      <p className={`flex justify-between text-xs font-semibold ${tone}`}>
        <span>{title}</span><span>{side.total}</span>
      </p>
      {side.groups.length === 0 ? <p className="mt-1 text-[11px] text-muted">None</p> : (
        <table className="mt-1 w-full text-[11px]">
          <tbody>
            {side.groups.map((g) => (
              <tr key={g.label + g.codes} className="border-t border-slate-100">
                <td className="py-0.5 pr-2 font-medium text-ink">{g.codes}</td>
                <td className="py-0.5 pr-2 text-slate-600">{g.label}</td>
                <td className="py-0.5 text-right tabular-nums text-ink">{g.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
