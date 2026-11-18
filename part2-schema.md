# Part 2 — Reward points

Assumption: a point is an integer. Cash is integer paise. The conversion rate is a global value that changes over time, so a conversion stores the rate it actually used. "Expired in March" means the expiry happened in March, not that the points were earned in March. Cohort is the user's signup month (`"2026-03"`), copied onto every points event at write time so the monthly report does not join users for every ledger row.

Question I would ask: is expiry FIFO across earned lots, and can one conversion spend several lots? I assumed yes, because that is the version that actually has a double-spend bug worth designing against.

## Collections

### `users` (field we add, not a new collection)

```
cohort: string    // signup month, immutable, "YYYY-MM"
```

### `point_lots` — one document per time the user earned points

```
_id:              ObjectId
userId:           ObjectId
cohort:           string
sourceType:       "project" | "promo"
sourceId:         string          // project completion id, or promo grant id
earnedPoints:     int
remainingPoints:  int
earnedAt:         Date
expiresAt:        Date
status:           "open" | "exhausted" | "expired"
```

Indexes:

- `{ sourceType: 1, sourceId: 1 }` unique. A retried "project completed" event cannot create a second lot. Serves the earn path.
- `{ userId: 1, status: 1, expiresAt: 1 }`. Serves "which open lots can this conversion spend, oldest expiry first" and the expiry job's per-user scan.
- `{ status: 1, expiresAt: 1 }`. Serves the expiry job: open lots whose `expiresAt` has passed.

### `point_conversions` — one document per attempt to turn points into wallet cash

```
_id:                    ObjectId
userId:                 ObjectId
cohort:                 string
idempotencyKey:         string
points:                 int
ratePaisePerPoint:      int       // the rate at that moment, not "whatever the rate is now"
cashPaise:              int
lotAllocations:         [ { lotId: ObjectId, points: int } ]
walletCreditReference:  string
status:                 "pending" | "credited" | "failed"
createdAt:              Date
```

Indexes:

- `{ userId: 1, idempotencyKey: 1 }` unique. A retried convert request is the same conversion.
- `{ createdAt: 1 }`. Serves the monthly report's convert side if we ever read this collection instead of the ledger. The report below reads the ledger.

### `point_ledger` — append-only, this is what finance adds up

```
_id:         ObjectId
userId:      ObjectId
cohort:      string
type:        "earn" | "convert" | "expire"
points:      int            // always positive; type says the direction
sourceType:  string
sourceId:    string         // lot sourceId, or conversion id
createdAt:   Date
```

Indexes:

- `{ sourceType: 1, sourceId: 1, type: 1 }` unique. One earn, one convert, or one expire event cannot be recorded twice for the same source.
- `{ createdAt: 1, cohort: 1, userId: 1 }`. Serves the monthly report: a range on `createdAt`, then a group by user and cohort. `createdAt` is first because every run of this report is a month range. Cohort and userId are there so the group doesn't have to re-read the whole document, and so a single-cohort rerun can still use the index.
- `{ userId: 1, createdAt: -1 }`. Serves the app's "my points history" page. It does not serve the finance report, and the report should not share it.

I would not keep a cached points balance as the thing we decrement. `remainingPoints` on the lot is the balance, and it only moves with a conditional update. A cached `users.pointsBalance` is fine later as a projection, rebuilt from lots, not written by the request.

### Rate

```
point_rates
  _id
  paisePerPoint: int
  effectiveFrom:  Date
```

Index: `{ effectiveFrom: -1 }`. The conversion reads the newest rate with `effectiveFrom <= now`. The number that was used is copied onto `point_conversions`, so a later rate change does not rewrite history.

## Monthly report

Per user, for one month: points earned, converted, and expired. Cohort is on the row so finance can roll it up without another join.

```js
db.point_ledger.aggregate([
  {
    $match: {
      createdAt: { $gte: monthStart, $lt: monthEnd }, // monthEnd is exclusive
    },
  },
  {
    $group: {
      _id: { userId: "$userId", cohort: "$cohort" },
      earned: {
        $sum: { $cond: [{ $eq: ["$type", "earn"] }, "$points", 0] },
      },
      converted: {
        $sum: { $cond: [{ $eq: ["$type", "convert"] }, "$points", 0] },
      },
      expired: {
        $sum: { $cond: [{ $eq: ["$type", "expire"] }, "$points", 0] },
      },
    },
  },
  {
    $project: {
      _id: 0,
      userId: "$_id.userId",
      cohort: "$_id.cohort",
      earned: 1,
      converted: 1,
      expired: 1,
    },
  },
]);
```

`monthStart` and `monthEnd` are UTC dates I would pass in, not compute with a timezone-less `$month`, because an IST month boundary is the kind of thing finance argues about. If they want one row per cohort instead of per user, the same pipeline groups by `$cohort` only.

## Concurrent conversions

A conversion does not read a balance and write it back. Inside one transaction it walks the user's open lots oldest-expiry-first and claims points with `updateOne({ _id, remainingPoints: { $gte: take } }, { $inc: { remainingPoints: -take } })`. A lot that lost the race matches zero documents, so this request takes less from it or fails with insufficient points. The same transaction inserts the `point_conversions` row, and the unique index on `{ userId, idempotencyKey }` means the retrying request is not a second conversion. Two different keys racing on the same lots cannot both take the last point, because the conditional `$inc` only succeeds for one of them and the loser aborts the transaction instead of writing a convert ledger line.
