// The Master Data subsections: one registry for the secondary sidebar, the phone section menu and the
// routes #/masters/<key>. `show(can)` mirrors what the old tab strip offered (the server re-checks every call).
import {
  BoxIcon, BriefcaseIcon, ClipboardListIcon, DatabaseGridIcon, FlagIcon, SettingsIcon, TrainIcon, UsersIcon,
} from '../../../components/Icons.jsx';

export const MASTER_GROUPS = ['Organisation', 'Feedback & complaints', 'Operations'];

export const MASTER_SECTIONS = [
  { key: 'trains', group: 'Organisation', label: 'Trains & Coaches', hint: 'Trains, coaches, rounds', Icon: TrainIcon, show: (can) => can('trains.read') || can('trains.manage') },
  { key: 'users', group: 'Organisation', label: 'Users', hint: 'Staff, sign-in, biometrics', Icon: UsersIcon, show: (can) => can('users.read') },
  { key: 'divisions', group: 'Organisation', label: 'Divisions', hint: 'Railway divisions', Icon: DatabaseGridIcon },
  // Readable by every member of the division (backend list endpoints); changes need the manage permission.
  { key: 'questions', group: 'Feedback & complaints', label: 'Question Banks', hint: 'Feedback questionnaires', Icon: ClipboardListIcon },
  { key: 'categories', group: 'Feedback & complaints', label: 'Complaint Categories', hint: 'Types of complaint', Icon: FlagIcon },
  { key: 'departments', group: 'Feedback & complaints', label: 'Complaint Departments', hint: 'Who resolves them', Icon: BriefcaseIcon },
  { key: 'items', group: 'Operations', label: 'Inventory Items', hint: 'Consumables and units', Icon: BoxIcon },
  { key: 'policy', group: 'Operations', label: 'Division Policy', hint: 'Operating rules', Icon: SettingsIcon },
];

export const visibleSections = (can) => MASTER_SECTIONS.filter((s) => !s.show || s.show(can));

// '/masters/users/abc' -> 'users'; '/masters' -> null.
export const sectionOf = (path) => (path.startsWith('/masters/') ? path.split('/')[2] || null : null);
