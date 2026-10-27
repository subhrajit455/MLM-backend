const express = require('express');
const router = express.Router();
const mlmController = require('../controllers/mlmController');

// User & Registration Endpoints
router.get('/users', mlmController.listUsers);
router.post('/users/register', mlmController.registerUser);
router.get('/users/:id/dashboard', mlmController.getUserDashboard);

// Genealogy Tree Endpoint (Binary & Unilevel + EMPTY_SLOT virtual nodes)
router.get('/tree/:rootId', mlmController.getTree);

// Orders, Volume Roll-Up, Dynamic Compression & Clawbacks
router.get('/orders', mlmController.listOrders);
router.post('/orders', mlmController.createOrder);
router.post('/orders/:orderId/refund', mlmController.refundOrder);

// Binary Cycle Settlement Engine
router.post('/settlement/run-binary', mlmController.executeBinarySettlement);

// 15-Node Demo Network Seeder
router.post('/seed', mlmController.seedNetwork);

module.exports = router;

