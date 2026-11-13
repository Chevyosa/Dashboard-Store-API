> **CATATAN (repo publik):** nama konsinyor dan angka keuangan asli sudah disamarkan (`Konsinyor A/B`, `Rp[X]`). Salinan lengkap disimpan privat di luar git (arsip migrasi VPS) dan dibawa lewat scp, bukan lewat GitHub.

# Store Liquidity & Restock Safety Implementation Plan

> **For Claude Code:** Implement only after Riyanda explicitly approves this plan. Work on the existing repositories/branches without deploying or running migrations against production.

**Goal:** Make the Store Dashboard show a reliable, auditable liquid balance and safe-to-withdraw amount that accounts for paid stock purchases, consignor payouts, owner withdrawals, and the Rp300,000 minimum reserve.

**Architecture:** Keep weekly sales/opname and inventory valuation calculations intact, but separate them from actual liquidity. Add a minimal, append-only cash movement ledger with an opening-balance cutover and idempotent links to finalized opnames, stock-purchase payments, consignor payments, and take-profit withdrawals. Calculate withdrawable funds from actual liquid balance less the reserve and any unpaid/committed obligations; do not deduct paid obligations twice.

**Tech Stack:** Express 5 + TypeScript + MySQL 8 backend, Next.js 16 + React 19 frontend, existing Vitest tests and SQL migrations.

---

## Confirmed business rules and current context

- Latest production opname: 2026-11-06, final. Turnover Rp[X]; cash received Rp[X]; QRIS received Rp[X]; real receipts Rp[X]; cash difference +Rp[X]; payout due Rp[X]; Profit B -Rp[X].
- Production payment data now includes Konsinyor A payout Rp[X], dated 2026-11-08, by transfer. Its `opname_id` is NULL. Aggregate recorded payout totals currently equal accrued payouts for Konsinyor A (Rp[X] paid/accrued) and Konsinyor B (Rp[X] paid/accrued); verify through ordinary read-only queries before any data correction.
- The user confirms Rp[X] stock purchase on 2026-11-04 is the approximately-Rp[X] purchase paid from that week's receipts. Do not create a duplicate purchase.
- A second own-stock purchase of Rp[X] on 2026-11-02 was paid from funds already held before that week.
- Current combined liquid balance (cash + available bank/QRIS funds) is Rp[X]. Treat this as the opening balance at cutover, after all pre-cutover transactions. Do not replay historical opname/purchase/payout/withdrawal rows into the new ledger.
- Minimum working capital means at least Rp300,000 of liquid money remaining after actual outflows. Inventory value does not count toward that liquid reserve.
- Scope is a minimal cashflow/liquidity ledger, not a full accounting package: no general operating-expense module or multi-account reconciliation in this change. The opening balance and subsequent movements use one combined liquid-funds pool.
- The user is planning restock. Before new restock, the availability display must not imply money is safe to spend/withdraw if the reserve would be breached.
- No full live dump is needed. Production was inspected with read-only queries; do not expose production credentials or give Claude unrestricted production DB access.

## Important current implementation findings

