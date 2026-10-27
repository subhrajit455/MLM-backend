const mongoose = require('mongoose');
const User = require('../models/User');
const VolumeLedger = require('../models/VolumeLedger');
const { toDecimal128 } = require('../utils/decimal');
const { runWithTransactionOrFallback } = require('../utils/transactionHelper');

/**
 * Traverses down the extreme left or extreme right leg starting from sponsorNode
 * until it finds a node whose target slot (`children_slots.LEFT` or `children_slots.RIGHT`) is null.
 */
async function findExtremeLegTarget(startNodeId, legDirection, session = null) {
  const normalizedLeg =
    legDirection === 'OUTER_RIGHT' || legDirection === 'RIGHT' ? 'RIGHT' : 'LEFT';

  let currentNode = await User.findById(startNodeId).session(session);
  if (!currentNode) {
    throw new Error(`Sponsor node ${startNodeId} not found for spillover traversal.`);
  }

  let safetyCounter = 0;
  while (currentNode.children_slots && currentNode.children_slots[normalizedLeg] !== null) {
    safetyCounter += 1;
    if (safetyCounter > 2000) {
      throw new Error('Max binary tree depth exceeded during spillover search.');
    }
    const nextNodeId = currentNode.children_slots[normalizedLeg];
    const nextNode = await User.findById(nextNodeId).session(session);
    if (!nextNode) {
      // Slot pointed to missing doc; treat current slot as vacant
      break;
    }
    currentNode = nextNode;
  }

  return {
    parentNode: currentNode,
    targetLeg: normalizedLeg
  };
}

/**
 * Registers a new distributor in both the Unilevel (Sponsor) Tree and Binary (Placement) Tree
 * with optimistic concurrency locking and transaction safety.
 */
