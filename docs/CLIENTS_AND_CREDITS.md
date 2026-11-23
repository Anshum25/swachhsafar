# Clients, role rights, and the prepaid credit wallet

Three things that are easy to confuse, so they are named apart here and everywhere in the code:

| | What it decides | Who changes it |
|---|---|---|
| **Client (office)** | Which *modules* an organisation has bought, and its prepaid wallet | Super Admin only |
| **Role** | What a *person* may do with a module they have | Super Admin, or an admin with `permissions.manage` (per division) |
| **Division** | Which *records* a person can reach | Super Admin (`divisions.manage`) |

A user sees a screen only when **all three** allow it. The server applies all three; the app mirrors them
so nothing is captured offline that the server would refuse.

```
client.enabled_modules   does this office pay for Attendance?        ─┐
        ∩                                                             ├─► what the user sees
role_permissions         may a Janitor submit attendance?            ─┤
        ∩                                                             │
division scope           in which division's records?                ─┘
```

---

## 1. Clients are offices

Each client has its own **`office_id`** — unique, and how the Super Admin finds it. Divisions belong to a
client (`divisions.client_id`), and everything else follows from the division it is in: a user's client is
the client of their division, and no operational table needed a second scope column.

```
clients  (office_id, name, status, enabled_modules[], credit_balance, credit_per_journey)
   │
   └── divisions  (client_id)
          │
          └── users · journeys · attendance · inspections · every record
```

**One client, many divisions.** An office running CR and WR is one client with one wallet and one
subscription. Two offices that each run one division are two clients with separate wallets.

**Suspending a client** stops new journeys whatever the balance, and leaves running journeys alone.

### Where it lives

| Piece | File |
|---|---|
| Model | `backend/app/models/clients.py` |
| Migration | `backend/alembic/versions/0011_clients_credits.py` |
| Service | `backend/app/services/clients.py` |
| API | `backend/app/api/v1/clients.py` (`/clients`) |
| Screen | `src/pages/ops/masters/Clients.jsx` → Master data → **Clients & Credits** |
| Tests | `backend/tests/test_clients_credits.py` (25), `tests/unit/clientModules.test.js` (17) |

---

## 2. Module subscription: "this client only wants inspection"

The Super Admin ticks the modules an office has bought. Six can be switched on and off:

`attendance` · `inspections` · `feedback` · `complaints` · `inventory` · `reports`

Five are **never** switched off, because they are the platform rather than a product:

`admin` · `users` · `masters` · `media` · **`journeys`**

> **Why journeys is always on.** Every operational record hangs off a journey. A client that only records
> inspections still records them *against a journey*, so switching journeys off would produce a
> configuration that cannot work. The screen says so rather than offering the option.

### How it is enforced

One change does it for every endpoint: `Principal.permissions_in()`
(`backend/app/security/principal.py`) drops every permission whose module the client has not bought.
Because each permission already declares its module in `app/security/catalog.py`, a new permission is
gated by its module automatically.

That single point has three consequences worth knowing:

1. **`/auth/me` is already filtered.** An unsubscribed module's permissions are not in the response, so
   the app hides the screen without being told to.
2. **The refusal is specific.** `require()` answers `403 module_disabled` with the module name, not
   `permission_denied` — "your office does not pay for this" and "you lack this permission" are different
   problems, and only one of them is about the person holding the phone.
3. **The Super Admin is not gated.** They configure the subscriptions, so they must be able to see what
   they are configuring. `/auth/me` returns `client: null` for them.

### On the device

`me.client.modules` arrives with `/auth/me`, is refreshed by every `/sync/changes` pull, and is part of the
cached authorization snapshot — so it is just as available offline.

| Layer | File |
|---|---|
| Module registry (each screen declares its `module`) | `src/app/modules.js` |
| Navigation and tiles | `src/app/Layout.jsx`, `src/pages/ops/Dashboard.jsx` |
| Offline capture gate | `src/services/authorization.js` (`CAPTURE_RULES[*].module`) |
| Session exposure | `src/app/session.jsx` (`client`, `modules`, `moduleEnabled`) |

