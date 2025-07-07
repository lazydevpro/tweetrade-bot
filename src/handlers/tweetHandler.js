const { setupLogger } = require('../utils/logger');
const alithService = require('../services/alithService');
const { getOrCreateWalletForUser, getWalletForUser, getBalance, sendTransaction, sendContractTransaction, addTweetReplyToHistory } = require('../services/privyUserService');
const twitterService = require('../services/twitterService');

const logger = setupLogger();

/**
 * @file tweetHandler.js
 * @description Handles incoming tweets, parses commands, and triggers wallet or transaction actions for the Twitter bot.
 */

/**
 * Processes a tweet, determines the requested action, and triggers the appropriate service (wallet, transaction, swap, etc.).
 * Ignores retweets and tweets from the bot itself. Updates tweet history and replies to the user.
 *
 * @param {object} tweet - The tweet object from Twitter API.
 * @param {Set<string>} processedTweetIds - Set of tweet IDs already processed to avoid duplicates.
 * @returns {Promise<boolean>} True if the tweet was processed (or intentionally skipped), false if not.
 */
async function handleTweet(tweet, processedTweetIds) {
  try {
    // This check is now redundant since index.js handles it, but it's good for defense-in-depth
    if (processedTweetIds.has(tweet.id)) {
      logger.info('Skipping already processed tweet in handler.', { tweetId: tweet.id });
      return false;
    }

    logger.info('Processing tweet:', { tweetId: tweet.id, text: tweet.text });

    // Ignore retweets
    if (tweet.referenced_tweets?.some(t => t.type === 'retweeted')) {
      return true; // Mark as processed to not see it again
    }

    // Ignore tweets from the bot itself to prevent loops
    if (tweet.author_id === twitterService.userId) {
      logger.info('Ignoring tweet from bot itself.');
      return true; // Mark as processed
    }

    const authorInfo = await twitterService.getUserInfo(tweet.author_id);
    if (!authorInfo) {
      logger.warn('Could not retrieve author info, skipping tweet', { tweetId: tweet.id, authorId: tweet.author_id });
      return true; // Mark as processed to avoid retries
    }
    const authorUsername = authorInfo.username;

    // Get or create Privy wallet for this user
    const walletInfo = await getOrCreateWalletForUser(tweet.author_id, tweet.authorUsername);
    logger.info('User wallet:', { twitterUserId: tweet.author_id, walletId: walletInfo.id, walletAddress: walletInfo.address });

    // Clean the tweet text and add context for Alith
    const botUsername = twitterService.username;
    const cleanedText = tweet.text.replace(new RegExp(`@${botUsername}`, 'ig'), '').trim();
    // Prepend author's ID to give Alith context about who sent the command
    const textForAlith = `${tweet.author_id} ${cleanedText}`;
    logger.info('Text for Alith:', { textForAlith });

    // Parse the command from the tweet using Alith
    const command = await alithService.understand(textForAlith);
    if (!command) {
      logger.info('No valid command found in tweet');
      return true; // Mark as processed to avoid re-processing
    }

    logger.info('Parsed command:', command);

    // Execute the command
    switch (command.action) {
      case 'send': {
        // Get sender's wallet
        const senderWallet = await getWalletForUser(tweet.author_id);
        if (!senderWallet || !senderWallet.id) {
          logger.warn('No wallet found for sender:', tweet.author_id);
          break;
        }
        const { recipient, amount } = command.params;
        // Assume recipient is an address; if it's a handle, resolve to address as needed
        let recipientAddress = recipient;
        if (recipient.startsWith('@')) {
          // If recipient is a Twitter handle, resolve to wallet address
          const username = recipient.slice(1);
          let userId = null;
          if (username === 'BooinWeb3') {
            userId = "1516740821688537088";
          } else if (username === 'lazydevpro') {
            userId = "1455231687357390853";
          } else {
            // Optionally resolve userId from Twitter username
            const userInfo = await twitterService.getUserInfoByUsername(username);
            userId = userInfo?.id;
          }
          if (userId) {
            const recipientWallet = await getWalletForUser(userId);
            if (recipientWallet && recipientWallet.address) {
              recipientAddress = recipientWallet.address;
            } else {
              logger.warn('No wallet found for recipient handle:', recipient);
              break;
            }
          } else {
            logger.warn('Could not resolve user ID for handle:', username);
            break;
          }
        }
        // Send transaction using Privy
        const transaction = await sendTransaction(senderWallet.id, recipientAddress, amount);

        //send notification and transaction url to the user
        await twitterService.replyToTweet(
          tweet.id,
          `@${authorUsername} Transaction sent successfully! Check your wallet, txHash: ${transaction.hash}. If you have any issues, reply to this tweet.`
        );
        await addTweetReplyToHistory(tweet.author_id, {
          tweetId: tweet.id,
          tweetText: tweet.text,
          replyId: null,
          replyText: `@${authorUsername} Transaction sent successfully! Check your wallet, txHash: ${transaction.hash}. If you have any issues, reply to this tweet.`,
          createdAt: new Date(tweet.created_at),
          repliedAt: new Date(),
          status: 'success',
          error: null
        });
        break;
      }
      case 'balance': {
        const recipientHandle = command.params.recipient;
        let targetUsername = authorUsername;
        let targetUserId = tweet.author_id;

        if (recipientHandle && recipientHandle.startsWith('@')) {
          const specifiedUsername = recipientHandle.slice(1);
          // Overwrite target if a specific user is mentioned
          targetUsername = specifiedUsername;
          if (specifiedUsername.toLowerCase() === 'lazydevpro') { // case-insensitive check
            targetUserId = "1455231687357390853";
          } else if (specifiedUsername.toLowerCase() === 'booinweb3') {
            targetUserId = "1516740821688537088";
          } else {
            const userInfo = await twitterService.getUserInfoByUsername(specifiedUsername);
            if (userInfo) {
              targetUserId = userInfo.id;
            } else {
              logger.warn('Could not find user ID for handle:', specifiedUsername);
              await twitterService.replyToTweet(tweet.id, `@${authorUsername} Sorry, I couldn't find a user with the handle ${recipientHandle}.`);
              break;
            }
          }
        }

        logger.info('Checking balance for user:', { targetUsername, targetUserId });

        const wallet = await getWalletForUser(targetUserId);
        if (!wallet || !wallet.address) {
          logger.warn('No wallet found for user ID:', targetUserId);
          const replyText = targetUserId === tweet.author_id ? `@${authorUsername} You don't have a wallet yet. Try sending a transaction to create one.` : `@${authorUsername} The user ${recipientHandle} doesn't have a wallet yet.`;
          await twitterService.replyToTweet(tweet.id, replyText);
          break;
        }

        const balance = await getBalance(wallet.address);
        logger.info('Balance:', { address: wallet.address, balance });

        const balanceMessage = targetUserId === tweet.author_id
          ? `@${authorUsername} Your balance is ${balance} hMETIS.`
          : `@${authorUsername} The balance for ${recipientHandle} is ${balance} hMETIS.`;

        await twitterService.replyToTweet(tweet.id, balanceMessage);
        await addTweetReplyToHistory(tweet.author_id, {
          tweetId: tweet.id,
          tweetText: tweet.text,
          replyId: null,
          replyText: balanceMessage,
          createdAt: new Date(tweet.created_at),
          repliedAt: new Date(),
          status: 'success',
          error: null
        });
        break;
      }
      case 'get_wallet_address': {
        const recipientHandle = command.params.recipient;
        let targetUsername = authorUsername;
        let targetUserId = tweet.author_id;

        if (recipientHandle && recipientHandle.startsWith('@')) {
          const specifiedUsername = recipientHandle.slice(1);
          // Overwrite target if a specific user is mentioned
          targetUsername = specifiedUsername;
          if (specifiedUsername.toLowerCase() === 'lazydevpro') { // case-insensitive check
            targetUserId = "1455231687357390853";
          } else if (specifiedUsername.toLowerCase() === 'booinweb3') {
            targetUserId = "1516740821688537088";
          } else {
            const userInfo = await twitterService.getUserInfoByUsername(specifiedUsername);
            if (userInfo) {
              targetUserId = userInfo.id;
            } else {
              logger.warn('Could not find user ID for handle:', specifiedUsername);
              await twitterService.replyToTweet(tweet.id, `@${authorUsername} Sorry, I couldn't find a user with the handle ${recipientHandle}.`);
              break;
            }
          }
        }

        logger.info('Getting or creating wallet address for user:', { targetUsername, targetUserId });

        // Always get or create the wallet for the target user
        const wallet = await getOrCreateWalletForUser(targetUserId);

        const addressMessage = targetUserId === tweet.author_id
          ? `@${authorUsername} Your wallet address is ${wallet.address}.`
          : `@${authorUsername} The wallet address for ${recipientHandle} is ${wallet.address}.`;

        await twitterService.replyToTweet(tweet.id, addressMessage);
        await addTweetReplyToHistory(tweet.author_id, {
          tweetId: tweet.id,
          tweetText: tweet.text,
          replyId: null,
          replyText: addressMessage,
          createdAt: new Date(tweet.created_at),
          repliedAt: new Date(),
          status: 'success',
          error: null
        });
        break;
      }
      case 'swap': {
        const { amount, fromToken, toToken } = command.params;
        logger.info('Initiating swap...', { amount, fromToken, toToken });

        const senderWallet = await getWalletForUser(tweet.author_id);
        if (!senderWallet) {
          logger.warn('No wallet found for sender:', tweet.author_id);
          await twitterService.replyToTweet(tweet.id, `@${authorUsername} You need a wallet to swap. Try sending tMETIS to create one.`);
          break;
        }

        try {
          // Only support METIS -> USDT swaps for now
          if (fromToken.toUpperCase() === 'METIS' && toToken.toUpperCase() === 'USDT') {
            // For demo, set minAmountOut to 0 (no slippage protection). In production, calculate from price API.
            const minAmountOut = '0';
            const executedTx = await require('../services/privyUserService').swapMetisToUSDTWithSushi(senderWallet.id, amount, minAmountOut);
            const replyMessage = `@${authorUsername} Your swap was submitted! View on Metis Explorer: https://andromeda-explorer.metis.io/tx/${executedTx.hash}`;
            await twitterService.replyToTweet(tweet.id, replyMessage);
            logger.info('Swap successful:', { txHash: executedTx.hash });
            await addTweetReplyToHistory(tweet.author_id, {
              tweetId: tweet.id,
              tweetText: tweet.text,
              replyId: null,
              replyText: replyMessage,
              createdAt: new Date(tweet.created_at),
              repliedAt: new Date(),
              status: 'success',
              error: null
            });
          } else {
            await twitterService.replyToTweet(tweet.id, `@${authorUsername} Only METIS to USDT swaps are supported on Metis testnet for now.`);
            await addTweetReplyToHistory(tweet.author_id, {
              tweetId: tweet.id,
              tweetText: tweet.text,
              replyId: null,
              replyText: `@${authorUsername} Only METIS to USDT swaps are supported on Metis testnet for now.`,
              createdAt: new Date(tweet.created_at),
              repliedAt: new Date(),
              status: 'error',
              error: 'unsupported swap pair'
            });
          }
        } catch (error) {
          logger.error('Swap failed:', { error: error.message, stack: error.stack });
          const errorMessage = `@${authorUsername} Your swap failed. Reason: ${error.message}`;
          await twitterService.replyToTweet(tweet.id, errorMessage);
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: errorMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
        }
        break;
      }
      // Add more command types here
      default:
        // send user a message that the command is not valid
        await twitterService.replyToTweet(
          tweet.id,
          `@${authorUsername} The command ${command.action} is not valid. Please try again.`
        );
        logger.warn('Unknown command action:', command.action);
        await addTweetReplyToHistory(tweet.author_id, {
          tweetId: tweet.id,
          tweetText: tweet.text,
          replyId: null,
          replyText: `@${authorUsername} The command ${command.action} is not valid. Please try again.`,
          createdAt: new Date(tweet.created_at),
          repliedAt: new Date(),
          status: 'error',
          error: 'invalid command'
        });
    }
    return true; // Indicate that the tweet was successfully processed
  } catch (error) {
    logger.error('Error handling tweet:', { error: error.message, tweetId: tweet.id });
    // We re-throw the error so the main loop can catch it, but we don't mark as processed.
    // This means it might be retried next time.
    // For certain errors, you might want to return true to avoid retries.
    throw error;
  }
}

module.exports = {
  handleTweet,
}; 