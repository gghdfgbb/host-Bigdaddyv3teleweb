const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { BOT_TOKEN, ADMIN_CHAT_ID, WEB_DOMAIN } = require('./config');
const { trackIP, isIPBlocked, blockIP } = require('./utils/ipTracker');

const bot = new TelegramBot(BOT_TOKEN, { 
  polling: { 
    interval: 300,
    timeout: 10,
    limit: 100,
    retryTimeout: 3000,
    allowedUpdates: ['message', 'chat_member', 'callback_query']
  } 
});

class DatabaseManager {
  constructor() {
    this.dbPath = path.join(__dirname, 'database.json');
    this.loadDatabase();
  }

  loadDatabase() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const data = fs.readFileSync(this.dbPath, 'utf8');
        this.db = JSON.parse(data);
      } else {
        this.db = {
          users: {},
          admins: [ADMIN_CHAT_ID],
          settings: {
            force_join: [],
            max_accounts_per_ip: 3,
            blocked_ips: {}
          },
          statistics: {
            total_users: 0,
            total_accounts: 0,
            blocked_users: 0
          }
        };
        this.saveDatabase();
      }
    } catch (error) {
      console.error('Database load error:', error);
      this.db = this.getDefaultDB();
      this.saveDatabase();
    }
  }

  getDefaultDB() {
    return {
      users: {},
      admins: [ADMIN_CHAT_ID],
      settings: {
        force_join: [],
        max_accounts_per_ip: 3,
        blocked_ips: {}
      },
      statistics: {
        total_users: 0,
        total_accounts: 0,
        blocked_users: 0
      }
    };
  }

  saveDatabase() {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2));
    } catch (error) {
      console.error('Database save error:', error);
    }
  }

  async checkUserJoinedChannels(userId) {
    const forceJoin = this.db.settings.force_join;
    
    if (!forceJoin || forceJoin.length === 0) {
      return true;
    }
    
    for (const channel of forceJoin) {
      try {
        const chatMember = await bot.getChatMember(channel.id, userId);
        if (chatMember.status === 'left' || chatMember.status === 'kicked') {
          return false;
        }
      } catch (error) {
        console.error(`Error checking channel membership for ${channel.id}:`, error.message);
        return false;
      }
    }
    return true;
  }

  hasForceJoinChannels() {
    return this.db.settings.force_join && this.db.settings.force_join.length > 0;
  }

  addUser(userId, userData) {
    if (!this.db.users[userId]) {
      this.db.users[userId] = {
        ...userData,
        ip: trackIP(userId),
        created_at: new Date().toISOString(),
        status: 'active',
        joined_channels: []
      };
      this.db.statistics.total_users++;
      this.db.statistics.total_accounts++;
      this.saveDatabase();
      return true;
    }
    return false;
  }

  getUser(userId) {
    return this.db.users[userId];
  }
}

const db = new DatabaseManager();
const userStates = new Map();

// Helper function to create safe web app URL
function createWebAppUrl(path, params = {}) {
  const url = new URL(path, WEB_DOMAIN);
  Object.keys(params).forEach(key => {
    url.searchParams.set(key, params[key]);
  });
  return url.toString();
}

