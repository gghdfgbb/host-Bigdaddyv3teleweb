const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { BOT_TOKEN, ADMIN_CHAT_ID, WEB_DOMAIN } = require('./config');
const { trackIP, isIPBlocked, blockIP } = require('./utils/ipTracker');

const bot = new TelegramBot(BOT_TOKEN, { 
  polling: true 
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
        console.error(`Error checking channel membership:`, error.message);
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
        status: 'active'
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

// Simple message function
async function sendMainMenu(chatId, userId, isAdmin = false) {
  if (isAdmin) {
    const adminUrl = `${WEB_DOMAIN}/admin`;
    await bot.sendMessage(chatId,
      `👑 *Admin Panel - Big Daddy V3*\n\n` +
      `📊 *Statistics:*\n` +
      `• Users: ${db.db.statistics.total_users}\n` +
      `• Accounts: ${db.db.statistics.total_accounts}\n` +
      `• Blocked: ${db.db.statistics.blocked_users}\n\n` +
      `🌐 *Web Dashboard:*\n${adminUrl}\n\n` +
      `Use /stats for detailed statistics\n` +
      `Use /users to view all users`,
      { parse_mode: 'Markdown' }
    );
  } else {
    const user = db.getUser(userId);
    if (user) {
      const dashboardUrl = `${WEB_DOMAIN}/dashboard?user=${userId}`;
      await bot.sendMessage(chatId,
        `👋 *Welcome back ${user.name}!*\n\n` +
        `*Your Account:*\n` +
        `• Email: ${user.email}\n` +
        `• User ID: ${userId}\n` +
        `• Status: ✅ Active\n\n` +
        `🌐 *Dashboard:* ${dashboardUrl}\n\n` +
        `Use /account for account info\n` +
        `Use /support for help`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(chatId,
        `🎉 *Welcome to Big Daddy V3!*\n\n` +
        `🚀 *WhatsApp Bot Deployment Platform*\n\n` +
        `To get started, create your account:\n` +
        `Use /register to begin`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

// Start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  
  try {
    // Check if user needs to join channels
    if (db.hasForceJoinChannels()) {
      const hasJoined = await db.checkUserJoinedChannels(userId);
      if (!hasJoined) {
        const keyboard = {
          inline_keyboard: db.db.settings.force_join.map(channel => [
            { text: `Join ${channel.name}`, url: channel.invite_link }
          ]).concat([[{ text: "✅ I've Joined", callback_data: `check_join_${userId}` }]])
        };
        
        await bot.sendMessage(chatId,
          `🔒 *Access Required*\n\n` +
          `Please join our channels first:\n\n` +
          `${db.db.settings.force_join.map(ch => `• ${ch.name}`).join('\n')}\n\n` +
          `Then click "I've Joined"`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
        return;
      }
    }

    // Check IP blocking
    const userIP = trackIP(userId);
    if (isIPBlocked(userIP)) {
      await bot.sendMessage(chatId,
        `🚫 *ACCESS DENIED*\n\n` +
        `Your IP (${userIP}) is blocked.\n` +
        `Reason: Violated terms\n\n` +
        `Contact admin for help.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Show appropriate menu
    const isAdmin = userId === ADMIN_CHAT_ID;
    await sendMainMenu(chatId, userId, isAdmin);

  } catch (error) {
    console.error('Start error:', error);
    await bot.sendMessage(chatId, '❌ Service error. Please try again.');
  }
});

// Register command
bot.onText(/\/register/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  if (db.getUser(userId)) {
    await bot.sendMessage(chatId, '✅ You already have an account! Use /start to continue.');
    return;
  }

  userStates.set(userId, { step: 'name' });
  await bot.sendMessage(chatId,
    `📝 *Account Registration*\n\n` +
    `Let's create your account!\n\n` +
    `Please enter your *full name*:`,
    { parse_mode: 'Markdown' }
  );
});

// Stats command for admin
bot.onText(/\/stats/, async (msg) => {
  const userId = msg.from.id.toString();
  if (userId !== ADMIN_CHAT_ID) return;

  const stats = db.db.statistics;
  await bot.sendMessage(msg.chat.id,
    `📊 *Detailed Statistics*\n\n` +
    `👥 Total Users: ${stats.total_users}\n` +
    `📦 Total Accounts: ${stats.total_accounts}\n` +
    `🚫 Blocked Users: ${stats.blocked_users}\n` +
    `🌐 Active Sessions: ${Object.keys(db.db.users).length}\n` +
    `🔧 Accounts per IP: ${db.db.settings.max_accounts_per_ip}\n\n` +
    `Force Join Channels: ${db.hasForceJoinChannels() ? '✅ Enabled' : '❌ Disabled'}`,
    { parse_mode: 'Markdown' }
  );
});

// Account info command
bot.onText(/\/account/, async (msg) => {
  const userId = msg.from.id.toString();
  const user = db.getUser(userId);
  
  if (!user) {
    await bot.sendMessage(msg.chat.id, '❌ No account found. Use /register to create one.');
    return;
  }

  await bot.sendMessage(msg.chat.id,
    `👤 *Account Information*\n\n` +
    `🆔 User ID: ${userId}\n` +
    `👤 Name: ${user.name}\n` +
    `📧 Email: ${user.email}\n` +
    `🌐 IP: ${user.ip}\n` +
    `📅 Registered: ${new Date(user.created_at).toLocaleDateString()}\n` +
    `🟢 Status: ${user.status}`,
    { parse_mode: 'Markdown' }
  );
});

// Message handler for registration
bot.on('message', async (msg) => {
  if (msg.text.startsWith('/')) return;
  
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;
  const state = userStates.get(userId);
  
  if (!state) return;

  try {
    switch (state.step) {
      case 'name':
        state.name = msg.text.trim();
        state.step = 'email';
        await bot.sendMessage(chatId, '📧 Now enter your *email address*:', { parse_mode: 'Markdown' });
        break;
        
      case 'email':
        state.email = msg.text.trim();
        state.step = 'password';
        await bot.sendMessage(chatId, '🔐 Create a *secure password* (min 6 characters):', { parse_mode: 'Markdown' });
        break;
        
      case 'password':
        if (msg.text.length < 6) {
          await bot.sendMessage(chatId, '❌ Password must be at least 6 characters. Try again:');
          return;
        }
        
        const userIP = trackIP(userId);
        const ipAccounts = Object.values(db.db.users).filter(user => user.ip === userIP).length;
        
        if (ipAccounts >= db.db.settings.max_accounts_per_ip) {
          await bot.sendMessage(chatId,
            `❌ *Account Limit Reached*\n\n` +
            `Max ${db.db.settings.max_accounts_per_ip} accounts per IP.\n` +
            `Your IP: ${userIP}\n` +
            `Contact admin for help.`,
            { parse_mode: 'Markdown' }
          );
          userStates.delete(userId);
          return;
        }
        
        const userData = {
          name: state.name,
          email: state.email,
          password: msg.text
        };
        
        if (db.addUser(userId, userData)) {
          const dashboardUrl = `${WEB_DOMAIN}/dashboard?user=${userId}`;
          await bot.sendMessage(chatId,
            `🎉 *Account Created Successfully!*\n\n` +
            `👤 Welcome *${userData.name}*!\n` +
            `📧 ${userData.email}\n\n` +
            `🌐 *Dashboard:* ${dashboardUrl}\n\n` +
            `You can now deploy your WhatsApp bots!`,
            { parse_mode: 'Markdown' }
          );
          
          // Notify admin
          await bot.sendMessage(ADMIN_CHAT_ID,
            `🆕 *New User Registration*\n\n` +
            `👤 ${userData.name}\n` +
            `📧 ${userData.email}\n` +
            `🆔 ${userId}\n` +
            `🌐 ${userIP}`,
            { parse_mode: 'Markdown' }
          );
        }
        
        userStates.delete(userId);
        break;
    }
  } catch (error) {
    console.error('Registration error:', error);
    await bot.sendMessage(chatId, '❌ Registration error. Please try /register again.');
    userStates.delete(userId);
  }
});

// Callback queries
bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const userId = callbackQuery.from.id.toString();
  const data = callbackQuery.data;

  try {
    if (data.startsWith('check_join_')) {
      const targetUserId = data.split('_')[2];
      if (userId !== targetUserId) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Not your verification", show_alert: true });
        return;
      }

      const hasJoined = await db.checkUserJoinedChannels(targetUserId);
      if (hasJoined) {
        await bot.editMessageText('✅ *Verified!* Use /start to continue.', {
          chat_id: message.chat.id,
          message_id: message.message_id,
          parse_mode: 'Markdown'
        });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Please join all channels first", show_alert: true });
      }
    }
    
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('Callback error:', error);
  }
});

console.log('🤖 Big Daddy V3 Bot Started!');
