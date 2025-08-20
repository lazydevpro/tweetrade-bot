require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const { createViemAccount } = require('@privy-io/server-auth/viem');
const { createWalletClient, http, parseEther, encodeFunctionData } = require('viem');
const privy = require('./privyService');
const { setupLogger } = require('../utils/logger');
const logger = setupLogger();

// --- MongoDB Setup ---
const MONGO_URI = process.env.MONGO_URI;
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY; // 32 bytes hex string
const IV_LENGTH = 16;

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const WalletSchema = new mongoose.Schema({
  twitterUserId: { type: String, unique: true },
  walletId: String,
  address: String,
  encryptedPrivateKey: String, // Encrypted!
  username: String, // New field
  createdAt: { type: Date, default: Date.now }
});
const Wallet = mongoose.model('Wallet', WalletSchema);

const TweetSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  text: String,
  edit_history_tweet_ids: [String]
});
const Tweet = mongoose.model('Tweet', TweetSchema);

const TweetHistorySchema = new mongoose.Schema({
  twitterUserId: { type: String, unique: true, index: true },
  history: [
    {
      tweetId: String,
      tweetText: String,
      replyId: String,
      replyText: String,
      createdAt: Date,
      repliedAt: Date,
      status: String, // e.g. 'success', 'error'
      error: String // optional
    }
  ]
});
const TweetHistory = mongoose.model('TweetHistory', TweetHistorySchema);

// Add separate chat history schema to keep chat interactions distinct from tweet history
const ChatHistorySchema = new mongoose.Schema({
  twitterUserId: { type: String, unique: true, index: true },
  history: [
    {
      tweetId: String,       // reuse same fields for minimal handler changes
      tweetText: String,     // stores chat message text
      replyId: String,
      replyText: String,
      createdAt: Date,
      repliedAt: Date,
      status: String,
      error: String,
      action: String
    }
  ]
});
const ChatHistory = mongoose.model('ChatHistory', ChatHistorySchema);

// Drip cooldown tracking schema
const DripCooldownSchema = new mongoose.Schema({
  twitterUserId: { type: String, unique: true, index: true },
  lastDripTime: { type: Date, required: true },
  targetAddress: String, // Store the last address they dripped to (for logging/debugging)
  txHash: String, // Store the transaction hash (for logging/debugging)
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

DripCooldownSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const DripCooldown = mongoose.model('DripCooldown', DripCooldownSchema);

// Giveaway schema for contest management
const GiveawaySchema = new mongoose.Schema({
  creatorTwitterUserId: { type: String, required: true, index: true },
  creatorUsername: String,
  tweetUrl: { type: String, required: true },
  tweetId: String, // Extracted from URL
  amount: { type: String, required: true }, // String to handle decimal precision
  token: { type: String, required: true }, // METIS, USDT, etc.
  winners: { type: Number, required: true }, // Number of winners to pick
  duration: { type: String, required: true }, // e.g., "24h", "12h", "48h"
  endTime: { type: Date, required: true }, // Calculated end time
  status: { 
    type: String, 
    enum: ['active', 'completed', 'cancelled'], 
    default: 'active' 
  },
  selectedWinners: [{
    twitterUserId: String,
    username: String,
    commentId: String,
    commentText: String,
    txHash: String, // Transaction hash for prize transfer
    transferStatus: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' }
  }],
  totalPrizeAmount: String, // Total amount needed (amount * winners)
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  confirmationTweetId: String, // Bot's confirmation tweet ID
  resultsTweetId: String // Bot's results announcement tweet ID
});

GiveawaySchema.index({ endTime: 1, status: 1 }); // For efficient querying of active giveaways
const Giveaway = mongoose.model('Giveaway', GiveawaySchema);

// --- Encryption Helpers ---
function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  const [ivHex, tagHex, encrypted] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- Wallet Service ---
async function getOrCreateWalletForUser(twitterUserId, username = null) {
  let walletDoc = await Wallet.findOne({ twitterUserId });
  if (walletDoc) {
    // Optionally update username if provided and different
    if (username && walletDoc.username !== username) {
      walletDoc.username = username;
      await walletDoc.save();
    }
    return { id: walletDoc.walletId, address: walletDoc.address };
  }
  // Create wallet with Privy
  const wallet = await privy.walletApi.create({ chainType: 'ethereum' });
  // Encrypt the private key (if available)
  let encryptedPrivateKey = '';
  if (wallet.privateKey) {
    encryptedPrivateKey = encrypt(wallet.privateKey);
  }
  walletDoc = await Wallet.create({
    twitterUserId,
    walletId: wallet.id,
    address: wallet.address,
    encryptedPrivateKey,
    username: username || null
  });
  return { id: walletDoc.walletId, address: walletDoc.address };
}

async function getWalletForUser(userId) {
  // Return a promise for consistency
  return Wallet.findOne({ twitterUserId: userId }).then(doc => {
    if (!doc) return null;
    return { id: doc.walletId, address: doc.address, username: doc.username };
  });
}

async function getWalletByUsername(username) {
  return Wallet.findOne({ username });
}

async function getBalance(address) {
  const { ethers } = require('ethers');
  const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL);
  const balance = await provider.getBalance(address);
  return ethers.formatEther(balance);
}

// New function to get ERC-20 token balance
async function getTokenBalance(address, tokenAddress, decimals = 18) {
  const { ethers } = require('ethers');
  const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL);
  
  // ERC-20 ABI for balanceOf function
  const erc20ABI = [
    "function balanceOf(address owner) view returns (uint256)"
  ];
  
  const contract = new ethers.Contract(tokenAddress, erc20ABI, provider);
  const balance = await contract.balanceOf(address);
  return ethers.formatUnits(balance, decimals);
}

