const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();
const { getOrCreateWalletForUser, getTweetHistoryForUser } = require('./services/privyUserService');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware to parse JSON bodies
app.use(express.json());
app.use(cors());

// --- /api/wallet endpoint ---
app.get('/api/wallet', async (req, res) => {
  try {
    const twitterUserId = req.headers['x-twitter-user-id'];
    if (!twitterUserId) {
      return res.status(400).json({ error: 'Missing X-Twitter-User-Id header' });
    }
    // Fetch or create wallet for this Twitter user using privyUserService
    const wallet = await getOrCreateWalletForUser(twitterUserId);
    return res.json({ address: wallet.address });
  } catch (err) {
    console.error('Error in /api/wallet:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- /api/wallet/export endpoint ---
app.post('/api/wallet/export', async (req, res) => {
  try {
    const twitterUserId = req.headers['x-twitter-user-id'];
    if (!twitterUserId) {
      return res.status(400).json({ error: 'Missing X-Twitter-User-Id header' });
    }
    // Import decrypt helper and Wallet model
    const { decrypt } = require('./services/privyUserService');
    const mongoose = require('mongoose');
    const Wallet = mongoose.model('Wallet');
    const walletDoc = await Wallet.findOne({ twitterUserId });
    if (!walletDoc || !walletDoc.encryptedPrivateKey) {
      return res.status(404).json({ error: 'Wallet or private key not found' });
    }
    const privateKey = decrypt(walletDoc.encryptedPrivateKey);
    return res.json({ privateKey });
  } catch (err) {
    console.error('Error in /api/wallet/export:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- /api/history endpoint ---
app.get('/api/history', async (req, res) => {
  try {
    const twitterUserId = req.headers['x-twitter-user-id'];
    if (!twitterUserId) {
      return res.status(400).json({ error: 'Missing X-Twitter-User-Id header' });
    }
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    let history = await getTweetHistoryForUser(twitterUserId);
    if (!history || history.length === 0) {
      return res.status(404).json({ error: 'No history found for this user' });
    }
    // Sort by repliedAt (or createdAt if repliedAt missing), latest first
    history.sort((a, b) => {
      const dateA = new Date(a.repliedAt || a.createdAt || 0);
      const dateB = new Date(b.repliedAt || b.createdAt || 0);
      return dateB - dateA;
    });
    const total = history.length;
    const start = (page - 1) * limit;
    const end = start + limit;
    const paginated = history.slice(start, end);
    return res.json({ history: paginated, total, page, limit });
  } catch (err) {
    console.error('Error in /api/history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Connect to MongoDB and start server ---
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`API server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  }); 