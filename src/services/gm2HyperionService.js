const { encodeFunctionData } = require('viem');
const { setupLogger } = require('../utils/logger');
const { sendContractTransaction, getTokenBalance } = require('./privyUserService');

const logger = setupLogger();

const HYPERION_ADDRESS = (process.env.GM2_HYPERION_ADDRESS || '0xC0Fb8775966aa361e6410aaDad2D223826b7c852');

const HYPERION_ABI = [
  {
    inputs: [
      { internalType: 'address', name: '_tokenAddress', type: 'address' },
      { internalType: 'uint256', name: '_amountOut', type: 'uint256' },
    ],
    name: 'estimateEthInForTokensOut',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: '_tokenAddress', type: 'address' },
      { internalType: 'uint256', name: '_amountIn', type: 'uint256' },
    ],
    name: 'estimateEthOutForTokenIn',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: '_tokenAddress', type: 'address' },
      { internalType: 'uint256', name: '_ethIn', type: 'uint256' },
    ],
    name: 'estimateTokensOutForEthIn',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: '_tokenAddress', type: 'address' },
      { internalType: 'uint256', name: '_amountOutMin', type: 'uint256' },
    ],
    name: 'swapExactETHForTokens',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: '_tokenAddress', type: 'address' },
      { internalType: 'uint256', name: '_amountIn', type: 'uint256' },
      { internalType: 'uint256', name: '_amountOutMin', type: 'uint256' },
    ],
    name: 'swapExactTokensForETH',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const ERC20_ABI = [
  { inputs: [], name: 'decimals', outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], name: 'allowance', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'approve', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
];

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

class Gm2HyperionService {
  constructor() {
    const { createPublicClient, http } = require('viem');
    this.publicClient = createPublicClient({ chain: metisHyperion, transport: http() });
  }

