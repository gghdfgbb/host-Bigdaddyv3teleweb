const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ==================== CRITICAL FIX: RENDER DOMAIN DETECTION ====================
const IS_RENDER = process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_URL !== undefined;
const PORT = process.env.PORT || 3000;
const MAX_MEMORY_MB = 512;

// Auto-detect Render domain
const RENDER_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

/**
 * Extract just the domain name without .render.com
 */
function getShortDomainName() {
    if (!RENDER_DOMAIN) return 'local';
    
    // Remove http:// or https://
    let domain = RENDER_DOMAIN.replace(/^https?:\/\//, '');
    
    // Remove .render.com and any other subdomains, keep only the main name
    domain = domain.replace(/\.render\.com$/, '');
    domain = domain.replace(/\.onrender\.com$/, '');
    domain = domain.split('.')[0]; // Take only the first part before any dots
    
    console.log(`🌐 Short domain name: ${domain}`);
    return domain;
}

const SHORT_DOMAIN = getShortDomainName();

console.log('🚀 Starting Big Daddy V3 Web Server...');
console.log('🌐 Domain:', RENDER_DOMAIN);
console.log('🔧 Port:', PORT);
console.log('🏷️ Short Domain:', SHORT_DOMAIN);
console.log('🚀 Render Environment:', IS_RENDER ? 'YES' : 'NO');

const app = express();

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enhanced CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    console.log(`📡 ${req.method} ${req.path} - ${new Date().toISOString()}`);
    next();
});

// ==================== STATIC FILES ====================
app.use(express.static('static'));

// ==================== FILE MANAGEMENT ====================
function ensureBasicFiles() {
    const directories = [
        'views',
        'static/css',
        'static/js',
        'static/images',
        'database',
        'backups'
    ];

    directories.forEach(dir => {
        const fullPath = path.join(__dirname, dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
    });

    // Create basic CSS
    const cssPath = path.join(__dirname, 'static/css/style.css');
    if (!fs.existsSync(cssPath)) {
        const basicCSS = `* { margin: 0; padding: 0; box-sizing: border-box; font-family: Arial, sans-serif; }
:root { --primary-red: #dc2626; --dark-bg: #0f0f0f; --card-bg: #1a1a1a; --text-light: #ffffff; }
body { background: var(--dark-bg); color: var(--text-light); }
.container { max-width: 500px; padding: 2rem; background: var(--card-bg); border-radius: 10px; border: 1px solid var(--primary-red); margin: 2rem auto; }
h1 { color: var(--primary-red); margin-bottom: 1rem; } .status { color: #10b981; font-weight: bold; }`;
        fs.writeFileSync(cssPath, basicCSS);
    }
}

// Initialize files
ensureBasicFiles();

// ==================== ROUTES ====================

// Health endpoint - MUST be first
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Big Daddy V3 Web',
        domain: RENDER_DOMAIN,
        short_domain: SHORT_DOMAIN,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
            used: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`,
            total: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)}MB`
        },
        environment: {
            is_render: IS_RENDER,
            port: PORT
        }
    });
});

app.get('/ping', (req, res) => {
    res.json({ 
        success: true, 
        message: 'pong',
        timestamp: new Date().toISOString(),
        server: 'Big Daddy V3 Web',
        domain: RENDER_DOMAIN
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
    <link rel="stylesheet" href="/css/style.css">
    <style>body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; }</style>
</head>
<body>
    <div class="container">
        <h1>🤖 Big Daddy V3</h1>
        <p>WhatsApp Bot Deployment Platform</p>
        <p class="status">✅ Server is running</p>
        <p><strong>Domain:</strong> ${RENDER_DOMAIN}</p>
        <p><strong>Port:</strong> ${PORT}</p>
        <p><strong>Short Domain:</strong> ${SHORT_DOMAIN}</p>
        <p><small>Web service is active and ready</small></p>
    </div>
</body>
</html>
    `);
});

// Admin page
app.get('/admin', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Admin - Big Daddy V3</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div class="container">
        <h1>🤖 Admin Panel</h1>
        <p><strong>Domain:</strong> ${RENDER_DOMAIN}</p>
        <p><strong>Port:</strong> ${PORT}</p>
        <p><strong>Status:</strong> ✅ Online</p>
        <p>Admin dashboard will be available here.</p>
    </div>
</body>
</html>
    `);
});

