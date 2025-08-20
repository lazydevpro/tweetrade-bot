const { setupLogger } = require('../utils/logger');
const axios = require('axios');
const { encodeFunctionData, erc20Abi, maxUint256, parseUnits } = require('viem');
const { provider } = require('./ethereumService');
const { ethers } = require('ethers');

const logger = setupLogger();

// Token addresses on Sepolia
const NATIVE_TOKEN_ADDRESS_0X = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // Special address for ETH
const USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // Official USDC on Sepolia

// A map to easily look up token info by their symbol
const tokenMap = {
    'ETH': { address: NATIVE_TOKEN_ADDRESS_0X, decimals: 18 },
    'USDC': { address: USDC_ADDRESS, decimals: 6 },
};

class DexService {
    constructor() {
        if (!process.env.ZEROX_API_KEY) {
            throw new Error('ZEROX_API_KEY is not set in environment variables');
        }
        this.apiKey = process.env.ZEROX_API_KEY;
        this.provider = provider;
        logger.info('DexService initialized for 0x API.');
    }

    /**
     * Checks how much of a token the 0x contract is allowed to spend.
     * @param {string} ownerAddress The user's wallet address.
     * @param {string} tokenAddress The contract address of the token.
     * @param {string} spenderAddress The contract address of the 0x spender.
     * @returns {Promise<string>} The allowance amount in the token's smallest unit.
     */
    async checkAllowance(ownerAddress, tokenAddress, spenderAddress) {
        const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, this.provider);
        const allowance = await tokenContract.allowance(ownerAddress, spenderAddress);
        return allowance.toString();
    }

    /**
     * Creates the transaction data to approve the 0x router contract.
     * @param {string} tokenSymbol The symbol of the token to approve (e.g., 'USDC').
     * @param {string} spenderAddress The address of the 0x contract that will spend the token.
     * @returns {object} A transaction object with `to` and `data` properties.
     */
    createApprovalTx(tokenSymbol, spenderAddress) {
        const token = tokenMap[tokenSymbol.toUpperCase()];
        if (!token || token.address === NATIVE_TOKEN_ADDRESS_0X) {
            throw new Error("Cannot create approval for native ETH.");
        }

        const data = encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [spenderAddress, maxUint256],
        });

        return {
            to: token.address,
            data,
            value: '0',
        };
    }

    /**
     * Gets a swap quote from the 0x API v1.
     * @param {string} fromTokenSymbol The token to sell.
     * @param {string} toTokenSymbol The token to buy.
     * @param {string} amountInString The amount to sell, in standard units (e.g., "0.1").
     * @param {string} userAddress The user's wallet address.
     * @returns {Promise<object>} The quote response from 0x.
     */
    async getSwapQuote(fromTokenSymbol, toTokenSymbol, amountInString, userAddress) {
        const fromToken = tokenMap[fromTokenSymbol.toUpperCase()];
        const toToken = tokenMap[toTokenSymbol.toUpperCase()];

        if (!fromToken || !toToken) {
            throw new Error(`Invalid token symbols: ${fromTokenSymbol}, ${toTokenSymbol}`);
        }
        
        const sellAmount = parseUnits(amountInString, fromToken.decimals).toString();

        const apiUrl = `https://api.0x.org/swap/v1/quote`;
        const params = {
            sellToken: fromToken.address,
            buyToken: toToken.address,
            sellAmount,
            takerAddress: userAddress,
        };
        
        logger.info('Fetching quote from 0x', { url: apiUrl, params });
        
        try {
            const response = await axios.get(apiUrl, {
                headers: { '0x-api-key': this.apiKey },
                params,
            });
            return response.data;
        } catch (error) {
            logger.error('Error fetching quote from 0x API', { 
                error: error.response ? error.response.data : error.message 
            });
            const errorMessage = error.response?.data?.validationErrors?.[0]?.description || 'Could not get a quote from 0x.';
            throw new Error(errorMessage);
        }
    }

    /**
     * Gets an indicative price from the 0x API v2.
     * @param {string} fromTokenSymbol The token to sell.
     * @param {string} toTokenSymbol The token to buy.
     * @param {string} amountInString The amount to sell, in standard units (e.g., "0.1").
     * @param {string} userAddress The user's wallet address (optional for price).
     * @returns {Promise<object>} The price response from 0x.
     */
    async getSwapPrice(fromTokenSymbol, toTokenSymbol, amountInString, userAddress = null) {
        const fromToken = tokenMap[fromTokenSymbol.toUpperCase()];
        const toToken = tokenMap[toTokenSymbol.toUpperCase()];

        if (!fromToken || !toToken) {
            throw new Error(`Invalid token symbols: ${fromTokenSymbol}, ${toTokenSymbol}`);
        }
        
        const sellAmount = parseUnits(amountInString, fromToken.decimals).toString();

        const apiUrl = `https://api.0x.org/swap/permit2/price`;
        const params = {
            sellToken: fromToken.address,
            buyToken: toToken.address,
            sellAmount,
            chainId: '8453', // Sepolia chainId
        };

        // Add taker if provided
        if (userAddress) {
            params.taker = userAddress;
        }
        
        const headers = {
            '0x-api-key': this.apiKey,
            '0x-version': 'v2',
        };
        
        logger.info('Fetching price from 0x v2', { url: apiUrl, params });
        
        try {
            const response = await axios.get(apiUrl, {
                headers,
                params,
            });
            return response.data;
        } catch (error) {
            logger.error('Error fetching price from 0x API', { 
                error: error.response ? error.response.data : error.message 
            });
            const errorMessage = error.response?.data?.validationErrors?.[0]?.description || 'Could not get a price from 0x.';
            throw new Error(errorMessage);
        }
    }
}

module.exports = new DexService();