- `backend/src/services/take-profit.service.ts` calculates raw balance from latest opname `realCash`, total payout allocation, minimum working capital, and withdrawals. It does not include stock-purchase cash payments or an opening liquid balance.
- `backend/src/domain/profit.ts` separately calculates period Profit B as `realCash - totalPayoutDue - modalBelanjaOwn`. Do not conflate this period profitability metric with the cash ledger/withdrawable balance.
- `backend/tests/integration/take-profit.test.ts` explicitly expects available-to-withdraw to remain unchanged when a consignor payout is paid; revise this contract to match the new actual-liquidity definition.
- `stock_ins` / `stock_in_lines` represent receipt and inventory cost, but do not record whether/how much of a purchase has actually been paid or its payment date. Stock receipt date and payment date must remain distinct.
- Current production purchases linked to opname 3: Rp[X] (Nov 2) and Rp[X] (Nov 4). Their historical cash impact is already included in the user-confirmed Rp[X] cutover balance; do not deduct these again.
- Frontend take-profit screen currently labels the available amount as “keuntungan murni” and claims payouts/reserve are already safely set aside. Update labels/help text to distinguish profit from liquid funds available for withdrawal/restock.
- Backend remote is `Chevyosa/Dashboard-Store-API`; user has now merged `dev-master` into `master`. At this deployment preflight, `origin/master` is `120430ceb02fdcc90a6bb3a276d71a04aa19b3e7` (`Merge pull request #1 from Chevyosa/dev-master`) and `origin/dev-master` remains `f2e95d1812f1d7077c6af8fffea0a6bad8d2032c`. A clean, separate master checkout is staged at `/home/chevyosa/releases/store-backend-120430ceb`; it must remain separate from the live/dev checkout.
- Frontend remote is `Chevyosa/Dashboard-Store`; local checkout HEAD is `ae0cea77bd1c80c37afb601b453e9c8c8f270d13`, while live `origin/dev-master` is `820ea274c0003677a727f6419496f7a71de2803d`. The host checkout is behind remote dev-master; synchronize/reconcile before Claude edits frontend files. Remote HEAD/default points to `master`; production branch `master` is user-confirmed. Production frontend is Vercel, not a PM2 process on this host. The user's chosen activation is local pull + GitHub Desktop merge to `master`; Claude must not merge/push `master`.
- Live PM2 process `store-backend` runs `dist/index.js` from `/home/chevyosa/projects/Dashboard-Store/backend`, whose current Git branch is `dev-master`. It is one `fork_mode` instance, PM2 watch disabled, `kill_timeout` 5 seconds. `src/index.ts` handles SIGTERM/SIGINT with `server.close()` and closes the DB pool. A PM2 restart alone neither fetches code nor rebuilds TypeScript; with one fork worker, do not promise zero downtime from a simple restart/reload.
- `backend/docs/deploy.md` documents deployment under `/var/www/store/{backend,frontend}` and pulls `dev-master`, but those deployment directories do not exist on this host. Treat the document as stale for the live host. Do not follow it blindly. The running backend shares the same checkout Claude would edit. Before production deploy, establish a separate production release checkout and verify its branch, environment, Nginx upstream, backup, migration runner, health checks, and rollback path. Prefer a blue-green/candidate process plus verified Nginx upstream switch, or another explicitly tested zero-downtime strategy; use expand/contract, backward-compatible migrations. Production deployment is a separate approved operation after user merges backend `master`.

## Contract / acceptance criteria

1. At cutover, one verified opening movement of Rp[X] establishes the combined liquid balance. It is recorded once, not hard-coded as a recurring amount and not derived by replaying historical live records.
2. Future final opname receipts add gross cash + QRIS as a single inflow exactly once. Draft saves and repeated requests do not add duplicate inflows.
3. Stock receipt and purchase payment are distinct. Only amounts actually paid reduce liquid balance. Support payment date and amount; support partial payments or explicitly reject/avoid them with a clear UI contract. A stock receipt must never be counted twice as a payment.
4. Existing consignor payment records count as outflows once. Paid payouts reduce liquid balance and remaining unpaid payout obligations; the same paid amount is never deducted twice. Keep payment history/auditability.
5. Existing take-profit withdrawals count as outflows once. New withdrawal creation must be bounded by the current safe-to-withdraw amount, with an atomic server-side check to prevent stale UI/parallel-request overdraw.
6. `safeToWithdraw = max(0, current liquid balance - Rp300,000 reserve - remaining unpaid/committed obligations)` under the confirmed single-pool rule. Paid payouts and paid stock buys are already reflected in liquid balance and must not be deducted a second time.
7. At the approved cutover snapshot, Rp[X] balance with Rp300,000 reserve yields Rp0 available. A future stock purchase paid from the pool lowers balance and available funds. A future paid payout lowers balance and does not leave the same payout unpaid.
8. Keep Profit A/Profit B and opname cash reconciliation semantically separate. Do not alter gross QRIS/cash figures to net out restock.
9. Cash discrepancy (+Rp[X] on the Nov 6 opname) remains a separate reconciliation warning; this implementation must not silently classify it as a stock purchase or payout.
10. No production writes, schema migration, deploy, or live-data backfill as part of Claude's local implementation/testing.