// Enhanced balance function that returns both METIS and USDT balances
async function getEnhancedBalance(address) {
  const USDT_ADDRESS = '0x3c099e287ec71b4aa61a7110287d715389329237'; // USDT token address
  const USDT_DECIMALS = 6; // USDT typically uses 6 decimals
  
  try {
    // Get both balances in parallel for better performance
    const [metisBalance, usdtBalance] = await Promise.all([
      getBalance(address), // Get native METIS balance
      getTokenBalance(address, USDT_ADDRESS, USDT_DECIMALS) // Get USDT balance
    ]);
    
    return {
      metis: metisBalance,
      usdt: usdtBalance,
      formatted: `${metisBalance} METIS, ${usdtBalance} USDT`
    };
  } catch (error) {
    // Fallback to METIS only if USDT balance fails
    console.error('Error getting USDT balance:', error);
    const metisBalance = await getBalance(address);
    return {
      metis: metisBalance,
      usdt: '0',
      formatted: `${metisBalance} METIS (USDT unavailable)`
    };
  }
}

async function sendTransaction(walletId, to, amount) {
  try {
    console.log('sendTransaction called with:', { walletId, to, amount });
    
    const walletDoc = await Wallet.findOne({ walletId });
    if (!walletDoc) throw new Error('Wallet not found for walletId: ' + walletId);
    
    const address = walletDoc.address;
    console.log('Found wallet:', { address, walletId });
    
    const account = await createViemAccount({ walletId, address, privy });
    console.log('Created Viem account');
    
    const metisChain = {
      id: Number(process.env.CHAIN_ID),
      name: 'Metis',
      network: 'metis',
      nativeCurrency: { name: 'Metis', symbol: 'tMETIS', decimals: 18 },
      rpcUrls: {
        default: { http: [process.env.ETH_RPC_URL] },
        public: { http: [process.env.ETH_RPC_URL] },
      },
      blockExplorers: {
        default: { name: 'Metis Testnet Explorer', url: process.env.BLOCK_EXPLORER_URL || '' },
      },
      testnet: true,
    };
    
    const client = createWalletClient({
      account,
      chain: metisChain,
      transport: http(process.env.ETH_RPC_URL)
    });
    
    console.log('Sending transaction:', { to, amount });
    const hash = await client.sendTransaction({
      to,
      value: parseEther(amount.toString()),
    });
    
    console.log('Transaction sent successfully:', { hash });
    return { hash };
  } catch (error) {
    console.error('Error in sendTransaction:', error);
    throw error;
  }
}