async function handleForceJoin(userId, chatId) {
  if (!db.hasForceJoinChannels()) {
    return true;
  }

  const hasJoined = await db.checkUserJoinedChannels(userId);
  
  if (!hasJoined) {
    const keyboard = {
      inline_keyboard: db.db.settings.force_join.map(channel => [
        { text: `Join ${channel.name}`, url: channel.invite_link }
      ]).concat([[{ text: "✅ I've Joined", callback_data: `check_join_${userId}` }]])
    };
    
    await bot.sendMessage(chatId, 
      `🔒 **Access Required**\n\n` +
      `To use **Big Daddy V3**, you must join our official channels:\n\n` +
      `${db.db.settings.force_join.map(ch => `• ${ch.name}`).join('\n')}\n\n` +
      `After joining, click "I've Joined" to verify.`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    return false;
  }
  return true;
}

// Enhanced start command handler with safe URLs
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  try {
    // Admin check
    if (userId === ADMIN_CHAT_ID) {
      const webAppUrl = createWebAppUrl('/admin');
      const keyboard = {
        inline_keyboard: [
          [{ text: "🏠 Admin Dashboard", url: webAppUrl }], // Using URL instead of web_app for compatibility
          [{ text: "📊 Statistics", callback_data: "admin_stats" }],
          [{ text: "🔧 Settings", callback_data: "admin_settings" }]
        ]
      };
      
      await bot.sendMessage(chatId, 
        `👑 **Welcome Admin!**\n\n` +
        `**Big Daddy V3 Admin Panel**\n\n` +
        `📊 Total Users: ${db.db.statistics.total_users}\n` +
        `🚀 Total Accounts: ${db.db.statistics.total_accounts}\n` +
        `🚫 Blocked Users: ${db.db.statistics.blocked_users}\n\n` +
        `Access the web dashboard using the button below:`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
      return;
    }

    // IP blocking check
    const userIP = trackIP(userId);
    if (isIPBlocked(userIP)) {
      await bot.sendMessage(chatId,
        `🚫 **ACCESS DENIED**\n\n` +
        `Your IP address has been **blocked**.\n\n` +
        `**Reason:** Failed to join required channels\n` +
        `**IP:** ${userIP}\n\n` +
        `Please contact admin for assistance.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Force join check
    const canProceed = await handleForceJoin(userId, chatId);
    if (!canProceed) return;

    // Existing user or new registration
    const existingUser = db.getUser(userId);
    if (existingUser) {
      const webAppUrl = createWebAppUrl('/dashboard', { user: userId });
      const keyboard = {
        inline_keyboard: [
          [{ text: "🚀 Open Dashboard", url: webAppUrl }],
          [{ text: "📱 Account Info", callback_data: "account_info" }],
          [{ text: "🆘 Support", callback_data: "support" }]
        ]
      };
      
      await bot.sendMessage(chatId,
        `👋 **Welcome back ${existingUser.name}!**\n\n` +
        `**Account Details:**\n` +
        `📧 Email: ${existingUser.email}\n` +
        `🆔 User ID: ${userId}\n` +
        `🌐 IP: ${existingUser.ip}\n\n` +
        `Click below to access your dashboard:`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    } else {
      // Start registration process
      userStates.set(userId, { step: 'name' });
      await bot.sendMessage(chatId,
        `🎉 **Welcome to Big Daddy V3!**\n\n` +
        `🚀 **The Ultimate WhatsApp Bot Deployment Platform**\n\n` +
        `To get started, we need to create your account.\n\n` +
        `Please enter your **full name**:`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    console.error('Start command error:', error);
    await bot.sendMessage(chatId, 
      `❌ **Service Temporarily Unavailable**\n\n` +
      `We're experiencing technical difficulties. Please try again in a few moments.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Enhanced message handler
bot.on('message', async (msg) => {
  if (msg.text.startsWith('/')) return;
  
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;
  const state = userStates.get(userId);
  
  if (!state) return;

  try {
    switch (state.step) {
      case 'name':
        if (msg.text.length < 2) {
          await bot.sendMessage(chatId, "❌ Please enter a valid name (at least 2 characters):");
          return;
        }
        state.name = msg.text.trim();
        state.step = 'email';
        userStates.set(userId, state);
        await bot.sendMessage(chatId, "📧 Great! Now enter your **email address**:", { parse_mode: 'Markdown' });
        break;
        
      case 'email':
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(msg.text)) {
          await bot.sendMessage(chatId, "❌ Please enter a valid **email address**:", { parse_mode: 'Markdown' });
          return;
        }
        state.email = msg.text.trim();
        state.step = 'password';
        userStates.set(userId, state);
        await bot.sendMessage(chatId, "🔐 Create a **secure password** (min 6 characters):", { parse_mode: 'Markdown' });
        break;
        
      case 'password':
        if (msg.text.length < 6) {
          await bot.sendMessage(chatId, "❌ Password must be at least **6 characters** long:", { parse_mode: 'Markdown' });
          return;
        }
        state.password = msg.text;
        
        // Check IP limits
        const userIP = trackIP(userId);
        const ipAccounts = Object.values(db.db.users).filter(user => user.ip === userIP).length;
        
        if (ipAccounts >= db.db.settings.max_accounts_per_ip) {
          await bot.sendMessage(chatId,
            `❌ **Account Limit Reached**\n\n` +
            `You can only create **${db.db.settings.max_accounts_per_ip} accounts** per IP address.\n\n` +
            `**Your IP:** ${userIP}\n` +
            `**Accounts created:** ${ipAccounts}\n\n` +
            `Please contact admin for assistance.`,
            { parse_mode: 'Markdown' }
          );
          userStates.delete(userId);
          return;
        }
        
        // Create user account
        const userData = {
          name: state.name,
          email: state.email,
          password: state.password
        };
        
        if (db.addUser(userId, userData)) {
          const webAppUrl = `${WEB_DOMAIN}/dashboard?user=${userId}`;
          const keyboard = {
            inline_keyboard: [
              [{ text: "🚀 Launch Dashboard", web_app: { url: webAppUrl } }],
              [{ text: "📖 Quick Guide", callback_data: "guide" }]
            ]
          };
          
          await bot.sendMessage(chatId,
            `🎉 **Account Created Successfully!**\n\n` +
            `👤 **Welcome ${userData.name}!**\n` +
            `📧 ${userData.email}\n` +
            `🌐 IP: ${userIP}\n\n` +
            `🚀 You can now deploy your WhatsApp bot using our advanced platform.`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
          );
          
          // Notify admin
          await bot.sendMessage(ADMIN_CHAT_ID,
            `🆕 **New User Registration**\n\n` +
            `👤 Name: ${userData.name}\n` +
            `📧 Email: ${userData.email}\n` +
            `🆔 User ID: ${userId}\n` +
            `🌐 IP: ${userIP}\n` +
            `📅 ${new Date().toLocaleString()}`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await bot.sendMessage(chatId, "❌ Error creating account. Please try /start again.");
        }
        
        userStates.delete(userId);
        break;
    }
  } catch (error) {
    console.error('Registration error:', error);
    await bot.sendMessage(chatId, "❌ An error occurred. Please try /start again.");
    userStates.delete(userId);
  }
});

// Enhanced callback query handler
bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const userId = callbackQuery.from.id.toString();
  const data = callbackQuery.data;

  try {
    if (data.startsWith('check_join_')) {
      const targetUserId = data.split('_')[2];
      
      // Verify the user clicking is the same user
      if (userId !== targetUserId) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "This verification is for a different user",
          show_alert: true
        });
        return;
      }

      const hasJoined = await db.checkUserJoinedChannels(targetUserId);
      
      if (hasJoined) {
        await bot.editMessageText(
          `✅ **Verification Successful!**\n\n` +
          `Thank you for joining our channels!\n\n` +
          `Now you can create your account. Use /start to begin.`,
          { 
            chat_id: message.chat.id, 
            message_id: message.message_id,
            parse_mode: 'Markdown'
          }
        );
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "Please join all required channels first",
          show_alert: true
        });
      }
    }
    
    else if (data === 'admin_stats' && userId === ADMIN_CHAT_ID) {
      const stats = db.db.statistics;
      await bot.editMessageText(
        `📊 **Admin Statistics**\n\n` +
        `👥 Total Users: ${stats.total_users}\n` +
        `📦 Total Accounts: ${stats.total_accounts}\n` +
        `🚫 Blocked Users: ${stats.blocked_users}\n` +
        `🌐 Active Sessions: ${Object.keys(db.db.users).length}\n` +
        `🔧 IP Restrictions: ${db.db.settings.max_accounts_per_ip} per IP`,
        { 
          chat_id: message.chat.id, 
          message_id: message.message_id,
          parse_mode: 'Markdown'
        }
      );
    }
    
    else if (data === 'account_info') {
      const user = db.db.users[userId];
      if (user) {
        await bot.editMessageText(
          `👤 **Account Information**\n\n` +
          `🆔 User ID: ${userId}\n` +
          `👤 Name: ${user.name}\n` +
          `📧 Email: ${user.email}\n` +
          `🌐 IP: ${user.ip}\n` +
          `📅 Registered: ${new Date(user.created_at).toLocaleDateString()}\n` +
          `🟢 Status: ${user.status}`,
          { 
            chat_id: message.chat.id, 
            message_id: message.message_id,
            parse_mode: 'Markdown'
          }
        );
      }
    }
    
    else if (data === 'support') {
      await bot.editMessageText(
        `🆘 **Support**\n\n` +
        `Need help? Here are your options:\n\n` +
        `📧 Email: support@bigdaddyv3.com\n` +
        `🔗 Website: ${WEB_DOMAIN}\n` +
        `👨‍💻 Admin: @AdminUsername\n\n` +
        `We're here to help you!`,
        { 
          chat_id: message.chat.id, 
          message_id: message.message_id,
          parse_mode: 'Markdown'
        }
      );
    }
    
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('Callback error:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { 
      text: "Error processing request. Please try again." 
    });
  }
});

