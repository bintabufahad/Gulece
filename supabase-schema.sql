-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste all of this → Run).

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  status text not null default 'pending' check (status in ('pending','verified','rejected')),
  has_id boolean not null default false,
  video_path text not null,
  id_path text,
  pending_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists app_users_email_idx on app_users (email);
create index if not exists app_users_pending_token_idx on app_users (pending_token);
create index if not exists app_users_status_idx on app_users (status);

create table if not exists app_sessions (
  token uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists app_sessions_expires_idx on app_sessions (expires_at);

create table if not exists admin_sessions (
  token uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Private buckets for face-verification videos and legal ID documents.
-- "Private" means files are NOT publicly reachable by URL — the server
-- (using the service_role key) generates short-lived signed URLs only
-- for the admin review dashboard.
insert into storage.buckets (id, name, public)
  values ('verification-videos', 'verification-videos', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
  values ('verification-ids', 'verification-ids', false)
  on conflict (id) do nothing;
