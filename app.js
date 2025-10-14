const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { WEB_DOMAIN, PORT } = require('./config');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static('static'));

// Keep-alive for web server itself
function startWebKeepAlive() {
    const pingServer = async () => {
        try {
            const response = await axios.get(`${WEB_DOMAIN}/health`, { timeout: 5000 });
            console.log(`🌐 Web server self-ping: ${response.status}`);
        } catch (error) {
            console.log(`🌐 Web server ping failed: ${error.message}`);
        }
    };

    // Self-ping every 4 minutes
    setInterval(pingServer, 4 * 60 * 1000);
    console.log('🔄 Web server keep-alive started');
}

// Fixed endpoints
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Big Daddy V3</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    background: #0f0f0f;
                    color: white;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                }
                .container { 
                    text-align: center; 
                    background: #1a1a1a;
                    padding: 3rem;
                    border-radius: 10px;
                    border: 1px solid #dc2626;
                }
                h1 { color: #dc2626; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 Big Daddy V3</h1>
                <p>WhatsApp Bot Deployment Platform</p>
                <p>Use our Telegram bot to get started</p>
                <p><small>Server: ✅ Online</small></p>
            </div>
        </body>
        </html>
    `);
});

// Essential health endpoints
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Big Daddy V3 Web',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.get('/ping', (req, res) => {
    res.json({ 
        success: true, 
        message: 'pong',
        timestamp: new Date().toISOString()
    });
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/dashboard', (req, res) => {
    const userId = req.query.user;
    if (!userId) return res.redirect('/');
    
    try {
        const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
        if (!db.users[userId]) return res.redirect('/');
        res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
    } catch (error) {
        res.redirect('/');
    }
});

// API routes
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
  
  for (const [userId, user] of Object.entries(db.users)) {
    if (user.email === email && user.password === password) {
      return res.json({ success: true, user_id: userId, user_data: user });
    }
  }
  
  res.json({ success: false, message: 'Invalid credentials' });
});

app.get('/api/admin/stats', (req, res) => {
  const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
  res.json(db.statistics);
});


// Add this new endpoint for settings check
app.get('/api/force-join-status', (req, res) => {
    try {
        const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
        const hasForceJoin = db.settings.force_join && 
                            db.settings.force_join.length > 0 && 
                            db.settings.force_join.some(ch => ch.id && ch.id.startsWith('-'));
        res.json({ hasForceJoin, channels: db.settings.force_join || [] });
    } catch (error) {
        res.json({ hasForceJoin: false, channels: [] });
    }
});

// Start web server keep-alive
startWebKeepAlive();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

