// Permissions in plain words, for people setting rights (Master data -> Rights & permissions) and reading a
// user's profile. The codes (audit.read, users.manage ...) stay what the server checks
// (backend app/security/catalog.py); only what people read changes here. A code missing from this list is
// still shown, worded from the code itself, so a permission added on the server never disappears.
const NAMES = {
  // Administration
  'audit.read': ['See the activity log', 'Who did what in the app, and when'],
  'charge.manage': ['Hand over a division', "Give someone temporary charge of a division while its in-charge is away"],
  'clients.read': ['See offices and credits', 'Offices (clients), the modules they use and their credit balance'],
  'clients.manage': ['Add and edit offices', 'Create offices (clients) and choose the modules they use'],
  'credits.manage': ['Add credits and set prices', 'Add credits, set the cost per journey and correct a balance'],
  'divisions.manage': ['Add and edit divisions', 'Create stations and headquarters and change their details'],
  'permissions.manage': ['Change rights & permissions', 'Decide what each role is allowed to do (this page)'],
  'policies.manage': ['Change division rules', 'Attendance, location and other working rules of a division'],
  // Users
  'users.read': ['See staff', 'List staff and open their profiles'],
  'users.manage': ['Add and edit staff', 'Create, edit, move and deactivate staff accounts'],
  'users.kyc.read': ['See staff ID documents', "Staff KYC: Aadhaar, PAN, bank and other personal details"],
  'users.kyc.manage': ['Edit staff ID documents', "Change staff KYC: Aadhaar, PAN, bank and other personal details"],
  // Master data
  'trains.read': ['See trains and coaches', 'Trains, their coaches and inspection settings'],
  'trains.manage': ['Add and edit trains', 'Trains, their coaches and how often coaches are inspected'],
  'questions.manage': ['Edit feedback questions', 'The question banks passengers and railway officials answer'],
  'inventory.items.manage': ['Edit the stock item list', 'The items (soap, phenyl ...) that are issued on journeys'],
  'complaints.masters.manage': ['Edit complaint categories', 'Complaint categories and the departments they go to'],
  // Journeys
  'journeys.read': ['See their own journeys', 'Journeys this person works on'],
  'journeys.read_all': ['See all journeys', 'Every journey of the division, not only their own'],
  'journeys.manage': ['Create and manage journeys', 'Create, change and cancel journeys, and assign supervisors'],
  'staff.manage': ['Assign staff to journeys', 'Add and remove the staff working on a journey'],
  // Attendance
  'attendance.submit': ['Mark attendance', 'Take attendance photos of the staff on a journey'],
  'attendance.read': ['See attendance', 'Attendance records and photos'],
  'attendance.review': ['Approve attendance', 'Verify or reject attendance records'],
  // Coach inspection
  'inspections.submit': ['Inspect coaches', 'Record coach cleanliness inspections with photos'],
  'inspections.read': ['See inspections', 'Coach inspection records and photos'],
  'inspections.review': ['Approve inspections', 'Verify or reject coach inspections'],
  // Feedback
  'feedback.collect': ['Collect passenger feedback', 'Take feedback from passengers on a journey'],
  'feedback.railway.submit': ['Record railway feedback', "Record a railway official's feedback on a journey"],
  'feedback.read': ['See feedback', 'Passenger and railway feedback'],
  'feedback.review': ['Approve or void feedback', 'Verify railway feedback and void wrong passenger feedback'],
  // Complaints
  'complaints.create': ['Raise complaints', 'Log a complaint on a journey'],
  'complaints.read': ['See complaints', 'Complaints and where they stand'],
  'complaints.manage': ['Handle complaints', 'Work on, forward and close complaints'],
  // Inventory
  'inventory.read': ['See journey stock', 'What was issued and returned on each journey'],
  'inventory.transact': ['Issue and return stock', 'Record stock given out and taken back on a journey'],
  // Reports
  'reports.read': ['See reports', 'Attendance, inspection, feedback and PSI reports'],
  'dashboard.read': ['See the dashboard', 'Counts and charts on the dashboard'],
  // Photos and files
  'media.upload': ['Upload photos and files', 'Send the photos and files taken in the app'],
};

// Plain name of a permission ("audit.read" -> "See the activity log").
export function permissionName(code) {
  if (NAMES[code]) return NAMES[code][0];
  const words = String(code ?? '').replace(/[._]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

// One line on what the permission allows; the server's own description when this list does not know it.
export function permissionHint(code, fallback = '') {
  return NAMES[code]?.[1] ?? fallback;
}

// The heading a permission is listed under on a user's profile (the rights page groups by the server's module).
const GROUP_BY_PREFIX = {
  audit: 'Administration', charge: 'Administration', clients: 'Administration', credits: 'Administration',
  divisions: 'Administration', permissions: 'Administration', policies: 'Administration', users: 'Staff',
  trains: 'Master data', questions: 'Master data', journeys: 'Journeys', staff: 'Journeys',
  attendance: 'Attendance', inspections: 'Coach inspection', feedback: 'Feedback', complaints: 'Complaints',
  inventory: 'Inventory', reports: 'Reports', dashboard: 'Reports', media: 'Photos and files',
};
const GROUP_BY_CODE = { 'inventory.items.manage': 'Master data', 'complaints.masters.manage': 'Master data' };
export function permissionGroup(code) {
  return GROUP_BY_CODE[code] ?? GROUP_BY_PREFIX[String(code ?? '').split('.')[0]] ?? 'Other';
}
