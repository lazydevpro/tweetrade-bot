const mongoose = require('mongoose');
const { setupLogger } = require('../utils/logger');

const logger = setupLogger();

// XP Transaction Schema - tracks all XP events
const XPTransactionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  username: { type: String, required: true },
  action: { type: String, required: true },
  xpAmount: { type: Number, required: true },
  metadata: { type: mongoose.Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now, index: true }
});

// User XP Schema - stores current XP totals and levels
const UserXPSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true },
  totalXP: { type: Number, default: 0, index: true },
  level: { type: String, default: 'Bronze' },
  rank: { type: Number, default: 0 },
  consecutiveDays: { type: Number, default: 0 },
  lastActivityDate: { type: Date, default: Date.now },
  achievements: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Leaderboard Schema - maintains sorted rankings
const LeaderboardSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true },
  totalXP: { type: Number, required: true, index: true },
  level: { type: String, required: true },
  rank: { type: Number, required: true, index: true },
  lastUpdated: { type: Date, default: Date.now }
});

// Daily Activity Schema - tracks daily user activity for bonuses
const DailyActivitySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  date: { type: Date, required: true, index: true },
  actions: [{ type: String }],
  totalXP: { type: Number, default: 0 },
  dailyBonus: { type: Number, default: 0 }
});

// Reward snapshot state schema - tracks last processed period for snapshotting
const RewardSnapshotStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  lastSnapshottedPeriodId: { type: Number, default: -1 },
  // Updated whenever the bot checks whether a snapshot is needed.
  lastCheckedAt: { type: Date },
  // Best-effort next scheduled check time (based on SNAPSHOT_CHECK_INTERVAL at runtime).
  nextCheckAt: { type: Date },
  updatedAt: { type: Date, default: Date.now }
});

// Period Reward Snapshot Schema - stores end-of-period leaderboard results and rewards
const PeriodRewardSnapshotSchema = new mongoose.Schema({
  periodId: { type: Number, required: true, index: true },
  periodDuration: { type: Number, required: true }, // seconds
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  userId: { type: String, required: true, index: true },
  username: { type: String, required: true },
  rank: { type: Number, required: true },
  totalXP: { type: Number, required: true },
  rewardAmount: { type: String, required: true }, // wei string
  tokenAddress: { type: String, required: true }, // address(0) for native
  claimed: { type: Boolean, default: false },
  claimedAt: { type: Date },
  txHash: { type: String },
  snapshotDate: { type: Date, default: Date.now }
});

// Uniqueness: one snapshot row per user per period
PeriodRewardSnapshotSchema.index({ periodId: 1, userId: 1 }, { unique: true });

// Create models
const XPTransaction = mongoose.model('XPTransaction', XPTransactionSchema);
const UserXP = mongoose.model('UserXP', UserXPSchema);
const Leaderboard = mongoose.model('Leaderboard', LeaderboardSchema);
const DailyActivity = mongoose.model('DailyActivity', DailyActivitySchema);
const RewardSnapshotState = mongoose.model('RewardSnapshotState', RewardSnapshotStateSchema);
const PeriodRewardSnapshot = mongoose.model('PeriodRewardSnapshot', PeriodRewardSnapshotSchema);

// XP Reward Structure
const XP_REWARDS = {
  CHAT_SWAP: 10000,        // Swap amount x 10000 XP (highest reward)
  TOKEN_TRANSFER: 1000,    // Transfer Amount x 1000 XP (high reward)
  BALANCE_CHECK: 100,      // Balance Checks (once a day): 100 XP (medium reward)
  WALLET_CREATION: 100,    // Wallet Creation: 100 XP (one-time bonus)
  DRIP_USAGE: 100,         // Drip Usage: 100 XP (medium reward)
  GIVEAWAY_CREATION: 100,  // Giveaway Creation: 100 XP (high reward)
  GIVEAWAY_PARTICIPATION: 50, // Giveaway Participation: 50 XP (low reward)
  DAILY_LOGIN: 100         // Daily Login/Interaction (once a day): 100 XP (daily bonus)
};

// Level thresholds
const LEVEL_THRESHOLDS = {
  'Bronze': { min: 0, max: 5000 },
  'Silver': { min: 5001, max: 15000 },
  'Gold': { min: 15001, max: 50000 },
  'Platinum': { min: 50001, max: 100000 },
  'Diamond': { min: 100001, max: Infinity }
};

class XPService {
  constructor() {
    this.setupIndexes();
  }

