const { ethers } = require('ethers');
const { setupLogger } = require('../utils/logger');
const { Leaderboard, PeriodRewardSnapshot } = require('./xpService');
const { provider } = require('./ethereumService');

const logger = setupLogger();

class RewardService {
  constructor() {
    this.contract = null;
    this.signer = null;
    this.contractAddress = process.env.REWARD_CONTRACT_ADDRESS;
    this.signerPrivateKey = process.env.REWARD_SIGNER_PRIVATE_KEY;
    this.periodDuration = null;
    this.epochStart = null;
    this.snapshotJob = null;
    this.checkInterval = null;
    
    if (this.contractAddress && this.signerPrivateKey) {
      this.initialize();
      this.startSnapshotJob();
    } else {
      logger.warn('Reward service not fully initialized - missing contract address or signer key');
    }
  }

  async initialize() {
    try {
      if (!this.contractAddress) {
        throw new Error('REWARD_CONTRACT_ADDRESS not set');
      }
      if (!this.signerPrivateKey) {
        throw new Error('REWARD_SIGNER_PRIVATE_KEY not set');
      }

      // Load contract ABI (will be generated after compilation)
      let contractABI;
      try {
        const fs = require('fs');
        const path = require('path');
        const abiPath = path.join(__dirname, '../../contracts/XPRewardPool.json');
        if (fs.existsSync(abiPath)) {
          const abiContent = fs.readFileSync(abiPath, 'utf8');
          const abiJson = JSON.parse(abiContent);
          contractABI = abiJson.abi || abiJson;
        } else {
          throw new Error('ABI file not found');
        }
      } catch (error) {
        logger.warn('Contract ABI not found, using minimal ABI. Deploy contract and generate ABI first.');
        // Minimal ABI for basic operations
        contractABI = [
          "function getPeriodDuration() view returns (uint256)",
          "function getCurrentPeriodId() view returns (uint256)",
          "function calculatePeriodId(uint256 timestamp) view returns (uint256)",
          "function poolExists(uint256 periodId) view returns (bool)",
          "function getAvailablePeriods() view returns (uint256[])",
          "function getClaimableReward(uint256 periodId, address user, uint256 rank) view returns (uint256)",
          "function hasClaimed(uint256 periodId, address user) view returns (bool)",
          "function userPeriodNonces(address user, uint256 periodId) view returns (uint256)",
          "function claimReward(uint256 periodId, address user, uint256 rank, uint256 rewardAmount, uint256 nonce, bytes signature)"
        ];
      }

      // Initialize contract
      this.contract = new ethers.Contract(this.contractAddress, contractABI, provider);

      // Initialize signer
      this.signer = new ethers.Wallet(this.signerPrivateKey, provider);

      // Get period duration from contract
      try {
        this.periodDuration = await this.contract.getPeriodDuration();
        logger.info('Reward service initialized', { contractAddress: this.contractAddress });
      } catch (error) {
        logger.warn('Could not get period duration from contract, using env var');
        this.periodDuration = this.convertDurationToSeconds(
          parseInt(process.env.PERIOD_DURATION || '604800'),
          process.env.PERIOD_DURATION_UNIT || 'seconds'
        );
      }

      // Get epoch start (if available in contract, otherwise use env or deployment time)
      this.epochStart = process.env.PERIOD_EPOCH_START 
        ? parseInt(process.env.PERIOD_EPOCH_START) 
        : Math.floor(Date.now() / 1000);

    } catch (error) {
      logger.error('Error initializing reward service:', error);
      throw error;
    }
  }

  // Convert duration to seconds
  convertDurationToSeconds(duration, unit) {
    if (unit === 'days') {
      return duration * 24 * 60 * 60;
    } else if (unit === 'hours') {
      return duration * 60 * 60;
    } else if (unit === 'seconds') {
      return duration;
    } else {
      throw new Error(`Invalid duration unit: ${unit}. Use 'days', 'hours', or 'seconds'`);
    }
  }

  // Get period duration from contract or config
  async getPeriodDuration() {
    if (this.contract && this.periodDuration) {
      try {
        const duration = await this.contract.getPeriodDuration();
        this.periodDuration = Number(duration);
        return this.periodDuration;
      } catch (error) {
        logger.warn('Could not get period duration from contract, using cached value');
      }
    }
    
    if (!this.periodDuration) {
      const envDuration = parseInt(process.env.PERIOD_DURATION || '604800');
      const unit = process.env.PERIOD_DURATION_UNIT || 'seconds';
      this.periodDuration = this.convertDurationToSeconds(envDuration, unit);
    }
    
    return this.periodDuration;
  }

