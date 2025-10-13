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

// IP blocking middleware
app.use((req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  
  if (isIPBlocked(clientIP)) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Access Denied - Big Daddy V3</title>
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
          .container { 
            text-align: center; 
            background: #1a1a1a; 
            padding: 3rem; 
            border-radius: 15px; 
            border: 1px solid #dc2626; 
          }
          h1 { color: #dc2626; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚫 ACCESS DENIED</h1>
          <p>Your IP address <strong>${clientIP}</strong> has been blocked.</p>
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
  const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
  
  if (!userId || !db.users[userId]) {
    return res.redirect('/login');
  }
  
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// API Routes
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const db = JSON.parse(fs.readFileSync('database.json', 'utf8'));
  
  for (const [userId, user] of Object.entries(db.users)) {
    if (user.email === email && user.password === password) {
      return res.json({
        success: true,
        user_id: userId,
        user_data: user
      });
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
  
  if (max_accounts_per_ip) {
    db.settings.max_accounts_per_ip = max_accounts_per_ip;
  }
  
  if (force_join) {
    db.settings.force_join = force_join;
  }
  
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

app.listen(PORT, () => {
  console.log(`🌐 Big Daddy V3 Web Server running on port ${PORT}`);
});
