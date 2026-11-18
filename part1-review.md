# Part 1 — Payout handler review

Assumptions I proceeded with, because the snippet doesn't say:

- This function is the whole withdraw path. I did not assume a middleware, a queue, or a unique index I cannot see.
- `gateway.createPayout` returns a promise. The call is not awaited.
- The mobile client retries a withdraw when it times out, as the brief says.
- Money is rupees in a JS number today. I would store paise as an integer.
- `req.body.userId` is whoever the caller sends. I would not trust that for a payout.

Questions I would have asked before touching this:

1. Does the gateway treat `reference` as an idempotency key, and for how long?
2. Is `createPayout` finished when the HTTP call returns, or does a webhook later say the money actually moved?
3. Are we on a replica set, so a multi-document transaction is allowed?
4. What is a legal withdraw: min, max, daily cap, and does the bank account belong to the teen or a parent?
5. Is there already an auth middleware that knows the user, and this handler ignores it?

---

## 1. We debit the wallet, then we don't actually know if the bank was paid

The balance is reduced with `updateOne` before `createPayout`. The gateway call is not awaited, and the `catch` only handles a synchronous throw. A rejected promise skips that `catch`. After that, the code always inserts a `withdrawal` ledger row and returns `{ ok: true }`.

The reference (`WD-` + `Date.now()`) is sent to the gateway and never stored. The ledger row has no reference and no gateway id.

What goes wrong: our database says the money left. The bank may or may not have it. We have no key to match the two.

Realistic case: payout day, the gateway takes 8 seconds and then times out. The balance is already down. The promise rejects later, the user still got `ok: true` if we responded, or the client already gave up. Support sees "debited but not received". Nobody can query the gateway by our reference because we didn't save it. The opposite also happens: the gateway accepted the payout, our process moved on and wrote a success row, then a retry starts a second payout.

Fix: persist a withdrawal row first, with a stable reference. Move the balance only with a conditional update, in the same transaction as the ledger line. Call the gateway only after that commit, with the stored reference. If the gateway clearly rejects it (bad account, 4xx that is not a timeout), reverse the debit in a transaction. If the call times out or returns 5xx, do not reverse it. Mark the row `unknown` and let a reconciler ask the gateway what happened.

## 2. Two requests can both spend the same balance

The handler reads `wallet.balance`, checks it in Node, then `$set`s a new balance it computed earlier. That is not atomic. `$set` also overwrites whatever landed in between, including a reward credit.

Realistic case: balance is 100. The app times out and retries. Both requests read 100, both pass the check, both write 0. The gateway is called twice. The user is paid 200. Same shape if a project reward credits 50 after the read and before the `$set`: the withdraw writes the stale balance and the 50 disappears.

This is likely, not theoretical, because the brief says the client retries timeouts, and the history query below is how those timeouts start.

Fix: one atomic update:

```js
Wallets.findOneAndUpdate(
  { userId, balancePaise: { $gte: amount } },
  { $inc: { balancePaise: -amount } },
  { new: true }
)
```

If `modifiedCount` is 0, the withdraw does not continue. No read-modify-write, no `$set` of a stale number.

## 3. A retry is a second withdraw

Nothing in the request is an idempotency key. The gateway reference is `Date.now()`, so two retries in the same millisecond can even share a reference, and two retries a millisecond apart are two payouts. The handler has no unique index to collapse them.

Realistic case: the debit and the gateway call succeeded, then `Ledger.find(...).sort({ createdAt: -1 })` takes 11 seconds on 40M docs. The app hits its timeout and sends the same withdraw again. Second debit, second payout. The user sees a failure and then two bank credits, or a failure and one credit, depending on which call died.

Fix: require `Idempotency-Key`. Unique index on `{ userId, idempotencyKey }`. First request inserts a `pending` withdrawal. A retry with the same key returns that row and does not debit again. The gateway reference is derived from that key, not from the clock.

## 4. The caller chooses whose wallet is paid out

`userId` comes from the body. If this route is reachable with a normal user token, anyone who can guess or leak an id can empty that wallet into the bank account on the user document. For a product that pays teenagers, that is a direct loss, not a hardening item.

Fix: take the user from the session (`req.user.id`). Ignore `body.userId`. Pay only the bank account stored for that user, and only if it is verified.

## 5. `amount` is not checked

`amount` is not required to be a positive integer. `balance >= amount` is true for a negative amount, and `balance - amount` then increases the wallet. `amount * 1.0` does not make it safe. A float (`10.1` rupees) will drift. A missing wallet throws on `wallet.balance` and returns 500, which the client may retry.

Realistic case: a buggy client, or a user, sends `{ amount: -50000 }`. The check passes, the balance goes up, and the gateway is asked to "pay" a negative number. If the gateway rejects it, we still write a withdrawal and return success, so the inflated balance sticks.

Fix: reject anything that is not an integer number of paise, greater than 0, and under the product cap. Look up the wallet and return 404 if it is missing before trying to move money.

## 6. The balance change and the ledger line are not one write

`updateOne` and `insertOne` are separate. A crash, a primary failover, or a duplicate-key error on the ledger leaves a balance that the ledger cannot explain, or a ledger line whose balance never moved.

Realistic case: balance is decremented, the process dies before `insertOne`. The user lost the balance. Finance has no withdrawal row. The gateway may already have been fired, and we stored no reference.

Fix: one MongoDB transaction for the conditional debit, the ledger insert, and the withdrawal status change. The ledger is append-only. Corrections are new rows (`withdrawal_reversal`), not updates to old ones.

## 7. The success path loads the user's entire ledger, with no index that can serve it

`Ledger.find({ userId }).sort({ createdAt: -1 })` on about 40M documents and only the default `_id` index is a collection scan plus an in-memory sort, on every withdraw. The result is shipped back in the response. That is the thing that turns a 300ms call into a timeout, and the timeout is what triggers the retry in problem 3.

Fix: this endpoint returns the new balance and the withdrawal reference. History is a different route, paginated, backed by `{ userId: 1, createdAt: -1 }`.

## 8. Money is a JavaScript number

`amount * 1.0` and a balance that is subtracted in IEEE floats will eventually be a paisa off. Gateway reconciliation then fails for a reason that looks like fraud and is actually `0.1 + 0.2`.

Fix: integer paise everywhere. Convert to rupees only at the UI.

---

## What I would change before trusting this with payouts at scale

I would stop doing "read balance, set balance, call the bank, write a log" inside one HTTP handler. A withdrawal is its own document with a short state machine (`pending`, `debit_held`, `submitting`, `payout_submitted`, `succeeded`, `failed`, `unknown`). The wallet balance moves only inside a transaction with an append-only ledger line, and only via a conditional `$inc`. The gateway is called once, with a reference we stored first, and a worker keeps asking the gateway about anything left in `submitting` or `unknown` — a timeout is not a refund. The request path should not read the user's history. I would also want the gateway webhook, not this HTTP response, to be what marks a payout `succeeded`, because payout day is exactly when that call gets slow.

The rewrite is in `part1-withdraw.js`.
