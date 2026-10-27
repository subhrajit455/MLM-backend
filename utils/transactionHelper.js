const mongoose = require('mongoose');

let replicaSetSupported = null;

/**
 * Executes a callback inside a MongoDB session transaction if replica sets are enabled,
 * with a clean automatic fallback for standalone local MongoDB instances.
 */
async function runWithTransactionOrFallback(workFn) {
  if (replicaSetSupported === false) {
    return await workFn(null);
  }

  let session = null;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
    const result = await workFn(session);
    await session.commitTransaction();
    replicaSetSupported = true;
    return result;
  } catch (err) {
    if (session && session.inTransaction()) {
      try {
        await session.abortTransaction();
      } catch (_) {
        // ignore abort error
      }
    }

    const msg = (err && err.message) || '';
    const isStandaloneError =
      msg.includes('Transaction numbers are only allowed on a replica set') ||
      msg.includes('transactions are not supported') ||
      msg.includes('This MongoDB deployment does not support retryable writes') ||
      err.code === 20 ||
      err.codeName === 'IllegalOperation';

    if (isStandaloneError) {
      replicaSetSupported = false;
      if (session) {
        session.endSession();
        session = null;
      }
      return await workFn(null);
    }
    throw err;
  } finally {
    if (session) {
      session.endSession();
    }
  }
}

module.exports = { runWithTransactionOrFallback };

