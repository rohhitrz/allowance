# Progress

Plain-English log of where the build stands. **Update this after every stage.** A new agent or session should read this first, then `docs/`.

Deadline: submit by **Thu 12 Nov, 10 PM IST** (hard close Fri 13 Nov, 1:30 AM IST).

## Current stage

**Stage 1: Prove PayPal (Mon 9 Nov night)**
- Gate: the PayPal sandbox spike passes (`npm run spike -- run`), or we decide on the popup fallback.
- Blocked on: Rohit adding sandbox keys to `.env` and approving the Vault URL as the sandbox buyer.

## Done

- [x] Idea locked: Allowance, a spending-permission layer for AI agents (see `docs/01-PRD.md`)
- [x] Docs approved: PRD, system design, API design, DB design (`docs/`)
- [x] Next.js 16 app scaffolded, MIT license, `.env.example`
- [x] PayPal client (`src/server/paypal/client.ts`) and spike script (`scripts/paypal-spike.ts`)
- [x] Public repo: https://github.com/rohhitrz/allowance (MIT)

## Next up

1. Run the spike: `check` → `setup` (approve URL as buyer) → `token` → `run`. Write the result below.
2. Pick the voice platform (Vapi vs ElevenLabs): check free credits.
3. Set up Render (web service + Postgres).

## Stages

| # | Stage | When | Status |
| --- | --- | --- | --- |
| 1 | Prove PayPal: repo, license, spike | Mon night | In progress |
| 2 | Core engine: DB schema, mandate parser, policy engine + tests, transaction service, shopping agent, seed catalog | Tue | Not started |
| 3 | Product + voice: dashboard, AG Grid ledger, receipts, kill switch, in-app voice; then MCP, refunds | Wed (freeze 10 PM) | Not started |
| 4 | Ship: fixes, video, README, submission | Thu | Not started |

## Decisions and findings

- Agents propose, code decides: the policy engine has no LLM; hard-rule breaks never reach PayPal.
- USD only, amounts in integer cents.
- Sponsor prize target: AG Grid (receipts ledger).
- Spike result: _not run yet_

## Open questions

- Does Vault (save PayPal, then authorize with `vault_id`) work in our sandbox app?
- Vapi or ElevenLabs for voice?
