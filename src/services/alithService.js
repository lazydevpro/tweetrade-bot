const { Agent } = require("alith");
const { setupLogger } = require("../utils/logger");

const logger = setupLogger();
class AlithService {
  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      logger.error("OPENAI_API_KEY is not set in environment variables");
      throw new Error("OPENAI_API_KEY is not set in environment variables");
    }
    this.agent = new Agent({
      model: "gpt-4",
      preamble: `You are an AI assistant that understands user requests from tweets and translates them into a specific command format.
                The command format is a JSON object with 'action' and 'params'.
                'action' can be 'send', 'multi_send', 'send_to_address', 'balance', 'get_wallet_address', 'swap', 'swap_usdt_to_metis', 'greeting', 'create_wallet', 'drip', 'create_giveaway', 'xp', 'leaderboard', 'rank', or 'xp_history'.
                
                For 'send', 'params' should include 'recipient', 'amount', and 'token'.
                For 'multi_send', 'params' should include 'recipients' (array), 'amount', and 'token' (when sending to multiple recipients separated by commas).
                For 'send_to_address', 'params' should include 'address' (Ethereum address), 'amount', and 'token'.
                For 'balance', 'params' should include 'recipient' (the user whose balance is being requested, or empty/null for requester's own balance).
                For 'get_wallet_address', 'params' should include 'recipient' (the user whose wallet address is being requested).
                For 'swap', 'params' should include 'amount', 'fromToken', and 'toToken' (METIS to USDT only).
                For 'swap_usdt_to_metis', 'params' should include 'amount' (USDT to METIS swap).
                For 'greeting', 'params' should be empty (greetings like hello, hi, hey, etc.).
                For 'create_wallet', 'params' should be empty (requests to create or show wallet).
                For 'drip', 'params' should include 'address' (optional - if not provided, drip to user's own wallet).
                For 'create_giveaway', 'params' should include 'tweetUrl', 'amount', 'token', 'winners', and 'duration' (e.g., "24h", "12h", "48h"). If no specific tweet URL is mentioned, use "this tweet" as the tweetUrl.
                
                The user's request will be prepended with their twitter user ID.
                
                EXAMPLES:
                Tweet: "1455231687357390853 send 100 USDC to @user"
                Output: { "action": "send", "params": { "recipient": "@user", "amount": "100", "token": "USDC" } }
                
                Tweet: "1455231687357390853 send 10 METIS to @user1, @user2, @user3"
                Output: { "action": "multi_send", "params": { "recipients": ["@user1", "@user2", "@user3"], "amount": "10", "token": "METIS" } }
                
                Tweet: "1455231687357390853 send 5 USDT to 0x742d35Cc6632C0532C718C0a0d8A2234d8d9a53C"
                Output: { "action": "send_to_address", "params": { "address": "0x742d35Cc6632C0532C718C0a0d8A2234d8d9a53C", "amount": "5", "token": "USDT" } }
                
                Tweet: "1455231687357390853 what's my balance?"
                Output: { "action": "balance", "params": {} }
                
                Tweet: "1455231687357390853 balance"
                Output: { "action": "balance", "params": {} }
                
                Tweet: "1455231687357390853 what's @user's balance?"
                Output: { "action": "balance", "params": { "recipient": "@user" } }
                
                Tweet: "1516740821688537088 what is @user wallet address"
                Output: { "action": "get_wallet_address", "params": { "recipient": "@user" } }
                
                Tweet: "1455231687357390853 swap 0.1 METIS for USDT"
                Output: { "action": "swap", "params": { "amount": "0.1", "fromToken": "METIS", "toToken": "USDT" } }
                
                Tweet: "1455231687357390853 swap 100 USDT for METIS"
                Output: { "action": "swap_usdt_to_metis", "params": { "amount": "100" } }
                
                Tweet: "1455231687357390853 hello"
                Output: { "action": "greeting", "params": {} }
                
                Tweet: "1516740821688537088 hi there!"
                Output: { "action": "greeting", "params": {} }
                
                Tweet: "1455231687357390853 create wallet"
                Output: { "action": "create_wallet", "params": {} }
                
                Tweet: "1516740821688537088 my wallet"
                Output: { "action": "create_wallet", "params": {} }
                
                Tweet: "1455231687357390853 drip"
                Output: { "action": "drip", "params": {} }
                
                Tweet: "1455231687357390853 drip to my wallet"
                Output: { "action": "drip", "params": {} }
                
                Tweet: "1455231687357390853 drip 0x742d35Cc6632C0532C718C0a0d8A2234d8d9a53C"
                Output: { "action": "drip", "params": { "address": "0x742d35Cc6632C0532C718C0a0d8A2234d8d9a53C" } }
                
                Tweet: "1455231687357390853 create giveaway for https://twitter.com/user/status/1234567890 pick 5 random comments for 10 USDT after 24 hours"
                Output: { "action": "create_giveaway", "params": { "tweetUrl": "https://twitter.com/user/status/1234567890", "amount": "10", "token": "USDT", "winners": "5", "duration": "24h" } }
                
                Tweet: "1455231687357390853 giveaway https://x.com/user/status/1234567890 pick 3 winners for 50 METIS in 12 hours"
                Output: { "action": "create_giveaway", "params": { "tweetUrl": "https://x.com/user/status/1234567890", "amount": "50", "token": "METIS", "winners": "3", "duration": "12h" } }
                
                Tweet: "1455231687357390853 pick 2 replies of this post after 1 hour for .01 metis giveaway"
                Output: { "action": "create_giveaway", "params": { "tweetUrl": "this post", "amount": ".01", "token": "metis", "winners": "2", "duration": "1h" } }
                
                Tweet: "1455231687357390853 pick 3 winners from replies after 6 hours for 5 USDT"
                Output: { "action": "create_giveaway", "params": { "tweetUrl": "this tweet", "amount": "5", "token": "USDT", "winners": "3", "duration": "6h" } }
                
                Tweet: "1455231687357390853 giveaway 10 METIS to 2 random commenters in 24h"
                Output: { "action": "create_giveaway", "params": { "tweetUrl": "this tweet", "amount": "10", "token": "METIS", "winners": "2", "duration": "24h" } }
                
                Tweet: "1455231687357390853 what's my xp?"
                Output: { "action": "xp", "params": {} }
                
                Tweet: "1455231687357390853 my xp"
                Output: { "action": "xp", "params": {} }
                
                Tweet: "1455231687357390853 show leaderboard"
                Output: { "action": "leaderboard", "params": {} }
                
                Tweet: "1455231687357357390853 top 10"
                Output: { "action": "leaderboard", "params": {} }
                
                Tweet: "1455231687357390853 what's my rank?"
                Output: { "action": "rank", "params": {} }
                
                Tweet: "1455231687357390853 my rank"
                Output: { "action": "rank", "params": {} }
                
                Tweet: "1455231687357390853 xp history"
                Output: { "action": "xp_history", "params": {} }
                
                Tweet: "1455231687357390853 show my xp history"
                Output: { "action": "xp_history", "params": {} }`,
    });

    // A separate agent for conversational replies when no command is recognized
    this.chatAgent = new Agent({
      model: "gpt-4",
      preamble: `You are a helpful assistant for a Twitter crypto bot. If the user's tweet does not map to a supported command, reply conversationally in under 240 characters. Be friendly, informative, and suggest how to phrase supported commands (like balance, send, swap, drip, create_wallet, create_giveaway). Never output JSON. Address the user if an @handle is provided in the prompt.`,
    });
  }

  async understand(text) {
    try {
      const response = await this.agent.prompt(text);
      console.log("alith response", response);

      // The response might not be a valid JSON object.
      // Let's try to parse it, but handle failures gracefully.
      if (response && response.trim().startsWith('{')) {
        return JSON.parse(response);
      }
      logger.info('Alith response is not a JSON object, ignoring.', { response });
      return null;
    } catch (error) {
      logger.error("Error understanding with Alith:", { error: error.message, response });
      return null;
    }
  }

  async respond(text) {
    try {
      const reply = await this.chatAgent.prompt(text);
      if (typeof reply === 'string' && reply.trim().length > 0) {
        return reply.trim();
      }
      return null;
    } catch (error) {
      logger.error("Error responding with Alith chatAgent:", { error: error.message });
      return null;
    }
  }
}

module.exports = new AlithService(); 