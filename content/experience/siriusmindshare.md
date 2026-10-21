---
company: SiriusMindShare
role: Software Engineer
dates: 2022 – 2023
order: 2
---

- Migrated and rebranded a large inherited enterprise ML codebase to the company's product line, renaming packages, modules, configs, and Oracle database schemas across the repo, rebuilding Python wheel packages, and updating the build and deploy scripts.
- Got a complex legacy ML service building in Docker by resolving deep dependency conflicts across TensorFlow, turicreate, mxnet, and numpy (pinning Python 3.6) and moving to a multi-stage Docker build.
- Deployed the platform to AWS EC2 end to end (provisioning instances, containerizing with Docker, and configuring nginx as a reverse proxy with HTTPS) and resolved CORS failures by reconfiguring nginx headers and proxy rules.
- Built a full-stack CSV upload feature (Angular front end + Python/Oracle backend) that upserts records on a user-defined composite key, using parameterized SQL to prevent injection and correctly handle special characters.
- Contributed to an email subject-line scoring app returning classification, regression, and key-phrase insights, building the Angular UI and wiring it to the Python prediction API.
