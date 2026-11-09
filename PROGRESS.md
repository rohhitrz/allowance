# Progress

Plain-English log of where the build stands. **Update this after every stage.** A new agent or session should read this first, then `docs/`.

Deadline: submit by **Thu 12 Nov, 10 PM IST** (hard close Fri 13 Nov, 1:30 AM IST).

## Current stage

**Stage 2: Core engine (Tue 10 Nov)**: built. Scripted story passes from the terminal on the real PayPal sandbox. **Still to check: the Claude parts (mandate parser, shopping agent) haven't run live, because there's no `ANTHROPIC_API_KEY` yet.**
- Put the key in `.env`, then run `npm run cli -- parse "..."` and `npm run cli -- agent`. Expect small fixes there.
- Stage 1 gate PASSED on Nov 10: Vault + authorize/capture/void/refund all work in sandbox with no buyer popup.

## Done

- [x] Idea locked: Allowance, a spending-permission layer for AI agents (see `docs/01-PRD.md`)
- [x] Docs approved: PRD, system design, API design, DB design (`docs/`)
- [x] Next.js 16 app scaffolded, MIT license, `.env.example`
- [x] PayPal client (`src/server/paypal/client.ts`) and spike script (`scripts/paypal-spike.ts`)
- [x] Public repo: https://github.com/rohhitrz/allowance (MIT)
- [x] **PayPal spike passed**: Vault (save buyer's PayPal once), then authorize → capture → refund, and authorize → void, all without a popup
- [x] **Stage 2 core engine** (Nov 10):
  - DB: Drizzle schema for all 11 tables (`src/server/db/schema.ts`), migration in `drizzle/`. Postgres CHECKs enforce: gift cards/crypto/cash equivalents can't be unblocked, hard limit ≥ budget, a BLOCKED purchase never called PayPal.
  - Seed: ~36 products incl. $170 headphones, $89.99 candle set, gift cards, and the poisoned "Artisan Tea Sampler Gift Box"; demo user; ACTIVE "Weekly groceries" mandate; the spike's vault id linked from `.spike-state.json`.
  - Policy engine (`src/server/policy/engine.ts`): pure function, all 10 rules always evaluated, hard → BLOCK, soft → HOLD. Weekly/monthly windows in the mandate's timezone (`period.ts`).
  - Mandates: Claude Haiku 5.5 parses text with structured output; code applies defaults and the locked categories; template read-back sentence; confirm / cancel / unfreeze (version + 1) with a snapshot per version.
  - Transaction service (`src/server/transactions/service.ts`), the only PayPal writer: lock mandate row → engine → insert purchase in one DB transaction; authorize; capture after re-check, or hold with a 10-minute single-use approval; void; refund; expiry sweep; kill switch. Every status change is compare-and-set.
  - Shopping agent (`src/server/agent/runner.ts`): Claude Sonnet 5.5, tools `search_catalog`, `get_product`, `request_purchase` only, max 8 steps, waits on holds, stops when frozen. Uses Claude's server-side refusal fallback (`fallbacks: "default"`).
  - Receipts (`src/server/receipts.ts`): purchase + rule results + rules snapshot + event timeline + template summary.
  - Tests: 49 pass (`npm test`). Engine table tests, defaults/read-back, and DB integration tests with a fake PayPal: full story, approve, unclear = reject, expiry, kill switch, version bump, **parallel race can't beat the hard limit**, refund frees budget, the DB CHECKs.
  - Terminal: `npm run cli -- story` runs the video story on the real sandbox (see below).

## Next up

1. Add `ANTHROPIC_API_KEY` to `.env`; run the live parser and agent (`npm run cli -- agent`), fix what breaks. Check the agent actually falls for the poisoned page (the prompt is deliberately not hardened).
2. Stage 3: API routes (REST per `docs/03-api-design.md`), SSE, dashboard, AG Grid ledger, kill switch button, voice.
3. Pick the voice platform (Vapi vs ElevenLabs): check free credits.
4. Set up Render (web service + Postgres); run `npm run db:migrate` and seed on deploy.

## Stages

| # | Stage | When | Status |
| --- | --- | --- | --- |
| 1 | Prove PayPal: repo, license, spike | Mon night | Done ✓ |
| 2 | Core engine: DB schema, mandate parser, policy engine + tests, transaction service, shopping agent, seed catalog | Tue | Built; scripted story passes; Claude parts need a live run |
| 3 | Product + voice: dashboard, AG Grid ledger, receipts, kill switch, in-app voice; then MCP, refunds | Wed (freeze 10 PM) | Not started |
| 4 | Ship: fixes, video, README, submission | Thu | Not started |

## Decisions and findings

- Agents propose, code decides: the policy engine has no LLM; hard-rule breaks never reach PayPal.
- USD only, amounts in integer cents.
- Sponsor prize target: AG Grid (receipts ledger).
- **PayPal sandbox setup that works** (learned the hard way):
  - Default sandbox accounts are India accounts → USD checkout and Vault are refused. Use a **US sandbox business account** and a **US sandbox personal buyer**.
  - The app must have **Save payment methods** ticked **before its keys are first used**. PayPal caches an app's access token (~9 h), so ticking it later doesn't take effect until the token expires. Fix: make a fresh app.
  - Current app in `.env`: "Allowance Vault" (US business). Vaulted buyer saved in `.spike-state.json` (gitignored).
  - Spike proof (Nov 10): vault id issued; $89.99 authorize → capture → refund ✓; $170 authorize → void ✓.

- **Local dev DB**: Docker container `allowance-pg` (Postgres 17) on port 5433. Dev DB `allowance`, test DB `allowance_test`. Start it with `docker start allowance-pg`. Commands: `npm run db:migrate`, `npm run cli -- reset`, `npm test`.
- **Terminal story proof** (Nov 10, real sandbox): $170 headphones HELD (auth 1V525131XJ023835G) → reject → VOIDED; $89.99 candle set CAPTURED (capture 3AF939117P8366344); 5 × $100 gift cards BLOCKED by 4 hard rules, PayPal never called; kill switch froze 2 mandates and the retry was BLOCKED.
- **Approval tokens**: only the token's hash is stored. The raw token is emitted on the in-memory bus (`approval.token`) for human channels, never to the agent. Humans on the dashboard/voice can also decide by approval id; `decideApproval` rejects any non-`user:` actor either way.
- **No-vault fallback** is wired (`RESERVED` + approve URL, then `completeFallbackAuthorization`) but not tested against the sandbox.

## Open questions

- Vapi or ElevenLabs for voice?
