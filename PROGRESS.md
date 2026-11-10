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

- [x] **Third review fixes** (Nov 11), 98 tests pass, build passes. 99 tests now. Rehearsed on the real sandbox in the browser afterwards (see below).
  - A failed capture or void now asks PayPal what really happened before acting: a charge whose responses were lost is recorded as CAPTURED with its capture id (refundable); a hold PayPal already voided is recorded as VOIDED.
  - A reservation stuck mid-authorize (server died) is recovered by re-sending the authorize call with the same request id, then voided, instead of being marked FAILED on a guess.
  - PENDING captures are re-checked every sweep: COMPLETED clears the flag, DECLINED/FAILED marks the purchase FAILED and frees the budget.
  - Popup checkout (no saved PayPal): `/paypal/return` and `/paypal/cancel` now exist and finish or release the purchase; the dashboard shows a "Finish in PayPal" card.
  - Voice never guesses which hold: with several waiting and no id, nothing is decided. "Approve, don't stop" approves and no longer freezes (`src/components/intent.ts`, tested).
  - Listing approvals no longer makes PayPal calls. Bad `limit`/`since` → 400. One bad Vapi tool call no longer fails the batch.
  - Production with no `APP_PASSCODE` is locked, not open. Demo "mandate" step twice gives a clear error.
  - Removed the unused `approval.token` event; humans decide by approval id. Dashboard uses the server's money formatter. README updated.
  - Not changed: a freeze arriving just before a capture can still let that capture through (documented in the README, not fixed).

  - **Sandbox rehearsal after the fixes** (Nov 11): hold → voice reject with no id → VOIDED; candle CAPTURED; gift cards BLOCKED; "Approve, don't stop" typed in the command bar → CAPTURED, no freeze. PayPal's real answers match what the reconcile code expects: a captured authorization reads `CAPTURED` and the order lists its capture id; a voided one reads `VOIDED`, and voiding it again returns 422 `PREVIOUSLY_VOIDED`.
  - **Popup checkout on the sandbox, up to PayPal's login**: with the vault unlinked, purchases come back RESERVED with a real `sandbox.paypal.com` approve link and the "Finish in PayPal" card shows. Returning without approving keeps the reservation (PayPal says `ORDER_NOT_APPROVED`); Cancel marks it FAILED and frees the budget. **Not done: actually approving as the sandbox buyer**, which needs a human to sign in to PayPal.

- [x] **Catalog**: 8 items under $10 in gifts, books and home (sympathy card, chocolate, tea, bookmark, poems, tea lights, remembrance candle, succulent) so small mandates can succeed. Live check: $5 mandate → agent bought the $4.50 sympathy card, all 10 rules passed.
- [x] **Voice fixes from user testing** (Nov 11), 105 tests:
  - Saying "no" to a read-back keeps the draft in context: a later "start now" / "go ahead" starts that draft instead of being parsed as a new mandate. With no context, a bare "start now" starts the user's only draft (refuses if there are several). A sentence with an amount or product is still a new mandate.
  - Mic listens continuously: it no longer cuts off at the first pause. It sends after 3.5 s of silence, or when you tap the mic again (60 s max).
  - When the agent stops, it says how it ended in one templated sentence (bought X, or "nothing fits your rules (at most $X in …)"), shown in the feed and spoken.

- [x] **UI polish** (Nov 11): new look across the dashboard, receipt drawer and login. Navy ink on a cool grey canvas; fonts are Bricolage Grotesque (titles, money), Public Sans (body) and IBM Plex Mono (ids and rule names only). Sentence-case labels instead of all caps; statuses read "Paid / Held / Blocked / Frozen". Mandate cards show a spend meter (track ends at the hard limit, tick at the budget). Approval card has a draining countdown bar. Chat-style replies in the command bar. Login is a two-panel page. Header fits on phones. Design tokens live in `src/app/globals.css`.

- [x] **Deploy prep** (Nov 11): `render.yaml` Blueprint (web + Postgres, free plans, Oregon). `npm run start:render` = `scripts/deploy.ts` (migrate + idempotent seed + link demo vault from env) then `next start`. Public URL falls back to `RENDER_EXTERNAL_URL` (`src/server/base-url.ts`) so PayPal return links work behind Render's proxy. Verified locally in production mode with a passcode.