  // Set period duration (admin only)
  async setPeriodDuration(durationInSeconds) {
    if (!this.contract) {
      throw new Error('Contract not initialized');
    }
    // This would require admin wallet, not signer wallet
    // For now, just update local cache
    this.periodDuration = durationInSeconds;
    logger.info('Period duration updated locally', { duration: durationInSeconds });
  }

  // Calculate period ID for a timestamp
  async calculatePeriodId(timestamp) {
    const duration = await this.getPeriodDuration();
    const epoch = this.epochStart;
    
    if (timestamp < epoch) {
      throw new Error('Timestamp before epoch start');
    }
    
    return Math.floor((timestamp - epoch) / duration);
  }

  // Get current period ID
  async getCurrentPeriodId() {
    if (this.contract) {
      try {
        const periodId = await this.contract.getCurrentPeriodId();
        return Number(periodId);
      } catch (error) {
        logger.warn('Could not get current period from contract, calculating locally');
      }
    }
    
    const now = Math.floor(Date.now() / 1000);
    return await this.calculatePeriodId(now);
  }

  // Get period info (start, end, duration)
  async getPeriodInfo(periodId) {
    const duration = await this.getPeriodDuration();
    const periodStart = this.epochStart + (periodId * duration);
    const periodEnd = periodStart + duration;
    
    return {
      periodId,
      periodStart: new Date(periodStart * 1000),
      periodEnd: new Date(periodEnd * 1000),
      duration
    };
  }

  // Snapshot leaderboard at period end
  async snapshotLeaderboard(periodId, topN) {
    try {
      const periodInfo = await this.getPeriodInfo(periodId);
      
      // Get top N users from leaderboard
      const topUsers = await Leaderboard.find({})
        .sort({ totalXP: -1, rank: 1 })
        .limit(topN);

      if (topUsers.length === 0) {
        logger.warn(`No users found for period ${periodId} snapshot`);
        return [];
      }

      // Handle tied ranks
      const processedUsers = await this.handleTiedRanks(topUsers);

      // Get reward distribution from config
      const rewardDistribution = this.getRewardDistribution();
      const tokenAddress = process.env.REWARD_TOKEN_ADDRESS || ethers.ZeroAddress; // address(0) for native

      const snapshots = [];

      for (let i = 0; i < processedUsers.length; i++) {
        const user = processedUsers[i];
        const rank = i + 1;
        const rewardAmount = rewardDistribution[rank.toString()] || '0';

        // Only create snapshot if user has reward
        if (rewardAmount && rewardAmount !== '0') {
          const snapshot = new PeriodRewardSnapshot({
            periodId,
            periodDuration: periodInfo.duration,
            periodStart: periodInfo.periodStart,
            periodEnd: periodInfo.periodEnd,
            userId: user.userId,
            username: user.username,
            rank,
            totalXP: user.totalXP,
            rewardAmount: ethers.parseEther(rewardAmount).toString(),
            tokenAddress,
            claimed: false
          });

          await snapshot.save();
          snapshots.push(snapshot);
        }
      }

      logger.info(`Created snapshot for period ${periodId}`, { 
        periodId, 
        usersSnapshotted: snapshots.length,
        topN 
      });

      return snapshots;
    } catch (error) {
      logger.error('Error snapshotting leaderboard:', error);
      throw error;
    }
  }

  // Handle tied ranks (users with same XP)
  async handleTiedRanks(users) {
    // Group users by XP
    const xpGroups = {};
    for (const user of users) {
      if (!xpGroups[user.totalXP]) {
        xpGroups[user.totalXP] = [];
      }
      xpGroups[user.totalXP].push(user);
    }

    const processed = [];
    let currentRank = 1;

    // Sort by XP descending
    const sortedXPs = Object.keys(xpGroups).sort((a, b) => b - a);

    for (const xp of sortedXPs) {
      const tiedUsers = xpGroups[xp];
      
      if (tiedUsers.length === 1) {
        // No tie, assign rank normally
        processed.push(tiedUsers[0]);
        currentRank++;
      } else {
        // Tie detected - use first to reach that XP (earliest user ID or alphabetical)
        // For simplicity, sort by userId (alphabetical)
        tiedUsers.sort((a, b) => a.userId.localeCompare(b.userId));
        processed.push(...tiedUsers);
        currentRank += tiedUsers.length;
      }
    }

    return processed;
  }

