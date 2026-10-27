const mongoose = require('mongoose');
const User = require('../models/User');
const VolumeLedger = require('../models/VolumeLedger');
const Order = require('../models/Order');
const WalletTransaction = require('../models/WalletTransaction');
const { registerDistributor } = require('../services/placementService');
const { processOrderAndCommissions } = require('../services/volumeAndCommissionService');
const { runBinarySettlement } = require('../services/binarySettlementService');
const { refundOrderAndClawback } = require('../services/clawbackService');
const { seedDatabase } = require('../scripts/seedData');
const { Decimal, toDecimal, toFixed4String, serializeDocument } = require('../utils/decimal');

const DEFAULT_PERIOD = process.env.ACTIVE_PERIOD || '202610';

/**
 * Helper to format a user + volume ledger into a clean serialized tree/list node
 */
function formatDistributorNode(userDoc, ledgerDoc, sponsorUsername = null) {
  const pv = ledgerDoc ? toFixed4String(ledgerDoc.pv) : '0.0000';
  const gvLeft = ledgerDoc ? toFixed4String(ledgerDoc.gv_left) : '0.0000';
  const gvRight = ledgerDoc ? toFixed4String(ledgerDoc.gv_right) : '0.0000';
  const carryLeft = ledgerDoc ? toFixed4String(ledgerDoc.carry_left) : '0.0000';
  const carryRight = ledgerDoc ? toFixed4String(ledgerDoc.carry_right) : '0.0000';
  const matchedVolumePaid = ledgerDoc ? toFixed4String(ledgerDoc.matched_volume_paid) : '0.0000';

  const totalLeft = toFixed4String(toDecimal(gvLeft).add(toDecimal(carryLeft)));
  const totalRight = toFixed4String(toDecimal(gvRight).add(toDecimal(carryRight)));

  return {
    _id: userDoc._id.toString(),
    node_type: 'DISTRIBUTOR',
    username: userDoc.username,
    full_name: userDoc.full_name,
    email: userDoc.email,
    rank_id: userDoc.rank_id,
    rank_cap: toFixed4String(userDoc.rank_cap || User.RANK_CAPS[userDoc.rank_id] || '5000.0000'),
    is_active: Boolean(userDoc.is_active),
    sponsor_id: userDoc.sponsor_id ? userDoc.sponsor_id.toString() : null,
    sponsor_username: sponsorUsername,
    sponsor_depth: userDoc.sponsor_depth || 0,
    placement_parent_id: userDoc.placement_parent_id
      ? userDoc.placement_parent_id.toString()
      : null,
    position: userDoc.position,
    placement_depth: userDoc.placement_depth || 0,
    binary_path: userDoc.binary_path,
    children_slots: {
      LEFT:
        userDoc.children_slots && userDoc.children_slots.LEFT
          ? userDoc.children_slots.LEFT.toString()
          : null,
      RIGHT:
        userDoc.children_slots && userDoc.children_slots.RIGHT
          ? userDoc.children_slots.RIGHT.toString()
          : null
    },
    metrics: {
      period_id: DEFAULT_PERIOD,
      pv,
      gv_left: gvLeft,
      gv_right: gvRight,
      carry_left: carryLeft,
      carry_right: carryRight,
      total_left: totalLeft,
      total_right: totalRight,
      matched_volume_paid: matchedVolumePaid
    }
  };
}

/**
 * POST /api/users/register
 */
async function registerUser(req, res) {
  try {
    const {
      username,
      full_name,
      email,
      rank_id,
      is_active,
      sponsorId,
      preferredLeg,
      placementParentId,
      position,
      initialBv
    } = req.body;

    if (!username || !full_name || !email) {
      return res.status(400).json({
        error: 'username, full_name, and email are required.'
      });
    }

    const registrationResult = await registerDistributor({
      username,
      full_name,
      email,
      rank_id: rank_id || 'SILVER',
      is_active: Boolean(is_active),
      sponsorId: sponsorId || null,
      preferredLeg: preferredLeg || 'LEFT',
      placementParentId: placementParentId || null,
      position: position || null,
      periodId: DEFAULT_PERIOD
    });

    let initialOrderTrace = null;
    if (initialBv && toDecimal(initialBv).gt(0)) {
      initialOrderTrace = await processOrderAndCommissions({
        buyerId: registrationResult.user._id,
        bvAmount: String(initialBv),
        productName: 'Enrollment Activation Pack',
        periodId: DEFAULT_PERIOD
      });
    }

    return res.status(201).json(
      serializeDocument({
        message: 'Distributor registered successfully.',
        placementMode: registrationResult.placementMode,
        placedUnder: registrationResult.placedUnder || null,
        user: registrationResult.user,
        initialOrderTrace
      })
    );
  } catch (err) {
    return res.status(400).json({
      error: err.message || 'Failed to register distributor.'
    });
  }
}

