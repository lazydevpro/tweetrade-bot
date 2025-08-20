const { setupLogger } = require('../utils/logger');
const alithService = require('../services/alithService');
const { getOrCreateWalletForUser, getWalletForUser, getBalance, getEnhancedBalance, sendTransaction, sendTokenTransaction, sendContractTransaction, addTweetReplyToHistory, swapUSDTToMetisWithSushi } = require('../services/privyUserService');
const twitterService = require('../services/twitterService');
const dexService = require('../services/dexService');
const faucetService = require('../services/faucetService');
const giveawayService = require('../services/giveawayService');
const { XPService } = require('../services/xpService');
const { ethers } = require('ethers');
const { isValidEthereumAddress, parseRecipients } = require('../utils/addressValidator');


const logger = setupLogger();
const xpService = new XPService();

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

    // Check if the bot is explicitly mentioned in this specific tweet
    const botUsername = twitterService.username;
    const botMentionPattern = new RegExp(`@${botUsername}\\b`, 'i');
    const isBotMentioned = botMentionPattern.test(tweet.text);
    const isReply = !!tweet.in_reply_to_id;
    
    if (!isBotMentioned && !isReply) {
      logger.info('Bot not explicitly mentioned in this tweet, skipping', { 
        tweetId: tweet.id, 
        text: tweet.text,
        botUsername: botUsername
      });
      return true; // Mark as processed to avoid re-processing
    }

    // Get or create Privy wallet for this user
    const walletInfo = await getOrCreateWalletForUser(tweet.author_id, tweet.authorUsername);
    logger.info('User wallet:', { twitterUserId: tweet.author_id, walletId: walletInfo.id, walletAddress: walletInfo.address });

    // Clean the tweet text and add context for Alith
    const cleanedText = tweet.text.replace(new RegExp(`@${botUsername}`, 'ig'), '').trim();
    // Prepend author's ID to give Alith context about who sent the command
    const textForAlith = `${tweet.author_id} ${cleanedText}`;
    logger.info('Text for Alith:', { textForAlith });

    // Parse the command from the tweet using Alith
    const command = await alithService.understand(textForAlith);
    if (!command) {
      logger.info('No valid command found in tweet');
      // Fallback: ask AI to provide a helpful conversational reply and share it
      const aiTextPrompt = `User @${authorUsername} said: "${cleanedText}". Reply concisely (<=240 chars), no JSON. If relevant, suggest a supported command syntax.`;
      const aiReply = await alithService.respond(aiTextPrompt);
      const replyMessage = `@${authorUsername} ${aiReply || 'I can help with balance, sending, swaps, wallet, drip, and giveaways. Try: balance, send 1 METIS to @user, swap 5 USDT for METIS, create wallet.'}`;
      await twitterService.replyToTweet(tweet.id, replyMessage);
      await addTweetReplyToHistory(tweet.author_id, {
        tweetId: tweet.id,
        tweetText: tweet.text,
        replyId: null,
        replyText: replyMessage,
        createdAt: new Date(tweet.created_at),
        repliedAt: new Date(),
        status: 'success',
        error: null,
        action: 'ai_fallback'
      });
      return true; // processed
    }

    logger.info('Parsed command:', command);

    // Tweet Owner Authentication - Security Check
    // If this is a reply to another user's tweet, implement security restrictions
    if (tweet.in_reply_to_id && tweet.in_reply_to_id !== tweet.author_id) {
      logger.info('Detected reply to another user\'s tweet', { 
        replyAuthor: tweet.author_id, 
        originalAuthor: tweet.in_reply_to_id,
        command: command.action 
      });
      
      // Allow all commands in replies - the swap function will check wallet ownership
      // Financial commands will only use the tweet author's wallet, not the original tweet author's wallet
      logger.info('Allowing command in reply - wallet ownership will be checked by the function', { 
        command: command.action, 
        replyAuthor: tweet.author_id, 
        originalAuthor: tweet.in_reply_to_id 
      });
    }

    // Execute the command
    switch (command.action) {
      case 'send': {
        // Get sender's wallet
        const senderWallet = await getWalletForUser(tweet.author_id);
        if (!senderWallet || !senderWallet.id) {
          logger.warn('No wallet found for sender:', tweet.author_id);
          break;
        }
        const { recipient, amount, token } = command.params;
        // Default to METIS if no token specified
        const tokenType = token || 'METIS';
        
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
        
        // Check balance before sending
        const balanceInfo = await getEnhancedBalance(senderWallet.address);
        const currentBalance = tokenType.toUpperCase() === 'USDT' ? parseFloat(balanceInfo.usdt) : parseFloat(balanceInfo.metis);
        const requestedAmount = parseFloat(amount);
        
        if (currentBalance < requestedAmount) {
          const replyMessage = `@${authorUsername} Insufficient ${tokenType.toUpperCase()} balance. You have ${currentBalance} ${tokenType.toUpperCase()}, but tried to send ${requestedAmount} ${tokenType.toUpperCase()}.`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: replyMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: 'Insufficient balance'
          });
          break;
        }
        
        // Send transaction using Privy with the specified token
        try {
          const transaction = await sendTokenTransaction(senderWallet.id, recipientAddress, amount, tokenType);

          //send notification and transaction url to the user
          const transactionUrl = `https://hyperion-testnet-explorer.metisdevops.link/tx/${transaction.hash}`;
          const replyMessage = `@${authorUsername} Successfully sent ${amount} ${tokenType.toUpperCase()} to ${recipient}! View transaction: ${transactionUrl}. If you have any issues, reply to this tweet.`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          
          // Award XP for successful token transfer
          try {
            await xpService.awardForTokenTransfer(tweet.author_id, authorUsername, {
              amount,
              token: tokenType,
              recipient,
              txHash: transaction.hash
            });
          } catch (error) {
            logger.error('Error awarding XP for token transfer:', error);
          }
          
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
        } catch (error) {
          logger.error('Transaction failed:', { error: error.message, tokenType, amount, recipient });
          
          let errorMessage = `Failed to send ${amount} ${tokenType.toUpperCase()} to ${recipient}.`;
          if (error.message.includes('insufficient funds')) {
            errorMessage += ' Insufficient balance or gas fees.';
          } else if (error.message.includes('execution reverted')) {
            errorMessage += ' Transaction reverted.';
          } else {
            errorMessage += ` Error: ${error.message}`;
          }
          
          const replyMessage = `@${authorUsername} ${errorMessage}`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: replyMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
        }
        break;
      }
      case 'balance': {
        const recipientHandle = command.params.recipient;
        let targetUsername = authorUsername;
        let targetUserId = tweet.author_id;

        // Only check for specific recipient if it's explicitly mentioned and is a valid @handle
        // This prevents confusion when replying to tweets where the original author might be mentioned
        // Also handle cases where recipientHandle might be undefined, null, or empty string
        if (recipientHandle && typeof recipientHandle === 'string' && recipientHandle.startsWith('@') && recipientHandle.length > 1) {
          const specifiedUsername = recipientHandle.slice(1);
          // Only override the target if it's a clear request for someone else's balance
          // Ensure it's not just parsing context from the original tweet
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

        logger.info('Checking balance for user:', { 
          targetUsername, 
          targetUserId, 
          recipientHandle: recipientHandle,
          originalAuthor: authorUsername,
          originalAuthorId: tweet.author_id,
          isReply: !!tweet.in_reply_to_id 
        });

        const wallet = await getWalletForUser(targetUserId);
        if (!wallet || !wallet.address) {
          logger.warn('No wallet found for user ID:', targetUserId);
          const replyText = targetUserId === tweet.author_id ? `@${authorUsername} You don't have a wallet yet. Try sending a transaction to create one.` : `@${authorUsername} The user ${recipientHandle} doesn't have a wallet yet.`;
          await twitterService.replyToTweet(tweet.id, replyText);
          break;
        }

        const balanceInfo = await getEnhancedBalance(wallet.address);
        logger.info('Balance:', { address: wallet.address, metis: balanceInfo.metis, usdt: balanceInfo.usdt });

        const balanceMessage = targetUserId === tweet.author_id
          ? `@${authorUsername} Your balance is ${balanceInfo.formatted}.`
          : `@${authorUsername} The balance for ${recipientHandle} is ${balanceInfo.formatted}.`;

        await twitterService.replyToTweet(tweet.id, balanceMessage);
        
        // Award XP for balance check (only to the user who requested it)
        if (targetUserId === tweet.author_id) {
          try {
            await xpService.awardForBalanceCheck(tweet.author_id, authorUsername);
          } catch (error) {
            logger.error('Error awarding XP for balance check:', error);
          }
        }
        
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
        
        // Award XP for wallet creation (only to the user who requested it)
        if (targetUserId === tweet.author_id) {
          try {
            await xpService.awardForWalletCreation(tweet.author_id, authorUsername);
          } catch (error) {
            logger.error('Error awarding XP for wallet creation:', error);
          }
        }
        
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
            const executedTx = await require('../services/privyUserService').swapMetisToUSDTWithSushi(senderWallet.id, amount, 0.005);
            const replyMessage = `@${authorUsername} Your swap was submitted! View on Metis Hyperion Explorer: https://hyperion-testnet-explorer.metisdevops.link/tx/${executedTx.hash}`;
            await twitterService.replyToTweet(tweet.id, replyMessage);
            
            // Award XP for successful swap
            try {
              await xpService.awardForChatSwap(tweet.author_id, authorUsername, {
                amount,
                fromToken,
                toToken,
                txHash: executedTx.hash
              });
            } catch (error) {
              logger.error('Error awarding XP for swap:', error);
            }
            
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
          
          // Extract clean error message
          let errorMessage = error.message;
          if (error.message.includes('INSUFFICIENT_OUTPUT_AMOUNT')) {
            errorMessage = 'Swap failed: Insufficient output amount (try a smaller amount or try again later)';
          } else if (error.message.includes('execution reverted')) {
            errorMessage = 'Swap failed: Transaction reverted';
          } else if (error.message.includes('insufficient funds') || error.message.includes('insufficient balance')) {
            // Get user's balance and include it in the error message
            try {
              const balance = await require('../services/privyUserService').getBalance(senderWallet.address);
              errorMessage = `Swap failed: Insufficient METIS balance. Your balance: ${balance} METIS`;
            } catch (balanceError) {
              errorMessage = 'Swap failed: Insufficient METIS balance';
            }
          }
          
          const replyMessage = `@${authorUsername} ${errorMessage}`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: replyMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
        }
        break;
      }
      case 'greeting': {
        // Welcome/Hello command - create wallet and provide bot information
        logger.info('Processing greeting command for user:', tweet.author_id);
        
        // Get or create wallet for the user (this automatically creates if doesn't exist)
        const wallet = await getOrCreateWalletForUser(tweet.author_id, authorUsername);
        logger.info('Wallet created/retrieved for greeting:', { walletId: wallet.id, address: wallet.address });
        
        // Get current balance to show in welcome message
        const balanceInfo = await getEnhancedBalance(wallet.address);
        
        // Create comprehensive welcome message
        const welcomeMessage = `@${authorUsername} Hello! 👋 Welcome to Tweetrade Bot! 

🔗 Your wallet address: ${wallet.address}
💰 Current balance: ${balanceInfo.formatted}

✨ I can help you with:
• Request tokens from faucet with command "Drip metis to [wallet address]"
• Send tokens: "send [amount] [token] to [user]"
• Check balances: "balance" or "balance [user]" 
• Get wallet addresses: "wallet address" or "wallet address [user]"
• Swap tokens: "swap [amount] METIS for USDT"
• Run Giveaway for Users commenting under certain post, Tag the bot and specify [Amount], [Token], [Number of winners], and [Duration].

Try sending me a command to get started! 🚀`;

        await twitterService.replyToTweet(tweet.id, welcomeMessage);
        
        // Award XP for wallet creation (greeting)
        try {
          await xpService.awardForWalletCreation(tweet.author_id, authorUsername);
        } catch (error) {
          logger.error('Error awarding XP for greeting wallet creation:', error);
        }
        
        await addTweetReplyToHistory(tweet.author_id, {
          tweetId: tweet.id,
          tweetText: tweet.text,
          replyId: null,
          replyText: welcomeMessage,
          createdAt: new Date(tweet.created_at),
          repliedAt: new Date(),
          status: 'success',
          error: null
        });
        break;
      }
      case 'create_wallet': {
        // Create/Show Wallet command - create wallet and show information
        logger.info('Processing create wallet command for user:', tweet.author_id);
        
        // Get or create wallet for the user (this automatically creates if doesn't exist)
        const wallet = await getOrCreateWalletForUser(tweet.author_id, authorUsername);
        logger.info('Wallet created/retrieved for create wallet command:', { walletId: wallet.id, address: wallet.address });
        
        // Get current balance to show in response
        const balanceInfo = await getEnhancedBalance(wallet.address);
        
        // Create wallet information message
        const walletMessage = `@${authorUsername} Your wallet details:

🔗 Address: ${wallet.address}
💰 Balance: ${balanceInfo.formatted}

You can now send and receive tokens! Use commands like:
• "send [amount] [token] to @user" to transfer tokens
• "balance" to check your balance
• "swap [amount] METIS for USDT" to exchange tokens`;

        await twitterService.replyToTweet(tweet.id, walletMessage);
        
        // Award XP for wallet creation
        try {
          await xpService.awardForWalletCreation(tweet.author_id, authorUsername);
        } catch (error) {
          logger.error('Error awarding XP for create wallet command:', error);
        }
        
        await addTweetReplyToHistory(tweet.author_id, {
          tweetId: tweet.id,
          tweetText: tweet.text,
          replyId: null,
          replyText: walletMessage,
          createdAt: new Date(tweet.created_at),
          repliedAt: new Date(),
          status: 'success',
          error: null
        });
        break;
      }
      case 'send_to_address': {
        // Send tokens directly to an Ethereum address
        const senderWallet = await getWalletForUser(tweet.author_id);
        if (!senderWallet || !senderWallet.id) {
          logger.warn('No wallet found for sender:', tweet.author_id);
          break;
        }
        
        const { address, amount, token } = command.params;
        const tokenType = token || 'METIS';
        
        // Validate Ethereum address
        if (!isValidEthereumAddress(address)) {
          const replyMessage = `@${authorUsername} Invalid Ethereum address: ${address}`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: replyMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: 'Invalid address'
          });
          break;
        }
        
        // Check balance before sending
        const balanceInfo = await getEnhancedBalance(senderWallet.address);
        const currentBalance = tokenType.toUpperCase() === 'USDT' ? parseFloat(balanceInfo.usdt) : parseFloat(balanceInfo.metis);
        const requestedAmount = parseFloat(amount);
        
        if (currentBalance < requestedAmount) {
          const replyMessage = `@${authorUsername} Insufficient ${tokenType.toUpperCase()} balance. You have ${currentBalance} ${tokenType.toUpperCase()}, but tried to send ${requestedAmount} ${tokenType.toUpperCase()}.`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: replyMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: 'Insufficient balance'
          });
          break;
        }
        
        try {
          const transaction = await sendTokenTransaction(senderWallet.id, address, amount, tokenType);
          const transactionUrl = `https://hyperion-testnet-explorer.metisdevops.link/tx/${transaction.hash}`;
          const replyMessage = `@${authorUsername} Successfully sent ${amount} ${tokenType.toUpperCase()} to ${address}! View transaction: ${transactionUrl}`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
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
        } catch (error) {
          logger.error('Address transaction failed:', { error: error.message, tokenType, amount, address });
          const replyMessage = `@${authorUsername} Failed to send ${amount} ${tokenType.toUpperCase()} to ${address}. Error: ${error.message}`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: replyMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
        }
        break;
      }
      case 'multi_send': {
        // Send tokens to multiple recipients
        const senderWallet = await getWalletForUser(tweet.author_id);
        if (!senderWallet || !senderWallet.id) {
          logger.warn('No wallet found for sender:', tweet.author_id);
          break;
        }
        
        const { recipients, amount, token } = command.params;
        const tokenType = token || 'METIS';
        const requestedAmount = parseFloat(amount);
        const totalAmount = requestedAmount * recipients.length;
        
        // Limit number of recipients
        if (recipients.length > 10) {
          const replyMessage = `@${authorUsername} Too many recipients. Maximum 10 allowed per transaction.`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          break;
        }
        
        // Check balance before sending
        const balanceInfo = await getEnhancedBalance(senderWallet.address);
        const currentBalance = tokenType.toUpperCase() === 'USDT' ? parseFloat(balanceInfo.usdt) : parseFloat(balanceInfo.metis);
        
        if (currentBalance < totalAmount) {
          const replyMessage = `@${authorUsername} Insufficient ${tokenType.toUpperCase()} balance. You have ${currentBalance} ${tokenType.toUpperCase()}, but need ${totalAmount} ${tokenType.toUpperCase()} for ${recipients.length} recipients.`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: replyMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: 'Insufficient balance for multi-send'
          });
          break;
        }
        
        // Process each recipient
        const results = [];
        for (const recipient of recipients) {
          try {
            let recipientAddress;
            
            if (recipient.startsWith('@')) {
              // Twitter handle - resolve to address
              const username = recipient.slice(1);
              let userId = null;
              
              if (username === 'BooinWeb3') {
                userId = "1516740821688537088";
              } else if (username === 'lazydevpro') {
                userId = "1455231687357390853";
              } else {
                const userInfo = await twitterService.getUserInfoByUsername(username);
                userId = userInfo?.id;
              }
              
              if (userId) {
                const recipientWallet = await getWalletForUser(userId);
                if (recipientWallet && recipientWallet.address) {
                  recipientAddress = recipientWallet.address;
                } else {
                  results.push({ recipient, status: 'failed', error: 'No wallet found' });
                  continue;
                }
              } else {
                results.push({ recipient, status: 'failed', error: 'User not found' });
                continue;
              }
            } else {
              // Direct address or invalid input
              results.push({ recipient, status: 'failed', error: 'Invalid recipient format' });
              continue;
            }
            
            // Send transaction
            const transaction = await sendTokenTransaction(senderWallet.id, recipientAddress, amount, tokenType);
            results.push({
              recipient,
              status: 'success',
              txHash: transaction.hash,
              amount: requestedAmount,
              token: tokenType.toUpperCase()
            });
            
          } catch (error) {
            results.push({
              recipient,
              status: 'failed',
              error: error.message
            });
          }
        }
        
        // Format results message
        const successful = results.filter(r => r.status === 'success');
        const failed = results.filter(r => r.status === 'failed');
        
        let replyMessage = `@${authorUsername} Multi-send Results:\n\n`;
        
        if (successful.length > 0) {
          replyMessage += `✅ Successful (${successful.length}):\n`;
          successful.forEach(result => {
            replyMessage += `• ${result.recipient}: ${result.amount} ${result.token}\n`;
            replyMessage += `  TX: https://hyperion-testnet-explorer.metisdevops.link/tx/${result.txHash}\n`;
          });
        }
        
        if (failed.length > 0) {
          replyMessage += `\n❌ Failed (${failed.length}):\n`;
          failed.forEach(result => {
            replyMessage += `• ${result.recipient}: ${result.error}\n`;
          });
        }
        
        await twitterService.replyToTweet(tweet.id, replyMessage);
        await addTweetReplyToHistory(tweet.author_id, {
          tweetId: tweet.id,
          tweetText: tweet.text,
          replyId: null,
          replyText: replyMessage,
          createdAt: new Date(tweet.created_at),
          repliedAt: new Date(),
          status: successful.length > 0 ? 'success' : 'error',
          error: failed.length > 0 ? `${failed.length} transfers failed` : null
        });
        break;
      }
      case 'swap_usdt_to_metis': {
        // USDT to METIS swap with improved logic
        const { amount } = command.params;
        logger.info('Initiating USDT to METIS swap...', { amount });

        const senderWallet = await getWalletForUser(tweet.author_id);
        if (!senderWallet) {
          logger.warn('No wallet found for sender:', tweet.author_id);
          await twitterService.replyToTweet(tweet.id, `@${authorUsername} You need a wallet to swap. Try sending tMETIS to create one.`);
          break;
        }

        try {
          // Check USDT balance first
          const { getTokenBalance } = require('../services/privyUserService');
          const USDT = '0x3c099e287ec71b4aa61a7110287d715389329237';
          const usdtBalance = await getTokenBalance(senderWallet.address, USDT, 6);
          const requestedAmount = parseFloat(amount);
          
          if (parseFloat(usdtBalance) < requestedAmount) {
            const replyMessage = `@${authorUsername} Insufficient USDT balance. You have ${usdtBalance} USDT, but need ${amount} USDT.`;
            await twitterService.replyToTweet(tweet.id, replyMessage);
            await addTweetReplyToHistory(tweet.author_id, {
              tweetId: tweet.id,
              tweetText: tweet.text,
              replyId: null,
              replyText: replyMessage,
              createdAt: new Date(tweet.created_at),
              repliedAt: new Date(),
              status: 'error',
              error: 'insufficient_usdt_balance'
            });
            break;
          }

          // Execute the swap with improved error handling
          const executedTx = await swapUSDTToMetisWithSushi(senderWallet.id, amount, 0.005);
          const replyMessage = `@${authorUsername} Your USDT to METIS swap was submitted! View on Metis Hyperion Explorer: https://hyperion-testnet-explorer.metisdevops.link/tx/${executedTx.hash}`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          logger.info('USDT to METIS swap successful:', { txHash: executedTx.hash });
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
        } catch (error) {
          logger.error('USDT to METIS swap failed:', { error: error.message, stack: error.stack });
          
          let errorMessage = error.message;
          if (error.message.includes('INSUFFICIENT_OUTPUT_AMOUNT')) {
            errorMessage = 'Swap failed: Insufficient output amount (try a smaller amount or try again later)';
          } else if (error.message.includes('TransferHelper::transferFrom: transferFrom failed')) {
            errorMessage = 'Swap failed: USDT approval required. Please try again.';
          } else if (error.message.includes('execution reverted')) {
            errorMessage = 'Swap failed: Transaction reverted';
          } else if (error.message.includes('insufficient funds') || error.message.includes('insufficient balance')) {
            errorMessage = `Swap failed: Insufficient USDT balance`;
          } else if (error.message.includes('INSUFFICIENT_BALANCE')) {
            errorMessage = `Swap failed: Insufficient USDT balance`;
          }
          
          const replyMessage = `@${authorUsername} ${errorMessage}`;
          await twitterService.replyToTweet(tweet.id, replyMessage);
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: replyMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
        }
        break;
      }
      
      case 'drip': {
        try {
          // Get user's wallet address - either from params or user's own wallet
          let targetAddress;
          
          if (command.params.address) {
            // Validate the provided address
            if (!ethers.isAddress(command.params.address)) {
              await twitterService.replyToTweet(
                tweet.id,
                `@${authorUsername} Invalid wallet address. Please provide a valid Ethereum address.`
              );
              logger.warn('Invalid address provided for drip command', { 
                userId: tweet.author_id, 
                address: command.params.address 
              });
              break;
            }
            targetAddress = command.params.address;
          } else {
            // Use user's own wallet
            const userWallet = await getWalletForUser(tweet.author_id);
            if (!userWallet || !userWallet.address) {
              await twitterService.replyToTweet(
                tweet.id,
                `@${authorUsername} You don't have a wallet yet. I'll create one for you! Please try the drip command again in a moment.`
              );
              logger.warn('No wallet found for drip request, wallet should be created by getOrCreateWalletForUser call earlier');
              break;
            }
            targetAddress = userWallet.address;
          }

          // Attempt to drip to the target address
          const result = await faucetService.dripToUser(targetAddress, tweet.author_id);
          
          if (result.success) {
            const replyMessage = `@${authorUsername} Successfully dripped ${result.amount} METIS to ${targetAddress}! 💰\n\nTransaction: https://hyperion-testnet-explorer.metisdevops.link/tx/${result.txHash}\n\nYou can request another drip in 24 hours!`;
            
            await twitterService.replyToTweet(tweet.id, replyMessage);
            
            // Award XP for successful drip usage
            try {
              await xpService.awardForDripUsage(tweet.author_id, authorUsername, {
                amount: result.amount,
                targetAddress,
                txHash: result.txHash
              });
            } catch (error) {
              logger.error('Error awarding XP for drip usage:', error);
            }
            
            await addTweetReplyToHistory(tweet.author_id, {
              tweetId: tweet.id,
              tweetText: tweet.text,
              replyId: null,
              replyText: replyMessage,
              createdAt: new Date(tweet.created_at),
              repliedAt: new Date(),
              status: 'success',
              transactionHash: result.txHash,
              amount: result.amount,
              action: 'drip'
            });
            
            logger.info('Successfully processed drip command', {
              userId: tweet.author_id,
              targetAddress,
              amount: result.amount,
              txHash: result.txHash
            });
          }
          
        } catch (error) {
          logger.error('Error processing drip command', { 
            error: error.message, 
            userId: tweet.author_id,
            targetAddress: command.params.address 
          });
          
          let errorMessage;
          if (error.message.includes('You can only request drip once per 24 hours')) {
            errorMessage = `@${authorUsername} You can only request drip once per 24 hours. Please try again later! ⏰`;
          } else if (error.message.includes('cooldown') || error.message.includes('24 hours')) {
            errorMessage = `@${authorUsername} This address can only receive drip once per 24 hours. Please try again later! ⏰`;
          } else if (error.message.includes('insufficient balance') || error.message.includes('empty')) {
            errorMessage = `@${authorUsername} The faucet is currently empty. Please try again later! 🪣`;
          } else if (error.message.includes('not authorized')) {
            errorMessage = `@${authorUsername} Faucet service is temporarily unavailable. Please contact the administrator.`;
          } else {
            errorMessage = `@${authorUsername} Sorry, I couldn't process your drip request. Please try again later.`;
          }
          
          await twitterService.replyToTweet(tweet.id, errorMessage);
          
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: errorMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: error.message,
            action: 'drip'
          });
        }
        break;
      }
      
      case 'create_giveaway': {
        try {
          let { tweetUrl, amount, token, winners, duration } = command.params;
          
          // Validate core parameters (tweetUrl can be missing/implicit)
          if (!amount || !token || !winners || !duration) {
            await twitterService.replyToTweet(
              tweet.id,
              `@${authorUsername} Invalid giveaway parameters. Please provide: amount, token, number of winners, and duration.`
            );
            break;
          }
          
          // Compute current tweet URL for robust fallback usage
          const currentTweetUrl = `https://x.com/${authorUsername}/status/${tweet.id}`;
          const currentTweetId = tweet.id;

          // Handle missing or implicit tweet URL references
          if (!tweetUrl || 
              (typeof tweetUrl === 'string' && (
                tweetUrl.toLowerCase().includes('this post') || 
                tweetUrl.toLowerCase().includes('this tweet') || 
                tweetUrl.toLowerCase().includes('this message') ||
                tweetUrl.toLowerCase().includes('replies') ||
                tweetUrl.toLowerCase().includes('comments') ||
                tweetUrl.toLowerCase().includes('commenters') ||
                tweetUrl.toLowerCase().includes('below') ||
                tweetUrl.toLowerCase().includes('here')
              ))
          ) {
            const originalUrl = tweetUrl || 'implicit reference';
            tweetUrl = currentTweetUrl;
            logger.info('Replaced implicit tweet reference with current tweet URL', { 
              originalTweetUrl: originalUrl, 
              newTweetUrl: tweetUrl 
            });
          }

          // As an extra safeguard: if tweetUrl is not a valid Twitter/X URL, override with current tweet URL
          const urlLooksValid = typeof tweetUrl === 'string' && /(twitter\.com|x\.com)\/\w+\/status\/\d+/.test(tweetUrl);
          if (!urlLooksValid) {
            const originalUrl = tweetUrl;
            tweetUrl = currentTweetUrl;
            logger.info('Invalid or non-URL tweet reference; using current tweet URL', {
              originalTweetUrl: originalUrl,
              newTweetUrl: tweetUrl
            });
          }

          // If a valid-looking URL was provided but it does NOT literally appear in the user's text,
          // assume it was inferred (e.g., from a quote/media) and prefer the current tweet to avoid confusion
          if (urlLooksValid) {
            try {
              const providedIdMatch = tweetUrl.match(/status\/(\d+)/);
              const providedId = providedIdMatch ? providedIdMatch[1] : null;
              const textHasExplicitUrl = typeof cleanedText === 'string' && cleanedText.includes('twitter.com') || cleanedText.includes('x.com');
              const textMentionsSameId = providedId && typeof cleanedText === 'string' && cleanedText.includes(providedId);
              if (!textHasExplicitUrl || !textMentionsSameId) {
                const originalUrl = tweetUrl;
                tweetUrl = currentTweetUrl;
                logger.info('Provided tweet URL not explicitly present in text; using current tweet URL instead', {
                  originalTweetUrl: originalUrl,
                  newTweetUrl: tweetUrl,
                  providedId,
                  cleanedTextSample: cleanedText?.slice(0, 100)
                });
              }
            } catch (e) {
              logger.warn('Error while validating provided tweet URL presence in text; defaulting to current', { error: e.message });
              tweetUrl = currentTweetUrl;
            }
          }
          
          // Update the params with the corrected URL and include fallbacks
          const updatedParams = { 
            ...command.params, 
            tweetUrl,
            currentTweetUrl,
            currentTweetId
          };
          
          // Create giveaway
          const giveaway = await giveawayService.createGiveaway(
            tweet.author_id,
            authorUsername,
            updatedParams
          );
          
          // Send confirmation message
          const endTime = new Date(giveaway.endTime).toLocaleString('en-US', {
            timeZone: 'UTC',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short'
          });
          
          const confirmationMessage = `@${authorUsername} 🎉 Giveaway created successfully!\n\n` +
            `💰 Prize: ${amount} ${token} each\n` +
            `👥 Winners: ${winners}\n` +
            `⏰ Ends: ${endTime}\n` +
            `📝 Total Prize Pool: ${giveaway.totalPrizeAmount} ${token}\n\n` +
            `I'll automatically select ${winners} random winners from the comments on that tweet when the time is up!`;
          
          const confirmationReply = await twitterService.replyToTweet(tweet.id, confirmationMessage);
          
          // Award XP for successful giveaway creation
          try {
            await xpService.awardForGiveawayCreation(tweet.author_id, authorUsername, {
              amount,
              token,
              winners,
              duration,
              giveawayId: giveaway._id.toString()
            });
          } catch (error) {
            logger.error('Error awarding XP for giveaway creation:', error);
          }
          
          // Store confirmation tweet ID
          if (confirmationReply && confirmationReply.data && confirmationReply.data.id) {
            giveaway.confirmationTweetId = confirmationReply.data.id;
            await giveaway.save();
          }
          
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: confirmationReply?.data?.id || null,
            replyText: confirmationMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'success',
            action: 'create_giveaway',
            giveawayId: giveaway._id.toString()
          });
          
          logger.info('Giveaway created successfully', {
            giveawayId: giveaway._id,
            creator: authorUsername,
            tweetUrl,
            amount,
            token,
            winners,
            duration
          });
          
        } catch (error) {
          logger.error('Error creating giveaway', { 
            error: error.message, 
            userId: tweet.author_id,
            params: command.params
          });
          
          let errorMessage;
          if (error.message.includes('Insufficient')) {
            errorMessage = `@${authorUsername} ${error.message}`;
          } else if (error.message.includes('Invalid tweet URL')) {
            errorMessage = `@${authorUsername} ${error.message}`;
          } else if (error.message.includes('Invalid duration')) {
            errorMessage = `@${authorUsername} ${error.message} (e.g., "24h", "12h", "30m")`;
          } else if (error.message.includes('Unsupported token')) {
            errorMessage = `@${authorUsername} ${error.message}`;
          } else {
            errorMessage = `@${authorUsername} Sorry, I couldn't create your giveaway. Please check your parameters and try again.`;
          }
          
          await twitterService.replyToTweet(tweet.id, errorMessage);
          
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: errorMessage,
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'error',
            error: error.message,
            action: 'create_giveaway'
          });
        }
        break;
      }
      
      case 'xp': {
        try {
          const userXP = await xpService.getUserXP(tweet.author_id);
          if (!userXP) {
            // Create initial XP record for new user
            await xpService.awardForBalanceCheck(tweet.author_id, authorUsername);
            const newUserXP = await xpService.getUserXP(tweet.author_id);
            
            const xpMessage = `@${authorUsername} 🎉 Welcome! You've earned your first XP!\n\n` +
              `⭐ Level: ${newUserXP.level}\n` +
              `💎 XP: ${newUserXP.totalXP.toLocaleString()}\n` +
              `🏆 Rank: #${newUserXP.rank || 'N/A'}\n\n` +
              `Keep using the bot to earn more XP and climb the leaderboard!`;
            
            await twitterService.replyToTweet(tweet.id, xpMessage);
          } else {
            const xpMessage = `@${authorUsername} 🎯 Your XP Status:\n\n` +
              `⭐ Level: ${userXP.level}\n` +
              `💎 Total XP: ${userXP.totalXP.toLocaleString()}\n` +
              `🏆 Rank: #${userXP.rank || 'N/A'}\n` +
              `🔥 Consecutive Days: ${userXP.consecutiveDays}\n\n` +
              `Recent Activity: ${userXP.recentTransactions.slice(0, 3).map(t => `${t.action.replace(/_/g, ' ')} (+${t.xpAmount.toLocaleString()})`).join(', ')}`;
            
            await twitterService.replyToTweet(tweet.id, xpMessage);
          }
          
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: 'XP status displayed',
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'success',
            action: 'xp'
          });
          
        } catch (error) {
          logger.error('Error handling XP command:', error);
          const errorMessage = `@${authorUsername} Sorry, I couldn't retrieve your XP status. Please try again later.`;
          await twitterService.replyToTweet(tweet.id, errorMessage);
        }
        break;
      }
      
      case 'leaderboard': {
        try {
          const leaderboard = await xpService.getLeaderboard(10);
          if (leaderboard.length === 0) {
            const noDataMessage = `@${authorUsername} 🏆 No leaderboard data available yet. Be the first to earn XP!`;
            await twitterService.replyToTweet(tweet.id, noDataMessage);
            break;
          }
          
          let leaderboardMessage = `@${authorUsername} 🏆 Top 10 XP Leaderboard:\n\n`;
          leaderboard.forEach((user, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            leaderboardMessage += `${medal} @${user.username} - ${user.totalXP.toLocaleString()} XP (${user.level})\n`;
          });
          
          await twitterService.replyToTweet(tweet.id, leaderboardMessage);
          
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: 'Leaderboard displayed',
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'success',
            action: 'leaderboard'
          });
          
        } catch (error) {
          logger.error('Error handling leaderboard command:', error);
          const errorMessage = `@${authorUsername} Sorry, I couldn't retrieve the leaderboard. Please try again later.`;
          await twitterService.replyToTweet(tweet.id, errorMessage);
        }
        break;
      }
      
      case 'rank': {
        try {
          const rankInfo = await xpService.getUserRank(tweet.author_id);
          if (!rankInfo) {
            const noRankMessage = `@${authorUsername} 🎯 You don't have a rank yet. Start using the bot to earn XP!`;
            await twitterService.replyToTweet(tweet.id, noRankMessage);
            break;
          }
          
          const rankMessage = `@${authorUsername} 🎯 Your Ranking:\n\n` +
            `🏆 Rank: #${rankInfo.rank} of ${rankInfo.totalUsers}\n` +
            `💎 Total XP: ${rankInfo.totalXP.toLocaleString()}\n` +
            `⭐ Level: ${rankInfo.level}\n\n` +
            `Keep earning XP to climb higher!`;
          
          await twitterService.replyToTweet(tweet.id, rankMessage);
          
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: 'Rank displayed',
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'success',
            action: 'rank'
          });
          
        } catch (error) {
          logger.error('Error handling rank command:', error);
          const errorMessage = `@${authorUsername} Sorry, I couldn't retrieve your rank. Please try again later.`;
          await twitterService.replyToTweet(tweet.id, errorMessage);
        }
        break;
      }
      
      case 'xp_history': {
        try {
          const xpHistory = await xpService.getXPHistory(tweet.author_id, 10);
          if (xpHistory.length === 0) {
            const noHistoryMessage = `@${authorUsername} 🎯 No XP history available yet. Start using the bot to earn XP!`;
            await twitterService.replyToTweet(tweet.id, noHistoryMessage);
            break;
          }
          
          let historyMessage = `@${authorUsername} 📊 Recent XP Activity:\n\n`;
          xpHistory.forEach((transaction, index) => {
            const date = new Date(transaction.timestamp).toLocaleDateString();
            const action = transaction.action.replace(/_/g, ' ').toLowerCase();
            historyMessage += `${index + 1}. ${action} (+${transaction.xpAmount.toLocaleString()} XP) - ${date}\n`;
          });
          
          await twitterService.replyToTweet(tweet.id, historyMessage);
          
          await addTweetReplyToHistory(tweet.author_id, {
            tweetId: tweet.id,
            tweetText: tweet.text,
            replyId: null,
            replyText: 'XP history displayed',
            createdAt: new Date(tweet.created_at),
            repliedAt: new Date(),
            status: 'success',
            action: 'xp_history'
          });
          
        } catch (error) {
          logger.error('Error handling XP history command:', error);
          const errorMessage = `@${authorUsername} Sorry, I couldn't retrieve your XP history. Please try again later.`;
          await twitterService.replyToTweet(tweet.id, errorMessage);
        }
        break;
      }
      
      // Add more command types here
      default:
        // Fallback to AI conversational reply instead of invalid command message
        const aiTextPrompt = `User @${authorUsername} said: "${cleanedText}". The parsed action was not supported ("${command.action}"). Reply concisely (<=240 chars), suggest supported commands if helpful. No JSON.`;
        const aiReply = await alithService.respond(aiTextPrompt);
        const replyMessage = `@${authorUsername} ${aiReply || 'I did not recognize that command. Try: balance, send 1 METIS to @user, swap 5 USDT for METIS, create wallet, drip, or create giveaway.'}`;
        await twitterService.replyToTweet(
          tweet.id,
          replyMessage
        );
        logger.warn('Unknown command action:', command.action);
        await addTweetReplyToHistory(tweet.author_id, {
          tweetId: tweet.id,
          tweetText: tweet.text,
          replyId: null,
          replyText: replyMessage,
          createdAt: new Date(tweet.created_at),
          repliedAt: new Date(),
          status: 'success',
          error: null,
          action: 'ai_fallback'
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