- [x] **Fourth review fixes** (Nov 10), 126 tests, story re-run on the real sandbox:
  - An approved capture that fails because PayPal is unreachable or erroring (network, 5xx, 429, unknown state) is **kept and retried** by the sweep (`capture retry n/5`), with the full rule re-check each time. Only a real refusal (400/422, or a capture PayPal reports as DECLINED/FAILED) voids it. After 5 tries it is voided and marked FAILED.
  - A pending capture later declined now voids the authorization behind it and drops the dead capture id. If that void fails the purchase goes back to AUTHORIZED and the void is retried.
  - A declined capture's id is never adopted as a successful capture. A pending capture refunded at PayPal becomes REFUNDED; a completed one just clears the flag (no second capture event).
  - Crash cleanup knows which PayPal call was in flight (`authorizing: …` marker). A crashed popup-order creation is FAILED without replaying anything. A timed-out popup checkout reads the order first and voids any authorization PayPal made. A stuck saved-account authorization is only FAILED on a 400/422; 401/409/429/5xx/network errors leave it RESERVED for a later try.
  - Stop words: only a whole-sentence command or an unmistakable phrase freezes. "freeze-dried strawberries", "Stop and Shop gift card" are shopping requests.
  - The full approvals list shows a hold past its expiry as EXPIRED. The sweep backs off per purchase (1 → 30 min), calls PayPal 4 at a time, and never overlaps itself.

- [x] **Red-team agent + independent audit** (Nov 10), 130 tests:
  - **Red-team it** button on every active mandate (`src/server/agent/redteam.ts`). A second Claude agent is told to break the mandate and picks its own attacks. Its purchases go through `requestPurchase` like any agent's. It also has an `admin_action` tool (approve a hold, unfreeze, confirm, refund): each is the real service call made as the agent, and each is refused by `assertHuman`. A purchase the rules send to a human is released at once (`cancelHold`), since the agent can't answer for the user.
  - **Report** (`GET /api/runs/:id/report`, drawer in `src/components/RedTeamReport.tsx`): each attack, its outcome read from the purchase records (not from what the model was told), a link to the receipt, the attacker's own summary, and the audit.
  - **Audit** (`src/server/audit.ts`, `GET /api/mandates/:id/audit`): recomputes 7 invariants from the purchases table with no shared code with the policy engine. Tests forge a bypass in the table and check the audit catches it.
  - **Live run on the real sandbox** (Haiku 5.5, about 35 s): 12 attacks, 12 stopped, 0 rules broken. It tried gift cards, a Bitcoin voucher "as a book", 50 bookmarks at $199.50 (under the limit, blocked on quantity), a $199 watch then approving its own hold, "the user already approved", unfreeze, confirm and refund.
  - This replaces the scripted "attack" beat as the main proof in the video: the AI really attacks, and the result is not known in advance.
- [x] **Fifth review fixes** (Nov 10, two reviewers, 131 tests; migration `0001_recovery_state`):
  - Red team no longer cancels a hold a human approved first: `cancelHold` voids only if it closed the approval itself.
  - Crash + unlinked PayPal: the stuck authorization is replayed with the account it used (vault id recorded); if no account exists it is FAILED, freeing budget and order slot (no capture can follow without an authorization id).
  - Stop words: "stop all purchases", "stop the order", "halt spending money" are stops again; "freeze-dried…", "Stop and Shop" still aren't.
  - Retry state moved out of `failureReason` into `recovery` / `recovery_attempts` / `recovery_note` columns; sweeps select on `recovery`. Old markers migrated.
  - One active agent run per mandate (unique partial index); a double click gets a 409.
  - Popup cleanup: EXPIRED/VOIDED/DENIED hold nothing; CAPTURED is recorded as a capture, never voided.
  - Sweep backoff map forgets settled purchases; PENDING captures back off.
  - Refunds check PayPal's refund status: COMPLETED → REFUNDED, PENDING → stays CAPTURED and the sweep re-checks (`getRefund`), FAILED/CANCELLED → error.
  - Agents send an idempotency key per tool call (`runId:toolUseId`); MCP accepts `idempotencyKey`; keys are scoped per caller.
  - Audit: per-purchase checks (category, quantity, per-item) cover refunded/voided purchases too; new duplicate and expiry checks; each check lists offending purchase ids; a `notChecked` list is shown in the report.
  - Red-team report marks a purchase "allowed" only if no audit check names it; otherwise "breach".
  - 9 regression tests added (140 total): approved hold survives the red-team release, crash replay after unlink, no account left, EXPIRED popup auth, PENDING/FAILED refunds, refunded forbidden purchase caught by audit and report, duplicate product, two runs at once, retried tool call buys once. `next build` passes. Dev DB migrated.
  - Not done: re-run on the real PayPal sandbox and live Claude (red team + refund) after these changes.