// New function to send USDT tokens
async function sendUSDTTransaction(walletId, to, amount) {
  try {
    console.log('sendUSDTTransaction called with:', { walletId, to, amount });
    
    const USDT_ADDRESS = '0x3c099e287ec71b4aa61a7110287d715389329237';
    const USDT_DECIMALS = 6;
    const { ethers } = require('ethers');
    
    const walletDoc = await Wallet.findOne({ walletId });
    if (!walletDoc) throw new Error('Wallet not found for walletId: ' + walletId);
    
    console.log('Found wallet for USDT transaction:', { address: walletDoc.address, walletId });
  
  const address = walletDoc.address;
  const account = await createViemAccount({ walletId, address, privy });
  
  const metisChain = {
    id: Number(process.env.CHAIN_ID),
    name: 'Metis',
    network: 'metis',
    nativeCurrency: { name: 'Metis', symbol: 'tMETIS', decimals: 18 },
    rpcUrls: {
      default: { http: [process.env.ETH_RPC_URL] },
      public: { http: [process.env.ETH_RPC_URL] },
    },
    blockExplorers: {
      default: { name: 'Metis Testnet Explorer', url: process.env.BLOCK_EXPLORER_URL || '' },
    },
    testnet: true,
  };
  
  const client = createWalletClient({
    account,
    chain: metisChain,
    transport: http(process.env.ETH_RPC_URL)
  });
  
  // ERC-20 transfer function ABI
  const transferABI = [{
    "inputs": [
      {"name": "_to", "type": "address"},
      {"name": "_value", "type": "uint256"}
    ],
    "name": "transfer",
    "outputs": [{"name": "", "type": "bool"}],
    "type": "function"
  }];
  
  // Convert amount to the correct decimal format for USDT (6 decimals)
  const amountInWei = ethers.parseUnits(amount.toString(), USDT_DECIMALS);
  
  // Encode the transfer function call
  const transferData = encodeFunctionData({
    abi: transferABI,
    functionName: 'transfer',
    args: [to, amountInWei]
  });
  
    // Send the contract transaction
    console.log('Sending USDT transaction:', { to, amount: amountInWei.toString(), contractAddress: USDT_ADDRESS });
    const hash = await client.sendTransaction({
      to: USDT_ADDRESS,
      data: transferData,
    });
    
    console.log('USDT transaction sent successfully:', { hash });
    return { hash };
  } catch (error) {
    console.error('Error in sendUSDTTransaction:', error);
    throw error;
  }
}

// Add chat history helpers
async function addChatEntryToHistory(twitterUserId, chatObj) {
  // chatObj uses same shape as tweet history entries for consistency
  await ChatHistory.updateOne(
    { twitterUserId },
    { $push: { history: chatObj } },
    { upsert: true }
  );
}

async function getChatHistoryForUser(twitterUserId) {
  const doc = await ChatHistory.findOne({ twitterUserId });
  return doc ? doc.history : [];
}

// Enhanced send function that supports both METIS and USDT
async function sendTokenTransaction(walletId, to, amount, token = 'METIS') {
  const normalizedToken = token.toUpperCase();
  
  if (normalizedToken === 'METIS' || normalizedToken === 'METIS' || normalizedToken === 'TMETIS') {
    return await sendTransaction(walletId, to, amount);
  } else if (normalizedToken === 'USDT') {
    return await sendUSDTTransaction(walletId, to, amount);
  } else {
    throw new Error(`Unsupported token: ${token}. Only METIS and USDT are supported.`);
  }
}

async function sendContractTransaction(walletId, transaction) {
  const walletDoc = await Wallet.findOne({ walletId });
  if (!walletDoc) throw new Error('Wallet not found for walletId: ' + walletId);
  const address = walletDoc.address;
  const account = await createViemAccount({ walletId, address, privy });
  const metisChain = {
    id: Number(process.env.CHAIN_ID),
    name: 'Metis',
    network: 'metis',
    nativeCurrency: { name: 'Metis', symbol: 'tMETIS', decimals: 18 },
    rpcUrls: {
      default: { http: [process.env.ETH_RPC_URL] },
      public: { http: [process.env.ETH_RPC_URL] },
    },
    blockExplorers: {
      default: { name: 'Metis Testnet Explorer', url: process.env.BLOCK_EXPLORER_URL || '' },
    },
    testnet: true,
  };
  const client = createWalletClient({
    account,
    chain: metisChain,
    transport: http(process.env.ETH_RPC_URL)
  });
  const tx = {
    to: transaction.to,
    data: transaction.data,
    value: transaction.value ? BigInt(transaction.value) : undefined,
    gas: transaction.gas ? BigInt(transaction.gas) : undefined,
  };
  const hash = await client.sendTransaction(tx);
  return { hash };
}

