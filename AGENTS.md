<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project: Allowance (PayPal AI Hackathon 2026)

Start every session by reading `PROGRESS.md`, then the relevant doc in `docs/` (PRD → system design → API → DB).

- The policy engine decides whether money moves; it must never call an LLM.
- Only the transaction service may call PayPal write APIs (authorize, capture, void, refund).
- Money is integer cents, USD only. Never commit `.env` or paste secrets anywhere.
- After finishing a stage or a meaningful piece of work: update `PROGRESS.md` in plain words, then commit with a conventional message (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
