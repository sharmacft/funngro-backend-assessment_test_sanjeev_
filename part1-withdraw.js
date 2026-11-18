/**
 * POST /api/wallet/withdraw
 *
 * Header: Idempotency-Key  (client generates one per withdraw attempt, reuses it on retry)
 * Body:   { amount }        (integer paise). body.userId is ignored.
 *
 * Needs a replica set (transactions). Indexes at the bottom of this file.
 * gateway.createPayout({ account, amount, currency, reference }) must be safe to
 * retry with the same reference. If it isn't, I would not ship the HTTP path
 * calling it directly — the worker below is the version I would turn on.
 */

const MAX_WITHDRAW_PAISE = 10000000; // 1,00,000 INR. I'd confirm the real product cap.

async function withdraw(req, res) {
  const userId = req.user && req.user.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const idempotencyKey = req.get("Idempotency-Key");
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 128
  ) {
    return res.status(400).json({ error: "Idempotency-Key required" });
  }

  const amount = req.body && req.body.amount;
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_WITHDRAW_PAISE) {
    return res.status(400).json({ error: "amount must be a positive integer in paise" });
  }

  const user = await Users.findOne({ _id: userId }).select("bankAccount kycStatus");
  if (!user) return res.status(404).json({ error: "user not found" });
  if (!user.bankAccount) return res.status(400).json({ error: "no bank account" });
  if (user.kycStatus && user.kycStatus !== "verified") {
    return res.status(403).json({ error: "bank account not verified" });
  }

  const reference = "WD-" + userId + "-" + idempotencyKey;

  let withdrawal;
  try {
    withdrawal = await Withdrawals.findOneAndUpdate(
      { userId, idempotencyKey },
      {
        $setOnInsert: {
          userId,
          idempotencyKey,
          reference,
          amount,
          status: "pending",
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    // Two retries inserted at the same moment. The unique index keeps one row.
    if (err.code !== 11000) throw err;
    withdrawal = await Withdrawals.findOne({ userId, idempotencyKey });
  }

  if (!withdrawal) return res.status(500).json({ error: "could not start withdrawal" });

  if (withdrawal.amount !== amount) {
    return res.status(409).json({ error: "idempotency key already used with a different amount" });
  }

  if (withdrawal.status === "succeeded") {
    const wallet = await Wallets.findOne({ userId }).select("balancePaise");
    return res.json({
      ok: true,
      status: "succeeded",
      balance: wallet ? wallet.balancePaise : null,
      reference,
    });
  }

  if (withdrawal.status === "failed") {
    return res.status(400).json({
      error: withdrawal.failureReason || "withdrawal failed",
      reference,
    });
  }

  // A previous attempt already left this row with the gateway, or we don't know yet.
  // Do not debit again and do not refund from this request.
  if (
    withdrawal.status === "submitting" ||
    withdrawal.status === "payout_submitted" ||
    withdrawal.status === "unknown"
  ) {
    return res.status(202).json({ ok: true, status: withdrawal.status, reference });
  }

  if (withdrawal.status === "debit_held") {
    return submitPayout(withdrawal, user, res);
  }

  const outcome = await debitIfPending(withdrawal, amount);
  if (outcome === "insufficient") {
    return res.status(400).json({ error: "insufficient balance", reference });
  }
  if (outcome === "no_wallet") {
    return res.status(404).json({ error: "wallet not found", reference });
  }
  if (outcome !== "debit_held") {
    const latest = await Withdrawals.findOne({ _id: withdrawal._id }).select("status");
    return res.status(202).json({ ok: true, status: latest.status, reference });
  }

  return submitPayout(withdrawal, user, res);
}

async function debitIfPending(withdrawal, amount) {
  const session = await mongoose.startSession();
  let outcome = "pending";
  try {
    await session.withTransaction(async () => {
      const current = await Withdrawals.findOne({ _id: withdrawal._id }).session(session);
      if (!current || current.status !== "pending") {
        outcome = current ? current.status : "missing";
        return;
      }

      const wallet = await Wallets.findOneAndUpdate(
        { userId: current.userId, balancePaise: { $gte: amount } },
        { $inc: { balancePaise: -amount } },
        { new: true, session }
      );

      if (!wallet) {
        const again = await Withdrawals.findOne({ _id: withdrawal._id }).session(session);
        if (!again || again.status !== "pending") {
          outcome = again ? again.status : "missing";
          return;
        }
        const exists = await Wallets.findOne({ userId: current.userId }).session(session).select("_id");
        if (!exists) {
          outcome = "no_wallet";
          return;
        }
        await Withdrawals.updateOne(
          { _id: withdrawal._id, status: "pending" },
          { $set: { status: "failed", failureReason: "insufficient_balance", failedAt: new Date() } },
          { session }
        );
        outcome = "insufficient";
        return;
      }

      await Ledger.create(
        [
          {
            userId: current.userId,
            type: "withdrawal_hold",
            amount,
            balanceAfter: wallet.balancePaise,
            reference: current.reference,
            withdrawalId: current._id,
            createdAt: new Date(),
          },
        ],
        { session }
      );

      await Withdrawals.updateOne(
        { _id: withdrawal._id, status: "pending" },
        {
          $set: {
            status: "debit_held",
            balanceAfter: wallet.balancePaise,
            heldAt: new Date(),
          },
        },
        { session }
      );
      outcome = "debit_held";
    });
  } finally {
    await session.endSession();
  }
  return outcome;
}

async function submitPayout(withdrawal, user, res) {
  // Only one request is allowed to call the gateway for this row.
  const claim = await Withdrawals.updateOne(
    { _id: withdrawal._id, status: "debit_held" },
    { $set: { status: "submitting", submittingAt: new Date() } }
  );
  if (claim.modifiedCount === 0) {
    const latest = await Withdrawals.findOne({ _id: withdrawal._id }).select("status reference");
    return res.status(202).json({ ok: true, status: latest.status, reference: latest.reference });
  }

  let payout;
  try {
    payout = await gateway.createPayout({
      account: user.bankAccount,
      amount: withdrawal.amount,
      currency: "INR",
      reference: withdrawal.reference,
    });
  } catch (err) {
    // 409 = this reference already exists at the gateway. That is not a failure
    // and it is not a reason to refund. The reconciler will read the real status.
    if (err.status === 409) {
      await Withdrawals.updateOne(
        { _id: withdrawal._id, status: "submitting" },
        { $set: { status: "payout_submitted", updatedAt: new Date() } }
      );
      return res.status(202).json({
        ok: true,
        status: "payout_submitted",
        reference: withdrawal.reference,
      });
    }

    if (isDefiniteGatewayRejection(err)) {
      await refundHold(withdrawal, err.code || "gateway_rejected");
      return res.status(502).json({ error: "payout rejected", reference: withdrawal.reference });
    }

    // Timeout, reset, 429, 5xx. The payout may have been created. Leave the debit.
    await Withdrawals.updateOne(
      { _id: withdrawal._id, status: "submitting" },
      { $set: { status: "unknown", updatedAt: new Date() } }
    );
    return res.status(202).json({
      ok: false,
      status: "unknown",
      reference: withdrawal.reference,
    });
  }

  const settled = payout.status === "processed";
  await Withdrawals.updateOne(
    { _id: withdrawal._id, status: "submitting" },
    {
      $set: {
        status: settled ? "succeeded" : "payout_submitted",
        gatewayPayoutId: payout.id,
        updatedAt: new Date(),
      },
    }
  );

  if (!settled) {
    return res.status(202).json({
      ok: true,
      status: "payout_submitted",
      reference: withdrawal.reference,
    });
  }

  const wallet = await Wallets.findOne({ userId: withdrawal.userId }).select("balancePaise");
  return res.json({
    ok: true,
    status: "succeeded",
    balance: wallet.balancePaise,
    reference: withdrawal.reference,
  });
}

// Only call this when the gateway has said, clearly, that it did not take the money.
// Guarded on status so a retry cannot refund a payout that already moved on.
async function refundHold(withdrawal, reason) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await Withdrawals.findOne({ _id: withdrawal._id }).session(session);
      if (!current || current.status !== "submitting") return;

      const wallet = await Wallets.findOneAndUpdate(
        { userId: current.userId },
        { $inc: { balancePaise: current.amount } },
        { new: true, session }
      );

      await Ledger.create(
        [
          {
            userId: current.userId,
            type: "withdrawal_reversal",
            amount: current.amount,
            balanceAfter: wallet.balancePaise,
            reference: current.reference,
            withdrawalId: current._id,
            createdAt: new Date(),
          },
        ],
        { session }
      );

      await Withdrawals.updateOne(
        { _id: current._id, status: "submitting" },
        { $set: { status: "failed", failureReason: reason, failedAt: new Date() } },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
}

function isDefiniteGatewayRejection(err) {
  const status = err.status || (err.response && err.response.status);
  if (status === 408 || status === 409 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * Worker, not the request path. Pseudocode on purpose: I don't have the
 * gateway's "get payout by reference" client here. The rule is the part that matters.
 *
 * Every minute, for rows stuck in submitting | unknown | payout_submitted:
 *   payout = gateway.findByReference(row.reference)
 *   not found, and the row has been submitting for > 2 minutes:
 *       refund, same transaction as refundHold, from that status
 *   found and processed:  mark succeeded
 *   found and failed:     refund
 *   found and pending:    mark payout_submitted
 * Never refund an unknown row just because our HTTP call timed out.
 */

/*
Indexes I would create before turning this on:

Withdrawals:
  { userId: 1, idempotencyKey: 1 }  unique   — one logical withdraw per retry storm
  { reference: 1 }                  unique   — the key we give the gateway
  { status: 1, updatedAt: 1 }                — the reconciler's scan

Wallets:
  { userId: 1 }                     unique

Ledger:
  { reference: 1 }                           — tie a hold and its reversal together
  { userId: 1, createdAt: -1 }               — paginated history, NOT used by withdraw

Users:
  already keyed by _id
*/

module.exports = { withdraw };