/**
 * GET /api/tree/:rootId?depth=3&treeType=binary|unilevel
 */
async function getTree(req, res) {
  try {
    const { rootId } = req.params;
    const depth = Math.min(Math.max(parseInt(req.query.depth || '3', 10), 1), 8);
    const treeType = (req.query.treeType || 'binary').toLowerCase();
    const periodId = req.query.periodId || DEFAULT_PERIOD;

    let rootUser = null;
    if (!rootId || rootId === 'root') {
      rootUser = await User.findOne({ position: 'ROOT' });
      if (!rootUser) {
        rootUser = await User.findOne().sort({ placement_depth: 1 });
      }
    } else if (mongoose.Types.ObjectId.isValid(rootId)) {
      rootUser = await User.findById(rootId);
    }

    if (!rootUser) {
      return res.status(404).json({
        error: 'Root distributor not found. Please run /api/seed first.'
      });
    }

    let subtreeUsers = [];

    if (treeType === 'unilevel') {
      const maxSponsorDepth = (rootUser.sponsor_depth || 0) + depth;
      subtreeUsers = await User.find({
        $or: [
          { _id: rootUser._id },
          {
            sponsor_ancestors: rootUser._id,
            sponsor_depth: { $lte: maxSponsorDepth }
          }
        ]
      }).sort({ sponsor_depth: 1, created_at: 1 });
    } else {
      const maxPlacementDepth = (rootUser.placement_depth || 0) + depth;
      subtreeUsers = await User.find({
        $or: [
          { _id: rootUser._id },
          {
            'placement_ancestors.user_id': rootUser._id,
            placement_depth: { $lte: maxPlacementDepth }
          }
        ]
      }).sort({ placement_depth: 1, position: 1 });
    }

    // Fetch all users' usernames for sponsor name resolution and breadcrumbs
    const allUsersMin = await User.find({}).select(
      '_id username full_name rank_id placement_depth sponsor_depth'
    );
    const usernameMap = new Map(allUsersMin.map((u) => [u._id.toString(), u]));

    // Fetch VolumeLedger metrics for all nodes in subtree
    const userIds = subtreeUsers.map((u) => u._id);
    const ledgers = await VolumeLedger.find({
      user_id: { $in: userIds },
      period_id: periodId
    });
    const ledgerMap = new Map(ledgers.map((l) => [l.user_id.toString(), l]));

    const nodes = [];
    const edges = [];

    for (const u of subtreeUsers) {
      const sponsorDoc = u.sponsor_id ? usernameMap.get(u.sponsor_id.toString()) : null;
      const formatted = formatDistributorNode(
        u,
        ledgerMap.get(u._id.toString()),
        sponsorDoc ? sponsorDoc.username : null
      );
      nodes.push(formatted);

      if (u._id.toString() !== rootUser._id.toString()) {
        if (treeType === 'unilevel' && u.sponsor_id) {
          edges.push({
            id: `e-uni-${u.sponsor_id.toString()}-${u._id.toString()}`,
            source: u.sponsor_id.toString(),
            target: u._id.toString(),
            edge_type: 'UNILEVEL',
            label: `Gen ${(u.sponsor_depth || 0) - (rootUser.sponsor_depth || 0)}`
          });
        } else if (treeType === 'binary' && u.placement_parent_id) {
          edges.push({
            id: `e-bin-${u.placement_parent_id.toString()}-${u._id.toString()}`,
            source: u.placement_parent_id.toString(),
            target: u._id.toString(),
            edge_type: 'BINARY',
            leg: u.position
          });
        }
      }

      // Add explicit EMPTY_SLOT virtual child nodes for Binary tree nodes within depth limit
      const relativeDepth = (u.placement_depth || 0) - (rootUser.placement_depth || 0);
      if (treeType === 'binary' && relativeDepth < depth) {
        const leftChildId = u.children_slots ? u.children_slots.LEFT : null;
        const rightChildId = u.children_slots ? u.children_slots.RIGHT : null;

        if (!leftChildId) {
          const emptyLeftId = `EMPTY_${u._id.toString()}_LEFT`;
          nodes.push({
            _id: emptyLeftId,
            node_type: 'EMPTY_SLOT',
            parent_id: u._id.toString(),
            parent_username: u.username,
            position: 'LEFT',
            placement_depth: (u.placement_depth || 0) + 1,
            label: '+ Vacant Left Slot'
          });
          edges.push({
            id: `e-empty-${u._id.toString()}-LEFT`,
            source: u._id.toString(),
            target: emptyLeftId,
            edge_type: 'EMPTY_SLOT',
            leg: 'LEFT'
          });
        }

        if (!rightChildId) {
          const emptyRightId = `EMPTY_${u._id.toString()}_RIGHT`;
          nodes.push({
            _id: emptyRightId,
            node_type: 'EMPTY_SLOT',
            parent_id: u._id.toString(),
            parent_username: u.username,
            position: 'RIGHT',
            placement_depth: (u.placement_depth || 0) + 1,
            label: '+ Vacant Right Slot'
          });
          edges.push({
            id: `e-empty-${u._id.toString()}-RIGHT`,
            source: u._id.toString(),
            target: emptyRightId,
            edge_type: 'EMPTY_SLOT',
            leg: 'RIGHT'
          });
        }
      }
    }

    // Build top-down breadcrumbs from global root to current rootUser
    let ancestorIdsTopDown = [];
    if (treeType === 'unilevel') {
      ancestorIdsTopDown = [...(rootUser.sponsor_ancestors || [])]
        .map((id) => id.toString())
        .reverse();
    } else {
      ancestorIdsTopDown = [...(rootUser.placement_ancestors || [])]
        .map((a) => a.user_id.toString())
        .reverse();
    }

    const breadcrumbs = [
      ...ancestorIdsTopDown.map((id) => {
        const info = usernameMap.get(id);
        return {
          _id: id,
          username: info ? info.username : 'Ancestor',
          rank_id: info ? info.rank_id : 'SILVER'
        };
      }),
      {
        _id: rootUser._id.toString(),
        username: rootUser.username,
        rank_id: rootUser.rank_id
      }
    ];

    return res.json({
      tree_type: treeType,
      period_id: periodId,
      depth,
      root: nodes.find((n) => n._id === rootUser._id.toString()),
      breadcrumbs,
      nodes,
      edges
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Failed to load genealogy tree.'
    });
  }
}

