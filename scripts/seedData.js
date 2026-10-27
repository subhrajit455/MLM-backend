const User = require('../models/User');
const VolumeLedger = require('../models/VolumeLedger');
const Order = require('../models/Order');
const WalletTransaction = require('../models/WalletTransaction');
const { registerDistributor } = require('../services/placementService');
const { processOrderAndCommissions } = require('../services/volumeAndCommissionService');

/**
 * Seeds a realistic 15-distributor Indian Direct-Selling & Affiliate Network
 * with active & inactive members engineered to showcase:
 * 1. Dual-Tree Decoupling (Unilevel Sponsor Tree vs Binary Placement Tree with Auto Spillover)
 * 2. Dynamic Compression (Inactive mid-tier sponsors skipped without consuming paid levels 1..5)
 * 3. Binary Left/Right GV accumulation ready for Weak-Leg Matching Settlement in ₹ (INR)
 * 4. Interactive Vacant Binary Slots for manual placement
 */
async function seedDatabase(periodId = process.env.ACTIVE_PERIOD || '202610') {
  await Promise.all([
    User.deleteMany({}),
    VolumeLedger.deleteMany({}),
    Order.deleteMany({}),
    WalletTransaction.deleteMany({})
  ]);

  const created = {};

  // 1. ROOT NODE (Node #1)
  const n1 = await registerDistributor({
    username: 'rajeshwar_root',
    full_name: 'Rajeshwar Singhania',
    email: 'rajeshwar.s@vantara.in',
    rank_id: 'CROWN_DIAMOND',
    is_active: true,
    periodId
  });
  created.rajeshwar_root = n1.user;

  // 2. LEVEL 1 BINARY LEFT (Node #2) - Active Diamond
  const n2 = await registerDistributor({
    username: 'ananya_iyer',
    full_name: 'Ananya Iyer',
    email: 'ananya.iyer@vantara.in',
    rank_id: 'DIAMOND',
    is_active: true,
    sponsorId: created.rajeshwar_root._id,
    placementParentId: created.rajeshwar_root._id,
    position: 'LEFT',
    periodId
  });
  created.ananya_iyer = n2.user;

  // 3. LEVEL 1 BINARY RIGHT (Node #3) - Active Platinum
  const n3 = await registerDistributor({
    username: 'vikram_patel',
    full_name: 'Vikramaditya Patel',
    email: 'vikram.patel@vantara.in',
    rank_id: 'PLATINUM',
    is_active: true,
    sponsorId: created.rajeshwar_root._id,
    placementParentId: created.rajeshwar_root._id,
    position: 'RIGHT',
    periodId
  });
  created.vikram_patel = n3.user;

  // 4. LEVEL 2: Under Ananya Left (Node #4) - INACTIVE Bronze (Demonstrates Dynamic Compression!)
  const n4 = await registerDistributor({
    username: 'sanjay_dormant',
    full_name: 'Sanjay Kulkarni',
    email: 'sanjay.k@vantara.in',
    rank_id: 'BRONZE',
    is_active: false,
    sponsorId: created.ananya_iyer._id,
    placementParentId: created.ananya_iyer._id,
    position: 'LEFT',
    periodId
  });
  created.sanjay_dormant = n4.user;

  // 5. LEVEL 2: Under Ananya Right (Node #5) - Active Gold
  const n5 = await registerDistributor({
    username: 'meera_deshmukh',
    full_name: 'Meera Deshmukh',
    email: 'meera.d@vantara.in',
    rank_id: 'GOLD',
    is_active: true,
    sponsorId: created.ananya_iyer._id,
    placementParentId: created.ananya_iyer._id,
    position: 'RIGHT',
    periodId
  });
  created.meera_deshmukh = n5.user;

  // 6. LEVEL 2: Under Vikram Left (Node #6) - Active Gold
  const n6 = await registerDistributor({
    username: 'arjun_reddy',
    full_name: 'Arjun Reddy',
    email: 'arjun.reddy@vantara.in',
    rank_id: 'GOLD',
    is_active: true,
    sponsorId: created.vikram_patel._id,
    placementParentId: created.vikram_patel._id,
    position: 'LEFT',
    periodId
  });
  created.arjun_reddy = n6.user;

  // 7. LEVEL 2: Under Vikram Right (Node #7) - INACTIVE Starter (Demonstrates Dynamic Compression on Right branch!)
  const n7 = await registerDistributor({
    username: 'kavita_paused',
    full_name: 'Kavita Verma',
    email: 'kavita.v@vantara.in',
    rank_id: 'STARTER',
    is_active: false,
    sponsorId: created.vikram_patel._id,
    placementParentId: created.vikram_patel._id,
    position: 'RIGHT',
    periodId
  });
  created.kavita_paused = n7.user;

  // 8. LEVEL 3: Auto Extreme-Left Spillover recruited personally by ROOT (rajeshwar_root)
  // Lands under sanjay_dormant LEFT! Demonstrates Sponsor != Placement Parent.
  const n8 = await registerDistributor({
    username: 'siddharth_spill',
    full_name: 'Siddharth Joshi',
    email: 'siddharth.j@vantara.in',
    rank_id: 'SILVER',
    is_active: true,
    sponsorId: created.rajeshwar_root._id,
    preferredLeg: 'OUTER_LEFT',
    periodId
  });
  created.siddharth_spill = n8.user;

  // 9. LEVEL 3: Under sanjay_dormant RIGHT (Node #9) - Active Silver recruited by sanjay_dormant
  const n9 = await registerDistributor({
    username: 'neha_kapoor',
    full_name: 'Neha Kapoor',
    email: 'neha.kapoor@vantara.in',
    rank_id: 'SILVER',
    is_active: true,
    sponsorId: created.sanjay_dormant._id,
    placementParentId: created.sanjay_dormant._id,
    position: 'RIGHT',
    periodId
  });
  created.neha_kapoor = n9.user;

  // 10. LEVEL 3: Under meera_deshmukh LEFT (Node #10) - Active Silver
  const n10 = await registerDistributor({
    username: 'karthik_menon',
    full_name: 'Karthik Menon',
    email: 'karthik.m@vantara.in',
    rank_id: 'SILVER',
    is_active: true,
    sponsorId: created.meera_deshmukh._id,
    placementParentId: created.meera_deshmukh._id,
    position: 'LEFT',
    periodId
  });
  created.karthik_menon = n10.user;

  // 11. LEVEL 3: Under arjun_reddy LEFT (Node #11) - Active Silver
  const n11 = await registerDistributor({
    username: 'divya_bhatia',
    full_name: 'Divya Bhatia',
    email: 'divya.b@vantara.in',
    rank_id: 'SILVER',
    is_active: true,
    sponsorId: created.arjun_reddy._id,
    placementParentId: created.arjun_reddy._id,
    position: 'LEFT',
    periodId
  });
  created.divya_bhatia = n11.user;

  // 12. LEVEL 3: Auto Extreme-Right Spillover recruited by vikram_patel
  // Lands under kavita_paused RIGHT
  const n12 = await registerDistributor({
    username: 'aditya_chauhan',
    full_name: 'Aditya Chauhan',
    email: 'aditya.c@vantara.in',
    rank_id: 'SILVER',
    is_active: true,
    sponsorId: created.vikram_patel._id,
    preferredLeg: 'OUTER_RIGHT',
    periodId
  });
  created.aditya_chauhan = n12.user;

  // 13. LEVEL 4: Under neha_kapoor LEFT (Node #13) - INACTIVE Bronze (Second inactive link in deep chain!)
  const n13 = await registerDistributor({
    username: 'deepak_inactive',
    full_name: 'Deepak Bansal',
    email: 'deepak.b@vantara.in',
    rank_id: 'BRONZE',
    is_active: false,
    sponsorId: created.neha_kapoor._id,
    placementParentId: created.neha_kapoor._id,
    position: 'LEFT',
    periodId
  });
  created.deepak_inactive = n13.user;

  // 14. LEVEL 5: Under deepak_inactive LEFT (Node #14) - Active Gold
  const n14 = await registerDistributor({
    username: 'priya_nair',
    full_name: 'Priya Nair',
    email: 'priya.nair@vantara.in',
    rank_id: 'GOLD',
    is_active: true,
    sponsorId: created.deepak_inactive._id,
    placementParentId: created.deepak_inactive._id,
    position: 'LEFT',
    periodId
  });
  created.priya_nair = n14.user;

  // 15. LEVEL 6: Under priya_nair LEFT (Node #15) - Active Builder
  // Sponsor chain from rohan_malhotra bottom-up:
  // Gen 1: priya_nair (ACTIVE -> Paid L1 10%)
  // Gen 2: deepak_inactive (INACTIVE -> SKIPPED by Dynamic Compression!)
  // Gen 3: neha_kapoor (ACTIVE -> Compresses up to Paid L2 5%)
  // Gen 4: sanjay_dormant (INACTIVE -> SKIPPED by Dynamic Compression!)
  // Gen 5: ananya_iyer (ACTIVE -> Compresses up to Paid L3 3%)
  // Gen 6: rajeshwar_root (ACTIVE -> Compresses up to Paid L4 2%)
  const n15 = await registerDistributor({
    username: 'rohan_malhotra',
    full_name: 'Rohan Malhotra',
    email: 'rohan.m@vantara.in',
    rank_id: 'SILVER',
    is_active: true,
    sponsorId: created.priya_nair._id,
    placementParentId: created.priya_nair._id,
    position: 'LEFT',
    periodId
  });
  created.rohan_malhotra = n15.user;

  // Seed realistic Indian product orders (with INR retail price & BV)
  const seedOrders = [
    {
      buyer: created.rajeshwar_root,
      bv: '1500.0000',
      totalPrice: '27000.0000',
      productName: 'AyurVeda Crown Stockist Pack'
    },
    {
      buyer: created.ananya_iyer,
      bv: '1200.0000',
      totalPrice: '21600.0000',
      productName: 'Wellness Diamond Franchise Kit'
    },
    {
      buyer: created.vikram_patel,
      bv: '1200.0000',
      totalPrice: '21600.0000',
      productName: 'Wellness Diamond Franchise Kit'
    },
    {
      buyer: created.meera_deshmukh,
      bv: '1800.0000',
      totalPrice: '32400.0000',
      productName: 'NutriLife Gold Leader Bundle'
    },
    {
      buyer: created.karthik_menon,
      bv: '1000.0000',
      totalPrice: '18000.0000',
      productName: 'NutriLife Pro Retail Pack'
    },
    {
      buyer: created.arjun_reddy,
      bv: '1500.0000',
      totalPrice: '27000.0000',
      productName: 'AyurVeda Crown Stockist Pack'
    },
    {
      buyer: created.divya_bhatia,
      bv: '1250.0000',
      totalPrice: '22500.0000',
      productName: 'Wellness Regional Builder Kit'
    },
    {
      buyer: created.aditya_chauhan,
      bv: '900.0000',
      totalPrice: '16200.0000',
      productName: 'Personal Care Starter Assortment'
    },
    {
      buyer: created.neha_kapoor,
      bv: '800.0000',
      totalPrice: '14400.0000',
      productName: 'Personal Care Starter Assortment'
    },
    {
      buyer: created.priya_nair,
      bv: '1000.0000',
      totalPrice: '18000.0000',
      productName: 'NutriLife Pro Retail Pack'
    },
    {
      buyer: created.rohan_malhotra,
      bv: '1500.0000',
      totalPrice: '27000.0000',
      productName: 'AyurVeda Crown Stockist Pack'
    }
  ];

  let lastOrderTrace = null;
  for (const item of seedOrders) {
    lastOrderTrace = await processOrderAndCommissions({
      buyerId: item.buyer._id,
      bvAmount: item.bv,
      totalPrice: item.totalPrice,
      productName: item.productName,
      periodId
    });
  }

  return {
    message: 'Successfully seeded 15-node Dual-Tree MLM Network and executed 11 initial BV orders.',
    rootUserId: created.rajeshwar_root._id.toString(),
    featuredLeafUserId: created.rohan_malhotra._id.toString(),
    totalDistributors: 15,
    totalOrders: seedOrders.length,
    sampleCompressionTrace: lastOrderTrace
  };
}

// Allow standalone CLI execution via `npm run seed`
if (require.main === module && process.argv.includes('--run')) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/mlm_dual_tree_platform';
  mongoose
    .connect(uri)
    .then(async () => {
      console.log('Connected to MongoDB. Seeding 15-node network...');
      const res = await seedDatabase();
      console.log(res.message);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed error:', err);
      process.exit(1);
    });
}

module.exports = { seedDatabase };
