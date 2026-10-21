---
name: ARC (PaperPrism)
blurb: Retrieval-augmented Q&A over a researcher's library of about 10,000 scientific papers, checking every citation against its source.
dates: 2025 – Present
tech: [Python, FastAPI, React, Qdrant, Claude, Voyage, Cohere, Docker, Cloudflare Tunnel]
order: 1
---

- Supported a postdoctoral biochemistry researcher's grant drafting: he used it to pull key data and find gaps in the literature across his roughly 10,000-paper library while writing a Burroughs Wellcome Fund proposal that was awarded $500,000.
- Architected the pipeline to index each paper as six representations and verify every citation against its source chunk; in a blind A/B over a 20-paper evaluation corpus it beat direct Claude on 11 of 15 questions.
- Audited the live index after the researcher reported wrong citations: counting chunk types straight out of Qdrant showed 93,144 caption chunks (44% of the index) and zero table chunks, traced to two extraction bugs; validated the fixes by re-running old and new extraction side by side on real papers.
- Diagnosed a memory leak that grew a long-running service to 30 GB, traced ~90% to ML models being reloaded on every upload, and fixed six sources (processor singleton, executor lifecycle, shared streaming executor, LRU context cap, rate-limiter eviction); the server then ran a full month of continuous use without recurrence.
- Traced upload serialization that hung three concurrent users past 600 seconds to a global tqdm monkey-patch, and fixed it with thread-local hooks, checkpoint locking (RLock), and per-user round-robin queuing, verified end to end under load.
- Built the system with AI agent workflows in Claude Code: defined the architecture and guardrails up front, reviewed agent plans before implementation, and gated changes on side-by-side accuracy experiments.
- Presented as a research poster, "Paper Prism: A Query-Adaptive RAG Pipeline for Scientific Literature," at a Northeastern University research showcase.
