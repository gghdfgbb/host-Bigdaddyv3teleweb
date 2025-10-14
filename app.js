const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { WEB_DOMAIN, PORT } = require('./config');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static('static'));

// Auto-ping function to keep Render alive
function startAutoPing() {
  const pingInterval = 5 * 60 * 1000; // 5 minutes
  
  const pingServer = async () => {
    try {
      const response = await axios.get(WEB_DOMAIN, { timeout: 10000 });
      console.log(`✅ Ping successful: ${response.status} - ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      console.log(`❌ Ping failed: ${error.message} - ${new Date().toLocaleTimeString()}`);
    }
  };

  // Ping immediately on startup
  pingServer();
  
  // Then ping every 5 minutes
  setInterval(pingServer, pingInterval);
  
  console.log('🔄 Auto-ping started (every 5 minutes)');
}

// Basic routes
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
        .container { max-width: 500px; padding: 2rem; }
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
        <p>WhatsApp Bot Deployment Platform</p>
        <p>Use our Telegram bot to get started:</p>
        <a href="https://t.me/your_bot_username" class="btn">🚀 Start Bot</a>
        
        <div class="status">
          <p><strong>Server Status:</strong> ✅ Online</p>
          <p><strong>Last Ping:</strong> <span id="pingTime">${new Date().toLocaleString()}</span></p>
          <p><small>Auto-ping active every 5 minutes</small></p>
        </div>
      </div>
      
      <script>
        // Update ping time every minute
        setInterval(() => {
          document.getElementById('pingTime').textContent = new Date().toLocaleString();
        }, 60000);
      </script>
    </body>
    </html>
  `);
});

// Health check endpoint for pinging
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Big Daddy V3', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    ping: 'active'
  });
});

// Ping endpoint specifically for keep-alive
app.get('/ping', (req, res) => {
  res.json({ 
    success: true, 
    message: 'pong', 
    timestamp: new Date().toISOString(),
    server: 'Big Daddy V3'
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.get('/dashboard', (req, res) => {
  const userId = req.query.user;
  if (!userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
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

app.get('/api/admin/users', (req, res) => {
  const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
  res.json(db.users);
});

app.get('/api/admin/settings', (req, res) => {
  const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
  res.json(db.settings);
});

app.post('/api/admin/settings', (req, res) => {
  const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
  const { max_accounts_per_ip, force_join } = req.body;
  
  if (max_accounts_per_ip) db.settings.max_accounts_per_ip = max_accounts_per_ip;
  if (force_join) db.settings.force_join = force_join;
  
  fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
  res.json({ success: true });
});

app.delete('/api/admin/user/:userId', (req, res) => {
  const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
  const { userId } = req.params;
  
  if (db.users[userId]) {
    delete db.users[userId];
    db.statistics.total_users--;
    fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// Start auto-ping when server starts
startAutoPing();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web server running on port ${PORT}`);
  console.log(`🔄 Auto-ping active for: ${WEB_DOMAIN}`);
});
