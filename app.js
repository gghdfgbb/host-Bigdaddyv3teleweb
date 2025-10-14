const express = require('express');
const path = require('path');
const fs = require('fs');
const { WEB_DOMAIN, PORT } = require('./config');
const { isIPBlocked } = require('./utils/ipTracker');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static('static'));
app.use(express.urlencoded({ extended: true }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// IP blocking middleware
app.use((req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
  const realIP = req.headers['x-forwarded-for'] || clientIP;
  
  if (isIPBlocked(realIP)) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Access Denied - Big Daddy V3</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: linear-gradient(135deg, #0f0f0f 0%, #050505 100%);
            color: white; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            height: 100vh; 
            margin: 0; 
            padding: 1rem;
          }
          .container { 
            text-align: center; 
            background: #1a1a1a; 
            padding: 3rem; 
            border-radius: 15px; 
            border: 1px solid #dc2626;
            max-width: 500px;
            width: 100%;
          }
          h1 { color: #dc2626; margin-bottom: 1rem; }
          p { margin-bottom: 0.5rem; line-height: 1.6; }
          code { background: rgba(220, 38, 38, 0.2); padding: 0.2rem 0.4rem; border-radius: 3px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚫 ACCESS DENIED</h1>
          <p>Your IP address <code>${realIP}</code> has been blocked.</p>
          <p><strong>Reason:</strong> Failed to join required channels</p>
          <p>Please contact administrator for assistance.</p>
        </div>
      </body>
      </html>
    `);
  }
  next();
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  const userId = req.query.user;
  
  if (!userId) {
    return res.redirect('/login');
  }

  try {
    const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    
    if (!db.users[userId]) {
      return res.redirect('/login');
    }
    
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
  } catch (error) {
    console.error('Dashboard access error:', error);
    res.redirect('/login');
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// API Routes
app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.json({ success: false, message: 'Email and password are required' });
    }

    const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    
    for (const [userId, user] of Object.entries(db.users)) {
      if (user.email === email && user.password === password && user.status === 'active') {
        return res.json({
          success: true,
          user_id: userId,
          user_data: user
        });
      }
    }
    
    res.json({ success: false, message: 'Invalid credentials or account disabled' });
  } catch (error) {
    console.error('Login error:', error);
    res.json({ success: false, message: 'Server error during login' });
  }
});

app.get('/api/admin/stats', (req, res) => {
  try {
    const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    res.json(db.statistics);
  } catch (error) {
    console.error('Stats error:', error);
    res.json({ 
      total_users: 0, 
      total_accounts: 0, 
      blocked_users: 0 
    });
  }
});

app.get('/api/admin/users', (req, res) => {
  try {
    const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    res.json(db.users);
  } catch (error) {
    console.error('Users error:', error);
    res.json({});
  }
});

app.get('/api/admin/settings', (req, res) => {
  try {
    const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    res.json(db.settings);
  } catch (error) {
    console.error('Settings error:', error);
    res.json({ 
      force_join: [], 
      max_accounts_per_ip: 3, 
      blocked_ips: {} 
    });
  }
});

app.post('/api/admin/settings', (req, res) => {
  try {
    const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    const { max_accounts_per_ip, force_join } = req.body;
    
    if (max_accounts_per_ip !== undefined) {
      db.settings.max_accounts_per_ip = parseInt(max_accounts_per_ip) || 3;
    }
    
    if (force_join !== undefined) {
      db.settings.force_join = force_join;
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
    const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    
    if (db.users[userId]) {
      delete db.users[userId];
      db.statistics.total_users = Math.max(0, db.statistics.total_users - 1);
      fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'User not found' });
    }
  } catch (error) {
    console.error('Delete user error:', error);
    res.json({ success: false, message: 'Failed to delete user' });
  }
});

// New API routes for blocked IPs
app.get('/api/admin/blocked-ips', (req, res) => {
  try {
    const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    res.json(db.settings.blocked_ips || {});
  } catch (error) {
    console.error('Blocked IPs error:', error);
    res.json({});
  }
});

app.post('/api/admin/unblock-ip/:ip', (req, res) => {
  try {
    const { ip } = req.params;
    const { unblockIP } = require('./utils/ipTracker');
    
    if (unblockIP(ip)) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'IP not found' });
    }
  } catch (error) {
    console.error('Unblock IP error:', error);
    res.json({ success: false, message: 'Failed to unblock IP' });
  }
});

app.get('/api/user/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
    
    if (db.users[userId]) {
      res.json(db.users[userId]);
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Big Daddy V3', 
    timestamp: new Date().toISOString() 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Page Not Found - Big Daddy V3</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          background: linear-gradient(135deg, #0f0f0f 0%, #050505 100%);
          color: white; 
          display: flex; 
          justify-content: center; 
          align-items: center; 
          height: 100vh; 
          margin: 0; 
        }
        .container { text-align: center; }
        h1 { color: #dc2626; font-size: 4rem; margin-bottom: 1rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>404</h1>
        <p>Page not found</p>
        <a href="/" style="color: #dc2626;">Return to Home</a>
      </div>
    </body>
    </html>
  `);
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server Error:', error);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error' 
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Big Daddy V3 Web Server running on port ${PORT}`);
  console.log(`🏠 Local: http://localhost:${PORT}`);
  console.log(`🌐 Domain: ${WEB_DOMAIN}`);
});
