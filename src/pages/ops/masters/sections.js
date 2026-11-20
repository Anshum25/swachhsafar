// The Master Data subsections: one registry for the secondary sidebar, the phone section menu and the
// routes #/masters/<key>. `show(can)` mirrors what the old tab strip offered (the server re-checks every call).
import {
  BoxIcon, BriefcaseIcon, ClipboardListIcon, DatabaseGridIcon, FlagIcon, SettingsIcon, TrainIcon, UsersIcon,
} from '../../../components/Icons.jsx';

export const MASTER_SECTIONS = [
  { key: 'trains', label: 'Trains & Coaches', Icon: TrainIcon, show: (can) => can('trains.read') || can('trains.manage') },
  { key: 'users', label: 'Users', Icon: UsersIcon, show: (can) => can('users.read') },
  { key: 'divisions', label: 'Divisions', Icon: DatabaseGridIcon },
  // Readable by every member of the division (backend list endpoints); changes need the manage permission.
  { key: 'questions', label: 'Question Banks', Icon: ClipboardListIcon },
  { key: 'categories', label: 'Complaint Categories', Icon: FlagIcon },
  { key: 'departments', label: 'Complaint Departments', Icon: BriefcaseIcon },
  { key: 'items', label: 'Inventory Items', Icon: BoxIcon },
  { key: 'policy', label: 'Division Policy', Icon: SettingsIcon },
];

export const visibleSections = (can) => MASTER_SECTIONS.filter((s) => !s.show || s.show(can));

// '/masters/users/abc' -> 'users'; '/masters' -> null.
export const sectionOf = (path) => (path.startsWith('/masters/') ? path.split('/')[2] || null : null);
