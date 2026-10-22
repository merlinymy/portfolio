-- The chat's search passages (docs/phase-4-knowledge-plan.md). `npm run ingest` replaces them all
-- in one transaction whenever content/ or knowledge/extra/ changes.
create extension if not exists vector;

create table passages (
  id text primary key,                -- the file and the piece of it, e.g. projects/arc.md#bullet-3
  source text not null,               -- the file, relative to content/ (or extra/<file> for private notes)
  title text not null,                -- what it's about, e.g. ARC (PaperPrism)
  kind text not null,                 -- facts, summary, tech, paragraph, bullet, skills, instant, note
  body text not null,                 -- the text the answer model is shown
  embedding vector(1024) not null,    -- Qwen3-Embedding-0.6B's numbers for the body
  model text not null,                -- the embedding model that made them
  -- Keyword search: the words of the title and body, reduced to their stems ("indexing" -> "index").
  terms tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored,
  loaded_at timestamptz not null default now()
);

create index passages_terms on passages using gin (terms);
