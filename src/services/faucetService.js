const { ethers } = require('ethers');
const { DripCooldown } = require('./privyUserService');

// Simple console logger fallback
const createSimpleLogger = () => {
  return {
    info: (message, meta = {}) => console.log(`[INFO] ${message}`, meta),
    warn: (message, meta = {}) => console.warn(`[WARN] ${message}`, meta),
    error: (message, meta = {}) => console.error(`[ERROR] ${message}`, meta)
  };
};

// Try to use winston logger, fallback to simple console logger
let logger;
try {
  const { setupLogger } = require('../utils/logger');
  logger = setupLogger();
} catch (error) {
  console.warn('Winston logger failed to initialize, using console logger');
  logger = createSimpleLogger();
}

const faucetABI = require('../../contracts/FaucetDripper.json');

class FaucetService {
  constructor() {
    this.provider = null;
    this.wallet = null;
    this.contract = null;
    this.contractAddress = process.env.FAUCET_CONTRACT_ADDRESS;
    this.dripCooldowns = new Map(); // Track user cooldowns locally as backup
  }

  async initialize() {
    try {
      // Initialize provider (using same setup as other services)
      this.provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL || 'https://andromeda.metis.io/?owner=1088');
      
      // Initialize bot wallet for faucet operations
      if (!process.env.FAUCET_PRIVATE_KEY) {
        throw new Error('FAUCET_PRIVATE_KEY environment variable is required');
      }
      
      this.wallet = new ethers.Wallet(process.env.FAUCET_PRIVATE_KEY, this.provider);
      
      if (!this.contractAddress) {
        throw new Error('FAUCET_CONTRACT_ADDRESS environment variable is required');
      }
      
      // Initialize contract
      this.contract = new ethers.Contract(this.contractAddress, faucetABI, this.wallet);
      
      logger.info('Faucet service initialized', {
        contractAddress: this.contractAddress,
        botAddress: this.wallet.address
      });
      
      // Verify bot is manager
      const isManager = await this.contract.isManager(this.wallet.address);
      if (!isManager) {
        logger.warn('Bot wallet is not a manager on the faucet contract', {
          botAddress: this.wallet.address,
          contractAddress: this.contractAddress
        });
      }
      
    } catch (error) {
      logger.error('Failed to initialize faucet service', { error: error.message });
      throw error;
    }
  }

  async canUserReceiveDrip(userAddress) {
    try {
      if (!this.contract) {
        await this.initialize();
      }

      // Hardcoded 24-hour cooldown (in seconds)
      const HARDCODED_COOLDOWN = 24 * 60 * 60; // 24 hours in seconds
      
      // Check last drip time from contract
      const lastDripTime = await this.contract.lastDripTime(userAddress);
      const currentTime = Math.floor(Date.now() / 1000);
      const nextAllowedTime = Number(lastDripTime) + HARDCODED_COOLDOWN;

      if (currentTime < nextAllowedTime) {
        const timeRemaining = nextAllowedTime - currentTime;
        const hoursRemaining = Math.ceil(timeRemaining / 3600);
        return {
          canDrip: false,
          reason: `Drip cooldown active. Try again in ${hoursRemaining} hours.`,
          timeRemaining: timeRemaining
        };
      }

      return { canDrip: true };
    } catch (error) {
      logger.error('Error checking drip eligibility', { error: error.message, userAddress });
      throw error;
    }
  }

  // Check if a Twitter user (tweet author) can request a drip
  async canUserRequestDrip(twitterUserId) {
    try {
      if (!this.contract) {
        await this.initialize();
      }

      // Hardcoded 24-hour cooldown (in seconds)
      const HARDCODED_COOLDOWN = 24 * 60 * 60; // 24 hours in seconds

      // Check last drip time for this Twitter user from database
      const cooldownRecord = await DripCooldown.findOne({ twitterUserId });
      
      if (!cooldownRecord) {
        // User has never dripped before
        return { canDrip: true };
      }

      const lastUserDripTime = Math.floor(cooldownRecord.lastDripTime.getTime() / 1000);
      const currentTime = Math.floor(Date.now() / 1000);
      const nextAllowedTime = lastUserDripTime + HARDCODED_COOLDOWN;

      if (currentTime < nextAllowedTime) {
        const timeRemaining = nextAllowedTime - currentTime;
        const hoursRemaining = Math.ceil(timeRemaining / 3600);
        return {
          canDrip: false,
          reason: `You can only request drip once per 24 hours. Try again in ${hoursRemaining} hours.`,
          timeRemaining: timeRemaining
        };
      }

      return { canDrip: true };
    } catch (error) {
      logger.error('Error checking user drip eligibility', { error: error.message, twitterUserId });
      throw error;
    }
  }

  async dripToUser(userAddress, twitterUserId = null) {
    try {
      if (!this.contract) {
        await this.initialize();
      }

      // Validate address
      if (!ethers.isAddress(userAddress)) {
        throw new Error('Invalid Ethereum address');
      }

      // NEW: If twitterUserId is provided, check user-level cooldown first
      if (twitterUserId) {
        const userEligibility = await this.canUserRequestDrip(twitterUserId);
        if (!userEligibility.canDrip) {
          throw new Error(userEligibility.reason);
        }
      }

      // Check if user can receive drip (address-level check)
      const eligibility = await this.canUserReceiveDrip(userAddress);
      if (!eligibility.canDrip) {
        throw new Error(eligibility.reason);
      }

      // Check contract balance
      const contractBalance = await this.provider.getBalance(this.contractAddress);
      const dripAmount = await this.contract.dripAmount();
      
      if (contractBalance < dripAmount) {
        throw new Error('Faucet contract has insufficient balance');
      }

      // Execute drip transaction
      const tx = await this.contract.drip(userAddress, {
        gasLimit: 100000 // Set reasonable gas limit
      });

      logger.info('Drip transaction sent', {
        txHash: tx.hash,
        to: userAddress,
        twitterUserId: twitterUserId,
        amount: ethers.formatEther(dripAmount)
      });

      // Wait for transaction confirmation
      const receipt = await tx.wait();
      
      if (receipt.status === 1) {
        // Update user cooldown in database if twitterUserId is provided
        if (twitterUserId) {
          try {
            await DripCooldown.findOneAndUpdate(
              { twitterUserId },
              {
                twitterUserId,
                lastDripTime: new Date(),
                targetAddress: userAddress,
                txHash: tx.hash
              },
              { upsert: true, new: true }
            );
          } catch (dbError) {
            logger.warn('Failed to update drip cooldown in database', { 
              error: dbError.message, 
              twitterUserId 
            });
            // Don't fail the transaction for database issues
          }
        }

        logger.info('Drip transaction confirmed', {
          txHash: tx.hash,
          to: userAddress,
          twitterUserId: twitterUserId,
          blockNumber: receipt.blockNumber
        });

        return {
          success: true,
          txHash: tx.hash,
          amount: ethers.formatEther(dripAmount),
          blockNumber: receipt.blockNumber
        };
      } else {
        throw new Error('Transaction failed');
      }

    } catch (error) {
      logger.error('Error executing drip', { error: error.message, userAddress, twitterUserId });
      
      // Parse specific error messages from contract
      if (error.message.includes('You can only request drip once per 24 hours')) {
        // Pass through our user-level cooldown message
        throw error;
      } else if (error.message.includes('Drip cooldown active')) {
        throw new Error('This address can only receive drip once per 24 hours. Please try again later.');
      } else if (error.message.includes('Insufficient balance')) {
        throw new Error('Faucet is currently empty. Please try again later.');
      } else if (error.message.includes('Not a manager')) {
        throw new Error('Bot is not authorized to drip funds. Contact administrator.');
      }
      
      throw error;
    }
  }

  async getFaucetInfo() {
    try {
      if (!this.contract) {
        await this.initialize();
      }

      const [dripAmount, frequencyLimit, contractBalance] = await Promise.all([
        this.contract.dripAmount(),
        this.contract.frequencyLimit(),
        this.provider.getBalance(this.contractAddress)
      ]);

      return {
        dripAmount: ethers.formatEther(dripAmount),
        frequencyLimitHours: Number(frequencyLimit) / 3600,
        contractBalance: ethers.formatEther(contractBalance),
        contractAddress: this.contractAddress
      };
    } catch (error) {
      logger.error('Error getting faucet info', { error: error.message });
      throw error;
    }
  }
}

// Create singleton instance
const faucetService = new FaucetService();

module.exports = faucetService;