  async setupIndexes() {
    try {
      // Create compound indexes for better performance
      await UserXP.collection.createIndex({ totalXP: -1, userId: 1 });
      await Leaderboard.collection.createIndex({ totalXP: -1, rank: 1 });
      await XPTransaction.collection.createIndex({ userId: 1, timestamp: -1 });
      await DailyActivity.collection.createIndex({ userId: 1, date: -1 });
      
      // Try to create unique index for WALLET_CREATION, clean up duplicates if needed
      try {
        await XPTransaction.collection.createIndex(
          { userId: 1, action: 1 },
          { unique: true, partialFilterExpression: { action: 'WALLET_CREATION' } }
        );
        logger.info('Successfully created unique index for WALLET_CREATION');
      } catch (indexError) {
        if (indexError.code === 11000) {
          logger.warn('Duplicate key error when creating WALLET_CREATION index. Cleaning up duplicates...');
          await this.cleanupDuplicateWalletCreation();
          
          // Try creating the index again
          await XPTransaction.collection.createIndex(
            { userId: 1, action: 1 },
            { unique: true, partialFilterExpression: { action: 'WALLET_CREATION' } }
          );
          logger.info('Successfully created unique index for WALLET_CREATION after cleanup');
        } else {
          throw indexError;
        }
      }
    } catch (error) {
      logger.error('Error setting up XP indexes:', error);
    }
  }

  // Clean up duplicate WALLET_CREATION transactions
  async cleanupDuplicateWalletCreation() {
    try {
      const db = mongoose.connection.db;
      const collection = db.collection('xptransactions');
      
      // Find all WALLET_CREATION transactions
      const walletCreations = await collection.find({ action: 'WALLET_CREATION' }).toArray();
      
      // Group by userId to find duplicates
      const userGroups = {};
      walletCreations.forEach(transaction => {
        if (!userGroups[transaction.userId]) {
          userGroups[transaction.userId] = [];
        }
        userGroups[transaction.userId].push(transaction);
      });
      
      // Process duplicates
      let totalRemoved = 0;
      for (const [userId, transactions] of Object.entries(userGroups)) {
        if (transactions.length > 1) {
          logger.info(`User ${userId} has ${transactions.length} WALLET_CREATION transactions`);
          
          // Keep the first one (oldest timestamp), remove the rest
          const sortedTransactions = transactions.sort((a, b) => 
            new Date(a.timestamp) - new Date(b.timestamp)
          );
          
          const toRemove = sortedTransactions.slice(1);
          const idsToRemove = toRemove.map(t => t._id);
          
          if (idsToRemove.length > 0) {
            const result = await collection.deleteMany({ _id: { $in: idsToRemove } });
            logger.info(`Removed ${result.deletedCount} duplicate transactions for user ${userId}`);
            totalRemoved += result.deletedCount;
          }
        }
      }
      
      logger.info(`Total duplicate transactions removed: ${totalRemoved}`);
      return totalRemoved;
      
    } catch (error) {
      logger.error('Error cleaning up duplicates:', error);
      throw error;
    }
  }

