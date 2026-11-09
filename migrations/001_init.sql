create table users (
  id bigserial primary key,
  username text unique not null,
  password_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id bigint not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- The shared store: one row per application number, filled only by successful lookups.
create table records (
  id bigserial primary key,
  application_no text unique not null,
  vehicle_no text not null default '',
  transaction_no text not null default '',
  payment_id text not null default '',
  payment_date text not null default '',
  payment_confirmation_date text not null default '',
  payment_gateway text not null default '',
  bank_ref_no text not null default '',
  grn text not null default '',
  cin text not null default '',
  amount text not null default '',
  bank_status text not null default '',
  status_description text not null default '',
  first_found_at timestamptz not null default now(),
  last_found_at timestamptz not null default now()
);

-- Which client asked for which record. Every client query goes through user_id.
create table client_records (
  user_id bigint not null references users (id) on delete cascade,
  record_id bigint not null references records (id) on delete cascade,
  first_requested_at timestamptz not null default now(),
  last_requested_at timestamptz not null default now(),
  primary key (user_id, record_id)
);

create index client_records_user_recent_idx on client_records (user_id, last_requested_at desc);
