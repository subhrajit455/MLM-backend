const User = require('../models/User');
const Order = require('../models/Order');
const VolumeLedger = require('../models/VolumeLedger');
const WalletTransaction = require('../models/WalletTransaction');
const { Decimal, toDecimal, toDecimal128, toFixed4String } = require('../utils/decimal');
const { runWithTransactionOrFallback } = require('../utils/transactionHelper');

// 5-Level Unilevel Commission Rates: Level 1 = 10%, Level 2 = 5%, Level 3 = 3%, Level 4 = 2%, Level 5 = 1%
const UNILEVEL_RATES = [
  new Decimal('0.10'),
  new Decimal('0.05'),
  new Decimal('0.03'),
  new Decimal('0.02'),
  new Decimal('0.01')
];

const DIRECT_BONUS_RATE = new Decimal('0.10');
const QUALIFICATION_PV_THRESHOLD = new Decimal('100.0000');

/**
 * Processes an order purchase:
 * 1. Creates the PAID Order record.
 * 2. Executes Single-Round-Trip Volume Roll-Up via VolumeLedger.bulkWrite() for buyer PV & binary ancestors GV.
 * 3. Evaluates buyer monthly qualification (activates buyer if PV >= 100).
 * 4. Credits Direct Sponsor Bonus (10% of BV) with idempotency key DIRECT_${orderId}_${sponsorId}.
 * 5. Executes 5-Level Unilevel Commission with true Dynamic Compression.
 * 6. Returns a detailed trace for the Commission Simulator UI.
 */