A capture for an unsubscribed module is refused **on the device**, with `module_disabled`. Letting it
queue would mean rejecting it at the next sync, hours later, with the work already done.

`modules === null` means *do not gate*: a Super Admin, and demo mode.

---

## 3. What each role sees

Defaults are in `backend/app/security/catalog.py` and are seeded by migration `0002`. The Super Admin can
override any of them **per division** through `role_permissions` (allow or deny), on
Master data → **Role rights** (`src/pages/ops/masters/RolePermissions.jsx`).

With every module subscribed, the defaults are:

| Role | Sees | Captures | Administers |
|---|---|---|---|
| **Super Admin** | everything, every division, every client | — | clients, credits, divisions, role rights |
| **Admin** | everything in their divisions | — | users, master data, policy; *reads* the wallet |
| **Manager** | journeys, all records, reports | complaints | users, trains; reviews attendance/inspections/feedback |
| **Supervisor / EHK** | journeys they run | attendance, inspections, feedback, complaints, inventory | — |
| **Janitor** | journeys they are on | **attendance only** | — |
| **Contractor** | journeys and records, read-only, plus reports | — | — |

**A Janitor's app** is therefore Dashboard, Journeys and Attendance — and if the office has not bought
Attendance, Dashboard and Journeys. **A Manager's** is every subscribed module plus Master data and
Reports. `tests/unit/clientModules.test.js` pins each of these.

Two rules the UI relies on:

- **An admin cannot grant themselves the wallet.** `clients.manage` and `credits.manage` are Super Admin
  only (`SUPER_ADMIN_ONLY` in the catalog). An Admin holds `clients.read`, which is what lets them see a
  low balance and ask for a top-up.
- **Super Admin grants are fixed.** `upsert_grant` refuses to edit role 1, so one account can always
  repair the others.

---

## 4. The prepaid wallet

### The rule

**One journey costs `credit_per_journey` credits, deducted when the journey is created.** The Super Admin
sets the rate per client. `0` makes journeys free, which is what every pre-existing deployment is migrated
to, so nothing started refusing journeys the day this shipped.

### Why at creation, and not at departure

Deducting in the transaction that inserts the journey makes three problems disappear:

- **It cannot be bypassed.** A journey without its charge, or a charge without its journey, cannot exist —
  same transaction, and a 402 rolls the whole create back.
- **It needs no scheduler.** No timer, nothing to miss, nothing to replay after an outage.
- **It refuses at the only honest moment**: while somebody is looking at the screen that asked for it.

Cancelling a journey **before its departure date** returns the credits. Cancelling one that has already
departed does not — the train has gone and the client has had the service. A cancellation after departure
is a record correction, not a refund.

### Empty wallet

| | With no credits |
|---|---|
| Create a journey | **refused**, `402 credits_exhausted` |
| Capture on an existing journey | works |
| Sync records already captured | works |
| Read journeys, reports, sign in | works |

Field staff are never stranded mid-trip by a billing state. The person who can act on it — an
administrator — gets a warning on the dashboard *before* anything stops, as soon as the balance reaches
`low_credit_threshold`.

### The ledger explains the balance

`credit_ledger` is append-only (triggers on SQLite; a test asserts an UPDATE fails). One row per movement,
with the balance after it:

| Reason | When | Sign |
|---|---|---|
| `top_up` | the client paid and the Super Admin recorded it, with the payment reference | `+` |
| `journey_charge` | a journey was created | `−` |
| `journey_refund` | a journey was cancelled before departure | `+` |
| `adjustment` | a correction, with a required reason | either |

`sum(credit_ledger.delta) == clients.credit_balance`, always, and
`test_the_ledger_explains_the_balance` asserts it. If those two ever disagree, one of them is lying about
money.

### What stops a double charge

- **A row lock.** Every balance change selects the client `FOR UPDATE` first, so two journeys created in
  the same second cannot both see the last credit.
