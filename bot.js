const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ==================== CONFIGURATION ====================
const config = {
    telegramBotToken: 'AAFNh20zM_RHbP4ftWGcBEusD1VmcQlvg3E', // Get from @BotFather
    webPort: process.env.PORT || 3000,
    webBaseUrl: process.env.WEB_BASE_URL || 'http://localhost:3000'
};

// ==================== DATABASE SETUP ====================
const DB_PATH = path.join(__dirname, 'database.json');

function initDatabase() {
    if (!fs.existsSync(DB_PATH)) {
        const initialData = {
            users: {},
            settings: {
                welcomeMessage: "Welcome! Please provide your email address to access your dashboard.",
                webWelcomeMessage: "Welcome to your dashboard!"
            }
        };
        fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
        console.log('✅ Database initialized');
    }
}

function readDatabase() {
    try {
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('❌ Error reading database:', error);
        return { users: {}, settings: {} };
    }
}

function writeDatabase(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Error writing database:', error);
        return false;
    }
}

function getUser(userId) {
    const db = readDatabase();
    return db.users[userId] || null;
}

function createOrUpdateUser(userId, userData) {
    const db = readDatabase();
    if (!db.users[userId]) {
        db.users[userId] = {
            id: userId,
            email: '',
            createdAt: new Date().toISOString(),
            ...userData
        };
    } else {
        db.users[userId] = { ...db.users[userId], ...userData };
    }
    return writeDatabase(db);
}

function setUserEmail(userId, email) {
    return createOrUpdateUser(userId, { 
        email: email,
        emailVerified: false,
        lastUpdated: new Date().toISOString()
    });
}

// ==================== TELEGRAM BOT SETUP ====================
const bot = new Telegraf(config.telegramBotToken);

// Session middleware for conversation flow
bot.use(session());

// Start command with interactive buttons
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    const user = getUser(userId);
    
    const welcomeMessage = readDatabase().settings.welcomeMessage;
    
    if (user && user.email) {
        // User already has email - show dashboard access
        await ctx.reply(
            `Welcome back! Your registered email: ${user.email}\n\nAccess your dashboard:`,
            Markup.inlineKeyboard([
                [Markup.button.url('📊 Open Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)],
                [Markup.button.callback('✏️ Change Email', 'change_email')]
            ])
        );
    } else {
        // New user - ask for email
        await ctx.reply(
            welcomeMessage,
            Markup.inlineKeyboard([
                [Markup.button.callback('📧 Provide Email', 'provide_email')]
            ])
        );
    }
});

// Handle email provision button
bot.action('provide_email', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.waitingForEmail = true;
    await ctx.reply('Please enter your email address:');
});

// Handle change email button
bot.action('change_email', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.waitingForEmail = true;
    await ctx.reply('Please enter your new email address:');
});

