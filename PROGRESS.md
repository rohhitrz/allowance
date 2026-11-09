# Progress

Plain-English log of where the build stands. **Update this after every stage.** A new agent or session should read this first, then `docs/`.

Deadline: submit by **Thu 12 Nov, 10 PM IST** (hard close Fri 13 Nov, 1:30 AM IST).

## Current stage

**Stage 2: Core engine (Tue 10 Nov)**: not started.
- Stage 1 gate PASSED on Nov 10: Vault + authorize/capture/void/refund all work in sandbox with no buyer popup.

## Done

- [x] Idea locked: Allowance, a spending-permission layer for AI agents (see `docs/01-PRD.md`)
- [x] Docs approved: PRD, system design, API design, DB design (`docs/`)
- [x] Next.js 16 app scaffolded, MIT license, `.env.example`
- [x] PayPal client (`src/server/paypal/client.ts`) and spike script (`scripts/paypal-spike.ts`)
- [x] Public repo: https://github.com/rohhitrz/allowance (MIT)
- [x] **PayPal spike passed**: Vault (save buyer's PayPal once), then authorize → capture → refund, and authorize → void, all without a popup

## Next up

1. Stage 2: DB schema (Drizzle) + seed, policy engine + tests, mandate parser, transaction service, shopping agent.
2. Pick the voice platform (Vapi vs ElevenLabs): check free credits.
3. Set up Render (web service + Postgres).

## Stages

| # | Stage | When | Status |
| --- | --- | --- | --- |
| 1 | Prove PayPal: repo, license, spike | Mon night | Done ✓ |
| 2 | Core engine: DB schema, mandate parser, policy engine + tests, transaction service, shopping agent, seed catalog | Tue | Not started |
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

## Open questions

- Vapi or ElevenLabs for voice?
