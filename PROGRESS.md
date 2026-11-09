# Progress

Plain-English log of where the build stands. **Update this after every stage.** A new agent or session should read this first, then `docs/`.

Deadline: submit by **Thu 12 Nov, 10 PM IST** (hard close Fri 13 Nov, 1:30 AM IST).

## Current stage

**Stage 3: Product + voice (Wed 11 Nov)**: core built and tested in the browser on the real PayPal sandbox. Left: Vapi (or stay on browser speech), Render deploy, and polish.
- Stage 2 (core engine) DONE ✓. Stage 1 (PayPal spike) DONE ✓.

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

- [x] **Stage 3 product** (Nov 10–11):
  - **REST API** (`src/app/api/**`), per `docs/03-api-design.md`: session, health, mandates (create / confirm+start agent / cancel / unfreeze / runs), freeze-all, runs (get / stop), purchases (list / get / create / receipt / refund / fallback authorize), approvals (list / decide by approval id or token), catalog, events, PayPal vault (status / setup / return), demo reset + scripted beats. One error shape; zod bodies. Not built: `PATCH /api/mandates/:id` (edit a draft) and `Idempotency-Key` on decision/refund (both already idempotent by state).
  - **Live updates**: SSE at `/api/events/stream` from the in-memory bus, 15 s heartbeat, replays from `Last-Event-ID`. The bus is per process: events from `npm run cli` don't reach an open dashboard (refresh it).
  - **Auth** (`src/server/http/auth.ts`): passcode → signed httpOnly cookie (dashboard open if `APP_PASSCODE` is unset); `x-vapi-secret` for Vapi; bearer `MCP_API_KEY` for MCP. Page guard in `src/proxy.ts` (Next 16's renamed middleware). Login at `/login`.
  - **Dashboard** (`src/components/`): command bar with push-to-talk, approval card with countdown, mandate cards (spend bar, budget marker, confirm / run agent / stop / cancel / unfreeze), **AG Grid ledger** (status chips, failed-rule pills, PayPal ids, quick filter, stat tiles; rows upserted live with `applyTransaction`), receipt drawer (summary, all 10 rules, PayPal ids, mandate snapshot, timeline, refund button), live activity feed, kill switch, "Link PayPal", demo-script menu.
  - **Voice**: browser `SpeechRecognition` + `speechSynthesis` → `/api/voice/local`, recorded as `user:voice`. Routing is deterministic: after a question, the next answer is that answer; only "approve" approves, anything else rejects. New holds are read out automatically from the stored template. `/api/voice/tools` is the Vapi adapter on the same handlers (`src/server/voice/tools.ts`), untested against Vapi.
  - **MCP** (`/api/mcp`, stateless streamable HTTP): create_mandate (draft only), list_mandates, get_mandate, search_catalog, request_purchase, get_receipt, freeze_all. A client sees its own mandates plus the shared grocery mandate.
  - **Background sweep** (`src/instrumentation.ts`): every 60 s, expire stale holds (void) and past-date mandates.
  - **Browser proof** (Nov 10 night, real sandbox): scripted beats from the UI: hold → "reject" typed in the command bar → VOIDED; candle CAPTURED; 5 gift cards BLOCKED (receipt: 4 hard rules, "PayPal never called"); kill switch froze 2 mandates, retry BLOCKED; refund from the receipt drawer → REFUNDED, spend back to $0. Live Claude: typed a housewarming mandate → read-back → "yes" → agent bought a $45 herb garden kit. API: hold → approve → CAPTURED; repeat decision is a no-op. MCP via curl: unauthenticated → 401; tools/list; bought 2 × coffee beans on the grocery mandate → CAPTURED, and it appeared live in the open dashboard.
  - Tests: 70 pass (adds auth tests). `next build` passes.

## Next up

1. Deploy to Render (web service + Postgres): set `APP_PASSCODE`, `MCP_API_KEY`, `APP_BASE_URL`, `PAYPAL_DEMO_VAULT_ID` (+ email); run `npm run db:migrate` then a demo reset on deploy. Test in a private window.
2. Voice: decide Vapi vs staying on browser speech. Browser speech works now in Chrome (needs mic permission). If Vapi: create the assistant with `VAPI_TOOL_DEFS`, point it at `/api/voice/tools`, set `VAPI_WEBHOOK_SECRET`.
3. Connect Claude Desktop to `/api/mcp` with the bearer key for the video's MCP beat.
4. Video attack beat: use the demo-script menu ("4 · Injection: 5 gift cards"), since Haiku ignores the poisoned page.
5. Polish if time: mobile layout of the ledger, `PATCH /api/mandates/:id`.

## Stages

| # | Stage | When | Status |
| --- | --- | --- | --- |
| 1 | Prove PayPal: repo, license, spike | Mon night | Done ✓ |
| 2 | Core engine: DB schema, mandate parser, policy engine + tests, transaction service, shopping agent, seed catalog | Tue | Done ✓ |
| 3 | Product + voice: dashboard, AG Grid ledger, receipts, kill switch, in-app voice; then MCP, refunds | Wed (freeze 10 PM) | Built + browser-tested; deploy and Vapi left |
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

- **Dev server**: `npm run dev` (or the "web" entry in `.claude/launch.json`). Local `.env` has a generated `MCP_API_KEY`; `APP_PASSCODE` is empty locally, so the dashboard is open.
- **Next 16 notes**: middleware is now `src/proxy.ts`; `cacheComponents` is on, so the dashboard is a static shell that loads data client-side; route handlers read `ctx.params` as a Promise.

## Open questions

- Vapi, or ship with browser speech only? (Browser speech is built and works; Vapi adapter exists but is untested.)
