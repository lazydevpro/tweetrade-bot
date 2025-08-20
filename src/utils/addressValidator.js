/**
 * Utility functions for validating Ethereum addresses and parsing recipients
 * Phase 3 enhancement for X-Pay Twitter Bot
 */

/**
 * Validates if a string is a valid Ethereum address format
 * @param {string} address - The address to validate
 * @returns {boolean} - True if valid Ethereum address format
 */
function isValidEthereumAddress(address) {
  if (!address || typeof address !== 'string') {
    return false;
  }
  
  // Check if it starts with 0x and is 42 characters long
  const ethAddressRegex = /^0x[a-fA-F0-9]{40}$/;
  return ethAddressRegex.test(address);
}

/**
 * Extracts potential Ethereum addresses from a text string
 * @param {string} text - The text to search for addresses
 * @returns {string[]} - Array of valid Ethereum addresses found
 */
function extractAddressesFromText(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  
  // Regular expression to find potential Ethereum addresses
  const ethAddressRegex = /0x[a-fA-F0-9]{40}/g;
  const matches = text.match(ethAddressRegex) || [];
  
  // Filter to only include valid addresses
  return matches.filter(address => isValidEthereumAddress(address));
}

/**
 * Parses multiple recipients from a command string
 * Supports both Twitter handles (@user) and raw addresses (0x...)
 * @param {string} recipientString - The recipient string to parse
 * @returns {Object[]} - Array of recipient objects with type and value
 */
function parseRecipients(recipientString) {
  if (!recipientString || typeof recipientString !== 'string') {
    return [];
  }
  
  const recipients = [];
  
  // Split by comma and clean up
  const parts = recipientString.split(',').map(part => part.trim());
  
  for (const part of parts) {
    if (part.startsWith('@')) {
      // Twitter handle
      recipients.push({
        type: 'twitter',
        value: part.substring(1) // Remove @
      });
    } else if (isValidEthereumAddress(part)) {
      // Ethereum address
      recipients.push({
        type: 'address',
        value: part
      });
    }
    // Ignore invalid entries
  }
  
  return recipients;
}

module.exports = {
  isValidEthereumAddress,
  extractAddressesFromText,
  parseRecipients
};