const { ethers } = require('ethers');
const { setupLogger } = require('../utils/logger');

const logger = setupLogger();

// Initialize provider and wallet immediately
if (!process.env.ETH_RPC_URL) {
  throw new Error('ETH_RPC_URL environment variable is not set');
}
if (!process.env.ETH_PRIVATE_KEY) {
  throw new Error('ETH_PRIVATE_KEY environment variable is not set');
}

let provider;
let wallet;
try {
  provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL);
  wallet = new ethers.Wallet(process.env.ETH_PRIVATE_KEY, provider);
  logger.info('Ethereum client initialized successfully');
} catch (error) {
  logger.error('Failed to initialize Ethereum client:', error);
  throw new Error('Failed to initialize Ethereum client. Please check your credentials.');
}

async function executeTransaction({ amount, token, recipient }) {
  try {
    logger.info('Executing transaction:', { amount, token, recipient });

    // For now, we only support the native token.
    // Allow for different names for the native token, like 'ETH', 'MATIC', 'POL'.
    const nativeTokens = ['ETH', 'MATIC', 'POL', 'METIS'];
    if (!nativeTokens.includes(token.toUpperCase())) {
      throw new Error(`Unsupported currency: ${token}`);
    }

    // Convert amount to Wei
    const amountInWei = ethers.parseEther(amount.toString());

    // Prepare transaction
    const tx = {
      to: recipient,
      value: amountInWei,
    };

    // Estimate gas
    const gasEstimate = await provider.estimateGas(tx);
    tx.gasLimit = gasEstimate;

    // Send transaction
    const transaction = await wallet.sendTransaction(tx);
    logger.info('Transaction sent:', { hash: transaction.hash });

    // Wait for confirmation
    const receipt = await transaction.wait();
    logger.info('Transaction confirmed:', {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });

    return receipt;
  } catch (error) {
    logger.error('Error executing transaction:', error);
    throw error;
  }
}

module.exports = {
  provider,
  wallet,
  executeTransaction,
}; 