-- ============================================================
--  Generations Getaway LLC — Pricing schema
--  Run this ONCE in Supabase: SQL Editor -> New query -> Run
-- ============================================================
--  Creates three tables:
--    pricing_seasons  - base rate per season + which months map to it
--    pricing_overrides- specific dates or ranges at a custom rate
--    discount_codes   - editable codes, percent or flat-rate
--
--  Precedence when pricing a night (highest wins):
--    1. pricing_overrides  (a specific date range you set)
--    2. pricing_seasons    (the season that month belongs to)
-- ============================================================

-- ── Seasons ──────────────────────────────────────────────────
create table if not exists pricing_seasons (
  id          text primary key,              -- 'high' | 'medium' | 'low'
  label       text not null,
  nightly_rate numeric(10,2) not null check (nightly_rate >= 0),
  months      int[] not null default '{}',   -- 1-12
  sort_order  int  not null default 0,
  updated_at  timestamptz not null default now()
);

insert into pricing_seasons (id, label, nightly_rate, months, sort_order) values
  ('high',   'High Season',   550, '{1,2,3,4}',        1),
  ('medium', 'Medium Season', 425, '{5,11,12}',        2),
  ('low',    'Low Season',    350, '{6,7,8,9,10}',     3)
on conflict (id) do nothing;

-- ── Date-specific overrides ──────────────────────────────────
-- Use for holidays, events, blackout pricing, or a one-off deal.
create table if not exists pricing_overrides (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,                 -- e.g. 'New Year week'
  start_date   date not null,
  end_date     date not null,                 -- inclusive
  nightly_rate numeric(10,2) check (nightly_rate >= 0),
  is_blocked   boolean not null default false,-- true = not bookable
  min_nights   int,                           -- optional stricter minimum
  priority     int not null default 0,        -- higher wins on overlap
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint valid_range check (end_date >= start_date),
  constraint rate_or_blocked check (is_blocked or nightly_rate is not null)
);

create index if not exists idx_overrides_dates
  on pricing_overrides (start_date, end_date);

-- ── Discount codes ───────────────────────────────────────────
create table if not exists discount_codes (
  code          text primary key,             -- stored UPPERCASE
  label         text not null,
  kind          text not null check (kind in ('percent','rates')),
  percent       numeric(5,2) check (percent >= 0 and percent <= 100),
  rate_high     numeric(10,2),
  rate_medium   numeric(10,2),
  rate_low      numeric(10,2),
  free_nights   int not null default 0,
  free_seasons  text[] not null default '{}', -- empty = any season
  is_active     boolean not null default true,
  valid_from    date,
  valid_until   date,
  max_uses      int,                          -- null = unlimited
  times_used    int not null default 0,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

insert into discount_codes
  (code, label, kind, percent, rate_high, rate_medium, rate_low, free_nights, free_seasons) values
  ('FAMILYKB',  'Complimentary family stay',  'rates',   null, 0,   0,   0,   0, '{}'),
  ('FAMILYLOW', 'Family low-season rate',     'rates',   null, 250, 200, 200, 4, '{low}'),
  ('FAMILY',    'Family rate',                'rates',   null, 250, 200, 200, 0, '{}'),
  ('FRIENDS',   'Friends rate',               'percent', 20,   null,null,null,0, '{}'),
  ('WELCOME',   'Guest rate',                 'percent', 10,   null,null,null,0, '{}')
on conflict (code) do nothing;

-- ── Global settings (min nights, tax rate) ───────────────────
create table if not exists pricing_settings (
  id          int primary key default 1,
  min_nights  int not null default 3,
  tax_rate    numeric(6,4) not null default 0.13,
  updated_at  timestamptz not null default now(),
  constraint single_row check (id = 1)
);

insert into pricing_settings (id, min_nights, tax_rate)
  values (1, 3, 0.13)
on conflict (id) do nothing;

-- ── Row Level Security ───────────────────────────────────────
-- The API uses the service role key, which bypasses RLS. Enabling
-- RLS with no public policy means the browser's anon key can never
-- read or write these tables directly.
alter table pricing_seasons   enable row level security;
alter table pricing_overrides enable row level security;
alter table discount_codes    enable row level security;
alter table pricing_settings  enable row level security;
