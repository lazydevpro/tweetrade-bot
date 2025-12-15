const { setupLogger } = require('../utils/logger');
const alithService = require('../services/alithService');
const twitterService = require('../services/twitterService');
const {
  getOrCreateWalletForUser,
  getWalletForUser,
  getEnhancedBalance,
  sendTokenTransaction,
  addTweetReplyToHistory,
  swapMetisToUSDTWithSushi,
  swapUSDTToMetisWithSushi
} = require('../services/privyUserService');
const { XPService } = require('../services/xpService');
const rewardService = require('../services/rewardService');
const { ethers } = require('ethers');
const { isValidEthereumAddress } = require('../utils/addressValidator');

const logger = setupLogger();
const xpService = new XPService();

/**
 * Handle chat message with same capabilities as tweet commands, but without posting to Twitter.
 * @param {Object} params
 * @param {string} params.message - User chat message in natural language
 * @param {string} [params.twitterUserId] - Twitter user ID of the author
 * @param {string} [params.twitterUsername] - Twitter username of the author (used for mentions and resolving handles)
 * @param {string} [params.tweetUrl] - Optional explicit tweet URL for giveaway commands when message says "this tweet"
 * @returns {Promise<{status: 'success'|'error', action?: string, reply: string, data?: any}>}
 */
