# aimdware

A teaching-team toolkit for monitoring student AI usage in coursework.

Three components:

- **Backend** (Python/FastAPI/Postgres) — stores per-record metadata + sha256 + jbox URI. Holds no prompt/response content.
- **LLM client** (Bun single binary) — runs on the student's machine. OpenAI-compatible local API; forwards to a student-configured upstream (the student's own LLM key, or a ChatGPT/Codex or GitHub Copilot subscription); uploads the response JSON to the student's jbox via a WebDAV PUT to the local Tbox endpoint.
- **Admin script** (`aimdware-admin`, Python CLI) — TT-side tool. Manages users / courses / enrollments / tokens via direct Postgres; fetches blobs from jbox for inspection.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Student's own laptop                          │
│                                                                  │
│   coding agent  ──▶  aimdware router  ──▶  OpenAI / DeepSeek /   │
│   (Cline / Aider /  (student token +          upstream LLM       │
│    OpenCode...)      student's LLM key)                          │
│                          │             │                         │
└──────────────────────────┼─────────────┼─────────────────────────┘
                           │             │ blob (JSON)
       metadata + hash     │             ▼
                           │     ┌──────────────────────┐
                           │     │ Student's jbox       │
                           │     │ (1 TB/student quota) │
                           ▼     └──────────────────────┘
                   ┌────────────────┐
                   │ Backend        │
                   │ (ingest only)  │
                   └────────────────┘
                           ▲
                           │ TT manages via
                           │ aimdware-admin CLI
                           │ + pulls jbox blobs
                           │ with own jaccount
                       TT (admin)
```

Open source and auditable. **Visibility tool**, not enforcement.
Students hold their own LLM credentials and self-host the router; an
adversarial student can bypass it. Course policy treats undisclosed AI
use as an academic-integrity matter — not something the router
prevents. See [Threat model](https://focs.gc.sjtu.edu.cn/git/FOCS-dev/aimdware/wiki/Threat-model).

## Docs

- [Architecture](https://focs.gc.sjtu.edu.cn/git/FOCS-dev/aimdware/wiki/Architecture)
- [Backend](https://focs.gc.sjtu.edu.cn/git/FOCS-dev/aimdware/wiki/Backend)
- [Client](https://focs.gc.sjtu.edu.cn/git/FOCS-dev/aimdware/wiki/LLM-Client)
- [Admin scripts](https://focs.gc.sjtu.edu.cn/git/FOCS-dev/aimdware/wiki/Admin-scripts)
- [Threat model](https://focs.gc.sjtu.edu.cn/git/FOCS-dev/aimdware/wiki/Threat-model)
- [Roadmap](https://focs.gc.sjtu.edu.cn/git/FOCS-dev/aimdware/wiki/Roadmap)