// Handle text messages for email input
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (ctx.session.waitingForEmail) {
        const email = ctx.message.text.trim();
        
        // Basic email validation
        if (!email.includes('@') || !email.includes('.')) {
            await ctx.reply('Please enter a valid email address:');
            return;
        }
        
        // Save email to database
        setUserEmail(userId, email);
        
        // Clear the session state
        ctx.session.waitingForEmail = false;
        
        // Send success message with dashboard link
        await ctx.reply(
            `✅ Thank you! Your email ${email} has been registered.\n\nYou can now access your dashboard:`,
            Markup.inlineKeyboard([
                [Markup.button.url('📊 Open Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)]
            ])
        );
    } else {
        // Handle other text messages
        await ctx.reply(
            'Welcome! Use the buttons below to interact:',
            Markup.inlineKeyboard([
                [Markup.button.callback('📧 Provide/Change Email', 'provide_email')],
                [Markup.button.url('📊 Open Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)]
            ])
        );
    }
});

// Handle button interactions
bot.action('view_dashboard', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await ctx.reply(
        'Opening your dashboard...',
        Markup.inlineKeyboard([
            [Markup.button.url('📊 Open Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)]
        ])
    );
});

// ==================== EXPRESS WEB SERVER ====================
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // For serving static files

// Web dashboard route
app.get('/dashboard/:userId', (req, res) => {
    const userId = req.params.userId;
    const user = getUser(userId);
    
    if (!user || !user.email) {
        return res.redirect('/error?message=User not found or email not provided');
    }
    
    const welcomeMessage = readDatabase().settings.webWelcomeMessage;
    
    // Simple HTML dashboard
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>User Dashboard</title>
        <style>
            body { 
                font-family: Arial, sans-serif; 
                max-width: 800px; 
                margin: 0 auto; 
                padding: 20px; 
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                color: white;
            }
            .dashboard-container {
                background: rgba(255,255,255,0.1);
                backdrop-filter: blur(10px);
                border-radius: 15px;
                padding: 30px;
                margin-top: 50px;
                box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
            }
            .user-info {
                background: rgba(255,255,255,0.2);
                padding: 20px;
                border-radius: 10px;
                margin: 20px 0;
            }
            .btn {
                background: #4CAF50;
                color: white;
                padding: 12px 24px;
                border: none;
                border-radius: 5px;
                cursor: pointer;
                text-decoration: none;
                display: inline-block;
                margin: 10px 5px;
            }
            .btn-telegram {
                background: #0088cc;
            }
        </style>
    </head>
    <body>
        <div class="dashboard-container">
            <h1>📊 Welcome to Your Dashboard</h1>
            <p>${welcomeMessage}</p>
            
            <div class="user-info">
                <h3>User Information</h3>
                <p><strong>User ID:</strong> ${user.id}</p>
                <p><strong>Email:</strong> ${user.email}</p>
                <p><strong>Member since:</strong> ${new Date(user.createdAt).toLocaleDateString()}</p>
            </div>
            
            <div class="actions">
                <h3>Quick Actions</h3>
                <a href="https://t.me/your_bot_username" class="btn btn-telegram">💬 Open Telegram Bot</a>
                <button onclick="refreshData()" class="btn">🔄 Refresh</button>
            </div>
        </div>
        
        <script>
            function refreshData() {
                location.reload();
            }
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// API endpoint to get user data
app.get('/api/user/:userId', (req, res) => {
    const user = getUser(req.params.userId);
    if (user) {
        res.json({ success: true, user });
    } else {
        res.status(404).json({ success: false, error: 'User not found' });
    }
});

// Error page
app.get('/error', (req, res) => {
    const message = req.query.message || 'An error occurred';
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Error</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .error { color: #ff4444; background: #ffeaea; padding: 20px; border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="error">
                <h2>⚠️ Error</h2>
                <p>${message}</p>
                <a href="/">Go Home</a>
            </div>
        </body>
        </html>
    `);
});

// Home page
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Telegram Bot Dashboard</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    text-align: center; 
                    padding: 50px; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    min-height: 100vh;
                }
                .container {
                    background: rgba(255,255,255,0.1);
                    backdrop-filter: blur(10px);
                    padding: 40px;
                    border-radius: 15px;
                    display: inline-block;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 Telegram Bot Dashboard</h1>
                <p>Please use the Telegram bot to access your personal dashboard.</p>
                <p><a href="https://t.me/your_bot_username" style="color: white; text-decoration: underline;">Start chatting with the bot</a></p>
            </div>
        </body>
        </html>
    `);
});

// ==================== START SERVERS ====================
async function startServers() {
    try {
        // Initialize database
        initDatabase();
        
        // Start web server
        app.listen(config.webPort, () => {
            console.log(`✅ Web server running on port ${config.webPort}`);
            console.log(`📊 Dashboard available at: ${config.webBaseUrl}`);
        });
        
        // Start Telegram bot
        await bot.launch();
        console.log('✅ Telegram bot started successfully');
        
        // Enable graceful stop
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
        
    } catch (error) {
        console.error('❌ Failed to start servers:', error);
        process.exit(1);
    }
}

// Start everything
startServers();

module.exports = {
    readDatabase,
    getUser,
    createOrUpdateUser
};