## Proposed data and API design

Claude should first inspect existing repositories/validators/controllers and propose the smallest safe design before coding. Prefer an append-only `store_cash_movements` (or similarly named) table with unique source references and fields for direction/type, amount, effective date, source entity/id, note, and created-by metadata. Record one opening-balance movement at cutover. Use source uniqueness/idempotency to prevent duplicate movements.

Integrate existing events transactionally:
- finalized opname -> one gross-receipts inflow;
- stock purchase payment -> outflow, linked to stock-in and payment date (do not assume receipt means paid);
- consignor payment -> outflow linked to existing `consignor_payments` row;
- take-profit withdrawal -> outflow linked to existing `take_profits` row.

Expose a typed API overview with opening/current liquid balance, recent movement totals, reserve, unpaid liabilities, safe-to-withdraw, and warning text. Add only the minimum write endpoint/UI needed for setting the opening cutover balance and registering actual stock purchase settlement. Reuse current payout/withdrawal forms and ensure their writes update liquidity exactly once.

Do not expose unrestricted ledger editing/deletion. Any correction should be an auditable reversal/adjustment, but a general adjustment workflow is out of scope unless required by the existing architecture and approved by Riyanda.

## Task sequence

### Task 1: Reconfirm contracts and inspect integration points

- Re-read `backend/src/services/take-profit.service.ts`, `backend/src/repositories/take-profit.repository.ts`, `backend/src/services/stock-in.service.ts`, `backend/src/services/opname.service.ts`, payout service/repository, take-profit and stock-in validators/routes/controllers, and their tests.
- Inspect frontend take-profit page/components/API types and stock-in form. Follow `frontend/AGENTS.md`: before changing frontend code, read relevant Next 16 docs under `frontend/node_modules/next/dist/docs/`.
- Confirm current repository status and ensure no unrelated changes are overwritten.

### Task 2: Add failing backend domain/service tests

- Specify the liquid-balance equation and cases for opening balance, final opname inflow, paid vs unpaid stock receipt, payout payment, withdrawal, unpaid obligations, idempotent source handling, and reserve floor.
- Add tests proving the current Nov 6/Nov 8 scenario has Rp[X] baseline and Rp0 withdrawable at cutover, without replaying historic events.
- Add regression coverage that changing QRIS input to net-of-purchase is incorrect and that Profit B remains separate from liquid availability.
- Run the narrow tests and confirm RED before implementation.

### Task 3: Create migration and ledger repository/domain service

- Add next forward-only migration (currently expected `0013_...sql`; verify migration sequencing/checksum conventions first).
- Add append-only movement storage with unique source references and indexes for effective-date/history queries.
- Add repository/service calculations using decimal-safe string handling and transaction boundaries. Define/report `paid`, `unpaid`, and opening balance without double subtraction.
- Test against `store_test` only. Do not connect Claude/test runner to `store_prod`.

### Task 4: Wire source transactions safely

- Finalized opname transaction: create one receipt movement for `realCash`; ensure draft edits and retries do not create multiple movements.
- Stock purchase: record actual payment separately from stock receipt, date/method/amount, and support partial payments or explicitly constrain to single full settlement with validation and a documented error.
- Consignor payment and take-profit creation: create linked movements within the same DB transaction or derive them through a single canonical service; avoid dual writes that can drift.
- Add rollback/failure tests ensuring source row and movement cannot diverge.

