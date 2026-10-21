---
name: jobhunt
blurb: Local-first job-search pipeline with anti-fabrication resume tailoring.
dates: 2026 – Present
tech: [Python, FastAPI, SQLite, React, TypeScript]
order: 3
---

- Rebuilt the resume generator to select from a fixed library of pre-approved, human-written bullets instead of rewording a corpus: the model may pick, reorder, and trim, but a word-subsequence check on every trim makes introducing a claim unrepresentable rather than merely rejected, so the output is provably a subset of approved text.
- Cut model spend by rejecting 1,041 of 1,703 discovered postings with deterministic rules before any paid LLM call (61% never reached a model; the 662 that did cost $0.73 total); modeled the application lifecycle as an 11-state machine with append-only event logging, and wrote nightly backups that re-read every stored byte and refuse to prune on a failed verification.
