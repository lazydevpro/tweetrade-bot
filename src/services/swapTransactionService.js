const mongoose = require('mongoose');
const { setupLogger } = require('../utils/logger');

const logger = setupLogger();

// Swap Transaction Schema
const SwapTransactionSchema = new mongoose.Schema({
  txHash: { type: String, unique: true, required: true, index: true },
  twitterUserId: { type: String, required: true, index: true },
  username: String,
  walletAddress: { type: String, required: true },
  fromToken: { type: String, required: true }, // METIS, USDT, etc.
  toToken: { type: String, required: true }, // METIS, USDT, etc.
  amountIn: { type: String, required: true }, // String to handle decimal precision
  amountOut: { type: String }, // Output amount (may not be known initially)
  amountOutMin: { type: String }, // Minimum output amount for slippage protection
  slippage: { type: Number, default: 0.005 }, // Slippage tolerance (0.5% default)
  status: { 
    type: String, 
    enum: ['pending', 'completed', 'failed', 'reverted'], 
    default: 'pending' 
  },
  dexRouter: String, // DEX router address used
  gasUsed: String, // Gas used in transaction
  gasPrice: String, // Gas price
  blockNumber: Number, // Block number where transaction was mined
  error: String, // Error message if transaction failed
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  completedAt: Date, // When transaction was completed/failed
  explorerUrl: String // Transaction explorer URL
});

// Update timestamp on save
SwapTransactionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const SwapTransaction = mongoose.model('SwapTransaction', SwapTransactionSchema);

// Service functions
class SwapTransactionService {
  
  // Create a new swap transaction record
  async createSwapTransaction(swapData) {
    try {
      const swapTx = new SwapTransaction(swapData);
      await swapTx.save();
      logger.info('Created swap transaction record:', { txHash: swapData.txHash, twitterUserId: swapData.twitterUserId });
      return swapTx;
    } catch (error) {
      logger.error('Error creating swap transaction:', error);
      throw error;
    }
  }

  // Get all swap transactions for a user
  async getUserSwapTransactions(twitterUserId, page = 1, limit = 20) {
    try {
      const skip = (page - 1) * limit;
      const transactions = await SwapTransaction.find({ twitterUserId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);
      
      const total = await SwapTransaction.countDocuments({ twitterUserId });
      
      return {
        transactions,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      };
    } catch (error) {
      logger.error('Error fetching user swap transactions:', error);
      throw error;
    }
  }

  // Get all swap transactions (admin function)
  async getAllSwapTransactions(page = 1, limit = 50, status = null) {
    try {
      const skip = (page - 1) * limit;
      let query = {};
      
      if (status) {
        query.status = status;
      }
      
      const transactions = await SwapTransaction.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);
      
      const total = await SwapTransaction.countDocuments(query);
      
      return {
        transactions,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      };
    } catch (error) {
      logger.error('Error fetching all swap transactions:', error);
      throw error;
    }
  }

  // Get a specific swap transaction by hash
  async getSwapTransaction(txHash) {
    try {
      const transaction = await SwapTransaction.findOne({ txHash });
      if (!transaction) {
        throw new Error('Swap transaction not found');
      }
      return transaction;
    } catch (error) {
      logger.error('Error fetching swap transaction:', error);
      throw error;
    }
  }

  // Update swap transaction status
  async updateSwapTransactionStatus(txHash, status, additionalData = {}) {
    try {
      const updateData = { 
        status, 
        updatedAt: new Date(),
        ...additionalData
      };
      
      if (status === 'completed' || status === 'failed' || status === 'reverted') {
        updateData.completedAt = new Date();
      }
      
      const transaction = await SwapTransaction.findOneAndUpdate(
        { txHash },
        updateData,
        { new: true }
      );
      
      if (!transaction) {
        throw new Error('Swap transaction not found');
      }
      
      logger.info('Updated swap transaction status:', { txHash, status });
      return transaction;
    } catch (error) {
      logger.error('Error updating swap transaction status:', error);
      throw error;
    }
    }

  // Get swap transaction statistics
  async getSwapStatistics(twitterUserId = null) {
    try {
      let matchStage = {};
      if (twitterUserId) {
        matchStage.twitterUserId = twitterUserId;
      }

      const stats = await SwapTransaction.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: null,
            totalTransactions: { $sum: 1 },
            totalVolume: { $sum: { $toDouble: "$amountIn" } },
            completedTransactions: {
              $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] }
            },
            failedTransactions: {
              $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] }
            },
            pendingTransactions: {
              $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] }
            }
          }
        }
      ]);

      return stats[0] || {
        totalTransactions: 0,
        totalVolume: 0,
        completedTransactions: 0,
        failedTransactions: 0,
        pendingTransactions: 0
      };
    } catch (error) {
      logger.error('Error fetching swap statistics:', error);
      throw error;
    }
  }

  // Search swap transactions
  async searchSwapTransactions(searchTerm, page = 1, limit = 20) {
    try {
      const skip = (page - 1) * limit;
      
      const transactions = await SwapTransaction.find({
        $or: [
          { txHash: { $regex: searchTerm, $options: 'i' } },
          { username: { $regex: searchTerm, $options: 'i' } },
          { walletAddress: { $regex: searchTerm, $options: 'i' } }
        ]
      })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);
      
      const total = await SwapTransaction.countDocuments({
        $or: [
          { txHash: { $regex: searchTerm, $options: 'i' } },
          { username: { $regex: searchTerm, $options: 'i' } },
          { walletAddress: { $regex: searchTerm, $options: 'i' } }
        ]
      });
      
      return {
        transactions,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      };
    } catch (error) {
      logger.error('Error searching swap transactions:', error);
      throw error;
    }
  }

  // Delete a swap transaction (admin function)
  async deleteSwapTransaction(txHash) {
    try {
      const result = await SwapTransaction.deleteOne({ txHash });
      if (result.deletedCount === 0) {
        throw new Error('Swap transaction not found');
      }
      
      logger.info('Deleted swap transaction:', { txHash });
      return { success: true, message: 'Swap transaction deleted successfully' };
    } catch (error) {
      logger.error('Error deleting swap transaction:', error);
      throw error;
    }
  }
}

module.exports = {
  SwapTransaction,
  SwapTransactionService: new SwapTransactionService()
};