async function registerDistributor({
  username,
  full_name,
  email,
  rank_id = 'SILVER',
  is_active = false,
  sponsorId,
  preferredLeg = 'LEFT', // 'LEFT' | 'RIGHT' | 'OUTER_LEFT' | 'OUTER_RIGHT'
  placementParentId = null,
  position = null, // 'LEFT' | 'RIGHT'
  periodId = process.env.ACTIVE_PERIOD || '202610'
}) {
  return await runWithTransactionOrFallback(async (session) => {
    const sessionOpts = session ? { session } : {};

    // Check if root user exists
    const existingCount = await User.countDocuments({}, sessionOpts);
    const rankCapStr = User.RANK_CAPS[rank_id] || '5000.0000';

    if (existingCount === 0 && !sponsorId && !placementParentId) {
      const rootId = new mongoose.Types.ObjectId();
      const rootUser = new User({
        _id: rootId,
        username,
        full_name,
        email,
        rank_id,
        rank_cap: toDecimal128(rankCapStr),
        is_active: Boolean(is_active),
        sponsor_id: null,
        sponsor_ancestors: [],
        sponsor_depth: 0,
        placement_parent_id: null,
        position: 'ROOT',
        placement_depth: 0,
        binary_path: `/${rootId.toString()}/`,
        placement_ancestors: [],
        children_slots: { LEFT: null, RIGHT: null }
      });

      await rootUser.save(sessionOpts);

      await VolumeLedger.findOneAndUpdate(
        { user_id: rootId, period_id: periodId },
        {
          $setOnInsert: {
            pv: toDecimal128('0.0000'),
            gv_left: toDecimal128('0.0000'),
            gv_right: toDecimal128('0.0000'),
            carry_left: toDecimal128('0.0000'),
            carry_right: toDecimal128('0.0000')
          }
        },
        { upsert: true, new: true, ...sessionOpts }
      );

      return {
        user: rootUser,
        placementMode: 'ROOT'
      };
    }

    // Resolve sponsor (defaults to root user if not specified)
    let sponsor = null;
    if (sponsorId) {
      sponsor = await User.findById(sponsorId).session(session);
    } else {
      sponsor = await User.findOne({ position: 'ROOT' }).session(session);
    }
    if (!sponsor) {
      throw new Error('Valid sponsor is required to register a distributor.');
    }

    // Determine placement target: Manual Vacant-Slot vs Auto Extreme-Leg Spillover
    const isManualPlacement = Boolean(placementParentId && position);
    let maxAttempts = isManualPlacement ? 1 : 5;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;

      let parentNode = null;
      let targetLeg = null;

      if (isManualPlacement) {
        targetLeg = position === 'RIGHT' ? 'RIGHT' : 'LEFT';
        parentNode = await User.findById(placementParentId).session(session);
        if (!parentNode) {
          throw new Error('Specified placement parent distributor does not exist.');
        }
        if (parentNode.children_slots && parentNode.children_slots[targetLeg] !== null) {
          throw new Error(
            `Binary slot ${targetLeg} under ${parentNode.username} is already occupied.`
          );
        }
      } else {
        const spilloverTarget = await findExtremeLegTarget(sponsor._id, preferredLeg, session);
        parentNode = spilloverTarget.parentNode;
        targetLeg = spilloverTarget.targetLeg;
      }

      const newUserId = new mongoose.Types.ObjectId();

      // Optimistic Concurrency Lock: claim the parent's null slot atomically
      const slotField = `children_slots.${targetLeg}`;
      const lockUpdate = await User.updateOne(
        {
          _id: parentNode._id,
          [slotField]: null
        },
        {
          $set: { [slotField]: newUserId }
        },
        sessionOpts
      );

      if (lockUpdate.modifiedCount === 0) {
        if (isManualPlacement) {
          throw new Error(
            `Concurrency conflict: Binary slot ${targetLeg} under ${parentNode.username} was just taken.`
          );
        }
        // Retry auto-spillover on race condition
        continue;
      }

      // Build bottom-up sponsor_ancestors: [immediateSponsorId, ...sponsor.sponsor_ancestors]
      const sponsorAncestors = [sponsor._id, ...(sponsor.sponsor_ancestors || [])];
      const sponsorDepth = (sponsor.sponsor_depth || 0) + 1;

      // Build bottom-up placement_ancestors: [{ user_id, leg, depth }, ...parentNode.placement_ancestors]
      const placementAncestors = [
        {
          user_id: parentNode._id,
          leg: targetLeg,
          depth: parentNode.placement_depth || 0
        },
        ...(parentNode.placement_ancestors || []).map((a) => ({
          user_id: a.user_id,
          leg: a.leg,
          depth: a.depth
        }))
      ];
      const placementDepth = (parentNode.placement_depth || 0) + 1;
      const legCode = targetLeg === 'LEFT' ? 'L' : 'R';
      const binaryPath = `${parentNode.binary_path || `/${parentNode._id}/`}${legCode}/${newUserId.toString()}/`;

      const newUser = new User({
        _id: newUserId,
        username,
        full_name,
        email,
        rank_id,
        rank_cap: toDecimal128(rankCapStr),
        is_active: Boolean(is_active),
        sponsor_id: sponsor._id,
        sponsor_ancestors: sponsorAncestors,
        sponsor_depth: sponsorDepth,
        placement_parent_id: parentNode._id,
        position: targetLeg,
        placement_depth: placementDepth,
        binary_path: binaryPath,
        placement_ancestors: placementAncestors,
        children_slots: { LEFT: null, RIGHT: null }
      });

      try {
        await newUser.save(sessionOpts);
      } catch (saveErr) {
        // If we are in standalone fallback (no transaction), rollback the parent's slot if user save failed
        if (!session) {
          await User.updateOne(
            { _id: parentNode._id, [slotField]: newUserId },
            { $set: { [slotField]: null } }
          );
        }
        throw saveErr;
      }

      // Initialize current period VolumeLedger bucket
      await VolumeLedger.findOneAndUpdate(
        { user_id: newUserId, period_id: periodId },
        {
          $setOnInsert: {
            pv: toDecimal128('0.0000'),
            gv_left: toDecimal128('0.0000'),
            gv_right: toDecimal128('0.0000'),
            carry_left: toDecimal128('0.0000'),
            carry_right: toDecimal128('0.0000')
          }
        },
        { upsert: true, new: true, ...sessionOpts }
      );

      return {
        user: newUser,
        placementMode: isManualPlacement ? 'MANUAL_VACANT_SLOT' : `AUTO_SPILLOVER_${targetLeg}`,
        placedUnder: {
          _id: parentNode._id,
          username: parentNode.username,
          position: targetLeg,
          depth: placementDepth
        }
      };
    }

    throw new Error('Unable to acquire binary placement lock after multiple attempts.');
  });
}

module.exports = {
  registerDistributor,
  findExtremeLegTarget
};

