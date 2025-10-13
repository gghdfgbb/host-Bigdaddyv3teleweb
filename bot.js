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
    
    for (const channel of forceJoin) {
      try {
        const chatMember = await bot.getChatMember(channel.id, userId);
        if (chatMember.status === 'left' || chatMember.status === 'kicked') {
          return false;
        }
      } catch (error) {
        console.error(`Error checking channel membership: ${error}`);
        return false;
      }
    }
    return true;
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
}

const db = new DatabaseManager();

// Store user registration state
const userStates = new Map();

// Force join check handler
async function handleForceJoin(userId, chatId) {
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

// Start command handler
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  // Admin check
  if (userId === ADMIN_CHAT_ID) {
    const keyboard = {
      inline_keyboard: [
        [{ text: "🏠 Admin Dashboard", web_app: { url: `${WEB_DOMAIN}/admin` } }],
        [{ text: "📊 Statistics", callback_data: "admin_stats" }]
      ]
    };
    
    await bot.sendMessage(chatId, 
      `👑 **Welcome Admin!**\n\n` +
      `**Big Daddy V3 Admin Panel**\n\n` +
      `📊 Total Users: ${db.db.statistics.total_users}\n` +
      `🚀 Total Accounts: ${db.db.statistics.total_accounts}\n` +
      `🚫 Blocked Users: ${db.db.statistics.blocked_users}\n\n` +
      `Access the web dashboard for full control:`,
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
      `Please contact admin for assistance.`
    );
    return;
  }

  // Force join check
  const canProceed = await handleForceJoin(userId, chatId);
  if (!canProceed) return;

  // Existing user or new registration
  if (db.db.users[userId]) {
    const user = db.db.users[userId];
    const keyboard = {
      inline_keyboard: [
        [{ text: "🚀 Open Web Dashboard", web_app: { url: `${WEB_DOMAIN}/dashboard?user=${userId}` } }],
        [{ text: "📱 Account Info", callback_data: "account_info" }]
      ]
    };
    
    await bot.sendMessage(chatId,
      `👋 **Welcome back ${user.name}!**\n\n` +
      `**Account Details:**\n` +
      `📧 Email: ${user.email}\n` +
      `🆔 User ID: ${userId}\n` +
      `🌐 IP: ${user.ip}\n\n` +
      `Ready to deploy your WhatsApp bot?`,
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
});

// Registration flow
bot.on('message', async (msg) => {
  if (msg.text.startsWith('/')) return;
  
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;
  const state = userStates.get(userId);
  
  if (!state) return;

  try {
    switch (state.step) {
      case 'name':
        state.name = msg.text;
        state.step = 'email';
        userStates.set(userId, state);
        await bot.sendMessage(chatId, "📧 Great! Now enter your **email address**:", { parse_mode: 'Markdown' });
        break;
        
      case 'email':
        state.email = msg.text;
        state.step = 'password';
        userStates.set(userId, state);
        await bot.sendMessage(chatId, "🔐 Create a **secure password**:", { parse_mode: 'Markdown' });
        break;
        
      case 'password':
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
          const keyboard = {
            inline_keyboard: [
              [{ text: "🚀 Launch Dashboard", web_app: { url: `${WEB_DOMAIN}/dashboard?user=${userId}` } }],
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

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const userId = callbackQuery.from.id.toString();
  const data = callbackQuery.data;

  try {
    if (data.startsWith('check_join_')) {
      const targetUserId = data.split('_')[2];
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
    
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('Callback error:', error);
    await bot.answerCallbackQuery(callbackQuery.id, { text: "Error processing request" });
  }
});

// Channel leave detection and IP blocking
bot.on('chat_member', async (update) => {
  try {
    const chatMember = update.new_chat_member;
    const chat = update.chat;
    const userId = chatMember.user.id.toString();
    
    // Check if this is a forced channel
    const forcedChannel = db.db.settings.force_join.find(ch => ch.id === chat.id.toString());
    
    if (forcedChannel && chatMember.status === 'left') {
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
    }
  } catch (error) {
    console.error('Chat member update error:', error);
  }
});

console.log('🤖 Big Daddy V3 Telegram Bot is running...');
