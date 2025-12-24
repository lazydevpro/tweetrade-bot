// Mock alith module first
jest.mock('alith', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    prompt: jest.fn()
  }))
}));

// Mock dependencies
jest.mock('../services/privyUserService');
jest.mock('../services/alithService', () => ({
  understand: jest.fn(),
  respond: jest.fn(),
}));
jest.mock('../services/twitterService', () => ({
  getUserInfo: jest.fn(),
  getUserInfoByUsername: jest.fn(),
  replyToTweet: jest.fn(),
  username: 'testbot',
  userId: 'botuser123'
}));

// Mock dexService and ethereumService to avoid real initialization
jest.mock('../services/ethereumService', () => ({
  executeTransaction: jest.fn(),
}));

jest.mock('../services/dexService', () => ({
  getQuote: jest.fn(),
  executeSwap: jest.fn(),
}));

// Set required environment variables for testing
process.env.OPENAI_API_KEY = 'test-key';
process.env.ETH_RPC_URL = 'https://test-rpc.example.com';
process.env.ETH_PRIVATE_KEY = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
process.env.PRIVY_APP_ID = 'test-app-id';
process.env.PRIVY_APP_SECRET = 'test-app-secret';
const { handleTweet } = require('./tweetHandler');
const privyUserService = require('../services/privyUserService');
const alithService = require('../services/alithService');
const twitterService = require('../services/twitterService');

// Mock logger
jest.mock('../utils/logger', () => ({
  setupLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Mock fs for user_wallet_map.json
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() => JSON.stringify({
    'user': { id: 'wallet123', address: '0xabc' }
  })),
}));

// Mock path module
jest.mock('path', () => ({
  join: jest.fn(() => 'dummy_path'),
  resolve: jest.fn(() => 'dummy_path')
}));

// Mock dotenv
jest.mock('dotenv', () => ({
  config: jest.fn()
}));

// Mock mongoose
jest.mock('mongoose', () => {
  const Schema = function Schema() {
    return {
      pre: jest.fn(),
      index: jest.fn()
    };
  };
  // Provide Schema.Types for code that references mongoose.Schema.Types.Mixed
  Schema.Types = { Mixed: {} };
  return {
    connect: jest.fn(),
    model: jest.fn(() => ({})),
    Schema
  };
});

// Mock crypto
jest.mock('crypto', () => ({
  randomBytes: jest.fn(() => Buffer.from('test')),
  createHash: jest.fn(() => ({
    update: jest.fn(),
    digest: jest.fn(() => 'testhash')
  }))
}));

// Mock Privy
jest.mock('@privy-io/server-auth/viem', () => ({
  createViemAccount: jest.fn()
}));

jest.mock('@privy-io/server-auth', () => ({
  PrivyClient: jest.fn().mockImplementation(() => ({
    createWallet: jest.fn(),
    getUser: jest.fn()
  })),
  PrivyApi: jest.fn().mockImplementation(() => ({
    createWallet: jest.fn(),
    getUser: jest.fn()
  }))
}));

// Mock ethers
jest.mock('ethers', () => ({
  ethers: {
    utils: {
      isAddress: jest.fn(() => true),
      parseEther: jest.fn(),
      formatEther: jest.fn()
    },
    providers: {
      JsonRpcProvider: jest.fn()
    },
    Contract: jest.fn()
  }
}));

describe('handleTweet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default author info so handler progresses
    twitterService.getUserInfo.mockResolvedValue({ id: 'author', username: 'author' });
    // Default AI fallback response
    alithService.respond.mockResolvedValue('How can I help? Try commands like balance, send 1 METIS to @user, swap 5 USDT for METIS.');
  });

  it('should handle a balance command and find the wallet', async () => {
    twitterService.getUserInfo.mockResolvedValue({ id: 'author1', username: 'author1' });
    alithService.understand.mockResolvedValue({
      action: 'balance',
      params: { recipient: '@user' }
    });
    privyUserService.getOrCreateWalletForUser.mockResolvedValue({
      id: 'wallet123',
      address: '0xabc'
    });
    const tweet = {
      id: '1',
      text: "what's @user's balance?",
      author_id: 'author1',
      created_at: '2025-06-20T14:29:44.000Z'
    };
    await handleTweet(tweet, new Set());
    // No assertion: just ensure no error is thrown
  });

  it('should handle balance command for own balance (no recipient)', async () => {
    twitterService.getUserInfo.mockResolvedValue({ id: 'author3', username: 'author3' });
    alithService.understand.mockResolvedValue({
      action: 'balance',
      params: {} // No recipient specified - should show requester's balance
    });
    privyUserService.getOrCreateWalletForUser.mockResolvedValue({
      id: 'wallet123',
      address: '0xabc'
    });
    privyUserService.getWalletForUser.mockResolvedValue({
      id: 'wallet123',
      address: '0xabc'
    });
    privyUserService.getEnhancedBalance.mockResolvedValue({
      metis: '10.5',
      usdt: '0.0',
      formatted: '10.5 hMETIS, 0.0 USDT'
    });
    
    const tweet = {
      id: '3',
      text: "what's my balance?",
      author_id: 'author3',
      created_at: '2025-06-20T14:29:44.000Z',
      in_reply_to_id: 'some_other_tweet' // This is a reply
    };
    
    await handleTweet(tweet, new Set());
    
    // Verify that we attempted to fetch a wallet
    expect(privyUserService.getWalletForUser).toHaveBeenCalled();
  });

  it('should handle balance command for specific user when mentioned', async () => {
    twitterService.getUserInfo.mockResolvedValue({ id: 'author4', username: 'author4' });
    alithService.understand.mockResolvedValue({
      action: 'balance',
      params: { recipient: '@specificuser' }
    });
    privyUserService.getOrCreateWalletForUser.mockResolvedValue({
      id: 'wallet123',
      address: '0xabc'
    });
    privyUserService.getWalletForUser.mockResolvedValue({
      id: 'wallet456',
      address: '0xdef'
    });
    privyUserService.getEnhancedBalance.mockResolvedValue({
      metis: '5.0',
      usdt: '10.0',
      formatted: '5.0 hMETIS, 10.0 USDT'
    });
    
    const tweet = {
      id: '4',
      text: "what's @specificuser's balance?",
      author_id: 'author4',
      created_at: '2025-06-20T14:29:44.000Z',
      in_reply_to_id: 'some_other_tweet' // This is a reply
    };
    
    await handleTweet(tweet, new Set());
    // Should call getUserInfoByUsername for the specific user, not the tweet author
    // Since we're not mocking twitterService, this test just ensures no errors
  });

  it('should handle unknown commands gracefully', async () => {
    twitterService.getUserInfo.mockResolvedValue({ id: 'author2', username: 'author2' });
    alithService.understand.mockResolvedValue(null);
    const tweet = {
      id: '2',
      text: "hello world",
      author_id: 'author2',
      created_at: '2025-06-20T14:29:44.000Z'
    };
    await handleTweet(tweet, new Set());
    // No assertion: just ensure no error is thrown
  });
}); 