  async getTokenDecimals(tokenAddress) {
    try {
      const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'decimals', args: [] });
      const result = await this.publicClient.call({ to: tokenAddress, data });
      // viem returns hex data; parse as BigInt then Number
      const hex = result.data || '0x0';
      return Number(BigInt(hex));
    } catch (e) {
      logger.warn('Failed to fetch token decimals, defaulting to 18', { tokenAddress, error: e.message });
      return 18;
    }
  }

  async estimateTokensOutForEthIn(tokenAddress, ethInWei) {
    const data = encodeFunctionData({ abi: HYPERION_ABI, functionName: 'estimateTokensOutForEthIn', args: [tokenAddress, BigInt(ethInWei)] });
    const result = await this.publicClient.call({ to: HYPERION_ADDRESS, data });
    return BigInt(result.data || '0x0');
  }

  async estimateEthInForTokensOut(tokenAddress, tokensOut) {
    const data = encodeFunctionData({ abi: HYPERION_ABI, functionName: 'estimateEthInForTokensOut', args: [tokenAddress, BigInt(tokensOut)] });
    const result = await this.publicClient.call({ to: HYPERION_ADDRESS, data });
    return BigInt(result.data || '0x0');
  }

  async estimateEthOutForTokenIn(tokenAddress, tokenIn) {
    const data = encodeFunctionData({ abi: HYPERION_ABI, functionName: 'estimateEthOutForTokenIn', args: [tokenAddress, BigInt(tokenIn)] });
    const result = await this.publicClient.call({ to: HYPERION_ADDRESS, data });
    return BigInt(result.data || '0x0');
  }

  async buyWithEth({ walletId, tokenAddress, ethInWei, slippageBps = 50, twitterUserId, username }) {
    // quote tokens out
    const expectedOut = await this.estimateTokensOutForEthIn(tokenAddress, ethInWei);
    const minOut = expectedOut * BigInt(10000 - slippageBps) / 10000n;

    const data = encodeFunctionData({ abi: HYPERION_ABI, functionName: 'swapExactETHForTokens', args: [tokenAddress, minOut] });
    const tx = { to: HYPERION_ADDRESS, data, value: BigInt(ethInWei) };
    const result = await sendContractTransaction(walletId, tx);

    try {
      const { SwapTransactionService } = require('./swapTransactionService');
      const mongoose = require('mongoose');
      const Wallet = mongoose.model('Wallet');
      const walletDoc = await Wallet.findOne({ walletId });
      const swapData = {
        txHash: result.hash,
        twitterUserId: twitterUserId || walletDoc.twitterUserId,
        username: username || walletDoc.username,
        walletAddress: walletDoc.address,
        fromToken: 'METIS',
        toToken: 'GM2_TOKEN',
        tokenAddress,
        protocol: 'GM2_BOND',
        amountIn: (BigInt(ethInWei).toString()),
        amountOutMin: minOut.toString(),
        status: 'pending',
        explorerUrl: `https://hyperion-testnet-explorer.metisdevops.link/tx/${result.hash}`
      };
      await SwapTransactionService.createSwapTransaction(swapData);
    } catch (e) {
      logger.warn('Failed to save GM2 buy swap record', { error: e.message });
    }
    return { hash: result.hash, expectedOut: expectedOut.toString(), minOut: minOut.toString() };
  }

  async sellTokensForEth({ walletId, tokenAddress, tokenAmountUnits, tokenDecimals, slippageBps = 50, twitterUserId, username }) {
    const amountIn = BigInt(tokenAmountUnits);
    const expectedEth = await this.estimateEthOutForTokenIn(tokenAddress, amountIn);
    const minEth = expectedEth *  BigInt(10000 - slippageBps) / 10000n;

    // ensure allowance
    const allowanceData = encodeFunctionData({ abi: ERC20_ABI, functionName: 'allowance', args: [await this.getWalletAddress(walletId), HYPERION_ADDRESS] });
    const allowanceRes = await this.publicClient.call({ to: tokenAddress, data: allowanceData });
    const allowance = BigInt(allowanceRes.data || '0x0');
    if (allowance < amountIn) {
      const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [HYPERION_ADDRESS, amountIn] });
      await sendContractTransaction(walletId, { to: tokenAddress, data: approveData, value: '0' });
      await new Promise(r => setTimeout(r, 3000));
    }

    const data = encodeFunctionData({ abi: HYPERION_ABI, functionName: 'swapExactTokensForETH', args: [tokenAddress, amountIn, minEth] });
    const tx = { to: HYPERION_ADDRESS, data, value: '0' };
    const result = await sendContractTransaction(walletId, tx);
    try {
      const { SwapTransactionService } = require('./swapTransactionService');
      const mongoose = require('mongoose');
      const Wallet = mongoose.model('Wallet');
      const walletDoc = await Wallet.findOne({ walletId });
      const swapData = {
        txHash: result.hash,
        twitterUserId: twitterUserId || walletDoc.twitterUserId,
        username: username || walletDoc.username,
        walletAddress: walletDoc.address,
        fromToken: 'GM2_TOKEN',
        toToken: 'METIS',
        tokenAddress,
        protocol: 'GM2_BOND',
        amountIn: tokenAmountUnits.toString(),
        amountOutMin: minEth.toString(),
        status: 'pending',
        explorerUrl: `https://hyperion-testnet-explorer.metisdevops.link/tx/${result.hash}`
      };
      await SwapTransactionService.createSwapTransaction(swapData);
    } catch (e) {
      logger.warn('Failed to save GM2 sell swap record', { error: e.message });
    }
    return { hash: result.hash, expectedEth: expectedEth.toString(), minEth: minEth.toString() };
  }

  async getWalletAddress(walletId) {
    const mongoose = require('mongoose');
    const Wallet = mongoose.model('Wallet');
    const doc = await Wallet.findOne({ walletId });
    return doc?.address;
  }
}

module.exports = new Gm2HyperionService();

