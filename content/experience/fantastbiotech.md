---
company: FantastBioTech Inc.
role: Full-Stack Developer
location: Remote
dates: 2025 – Present
about: Family business. A small biotech company in China that makes animal feed mixtures for clients around the world, with no marketing team of its own.
order: 1
---

- Built and shipped a full-stack AI social-media content generator end to end (an Express 5 REST API and a React 19 + TypeScript SPA on a Supabase Postgres backend) for a company with no marketing function; the client used it on their real audience and saw a 200% increase in LinkedIn engagement in the first month.
- Designed a session-based Postgres content model and five REST endpoints, and enforced per-user data isolation with Postgres row-level security driven by forwarded JWTs rather than application code.
- Integrated OpenAI's Responses and Images APIs behind a single module with fabrication guardrails and defensive JSON parsing; built a two-stage image pipeline with a two-phase write so an interrupted upload leaves a visible failed row rather than a silent gap, and generated every post bilingually (English + Simplified Chinese) from one model call.
- Cut direct publishing from scope when the client's LinkedIn API access was never authorized and shipped copy-to-clipboard as the deliberate hand-off path instead, a scope decision, not a stopgap.