  // Get reward distribution from config
  getRewardDistribution() {
    try {
      const distributionStr = process.env.REWARD_DISTRIBUTION || '{"1":"10","2":"8","3":"5"}';
      return JSON.parse(distributionStr);
    } catch (error) {
      logger.error('Error parsing reward distribution:', error);
      return { "1": "10", "2": "8", "3": "5" }; // Default
    }
  }

  // Validate reward distribution
  async validateRewardDistribution(ranks, amounts, poolAmount) {
    if (ranks.length !== amounts.length) {
      throw new Error('Ranks and amounts arrays must have same length');
    }

    let total = ethers.parseEther('0');
    for (const amount of amounts) {
      total = total + ethers.parseEther(amount.toString());
    }

    const poolAmountWei = ethers.parseEther(poolAmount.toString());
    if (total > poolAmountWei) {
      throw new Error(`Total rewards (${ethers.formatEther(total)}) exceed pool amount (${poolAmount})`);
    }

    // Check for duplicate ranks
    const seenRanks = new Set();
    for (const rank of ranks) {
      if (seenRanks.has(rank)) {
        throw new Error(`Duplicate rank found: ${rank}`);
      }
      seenRanks.add(rank);
    }

    return true;
  }

  // Get user's rank for a period
  async getUserRankForPeriod(userId, periodId) {
    try {
      const snapshot = await PeriodRewardSnapshot.findOne({
        periodId,
        userId
      });

      if (!snapshot) {
        return null; // User not in top N for this period
      }

      return snapshot.rank;
    } catch (error) {
      logger.error('Error getting user rank for period:', error);
      return null;
    }
  }

  // Get user's reward for a period
  async getUserRewardForPeriod(userId, periodId) {
    try {
      const snapshot = await PeriodRewardSnapshot.findOne({
        periodId,
        userId
      });

      if (!snapshot) {
        return null; // User not in top N for this period
      }

      return {
        rank: snapshot.rank,
        rewardAmount: snapshot.rewardAmount,
        tokenAddress: snapshot.tokenAddress,
        claimed: snapshot.claimed
      };
    } catch (error) {
      logger.error('Error getting user reward for period:', error);
      return null;
    }
  }

  // Generate EIP-712 signature for claim
  async generateClaimSignature(periodId, userAddress, rank, rewardAmount, nonce) {
    try {
      if (!this.signer) {
        throw new Error('Signer not initialized');
      }

      const domain = {
        name: 'XPRewardPool',
        version: '1',
        chainId: await provider.getNetwork().then(n => Number(n.chainId)),
        verifyingContract: this.contractAddress
      };

      const types = {
        Claim: [
          { name: 'periodId', type: 'uint256' },
          { name: 'user', type: 'address' },
          { name: 'rank', type: 'uint256' },
          { name: 'rewardAmount', type: 'uint256' },
          { name: 'nonce', type: 'uint256' }
        ]
      };

      const message = {
        periodId,
        user: userAddress,
        rank,
        rewardAmount: BigInt(rewardAmount),
        nonce
      };

      const signature = await this.signer.signTypedData(domain, types, message);
      
      logger.info('Generated claim signature', { periodId, userAddress, rank });
      
      return signature;
    } catch (error) {
      logger.error('Error generating claim signature:', error);
      throw error;
    }
  }

  // Verify eligibility (checks both snapshot and contract pool)
  async verifyEligibility(userId, periodId) {
    try {
      // Check snapshot exists
      const snapshot = await PeriodRewardSnapshot.findOne({
        periodId,
        userId
      });

      if (!snapshot) {
        return { eligible: false, reason: 'User not in top N for this period' };
      }

      if (snapshot.claimed) {
        return { eligible: false, reason: 'Reward already claimed for this period' };
      }

      // Check pool exists in contract
      if (this.contract) {
        try {
          const poolExists = await this.contract.poolExists(periodId);
          if (!poolExists) {
            return { eligible: false, reason: 'Pool does not exist for this period' };
          }
        } catch (error) {
          logger.warn('Could not check pool existence in contract:', error);
        }
      }

      return {
        eligible: true,
        rank: snapshot.rank,
        rewardAmount: snapshot.rewardAmount,
        tokenAddress: snapshot.tokenAddress
      };
    } catch (error) {
      logger.error('Error verifying eligibility:', error);
      return { eligible: false, reason: 'Error checking eligibility' };
    }
  }