// Channel leave detection and IP blocking
bot.on('chat_member', async (update) => {
  try {
    // Only process if we have force join channels configured
    if (!db.hasForceJoinChannels()) {
      return;
    }

    const chatMember = update.new_chat_member;
    const chat = update.chat;
    const userId = chatMember.user.id.toString();
    
    // Check if this is a forced channel
    const forcedChannel = db.db.settings.force_join.find(ch => ch.id === chat.id.toString());
    
    if (forcedChannel && (chatMember.status === 'left' || chatMember.status === 'kicked')) {
      const userIP = trackIP(userId);
      
      // Block the IP address
      blockIP(userIP, `Left required channel: ${forcedChannel.name}`);
      
      // Update user status
      if (db.db.users[userId]) {
        db.db.users[userId].status = 'blocked';
        db.db.statistics.blocked_users++;
        db.saveDatabase();
      }
      
      // Notify admin
      await bot.sendMessage(ADMIN_CHAT_ID,
        `🚨 **User Left Required Channel**\n\n` +
        `👤 User: ${userId}\n` +
        `📱 Channel: ${forcedChannel.name}\n` +
        `🌐 IP Blocked: ${userIP}\n` +
        `⏰ ${new Date().toLocaleString()}`,
        { parse_mode: 'Markdown' }
      );

      // Notify user
      try {
        await bot.sendMessage(userId,
          `🚫 **Access Revoked**\n\n` +
          `Your access has been revoked because you left our required channel: ${forcedChannel.name}\n\n` +
          `Your IP address (${userIP}) has been blocked.\n` +
          `Contact admin for assistance.`,
          { parse_mode: 'Markdown' }
        );
      } catch (userError) {
        console.error('Could not notify user:', userError.message);
      }
    }
  } catch (error) {
    console.error('Chat member update error:', error);
  }
});

// Error handling
bot.on('error', (error) => {
  console.error('Telegram Bot Error:', error);
});

bot.on('polling_error', (error) => {
  console.error('Polling Error:', error);
});

console.log('🤖 Big Daddy V3 Telegram Bot is running...');
console.log('📊 Admin ID:', ADMIN_CHAT_ID);
console.log('🌐 Web Domain:', WEB_DOMAIN);
