// The Master Data subsections: one registry for the secondary sidebar, the phone section menu and the
// routes #/masters/<key>. `show(can)` mirrors what the old tab strip offered (the server re-checks every call).
import {
  BoxIcon, BriefcaseIcon, ClipboardListIcon, DatabaseGridIcon, FlagIcon, SettingsIcon, ShieldIcon, TrainIcon, UsersIcon,
} from '../../../components/Icons.jsx';

export const MASTER_GROUPS = ['Organisation', 'Feedback & complaints', 'Operations'];

export const MASTER_SECTIONS = [
  { key: 'trains', group: 'Organisation', label: 'Trains & Coaches', hint: 'Trains, coaches, rounds', Icon: TrainIcon, show: (can) => can('trains.read') || can('trains.manage') },
  { key: 'users', group: 'Organisation', label: 'Users', hint: 'Staff, sign-in, biometrics', Icon: UsersIcon, show: (can) => can('users.read') },
  { key: 'divisions', group: 'Organisation', label: 'Divisions', hint: 'Railway divisions', Icon: DatabaseGridIcon },
  // Clients (offices): modules and the prepaid wallet. A client's own administrator sees it read-only;
  // creating offices, changing modules and moving credits are the Super Admin's (the server enforces it).
  { key: 'clients', group: 'Organisation', label: 'Clients & Credits', hint: 'Offices, modules, prepaid credits', Icon: BriefcaseIcon, show: (can) => can('clients.read') },
  // The office's stations and the trains planned from them (OfficeSetup.jsx). The server lets only the
  // Super Admin and the office's own Admin save it.
  { key: 'setup', group: 'Organisation', label: 'Stations & trains', hint: 'From the railway network', Icon: TrainIcon, show: (can) => can('clients.read') },
  // Role rights: the default grants and this division's overrides. Needs permissions.manage to change,
  // and the screen itself explains that an unsubscribed module overrides whatever it says.
  { key: 'roles', group: 'Organisation', label: 'Role rights', hint: 'What each role may do', Icon: ShieldIcon, show: (can) => can('permissions.manage') },
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
