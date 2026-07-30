---
type: profile
project: Threads Scrapper
last_updated: 2026-07-29
---
## Core Tech Stack
- Frontend: Web Dashboard (HTML/JS)
- Backend: Node.js, Express
- Infrastructure: Local Node.js runtime / Webhooks

## Hard Engineering Constraints
1. Deduplication module must filter out previously scraped lead IDs.
2. Webhooks must send standard JSON payloads on new lead discovery.

## Internal Memory Index
- Intent Filtering Engine: [[Arch_Intent_Filtering]]
- Express Server Operations: [[Run_Server_Operations]]