### Task 5: Update take-profit API and transaction guard

- Replace current realCash-minus-payout formula for liquidity with ledger-derived current balance and unpaid liabilities.
- Enforce safe withdrawal atomically when recording a take-profit, not only in the frontend.
- Preserve `profitA`, `profitB`, and existing payout-due reporting for profitability/reconciliation; give fields distinct names and documented semantics.
- Update integration tests whose current expected contract leaves available funds unchanged after payout.

### Task 6: Update frontend and terminology

- Update `frontend/components/take-profit/take-profit-summary-card.tsx`, `take-profit-dialog.tsx`, page/API types, and relevant tests.
- Show liquid balance, minimum reserve, unpaid liabilities/committed stock payments, and safe-to-withdraw. Replace the misleading “keuntungan murni” text with clear Indonesian language that distinguishes profit and spendable balance.
- Add/adjust stock-in payment UI so a received purchase is not presumed paid. Clearly show payment amount/date and outstanding amount if partial payments are supported.
- Use Next 16 documentation required by `frontend/AGENTS.md` before editing.

### Task 7: Establish cutover procedure and regression verification

- Provide an explicit, auditable cutover operation for the user-approved Rp[X] opening balance. It must be one-time/idempotent and must not seed historic stock, payout, or opname movements.
- Confirm current historic paid payouts are settled and avoid importing the Nov 8 payment as a new outflow after the Rp[X] opening balance.
- Run backend targeted tests, full backend typecheck/lint/test, and frontend typecheck/lint/test/build as applicable. Review `git diff` and ensure no secrets, dump, or live data entered tracked files.
- Document that the +Rp[X] historical cash discrepancy remains unresolved and is not changed by the liquidity ledger.
- After implementation and independent FADD validation PASS, push only the backend/frontend changes to their respective `origin/dev-master` branches, as authorized by the user. Never push/merge `master`; the user pulls locally and merges via GitHub Desktop.
- Stop before production migration/deployment. That is a separate operation after the user merges the backend to `master`, with an approved backup, separate production checkout, compatibility check, candidate health tests, traffic cutover, monitoring, and rollback plan.

## Files likely to change

Backend:
- Create: `backend/migrations/0013_store_cash_movements.sql` (confirm sequence/name)
- Create: ledger domain/repository/service and focused unit/integration tests
- Modify: `backend/src/services/take-profit.service.ts`, `backend/src/repositories/take-profit.repository.ts`, `backend/src/services/opname.service.ts`, stock-in service/validators/repositories/routes/controllers, payout integration if required, `backend/src/app.ts`
- Modify: `backend/tests/integration/take-profit.test.ts` and add focused ledger/stock-in/opname/payout tests

Frontend:
- Modify: `frontend/app/(app)/take-profit/page.tsx`, `frontend/components/take-profit/take-profit-summary-card.tsx`, `take-profit-dialog.tsx`, `frontend/tests/take-profit.test.tsx`, API types/client, and stock-in form/components/tests as required.

Documentation:
- Update relevant backend/frontend README or financial workflow docs with the cutover and gross-sales-vs-stock-payment distinction.

## Validation commands

Backend from `backend/`:
- `npm test -- tests/integration/take-profit.test.ts`
- Run newly added focused ledger/payment/opname tests.
- `npm run typecheck`
- `npm run lint`
- `npm test`

Frontend from `frontend/`:
- Run focused take-profit and stock-in Vitest tests.
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`

All migration/integration tests must target an isolated `_test` database. Never point tests or Claude MCP at production.

## Open implementation check

Before coding, Claude must report its proposed table/event design, idempotency strategy, and exact definition of unpaid/committed obligations. Do not silently assume the `store_ins` receipt date is the payment date. The user-confirmed opening baseline is Rp[X] after historical activity; all historical data is excluded from the new ledger.