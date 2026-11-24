# Database schema

Generated from the SQLAlchemy models in `backend/app/models` (47 tables). The migrations in `backend/alembic/versions` create the same tables; regenerate this file when a model changes.

## How client-wise scoping works

```
clients (office)
  └── divisions            divisions.client_id → clients.id
        └── users, trains, journeys, masters, records   <table>.division_id → divisions.id
```

Only `clients`, `credit_ledger` and `divisions` carry a `client_id`. Every master and operational table carries `division_id`, so "everything for client X" is always:

```sql
SELECT * FROM journeys
WHERE division_id IN (SELECT id FROM divisions WHERE client_id = :client_id);
```

Child tables without their own `division_id` (`train_coaches`, `questions`, `journey_coaches`, ratings, `complaint_history`, `complaint_attachments`, `otp_challenges`) follow their parent row.

## Master data

| Screen (Masters menu) | Tables | Scoped by |
|---|---|---|
| Trains & Coaches | `trains`, `train_coaches` | division |
| Users | `users`, `user_credentials`, `employee_kyc`, `face_enrollments`, `fingerprint_enrollments`, `charge_maps` | division |
| Divisions | `divisions` | client |
| Clients & Credits | `clients`, `credit_ledger` | client (Super Admin only) |
| Role rights | `roles`, `permissions`, `role_permissions` | global, with optional per-division overrides |
| Question Banks | `question_banks`, `questions` | division (`division_id` NULL = global bank) |
| Complaint Categories | `complaint_categories` | division |
| Complaint Departments | `complaint_departments` | division |
| Inventory Items | `inventory_items` | division |
| Division Policy | `division_policies` | division (one row each) |

All IDs are UUIDs (stored as `CHAR(32)` on SQLite, `UUID` on PostgreSQL) except `roles.id` (integer) and `permissions.code` (text). Timestamps are timezone-aware.

## Tables