- **A unique index.** `uq_credit_ledger_journey_reason` permits one `journey_charge` and one
  `journey_refund` per journey, so a retried create or a double cancel cannot double-spend. This is
  enforced by the database, not by callers behaving.
- **A non-negative balance.** A `CHECK (credit_balance >= 0)` constraint backs up the service check.

---

## 5. Setting up a new client

```
Master data → Clients & Credits → New office
```

1. **Office ID and name.** `OFF-002`, "Western Contractors Pvt Ltd". The office ID is permanent.
2. **Modules.** Tick what they have bought. For an inspection-only client, tick Coach inspection and
   leave the rest clear.
3. **Credits per journey.** `1` unless agreed otherwise; `0` for a pilot that should not be billed.
4. **Low-credit warning at.** `10` is a sensible default; `0` turns the warning off.
5. **Create the division(s)** under Master data → Divisions, choosing this office as the client.
6. **Add their users** under Master data → Users, in those divisions.
7. **Add credits** once they have paid — Clients & Credits → the office → Add credits, with the payment
   reference.

The wallet always starts at zero: credits only ever arrive through a recorded top-up, so the ledger
explains every credit the office has.

### Changing a client later

| To | Do |
|---|---|
| Sell them another module | Clients & Credits → office → Modules → tick → Save |
| Change the price | → Wallet → Set rate (journeys already charged are not re-priced) |
| Stop them without deleting anything | → Suspend office |
| Correct a mistake in the balance | → Wallet → Adjust, with a reason |

Removing a module takes effect on the next call any of their users makes, and the screen disappears from
their phones at the next sync. **Records already captured are kept** — the module going away does not
delete work.

---

## 6. API summary

All under `/api/v1`. Writes marked **SA** are Super Admin only, enforced in the service.

| Method | Path | What |
|---|---|---|
| GET | `/clients` | Every client (SA) or just your own |
| POST | `/clients` | Create an office **SA** |
| GET | `/clients/{id}` | One office |
| PATCH | `/clients/{id}` | Contact details, status, warning level **SA** |
| PUT | `/clients/{id}/modules` | Replace the subscription **SA** |
| PUT | `/clients/{id}/credit-rate` | Credits per journey **SA** |
| POST | `/clients/{id}/credits` | Add paid credits **SA** |
| POST | `/clients/{id}/credits/adjust` | Correct a balance **SA** |
| GET | `/clients/{id}/ledger` | Every movement, newest first |

`GET /auth/me` and `GET /sync/changes` both carry a `client` summary: `office_id`, `name`, `status`,
`modules` (subscription **plus** always-on, so the device needs no second list), `credit_balance`,
`credit_per_journey`, `low_credit`. It is `null` for a Super Admin.

### New error codes

| Code | Status | Means |
|---|---|---|
| `module_disabled` | 403 | The office has not subscribed to this module. Only the Super Admin can change it. |
| `credits_exhausted` | 402 | The wallet cannot cover this journey. `details` carries `office_id`, `balance`, `required`. |
| `client_suspended` | 402 | The office is suspended; no new journeys whatever the balance. |
| `office_id_taken` | 409 | That office ID already exists. |

---

## 7. Known limits

- **Credits are charged per journey, not per record.** A journey with 200 attendance records costs the
  same as one with two. Per-record billing would need a different trigger and a different conversation
  about what happens when a record arrives from a phone that was offline for a day.
- **No invoicing.** The ledger records what was paid for and when, with a reference; it does not produce
  an invoice, compute tax, or track dues. `gstin` is stored for whoever does.
- **A client's own administrator cannot see the ledger of another office**, by design, but they *can* see
  their own full history. If credit history should be Super-Admin-only, narrow `list_ledger`.
- **Charging happens on the server.** A journey can only be created online (it always could), so there is
  no offline path to charge and nothing to reconcile.
- **`low_credit` is computed per request**, not pushed. A phone learns the balance is low at its next
  `/auth/me` or sync, not the moment it happens.
