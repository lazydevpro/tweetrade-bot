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

// Add dedicated endpoint for chat history
app.get('/api/history/chat', async (req, res) => {
  try {
    const twitterUserId = req.headers['x-twitter-user-id'];
    if (!twitterUserId) {
      return res.status(400).json({ error: 'Missing X-Twitter-User-Id header' });
    }
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const { getChatHistoryForUser } = require('./services/privyUserService');
    let history = await getChatHistoryForUser(twitterUserId);
    if (!history || history.length === 0) {
      return res.status(404).json({ error: 'No chat history found for this user' });
    }
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
    console.error('Error in /api/history/chat:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- /api/chat endpoint ---
app.post('/api/chat', async (req, res) => {
  try {
    const { message, twitterUserId: bodyUserId, twitterUsername, tweetUrl } = req.body || {};
    const headerUserId = req.headers['x-twitter-user-id'];
    const twitterUserId = bodyUserId || headerUserId;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid message' });
    }
    if (!twitterUserId && !twitterUsername) {
      return res.status(400).json({ error: 'Provide X-Twitter-User-Id header or twitterUsername in body' });
    }

    const { handleChat } = require('./handlers/chatHandler');
    const result = await handleChat({ message, twitterUserId, twitterUsername, tweetUrl });

    // Normalize HTTP status
    if (result.status === 'error') {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Error in /api/chat:', err);
    res.status(500).json({ status: 'error', reply: 'Internal server error' });
  }
});

// --- /api/leaderboard endpoint ---
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const { XPService } = require('./services/xpService');
    const xpService = new XPService();
    
    const leaderboard = await xpService.getLeaderboard(limit);
    return res.json({ 
      leaderboard,
      total: leaderboard.length,
      limit 
    });
  } catch (err) {
    console.error('Error in /api/leaderboard:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- /api/user/xp endpoint ---
app.get('/api/user/xp', async (req, res) => {
  try {
    const twitterUserId = req.headers['x-twitter-user-id'];
    if (!twitterUserId) {
      return res.status(400).json({ error: 'Missing X-Twitter-User-Id header' });
    }
    
    const { XPService } = require('./services/xpService');
    const xpService = new XPService();
    
    const userXP = await xpService.getUserXP(twitterUserId);
    if (!userXP) {
      return res.status(404).json({ error: 'User XP not found' });
    }
    
    return res.json(userXP);
  } catch (err) {
    console.error('Error in /api/user/xp:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- /api/user/rank endpoint ---
app.get('/api/user/rank', async (req, res) => {
  try {
    const twitterUserId = req.headers['x-twitter-user-id'];
    if (!twitterUserId) {
      return res.status(400).json({ error: 'Missing X-Twitter-User-Id header' });
    }
    
    const { XPService } = require('./services/xpService');
    const xpService = new XPService();
    
    const userRank = await xpService.getUserRank(twitterUserId);
    if (!userRank) {
      return res.status(404).json({ error: 'User rank not found' });
    }
    
    return res.json(userRank);
  } catch (err) {
    console.error('Error in /api/user/rank:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- /api/user/:username/xp endpoint ---
app.get('/api/user/:username/xp', async (req, res) => {
  try {
    const { username } = req.params;
    if (!username) {
      return res.status(400).json({ error: 'Missing username parameter' });
    }
    
    const { UserXP } = require('./services/xpService');
    
    // Find user by username (case-insensitive)
    const userXP = await UserXP.findOne({ 
      username: { $regex: new RegExp(`^${username}$`, 'i') } 
    });
    
    if (!userXP) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    return res.json(userXP);
  } catch (err) {
    console.error('Error in /api/user/:username/xp:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- /api/user/:username/rank endpoint ---
app.get('/api/user/:username/rank', async (req, res) => {
  try {
    const { username } = req.params;
    if (!username) {
      return res.status(400).json({ error: 'Missing username parameter' });
    }
    
    const { XPService } = require('./services/xpService');
    const xpService = new XPService();
    
    // Find user by username first
    const { UserXP } = require('./services/xpService');
    const user = await UserXP.findOne({ 
      username: { $regex: new RegExp(`^${username}$`, 'i') } 
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userRank = await xpService.getUserRank(user.userId);
    if (!userRank) {
      return res.status(404).json({ error: 'User rank not found' });
    }
    
    return res.json(userRank);
  } catch (err) {
    console.error('Error in /api/user/:username/rank:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- /api/xp/stats endpoint ---
app.get('/api/xp/stats', async (req, res) => {
  try {
    const { XPService } = require('./services/xpService');
    const xpService = new XPService();
    
    const stats = await xpService.getXPStats();
    if (!stats) {
      return res.status(500).json({ error: 'Failed to retrieve XP statistics' });
    }
    
    return res.json(stats);
  } catch (err) {
    console.error('Error in /api/xp/stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Swap Transaction Endpoints ---

// GET /api/swap/transactions - Get user's swap transactions
app.get('/api/swap/transactions', async (req, res) => {
  try {
    const twitterUserId = req.headers['x-twitter-user-id'];
    if (!twitterUserId) {
      return res.status(400).json({ error: 'Missing X-Twitter-User-Id header' });
    }
    
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    
    const { SwapTransactionService } = require('./services/swapTransactionService');
    const result = await SwapTransactionService.getUserSwapTransactions(twitterUserId, page, limit);
    
    return res.json(result);
  } catch (err) {
    console.error('Error in /api/swap/transactions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/swap/transactions/all - Get all swap transactions (admin)
app.get('/api/swap/transactions/all', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const status = req.query.status || null;
    
    const { SwapTransactionService } = require('./services/swapTransactionService');
    const result = await SwapTransactionService.getAllSwapTransactions(page, limit, status);
    
    return res.json(result);
  } catch (err) {
    console.error('Error in /api/swap/transactions/all:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/swap/transactions/:txHash - Get specific swap transaction
app.get('/api/swap/transactions/:txHash', async (req, res) => {
  try {
    const { txHash } = req.params;
    
    const { SwapTransactionService } = require('./services/swapTransactionService');
    const transaction = await SwapTransactionService.getSwapTransaction(txHash);
    
    return res.json(transaction);
  } catch (err) {
    console.error('Error in /api/swap/transactions/:txHash:', err);
    if (err.message === 'Swap transaction not found') {
      return res.status(404).json({ error: 'Swap transaction not found' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/swap/statistics - Get swap statistics
app.get('/api/swap/statistics', async (req, res) => {
  try {
    const twitterUserId = req.query.userId || null;
    
    const { SwapTransactionService } = require('./services/swapTransactionService');
    const stats = await SwapTransactionService.getSwapStatistics(twitterUserId);
    
    return res.json(stats);
  } catch (err) {
    console.error('Error in /api/swap/statistics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/swap/search - Search swap transactions
app.get('/api/swap/search', async (req, res) => {
  try {
    const searchTerm = req.query.q;
    if (!searchTerm) {
      return res.status(400).json({ error: 'Missing search query parameter' });
    }
    
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    
    const { SwapTransactionService } = require('./services/swapTransactionService');
    const result = await SwapTransactionService.searchSwapTransactions(searchTerm, page, limit);
    
    return res.json(result);
  } catch (err) {
    console.error('Error in /api/swap/search:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/swap/transactions - Create new swap transaction
app.post('/api/swap/transactions', async (req, res) => {
  try {
    const twitterUserId = req.headers['x-twitter-user-id'];
    if (!twitterUserId) {
      return res.status(400).json({ error: 'Missing X-Twitter-User-Id header' });
    }
    
    const { SwapTransactionService } = require('./services/swapTransactionService');
    const swapTx = await SwapTransactionService.createSwapTransaction(req.body);
    
    return res.status(201).json(swapTx);
  } catch (err) {
    console.error('Error in /api/swap/transactions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/swap/transactions/:txHash - Update swap transaction status
app.put('/api/swap/transactions/:txHash', async (req, res) => {
  try {
    const { txHash } = req.params;
    const { status, ...additionalData } = req.body;
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    
    const { SwapTransactionService } = require('./services/swapTransactionService');
    const transaction = await SwapTransactionService.updateSwapTransactionStatus(txHash, status, additionalData);
    
    return res.json(transaction);
  } catch (err) {
    console.error('Error in /api/swap/transactions/:txHash:', err);
    if (err.message === 'Swap transaction not found') {
      return res.status(404).json({ error: 'Swap transaction not found' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/swap/transactions/:txHash - Delete swap transaction (admin)
app.delete('/api/swap/transactions/:txHash', async (req, res) => {
  try {
    const { txHash } = req.params;
    
    const { SwapTransactionService } = require('./services/swapTransactionService');
    const result = await SwapTransactionService.deleteSwapTransaction(txHash);
    
    return res.json(result);
  } catch (err) {
    console.error('Error in /api/swap/transactions/:txHash:', err);
    if (err.message === 'Swap transaction not found') {
      return res.status(404).json({ error: 'Swap transaction not found' });
    }
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