| Area | Table | Scope |
|---|---|---|
| Clients and billing (scope level 1: the office) | [`clients`](#clients) | - |
| Clients and billing (scope level 1: the office) | [`credit_ledger`](#credit_ledger) | client |
| Organisation and access | [`divisions`](#divisions) | client |
| Organisation and access | [`roles`](#roles) | - |
| Organisation and access | [`permissions`](#permissions) | - |
| Organisation and access | [`role_permissions`](#role_permissions) | division |
| Organisation and access | [`users`](#users) | division |
| Organisation and access | [`employee_kyc`](#employee_kyc) | - |
| Organisation and access | [`charge_maps`](#charge_maps) | division |
| Organisation and access | [`division_policies`](#division_policies) | division |
| Organisation and access | [`audit_logs`](#audit_logs) | division |
| Master data: trains | [`trains`](#trains) | division |
| Master data: trains | [`train_coaches`](#train_coaches) | - |
| Master data: feedback | [`question_banks`](#question_banks) | division |
| Master data: feedback | [`questions`](#questions) | - |
| Master data: complaints | [`complaint_departments`](#complaint_departments) | division |
| Master data: complaints | [`complaint_categories`](#complaint_categories) | division |
| Master data: complaints | [`complaint_counters`](#complaint_counters) | division |
| Master data: inventory | [`inventory_items`](#inventory_items) | division |
| Journeys | [`journeys`](#journeys) | division |
| Journeys | [`journey_coaches`](#journey_coaches) | - |
| Journeys | [`staff_allocations`](#staff_allocations) | division |
| Operations (recorded on the phone) | [`attendance`](#attendance) | division |
| Operations (recorded on the phone) | [`inspections`](#inspections) | division |
| Operations (recorded on the phone) | [`media_objects`](#media_objects) | division |
| Feedback records | [`passenger_feedback`](#passenger_feedback) | division |
| Feedback records | [`passenger_feedback_ratings`](#passenger_feedback_ratings) | - |
| Feedback records | [`otp_challenges`](#otp_challenges) | - |
| Feedback records | [`railway_feedback`](#railway_feedback) | division |
| Feedback records | [`railway_feedback_ratings`](#railway_feedback_ratings) | - |
| Complaints records | [`complaints`](#complaints) | division |
| Complaints records | [`complaint_history`](#complaint_history) | - |
| Complaints records | [`complaint_attachments`](#complaint_attachments) | - |
| Inventory records | [`inventory_transactions`](#inventory_transactions) | division |
| Biometrics | [`face_enrollments`](#face_enrollments) | division |
| Biometrics | [`fingerprint_enrollments`](#fingerprint_enrollments) | division |
| Sign-in and security | [`user_credentials`](#user_credentials) | - |
| Sign-in and security | [`auth_sessions`](#auth_sessions) | - |
| Sign-in and security | [`devices`](#devices) | - |
| Sign-in and security | [`login_otps`](#login_otps) | - |
| Sign-in and security | [`login_attempts`](#login_attempts) | - |
| Sign-in and security | [`security_events`](#security_events) | division |
| Sign-in and security | [`captcha_uses`](#captcha_uses) | - |
| Sync, releases, temporary | [`sync_operations`](#sync_operations) | - |
| Sync, releases, temporary | [`web_bundles`](#web_bundles) | - |
| Sync, releases, temporary | [`web_channels`](#web_channels) | - |

## Clients and billing (scope level 1: the office)

### clients

| Column | Type | Keys / rules |
|---|---|---|
| `office_id` | VARUUID | unique not null |
| `name` | VARCHAR(150) | not null |
| `contact_name` | VARCHAR(100) |  |
| `contact_mobile` | VARCHAR(10) |  |
| `contact_email` | VARCHAR(254) |  |
| `gstin` | VARCHAR(15) |  |
| `address` | TEXT |  |
| `status` | VARCHAR(10) | not null |
| `enabled_modules` | JSON | not null |
| `credit_balance` | INTEGER | not null |
| `credit_per_journey` | INTEGER | not null |
| `low_credit_threshold` | INTEGER | not null |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### credit_ledger

| Column | Type | Keys / rules |
|---|---|---|
| `created_at` | DATETIME | not null |
| `client_id` | UUID | → clients.id not null |
| `delta` | INTEGER | not null |
| `balance_after` | INTEGER | not null |
| `reason` | VARCHAR(20) | not null |
| `journey_id` | UUID |  |
| `reference` | VARCHAR(100) |  |
| `note` | TEXT |  |
| `created_by_id` | UUID | → users.id |
| `is_system` | BOOLEAN | not null |
| `id` | UUID | PK |


## Organisation and access

### divisions

| Column | Type | Keys / rules |
|---|---|---|
| `code` | VARCHAR(16) | unique not null |
| `name` | VARCHAR(100) | not null |
| `is_active` | BOOLEAN | not null |
| `client_id` | UUID | → clients.id not null |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### roles

| Column | Type | Keys / rules |
|---|---|---|
| `id` | INTEGER | PK |
| `code` | VARUUID | unique not null |
| `name` | VARCHAR(50) | not null |
| `level` | INTEGER | not null |

### permissions

| Column | Type | Keys / rules |
|---|---|---|
| `code` | VARCHAR(64) | PK |
| `module` | VARUUID | not null |
| `description` | VARCHAR(200) | not null |

### role_permissions

| Column | Type | Keys / rules |
|---|---|---|
| `role_id` | INTEGER | → roles.id not null |
| `permission_code` | VARCHAR(64) | → permissions.code not null |
| `division_id` | UUID | → divisions.id |
| `effect` | VARCHAR(8) | not null |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### users

| Column | Type | Keys / rules |
|---|---|---|
| `firebase_uid` | VARCHAR(128) | unique |
| `emp_id` | VARUUID | not null |
| `name` | VARCHAR(100) | not null |
| `name_hindi` | VARCHAR(100) |  |
| `email` | VARCHAR(254) |  |
| `mobile` | VARCHAR(10) |  |
| `gender` | VARCHAR(1) |  |
| `designation` | VARCHAR(100) |  |
| `lang` | VARCHAR(5) | not null |
| `role_id` | INTEGER | → roles.id not null |
| `division_id` | UUID | → divisions.id not null |
| `status` | VARCHAR(10) | not null |
| `deleted_at` | DATETIME |  |
| `created_by_id` | UUID | → users.id |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### employee_kyc

| Column | Type | Keys / rules |
|---|---|---|
| `user_id` | UUID | PK → users.id |
| `father_name` | VARCHAR(100) |  |
| `birth_date` | DATE |  |
| `first_engaged_on` | DATE |  |
| `rail_reg_id` | VARUUID |  |
| `aadhaar_last4` | VARCHAR(4) |  |
| `education` | VARCHAR(100) |  |
| `address` | TEXT |  |
| `documents` | JSON | not null |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### charge_maps

| Column | Type | Keys / rules |
|---|---|---|
| `user_id` | UUID | → users.id not null |
| `division_id` | UUID | → divisions.id not null |
| `from_date` | DATE | not null |
| `to_date` | DATE | not null |
| `is_active` | BOOLEAN | not null |
| `created_by_id` | UUID | → users.id not null |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### division_policies

| Column | Type | Keys / rules |
|---|---|---|
| `division_id` | UUID | PK → divisions.id |
| `settings` | JSON | not null |
| `updated_by_id` | UUID | → users.id |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### audit_logs

| Column | Type | Keys / rules |
|---|---|---|
| `created_at` | DATETIME | not null |
| `actor_id` | UUID | → users.id |
| `division_id` | UUID | → divisions.id |
| `action` | VARCHAR(64) | not null |
| `entity_type` | VARCHAR(64) | not null |
| `entity_id` | VARCHAR(64) | not null |
| `changes` | JSON | not null |
| `id` | UUID | PK |


## Master data: trains

### trains

| Column | Type | Keys / rules |
|---|---|---|
| `division_id` | UUID | → divisions.id not null |
| `train_no` | VARCHAR(15) | not null |
| `name` | VARCHAR(100) | not null |
| `duration_days` | INTEGER | not null |
| `operational_days` | INTEGER | not null |
| `start_time` | TIME |  |
| `end_time` | TIME |  |
| `return_start_time` | TIME |  |
| `return_end_time` | TIME |  |
| `daywise` | BOOLEAN | not null |
| `inspection_rounds_per_day` | INTEGER | not null |
| `before_inspection_enabled` | BOOLEAN | not null |
| `after_inspection_enabled` | BOOLEAN | not null |
| `is_active` | BOOLEAN | not null |
| `origin_code` | VARCHAR(8) | station it starts at (RailRadar) |
| `destination_code` | VARCHAR(8) | station it ends at |
| `destination_name` | VARCHAR(120) |  |
| `run_days` | VARCHAR(27) | "mon,tue,..."; NULL = every day |
| `auto_journeys` | BOOLEAN | not null; journeys planned daily (services/railway.plan_journeys) |
| `arrival_days` | INTEGER | days after departure it reaches its last station, 0–7; NULL = schedule not read |
| `return_train_id` | UUID | → trains.id (SET NULL); the train that makes the return trip |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### train_coaches

| Column | Type | Keys / rules |
|---|---|---|
| `train_id` | UUID | → trains.id not null |
| `code` | VARCHAR(10) | not null |
| `classification` | VARCHAR(8) | not null: AC, NON_AC or GEN (general) |
| `position` | INTEGER | not null |
| `id` | UUID | PK |


## Master data: feedback

### question_banks

| Column | Type | Keys / rules |
|---|---|---|
| `division_id` | UUID | → divisions.id |
| `audience` | VARCHAR(10) | not null |
| `name` | VARCHAR(100) | not null |
| `scale_min` | INTEGER | not null |
| `scale_max` | INTEGER | not null |
| `is_active` | BOOLEAN | not null |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### questions

| Column | Type | Keys / rules |
|---|---|---|
| `bank_id` | UUID | → question_banks.id not null |
| `position` | INTEGER | not null |
| `text_en` | TEXT | not null |
| `text_hi` | TEXT |  |
| `applies_ac` | BOOLEAN | not null |
| `applies_non_ac` | BOOLEAN | not null |
| `applies_gen` | BOOLEAN | not null (General coaches; at least one of the three) |
| `required` | BOOLEAN | not null |
| `psi_weight` | NUMERIC(6, 3) |  |
| `id` | UUID | PK |


## Master data: complaints

### complaint_departments

| Column | Type | Keys / rules |
|---|---|---|
| `division_id` | UUID | → divisions.id not null |
| `name` | VARCHAR(100) | not null |
| `is_active` | BOOLEAN | not null |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### complaint_categories

| Column | Type | Keys / rules |
|---|---|---|
| `division_id` | UUID | → divisions.id not null |
| `parent_id` | UUID | → complaint_categories.id |
| `name` | VARCHAR(100) | not null |
| `default_department_id` | UUID | → complaint_departments.id |
| `sla_hours` | INTEGER |  |
| `sort_order` | INTEGER | not null |
| `is_active` | BOOLEAN | not null |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### complaint_counters

| Column | Type | Keys / rules |
|---|---|---|
| `division_id` | UUID | PK → divisions.id |
| `year` | INTEGER | PK |
| `last_seq` | INTEGER | not null |


## Master data: inventory

### inventory_items

| Column | Type | Keys / rules |
|---|---|---|
| `division_id` | UUID | → divisions.id not null |
| `name` | VARCHAR(100) | not null |
| `unit` | VARCHAR(4) | not null |
| `ideal_qty` | NUMERIC(12, 3) | not null |
| `is_active` | BOOLEAN | not null |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |


## Journeys

### journeys

| Column | Type | Keys / rules |
|---|---|---|
| `division_id` | UUID | → divisions.id not null |
| `train_id` | UUID | → trains.id not null |
| `linked_train_id` | UUID | → trains.id |
| `journey_date` | DATE | not null |
| `outbound_end_date` | DATE |  |
| `linked_journey_date` | DATE | not null |
| `end_date` | DATE | not null |
| `start_time` | TIME |  |
| `end_time` | TIME |  |
| `return_start_time` | TIME |  |
| `return_end_time` | TIME |  |
| `duration_days` | INTEGER | not null |
| `operational_days` | INTEGER | not null |
| `daywise` | BOOLEAN | not null |
| `inspection_rounds_per_day` | INTEGER | not null |
| `before_inspection_enabled` | BOOLEAN | not null |
| `after_inspection_enabled` | BOOLEAN | not null |
| `supervisor_id` | UUID | → users.id not null |
| `created_by_id` | UUID | → users.id not null |
| `status` | VARCHAR(10) | not null |
| `cancelled_at` | DATETIME |  |
| `cancelled_by_id` | UUID | → users.id |
| `cancel_reason` | VARCHAR(300) |  |
| `version` | INTEGER | not null |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### journey_coaches

| Column | Type | Keys / rules |
|---|---|---|
| `journey_id` | UUID | → journeys.id not null |
| `code` | VARCHAR(10) | not null |
| `classification` | VARCHAR(8) | not null: AC, NON_AC or GEN (general) |
| `position` | INTEGER | not null |
| `id` | UUID | PK |

### staff_allocations

| Column | Type | Keys / rules |
|---|---|---|
| `journey_id` | UUID | → journeys.id not null |
| `user_id` | UUID | → users.id not null |
| `role_id` | INTEGER | → roles.id not null |
| `division_id` | UUID | → divisions.id not null |
| `allocated_by_id` | UUID | → users.id not null |
| `removed_at` | DATETIME |  |
| `removed_by_id` | UUID | → users.id |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |


## Operations (recorded on the phone)

### attendance

| Column | Type | Keys / rules |
|---|---|---|
| `employee_id` | UUID | → users.id not null |
| `stage` | INTEGER | not null |
| `photo_media_id` | UUID | → media_objects.id unique |
| `group_submission_id` | UUID |  |
| `face_distance` | FLOAT |  |
| `face_model` | VARCHAR(40) |  |
| `identified_by` | VARCHAR(20) |  |
| `fingerprint_score` | INTEGER |  |
| `fingerprint_matcher` | VARCHAR(40) |  |
| `fingerprint_finger` | VARCHAR(20) |  |
| `id` | UUID | PK |
| `division_id` | UUID | → divisions.id not null |
| `journey_id` | UUID | → journeys.id not null |
| `device_timestamp` | DATETIME | not null |
| `server_timestamp` | DATETIME | not null |
| `created_by_id` | UUID | → users.id not null |
| `verification_status` | VARCHAR(10) | not null |
| `verified_by_id` | UUID | → users.id |
| `verified_at` | DATETIME |  |
| `review_remarks` | VARCHAR(500) |  |
| `sync_op_id` | UUID |  |
| `payload_hash` | VARCHAR(64) | not null |
| `device_id` | VARCHAR(64) |  |
| `gps_timestamp` | DATETIME |  |
| `security` | JSON |  |
| `risk_flags` | JSON |  |
| `latitude` | NUMERIC(9, 6) | not null |
| `longitude` | NUMERIC(9, 6) | not null |
| `gps_accuracy_m` | NUMERIC(8, 2) |  |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### inspections

| Column | Type | Keys / rules |
|---|---|---|
| `coach_code` | VARCHAR(10) | not null |
| `day` | INTEGER | not null |
| `round` | INTEGER | not null |
| `phase` | VARCHAR(1) | not null |
| `comments` | TEXT |  |
| `photo_media_id` | UUID | → media_objects.id unique |
| `video_media_id` | UUID | → media_objects.id unique |
| `id` | UUID | PK |
| `division_id` | UUID | → divisions.id not null |
| `journey_id` | UUID | → journeys.id not null |
| `device_timestamp` | DATETIME | not null |
| `server_timestamp` | DATETIME | not null |
| `created_by_id` | UUID | → users.id not null |
| `verification_status` | VARCHAR(10) | not null |
| `verified_by_id` | UUID | → users.id |
| `verified_at` | DATETIME |  |
| `review_remarks` | VARCHAR(500) |  |
| `sync_op_id` | UUID |  |
| `payload_hash` | VARCHAR(64) | not null |
| `device_id` | VARCHAR(64) |  |
| `gps_timestamp` | DATETIME |  |
| `security` | JSON |  |
| `risk_flags` | JSON |  |
| `latitude` | NUMERIC(9, 6) | not null |
| `longitude` | NUMERIC(9, 6) | not null |
| `gps_accuracy_m` | NUMERIC(8, 2) |  |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### media_objects

| Column | Type | Keys / rules |
|---|---|---|
| `division_id` | UUID | → divisions.id not null |
| `owner_id` | UUID | → users.id not null |
| `journey_id` | UUID | → journeys.id |
| `kind` | VARCHAR(24) | not null |
| `declared_content_type` | VARCHAR(100) | not null |
| `content_type` | VARCHAR(100) |  |
| `declared_size_bytes` | BIGINT | not null |
| `size_bytes` | BIGINT |  |
| `sha256` | VARCHAR(64) | not null |
| `storage_path` | VARCHAR(300) | unique |
| `status` | VARCHAR(10) | not null |
| `rejection_reason` | VARCHAR(200) |  |
| `uploaded_at` | DATETIME |  |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |


## Feedback records

### passenger_feedback

| Column | Type | Keys / rules |
|---|---|---|
| `id` | UUID | PK |
| `division_id` | UUID | → divisions.id not null |
| `journey_id` | UUID | → journeys.id not null |
| `bank_id` | UUID | → question_banks.id not null |
| `coach_code` | VARCHAR(10) | not null |
| `coach_class` | VARCHAR(8) | not null: AC, NON_AC or GEN |
| `journey_day` | INTEGER | not null |
| `feedback_date` | DATE | not null |
| `passenger_name` | VARCHAR(100) | not null |
| `mobile` | VARCHAR(10) | not null |
| `pnr` | VARCHAR(10) |  |
| `seat_no` | VARCHAR(10) |  |
| `comments` | TEXT |  |
| `voice_media_id` | UUID | → media_objects.id unique |
| `status` | VARCHAR(10) | not null |
| `pnr_status` | VARCHAR(14) | not null |
| `pnr_details` | JSON |  |
| `pnr_checked_at` | DATETIME |  |
| `otp_status` | VARCHAR(14) | not null |
| `void_reason` | VARCHAR(200) |  |
| `device_timestamp` | DATETIME | not null |
| `server_timestamp` | DATETIME | not null |
| `verified_at` | DATETIME |  |
| `completed_at` | DATETIME |  |
| `collected_by_id` | UUID | → users.id not null |
| `payload_hash` | VARCHAR(64) | not null |
| `latitude` | NUMERIC(9, 6) | not null |
| `longitude` | NUMERIC(9, 6) | not null |
| `gps_accuracy_m` | NUMERIC(8, 2) |  |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### passenger_feedback_ratings

| Column | Type | Keys / rules |
|---|---|---|
| `feedback_id` | UUID | PK → passenger_feedback.id |
| `question_id` | UUID | PK → questions.id |
| `value` | INTEGER | not null |

### otp_challenges

| Column | Type | Keys / rules |
|---|---|---|
| `feedback_id` | UUID | → passenger_feedback.id unique not null |
| `mobile` | VARCHAR(10) | not null |
| `code_hash` | VARCHAR(64) | not null |
| `expires_at` | DATETIME | not null |
| `attempts` | INTEGER | not null |
| `send_count` | INTEGER | not null |
| `last_sent_at` | DATETIME | not null |
| `verified_at` | DATETIME |  |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### railway_feedback

| Column | Type | Keys / rules |
|---|---|---|
| `id` | UUID | PK |
| `division_id` | UUID | → divisions.id not null |
| `journey_id` | UUID | → journeys.id not null |
| `bank_id` | UUID | → question_banks.id not null |
| `railway_employee_id` | VARUUID | not null |
| `official_name` | VARCHAR(100) | not null |
| `designation` | VARCHAR(100) |  |
| `coach_code` | VARCHAR(10) |  |
| `journey_day` | INTEGER | not null |
| `comments` | TEXT |  |
| `verification_status` | VARCHAR(10) | not null |
| `verified_by_id` | UUID | → users.id |
| `verified_at` | DATETIME |  |
| `device_timestamp` | DATETIME | not null |
| `server_timestamp` | DATETIME | not null |
| `created_by_id` | UUID | → users.id not null |
| `payload_hash` | VARCHAR(64) | not null |
| `latitude` | NUMERIC(9, 6) | not null |
| `longitude` | NUMERIC(9, 6) | not null |
| `gps_accuracy_m` | NUMERIC(8, 2) |  |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### railway_feedback_ratings

| Column | Type | Keys / rules |
|---|---|---|
| `feedback_id` | UUID | PK → railway_feedback.id |
| `question_id` | UUID | PK → questions.id |
| `value` | INTEGER | not null |


## Complaints records

### complaints

| Column | Type | Keys / rules |
|---|---|---|
| `id` | UUID | PK |
| `complaint_no` | VARUUID | unique not null |
| `division_id` | UUID | → divisions.id not null |
| `journey_id` | UUID | → journeys.id |
| `train_id` | UUID | → trains.id |
| `coach_code` | VARCHAR(10) |  |
| `coach_class` | VARCHAR(8) | AC, NON_AC or GEN |
| `category_id` | UUID | → complaint_categories.id not null |
| `subcategory_id` | UUID | → complaint_categories.id |
| `description` | TEXT | not null |
| `latitude` | DOUBLE |  |
| `longitude` | DOUBLE |  |
| `department_id` | UUID | → complaint_departments.id |
| `assigned_to_id` | UUID | → users.id |
| `status` | VARCHAR(12) | not null |
| `sla_hours` | INTEGER | not null |
| `due_at` | DATETIME | not null |
| `resolution_remarks` | TEXT |  |
| `closed_at` | DATETIME |  |
| `closed_by_id` | UUID | → users.id |
| `device_timestamp` | DATETIME | not null |
| `server_timestamp` | DATETIME | not null |
| `created_by_id` | UUID | → users.id not null |
| `payload_hash` | VARCHAR(64) | not null |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### complaint_history

| Column | Type | Keys / rules |
|---|---|---|
| `complaint_id` | UUID | → complaints.id not null |
| `from_status` | VARCHAR(12) |  |
| `to_status` | VARCHAR(12) | not null |
| `actor_id` | UUID | → users.id not null |
| `forwarded_to_id` | UUID | → users.id |
| `department_id` | UUID | → complaint_departments.id |
| `remarks` | TEXT |  |
| `created_at` | DATETIME | not null |
| `id` | UUID | PK |

### complaint_attachments

| Column | Type | Keys / rules |
|---|---|---|
| `complaint_id` | UUID | PK → complaints.id |
| `media_id` | UUID | PK → media_objects.id unique |


## Inventory records

### inventory_transactions

| Column | Type | Keys / rules |
|---|---|---|
| `id` | UUID | PK |
| `division_id` | UUID | → divisions.id not null |
| `journey_id` | UUID | → journeys.id not null |
| `item_id` | UUID | → inventory_items.id not null |
| `coach_code` | VARCHAR(10) |  |
| `txn_type` | VARCHAR(8) | not null |
| `quantity` | NUMERIC(12, 3) | not null |
| `remarks` | VARCHAR(300) |  |
| `created_by_id` | UUID | → users.id not null |
| `created_at` | DATETIME | not null |
| `payload_hash` | VARCHAR(64) | not null |


## Biometrics

### face_enrollments

| Column | Type | Keys / rules |
|---|---|---|
| `user_id` | UUID | PK → users.id |
| `division_id` | UUID | → divisions.id not null |
| `model` | VARCHAR(40) | not null |
| `descriptors` | JSON | not null |
| `consent_at` | DATETIME | not null |
| `consent_recorded_by_id` | UUID | → users.id not null |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### fingerprint_enrollments

| Column | Type | Keys / rules |
|---|---|---|
| `user_id` | UUID | PK → users.id |
| `division_id` | UUID | → divisions.id not null |
| `format` | VARCHAR(40) | not null |
| `matcher` | VARCHAR(40) | not null |
| `fingers` | JSON | not null |
| `consent_at` | DATETIME | not null |
| `consent_recorded_by_id` | UUID | → users.id not null |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |


## Sign-in and security

### user_credentials

| Column | Type | Keys / rules |
|---|---|---|
| `user_id` | UUID | PK → users.id |
| `password_hash` | VARCHAR(512) | not null |
| `source` | VARCHAR(16) | not null |
| `password_changed_at` | DATETIME | not null |
| `legacy_firebase_uid` | VARCHAR(128) |  |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### auth_sessions

| Column | Type | Keys / rules |
|---|---|---|
| `id` | UUID | PK |
| `user_id` | UUID | → users.id not null |
| `device_id` | VARCHAR(64) | → devices.id not null |
| `method` | VARCHAR(16) | not null |
| `token_hash` | VARCHAR(64) | unique |
| `firebase_uid` | VARCHAR(128) |  |
| `ip` | VARCHAR(45) |  |
| `last_seen_at` | DATETIME | not null |
| `revoked_at` | DATETIME |  |
| `revoke_reason` | VARCHAR(40) |  |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### devices

| Column | Type | Keys / rules |
|---|---|---|
| `id` | VARCHAR(64) | PK |
| `platform` | VARCHAR(16) | not null |
| `label` | VARCHAR(120) |  |
| `status` | VARCHAR(10) | not null |
| `first_user_id` | UUID | → users.id |
| `last_user_id` | UUID | → users.id |
| `last_seen_at` | DATETIME |  |
| `last_ip` | VARCHAR(45) |  |
| `revoked_at` | DATETIME |  |
| `revoked_by_id` | UUID | → users.id |
| `revoke_reason` | VARCHAR(200) |  |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### login_otps

| Column | Type | Keys / rules |
|---|---|---|
| `id` | UUID | PK |
| `user_id` | UUID | → users.id not null |
| `mobile` | VARCHAR(10) | not null |
| `code_hash` | VARCHAR(64) | not null |
| `expires_at` | DATETIME | not null |
| `attempts` | INTEGER | not null |
| `send_count` | INTEGER | not null |
| `last_sent_at` | DATETIME | not null |
| `consumed_at` | DATETIME |  |
| `device_id` | VARCHAR(64) |  |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### login_attempts

| Column | Type | Keys / rules |
|---|---|---|
| `id` | UUID | PK |
| `method` | VARCHAR(16) | not null |
| `subject` | VARCHAR(254) | not null |
| `user_id` | UUID | → users.id |
| `device_id` | VARCHAR(64) |  |
| `ip` | VARCHAR(45) |  |
| `success` | BOOLEAN | not null |
| `reason` | VARCHAR(40) |  |
| `created_at` | DATETIME | not null |

### security_events

| Column | Type | Keys / rules |
|---|---|---|
| `id` | UUID | PK |
| `source` | VARCHAR(8) | not null |
| `type` | VARCHAR(48) | not null |
| `severity` | VARCHAR(8) | not null |
| `user_id` | UUID | → users.id |
| `device_id` | VARCHAR(64) |  |
| `session_id` | UUID |  |
| `division_id` | UUID | → divisions.id |
| `details` | JSON | not null |
| `ip` | VARCHAR(45) |  |
| `occurred_at` | DATETIME | not null |
| `received_at` | DATETIME | not null |

### captcha_uses

| Column | Type | Keys / rules |
|---|---|---|
| `signature_hash` | VARCHAR(64) | PK |
| `expires_at` | DATETIME | not null |


## Sync, releases, temporary

### sync_operations

| Column | Type | Keys / rules |
|---|---|---|
| `op_id` | UUID | PK |
| `user_id` | UUID | → users.id not null |
| `device_id` | VARCHAR(64) | not null |
| `op_type` | VARCHAR(40) | not null |
| `entity_id` | UUID | not null |
| `outcome` | VARCHAR(16) | not null |
| `http_status` | INTEGER | not null |
| `result` | JSON | not null |
| `received_at` | DATETIME | not null |

### web_bundles

| Column | Type | Keys / rules |
|---|---|---|
| `version` | VARUUID | not null |
| `build` | INTEGER | unique not null |
| `git_sha` | VARCHAR(40) | not null |
| `storage_path` | VARCHAR(300) | unique not null |
| `sha256` | VARCHAR(64) | not null |
| `size_bytes` | BIGINT | not null |
| `min_native_version` | VARUUID | not null |
| `api_base_url` | VARCHAR(200) |  |
| `notes` | VARCHAR(500) |  |
| `published_by` | VARCHAR(64) |  |
| `id` | UUID | PK |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |

### web_channels

| Column | Type | Keys / rules |
|---|---|---|
| `channel` | VARCHAR(16) | PK |
| `bundle_id` | UUID | → web_bundles.id |
| `rollout_percent` | INTEGER | not null |
| `mandatory` | BOOLEAN | not null |
| `rolled_back_from` | INTEGER |  |
| `pointed_at` | DATETIME |  |
| `pointed_by` | VARCHAR(64) |  |
| `created_at` | DATETIME | not null |
| `updated_at` | DATETIME | not null |


