const mongoose = require('mongoose');
const { toFixed4String } = require('../utils/decimal');

const OrderSchema = new mongoose.Schema(
  {
    order_number: {
      type: String,
      required: true,
      unique: true
    },
    buyer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    product_name: {
      type: String,
      default: 'Executive Fintech Builder Pack'
    },
    total_price: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      get: (v) => (v ? toFixed4String(v) : '0.0000')
    },
    bv: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      get: (v) => (v ? toFixed4String(v) : '0.0000')
    },
    period_id: {
      type: String,
      required: true,
      trim: true
    },
    status: {
      type: String,
      enum: ['PAID', 'REFUNDED'],
      default: 'PAID'
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

OrderSchema.index({ buyer_id: 1, period_id: 1 });
OrderSchema.index({ status: 1 });

module.exports = mongoose.model('Order', OrderSchema);

