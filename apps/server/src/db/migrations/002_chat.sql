-- The chat's records (plan §7.2, §7.6; docs/phase-5-chat-plan.md): browsers, conversations, every
-- message with what was done about it and what it cost, strikes, handoffs and instant-answer clicks.
-- Transcripts are deleted after 12 months (npm run transcripts -- purge, also run daily by the api).

-- One anonymous browser, identified by the signed cookie the api sets. No login, no name.
create table visitors (
  id uuid primary key,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- The IP address it was created from, scrambled one way with a secret (never the address itself).
  ip_hash text not null,
  -- Strikes since the last lock ended; the third locks the browser for 30 days.
  strikes int not null default 0,
  locked_until timestamptz
);
create index visitors_ip_created on visitors (ip_hash, created_at);

create table conversations (
  id uuid primary key,
  visitor_id uuid not null references visitors (id) on delete cascade,
  started_at timestamptz not null default now(),
  -- The strike check's running note on where this conversation is heading (plan §7.1, step 3).
  risk_note text not null default '',
  -- Small-talk answers given so far; after two, small talk gets the handoff line (plan §7.7).
  small_talk int not null default 0
);
create index conversations_visitor on conversations (visitor_id, started_at);

-- Both sides of the conversation, one row each.
create table messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,
  visitor_id uuid not null references visitors (id) on delete cascade,
  ip_hash text not null,
  role text not null check (role in ('visitor', 'assistant')),
  text text not null,
  -- A visitor's pasted job posting, if any.
  job_post text,
  -- Visitor rows: what the strike check made of it, and what the server did (a ReplyKind).
  category text,
  intent text,
  action text,
  reason text,
  -- Assistant rows: the passages the answer model was given, by passage id.
  passages text[],
  -- What the message's AI calls cost, all of them together (strike check, answer, output check).
  model text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  -- How long each stage took, in milliseconds (plan §7.10): {"strike_check": 512, ...}.
  timings jsonb,
  created_at timestamptz not null default now()
);
create index messages_conversation on messages (conversation_id, id);
create index messages_visitor_time on messages (visitor_id, created_at);
create index messages_ip_time on messages (ip_hash, created_at);
create index messages_time on messages (created_at);

create table strikes (
  id bigserial primary key,
  visitor_id uuid not null references visitors (id) on delete cascade,
  message_id bigint references messages (id) on delete set null,
  category text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  -- Set by npm run strikes -- revoke, for a strike given by mistake.
  revoked_at timestamptz
);
create index strikes_visitor on strikes (visitor_id, created_at);

-- A visitor's details for the real Merlin (plan §7.5).
create table handoffs (
  id bigserial primary key,
  visitor_id uuid references visitors (id) on delete set null,
  conversation_id uuid references conversations (id) on delete set null,
  name text not null,
  company text,
  email text not null,
  role_link text,
  note text not null,
  -- The two-line summary of the conversation written for the email, and what it cost.
  summary text,
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now(),
  emailed_at timestamptz,
  email_error text
);
create index handoffs_visitor_time on handoffs (visitor_id, created_at);

create table instant_clicks (
  id bigserial primary key,
  visitor_id uuid references visitors (id) on delete set null,
  conversation_id uuid references conversations (id) on delete set null,
  instant_id text not null,
  created_at timestamptz not null default now()
);

-- Emails sent to you about the spending cap, at most one a month (plan §7.7).
create table spend_alerts (
  month text primary key,           -- e.g. 2026-10
  sent_at timestamptz not null default now()
);
