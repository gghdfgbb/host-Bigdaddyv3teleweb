const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Get environment variables with proper defaults
const BOT_TOKEN = process.env.BOT_TOKEN || "8494420933:AAFNh20zM_RHbP4ftWGcBEusD1VmcQlvg3E";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "8099343828";
const PORT = process.env.PORT || 3000;

// Auto-detect Render domain
function getWebDomain() {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  if (process.env.RENDER_SERVICE_NAME) {
    return `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
  }
  return `http://localhost:${PORT}`;
}

const WEB_DOMAIN = getWebDomain();

console.log('🚀 Starting Big Daddy V3 Web Server...');
console.log('🌐 Domain:', WEB_DOMAIN);
console.log('🔧 Port:', PORT);
console.log('👑 Admin ID:', ADMIN_CHAT_ID);

const app = express();

// Middleware
app.use(express.json());
app.use(express.static('static'));

// Keep-alive function (only ping after server is ready)
function startKeepAlive() {
  setTimeout(() => {
    const pingServer = async () => {
      try {
        const response = await axios.get(`${WEB_DOMAIN}/health`, { timeout: 5000 });
        console.log(`✅ Health check: ${response.status} - ${new Date().toLocaleTimeString()}`);
      } catch (error) {
        console.log(`❌ Health check failed: ${error.message}`);
      }
    };

    // Ping immediately
    pingServer();
    
    // Then ping every 4 minutes
    setInterval(pingServer, 4 * 60 * 1000);
    
    console.log('🔄 Keep-alive system started');
  }, 10000); // Wait 10 seconds for server to start
}

// Health endpoint - should be first
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Big Daddy V3 Web',
    domain: WEB_DOMAIN,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

app.get('/ping', (req, res) => {
  res.json({ 
    success: true, 
    message: 'pong',
    domain: WEB_DOMAIN,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Big Daddy V3 - WhatsApp Bot Deployment</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: Arial, sans-serif; 
                background: linear-gradient(135deg, #0f0f0f 0%, #050505 100%);
                color: white;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                text-align: center;
            }
            .container { 
                max-width: 500px; 
                padding: 2rem; 
                background: #1a1a1a;
                border-radius: 10px;
                border: 1px solid #dc2626;
            }
            h1 { color: #dc2626; margin-bottom: 1rem; }
            p { margin-bottom: 1rem; line-height: 1.6; }
            .btn { 
                display: inline-block; 
                background: #dc2626; 
                color: white; 
                padding: 1rem 2rem; 
                text-decoration: none; 
                border-radius: 5px; 
                margin: 0.5rem; 
            }
            .status { 
                background: rgba(255,255,255,0.1); 
                padding: 1rem; 
                border-radius: 5px; 
                margin-top: 1rem; 
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 Big Daddy V3</h1>
            <p>Advanced WhatsApp Bot Deployment Platform</p>
            <p>Use our Telegram bot to deploy your WhatsApp bots instantly.</p>
            <a href="https://t.me/BigDaddyV3Bot" class="btn">🚀 Start with Telegram Bot</a>
            
            <div class="status">
                <p><strong>Server Status:</strong> ✅ Online</p>
                <p><strong>Domain:</strong> ${WEB_DOMAIN}</p>
                <p><strong>Port:</strong> ${PORT}</p>
                <p><small>Auto-ping active every 5 minutes</small></p>
            </div>
        </div>
    </body>
    </html>
  `);
});

// Admin page
app.get('/admin', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
  } catch (error) {
    res.redirect('/');
  }
});

// Dashboard page
app.get('/dashboard', (req, res) => {
  const userId = req.query.user;
  if (!userId) {
    return res.redirect('/');
  }
  
  try {
    if (fs.existsSync('database.json')) {
      const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
      if (db.users && db.users[userId]) {
        return res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
      }
    }
    res.redirect('/');
  } catch (error) {
    console.error('Dashboard error:', error);
    res.redirect('/');
  }
});

// API Routes
app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.json({ success: false, message: 'Email and password required' });
    }

    if (fs.existsSync('database.json')) {
      const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
      
      for (const [userId, user] of Object.entries(db.users)) {
        if (user.email === email && user.password === password) {
          return res.json({
            success: true,
            user_id: userId,
            user_data: user,
            dashboard_url: `${WEB_DOMAIN}/dashboard?user=${userId}`
          });
        }
      }
    }
    
    res.json({ success: false, message: 'Invalid credentials' });
  } catch (error) {
    console.error('Login error:', error);
    res.json({ success: false, message: 'Server error' });
  }
});

app.get('/api/admin/stats', (req, res) => {
  try {
    if (fs.existsSync('database.json')) {
      const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
      return res.json(db.statistics || { total_users: 0, total_accounts: 0, blocked_users: 0 });
    }
    res.json({ total_users: 0, total_accounts: 0, blocked_users: 0 });
  } catch (error) {
    console.error('Stats error:', error);
    res.json({ total_users: 0, total_accounts: 0, blocked_users: 0 });
  }
});

app.get('/api/admin/users', (req, res) => {
  try {
    if (fs.existsSync('database.json')) {
      const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
      return res.json(db.users || {});
    }
    res.json({});
  } catch (error) {
    console.error('Users error:', error);
    res.json({});
  }
});

app.get('/api/admin/settings', (req, res) => {
  try {
    if (fs.existsSync('database.json')) {
      const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
      return res.json(db.settings || { force_join: [], max_accounts_per_ip: 3, blocked_ips: {} });
    }
    res.json({ force_join: [], max_accounts_per_ip: 3, blocked_ips: {} });
  } catch (error) {
    console.error('Settings error:', error);
    res.json({ force_join: [], max_accounts_per_ip: 3, blocked_ips: {} });
  }
});

app.post('/api/admin/settings', (req, res) => {
  try {
    const { max_accounts_per_ip, force_join } = req.body;
    
    let db = { users: {}, settings: { force_join: [], max_accounts_per_ip: 3, blocked_ips: {} }, statistics: { total_users: 0, total_accounts: 0, blocked_users: 0 } };
    
    if (fs.existsSync('database.json')) {
      db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    }
    
    if (max_accounts_per_ip !== undefined) {
      db.settings.max_accounts_per_ip = parseInt(max_accounts_per_ip) || 3;
    }
    
    if (force_join !== undefined) {
      db.settings.force_join = force_join || [];
    }
    
    fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
    res.json({ success: true });
  } catch (error) {
    console.error('Save settings error:', error);
    res.json({ success: false, message: 'Failed to save settings' });
  }
});

app.delete('/api/admin/user/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    
    if (fs.existsSync('database.json')) {
      const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
      
      if (db.users && db.users[userId]) {
        delete db.users[userId];
        db.statistics.total_users = Math.max(0, (db.statistics.total_users || 0) - 1);
        fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
        return res.json({ success: true });
      }
    }
    
    res.json({ success: false, message: 'User not found' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.json({ success: false, message: 'Server error' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server with proper error handling
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Web server successfully started on port ${PORT}`);
  console.log(`🌐 Access your app at: ${WEB_DOMAIN}`);
  console.log(`🔧 Health check: ${WEB_DOMAIN}/health`);
  
  // Start keep-alive after server is ready
  startKeepAlive();
});

// Handle server errors
server.on('error', (error) => {
  console.error('❌ Server failed to start:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