async function processOrderAndCommissions({
  buyerId,
  bvAmount,
  totalPrice,
  productName = 'Executive Fintech Builder Pack',
  periodId = process.env.ACTIVE_PERIOD || '202610'
}) {
  const bvDec = toDecimal(bvAmount);
  if (bvDec.lte(0)) {
    throw new Error('Order BV must be strictly greater than zero.');
  }
  const priceDec = totalPrice ? toDecimal(totalPrice) : bvDec.mul(new Decimal('18.00'));

  return await runWithTransactionOrFallback(async (session) => {
    const sessionOpts = session ? { session } : {};

    const buyer = await User.findById(buyerId).session(session);
    if (!buyer) {
      throw new Error('Buyer distributor not found.');
    }

    // 1. Create the Order document
    const randomSuffix = Math.floor(100000 + Math.random() * 900000);
    const orderNumber = `ORD-${periodId}-${Date.now().toString().slice(-5)}-${randomSuffix}`;

    const order = new Order({
      order_number: orderNumber,
      buyer_id: buyer._id,
      product_name: productName,
      total_price: toDecimal128(priceDec),
      bv: toDecimal128(bvDec),
      period_id: periodId,
      status: 'PAID'
    });
    await order.save(sessionOpts);

    const bvDec128 = toDecimal128(bvDec);
    const zeroDec128 = toDecimal128('0.0000');

    // 2. Single-Round-Trip Volume Roll-Up using VolumeLedger.bulkWrite()
    const bulkOps = [];

    // Operation A: Increment buyer's personal volume (PV)
    bulkOps.push({
      updateOne: {
        filter: { user_id: buyer._id, period_id: periodId },
        update: {
          $inc: { pv: bvDec128 },
          $setOnInsert: {
            gv_left: zeroDec128,
            gv_right: zeroDec128,
            carry_left: zeroDec128,
            carry_right: zeroDec128,
            matched_volume_paid: zeroDec128
          }
        },
        upsert: true
      }
    });

    // Operation B: Increment gv_left or gv_right for every binary placement ancestor in a single bulkWrite
    const placementAncestors = buyer.placement_ancestors || [];
    for (const anc of placementAncestors) {
      const isLeft = anc.leg === 'LEFT';
      const incField = isLeft ? { gv_left: bvDec128 } : { gv_right: bvDec128 };
      const setOnInsertFields = isLeft
        ? {
            pv: zeroDec128,
            gv_right: zeroDec128,
            carry_left: zeroDec128,
            carry_right: zeroDec128,
            matched_volume_paid: zeroDec128
          }
        : {
            pv: zeroDec128,
            gv_left: zeroDec128,
            carry_left: zeroDec128,
            carry_right: zeroDec128,
            matched_volume_paid: zeroDec128
          };

      bulkOps.push({
        updateOne: {
          filter: { user_id: anc.user_id, period_id: periodId },
          update: {
            $inc: incField,
            $setOnInsert: setOnInsertFields
          },
          upsert: true
        }
      });
    }

    if (bulkOps.length > 0) {
      await VolumeLedger.bulkWrite(bulkOps, sessionOpts);
    }

    // Check buyer's updated PV & auto-activate if pv >= 100
    const buyerLedger = await VolumeLedger.findOne({
      user_id: buyer._id,
      period_id: periodId
    }).session(session);

    const newBuyerPv = toDecimal(buyerLedger ? buyerLedger.pv : bvDec);
    let buyerActivatedNow = false;
    if (newBuyerPv.gte(QUALIFICATION_PV_THRESHOLD) && !buyer.is_active) {
      buyer.is_active = true;
      await buyer.save(sessionOpts);
      buyerActivatedNow = true;
    }

    // Fetch binary ancestor user details for the visual trace
    const binaryAncestorIds = placementAncestors.map((a) => a.user_id);
    const binaryAncestorDocs = await User.find({ _id: { $in: binaryAncestorIds } })
      .select('_id username full_name rank_id is_active placement_depth')
      .session(session);
    const binaryMap = new Map(binaryAncestorDocs.map((u) => [u._id.toString(), u]));

    const binaryLedgerDocs = await VolumeLedger.find({
      user_id: { $in: binaryAncestorIds },
      period_id: periodId
    }).session(session);
    const binaryLedgerMap = new Map(binaryLedgerDocs.map((l) => [l.user_id.toString(), l]));

    const binaryRollupTrace = placementAncestors.map((anc, idx) => {
      const u = binaryMap.get(anc.user_id.toString());
      const l = binaryLedgerMap.get(anc.user_id.toString());
      return {
        hop: idx + 1,
        user_id: anc.user_id.toString(),
        username: u ? u.username : 'Unknown',
        full_name: u ? u.full_name : 'Unknown',
        rank_id: u ? u.rank_id : 'SILVER',
        is_active: u ? u.is_active : false,
        leg: anc.leg,
        bv_added: toFixed4String(bvDec),
        new_gv_left: l ? toFixed4String(l.gv_left) : '0.0000',
        new_gv_right: l ? toFixed4String(l.gv_right) : '0.0000'
      };
    });

    // 3. Direct Sponsor Bonus (10% of order.bv to buyer.sponsor_id)
    let directBonusTrace = null;
    const walletTransactionsCreated = [];

    if (buyer.sponsor_id) {
      const sponsor = await User.findById(buyer.sponsor_id).session(session);
      if (sponsor) {
        const directAmount = bvDec.mul(DIRECT_BONUS_RATE).toDecimalPlaces(4, Decimal.ROUND_DOWN);
        const directIdempotencyKey = `DIRECT_${order._id.toString()}_${sponsor._id.toString()}`;

        if (directAmount.gt(0)) {
          const directTx = await WalletTransaction.findOneAndUpdate(
            { idempotency_key: directIdempotencyKey },
            {
              $setOnInsert: {
                idempotency_key: directIdempotencyKey,
                user_id: sponsor._id,
                source_order_id: order._id,
                period_id: periodId,
                tx_type: 'DIRECT_BONUS',
                amount: toDecimal128(directAmount),
                status: 'CLEARED',
                description: `10% Direct Sponsor Bonus from ${buyer.username} (${order.order_number})`,
                metadata: {
                  buyer_id: buyer._id.toString(),
                  buyer_username: buyer.username,
                  order_bv: toFixed4String(bvDec),
                  rate: '10%'
                }
              }
            },
            { upsert: true, new: true, ...sessionOpts }
          );

          walletTransactionsCreated.push(directTx);
          directBonusTrace = {
            sponsor_id: sponsor._id.toString(),
            username: sponsor.username,
            full_name: sponsor.full_name,
            rank_id: sponsor.rank_id,
            rate: '10%',
            amount: toFixed4String(directAmount),
            idempotency_key: directIdempotencyKey
          };
        }
      }
    }

    // 4. Unilevel Commission with Dynamic Compression (5 Paid Levels: 10%, 5%, 3%, 2%, 1%)
    const sponsorAncestorIds = buyer.sponsor_ancestors || [];
    const sponsorAncestorDocs = await User.find({ _id: { $in: sponsorAncestorIds } })
      .select('_id username full_name rank_id is_active sponsor_depth')
      .session(session);
    const sponsorMap = new Map(sponsorAncestorDocs.map((u) => [u._id.toString(), u]));

    let paidLevelIndex = 0; // 0 to 4 (tracks compressed paid levels 1..5)
    const unilevelCompressionTrace = [];

    for (let rawIdx = 0; rawIdx < sponsorAncestorIds.length; rawIdx++) {
      const ancId = sponsorAncestorIds[rawIdx];
      const ancUser = sponsorMap.get(ancId.toString());
      if (!ancUser) continue;

      const physicalGeneration = rawIdx + 1;

      // If all 5 levels have already been paid, record remaining ancestors as beyond max paid depth
      if (paidLevelIndex >= UNILEVEL_RATES.length) {
        unilevelCompressionTrace.push({
          physical_generation: physicalGeneration,
          paid_level: null,
          user_id: ancUser._id.toString(),
          username: ancUser.username,
          full_name: ancUser.full_name,
          rank_id: ancUser.rank_id,
          is_active: ancUser.is_active,
          status: 'MAX_LEVELS_REACHED',
          rate: '0%',
          amount: '0.0000',
          idempotency_key: null,
          note: 'Beyond 5 paid Unilevel levels'
        });
        continue;
      }

      // DYNAMIC COMPRESSION RULE:
      // If ancestor has is_active === false, skip them WITHOUT incrementing paidLevelIndex
      if (!ancUser.is_active) {
        unilevelCompressionTrace.push({
          physical_generation: physicalGeneration,
          paid_level: null,
          user_id: ancUser._id.toString(),
          username: ancUser.username,
          full_name: ancUser.full_name,
          rank_id: ancUser.rank_id,
          is_active: false,
          status: 'SKIPPED_INACTIVE_COMPRESSED',
          rate: '0%',
          amount: '0.0000',
          idempotency_key: null,
          note: `Inactive distributor skipped — Level ${paidLevelIndex + 1} (${UNILEVEL_RATES[
            paidLevelIndex
          ]
            .mul(100)
            .toString()}%) compresses upward to next active upline`
        });
        continue;
      }

      // Active ancestor claims the current compressed level (paidLevelIndex + 1)
      const currentPaidLevel = paidLevelIndex + 1;
      const rateDec = UNILEVEL_RATES[paidLevelIndex];
      const payoutDec = bvDec.mul(rateDec).toDecimalPlaces(4, Decimal.ROUND_DOWN);
      const unilevelIdempotencyKey = `UNILEVEL_${order._id.toString()}_L${currentPaidLevel}_${ancUser._id.toString()}`;

      if (payoutDec.gt(0)) {
        const uniTx = await WalletTransaction.findOneAndUpdate(
          { idempotency_key: unilevelIdempotencyKey },
          {
            $setOnInsert: {
              idempotency_key: unilevelIdempotencyKey,
              user_id: ancUser._id,
              source_order_id: order._id,
              period_id: periodId,
              tx_type: 'UNILEVEL_BONUS',
              amount: toDecimal128(payoutDec),
              status: 'CLEARED',
              description: `Unilevel L${currentPaidLevel} (${rateDec.mul(100).toString()}%) Bonus from ${buyer.username} [Gen ${physicalGeneration}]`,
              metadata: {
                buyer_id: buyer._id.toString(),
                buyer_username: buyer.username,
                order_bv: toFixed4String(bvDec),
                paid_level: currentPaidLevel,
                physical_generation: physicalGeneration,
                compressed_levels: physicalGeneration - currentPaidLevel,
                rate: `${rateDec.mul(100).toString()}%`
              }
            }
          },
          { upsert: true, new: true, ...sessionOpts }
        );
        walletTransactionsCreated.push(uniTx);
      }

      unilevelCompressionTrace.push({
        physical_generation: physicalGeneration,
        paid_level: currentPaidLevel,
        user_id: ancUser._id.toString(),
        username: ancUser.username,
        full_name: ancUser.full_name,
        rank_id: ancUser.rank_id,
        is_active: true,
        status:
          physicalGeneration > currentPaidLevel ? 'PAID_WITH_COMPRESSION' : 'PAID_STANDARD',
        compressed_up_by: physicalGeneration - currentPaidLevel,
        rate: `${rateDec.mul(100).toString()}%`,
        amount: toFixed4String(payoutDec),
        idempotency_key: unilevelIdempotencyKey,
        note:
          physicalGeneration > currentPaidLevel
            ? `Compressed upward from Generation ${physicalGeneration} to claim Paid Level ${currentPaidLevel}`
            : `Claimed Paid Level ${currentPaidLevel} directly`
      });

      paidLevelIndex += 1;
    }

    return {
      order,
      buyer: {
        _id: buyer._id.toString(),
        username: buyer.username,
        full_name: buyer.full_name,
        is_active: buyer.is_active,
        buyer_activated_now: buyerActivatedNow,
        new_pv: toFixed4String(newBuyerPv)
      },
      binaryRollupTrace,
      directBonusTrace,
      unilevelCompressionTrace,
      transactionsCount: walletTransactionsCreated.length
    };
  });
}

module.exports = {
  processOrderAndCommissions,
  UNILEVEL_RATES,
  DIRECT_BONUS_RATE
};