async function handleChat({ message, twitterUserId, twitterUsername, tweetUrl }) {
  try {
    if (!message || typeof message !== 'string') {
      return { status: 'error', reply: 'Missing or invalid message' };
    }

    // If no user id provided but username is, resolve via Twitter API
    if (!twitterUserId && twitterUsername) {
      const userInfo = await twitterService.getUserInfoByUsername(twitterUsername);
      if (!userInfo || !userInfo.id) {
        return { status: 'error', reply: 'Could not resolve Twitter user ID from username. Please provide a valid username or user ID.' };
      }
      twitterUserId = userInfo.id;
    }

    if (!twitterUserId) {
      return { status: 'error', reply: 'Missing twitterUserId or twitterUsername' };
    }

    const authorUsername = twitterUsername || (await (async () => {
      try {
        const info = await twitterService.getUserInfo(twitterUserId);
        return info?.username || 'user';
      } catch (e) {
        return 'user';
      }
    })());

    const fakeTweetId = `chat_${Date.now()}`;
    const createdAt = new Date();

    // Prepare message for NL parser (prepend author id as context)
    const textForAlith = `${twitterUserId} ${message}`;
    const command = await alithService.understand(textForAlith);

    if (!command) {
      // Conversational fallback via AI
      const aiPrompt = `User @${authorUsername} said: "${message}". Reply concisely (<=240 chars), no JSON. If relevant, suggest a supported command syntax.`;
      const aiReply = await alithService.respond(aiPrompt);
      const reply = aiReply || `I can help with balance, sending, swaps, wallet, drip, and giveaways. Try: balance, send 1 METIS to @user, swap 5 USDT for METIS, create wallet.`;
      const { addChatEntryToHistory } = require('../services/privyUserService');
      await addChatEntryToHistory(twitterUserId, {
        tweetId: fakeTweetId,
        tweetText: message,
        replyId: null,
        replyText: reply,
        createdAt,
        repliedAt: new Date(),
        status: 'success',
        error: null,
        action: 'ai_fallback'
      });
      return { status: 'success', reply, action: 'ai_fallback' };
    }

    logger.info('Parsed chat command', { action: command.action, params: command.params });

    switch (command.action) {
      case 'greeting': {
        const reply = `Hi @${authorUsername}! How can I help you today?`;
        
        // Award XP for wallet creation (greeting)
        try {
          await xpService.awardForWalletCreation(twitterUserId, authorUsername);
        } catch (error) {
          logger.error('Error awarding XP for greeting wallet creation in chat:', error);
        }
        
        const { addChatEntryToHistory } = require('../services/privyUserService');
        await addChatEntryToHistory(twitterUserId, {
          tweetId: fakeTweetId,
          tweetText: message,
          replyId: null,
          replyText: reply,
          createdAt,
          repliedAt: new Date(),
          status: 'success'
        });
        return { status: 'success', action: 'greeting', reply };
      }

      case 'create_wallet': {
        const wallet = await getOrCreateWalletForUser(twitterUserId, authorUsername);
        const balanceInfo = await getEnhancedBalance(wallet.address);
        const reply = `Your wallet is ready, @${authorUsername}.
Address: ${wallet.address}
Balance: ${balanceInfo.formatted}`;
        
        // Award XP for wallet creation
        try {
          await xpService.awardForWalletCreation(twitterUserId, authorUsername);
        } catch (error) {
          logger.error('Error awarding XP for create wallet command in chat:', error);
        }
        
        const { addChatEntryToHistory } = require('../services/privyUserService');
        await addChatEntryToHistory(twitterUserId, {
          tweetId: fakeTweetId,
          tweetText: message,
          replyId: null,
          replyText: reply,
          createdAt,
          repliedAt: new Date(),
          status: 'success'
        });
        return { status: 'success', action: 'create_wallet', reply, data: { address: wallet.address, balance: balanceInfo } };
      }

      case 'balance': {
        const recipientHandle = command.params.recipient;
        let targetUserId = twitterUserId;
        let targetLabel = 'Your';

        if (recipientHandle && typeof recipientHandle === 'string' && recipientHandle.startsWith('@')) {
          const specifiedUsername = recipientHandle.slice(1);
          const userInfo = await twitterService.getUserInfoByUsername(specifiedUsername);
          if (!userInfo || !userInfo.id) {
            const reply = `Sorry @${authorUsername}, I couldn't find a user with the handle ${recipientHandle}.`;
            const { addChatEntryToHistory } = require('../services/privyUserService');
            await addChatEntryToHistory(twitterUserId, {
              tweetId: fakeTweetId,
              tweetText: message,
              replyId: null,
              replyText: reply,
              createdAt,
              repliedAt: new Date(),
              status: 'error',
              error: 'user_not_found'
            });
            return { status: 'error', action: 'balance', reply };
          }
          targetUserId = userInfo.id;
          targetLabel = `The balance for ${recipientHandle} is`;
        }

        const wallet = await getWalletForUser(targetUserId);
        if (!wallet || !wallet.address) {
          const reply = targetUserId === twitterUserId
            ? `@${authorUsername} You don't have a wallet yet. Try creating one first.`
            : `@${authorUsername} That user doesn't have a wallet yet.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'wallet_not_found'
          });
          return { status: 'error', action: 'balance', reply };
        }

        const balanceInfo = await getEnhancedBalance(wallet.address);
        const reply = targetLabel === 'Your'
          ? `@${authorUsername} Your balance is ${balanceInfo.formatted}.`
          : `@${authorUsername} ${targetLabel} ${balanceInfo.formatted}.`;
        
        // Award XP for balance check (only to the user who requested it)
        if (targetUserId === twitterUserId) {
          try {
            await xpService.awardForBalanceCheck(twitterUserId, authorUsername);
          } catch (error) {
            logger.error('Error awarding XP for balance check in chat:', error);
          }
        }
        
        const { addChatEntryToHistory } = require('../services/privyUserService');
        await addChatEntryToHistory(twitterUserId, {
          tweetId: fakeTweetId,
          tweetText: message,
          replyId: null,
          replyText: reply,
          createdAt,
          repliedAt: new Date(),
          status: 'success'
        });
        return { status: 'success', action: 'balance', reply, data: balanceInfo };
      }

      case 'get_wallet_address': {
        const recipientHandle = command.params.recipient;
        let targetUserId = twitterUserId;
        let label = 'Your';

        if (recipientHandle && typeof recipientHandle === 'string' && recipientHandle.startsWith('@')) {
          const specifiedUsername = recipientHandle.slice(1);
          const userInfo = await twitterService.getUserInfoByUsername(specifiedUsername);
          if (!userInfo || !userInfo.id) {
            const reply = `Sorry @${authorUsername}, I couldn't find a user with the handle ${recipientHandle}.`;
            const { addChatEntryToHistory } = require('../services/privyUserService');
            await addChatEntryToHistory(twitterUserId, {
              tweetId: fakeTweetId,
              tweetText: message,
              replyId: null,
              replyText: reply,
              createdAt,
              repliedAt: new Date(),
              status: 'error',
              error: 'user_not_found'
            });
            return { status: 'error', action: 'get_wallet_address', reply };
          }
          targetUserId = userInfo.id;
          label = `The wallet address for ${recipientHandle} is`;
        }

        const wallet = await getOrCreateWalletForUser(targetUserId);
        const reply = label === 'Your'
          ? `@${authorUsername} Your wallet address is ${wallet.address}.`
          : `@${authorUsername} ${label} ${wallet.address}.`;
        
        // Award XP for wallet creation (only to the user who requested it)
        if (targetUserId === twitterUserId) {
          try {
            await xpService.awardForWalletCreation(twitterUserId, authorUsername);
          } catch (error) {
            logger.error('Error awarding XP for wallet address command in chat:', error);
          }
        }
        
        const { addChatEntryToHistory } = require('../services/privyUserService');
        await addChatEntryToHistory(twitterUserId, {
          tweetId: fakeTweetId,
          tweetText: message,
          replyId: null,
          replyText: reply,
          createdAt,
          repliedAt: new Date(),
          status: 'success'
        });
        return { status: 'success', action: 'get_wallet_address', reply, data: { address: wallet.address } };
      }

      case 'send': {
        const senderWallet = await getWalletForUser(twitterUserId);
        if (!senderWallet || !senderWallet.id) {
          const reply = `@${authorUsername} You need a wallet to send tokens. Try creating one first.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'wallet_not_found'
          });
          return { status: 'error', action: 'send', reply };
        }

        const { recipient, amount, token } = command.params;
        const tokenType = (token || 'METIS').toUpperCase();

        let recipientAddress = recipient;
        if (recipient && recipient.startsWith('@')) {
          const username = recipient.slice(1);
          const userInfo = await twitterService.getUserInfoByUsername(username);
          const userId = userInfo?.id;
          if (userId) {
            const recipientWallet = await getWalletForUser(userId);
            if (recipientWallet && recipientWallet.address) {
              recipientAddress = recipientWallet.address;
            } else {
              const reply = `@${authorUsername} The recipient ${recipient} does not have a wallet.`;
              const { addChatEntryToHistory } = require('../services/privyUserService');
              await addChatEntryToHistory(twitterUserId, {
                tweetId: fakeTweetId,
                tweetText: message,
                replyId: null,
                replyText: reply,
                createdAt,
                repliedAt: new Date(),
                status: 'error',
                error: 'recipient_wallet_not_found'
              });
              return { status: 'error', action: 'send', reply };
            }
          } else {
            const reply = `@${authorUsername} I couldn't resolve ${recipient}.`;
            const { addChatEntryToHistory } = require('../services/privyUserService');
            await addChatEntryToHistory(twitterUserId, {
              tweetId: fakeTweetId,
              tweetText: message,
              replyId: null,
              replyText: reply,
              createdAt,
              repliedAt: new Date(),
              status: 'error',
              error: 'recipient_not_found'
            });
            return { status: 'error', action: 'send', reply };
          }
        }

        if (!isValidEthereumAddress(recipientAddress)) {
          const reply = `@${authorUsername} Invalid recipient address.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'invalid_address'
          });
          return { status: 'error', action: 'send', reply };
        }

        const balanceInfo = await getEnhancedBalance(senderWallet.address);
        const currentBalance = tokenType === 'USDT' ? parseFloat(balanceInfo.usdt) : parseFloat(balanceInfo.metis);
        const requestedAmount = parseFloat(amount);
        if (currentBalance < requestedAmount) {
          const reply = `@${authorUsername} Insufficient ${tokenType} balance. You have ${currentBalance}, need ${requestedAmount}.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'insufficient_balance'
          });
          return { status: 'error', action: 'send', reply };
        }

        try {
          const tx = await sendTokenTransaction(senderWallet.id, recipientAddress, amount, tokenType);
          const reply = `@${authorUsername} Successfully sent ${amount} ${tokenType}. TX: ${tx.hash}`;
          
          // Award XP for successful token transfer
          try {
            await xpService.awardForTokenTransfer(twitterUserId, authorUsername, {
              amount,
              token: tokenType,
              recipient,
              txHash: tx.hash
            });
          } catch (error) {
            logger.error('Error awarding XP for token transfer in chat:', error);
          }
          
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success'
          });
          return { status: 'success', action: 'send', reply, data: { txHash: tx.hash } };
        } catch (error) {
          logger.error('Chat send failed', { error: error.message });
          const reply = `@${authorUsername} Failed to send ${amount} ${tokenType}. ${error.message}`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
          return { status: 'error', action: 'send', reply };
        }
      }

      case 'send_to_address': {
        const senderWallet = await getWalletForUser(twitterUserId);
        if (!senderWallet || !senderWallet.id) {
          const reply = `@${authorUsername} You need a wallet to send tokens.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'wallet_not_found'
          });
          return { status: 'error', action: 'send_to_address', reply };
        }
        const { address, amount, token } = command.params;
        const tokenType = (token || 'METIS').toUpperCase();
        if (!isValidEthereumAddress(address)) {
          const reply = `@${authorUsername} Invalid Ethereum address: ${address}`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'invalid_address'
          });
          return { status: 'error', action: 'send_to_address', reply };
        }
        const balanceInfo = await getEnhancedBalance(senderWallet.address);
        const currentBalance = tokenType === 'USDT' ? parseFloat(balanceInfo.usdt) : parseFloat(balanceInfo.metis);
        const requestedAmount = parseFloat(amount);
        if (currentBalance < requestedAmount) {
          const reply = `@${authorUsername} Insufficient ${tokenType} balance. You have ${currentBalance}, need ${requestedAmount}.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'insufficient_balance'
          });
          return { status: 'error', action: 'send_to_address', reply };
        }
        try {
          const tx = await sendTokenTransaction(senderWallet.id, address, amount, tokenType);
          const reply = `@${authorUsername} Successfully sent ${amount} ${tokenType} to ${address}. TX: ${tx.hash}`;
          
          // Award XP for successful token transfer to address
          try {
            await xpService.awardForTokenTransfer(twitterUserId, authorUsername, {
              amount,
              token: tokenType,
              recipient: address,
              txHash: tx.hash
            });
          } catch (error) {
            logger.error('Error awarding XP for send_to_address in chat:', error);
          }
          
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success'
          });
          return { status: 'success', action: 'send_to_address', reply, data: { txHash: tx.hash } };
        } catch (error) {
          logger.error('Chat send_to_address failed', { error: error.message });
          const reply = `@${authorUsername} Failed to send ${amount} ${tokenType} to ${address}. ${error.message}`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
          return { status: 'error', action: 'send_to_address', reply };
        }
      }

      case 'multi_send': {
        const senderWallet = await getWalletForUser(twitterUserId);
        if (!senderWallet || !senderWallet.id) {
          const reply = `@${authorUsername} You need a wallet to send tokens.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'wallet_not_found'
          });
          return { status: 'error', action: 'multi_send', reply };
        }

        const { recipients = [], amount, token } = command.params || {};
        const tokenType = (token || 'METIS').toUpperCase();
        const requestedAmount = parseFloat(amount);

        if (!Array.isArray(recipients) || recipients.length === 0) {
          const reply = `@${authorUsername} No recipients provided.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'no_recipients'
          });
          return { status: 'error', action: 'multi_send', reply };
        }

        if (recipients.length > 10) {
          const reply = `@${authorUsername} Too many recipients. Maximum 10 allowed per transaction.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'too_many_recipients'
          });
          return { status: 'error', action: 'multi_send', reply };
        }

        const totalAmount = requestedAmount * recipients.length;
        const balanceInfo = await getEnhancedBalance(senderWallet.address);
        const currentBalance = tokenType === 'USDT' ? parseFloat(balanceInfo.usdt) : parseFloat(balanceInfo.metis);
        if (currentBalance < totalAmount) {
          const reply = `@${authorUsername} Insufficient ${tokenType} balance. You have ${currentBalance}, need ${totalAmount} for ${recipients.length} recipients.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'insufficient_balance_multi'
          });
          return { status: 'error', action: 'multi_send', reply };
        }

        const results = [];
        for (const recipient of recipients) {
          try {
            let recipientAddress;
            if (typeof recipient === 'string' && recipient.startsWith('@')) {
              const username = recipient.slice(1);
              const userInfo = await twitterService.getUserInfoByUsername(username);
              const userId = userInfo?.id;
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
            } else if (typeof recipient === 'string' && isValidEthereumAddress(recipient)) {
              recipientAddress = recipient;
            } else {
              results.push({ recipient, status: 'failed', error: 'Invalid recipient format' });
              continue;
            }

            const transaction = await sendTokenTransaction(senderWallet.id, recipientAddress, amount, tokenType);
            results.push({ recipient, status: 'success', txHash: transaction.hash, amount: requestedAmount, token: tokenType });
          } catch (error) {
            results.push({ recipient, status: 'failed', error: error.message });
          }
        }

        const successful = results.filter(r => r.status === 'success');
        const failed = results.filter(r => r.status === 'failed');

        // Award XP for successful multi-send (award for each successful transfer)
        if (successful.length > 0) {
          try {
            for (const result of successful) {
              await xpService.awardForTokenTransfer(twitterUserId, authorUsername, {
                amount: result.amount,
                token: result.token,
                recipient: result.recipient,
                txHash: result.txHash
              });
            }
          } catch (error) {
            logger.error('Error awarding XP for multi-send in chat:', error);
          }
        }

        let reply = `@${authorUsername} Multi-send Results:\n\n`;
        if (successful.length > 0) {
          reply += `✅ Successful (${successful.length}):\n`;
          successful.forEach(r => {
            reply += `• ${r.recipient}: ${r.amount} ${r.token}\n  TX: ${r.txHash}\n`;
          });
        }
        if (failed.length > 0) {
          reply += `\n❌ Failed (${failed.length}):\n`;
          failed.forEach(r => { reply += `• ${r.recipient}: ${r.error}\n`; });
        }

        const { addChatEntryToHistory } = require('../services/privyUserService');
        await addChatEntryToHistory(twitterUserId, {
          tweetId: fakeTweetId,
          tweetText: message,
          replyId: null,
          replyText: reply,
          createdAt,
          repliedAt: new Date(),
          status: successful.length > 0 ? 'success' : 'error',
          error: failed.length > 0 ? `${failed.length} transfers failed` : null
        });
        return { status: successful.length > 0 ? 'success' : 'error', action: 'multi_send', reply, data: { successful, failed } };
      }

      case 'swap': {
        const { amount, fromToken, toToken } = command.params;
        const senderWallet = await getWalletForUser(twitterUserId);
        if (!senderWallet) {
          const reply = `@${authorUsername} You need a wallet to swap.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'wallet_not_found'
          });
          return { status: 'error', action: 'swap', reply };
        }
        try {
          if ((fromToken || '').toUpperCase() === 'METIS' && (toToken || '').toUpperCase() === 'USDT') {
            const tx = await swapMetisToUSDTWithSushi(senderWallet.id, amount, 0.005);
            const reply = `@${authorUsername} Your swap was submitted! TX: ${tx.hash}`;
            
            // Award XP for successful chat swap
            try {
              await xpService.awardForChatSwap(twitterUserId, authorUsername, {
                amount,
                fromToken,
                toToken,
                txHash: tx.hash
              });
            } catch (error) {
              logger.error('Error awarding XP for chat swap:', error);
            }
            
            const { addChatEntryToHistory } = require('../services/privyUserService');
            await addChatEntryToHistory(twitterUserId, {
              tweetId: fakeTweetId,
              tweetText: message,
              replyId: null,
              replyText: reply,
              createdAt,
              repliedAt: new Date(),
              status: 'success'
            });
            return { status: 'success', action: 'swap', reply, data: { txHash: tx.hash } };
          }
          const reply = `@${authorUsername} Only METIS -> USDT swap is supported currently.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'unsupported_swap_pair'
          });
          return { status: 'error', action: 'swap', reply };
        } catch (error) {
          logger.error('Chat swap failed', { error: error.message });
          const reply = `@${authorUsername} Swap failed. ${error.message}`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
          return { status: 'error', action: 'swap', reply };
        }
      }

      case 'swap_usdt_to_metis': {
        const { amount } = command.params;
        const senderWallet = await getWalletForUser(twitterUserId);
        if (!senderWallet) {
          const reply = `@${authorUsername} You need a wallet to swap.`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: 'wallet_not_found'
          });
          return { status: 'error', action: 'swap_usdt_to_metis', reply };
        }

        try {
          // Check USDT balance first
          const { getTokenBalance } = require('../services/privyUserService');
          const USDT = '0x3c099e287ec71b4aa61a7110287d715389329237';
          const usdtBalance = await getTokenBalance(senderWallet.address, USDT, 6);
          const requestedAmount = parseFloat(amount);
          
          if (parseFloat(usdtBalance) < requestedAmount) {
            const reply = `@${authorUsername} Insufficient USDT balance. You have ${usdtBalance} USDT, but need ${amount} USDT.`;
            const { addChatEntryToHistory } = require('../services/privyUserService');
            await addChatEntryToHistory(twitterUserId, {
              tweetId: fakeTweetId,
              tweetText: message,
              replyId: null,
              replyText: reply,
              createdAt,
              repliedAt: new Date(),
              status: 'error',
              error: 'insufficient_usdt_balance'
            });
            return { status: 'error', action: 'swap_usdt_to_metis', reply };
          }

          // Execute the swap with improved error handling
          const tx = await swapUSDTToMetisWithSushi(senderWallet.id, amount, 0.005);
          const reply = `@${authorUsername} Your swap was submitted! TX: ${tx.hash}`;
          
          // Award XP for successful USDT to METIS swap
          try {
            await xpService.awardForChatSwap(twitterUserId, authorUsername, {
              amount,
              fromToken: 'USDT',
              toToken: 'METIS',
              txHash: tx.hash
            });
          } catch (error) {
            logger.error('Error awarding XP for USDT to METIS swap in chat:', error);
          }
          
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success'
          });
          return { status: 'success', action: 'swap_usdt_to_metis', reply, data: { txHash: tx.hash } };
        } catch (error) {
          logger.error('Chat swap_usdt_to_metis failed', { error: error.message });
          
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
          
          const reply = `@${authorUsername} ${errorMessage}`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
          return { status: 'error', action: 'swap_usdt_to_metis', reply };
        }
      }

      case 'drip': {
        // Leverage faucet via tweet handler behavior: we cannot easily reuse its internal, but drip is triggered via faucetService in tweet handler.
        // Here, we mimic the same user-initiated request by creating/using wallet and asking faucet service.
        try {
          const { dripToUser } = require('../services/faucetService');
        } catch (e) {
          // ignore require test
        }
        const faucetService = require('../services/faucetService');
        const wallet = await getOrCreateWalletForUser(twitterUserId, authorUsername);
        try {
          const result = await faucetService.dripToUser(wallet.address, twitterUserId);
          const reply = `@${authorUsername} Drip sent! Amount: ${result.amount} tMETIS. TX: ${result.txHash}`;
          
          // Award XP for successful drip usage
          try {
            await xpService.awardForDripUsage(twitterUserId, authorUsername, {
              amount: result.amount,
              targetAddress: wallet.address,
              txHash: result.txHash
            });
          } catch (error) {
            logger.error('Error awarding XP for drip usage in chat:', error);
          }
          
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success'
          });
          return { status: 'success', action: 'drip', reply, data: result };
        } catch (error) {
          let reply;
          if (error.message.includes('24 hours')) {
            reply = `@${authorUsername} ${error.message}`;
          } else if (error.message.includes('insufficient balance') || error.message.includes('empty')) {
            reply = `@${authorUsername} The faucet is currently empty. Please try again later.`;
          } else {
            reply = `@${authorUsername} Sorry, I couldn't process your drip request. ${error.message}`;
          }
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
          return { status: 'error', action: 'drip', reply };
        }
      }

      case 'create_giveaway': {
        try {
          let { tweetUrl: parsedTweetUrl, amount, token, winners, duration } = command.params;
          // If the parser produced implicit refs like "this tweet", require explicit tweetUrl or use provided override.
          const implicit = !parsedTweetUrl || /this (tweet|post|message|replies|comments?|commenters|below|here)/i.test(parsedTweetUrl);
          if (implicit) {
            if (!tweetUrl) {
              const reply = `@${authorUsername} Please include a valid tweet URL for the giveaway (e.g., https://x.com/user/status/12345).`;
              const { addChatEntryToHistory } = require('../services/privyUserService');
              await addChatEntryToHistory(twitterUserId, {
                tweetId: fakeTweetId,
                tweetText: message,
                replyId: null,
                replyText: reply,
                createdAt,
                repliedAt: new Date(),
                status: 'error',
                error: 'missing_tweet_url'
              });
              return { status: 'error', action: 'create_giveaway', reply };
            }
            parsedTweetUrl = tweetUrl;
          }

          const giveawayService = require('../services/giveawayService');
          const giveaway = await giveawayService.createGiveaway(
            twitterUserId,
            authorUsername,
            { tweetUrl: parsedTweetUrl, amount, token, winners, duration }
          );

          const endTime = new Date(giveaway.endTime).toISOString();
          const reply = `@${authorUsername} Giveaway created!
Prize: ${amount} ${token} each
Winners: ${winners}
Ends: ${endTime} UTC
Total: ${giveaway.totalPrizeAmount} ${token}`;

          // Award XP for successful giveaway creation
          try {
            await xpService.awardForGiveawayCreation(twitterUserId, authorUsername, {
              amount,
              token,
              winners,
              duration,
              giveawayId: giveaway._id.toString()
            });
          } catch (error) {
            logger.error('Error awarding XP for giveaway creation in chat:', error);
          }

          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success'
          });

          return { status: 'success', action: 'create_giveaway', reply, data: { giveawayId: giveaway._id.toString() } };
        } catch (error) {
          const reply = `@${authorUsername} Failed to create giveaway. ${error.message}`;
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'error',
            error: error.message
          });
          return { status: 'error', action: 'create_giveaway', reply };
        }
      }

      case 'xp': {
        try {
          const userXP = await xpService.getUserXP(twitterUserId);
          if (!userXP) {
            // Create initial XP record for new user
            await xpService.awardForBalanceCheck(twitterUserId, authorUsername);
            const newUserXP = await xpService.getUserXP(twitterUserId);
            
            const reply = `@${authorUsername} 🎉 Welcome! You've earned your first XP!\n\n` +
              `⭐ Level: ${newUserXP.level}\n` +
              `💎 XP: ${newUserXP.totalXP.toLocaleString()}\n` +
              `🏆 Rank: #${newUserXP.rank || 'N/A'}\n\n` +
              `Keep using the bot to earn more XP and climb the leaderboard!`;
            
            const { addChatEntryToHistory } = require('../services/privyUserService');
            await addChatEntryToHistory(twitterUserId, {
              tweetId: fakeTweetId,
              tweetText: message,
              replyId: null,
              replyText: reply,
              createdAt,
              repliedAt: new Date(),
              status: 'success',
              action: 'xp'
            });
            
            return { status: 'success', action: 'xp', reply };
          } else {
            const reply = `@${authorUsername} 🎯 Your XP Status:\n\n` +
              `⭐ Level: ${userXP.level}\n` +
              `💎 Total XP: ${userXP.totalXP.toLocaleString()}\n` +
              `🏆 Rank: #${userXP.rank || 'N/A'}\n` +
              `🔥 Consecutive Days: ${userXP.consecutiveDays}\n\n` +
              `Recent Activity: ${userXP.recentTransactions.slice(0, 3).map(t => `${t.action.replace(/_/g, ' ')} (+${t.xpAmount.toLocaleString()})`).join(', ')}`;
            
            const { addChatEntryToHistory } = require('../services/privyUserService');
            await addChatEntryToHistory(twitterUserId, {
              tweetId: fakeTweetId,
              tweetText: message,
              replyId: null,
              replyText: reply,
              createdAt,
              repliedAt: new Date(),
              status: 'success',
              action: 'xp'
            });
            
            return { status: 'success', action: 'xp', reply };
          }
          
        } catch (error) {
          logger.error('Error handling XP command in chat:', error);
          const reply = `@${authorUsername} Sorry, I couldn't retrieve your XP status. Please try again later.`;
          return { status: 'error', action: 'xp', reply };
        }
      }
      
      case 'leaderboard': {
        try {
          const leaderboard = await xpService.getLeaderboard(10);
          if (leaderboard.length === 0) {
            const reply = `@${authorUsername} 🏆 No leaderboard data available yet. Be the first to earn XP!`;
            return { status: 'success', action: 'leaderboard', reply };
          }
          
          let reply = `@${authorUsername} 🏆 Top 10 XP Leaderboard:\n\n`;
          leaderboard.forEach((user, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            reply += `${medal} @${user.username} - ${user.totalXP.toLocaleString()} XP (${user.level})\n`;
          });
          
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success',
            action: 'leaderboard'
          });
          
          return { status: 'success', action: 'leaderboard', reply };
          
        } catch (error) {
          logger.error('Error handling leaderboard command in chat:', error);
          const reply = `@${authorUsername} Sorry, I couldn't retrieve the leaderboard. Please try again later.`;
          return { status: 'error', action: 'leaderboard', reply };
        }
      }
      
      case 'rank': {
        try {
          const rankInfo = await xpService.getUserRank(twitterUserId);
          if (!rankInfo) {
            const reply = `@${authorUsername} 🎯 You don't have a rank yet. Start using the bot to earn XP!`;
            return { status: 'success', action: 'rank', reply };
          }
          
          const reply = `@${authorUsername} 🎯 Your Ranking:\n\n` +
            `🏆 Rank: #${rankInfo.rank} of ${rankInfo.totalUsers}\n` +
            `💎 Total XP: ${rankInfo.totalXP.toLocaleString()}\n` +
            `⭐ Level: ${rankInfo.level}\n\n` +
            `Keep earning XP to climb higher!`;
          
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success',
            action: 'rank'
          });
          
          return { status: 'success', action: 'rank', reply };
          
        } catch (error) {
          logger.error('Error handling rank command in chat:', error);
          const reply = `@${authorUsername} Sorry, I couldn't retrieve your rank. Please try again later.`;
          return { status: 'error', action: 'rank', reply };
        }
      }
      
      case 'xp_history': {
        try {
          const xpHistory = await xpService.getXPHistory(twitterUserId, 10);
          if (xpHistory.length === 0) {
            const reply = `@${authorUsername} 📊 No XP history available yet. Start using the bot to earn XP!`;
            return { status: 'success', action: 'xp_history', reply };
          }
          
          let reply = `@${authorUsername} 📊 Recent XP Activity:\n\n`;
          xpHistory.forEach((transaction, index) => {
            const date = new Date(transaction.timestamp).toLocaleDateString();
            const action = transaction.action.replace(/_/g, ' ').toLowerCase();
            reply += `${index + 1}. ${action} (+${transaction.xpAmount.toLocaleString()} XP) - ${date}\n`;
          });
          
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success',
            action: 'xp_history'
          });
          
          return { status: 'success', action: 'xp_history', reply };
          
        } catch (error) {
          logger.error('Error handling XP history command in chat:', error);
          const reply = `@${authorUsername} Sorry, I couldn't retrieve your XP history. Please try again later.`;
          return { status: 'error', action: 'xp_history', reply };
        }
      }

      case 'claim_reward': {
        try {
          // Get user's wallet address
          const walletInfo = await getOrCreateWalletForUser(twitterUserId, authorUsername);
          if (!walletInfo || !walletInfo.address) {
            const reply = `@${authorUsername} Please create a wallet first using 'create wallet' command.`;
            return { status: 'error', action: 'claim_reward', reply };
          }

          // Get period ID from params or use latest available
          let periodId = command.params?.periodId;
          if (periodId === undefined || periodId === null) {
            // Get latest period with rewards
            const claimableRewards = await rewardService.getClaimableRewards(twitterUserId);
            if (claimableRewards.length === 0) {
              const reply = `@${authorUsername} You don't have any claimable rewards. Keep earning XP to qualify!`;
              return { status: 'success', action: 'claim_reward', reply };
            }
            periodId = claimableRewards[0].periodId;
          }

          // Verify eligibility
          const eligibility = await rewardService.verifyEligibility(twitterUserId, periodId);
          if (!eligibility.eligible) {
            let reply = `@${authorUsername} `;
            if (eligibility.reason === 'User not in top N for this period') {
              reply += `You weren't in the top N for period ${periodId}.`;
            } else if (eligibility.reason === 'Reward already claimed for this period') {
              reply += `You've already claimed rewards for period ${periodId}.`;
            } else if (eligibility.reason === 'Pool does not exist for this period') {
              const availablePeriods = await rewardService.getAvailablePeriods();
              reply += `No reward pool available for period ${periodId}. Available periods: ${availablePeriods.join(', ') || 'none'}`;
            } else {
              reply += eligibility.reason || 'Unable to claim reward.';
            }
            return { status: 'error', action: 'claim_reward', reply };
          }

          // Get nonce from contract
          let nonce = 0;
          try {
            if (rewardService.contract) {
              const currentNonce = await rewardService.contract.userPeriodNonces(walletInfo.address, periodId);
              nonce = Number(currentNonce);
            }
          } catch (error) {
            logger.warn('Could not get nonce from contract, using 0:', error);
          }

          // Prepare claim transaction
          const claimData = await rewardService.prepareClaimTransaction(
            periodId,
            walletInfo.address,
            eligibility.rank,
            eligibility.rewardAmount,
            nonce
          );

          const reply = `@${authorUsername} 🎉 You're eligible to claim your reward!\n\n` +
            `Period: ${periodId}\n` +
            `Rank: #${eligibility.rank}\n` +
            `Reward: ${ethers.formatEther(eligibility.rewardAmount)} METIS\n\n` +
            `Contract: ${rewardService.contractAddress}\n` +
            `To claim, call claimReward() with the signature provided.\n\n` +
            `Signature: ${claimData.signature.substring(0, 20)}...`;

          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success',
            action: 'claim_reward',
            data: claimData
          });

          return { status: 'success', action: 'claim_reward', reply, data: claimData };

        } catch (error) {
          logger.error('Error handling claim reward command in chat:', error);
          let reply = `@${authorUsername} `;
          if (error.message.includes('Contract not initialized')) {
            reply += 'Reward system not available. Please try again later.';
          } else if (error.message.includes('signature')) {
            reply += 'Error generating claim signature. Please try again.';
          } else {
            reply += "Sorry, I couldn't process your claim request. Please try again later.";
          }
          return { status: 'error', action: 'claim_reward', reply };
        }
      }

      case 'check_rewards': {
        try {
          const claimableRewards = await rewardService.getClaimableRewards(twitterUserId);
          
          if (claimableRewards.length === 0) {
            const reply = `@${authorUsername} You don't have any claimable rewards. Keep earning XP to qualify!`;
            return { status: 'success', action: 'check_rewards', reply };
          }

          let reply = `@${authorUsername} 🎁 Your Claimable Rewards:\n\n`;
          claimableRewards.forEach((reward, index) => {
            reply += `${index + 1}. Period ${reward.periodId} - Rank #${reward.rank} - ${ethers.formatEther(reward.rewardAmount)} METIS\n`;
          });
          reply += `\nUse 'claim reward' to claim your rewards!`;

          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success',
            action: 'check_rewards'
          });

          return { status: 'success', action: 'check_rewards', reply };

        } catch (error) {
          logger.error('Error handling check rewards command in chat:', error);
          const reply = `@${authorUsername} Sorry, I couldn't retrieve your rewards. Please try again later.`;
          return { status: 'error', action: 'check_rewards', reply };
        }
      }

      case 'available_periods': {
        try {
          const availablePeriods = await rewardService.getAvailablePeriods();
          
          if (availablePeriods.length === 0) {
            const reply = `@${authorUsername} No reward periods are currently available.`;
            return { status: 'success', action: 'available_periods', reply };
          }

          const reply = `@${authorUsername} 📅 Available Reward Periods:\n\n` +
            `Periods: ${availablePeriods.join(', ')}\n\n` +
            `Use 'check rewards' to see if you have rewards to claim!`;

          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success',
            action: 'available_periods'
          });

          return { status: 'success', action: 'available_periods', reply };

        } catch (error) {
          logger.error('Error handling available periods command in chat:', error);
          const reply = `@${authorUsername} Sorry, I couldn't retrieve available periods. Please try again later.`;
          return { status: 'error', action: 'available_periods', reply };
        }
      }

      case 'current_leaderboard': {
        try {
          const leaderboard = await xpService.getLeaderboard(10);
          if (leaderboard.length === 0) {
            const reply = `@${authorUsername} 🏆 No leaderboard data available yet. Be the first to earn XP!`;
            return { status: 'success', action: 'current_leaderboard', reply };
          }
          
          const currentPeriodId = await rewardService.getCurrentPeriodId();
          let reply = `@${authorUsername} 🏆 Current Period (${currentPeriodId}) Leaderboard:\n\n`;
          leaderboard.forEach((user, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            reply += `${medal} @${user.username} - ${user.totalXP.toLocaleString()} XP (${user.level})\n`;
          });
          
          const { addChatEntryToHistory } = require('../services/privyUserService');
          await addChatEntryToHistory(twitterUserId, {
            tweetId: fakeTweetId,
            tweetText: message,
            replyId: null,
            replyText: reply,
            createdAt,
            repliedAt: new Date(),
            status: 'success',
            action: 'current_leaderboard'
          });
          
          return { status: 'success', action: 'current_leaderboard', reply };
          
        } catch (error) {
          logger.error('Error handling current leaderboard command in chat:', error);
          const reply = `@${authorUsername} Sorry, I couldn't retrieve the leaderboard. Please try again later.`;
          return { status: 'error', action: 'current_leaderboard', reply };
        }
      }
      
      default: {
        // Conversational fallback for unsupported actions
        const aiPrompt = `User @${authorUsername} said: "${message}". The parsed action was not supported ("${command.action}"). Reply concisely (<=240 chars), suggest supported commands if helpful. No JSON.`;
        const aiReply = await alithService.respond(aiPrompt);
        const reply = aiReply || `I did not recognize that command. Try: balance, send 1 METIS to @user, swap 5 USDT for METIS, create wallet, drip, create giveaway, xp, leaderboard, rank, or xp history.`;
        const { addChatEntryToHistory } = require('../services/privyUserService');
        await addChatEntryToHistory(twitterUserId, {
          tweetId: fakeTweetId,
          tweetText: message,
          replyId: null,
          replyText: reply,
          createdAt,
          repliedAt: new Date(),
          status: 'success',
          error: null,
          action: 'ai_fallback'
        });
        return { status: 'success', action: 'ai_fallback', reply };
      }
    }
  } catch (error) {
    logger.error('Error handling chat', { error: error.message, stack: error.stack });
    return { status: 'error', reply: `Unexpected error: ${error.message}` };
  }
}

module.exports = { handleChat };