  // Get claimable rewards for a user
  async getClaimableRewards(userId) {
    try {
      // Get all unclaimed snapshots for user
      const snapshots = await PeriodRewardSnapshot.find({
        userId,
        claimed: false
      }).sort({ periodId: -1 });

      if (snapshots.length === 0) {
        return [];
      }

      // Filter to only periods with pools
      const claimableRewards = [];
      
      for (const snapshot of snapshots) {
        if (this.contract) {
          try {
            const poolExists = await this.contract.poolExists(snapshot.periodId);
            if (poolExists) {
              claimableRewards.push({
                periodId: snapshot.periodId,
                rank: snapshot.rank,
                rewardAmount: snapshot.rewardAmount,
                tokenAddress: snapshot.tokenAddress,
                periodEnd: snapshot.periodEnd
              });
            }
          } catch (error) {
            logger.warn(`Could not verify pool for period ${snapshot.periodId}:`, error);
          }
        } else {
          // If contract not available, include all unclaimed
          claimableRewards.push({
            periodId: snapshot.periodId,
            rank: snapshot.rank,
            rewardAmount: snapshot.rewardAmount,
            tokenAddress: snapshot.tokenAddress,
            periodEnd: snapshot.periodEnd
          });
        }
      }

      return claimableRewards;
    } catch (error) {
      logger.error('Error getting claimable rewards:', error);
      return [];
    }
  }

  // Get available periods (periods with pools)
  async getAvailablePeriods() {
    try {
      if (!this.contract) {
        return [];
      }

      const periods = await this.contract.getAvailablePeriods();
      return periods.map(p => Number(p));
    } catch (error) {
      logger.error('Error getting available periods:', error);
      return [];
    }
  }

  // Check if pool exists for a period
  async checkPoolExists(periodId) {
    try {
      if (!this.contract) {
        return false;
      }

      return await this.contract.poolExists(periodId);
    } catch (error) {
      logger.error('Error checking pool existence:', error);
      return false;
    }
  }

  // Get periods where user has unclaimed rewards
  async getPeriodsWithRewards(userId) {
    try {
      const snapshots = await PeriodRewardSnapshot.find({
        userId,
        claimed: false
      }).select('periodId').distinct('periodId');

      return snapshots.map(s => s.periodId || s);
    } catch (error) {
      logger.error('Error getting periods with rewards:', error);
      return [];
    }
  }

  // Prepare claim transaction data for user
  async prepareClaimTransaction(periodId, userAddress, rank, rewardAmount, nonce) {
    try {
      const signature = await this.generateClaimSignature(periodId, userAddress, rank, rewardAmount, nonce);
      
      return {
        contractAddress: this.contractAddress,
        functionName: 'claimReward',
        parameters: {
          periodId,
          user: userAddress,
          rank,
          rewardAmount,
          nonce,
          signature
        },
        signature,
        // Encoded data for direct transaction
        encodedData: this.contract.interface.encodeFunctionData('claimReward', [
          periodId,
          userAddress,
          rank,
          rewardAmount,
          nonce,
          signature
        ])
      };
    } catch (error) {
      logger.error('Error preparing claim transaction:', error);
      throw error;
    }
  }

  // Start period snapshot job
  startSnapshotJob() {
    const checkInterval = parseInt(process.env.SNAPSHOT_CHECK_INTERVAL || '3600'); // Default: 1 hour
    
    // Check every interval if period has ended
    this.checkInterval = setInterval(async () => {
      try {
        await this.checkAndSnapshotPeriod();
      } catch (error) {
        logger.error('Error in snapshot check interval:', error);
      }
    }, checkInterval * 1000);

    logger.info('Period snapshot job started', { checkIntervalSeconds: checkInterval });
  }

  // Check if period ended and create snapshot
  async checkAndSnapshotPeriod() {
    try {
      const currentPeriodId = await this.getCurrentPeriodId();
      const periodInfo = await this.getPeriodInfo(currentPeriodId);
      const now = Math.floor(Date.now() / 1000);
      const periodEndTimestamp = Math.floor(periodInfo.periodEnd.getTime() / 1000);

      // Check if current period has ended
      if (now >= periodEndTimestamp) {
        // Period has ended, check if snapshot already exists
        const existingSnapshot = await PeriodRewardSnapshot.findOne({
          periodId: currentPeriodId
        });

        if (!existingSnapshot) {
          // Create snapshot for the period that just ended
          const topN = parseInt(process.env.REWARD_TOP_N || '10');
          await this.snapshotLeaderboard(currentPeriodId, topN);
          logger.info(`Snapshot created for period ${currentPeriodId}`);
        }
      }
    } catch (error) {
      logger.error('Error checking and snapshotting period:', error);
    }
  }

  // Stop snapshot job
  stopSnapshotJob() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Period snapshot job stopped');
    }
  }
}

// Create singleton instance
const rewardService = new RewardService();

module.exports = rewardService;

