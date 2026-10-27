const Decimal = require('decimal.js');
const mongoose = require('mongoose');

// Configure Decimal.js globally for financial precision and ROUND_DOWN
Decimal.set({
  precision: 34,
  rounding: Decimal.ROUND_DOWN
});

/**
 * Converts any string, Decimal, or Decimal128 to a Decimal instance
 */
function toDecimal(val) {
  if (val === null || val === undefined) {
    return new Decimal('0.0000');
  }
  if (val instanceof Decimal) {
    return val;
  }
  if (val instanceof mongoose.Types.Decimal128 || (val && val._bsontype === 'Decimal128')) {
    return new Decimal(val.toString());
  }
  return new Decimal(String(val));
}

/**
 * Formats a value to a 4-decimal-place string using ROUND_DOWN
 */
function toFixed4String(val) {
  return toDecimal(val).toDecimalPlaces(4, Decimal.ROUND_DOWN).toFixed(4);
}

/**
 * Converts a value into mongoose.Types.Decimal128 rounded down to 4 decimal places
 */
function toDecimal128(val) {
  const fixedStr = toFixed4String(val);
  return mongoose.Types.Decimal128.fromString(fixedStr);
}

/**
 * Recursively transforms mongoose documents/objects so all Decimal128 values become 4-decimal strings
 */
function serializeDocument(obj) {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof mongoose.Types.Decimal128 || (obj && obj._bsontype === 'Decimal128')) {
    return toFixed4String(obj.toString());
  }
  if (obj instanceof mongoose.Types.ObjectId || (obj && obj._bsontype === 'ObjectId')) {
    return obj.toString();
  }
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (Array.isArray(obj)) {
    return obj.map(serializeDocument);
  }
  if (typeof obj === 'object') {
    const raw = typeof obj.toObject === 'function' ? obj.toObject() : obj;
    const result = {};
    for (const [key, value] of Object.entries(raw)) {
      result[key] = serializeDocument(value);
    }
    return result;
  }
  return obj;
}

module.exports = {
  Decimal,
  toDecimal,
  toFixed4String,
  toDecimal128,
  serializeDocument
};

