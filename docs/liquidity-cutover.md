# Liquidity Ledger Cutover Runbook

## Status

This is an implementation/runbook document only. It does not authorize a production migration, cutover request, database write, or deployment. None of those actions has been run by this implementation task.

## What the one-time endpoint does

`POST /api/v1/liquidity/cutover` creates, in one transaction:

- the singleton `liquidity_cutover` row;
- one positive `opening` event for the physical liquid-cash opening amount;
- high-water IDs for existing opnames, stock-ins, stock payments, consignor payments, and take-profit rows;
- an audit record.

It requires an authenticated session and the normal CSRF header. The request body is strict:

```json
{
  "openingAmount": "296000.0000",
  "openingUnpaidStock": "0.0000",
  "confirmOpeningBalance": true,
  "confirmLegacyPurchasesReconciled": true
}
```

The example numbers are not a recommendation to activate with those values. Use the figures verified immediately before the approved cutover. `openingAmount` is actual combined liquid cash/bank/available QRIS, not net of debt. `openingUnpaidStock` is the separate outstanding amount for legacy purchase receipts. Legacy payments are not replayed as cash movements.

The endpoint does not alter `min_working_capital`. Check that setting separately; existing migrations seed it at Rp400,000, so it may differ from the Rp300,000 reserve in the approved plan. Do not change it without a separately reviewed and authorized procedure.

## Preconditions before anyone calls it

1. Obtain explicit user approval for the production migration, deployment sequence, and this one-time call. This implementation task does not grant that approval.
2. Apply the reviewed migration to the intended production database through the approved release procedure. Do not use the development checkout or its `.env`.
3. Reconcile the exact cutover boundary. The opening amount must include every real inflow and outflow up to the chosen instant. Finish all opnames through that boundary; the endpoint refuses to initialize while any draft opname exists.
4. Reconcile legacy purchase liabilities. Set `openingUnpaidStock` to the actual remaining unpaid amount, not the historic purchase total. The known historical purchases described in the plan were paid, but verify the current state before activation.
5. Confirm the current reserve setting and agree its value. The endpoint intentionally does not modify it.
6. Choose a boundary that can be operationally enforced. `cutoverAt` is assigned by the server in UTC. Business-date transactions dated on or before the cutover calendar day are treated as historical; new opname, purchase, payout, payment, and withdrawal dates must be strictly later. In practice, activate before the next business date or wait until the following date to enter new transactions.
7. Ensure there is no transaction or manual cash movement crossing the boundary. The database lock serializes application source writes, but it cannot freeze physical cash activity outside the application.

## Expected outcomes

- First valid request: HTTP 201; one cutover row, one opening event, and one audit record.
- Existing draft opnames: HTTP 409 `LIQUIDITY_CUTOVER_HAS_OPEN_OPNAMES`; transaction rolls back without initializing.
- Invalid confirmation/body: HTTP 400; no writes.
- A second initialization attempt: HTTP 409; no second opening event.
- After activation, source writes dated on/before the cutoff are rejected. Pre-cutover source rows at or below the stored high-water marks cannot be replayed or edited into the post-cutover period.

## If activation values are wrong

There is intentionally no reset, update, or delete endpoint. Stop further financial writes and obtain a separately reviewed correction procedure. Do not delete the opening event, edit the cutover row directly, or retry with another opening value.

## Verification after an explicitly approved production activation

Use authenticated, read-only API checks to confirm the cutover response, the liquidity overview, opening balance, reserve, unpaid obligations, safe-to-withdraw amount, and audit entry. Do not run application migrations or direct production SQL as part of these checks unless separately approved.
