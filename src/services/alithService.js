const { Agent } = require("alith");
const { setupLogger } = require("../utils/logger");

const logger = setupLogger();
/**
 * @file alithService.js
 * @description Provides AI-powered command parsing for tweets using the Alith agent.
 */
/**
 * AlithService uses an AI agent to parse natural language tweets into structured commands for the bot.
 * @class
 */
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
                'action' can be 'send', 'balance', 'get_wallet_address', or 'swap'.
                For 'send', 'params' should include 'recipient', 'amount', and 'token'.
                For 'balance', 'params' should include 'recipient' (the user whose balance is being requested).
                For 'get_wallet_address', 'params' should include 'recipient' (the user whose wallet address is being requested).
                For 'swap', 'params' should include 'amount', 'fromToken', and 'toToken'.
                The user's request will be prepended with their twitter user ID.
                Example tweet: "1455231687357390853 send 100 USDC to @user"
                Example output: { "action": "send", "params": { "recipient": "@user", "amount": "100", "token": "USDC" } }
                Example tweet: "1455231687357390853 what's @user's balance?"
                Example output: { "action": "balance", "params": { "recipient": "@user" } }
                Example tweet: "1516740821688537088 what is @user wallet address"
                Example output: { "action": "get_wallet_address", "params": { "recipient": "@user" } }
                Example tweet: "1455231687357390853 swap 0.1 ETH for USDC"
                Example output: { "action": "swap", "params": { "amount": "0.1", "fromToken": "ETH", "toToken": "USDC" } }`,
    });
  }

  /**
   * Parses a tweet's text and returns a structured command object if recognized.
   * @param {string} text - The tweet text to parse.
   * @returns {Promise<object|null>} Parsed command object or null if not recognized.
   */
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
}

module.exports = new AlithService(); 