// Dashboard page
app.get('/dashboard', (req, res) => {
    const userId = req.query.user;
    if (!userId) {
        return res.redirect('/');
    }
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Dashboard - Big Daddy V3</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div class="container">
        <h1>🤖 User Dashboard</h1>
        <p><strong>User ID:</strong> ${userId}</p>
        <p><strong>Domain:</strong> ${RENDER_DOMAIN}</p>
        <p><strong>Port:</strong> ${PORT}</p>
        <p><strong>Status:</strong> ✅ Online</p>
        <p>User dashboard will be available here.</p>
    </div>
</body>
</html>
    `);
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
                        dashboard_url: `${RENDER_DOMAIN}/dashboard?user=${userId}`
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
        
        let db = { 
            users: {}, 
            settings: { force_join: [], max_accounts_per_ip: 3, blocked_ips: {} }, 
            statistics: { total_users: 0, total_accounts: 0, blocked_users: 0 } 
        };
        
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
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint not found',
        domain: RENDER_DOMAIN,
        available_endpoints: [
            'GET /',
            'GET /health',
            'GET /ping',
            'GET /admin', 
            'GET /dashboard',
            'POST /api/login',
            'GET /api/admin/stats',
            'GET /api/admin/users',
            'GET /api/admin/settings',
            'POST /api/admin/settings',
            'DELETE /api/admin/user/:userId'
        ]
    });
});

// Error handler
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ 
        success: false,
        error: 'Internal server error',
        message: error.message
    });
});

// ==================== SERVER INITIALIZATION ====================
let server;

async function initializeServer() {
    try {
        console.log('🚀 Initializing Big Daddy V3 Web Server...');
        
        // Start the server - EXACT Big Daddy pattern
        server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Express server running on port ${PORT}`);
            console.log(`🌐 Access your server at: ${RENDER_DOMAIN}`);
            console.log('📋 Available endpoints:');
            console.log(`   • GET  ${RENDER_DOMAIN}/ - Main page`);
            console.log(`   • GET  ${RENDER_DOMAIN}/health - Health check`);
            console.log(`   • GET  ${RENDER_DOMAIN}/ping - Ping endpoint`);
            console.log(`   • GET  ${RENDER_DOMAIN}/admin - Admin panel`);
            console.log(`   • GET  ${RENDER_DOMAIN}/dashboard - User dashboard`);
            console.log(`   • POST ${RENDER_DOMAIN}/api/login - User login`);
            console.log(`   • GET  ${RENDER_DOMAIN}/api/admin/stats - Admin statistics`);
            console.log(`   • GET  ${RENDER_DOMAIN}/api/admin/users - User list`);
            console.log(`   • GET  ${RENDER_DOMAIN}/api/admin/settings - Settings`);
            console.log(`   • POST ${RENDER_DOMAIN}/api/admin/settings - Update settings`);
            console.log(`   • DELETE ${RENDER_DOMAIN}/api/admin/user/:id - Delete user`);
        });

    } catch (error) {
        console.error('❌ Server initialization failed:', error);
        process.exit(1);
    }
}

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

process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down gracefully');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

// Test the server immediately
server.on('listening', () => {
    console.log('📡 Server is now listening for incoming connections');
    console.log('✅ Port binding successful - Render should detect open ports');
});

// Initialize the server
initializeServer().catch(err => {
    console.error('❌ Server startup failed:', err);
    process.exit(1);
});

module.exports = app;
