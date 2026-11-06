CREATE TABLE IF NOT EXISTS prospects (
  id serial PRIMARY KEY,
  name text NOT NULL,
  phone_raw text,
  wa_id text UNIQUE,
  email text,
  city text,
  province text,
  address text,
  website text,
  source text,
  source_ref text,
  profile_urls jsonb NOT NULL DEFAULT '[]',
  practice_type text NOT NULL DEFAULT 'desconocido',
  tools_signals text,
  fit_notes text,
  attributes jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'encontrado',
  status_reason text,
  needs_attention text,
  handed_off boolean NOT NULL DEFAULT false,
  opener_variant_id int,
  followups_sent int NOT NULL DEFAULT 0,
  evaluation jsonb NOT NULL DEFAULT '{}',
  tags jsonb NOT NULL DEFAULT '{"objections":[]}',
  contacted_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prospects_status_idx ON prospects (status);

CREATE TABLE IF NOT EXISTS messages (
  id serial PRIMARY KEY,
  prospect_id int NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  direction text NOT NULL,
  author text NOT NULL,
  body text NOT NULL,
  wa_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_prospect_idx ON messages (prospect_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_message_id_uniq ON messages (wa_message_id) WHERE wa_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS outbox (
  id serial PRIMARY KEY,
  prospect_id int REFERENCES prospects(id) ON DELETE SET NULL,
  to_wa_id text NOT NULL,
  body text NOT NULL,
  kind text NOT NULL,
  send_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pendiente',
  wa_message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox (status, send_after);

CREATE TABLE IF NOT EXISTS escalations (
  id serial PRIMARY KEY,
  prospect_id int NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text,
  status text NOT NULL DEFAULT 'abierta',
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

CREATE TABLE IF NOT EXISTS faq (
  id serial PRIMARY KEY,
  question text NOT NULL,
  answer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opt_outs (
  wa_id text PRIMARY KEY,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_versions (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  content text NOT NULL,
  source text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opener_variants (
  id serial PRIMARY KEY,
  template text NOT NULL,
  status text NOT NULL,
  proposal_id int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  summary text NOT NULL,
  evidence text NOT NULL,
  proposed_content text NOT NULL,
  target_id int,
  status text NOT NULL DEFAULT 'pendiente',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE TABLE IF NOT EXISTS meetings (
  id serial PRIMARY KEY,
  prospect_id int NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  calendar_event_id text,
  meet_url text,
  status text NOT NULL DEFAULT 'agendada',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id serial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kv (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