  // Award XP for an action
  async awardXP(userId, username, action, metadata = {}) {
    try {
      let xpAmount = XP_REWARDS[action] || 0;
      
      // Check daily restrictions for balance checks
      if (action === 'BALANCE_CHECK') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const dailyActivity = await DailyActivity.findOne({
          userId,
          date: today
        });
        
        // If user already got balance check XP today, don't award more
        if (dailyActivity && dailyActivity.actions.includes('BALANCE_CHECK')) {
          logger.info(`User ${username} already received balance check XP today - no additional XP awarded`);
          return 0;
        }
      }
      
      // Handle dynamic XP calculations for swaps and transfers
      if (action === 'CHAT_SWAP' && metadata.amount) {
        xpAmount = Math.floor(metadata.amount * XP_REWARDS.CHAT_SWAP);
      } else if (action === 'TOKEN_TRANSFER' && metadata.amount) {
        xpAmount = Math.floor(metadata.amount * XP_REWARDS.TOKEN_TRANSFER);
      }
      
      if (xpAmount === 0) {
        logger.warn(`No XP reward defined for action: ${action}`);
        return 0;
      }

      // Create XP transaction record
      const transaction = new XPTransaction({
        userId,
        username,
        action,
        xpAmount,
        metadata
      });
      await transaction.save();

      // Update or create user XP record
      let userXP = await UserXP.findOne({ userId });
      if (!userXP) {
        userXP = new UserXP({
          userId,
          username,
          totalXP: 0,
          level: 'Bronze',
          consecutiveDays: 0,
          lastActivityDate: new Date()
        });
      }

      // Add XP and check for level up
      const oldLevel = userXP.level;
      userXP.totalXP += xpAmount;
      userXP.level = this.calculateLevel(userXP.totalXP);
      userXP.updatedAt = new Date();

      // Check for consecutive days bonus
      const today = new Date();
      const lastActivity = new Date(userXP.lastActivityDate);
      const daysDiff = Math.floor((today - lastActivity) / (1000 * 60 * 60 * 24));
      
      if (daysDiff === 1) {
        userXP.consecutiveDays += 1;
        // Bonus for consecutive days (every 7 days)
        if (userXP.consecutiveDays % 7 === 0) {
          const consecutiveBonus = Math.floor(userXP.consecutiveDays / 7) * 1000;
          userXP.totalXP += consecutiveBonus;
          
          // Record consecutive day bonus
          const bonusTransaction = new XPTransaction({
            userId,
            username,
            action: 'CONSECUTIVE_DAYS_BONUS',
            xpAmount: consecutiveBonus,
            metadata: { consecutiveDays: userXP.consecutiveDays }
          });
          await bonusTransaction.save();
        }
      } else if (daysDiff > 1) {
        userXP.consecutiveDays = 1;
      }
      
      userXP.lastActivityDate = today;
      await userXP.save();

      // Update leaderboard
      await this.updateLeaderboard(userId, username, userXP.totalXP, userXP.level);

      // Record daily activity
      await this.recordDailyActivity(userId, action, xpAmount);

      // Check for level up
      if (userXP.level !== oldLevel) {
        logger.info(`User ${username} leveled up from ${oldLevel} to ${userXP.level}`);
        // Could add special rewards or notifications here
      }

      logger.info(`Awarded ${xpAmount} XP to user ${username} for action: ${action}`);
      return xpAmount;

    } catch (error) {
      logger.error('Error awarding XP:', error);
      return 0;
    }
  }

  // Calculate user level based on total XP
  calculateLevel(totalXP) {
    for (const [level, threshold] of Object.entries(LEVEL_THRESHOLDS)) {
      if (totalXP >= threshold.min && totalXP <= threshold.max) {
        return level;
      }
    }
    return 'Bronze';
  }

  // Update leaderboard rankings
  async updateLeaderboard(userId, username, totalXP, level) {
    try {
      // Update or create leaderboard entry
      await Leaderboard.findOneAndUpdate(
        { userId },
        {
          userId,
          username,
          totalXP,
          level,
          lastUpdated: new Date()
        },
        { upsert: true }
      );

      // Recalculate all rankings
      await this.recalculateLeaderboard();
    } catch (error) {
      logger.error('Error updating leaderboard:', error);
    }
  }

  // Recalculate all leaderboard rankings
  async recalculateLeaderboard() {
    try {
      const users = await Leaderboard.find({}).sort({ totalXP: -1 });
      
      for (let i = 0; i < users.length; i++) {
        users[i].rank = i + 1;
        await users[i].save();
      }

      // Also update UserXP records with current rank
      for (const user of users) {
        await UserXP.findOneAndUpdate(
          { userId: user.userId },
          { rank: user.rank }
        );
      }

      logger.info(`Recalculated leaderboard for ${users.length} users`);
    } catch (error) {
      logger.error('Error recalculating leaderboard:', error);
    }
  }

  // Record daily activity
  async recordDailyActivity(userId, action, xpAmount) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let dailyActivity = await DailyActivity.findOne({
        userId,
        date: today
      });

      if (!dailyActivity) {
        dailyActivity = new DailyActivity({
          userId,
          date: today,
          actions: [],
          totalXP: 0,
          dailyBonus: 0
        });
      }

      dailyActivity.actions.push(action);
      dailyActivity.totalXP += xpAmount;

      // Award daily login bonus if this is the first action of the day
      if (dailyActivity.actions.length === 1) {
        const dailyBonus = XP_REWARDS.DAILY_LOGIN;
        dailyActivity.dailyBonus = dailyBonus;
        dailyActivity.totalXP += dailyBonus;
        
        // Record daily bonus transaction
        const userXP = await UserXP.findOne({ userId });
        if (userXP) {
          const bonusTransaction = new XPTransaction({
            userId,
            username: userXP.username,
            action: 'DAILY_LOGIN',
            xpAmount: dailyBonus,
            metadata: { date: today }
          });
          await bonusTransaction.save();

          // Update user XP
          userXP.totalXP += dailyBonus;
          await userXP.save();
        }
      }

      await dailyActivity.save();
    } catch (error) {
      logger.error('Error recording daily activity:', error);
    }
  }

  // Get user's XP information
  async getUserXP(userId) {
    try {
      let userXP = await UserXP.findOne({ userId });
      if (!userXP) {
        return null;
      }

      // Get recent XP transactions
      const recentTransactions = await XPTransaction.find({ userId })
        .sort({ timestamp: -1 })
        .limit(10);

      return {
        ...userXP.toObject(),
        recentTransactions
      };
    } catch (error) {
      logger.error('Error getting user XP:', error);
      return null;
    }
  }

  // Get leaderboard (top users)
  async getLeaderboard(limit = 10) {
    try {
      const leaderboard = await Leaderboard.find({})
        .sort({ totalXP: -1, rank: 1 })
        .limit(limit);

      return leaderboard;
    } catch (error) {
      logger.error('Error getting leaderboard:', error);
      return [];
    }
  }

  // Get user's rank
  async getUserRank(userId) {
    try {
      const userXP = await UserXP.findOne({ userId });
      if (!userXP) {
        return null;
      }

      return {
        rank: userXP.rank,
        totalXP: userXP.totalXP,
        level: userXP.level,
        totalUsers: await UserXP.countDocuments()
      };
    } catch (error) {
      logger.error('Error getting user rank:', error);
      return null;
    }
  }

  // Get XP history for a user
  async getXPHistory(userId, limit = 20) {
    try {
      const transactions = await XPTransaction.find({ userId })
        .sort({ timestamp: -1 })
        .limit(limit);

      return transactions;
    } catch (error) {
      logger.error('Error getting XP history:', error);
      return [];
    }
  }

  // Get XP statistics
  async getXPStats() {
    try {
      const stats = await UserXP.aggregate([
        {
          $group: {
            _id: null,
            totalUsers: { $sum: 1 },
            totalXP: { $sum: '$totalXP' },
            averageXP: { $avg: '$totalXP' }
          }
        }
      ]);

      const levelDistribution = await UserXP.aggregate([
        {
          $group: {
            _id: '$level',
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } }
      ]);

      return {
        ...stats[0],
        levelDistribution
      };
    } catch (error) {
      logger.error('Error getting XP stats:', error);
      return null;
    }
  }

  // Award XP for specific actions (convenience methods)
  async awardForChatSwap(userId, username, swapDetails) {
    // Ensure swapDetails contains amount for dynamic XP calculation
    if (!swapDetails || typeof swapDetails.amount !== 'number') {
      logger.warn('Chat swap XP calculation requires amount in swapDetails');
    }
    return this.awardXP(userId, username, 'CHAT_SWAP', swapDetails);
  }

  async awardForTokenTransfer(userId, username, transferDetails) {
    // Ensure transferDetails contains amount for dynamic XP calculation
    if (!transferDetails || typeof transferDetails.amount !== 'number') {
      logger.warn('Token transfer XP calculation requires amount in transferDetails');
    }
    return this.awardXP(userId, username, 'TOKEN_TRANSFER', transferDetails);
  }

  async awardForBalanceCheck(userId, username) {
    // Note: Balance check XP is limited to once per day
    return this.awardXP(userId, username, 'BALANCE_CHECK');
  }

  async awardForWalletCreation(userId, username) {
    // Idempotency: award wallet creation XP only once per user
    try {
      const existing = await XPTransaction.findOne({ userId, action: 'WALLET_CREATION' }).lean();
      if (existing) {
        logger.info(`User ${username} already received wallet creation XP - no additional XP awarded`);
        return 0;
      }
    } catch (checkError) {
      logger.error('Error checking existing WALLET_CREATION XP transaction:', checkError);
      // Proceeding without awarding duplicate XP if check fails is safer; fall through to attempt award
    }
    return this.awardXP(userId, username, 'WALLET_CREATION');
  }

  async awardForDripUsage(userId, username, dripDetails) {
    return this.awardXP(userId, username, 'DRIP_USAGE', dripDetails);
  }

  async awardForGiveawayCreation(userId, username, giveawayDetails) {
    return this.awardXP(userId, username, 'GIVEAWAY_CREATION', giveawayDetails);
  }

  async awardForGiveawayParticipation(userId, username, giveawayDetails) {
    return this.awardXP(userId, username, 'GIVEAWAY_PARTICIPATION', giveawayDetails);
  }
}

module.exports = {
  XPService,
  XPTransaction,
  UserXP,
  Leaderboard,
  DailyActivity,
  RewardSnapshotState,
  PeriodRewardSnapshot,
  XP_REWARDS,
  LEVEL_THRESHOLDS
};