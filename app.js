const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const app = express();

// Get the real domain
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

console.log('🚀 Starting Web Server...');
console.log('🌐 Domain:', WEB_DOMAIN);
console.log('🔧 Port:', PORT);

// Middleware
app.use(express.json());
app.use(express.static('static'));

// Create basic HTML files if they don't exist
function ensureBasicFiles() {
  const viewsDir = path.join(__dirname, 'views');
  if (!fs.existsSync(viewsDir)) {
    fs.mkdirSync(viewsDir, { recursive: true });
  }

  // Create basic admin.html if it doesn't exist
  if (!fs.existsSync(path.join(viewsDir, 'admin.html'))) {
    fs.writeFileSync(path.join(viewsDir, 'admin.html'), `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Admin - Big Daddy V3</title>
        <style>
          body { font-family: Arial; background: #0f0f0f; color: white; padding: 2rem; }
          h1 { color: #dc2626; }
        </style>
      </head>
      <body>
        <h1>🤖 Big Daddy V3 - Admin Panel</h1>
        <p>Admin dashboard will be available here.</p>
        <p><strong>Domain:</strong> ${WEB_DOMAIN}</p>
      </body>
      </html>
    `);
  }

  // Create basic dashboard.html if it doesn't exist
  if (!fs.existsSync(path.join(viewsDir, 'dashboard.html'))) {
    fs.writeFileSync(path.join(viewsDir, 'dashboard.html'), `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Dashboard - Big Daddy V3</title>
        <style>
          body { font-family: Arial; background: #0f0f0f; color: white; padding: 2rem; }
          h1 { color: #dc2626; }
        </style>
      </head>
      <body>
        <h1>🤖 Big Daddy V3 - User Dashboard</h1>
        <p>User dashboard will be available here.</p>
        <p><strong>Domain:</strong> ${WEB_DOMAIN}</p>
      </body>
      </html>
    `);
  }
}

// Ensure basic files exist
ensureBasicFiles();

// Health endpoint - MUST be first
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Big Daddy V3 Web',
    domain: WEB_DOMAIN,
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

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Big Daddy V3</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
            .status { color: #10b981; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 Big Daddy V3</h1>
            <p>WhatsApp Bot Deployment Platform</p>
            <p class="status">✅ Server is running</p>
            <p><strong>Domain:</strong> ${WEB_DOMAIN}</p>
            <p><small>Web service is active and ready</small></p>
        </div>
    </body>
    </html>
  `);
});

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// Dashboard page
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// API Routes (simplified)
app.post('/api/login', (req, res) => {
  res.json({ success: false, message: 'API endpoint ready' });
});

app.get('/api/admin/stats', (req, res) => {
  res.json({ total_users: 0, total_accounts: 0, blocked_users: 0 });
});

app.get('/api/admin/users', (req, res) => {
  res.json({});
});

app.get('/api/admin/settings', (req, res) => {
  res.json({ force_join: [], max_accounts_per_ip: 3, blocked_ips: {} });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Web server running on port ${PORT}`);
  console.log(`🌐 Access at: ${WEB_DOMAIN}`);
  console.log(`🔧 Health: ${WEB_DOMAIN}/health`);
});
