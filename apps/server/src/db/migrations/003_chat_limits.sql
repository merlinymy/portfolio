-- Limits that follow a browser or an IP address instead of one conversation (security review of
-- phase 5): small talk counted per browser over a day, and each handoff's address, so one address's
-- AI spending can be added up (messages already carry theirs).

-- One row per approved small-talk answer given, so "2 in a day" can't be reset by starting over.
create table small_talk_uses (
  id bigserial primary key,
  visitor_id uuid not null references visitors (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index small_talk_uses_visitor on small_talk_uses (visitor_id, created_at);

-- The IP address (scrambled, as in messages) a handoff was sent from; null for older handoffs.
alter table handoffs add column ip_hash text;
create index handoffs_ip_time on handoffs (ip_hash, created_at);
