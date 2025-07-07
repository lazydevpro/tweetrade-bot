require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const { createViemAccount } = require('@privy-io/server-auth/viem');
const { createWalletClient, http, parseEther } = require('viem');
const privy = require('./privyService');
const { getSwap } = require('sushi');

/**
 * @file privyUserService.js
 * @description Manages user wallets, tweet history, and transaction operations using Privy and MongoDB.
 */

// --- MongoDB Setup ---
const MONGO_URI = process.env.MONGO_URI;
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY; // 32 bytes hex string
const IV_LENGTH = 16;

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

/**
 * Mongoose model for user wallets.
 * @typedef {object} Wallet
 * @property {string} twitterUserId - Twitter user ID (unique).
 * @property {string} walletId - Wallet ID.
 * @property {string} address - Ethereum address.
 * @property {string} encryptedPrivateKey - Encrypted private key.
 * @property {string} username - Twitter username.
 * @property {Date} createdAt - Creation date.
 */
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

/**
 * Mongoose model for tweet history.
 * @typedef {object} TweetHistory
 * @property {string} twitterUserId - Twitter user ID (unique).
 * @property {Array<object>} history - Array of tweet history entries.
 */
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
/**
 * Get or create a wallet for a Twitter user.
 * @param {string} twitterUserId - Twitter user ID.
 * @param {string} [username] - Optional Twitter username.
 * @returns {Promise<{id: string, address: string}>} Wallet info.
 */
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

/**
 * Get a wallet for a Twitter user by user ID.
 * @param {string} twitterUserId - Twitter user ID.
 * @returns {Promise<Wallet|null>} Wallet document or null.
 */
async function getWalletForUser(userId) {
  // Return a promise for consistency
  return Wallet.findOne({ twitterUserId: userId }).then(doc => {
    if (!doc) return null;
    return { id: doc.walletId, address: doc.address };
  });
}

/**
 * Get a wallet for a user by username.
 * @param {string} username - Twitter username.
 * @returns {Promise<Wallet|null>} Wallet document or null.
 */
async function getWalletByUsername(username) {
  return Wallet.findOne({ username });
}

/**
 * Get the balance for a user's wallet.
 * @param {string} walletId - Wallet ID.
 * @returns {Promise<string>} Balance as a string.
 */
async function getBalance(address) {
  const { ethers } = require('ethers');
  const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL);
  const balance = await provider.getBalance(address);
  return ethers.formatEther(balance);
}

/**
 * Send a native token transaction from a user's wallet.
 * @param {string} walletId - Wallet ID.
 * @param {string} to - Recipient address.
 * @param {string|number} amount - Amount to send.
 * @returns {Promise<{hash: string}>} Transaction hash.
 */
async function sendTransaction(walletId, to, amount) {
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
      default: { name: 'Metis Explorer', url: process.env.BLOCK_EXPLORER_URL || '' },
    },
    testnet: true,
  };
  const client = createWalletClient({
    account,
    chain: metisChain,
    transport: http(process.env.ETH_RPC_URL)
  });
  const hash = await client.sendTransaction({
    to,
    value: parseEther(amount.toString()),
  });
  return { hash };
}

/**
 * Send a contract transaction from a user's wallet.
 * @param {string} walletId - Wallet ID.
 * @param {object} transaction - Transaction data (to, data, value, gas).
 * @returns {Promise<{hash: string}>} Transaction hash.
 */
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
      default: { name: 'Metis Explorer', url: process.env.BLOCK_EXPLORER_URL || '' },
    },
    testnet: false,
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

/**
 * Swap METIS to USDT using SushiSwap for a user's wallet.
 * @param {string} walletId - Wallet ID.
 * @param {string|number} amountInMetis - Amount of METIS to swap.
 * @param {number} [slippage] - Max slippage (default 0.005).
 * @returns {Promise<object>} Transaction result.
 */
async function swapMetisToUSDTWithSushi(walletId, amountInMetis, slippage = 0.005) {
  // SushiSwap Metis chain config
  const chainId = 1088;
  const tokenIn = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // METIS
  const tokenOut = '0xbB06DCA3AE6887fAbF931640f67cab3e3a16F4dC'; // USDT on Metis
  const { parseEther } = require('viem');

  // 1. Get sender wallet address
  const walletDoc = await Wallet.findOne({ walletId });
  if (!walletDoc) throw new Error('Wallet not found for walletId: ' + walletId);
  const sender = walletDoc.address;

  // 2. Get swap transaction details from Sushi API/SDK
  const swapData = await getSwap({
    chainId,
    tokenIn,
    tokenOut,
    amount: parseEther(amountInMetis.toString()),
    maxSlippage: slippage,
    sender,
  });

  if (swapData.status !== 'Success') throw new Error('Swap estimate failed: ' + (swapData.message || 'Unknown error'));

  // 3. Use the tx object from Sushi API response directly
  const txData = {
    to: swapData.tx.to,
    data: swapData.tx.data,
    value: BigInt(swapData.tx.value),
  };

  // 4. Send the transaction using Privy signing
  return await sendContractTransaction(walletId, txData);
}

/**
 * Add a tweet reply to a user's tweet history.
 * @param {string} twitterUserId - Twitter user ID.
 * @param {object} replyData - Reply data object.
 * @returns {Promise<void>}
 */
async function addTweetReplyToHistory(twitterUserId, tweetObj) {
  // tweetObj: {tweetId, tweetText, replyId, replyText, createdAt, repliedAt, status, error}
  await TweetHistory.updateOne(
    { twitterUserId },
    { $push: { history: tweetObj } },
    { upsert: true }
  );
}

/**
 * Get tweet history for a user.
 * @param {string} twitterUserId - Twitter user ID.
 * @returns {Promise<Array<object>>} Array of tweet history entries.
 */
async function getTweetHistoryForUser(twitterUserId) {
  const doc = await TweetHistory.findOne({ twitterUserId });
  return doc ? doc.history : [];
}

module.exports = { getOrCreateWalletForUser, getWalletForUser, getWalletByUsername, getBalance, sendTransaction, sendContractTransaction, swapMetisToUSDTWithSushi, Tweet, TweetHistory, addTweetReplyToHistory, getTweetHistoryForUser };