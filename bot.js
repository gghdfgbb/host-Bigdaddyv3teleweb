const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN || "8494420933:AAFNh20zM_RHbP4ftWGcBEusD1VmcQlvg3E";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "8099343828";

// Get web domain
function getWebDomain() {
    if (process.env.RENDER_EXTERNAL_URL) {
        return process.env.RENDER_EXTERNAL_URL;
    }
    if (process.env.RENDER_SERVICE_NAME) {
        return `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
    }
    return 'http://localhost:3000';
}

const WEB_DOMAIN = getWebDomain();

console.log('🤖 Starting Telegram Bot...');
console.log('🌐 Web Domain:', WEB_DOMAIN);
console.log('👑 Admin ID:', ADMIN_CHAT_ID);

const bot = new TelegramBot(BOT_TOKEN, { 
    polling: true,
    request: {
        timeout: 10000
    }
});

// Wait for web service to be ready with better detection
async function waitForWebService() {
    console.log('⏳ Waiting for web service to be ready...');
    
    let attempts = 0;
    const maxAttempts = 12; // 2 minutes max (12 * 10 seconds)
    
    while (attempts < maxAttempts) {
        try {
            const response = await axios.get(`${WEB_DOMAIN}/health`, { 
                timeout: 5000,
                validateStatus: function (status) {
                    return status < 500; // Accept any status code less than 500
                }
            });
            
            console.log(`✅ Web service responded: ${response.status}`);
            console.log('✅ Web service is ready!');
            return true;
            
        } catch (error) {
            console.log(`⏰ Attempt ${attempts + 1}/${maxAttempts} - Web service not ready: ${error.message}`);
        }
        
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
    }
    
    console.log('❌ Web service did not become ready in time');
    return false;
}

// Start keep-alive only after web service is ready
async function startKeepAlive() {
    const isReady = await waitForWebService();
    
    if (!isReady) {
        console.log('🚫 Cannot start keep-alive - web service unavailable');
        return;
    }

    const pingWeb = async () => {
        try {
            const response = await axios.get(`${WEB_DOMAIN}/health`, { 
                timeout: 10000,
                validateStatus: function (status) {
                    return status < 500;
                }
            });
            console.log(`✅ Web service ping: ${response.status} - ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            console.log(`❌ Web service ping failed: ${error.message}`);
        }
    };

    // Start pinging
    console.log('🔄 Starting keep-alive system...');
    pingWeb();
    setInterval(pingWeb, 5 * 60 * 1000); // Ping every 5 minutes
    
    console.log('🔄 Keep-alive system started');
}

// Database setup
class DatabaseManager {
    constructor() {
        this.dbPath = 'database.json';
        this.loadDatabase();
    }

    loadDatabase() {
        try {
            if (fs.existsSync(this.dbPath)) {
                this.db = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
                console.log('✅ Database loaded successfully');
            } else {
                this.initializeDefaultDB();
            }
        } catch (error) {
            console.error('❌ Database load error:', error);
            this.initializeDefaultDB();
        }
    }

    initializeDefaultDB() {
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
        console.log('✅ Default database initialized');
    }

    saveDatabase() {
        try {
            fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2));
        } catch (error) {
            console.error('❌ Database save error:', error);
        }
    }

    shouldForceJoin() {
        const forceJoin = this.db.settings.force_join;
        return forceJoin && forceJoin.length > 0 && forceJoin.some(ch => ch.id && ch.id.startsWith('-'));
    }

    async checkUserJoinedChannels(userId) {
        if (!this.shouldForceJoin()) return true;

        const forceJoin = this.db.settings.force_join;
        for (const channel of forceJoin) {
            try {
                const chatMember = await bot.getChatMember(channel.id, userId);
                if (chatMember.status === 'left' || chatMember.status === 'kicked') {
                    return false;
                }
            } catch (error) {
                console.error(`❌ Channel check error for ${channel.id}:`, error.message);
            }
        }
        return true;
    }

    addUser(userId, userData) {
        if (!this.db.users[userId]) {
            this.db.users[userId] = {
                ...userData,
                ip: `192.168.1.${parseInt(userId) % 255}`,
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

// Start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    try {
        // Admin access
        if (userId === ADMIN_CHAT_ID) {
            const adminUrl = `${WEB_DOMAIN}/admin`;
            await bot.sendMessage(chatId,
                `👑 *Admin Panel - Big Daddy V3*\n\n` +
                `📊 *Statistics:*\n` +
                `• Users: ${db.db.statistics.total_users}\n` +
                `• Accounts: ${db.db.statistics.total_accounts}\n\n` +
                `🌐 *Web Dashboard:* ${adminUrl}\n\n` +
                `Use /stats for detailed statistics`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Force join check (only if channels are configured)
        if (db.shouldForceJoin()) {
            const hasJoined = await db.checkUserJoinedChannels(userId);
            if (!hasJoined) {
                const validChannels = db.db.settings.force_join.filter(ch => ch.id && ch.name);
                const keyboard = {
                    inline_keyboard: [
                        ...validChannels.map(channel => [
                            { text: `Join ${channel.name}`, url: channel.invite_link || `https://t.me/${channel.id}` }
                        ]),
                        [{ text: "✅ I've Joined", callback_data: `check_join_${userId}` }]
                    ]
                };
                
                await bot.sendMessage(chatId, 
                    `🔒 *Access Required*\n\n` +
                    `Please join our channels:\n\n` +
                    `${validChannels.map(ch => `• ${ch.name}`).join('\n')}\n\n` +
                    `Then click "I've Joined"`,
                    { parse_mode: 'Markdown', reply_markup: keyboard }
                );
                return;
            }
        }

        // User flow
        const user = db.getUser(userId);
        if (user) {
            const dashboardUrl = `${WEB_DOMAIN}/dashboard?user=${userId}`;
            await bot.sendMessage(chatId,
                `👋 *Welcome back ${user.name}!*\n\n` +
                `🌐 *Dashboard:* ${dashboardUrl}`,
                { parse_mode: 'Markdown' }
            );
        } else {
            await bot.sendMessage(chatId,
                `🎉 *Welcome to Big Daddy V3!*\n\n` +
                `Use /register to create your account\n` +
                `Use /help for assistance`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (error) {
        console.error('❌ Start command error:', error);
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
                        `🌐 ${db.db.users[userId].ip}`,
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
    const data = callbackQuery.data;
    
    if (data.startsWith('check_join_')) {
        const userId = data.split('_')[2];
        const hasJoined = await db.checkUserJoinedChannels(userId);
        
        if (hasJoined) {
            await bot.editMessageText('✅ **Verified!** Use /start to continue.', {
                chat_id: callbackQuery.message.chat.id,
                message_id: callbackQuery.message.message_id,
                parse_mode: 'Markdown'
            });
        } else {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: "Please join all required channels first",
                show_alert: true
            });
        }
    }
});

// Stats command
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
        `🔧 Accounts per IP: ${db.db.settings.max_accounts_per_ip}`,
        { parse_mode: 'Markdown' }
    );
});

// Start the system
startKeepAlive().then(() => {
    console.log('✅ Big Daddy V3 Bot is fully operational!');
});

console.log('✅ Bot started (waiting for web service...)');