async function swapMetisToUSDTWithSushi(walletId, amountInMetis, slippage = 0.005) {
  // Metis Hyperion DEX configuration based on successful transaction analysis
  const DEX_ROUTER = '0xa1cf48c109f8b5eee38b406591fe27f11f685a1f'; // The working router
  const WETH = '0x94765a5ad79ae18c6913449bf008a0b5f247d301'; // Wrapped ETH token
  const USDT = '0x3c099e287ec71b4aa61a7110287d715389329237'; // USDT token

  // Router ABI for swapExactETHForTokens
  const ROUTER_ABI = [
    {
      "inputs": [
        { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
        { "internalType": "address[]", "name": "path", "type": "address[]" },
        { "internalType": "address", "name": "to", "type": "address" },
        { "internalType": "uint256", "name": "deadline", "type": "uint256" }
      ],
      "name": "swapExactETHForTokens",
      "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
      "stateMutability": "payable",
      "type": "function"
    }
  ];

  // 1. Get sender wallet address
  const walletDoc = await Wallet.findOne({ walletId });
  if (!walletDoc) throw new Error('Wallet not found for walletId: ' + walletId);
  const sender = walletDoc.address;

  // 2. Prepare swap parameters
  const amountIn = parseEther(amountInMetis.toString());
  // Use a much lower minimum output to avoid INSUFFICIENT_OUTPUT_AMOUNT errors
  const amountOutMin = BigInt('0x1'); // 1 wei minimum (very low to ensure success)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 minutes from now
  const path = [WETH, USDT]; // METIS -> WETH -> USDT path

  // 3. Encode the swapExactETHForTokens function call
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'swapExactETHForTokens',
    args: [amountOutMin, path, sender, deadline]
  });

  // 4. Build the transaction
  const txData = {
    to: DEX_ROUTER,
    data,
    value: amountIn, // send METIS as value
  };

  // 5. Send the transaction using Privy signing
  const result = await sendContractTransaction(walletId, txData);
  
  // 6. Create swap transaction record
  try {
    const { SwapTransactionService } = require('./swapTransactionService');
    const swapData = {
      txHash: result.hash,
      twitterUserId: walletDoc.twitterUserId,
      username: walletDoc.username,
      walletAddress: sender,
      fromToken: 'METIS',
      toToken: 'USDT',
      amountIn: amountInMetis.toString(),
      amountOutMin: amountOutMin.toString(),
      slippage: slippage,
      dexRouter: DEX_ROUTER,
      status: 'pending',
      explorerUrl: `https://hyperion-testnet-explorer.metisdevops.link/tx/${result.hash}`
    };
    
    await SwapTransactionService.createSwapTransaction(swapData);
    logger.info('Created swap transaction record for METIS to USDT swap:', { txHash: result.hash });
  } catch (error) {
    logger.error('Failed to create swap transaction record:', error);
    // Don't fail the swap if record creation fails
  }
  
  return result;
}