/**
 * GET /api/users
 */
async function listUsers(req, res) {
  try {
    const periodId = req.query.periodId || DEFAULT_PERIOD;
    const users = await User.find({}).sort({ placement_depth: 1, created_at: 1 });
    const ledgers = await VolumeLedger.find({ period_id: periodId });
    const ledgerMap = new Map(ledgers.map((l) => [l.user_id.toString(), l]));
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const formatted = users.map((u) => {
      const sponsorDoc = u.sponsor_id ? userMap.get(u.sponsor_id.toString()) : null;
      return formatDistributorNode(
        u,
        ledgerMap.get(u._id.toString()),
        sponsorDoc ? sponsorDoc.username : null
      );
    });

    return res.json({
      period_id: periodId,
      count: formatted.length,
      users: formatted
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/orders
 */
async function createOrder(req, res) {
  try {
    const { buyerId, bv, totalPrice, productName, periodId } = req.body;
    if (!buyerId || bv === undefined || bv === null) {
      return res.status(400).json({
        error: 'buyerId and bv are required.'
      });
    }

    const result = await processOrderAndCommissions({
      buyerId,
      bvAmount: String(bv),
      totalPrice: totalPrice ? String(totalPrice) : undefined,
      productName: productName || 'Executive Fintech Builder Pack',
      periodId: periodId || DEFAULT_PERIOD
    });

    return res.status(201).json(serializeDocument(result));
  } catch (err) {
    return res.status(400).json({
      error: err.message || 'Order processing failed.'
    });
  }
}

/**
 * GET /api/orders
 */
async function listOrders(req, res) {
  try {
    const orders = await Order.find({})
      .populate('buyer_id', 'username full_name rank_id is_active')
      .sort({ created_at: -1 })
      .limit(50);

    return res.json({
      orders: serializeDocument(orders)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/orders/:orderId/refund
 */
async function refundOrder(req, res) {
  try {
    const { orderId } = req.params;
    const result = await refundOrderAndClawback(orderId);
    return res.json(serializeDocument(result));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

/**
 * POST /api/settlement/run-binary
 */
async function executeBinarySettlement(req, res) {
  try {
    const periodId = (req.body && req.body.periodId) || DEFAULT_PERIOD;
    const settlementResult = await runBinarySettlement(periodId);
    return res.json(serializeDocument(settlementResult));
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Binary settlement failed.'
    });
  }
}

/**
 * GET /api/users/:id/dashboard
 */
async function getUserDashboard(req, res) {
  try {
    const { id } = req.params;
    const periodId = req.query.periodId || DEFAULT_PERIOD;

    let user = null;
    if (id === 'root') {
      user = await User.findOne({ position: 'ROOT' });
    } else if (mongoose.Types.ObjectId.isValid(id)) {
      user = await User.findById(id);
    }

    if (!user) {
      return res.status(404).json({ error: 'Distributor not found.' });
    }

    const [ledger, sponsor, placementParent, transactions, directRecruitsCount] =
      await Promise.all([
        VolumeLedger.findOne({ user_id: user._id, period_id: periodId }),
        user.sponsor_id ? User.findById(user.sponsor_id).select('username full_name rank_id') : null,
        user.placement_parent_id
          ? User.findById(user.placement_parent_id).select('username full_name rank_id')
          : null,
        WalletTransaction.find({ user_id: user._id })
          .populate('source_order_id', 'order_number bv status')
          .sort({ created_at: -1 }),
        User.countDocuments({ sponsor_id: user._id })
      ]);

    // Aggregate immutable double-entry ledger using Decimal.js
    const breakdown = {
      DIRECT_BONUS: new Decimal('0.0000'),
      UNILEVEL_BONUS: new Decimal('0.0000'),
      BINARY_MATCH: new Decimal('0.0000'),
      WITHDRAWAL: new Decimal('0.0000'),
      CLAWBACK: new Decimal('0.0000')
    };
    let clearedBalance = new Decimal('0.0000');
    let escrowBalance = new Decimal('0.0000');

    for (const tx of transactions) {
      const amt = toDecimal(tx.amount);
      if (tx.status === 'CLEARED') {
        clearedBalance = clearedBalance.add(amt);
        if (breakdown[tx.tx_type] !== undefined) {
          breakdown[tx.tx_type] = breakdown[tx.tx_type].add(amt);
        }
      } else if (tx.status === 'ESCROW') {
        escrowBalance = escrowBalance.add(amt);
      }
    }

    const formattedUser = formatDistributorNode(
      user,
      ledger,
      sponsor ? sponsor.username : null
    );

    return res.json(
      serializeDocument({
        user: {
          ...formattedUser,
          direct_recruits_count: directRecruitsCount,
          sponsor_info: sponsor
            ? {
                _id: sponsor._id.toString(),
                username: sponsor.username,
                full_name: sponsor.full_name,
                rank_id: sponsor.rank_id
              }
            : null,
          placement_parent_info: placementParent
            ? {
                _id: placementParent._id.toString(),
                username: placementParent.username,
                full_name: placementParent.full_name,
                rank_id: placementParent.rank_id
              }
            : null
        },
        wallet: {
          cleared_balance: toFixed4String(clearedBalance),
          escrow_balance: toFixed4String(escrowBalance),
          breakdown: {
            DIRECT_BONUS: toFixed4String(breakdown.DIRECT_BONUS),
            UNILEVEL_BONUS: toFixed4String(breakdown.UNILEVEL_BONUS),
            BINARY_MATCH: toFixed4String(breakdown.BINARY_MATCH),
            WITHDRAWAL: toFixed4String(breakdown.WITHDRAWAL),
            CLAWBACK: toFixed4String(breakdown.CLAWBACK)
          },
          transaction_count: transactions.length
        },
        volume_ledger: formattedUser.metrics,
        transactions: transactions.map((t) => ({
          _id: t._id.toString(),
          idempotency_key: t.idempotency_key,
          tx_type: t.tx_type,
          amount: toFixed4String(t.amount),
          status: t.status,
          period_id: t.period_id,
          description: t.description,
          source_order: t.source_order_id
            ? {
                _id: t.source_order_id._id.toString(),
                order_number: t.source_order_id.order_number,
                bv: toFixed4String(t.source_order_id.bv),
                status: t.source_order_id.status
              }
            : null,
          metadata: t.metadata || {},
          created_at: t.created_at
        }))
      })
    );
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Failed to load distributor dashboard.'
    });
  }
}

/**
 * POST /api/seed
 */
async function seedNetwork(req, res) {
  try {
    const result = await seedDatabase(DEFAULT_PERIOD);
    return res.json(serializeDocument(result));
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Failed to seed demo network.'
    });
  }
}

module.exports = {
  registerUser,
  getTree,
  listUsers,
  createOrder,
  listOrders,
  refundOrder,
  executeBinarySettlement,
  getUserDashboard,
  seedNetwork
};

