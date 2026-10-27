require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const User = require('./models/User');
const VolumeLedger = require('./models/VolumeLedger');
const Order = require('./models/Order');
const WalletTransaction = require('./models/WalletTransaction');
const apiRoutes = require('./routes/api');
const { seedDatabase } = require('./scripts/seedData');

const app = express();
const PORT = process.env.PORT || 5005;
const MONGO_URI =
  process.env.MONGO_URI ||
  'mongodb+srv://vaisdt81_db_user:MUfypBSEWunKu3X8@cluster0.eosutgp.mongodb.net/';

app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    active_period: process.env.ACTIVE_PERIOD || '202610'
  });
});

// Mount REST API
app.use('/api', apiRoutes);

async function startServer() {
  try {
    await mongoose.connect(MONGO_URI, {
      dbName: 'mlm_dual_tree_platform'
    });
    console.log('[MongoDB] Connected successfully to MongoDB Atlas (mlm_dual_tree_platform)');

    // Ensure indexes are built (including partial unique index on { placement_parent_id, position })
    await Promise.all([
      User.syncIndexes(),
      VolumeLedger.syncIndexes(),
      Order.syncIndexes(),
      WalletTransaction.syncIndexes()
    ]);

    // Auto-seed on startup if database is empty so the app works out-of-the-box on first launch
    const existingUsers = await User.countDocuments();
    if (existingUsers === 0) {
      console.log('[Auto-Seed] Empty database detected. Seeding 15-node Dual-Tree network...');
      const seedRes = await seedDatabase();
      console.log(`[Auto-Seed] ${seedRes.message}`);
    } else {
      console.log(`[Auto-Seed] Found ${existingUsers} existing distributors in database.`);
    }

    app.listen(PORT, () => {
      console.log(`[Server] Dual-Tree MLM & Affiliate Fintech API listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[Startup Error]', err);
    process.exit(1);
  }
}

startServer();

