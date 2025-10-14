const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { BOT_TOKEN, ADMIN_CHAT_ID, WEB_DOMAIN } = require('./config');

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Keep-alive function to ping all endpoints
function startKeepAlive() {
    const endpoints = [
        `${WEB_DOMAIN}/`,
        `${WEB_DOMAIN}/health`,
        `${WEB_DOMAIN}/ping`,
        `${WEB_DOMAIN}/admin`,
        `${WEB_DOMAIN}/dashboard`
    ];

    const pingEndpoint = async (endpoint) => {
        try {
            const response = await axios.get(endpoint, { timeout: 10000 });
            console.log(`✅ ${endpoint} - Status: ${response.status}`);
        } catch (error) {
            console.log(`❌ ${endpoint} - Error: ${error.message}`);
        }
    };

    // Ping all endpoints immediately
    endpoints.forEach(pingEndpoint);
    
    // Ping every 5 minutes to keep Render alive
    setInterval(() => {
        console.log(`🔄 Pinging endpoints at ${new Date().toLocaleTimeString()}`);
        endpoints.forEach(pingEndpoint);
    }, 5 * 60 * 1000);
}

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
                        force_join: [], // Empty array by default
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
    }

    saveDatabase() {
        try {
            fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2));
        } catch (error) {
            console.error('Database save error:', error);
        }
    }

    // FIXED: Only check channels if they exist and are configured
    async checkUserJoinedChannels(userId) {
        const forceJoin = this.db.settings.force_join;
        
        // Return true immediately if no channels are configured
        if (!forceJoin || forceJoin.length === 0) {
            return true;
        }
        
        // Only check channels if they are properly configured with IDs
        const validChannels = forceJoin.filter(ch => ch.id && ch.id.startsWith('-'));
        
        if (validChannels.length === 0) {
            return true;
        }
        
        for (const channel of validChannels) {
            try {
                const chatMember = await bot.getChatMember(channel.id, userId);
                if (chatMember.status === 'left' || chatMember.status === 'kicked') {
                    return false;
                }
            } catch (error) {
                console.error(`Error checking channel ${channel.id}:`, error.message);
                // Continue checking other channels even if one fails
            }
        }
        return true;
    }

    // NEW: Check if force join should be enabled
    shouldForceJoin() {
        const forceJoin = this.db.settings.force_join;
        if (!forceJoin || forceJoin.length === 0) return false;
        
        // Only return true if we have at least one valid channel ID
        return forceJoin.some(ch => ch.id && ch.id.startsWith('-'));
    }

    addUser(userId, userData) {
        if (!this.db.users[userId]) {
            this.db.users[userId] = {
                ...userData,
                ip: this.trackIP(userId),
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

    trackIP(userId) {
        // Simple IP simulation - in production, get from web requests
        return `192.168.1.${parseInt(userId) % 255}`;
    }

    getUser(userId) {
        return this.db.users[userId];
    }
}

const db = new DatabaseManager();
const userStates = new Map();

// FIXED: Improved force join handler
async function handleForceJoin(userId, chatId) {
    // Only check if admin has actually configured channels
    if (!db.shouldForceJoin()) {
        return true; // No channels configured, proceed normally
    }

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
            `🔒 **Access Required**\n\n` +
            `To use **Big Daddy V3**, you must join our official channels:\n\n` +
            `${validChannels.map(ch => `• ${ch.name}`).join('\n')}\n\n` +
            `After joining, click "I've Joined" to verify.`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
        return false;
    }
    return true;
}

// FIXED: Start command with proper flow
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    try {
        // Admin gets direct access
        if (userId === ADMIN_CHAT_ID) {
            const adminUrl = `${WEB_DOMAIN}/admin`;
            await bot.sendMessage(chatId,
                `👑 **Admin Panel - Big Daddy V3**\n\n` +
                `📊 Statistics:\n` +
                `• Users: ${db.db.statistics.total_users}\n` +
                `• Accounts: ${db.db.statistics.total_accounts}\n\n` +
                `🌐 Web Dashboard: ${adminUrl}\n\n` +
                `Use /stats for more details.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // For regular users: check force join only if configured
        const canProceed = await handleForceJoin(userId, chatId);
        if (!canProceed) return;

        // Continue with normal flow
        const user = db.getUser(userId);
        if (user) {
            const dashboardUrl = `${WEB_DOMAIN}/dashboard?user=${userId}`;
            await bot.sendMessage(chatId,
                `👋 **Welcome back ${user.name}!**\n\n` +
                `Access your dashboard: ${dashboardUrl}`,
                { parse_mode: 'Markdown' }
            );
        } else {
            userStates.set(userId, { step: 'name' });
            await bot.sendMessage(chatId,
                `🎉 **Welcome to Big Daddy V3!**\n\n` +
                `Please enter your **full name** to create account:`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (error) {
        console.error('Start command error:', error);
        await bot.sendMessage(chatId, '❌ Service error. Please try again.');
    }
});

// Add this to your existing callback handler
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

// Start keep-alive when bot starts
startKeepAlive();
console.log('🤖 Bot started with keep-alive system');
