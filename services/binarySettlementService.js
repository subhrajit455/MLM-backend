const User = require('../models/User');
const VolumeLedger = require('../models/VolumeLedger');
const WalletTransaction = require('../models/WalletTransaction');
const { Decimal, toDecimal, toDecimal128, toFixed4String } = require('../utils/decimal');
const { runWithTransactionOrFallback } = require('../utils/transactionHelper');

const BINARY_MATCH_RATE = new Decimal('0.10');

/**
 * Batch cycle processor that iterates through VolumeLedger for a period_id:
 * - Computes totalLeft = gv_left + carry_left and totalRight = gv_right + carry_right
 * - Calculates matchedVolume = Decimal.min(totalLeft, totalRight)
 * - Pays 10% Binary Match Bonus (capped by the user's rank cap, e.g., $5,000) to WalletTransaction
 *   with idempotency_key: BINARY_${periodId}_${userId}
 * - Deducts matchedVolume from both legs and rolls the remaining strong-leg surplus into carry_left / carry_right
 */
async function runBinarySettlement(periodId = process.env.ACTIVE_PERIOD || '202610') {
  return await runWithTransactionOrFallback(async (session) => {
    const sessionOpts = session ? { session } : {};

    const ledgers = await VolumeLedger.find({ period_id: periodId })
      .populate('user_id', 'username full_name rank_id rank_cap is_active placement_depth')
      .session(session);

    const settlementRows = [];
    let totalMatchedVolume = new Decimal('0.0000');
    let totalBonusPaid = new Decimal('0.0000');
    let totalCappedFlushed = new Decimal('0.0000');
    let distributorsPaidCount = 0;

    for (const ledger of ledgers) {
      const user = ledger.user_id;
      if (!user) continue;

      const gvLeft = toDecimal(ledger.gv_left);
      const gvRight = toDecimal(ledger.gv_right);
      const carryLeft = toDecimal(ledger.carry_left);
      const carryRight = toDecimal(ledger.carry_right);

      const totalLeft = gvLeft.add(carryLeft);
      const totalRight = gvRight.add(carryRight);
      const matchedVolume = Decimal.min(totalLeft, totalRight);

      const newCarryLeft = totalLeft.sub(matchedVolume);
      const newCarryRight = totalRight.sub(matchedVolume);
      const rankCap = toDecimal(user.rank_cap || User.RANK_CAPS[user.rank_id] || '5000.0000');

      let rawBonus = new Decimal('0.0000');
      let finalPayout = new Decimal('0.0000');
      let capApplied = false;
      let flushedAmount = new Decimal('0.0000');
      let settlementStatus = 'NO_MATCHABLE_VOLUME';
      let idempotencyKey = null;

      if (matchedVolume.gt(0)) {
        rawBonus = matchedVolume.mul(BINARY_MATCH_RATE).toDecimalPlaces(4, Decimal.ROUND_DOWN);

        if (!user.is_active) {
          // Inactive user: volume still flushes/carries or holds according to binary rules;
          // here we report inactive disqualification clearly in the console
          settlementStatus = 'SKIPPED_INACTIVE';
          finalPayout = new Decimal('0.0000');
        } else {
          if (rawBonus.gt(rankCap)) {
            finalPayout = rankCap;
            capApplied = true;
            flushedAmount = rawBonus.sub(rankCap);
            totalCappedFlushed = totalCappedFlushed.add(flushedAmount);
          } else {
            finalPayout = rawBonus;
          }

          const baseKey = `BINARY_${periodId}_${user._id.toString()}`;
          const existingTx = await WalletTransaction.findOne({
            idempotency_key: baseKey
          }).session(session);

          // Use exact required idempotency_key `BINARY_${periodId}_${userId}` on first cycle for period,
          // and append cycle sequence if additional orders were simulated in the same period after settlement
          if (!existingTx) {
            idempotencyKey = baseKey;
          } else {
            const prevMatches = await WalletTransaction.countDocuments({
              user_id: user._id,
              period_id: periodId,
              tx_type: 'BINARY_MATCH'
            }).session(session);
            idempotencyKey = `${baseKey}_C${prevMatches + 1}`;
          }

          await WalletTransaction.findOneAndUpdate(
            { idempotency_key: idempotencyKey },
            {
              $setOnInsert: {
                idempotency_key: idempotencyKey,
                user_id: user._id,
                source_order_id: null,
                period_id: periodId,
                tx_type: 'BINARY_MATCH',
                amount: toDecimal128(finalPayout),
                status: 'CLEARED',
                description: `10% Binary Weak-Leg Match (${toFixed4String(matchedVolume)} BV matched)`,
                metadata: {
                  period_id: periodId,
                  total_left_before: toFixed4String(totalLeft),
                  total_right_before: toFixed4String(totalRight),
                  matched_volume: toFixed4String(matchedVolume),
                  raw_bonus: toFixed4String(rawBonus),
                  rank_cap: toFixed4String(rankCap),
                  cap_applied: capApplied,
                  carry_left_after: toFixed4String(newCarryLeft),
                  carry_right_after: toFixed4String(newCarryRight)
                }
              }
            },
            { upsert: true, new: true, ...sessionOpts }
          );

          // Deduct matchedVolume from both legs and roll remaining strong-leg surplus into carry_left / carry_right
          ledger.gv_left = toDecimal128('0.0000');
          ledger.gv_right = toDecimal128('0.0000');
          ledger.carry_left = toDecimal128(newCarryLeft);
          ledger.carry_right = toDecimal128(newCarryRight);
          ledger.matched_volume_paid = toDecimal128(
            toDecimal(ledger.matched_volume_paid).add(matchedVolume)
          );
          ledger.last_settled_at = new Date();
          await ledger.save(sessionOpts);

          settlementStatus = capApplied ? 'PAID_CAPPED' : 'PAID_FULL';
          totalMatchedVolume = totalMatchedVolume.add(matchedVolume);
          totalBonusPaid = totalBonusPaid.add(finalPayout);
          distributorsPaidCount += 1;
        }
      } else if (totalLeft.gt(0) || totalRight.gt(0)) {
        settlementStatus = 'CARRY_FORWARD_ONLY';
        // Roll current single-leg volume into carry_left / carry_right
        ledger.gv_left = toDecimal128('0.0000');
        ledger.gv_right = toDecimal128('0.0000');
        ledger.carry_left = toDecimal128(newCarryLeft);
        ledger.carry_right = toDecimal128(newCarryRight);
        ledger.last_settled_at = new Date();
        await ledger.save(sessionOpts);
      }

      settlementRows.push({
        user_id: user._id.toString(),
        username: user.username,
        full_name: user.full_name,
        rank_id: user.rank_id,
        is_active: user.is_active,
        rank_cap: toFixed4String(rankCap),
        gv_left_before: toFixed4String(gvLeft),
        gv_right_before: toFixed4String(gvRight),
        carry_left_before: toFixed4String(carryLeft),
        carry_right_before: toFixed4String(carryRight),
        total_left: toFixed4String(totalLeft),
        total_right: toFixed4String(totalRight),
        weak_leg: totalLeft.lt(totalRight)
          ? 'LEFT'
          : totalRight.lt(totalLeft)
          ? 'RIGHT'
          : 'BALANCED',
        matched_volume: toFixed4String(matchedVolume),
        raw_bonus: toFixed4String(rawBonus),
        payout: toFixed4String(finalPayout),
        flushed_by_cap: toFixed4String(flushedAmount),
        new_carry_left: toFixed4String(user.is_active || matchedVolume.eq(0) ? newCarryLeft : carryLeft),
        new_carry_right: toFixed4String(user.is_active || matchedVolume.eq(0) ? newCarryRight : carryRight),
        status: settlementStatus,
        idempotency_key: idempotencyKey
      });
    }

    // Sort rows so paid & highest matched volume appear at top
    settlementRows.sort((a, b) => {
      const diff = toDecimal(b.matched_volume).cmp(toDecimal(a.matched_volume));
      if (diff !== 0) return diff;
      return toDecimal(b.total_left).add(toDecimal(b.total_right)).cmp(
        toDecimal(a.total_left).add(toDecimal(a.total_right))
      );
    });

    return {
      period_id: periodId,
      settled_at: new Date().toISOString(),
      summary: {
        total_distributors_evaluated: settlementRows.length,
        distributors_paid: distributorsPaidCount,
        total_matched_volume: toFixed4String(totalMatchedVolume),
        total_bonus_paid: toFixed4String(totalBonusPaid),
        total_capped_flushed: toFixed4String(totalCappedFlushed)
      },
      rows: settlementRows
    };
  });
}

module.exports = {
  runBinarySettlement
};

