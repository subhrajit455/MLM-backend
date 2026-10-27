const mongoose = require('mongoose');
const { toFixed4String } = require('../utils/decimal');

const PlacementAncestorSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    leg: {
      type: String,
      enum: ['LEFT', 'RIGHT'],
      required: true
    },
    depth: {
      type: Number,
      required: true
    }
  },
  { _id: false }
);

const RANK_CAPS = {
  STARTER: '1000.0000',
  BRONZE: '2500.0000',
  SILVER: '5000.0000',
  GOLD: '10000.0000',
  PLATINUM: '25000.0000',
  DIAMOND: '50000.0000',
  CROWN_DIAMOND: '100000.0000'
};

const UserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    full_name: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    rank_id: {
      type: String,
      enum: ['STARTER', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'CROWN_DIAMOND'],
      default: 'SILVER'
    },
    rank_cap: {
      type: mongoose.Schema.Types.Decimal128,
      default: () => mongoose.Types.Decimal128.fromString('5000.0000'),
      get: (v) => (v ? toFixed4String(v) : '5000.0000')
    },
    is_active: {
      type: Boolean,
      default: false
    },

    // --- 1. SPONSOR TREE (UNILEVEL) ---
    sponsor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    // Ordered bottom-up: index 0 is immediate sponsor, index N is root
    sponsor_ancestors: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      }
    ],
    sponsor_depth: {
      type: Number,
      default: 0
    },

    // --- 2. PLACEMENT TREE (BINARY) ---
    placement_parent_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    position: {
      type: String,
      enum: ['LEFT', 'RIGHT', 'ROOT'],
      required: true
    },
    placement_depth: {
      type: Number,
      default: 0
    },
    // Materialized path e.g. "/rootId/L/nodeId/R/"
    binary_path: {
      type: String,
      default: ''
    },
    // Ordered bottom-up: index 0 is immediate binary placement parent
    placement_ancestors: {
      type: [PlacementAncestorSchema],
      default: []
    },
    children_slots: {
      LEFT: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
      },
      RIGHT: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
      }
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

// Strict unique partial index preventing two users from occupying the same Binary slot
UserSchema.index(
  { placement_parent_id: 1, position: 1 },
  {
    unique: true,
    partialFilterExpression: {
      placement_parent_id: { $type: 'objectId' }
    }
  }
);

// Multikey & compound indexes for high-speed tree traversals and roll-ups
UserSchema.index({ sponsor_id: 1 });
UserSchema.index({ sponsor_ancestors: 1 });
UserSchema.index({ 'placement_ancestors.user_id': 1, 'placement_ancestors.leg': 1 });
UserSchema.index({ binary_path: 1 });
UserSchema.index({ placement_depth: 1 });

UserSchema.statics.RANK_CAPS = RANK_CAPS;

module.exports = mongoose.model('User', UserSchema);

