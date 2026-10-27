const mongoose = require('mongoose');
const { toFixed4String } = require('../utils/decimal');

const decField = () => ({
  type: mongoose.Schema.Types.Decimal128,
  default: () => mongoose.Types.Decimal128.fromString('0.0000'),
  get: (v) => (v ? toFixed4String(v) : '0.0000')
});

const VolumeLedgerSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    period_id: {
      type: String,
      required: true,
      trim: true
    },
    pv: decField(),
    gv_left: decField(),
    gv_right: decField(),
    carry_left: decField(),
    carry_right: decField(),
    matched_volume_paid: decField(),
    last_settled_at: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

// Unique index on { user_id: 1, period_id: 1 }
VolumeLedgerSchema.index({ user_id: 1, period_id: 1 }, { unique: true });
VolumeLedgerSchema.index({ period_id: 1 });

module.exports = mongoose.model('VolumeLedger', VolumeLedgerSchema);

