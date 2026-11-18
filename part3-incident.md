# Part 3 — Payout day, 21:00

p95 on withdraw went from 300ms to 11s in the last hour, and support is hearing "debited but not received." I did not write this system. I have app logs, Atlas, and the gateway dashboard. I am not going to look for the root cause before I know whether we are paying people twice.

## First few minutes

I post one line to the incident channel and to support: payouts are slow, do not ask users to retry, do not promise a refund yet, I will update in 15 minutes. Then I look at three numbers for the last hour, in parallel:

- Gateway dashboard: payouts created per minute, error rate, and how many are `processing` versus `processed` versus `failed`. Median create latency.
- App logs for `POST /api/wallet/withdraw`: count of `200`, count of `4xx`, count of `5xx`, and the lines that say `gateway error`.
- Atlas primary: CPU, connections, replication lag, and the profiler / slow-query list.

The comparison that decides the next step is ledger withdrawal rows in the last hour versus gateway payouts created in the last hour. This handler writes the ledger row even when the gateway call failed, and it writes no reference, so I count them by time window, not by id.

```js
db.ledger.countDocuments({
  type: "withdrawal",
  createdAt: { $gte: hourAgo },
})
```

And in the gateway dashboard, payouts created since `hourAgo`.

## Stopping the bleeding, before I know the cause

If gateway payouts are clearly ahead of distinct users, or the same user has several `WD-*` payouts a few seconds apart, we are double paying. I turn the withdraw route off (flag, or a deploy that returns 503 with `Retry-After`). Leaving it up while I read logs costs real money because the client retries timeouts.

If the gateway's own latency or error rate jumped, I also turn the route off. New withdraws will debit first and then wait on a sick gateway, which is exactly the complaint we already have. Money already submitted stays where it is. I do not cancel those, and I do not refund them.

If the counts roughly match, the gateway is healthy, and Atlas shows the time is in Mongo, I leave payouts on only if I can stop the slow read immediately. On this code the slow read is the handler itself (`Ledger.find({ userId }).sort({ createdAt: -1 })` before the response). I would ship a one-line change that returns `{ ok, balance }` and does not load history, then watch p95. I would not leave the route serving an 11s history query, because every timeout becomes another withdraw.

If I cannot tell which of those is true within about ten minutes, I turn the route off. A paused payout day is cheaper than an hour of blind retries.

## What I look at to confirm

Atlas, on the primary:

```js
db.currentOp({
  active: true,
  secs_running: { $gt: 1 },
  ns: /ledger|wallets/,
})
```

I am looking for `planSummary: "COLLSCAN"` or a sort on `ledger` with `userId` and `createdAt`, a large `docsExamined`, and op latency near 11s. That matches the missing `{ userId: 1, createdAt: -1 }` index and the unbounded find in this handler.

```js
db.serverStatus().connections
db.serverStatus().opcounters
```

Plus the Atlas charts for replication lag, primary CPU, and WiredTiger tickets. If connections are climbing and the app is timing out, the client retries are now the load.

In the logs I want one slow request pulled apart: time to the wallet `updateOne`, time to `createPayout`, time to the ledger find. If the gateway call is fast and the find is the 11s, the user was debited and probably paid, and the app showed an error because it gave up. That complaint is "the response was late," not "the bank missed it." If `gateway error` is being logged and we still returned 200, the complaint is the real bug: debit and ledger succeeded, bank did not, and the `catch` swallowed it.

Gateway dashboard, same window: filter by reference prefix `WD-`. Several references per user, seconds apart, means the retry is creating new payouts (`Date.now()`), not replaying one.

## Decisions

- COLLSCAN on the history find, gateway latency normal, payout count close to ledger count: the money path is probably intact and the response is late. Hotfix the handler so it does not read history. Tell support the withdraw may have succeeded even though the app showed an error; users should wait, not retry. Build `{ userId: 1, createdAt: -1 }` in the background after the route is fast again, not during the 11s storm.
- Gateway create latency is itself multiple seconds, or gateway 5xx climbed: route stays off. Anything already created is the gateway's queue, not a refund. Support script: the debit is real, the bank credit is delayed, we are reconciling by time window because these rows have no reference.
- Ledger rows are ahead of gateway payouts, and logs show `gateway error` next to `200`s: route stays off. Those users were debited and not paid. I pull that set (ledger `withdrawal` in the window, no matching payout in the gateway export) and finance reviews it before any credit is put back. I do not script a refund against "everyone who complained."
- Ledger rows are behind gateway payouts: we paid more than we recorded. Route stays off. That list comes from the gateway export, not from our ledger, because our ledger is the thing that's missing rows.

## What I would not do

I would not refund from the support complaints. On this code a timeout often happens after the debit and after the gateway has already accepted the payout. A refund plus a late payout is a second payment.

I would not retry the failed-looking withdraws by hand. There is no idempotency key. My retry is another payout.

I would not build a foreground index on a 40M collection while the primary is already slow. That makes the outage worse. Background, after withdraw traffic is either stopped or no longer scanning.

I would not restart the app fleet or fail over Atlas as a first move. I don't yet know if the slowness is the history query, the gateway, or the pool. A restart drops the in-flight calls and the clients immediately retry them.

I would not tell support "the user's balance is wrong, ask them to withdraw again." That is the loop that got us here.