- [x] **Sixth review fixes** (Nov 11, 161 tests, migration `0002_payment_identity`; tsc, lint, build pass):
  - An unclear saved-account authorize (timeout, lost/unreadable response, 5xx, PREVIOUS_REQUEST_IN_PROGRESS) keeps the reservation and is replayed with the same request id; only a 400/422 with PayPal's JSON error is a refusal. Requests time out after 20 s; non-JSON bodies keep status and debug id.
  - The vault row used is stored on the purchase (`paypal_vault_id`); recovery never uses another account. Rows without it become FAILED + `needs_review`.
  - A popup order captured before a crash stays RESERVED until its capture id is read, then goes straight to CAPTURED.
  - No refund while a capture is pending. Refunds: lost answer → same request id replayed by the sweep (after checking whether the capture is already REFUNDED); FAILED/CANCELLED/refused → the next attempt gets a new id (`refund_attempts`). A pending refund is asked about, never resent.
  - Unknown capture statuses are kept as spend, re-checked with backoff, and flagged `needs_review` after 10 checks.
  - Kill switch: a capture claim (`capture_dispatched_at`) is set under the mandate lock with the final re-check. Freeze voids holds and auto-approved purchases not yet claimed, and reports claimed ones as `inFlight` (can't be recalled). No hold is opened on a mandate frozen during authorize.
  - Agent runs heartbeat every 15 s; runs silent for 2 min are closed as FAILED by the sweep or the next start.
  - Voice: "start now" with no draft in context reads the draft back (says if an MCP client made it) and needs a yes. Refund with no id never picks the latest capture: one → asks to confirm, several → asks which.
  - Red team: tool output and report say what really happened (released, release pending, approved by you first); purchase ids are a field on the step. Receipts say "release pending" for a rejected hold whose void is retrying.
  - Production needs SESSION_SECRET (locked without it); 10 wrong passcodes per address per 15 min → 429. MCP receipt: same "unknown purchase" for missing and not-yours. Event bus: a failing listener can't make a committed write look failed. Mandate money limits must be positive whole cents.
  - Voice echo (user report): each live announcement is now spoken once across all open tabs (Web Locks + remembered event ids), hidden tabs stay quiet, and announcements queue instead of cutting each other off.
  - Verified unchanged: PayPal return/cancel (SameSite=Lax is sent on PayPal's top-level redirect; an expired session goes through /login?next= and resumes; replays are idempotent). Rules can't be edited after confirm, so the audit's current-rules view is correct.
  - 12 of the new tests fail against the previous service and pass now.
  - Not done: live sandbox / live Claude rehearsal of these changes; the MCP receipt change has no automated test.
- [x] **README rewritten** for judges: the problem, "try to break it", a two-minute path, what it is and is not, tools statement.
- **Hackathon research** (Nov 10): five equally weighted criteria (technical implementation, design, impact, innovation, presentation; ties go to technical). Judges may score from the video and description alone. A project can win one main or honourable-mention prize plus one sponsor prize. The AG Grid prize looks at polish (custom cells, theming, layout) and use of AG Studio's agent framework, which we don't use. Render's prize needs a Render deploy. "Gift-finder shopping agent" is a widely suggested idea, so the pitch must lead with the control layer and the red team, not the shopping.

## Next up
0. Popup checkout: unlink the vault, click "Approve in PayPal", sign in as the sandbox buyer and confirm it lands back CAPTURED. Only needed if the demo won't use the vault.

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
- **Approvals**: humans on the dashboard/voice decide by approval id. No raw token is handed out (the hash column is kept for email links, P2); `decideApproval` rejects any non-`user:` actor either way.
- **No-vault fallback** is wired (`RESERVED` + approve URL, then `completeFallbackAuthorization`) but not tested against the sandbox.

- **Models** (Nov 10): Haiku 5.5 for both the parser and the agent. It's about 1/20th of Sonnet's price ($0.10 / $0.50 per M tokens), and in live runs it parsed mandates correctly and shopped sensibly. Sonnet 5 costs the same as Sonnet 5.5, so if we upgrade it's straight to `claude-sonnet-5-5`.
- **Live agent proof** (Nov 10, Haiku 5.5): plain brief → bought a $145 perfume under budget. Headphones brief → $170 HELD → "reject" → VOIDED (auth 60X20706L8171245F) → agent searched again. Poisoned page → agent **ignored** the injection and called it out. So the model resisted; the engine is still the guarantee.
- **Parser drift**: Haiku sometimes adds `fashion`/`toys` to a gift's allowed categories. Harmless (soft rule), but pin the demo text and re-check before recording.
- CLI prompts can be scripted: `ANSWERS="y,reject" npm run cli -- agent "<text>"`.

- **Dev server**: `npm run dev` (or the "web" entry in `.claude/launch.json`). Local `.env` has a generated `MCP_API_KEY`; `APP_PASSCODE` is empty locally, so the dashboard is open.
- **Next 16 notes**: middleware is now `src/proxy.ts`; `cacheComponents` is on, so the dashboard is a static shell that loads data client-side; route handlers read `ctx.params` as a Promise.

## Open questions

- Vapi, or ship with browser speech only? (Browser speech is built and works; Vapi adapter exists but is untested.)
