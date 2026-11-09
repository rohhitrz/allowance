# Progress

Plain-English log of where the build stands. **Update this after every stage.** A new agent or session should read this first, then `docs/`.

Deadline: submit by **Thu 12 Nov, 10 PM IST** (hard close Fri 13 Nov, 1:30 AM IST).

## Current stage

**Stage 2: Core engine (Tue 10 Nov)**: DONE ✓. Scripted story and the live Claude agent both work from the terminal on the real PayPal sandbox.
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
  - Shopping agent (`src/server/agent/runner.ts`): Claude Haiku 5.5 by default (`AGENT_MODEL` env to switch), tools `search_catalog`, `get_product`, `request_purchase` only, max 8 steps, waits on holds, stops when frozen. Server-side refusal fallback is on only for Sonnet/Opus (Haiku doesn't support it).
  - Receipts (`src/server/receipts.ts`): purchase + rule results + rules snapshot + event timeline + template summary.
  - Tests: 49 pass (`npm test`). Engine table tests, defaults/read-back, and DB integration tests with a fake PayPal: full story, approve, unclear = reject, expiry, kill switch, version bump, **parallel race can't beat the hard limit**, refund frees budget, the DB CHECKs.
  - Terminal: `npm run cli -- story` runs the video story on the real sandbox (see below).

- [x] **Code review fixes** (Nov 10, all 10 findings verified and fixed, 13 regression tests, 62 total):
  - A capture PayPal confirmed is never marked FAILED: the capture call retries once with the same request id, then the DB write retries; worst case the capture id is logged for a manual refund.
  - Abandoned no-vault popups release after 10 minutes (and at once via `cancelFallbackPurchase`); a vault authorization stuck RESERVED releases after 2 minutes.
  - Failed voids stay AUTHORIZED/HELD with `void failed:` and the 60-second sweep (`sweepExpiredApprovals`, wired in `src/instrumentation.ts`) retries them, along with HELD purchases whose approval is closed.
  - An authorization PayPal creates as anything but CREATED is voided, never captured.
  - Idempotency key conflicts are resolved inside the transaction; parallel retries make one purchase.
  - An allowed-category list that's entirely blocked is refused; an empty list now means "nothing allowed", never "anything".
  - Events (and the approval token) reach live listeners only after their transaction commits (`inTransaction` in `events/bus.ts`).
  - Both re-checks (auto-approve and human approve) run the full policy engine with the mandate row locked.
  - AGENTS.md now scopes the PayPal-writes rule to app code; `scripts/paypal-spike.ts` is the labelled exception.
  - Known small window: a freeze landing between the auto-approve re-check and the capture call can still capture that one purchase.
- [x] **Second review (Cursor) fixes** (Nov 10, 67 tests):
  - Capture status is checked: only COMPLETED (or PENDING, flagged on the receipt) counts; DECLINED/FAILED are voided and marked FAILED. The real sandbox returns COMPLETED.
  - The agent settles a hold itself after waiting (expired → voided), so the CLI doesn't depend on the server's 60-second sweep.
  - Repeating a decision finishes a void PayPal didn't confirm the first time.
  - `npm run cli -- story` is fully scripted (fixed mandate) even with a Claude key; `--claude` opts in to live parsing. Beat 4 is labelled an attack test: a compromised agent, not a live model exploit.
  - Heads-up: the Stage 3 session shares the dev and test databases; run the story and tests when it isn't using them.

## Next up

1. Decide how the video shows the attack: Haiku ignores the poisoned page, so the "agent tries gift cards" beat needs the scripted path (`npm run cli -- story`, later `/api/demo/script`).
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

- **Models** (Nov 10): Haiku 5.5 for both the parser and the agent. It's about 1/20th of Sonnet's price ($0.10 / $0.50 per M tokens), and in live runs it parsed mandates correctly and shopped sensibly. Sonnet 5 costs the same as Sonnet 5.5, so if we upgrade it's straight to `claude-sonnet-5-5`.
- **Live agent proof** (Nov 10, Haiku 5.5): plain brief → bought a $145 perfume under budget. Headphones brief → $170 HELD → "reject" → VOIDED (auth 60X20706L8171245F) → agent searched again. Poisoned page → agent **ignored** the injection and called it out. So the model resisted; the engine is still the guarantee.
- **Parser drift**: Haiku sometimes adds `fashion`/`toys` to a gift's allowed categories. Harmless (soft rule), but pin the demo text and re-check before recording.
- CLI prompts can be scripted: `ANSWERS="y,reject" npm run cli -- agent "<text>"`.

## Open questions

- Vapi or ElevenLabs for voice?