async function swapUSDTToMetisWithSushi(walletId, amountInUSDT, slippage = 0.005) {
  // Metis Hyperion DEX configuration for reverse swap (USDT -> METIS)
  const DEX_ROUTER = '0xa1cf48c109f8b5eee38b406591fe27f11f685a1f'; // The working router
  const WETH = '0x94765a5ad79ae18c6913449bf008a0b5f247d301'; // Wrapped ETH token
  const USDT = '0x3c099e287ec71b4aa61a7110287d715389329237'; // USDT token

  // Router ABI for swapExactTokensForETH
  const ROUTER_ABI = [
    {
      "inputs": [
        { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
        { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
        { "internalType": "address[]", "name": "path", "type": "address[]" },
        { "internalType": "address", "name": "to", "type": "address" },
        { "internalType": "uint256", "name": "deadline", "type": "uint256" }
      ],
      "name": "swapExactTokensForETH",
      "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
      "stateMutability": "nonpayable",
      "type": "function"
    }
  ];

  // USDT has 6 decimals
  const parseUSDT = (amount) => BigInt(Math.floor(amount * 1000000));

  // 1. Get sender wallet address
  const walletDoc = await Wallet.findOne({ walletId });
  if (!walletDoc) throw new Error('Wallet not found for walletId: ' + walletId);
  const sender = walletDoc.address;

  // 2. Check USDT balance first
  const usdtBalance = await getTokenBalance(sender, USDT, 6); // USDT has 6 decimals
  const amountIn = parseUSDT(amountInUSDT);
  
  // Convert balance to wei for comparison (USDT has 6 decimals)
  const balanceInWei = BigInt(Math.floor(parseFloat(usdtBalance) * 1000000));
  
  if (balanceInWei < amountIn) {
    throw new Error(`Insufficient USDT balance. Have ${usdtBalance} USDT, need ${amountInUSDT} USDT`);
  }

  // 3. Check and handle USDT approval for the router
  const approvalABI = [
    {
      "inputs": [
        { "internalType": "address", "name": "spender", "type": "address" },
        { "internalType": "uint256", "name": "amount", "type": "uint256" }
      ],
      "name": "approve",
      "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
      "stateMutability": "nonpayable",
      "type": "function"
    }
  ];
  
  // Check current allowance
  const allowanceABI = [
    {
      "inputs": [
        { "internalType": "address", "name": "owner", "type": "address" },
        { "internalType": "address", "name": "spender", "type": "address" }
      ],
      "name": "allowance",
      "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
      "stateMutability": "view",
      "type": "function"
    }
  ];
  
  const { createPublicClient, http } = require('viem');
  const metisHyperion = {
    id: 133717,
    name: 'Metis Hyperion',
    network: 'metis',
    nativeCurrency: { name: 'Metis', symbol: 'METIS', decimals: 18 },
    rpcUrls: {
      default: { http: ['https://hyperion-testnet.metisdevops.link'] },
      public: { http: ['https://hyperion-testnet.metisdevops.link'] },
    },
    blockExplorers: {
      default: { name: 'Metis Hyperion Explorer', url: 'https://hyperion-testnet-explorer.metisdevops.link/' },
    },
    testnet: true,
  };
  
  const publicClient = createPublicClient({ chain: metisHyperion, transport: http() });
  
  // Check current allowance
  const allowanceData = encodeFunctionData({
    abi: allowanceABI,
    functionName: 'allowance',
    args: [sender, DEX_ROUTER]
  });
  
  const allowanceResult = await publicClient.call({
    account: sender,
    to: USDT,
    data: allowanceData
  });
  
  const currentAllowance = BigInt(allowanceResult.data || '0x0');
  
  // If allowance is insufficient, send approval transaction
  if (currentAllowance < amountIn) {
    logger.info('USDT allowance insufficient, sending approval transaction...', { 
      currentAllowance: currentAllowance.toString(), 
      requiredAmount: amountIn.toString() 
    });
    
    const approvalData = encodeFunctionData({
      abi: approvalABI,
      functionName: 'approve',
      args: [DEX_ROUTER, amountIn]
    });
    
    const approvalTx = {
      to: USDT,
      data: approvalData,
      value: '0'
    };
    
    // Send approval transaction
    await sendContractTransaction(walletId, approvalTx);
    
    // Wait for approval to be processed
    logger.info('Waiting for USDT approval to be processed...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  } else {
    logger.info('USDT allowance sufficient, proceeding with swap...', { 
      currentAllowance: currentAllowance.toString() 
    });
  }

  // 4. Prepare swap parameters
  const amountOutMin = BigInt('0x1'); // 1 wei minimum (very low to ensure success)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 minutes from now
  const path = [USDT, WETH]; // USDT -> WETH -> METIS path

  // 5. Encode the swapExactTokensForETH function call
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'swapExactTokensForETH',
    args: [amountIn, amountOutMin, path, sender, deadline]
  });

  // 6. Build the transaction
  const txData = {
    to: DEX_ROUTER,
    data,
    value: '0', // No native token being sent, only USDT
  };

  // 7. Send the transaction using Privy signing
  const result = await sendContractTransaction(walletId, txData);
  
  // 8. Create swap transaction record
  try {
    const { SwapTransactionService } = require('./swapTransactionService');
    const swapData = {
      txHash: result.hash,
      twitterUserId: walletDoc.twitterUserId,
      username: walletDoc.username,
      walletAddress: sender,
      fromToken: 'USDT',
      toToken: 'METIS',
      amountIn: amountInUSDT.toString(),
      amountOutMin: amountOutMin.toString(),
      slippage: slippage,
      dexRouter: DEX_ROUTER,
      status: 'pending',
      explorerUrl: `https://hyperion-testnet-explorer.metisdevops.link/tx/${result.hash}`
    };
    
    await SwapTransactionService.createSwapTransaction(swapData);
    logger.info('Created swap transaction record for USDT to METIS swap:', { txHash: result.hash });
  } catch (error) {
    logger.error('Failed to create swap transaction record:', error);
    // Don't fail the swap if record creation fails
  }
  
  return result;
}

async function addTweetReplyToHistory(twitterUserId, tweetObj) {
  // tweetObj: {tweetId, tweetText, replyId, replyText, createdAt, repliedAt, status, error}
  await TweetHistory.updateOne(
    { twitterUserId },
    { $push: { history: tweetObj } },
    { upsert: true }
  );
}

async function getTweetHistoryForUser(twitterUserId) {
  const doc = await TweetHistory.findOne({ twitterUserId });
  return doc ? doc.history : [];
}

module.exports = { getOrCreateWalletForUser, getWalletForUser, getWalletByUsername, getBalance, getTokenBalance, getEnhancedBalance, sendTransaction, sendUSDTTransaction, sendTokenTransaction, sendContractTransaction, swapMetisToUSDTWithSushi, swapUSDTToMetisWithSushi, Tweet, TweetHistory, DripCooldown, Giveaway, addTweetReplyToHistory, getTweetHistoryForUser, encrypt, decrypt, addChatEntryToHistory, getChatHistoryForUser };