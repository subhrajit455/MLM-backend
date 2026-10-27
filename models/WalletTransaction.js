const mongoose = require('mongoose');
const { toFixed4String } = require('../utils/decimal');

const WalletTransactionSchema = new mongoose.Schema(
  {
    idempotency_key: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    source_order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null
    },
    period_id: {
      type: String,
      default: '202610'
    },
    tx_type: {
      type: String,
      enum: ['DIRECT_BONUS', 'UNILEVEL_BONUS', 'BINARY_MATCH', 'WITHDRAWAL', 'CLAWBACK'],
      required: true
    },
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      get: (v) => (v ? toFixed4String(v) : '0.0000')
    },
    status: {
      type: String,
      enum: ['ESCROW', 'CLEARED', 'REVERSED'],
      default: 'CLEARED'
    },
    description: {
      type: String,
      default: ''
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

WalletTransactionSchema.index({ user_id: 1, status: 1, created_at: -1 });
WalletTransactionSchema.index({ source_order_id: 1 });
WalletTransactionSchema.index({ tx_type: 1 });

module.exports = mongoose.model('WalletTransaction', WalletTransactionSchema);

