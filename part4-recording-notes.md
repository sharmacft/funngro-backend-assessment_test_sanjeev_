# Part 4 — recording (you have to film this)

Do not submit this file. It is a reminder for the 5 minute recording. They said no script-reading, so glance at the three beats, then talk through `part1-withdraw.js` like you are explaining it to a teammate.

Keep it under 5 minutes. Loom or a phone pointed at the screen is enough.

## Beat 1 — the bug you ranked first (~90s)

Open the original handler in the PDF, or scroll the review.

Say this in your own words: we take the money out of the wallet before we know the bank accepted it. The gateway call is not awaited, the catch only logs, and we still write a withdrawal and return ok. The reference we sent is `Date.now()` and we never store it, so when someone says "debited but not received" we cannot even look the payout up.

Say why it is first: it loses or invents money on a single request, with no concurrency required.

## Beat 2 — the bug you ranked second (~90s)

The balance check and the `$set` are not one operation. Two retries can both read 100 and both pay out 100. The client retries timeouts, and the full ledger scan is what makes those timeouts normal. So the race is the everyday path, not an edge case.

If you only have time for one sentence on the third: there is no idempotency key, so that retry is a new withdraw by design.

## Beat 3 — the decision you were not sure about (~90s)

Open `submitPayout` in `part1-withdraw.js`. The branch where a timeout sets status to `unknown` and does not put the money back.

Say you almost refunded on any gateway error, and you don't, because a timeout often means the payout was created and the response died. Refunding that pays the user twice. You want to ask them: does their gateway dedupe on `reference`, and is there a webhook, or do we have to poll?

Then stop. Don't tour the whole file.
