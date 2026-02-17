const fs = require('fs');
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ==================== FAKE FCA-MAFIYA (Fallback) ====================
// Yeh temporary hai jab tak real install nahi hota
let wiegine = {
    login: (cookie, options, callback) => {
        console.log('🔧 Using fallback mode - Install fca-mafiya for real Facebook');
        console.log('📝 Cookie length:', cookie.length);
        
        // Validate cookie
        if (!cookie.includes('c_user=') || !cookie.includes('xs=')) {
            callback(new Error('Invalid cookie. Must contain c_user and xs'), null);
            return;
        }
        
        setTimeout(() => {
            // Extract user ID from cookie
            const cUserMatch = cookie.match(/c_user=(\d+)/);
            const userId = cUserMatch ? cUserMatch[1] : '100000000000000';
            
            const mockApi = {
                sendMessage: (message, threadID, cb) => {
                    console.log(`📤 [FALLBACK] Would send to ${threadID}: ${message.substring(0, 50)}...`);
                    // Simulate success
                    setTimeout(() => cb(null), 1000);
                },
                getThreadInfo: (threadID, cb) => {
                    setTimeout(() => cb(null, { 
                        name: `Group ${threadID}`,
                        participantIDs: []
                    }), 500);
                },
                getUserInfo: (userID, cb) => {
                    setTimeout(() => cb(null, { 
                        [userID]: { name: 'Test User' }
                    }), 500);
                },
                getCurrentUserID: (cb) => {
                    setTimeout(() => cb(null, userId), 500);
                },
                logout: (cb) => {
                    if (cb) setTimeout(() => cb(null), 500);
                }
            };
            
            callback(null, mockApi);
        }, 1000);
    }
};

// Try to load real fca-mafiya
try {
    const realWiegine = require('fca-mafiya');
    wiegine = realWiegine;
    console.log('✅ fca-mafiya loaded - REAL MODE');
} catch (e) {
    console.log('⚠️ fca-mafiya not found - FALLBACK MODE');
    console.log('📦 Run: npm install fca-mafiya@latest');
}

// ==================== EXPRESS SETUP ====================
const app = express();
const PORT = process.env.PORT || 21615;

// Create necessary directories
const COOKIES_DIR = 'cookies';
const LOGS_DIR = 'logs';
if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// ==================== TASK MANAGER ====================
class TaskManager {
    constructor() {
        this.tasks = new Map();
        this.loadTasks();
    }
    
    loadTasks() {
        try {
            if (fs.existsSync('tasks.json')) {
                const data = fs.readFileSync('tasks.json', 'utf8');
                const saved = JSON.parse(data);
                
                for (const [id, taskData] of Object.entries(saved)) {
                    const task = new Task(
                        id,
                        taskData.config,
                        taskData.stats,
                        taskData.messages,
                        taskData.currentIndex
                    );
                    this.tasks.set(id, task);
                    
                    // Auto-restart if was running
                    if (taskData.status === 'running') {
                        setTimeout(() => task.start(), 5000);
                    }
                }
                console.log(`✅ Loaded ${this.tasks.size} saved tasks`);
            }
        } catch (e) {
            console.log('⚠️ No saved tasks found');
        }
    }
    
    saveTasks() {
        try {
            const data = {};
            for (const [id, task] of this.tasks.entries()) {
                data[id] = task.toJSON();
            }
            fs.writeFileSync('tasks.json', JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('Error saving tasks:', e);
        }
    }
    
    createTask(config) {
        const id = uuidv4();
        const task = new Task(id, config);
        this.tasks.set(id, task);
        this.saveTasks();
        return { id, task };
    }
    
    getTask(id) {
        return this.tasks.get(id);
    }
    
    stopTask(id) {
        const task = this.tasks.get(id);
        if (task) {
            task.stop();
            this.saveTasks();
            return true;
        }
        return false;
    }
    
    deleteTask(id) {
        const deleted = this.tasks.delete(id);
        if (deleted) this.saveTasks();
        return deleted;
    }
    
    getAllTasks() {
        const result = [];
        for (const [id, task] of this.tasks.entries()) {
            result.push(task.getInfo());
        }
        return result;
    }
}

class Task {
    constructor(id, config, savedStats = null, savedMessages = null, savedIndex = 0) {
        this.id = id;
        this.config = config;
        this.status = 'stopped'; // stopped, running, paused
        this.api = null;
        
        // Stats
        this.stats = savedStats || {
            sent: 0,
            failed: 0,
            loops: 0,
            startTime: Date.now(),
            lastSent: null
        };
        
        // Messages
        if (savedMessages) {
            this.messages = savedMessages;
            this.currentIndex = savedIndex;
        } else {
            this.messages = this.formatMessages(
                config.messageContent,
                config.hatersName,
                config.lastHereName
            );
            this.currentIndex = 0;
        }
        
        console.log(`📝 Task ${id}: ${this.messages.length} messages loaded`);
    }
    
    formatMessages(content, prefix, suffix) {
        if (!content || !prefix || !suffix) {
            return ['Test message 1', 'Test message 2'];
        }
        
        return content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(msg => `${prefix} ${msg} ${suffix}`);
    }
    
    async start() {
        if (this.status === 'running') {
            return { success: false, error: 'Already running' };
        }
        
        // Validate cookie
        const cookie = this.config.cookieContent;
        if (!cookie || !cookie.includes('c_user=') || !cookie.includes('xs=')) {
            return { success: false, error: 'Invalid cookie format' };
        }
        
        // Save cookie to file
        try {
            fs.writeFileSync(
                path.join(COOKIES_DIR, `cookie_${this.id}.txt`),
                cookie
            );
        } catch (e) {
            console.error('Error saving cookie:', e);
        }
        
        this.status = 'running';
        this.stats.startTime = Date.now();
        
        // Login to Facebook
        try {
            await this.login();
            this.startMessageLoop();
            return { success: true, message: 'Task started' };
        } catch (error) {
            this.status = 'stopped';
            return { success: false, error: error.message };
        }
    }
    
    login() {
        return new Promise((resolve, reject) => {
            const options = {
                logLevel: 'silent',
                forceLogin: true,
                selfListen: false
            };
            
            wiegine.login(this.config.cookieContent, options, (err, api) => {
                if (err) {
                    reject(new Error(`Login failed: ${err.message}`));
                } else {
                    this.api = api;
                    
                    // Get user info
                    api.getCurrentUserID((err, id) => {
                        if (!err && id) {
                            console.log(`✅ Task ${this.id}: Logged in as ${id}`);
                        }
                    });
                    
                    resolve(api);
                }
            });
        });
    }
    
    startMessageLoop() {
        if (this.status !== 'running' || !this.api) return;
        
        const sendNext = () => {
            if (this.status !== 'running') return;
            
            // Check if end of messages
            if (this.currentIndex >= this.messages.length) {
                this.currentIndex = 0;
                this.stats.loops++;
                console.log(`🔄 Task ${this.id}: Loop ${this.stats.loops}`);
            }
            
            const message = this.messages[this.currentIndex];
            const threadID = this.config.threadID;
            
            this.sendMessage(message, threadID)
                .then(() => {
                    this.stats.sent++;
                    this.stats.lastSent = Date.now();
                    this.currentIndex++;
                    
                    // Schedule next message
                    const delay = (this.config.delay || 5) * 1000;
                    setTimeout(sendNext, delay);
                })
                .catch(error => {
                    this.stats.failed++;
                    console.log(`❌ Task ${this.id}: ${error.message}`);
                    
                    // Retry after 3 seconds
                    setTimeout(sendNext, 3000);
                });
        };
        
        // Start the loop
        sendNext();
    }
    
    sendMessage(message, threadID) {
        return new Promise((resolve, reject) => {
            if (!this.api) {
                reject(new Error('Not logged in'));
                return;
            }
            
            this.api.sendMessage(message, threadID, (err) => {
                if (err) {
                    reject(err);
                } else {
                    const time = new Date().toLocaleTimeString();
                    console.log(`✅ Task ${this.id}: Sent at ${time}`);
                    resolve();
                }
            });
        });
    }
    
    stop() {
        this.status = 'stopped';
        if (this.api && this.api.logout) {
            this.api.logout();
        }
        console.log(`🛑 Task ${this.id}: Stopped`);
    }
    
    pause() {
        if (this.status === 'running') {
            this.status = 'paused';
            return true;
        }
        return false;
    }
    
    resume() {
        if (this.status === 'paused') {
            this.status = 'running';
            this.startMessageLoop();
            return true;
        }
        return false;
    }
    
    getInfo() {
        const uptime = Date.now() - this.stats.startTime;
        const hours = Math.floor(uptime / 3600000);
        const minutes = Math.floor((uptime % 3600000) / 60000);
        
        return {
            id: this.id,
            status: this.status,
            stats: this.stats,
            progress: {
                current: this.currentIndex + 1,
                total: this.messages.length,
                loop: this.stats.loops + 1
            },
            config: {
                threadID: this.config.threadID,
                delay: this.config.delay || 5,
                hatersName: this.config.hatersName,
                lastHereName: this.config.lastHereName
            },
            uptime: `${hours}h ${minutes}m`,
            messagesCount: this.messages.length
        };
    }
    
    toJSON() {
        return {
            config: this.config,
            stats: this.stats,
            messages: this.messages,
            currentIndex: this.currentIndex,
            status: this.status
        };
    }
}

// Initialize task manager
const taskManager = new TaskManager();

// Auto-save every 30 seconds
setInterval(() => taskManager.saveTasks(), 30000);

// ==================== API ROUTES ====================
app.post('/api/task', (req, res) => {
    try {
        const { 
            cookieContent, 
            messageContent, 
            hatersName, 
            lastHereName, 
            threadID, 
            delay 
        } = req.body;
        
        if (!cookieContent || !messageContent || !threadID) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields' 
            });
        }
        
        const config = {
            cookieContent,
            messageContent,
            hatersName: hatersName || '',
            lastHereName: lastHereName || '',
            threadID,
            delay: parseInt(delay) || 5
        };
        
        const { id, task } = taskManager.createTask(config);
        const result = task.start();
        
        if (result.success) {
            res.json({ 
                success: true, 
                taskId: id,
                message: 'Task started successfully' 
            });
        } else {
            taskManager.deleteTask(id);
            res.status(400).json(result);
        }
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Server error: ' + error.message 
        });
    }
});

app.get('/api/tasks', (req, res) => {
    res.json({
        success: true,
        tasks: taskManager.getAllTasks(),
        count: taskManager.tasks.size
    });
});

app.post('/api/task/:id/stop', (req, res) => {
    const success = taskManager.stopTask(req.params.id);
    res.json({ 
        success, 
        message: success ? 'Task stopped' : 'Task not found' 
    });
});

app.post('/api/task/:id/pause', (req, res) => {
    const task = taskManager.getTask(req.params.id);
    if (task) {
        const success = task.pause();
        res.json({ 
            success, 
            message: success ? 'Task paused' : 'Task not running' 
        });
    } else {
        res.json({ success: false, message: 'Task not found' });
    }
});

app.post('/api/task/:id/resume', (req, res) => {
    const task = taskManager.getTask(req.params.id);
    if (task) {
        const success = task.resume();
        res.json({ 
            success, 
            message: success ? 'Task resumed' : 'Task not paused' 
        });
    } else {
        res.json({ success: false, message: 'Task not found' });
    }
});

app.delete('/api/task/:id', (req, res) => {
    const success = taskManager.deleteTask(req.params.id);
    res.json({ 
        success, 
        message: success ? 'Task deleted' : 'Task not found' 
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        version: '1.0.0',
        uptime: process.uptime(),
        tasks: taskManager.tasks.size,
        timestamp: new Date().toISOString()
    });
});

// ==================== HTML INTERFACE ====================
const HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rk raja xwd Cookie Server</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #0f182a;
            color: #f6fafc;
            font-family: 'Segoe UI', system-ui, sans-serif;
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        .header {
            background: linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%);
            padding: 30px;
            border-radius: 16px;
            margin-bottom: 30px;
            text-align: center;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
        }
        .header h1 {
            font-size: 3.5rem;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
        }
        .status-badge {
            display: inline-block;
            padding: 8px 20px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 25px;
            margin: 5px;
            font-size: 0.9rem;
        }
        .card {
            background: rgba(30, 41, 59, 0.8);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            padding: 25px;
            margin-bottom: 25px;
        }
        .card h2 {
            color: #60a5fa;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid rgba(96, 165, 250, 0.3);
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            color: #cbd5e1;
            font-weight: 500;
        }
        input, textarea, select {
            width: 100%;
            padding: 12px 16px;
            background: rgba(15, 23, 42, 0.8);
            border: 1px solid #475569;
            border-radius: 10px;
            color: #f8fafc;
            font-size: 15px;
            transition: all 0.3s;
        }
        input:focus, textarea:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
        }
        textarea {
            min-height: 120px;
            resize: vertical;
            font-family: 'Consolas', monospace;
        }
        .btn {
            padding: 14px 28px;
            border: none;
            border-radius: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            font-size: 15px;
        }
        .btn-primary {
            background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
            color: white;
        }
        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(59, 130, 246, 0.4);
        }
        .btn-danger {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            color: white;
        }
        .btn-success {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: white;
        }
        .btn-warning {
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            color: white;
        }
        .mode-selector {
            display: flex;
            gap: 12px;
            margin-bottom: 20px;
        }
        .mode-btn {
            flex: 1;
            padding: 18px;
            text-align: center;
            background: rgba(255, 255, 255, 0.05);
            border: 2px solid transparent;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.3s;
        }
        .mode-btn.active {
            border-color: #3b82f6;
            background: rgba(59, 130, 246, 0.1);
        }
        .file-input-container {
            position: relative;
            margin-bottom: 20px;
        }
        .file-input-container input[type="file"] {
            position: absolute;
            opacity: 0;
            width: 100%;
            height: 100%;
            cursor: pointer;
        }
        .file-input-label {
            display: block;
            padding: 30px;
            background: rgba(255, 255, 255, 0.03);
            border: 2px dashed #475569;
            border-radius: 12px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s;
        }
        .file-input-label:hover {
            border-color: #3b82f6;
            background: rgba(59, 130, 246, 0.05);
        }
        .task-list {
            display: grid;
            gap: 15px;
            margin-top: 20px;
        }
        .task-item {
            background: rgba(15, 23, 42, 0.8);
            border: 1px solid #334155;
            border-radius: 12px;
            padding: 20px;
            transition: all 0.3s;
        }
        .task-item:hover {
            border-color: #3b82f6;
            transform: translateY(-2px);
        }
        .task-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .task-id {
            font-family: 'Courier New', monospace;
            color: #60a5fa;
            background: rgba(96, 165, 250, 0.1);
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 14px;
        }
        .task-status {
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: bold;
        }
        .status-running { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
        .status-stopped { background: rgba(239, 68, 68, 0.2); color: #f87171; }
        .status-paused { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
        .task-stats {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
            margin: 15px 0;
        }
        .stat-item {
            background: rgba(255, 255, 255, 0.05);
            padding: 12px;
            border-radius: 10px;
            text-align: center;
        }
        .stat-value {
            font-size: 1.4rem;
            font-weight: bold;
            color: #60a5fa;
        }
        .control-buttons {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        .control-buttons .btn {
            flex: 1;
        }
        .alert {
            padding: 16px;
            border-radius: 12px;
            margin: 20px 0;
            display: none;
            animation: slideIn 0.3s ease;
        }
        @keyframes slideIn {
            from { transform: translateY(-10px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
        .alert-success {
            background: rgba(34, 197, 94, 0.1);
            border: 1px solid #4ade80;
            color: #4ade80;
        }
        .alert-error {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid #f87171;
            color: #f87171;
        }
        .log-container {
            background: rgba(0, 0, 0, 0.4);
            border-radius: 12px;
            padding: 20px;
            height: 300px;
            overflow-y: auto;
            font-family: 'Courier New', monospace;
            font-size: 13px;
            margin-top: 20px;
        }
        .log-entry {
            padding: 10px;
            margin-bottom: 8px;
            border-left: 4px solid;
            border-radius: 6px;
            background: rgba(255, 255, 255, 0.03);
        }
        .log-info { border-color: #3b82f6; }
        .log-success { border-color: #10b981; }
        .log-warning { border-color: #f59e0b; }
        .log-error { border-color: #ef4444; }
        .log-time {
            color: #94a3b8;
            margin-right: 10px;
        }
        .progress-bar {
            height: 8px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
            margin: 10px 0;
            overflow: hidden;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #3b82f6, #8b5cf6);
            border-radius: 4px;
            transition: width 0.3s ease;
        }
    </style>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fas fa-robot"></i> RK RAJA XWD COOKIE SERVER <i class="fas fa-server"></i></h1>
            <p>Professional Facebook Messenger Bot with Auto Recovery</p>
            <div>
                <span class="status-badge"><i class="fas fa-shield-alt"></i> Auto-Recovery</span>
                <span class="status-badge"><i class="fas fa-bolt"></i> High Performance</span>
                <span class="status-badge"><i class="fas fa-database"></i> Persistent Tasks</span>
            </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 25px;">
            <!-- Left Column -->
            <div>
                <div class="card">
                    <h2><i class="fas fa-cookie-bite"></i> Cookie Input</h2>
                    <div class="mode-selector">
                        <div class="mode-btn active" onclick="setMode('paste')">
                            <i class="fas fa-paste"></i> Paste Cookie
                        </div>
                        <div class="mode-btn" onclick="setMode('upload')">
                            <i class="fas fa-upload"></i> Upload File
                        </div>
                    </div>
                    
                    <div id="pasteSection">
                        <div class="form-group">
                            <label><i class="fas fa-key"></i> Cookie Content</label>
                            <textarea id="cookieContent" placeholder="Paste Facebook cookie here (must contain c_user= and xs=)" rows="6"></textarea>
                        </div>
                    </div>
                    
                    <div id="uploadSection" style="display: none;">
                        <div class="form-group">
                            <label><i class="fas fa-file-upload"></i> Cookie File</label>
                            <div class="file-input-container">
                                <input type="file" id="cookieFile" accept=".txt">
                                <div class="file-input-label">
                                    <i class="fas fa-cloud-upload-alt fa-2x"></i>
                                    <div style="margin-top: 10px;">Upload Cookie File</div>
                                    <small>.txt files only</small>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label><i class="fas fa-file-alt"></i> Message File</label>
                        <div class="file-input-container">
                            <input type="file" id="messageFile" accept=".txt">
                            <div class="file-input-label">
                                <i class="fas fa-file-alt fa-2x"></i>
                                <div style="margin-top: 10px;">Upload Message File</div>
                                <small>One message per line</small>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="card">
                    <h2><i class="fas fa-cogs"></i> Configuration</h2>
                    <div class="form-group">
                        <label><i class="fas fa-user-tag"></i> Hater's Name</label>
                        <input type="text" id="hatersName" placeholder="Enter name to prefix messages">
                    </div>
                    <div class="form-group">
                        <label><i class="fas fa-user-clock"></i> Last Here Name</label>
                        <input type="text" id="lastHereName" placeholder="Enter name to suffix messages">
                    </div>
                    <div class="form-group">
                        <label><i class="fas fa-hashtag"></i> Thread/Group ID</label>
                        <input type="text" id="threadID" placeholder="Facebook Thread ID">
                    </div>
                    <div class="form-group">
                        <label><i class="fas fa-clock"></i> Delay (seconds)</label>
                        <input type="number" id="delay" value="5" min="1" max="60">
                    </div>
                    
                    <button class="btn btn-primary" onclick="startTask()" style="width: 100%; margin-top: 20px;">
                        <i class="fas fa-play"></i> Start Bot Task
                    </button>
                </div>
            </div>

            <!-- Right Column -->
            <div>
                <div class="card">
                    <h2><i class="fas fa-tasks"></i> Active Tasks (<span id="taskCount">0</span>)</h2>
                    <div id="taskList" class="task-list">
                        <div style="text-align: center; padding: 40px; color: #94a3b8;">
                            <i class="fas fa-robot fa-3x"></i>
                            <p style="margin-top: 20px;">No active tasks</p>
                        </div>
                    </div>
                </div>

                <div class="card">
                    <h2><i class="fas fa-terminal"></i> System Logs</h2>
                    <div id="logContainer" class="log-container">
                        <div class="log-entry log-info">
                            <span class="log-time">00:00:00</span>
                            <span>System initialized. Ready to start tasks.</span>
                        </div>
                    </div>
                    <div class="control-buttons">
                        <button class="btn" onclick="clearLogs()" style="background: #475569;">
                            <i class="fas fa-broom"></i> Clear Logs
                        </button>
                        <button class="btn btn-success" onclick="refreshTasks()">
                            <i class="fas fa-sync-alt"></i> Refresh
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Alerts -->
    <div id="alertSuccess" class="alert alert-success"></div>
    <div id="alertError" class="alert alert-error"></div>

    <script>
        let currentMode = 'paste';
        
        function setMode(mode) {
            currentMode = mode;
            document.querySelectorAll('.mode-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            event.target.classList.add('active');
            
            document.getElementById('pasteSection').style.display = mode === 'paste' ? 'block' : 'none';
            document.getElementById('uploadSection').style.display = mode === 'upload' ? 'block' : 'none';
        }
        
        async function readFile(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.onerror = reject;
                reader.readAsText(file);
            });
        }
        
        async function startTask() {
            let cookieContent = '';
            
            if (currentMode === 'paste') {
                cookieContent = document.getElementById('cookieContent').value.trim();
                if (!cookieContent) {
                    showAlert('Please paste cookie content', 'error');
                    return;
                }
            } else {
                const file = document.getElementById('cookieFile').files[0];
                if (!file) {
                    showAlert('Please select cookie file', 'error');
                    return;
                }
                cookieContent = await readFile(file);
            }
            
            // Validate cookie
            if (!cookieContent.includes('c_user=') || !cookieContent.includes('xs=')) {
                showAlert('Invalid cookie. Must contain c_user and xs parameters', 'error');
                return;
            }
            
            const messageFile = document.getElementById('messageFile').files[0];
            if (!messageFile) {
                showAlert('Please select message file', 'error');
                return;
            }
            
            const messageContent = await readFile(messageFile);
            const hatersName = document.getElementById('hatersName').value.trim();
            const lastHereName = document.getElementById('lastHereName').value.trim();
            const threadID = document.getElementById('threadID').value.trim();
            const delay = document.getElementById('delay').value;
            
            if (!hatersName || !lastHereName || !threadID) {
                showAlert('Please fill all configuration fields', 'error');
                return;
            }
            
            showAlert('Starting task...', 'info');
            
            const response = await fetch('/api/task', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cookieContent,
                    messageContent,
                    hatersName,
                    lastHereName,
                    threadID,
                    delay: parseInt(delay) || 5
                })
            });
            
            const result = await response.json();
            
            if (result.success) {
                showAlert('Task started successfully!', 'success');
                addLog(`Task ${result.taskId.substring(0, 8)}... started`, 'success');
                refreshTasks();
            } else {
                showAlert('Error: ' + result.error, 'error');
            }
        }
        
        async function refreshTasks() {
            const response = await fetch('/api/tasks');
            const result = await response.json();
            
            document.getElementById('taskCount').textContent = result.count;
            const taskList = document.getElementById('taskList');
            
            if (result.tasks.length === 0) {
                taskList.innerHTML = \`
                    <div style="text-align: center; padding: 40px; color: #94a3b8;">
                        <i class="fas fa-robot fa-3x"></i>
                        <p style="margin-top: 20px;">No active tasks</p>
                    </div>
                \`;
                return;
            }
            
            taskList.innerHTML = result.tasks.map(task => {
                const progressPercent = (task.progress.current / task.progress.total) * 100;
                const statusClass = \`status-\${task.status}\`;
                
                return \`
                    <div class="task-item">
                        <div class="task-header">
                            <div class="task-id">\${task.id.substring(0, 8)}...</div>
                            <div class="task-status \${statusClass}">\${task.status.toUpperCase()}</div>
                        </div>
                        
                        <div style="color: #cbd5e1; font-size: 14px; margin-bottom: 10px;">
                            <i class="fas fa-hashtag"></i> \${task.config.threadID} | 
                            <i class="fas fa-clock"></i> \${task.config.delay}s
                        </div>
                        
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: \${progressPercent}%"></div>
                        </div>
                        <div style="font-size: 12px; color: #94a3b8; text-align: center;">
                            \${task.progress.current} / \${task.progress.total} (Loop \${task.progress.loop})
                        </div>
                        
                        <div class="task-stats">
                            <div class="stat-item">
                                <div class="stat-value">\${task.stats.sent}</div>
                                <div>Sent</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-value">\${task.stats.failed}</div>
                                <div>Failed</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-value">\${task.stats.loops}</div>
                                <div>Loops</div>
                            </div>
                        </div>
                        
                        <div class="control-buttons">
                            \${task.status === 'running' ? 
                                \`<button class="btn btn-warning" onclick="controlTask('\${task.id}', 'pause')">
                                    <i class="fas fa-pause"></i> Pause
                                </button>\` : 
                                \`<button class="btn btn-success" onclick="controlTask('\${task.id}', 'resume')">
                                    <i class="fas fa-play"></i> Resume
                                </button>\`
                            }
                            <button class="btn btn-danger" onclick="controlTask('\${task.id}', 'stop')">
                                <i class="fas fa-stop"></i> Stop
                            </button>
                        </div>
                    </div>
                \`;
            }).join('');
        }
        
        async function controlTask(taskId, action) {
            const response = await fetch(\`/api/task/\${taskId}/\${action}\`, {
                method: 'POST'
            });
            
            const result = await response.json();
            showAlert(result.message, result.success ? 'success' : 'error');
            
            if (result.success) {
                addLog(\`Task \${taskId.substring(0, 8)}... \${action}ed\`, 'info');
                refreshTasks();
            }
        }
        
        function addLog(message, type = 'info') {
            const container = document.getElementById('logContainer');
            const time = new Date().toLocaleTimeString();
            
            const logEntry = document.createElement('div');
            logEntry.className = \`log-entry log-\${type}\`;
            logEntry.innerHTML = \`
                <span class="log-time">\${time}</span>
                <span>\${message}</span>
            \`;
            
            container.insertBefore(logEntry, container.firstChild);
            
            if (container.children.length > 50) {
                container.removeChild(container.lastChild);
            }
        }
        
        function clearLogs() {
            document.getElementById('logContainer').innerHTML = \`
                <div class="log-entry log-info">
                    <span class="log-time">\${new Date().toLocaleTimeString()}</span>
                    <span>Logs cleared</span>
                </div>
            \`;
        }
        
        function showAlert(message, type) {
            const alertDiv = document.getElementById(\`alert\${type.charAt(0).toUpperCase() + type.slice(1)}\`);
            alertDiv.textContent = message;
            alertDiv.style.display = 'block';
            
            setTimeout(() => {
                alertDiv.style.display = 'none';
            }, 5000);
        }
        
        // Auto-refresh tasks every 5 seconds
        setInterval(refreshTasks, 5000);
        
        // Initial load
        refreshTasks();
        addLog('SK Cookie Server loaded successfully', 'success');
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'r') {
                e.preventDefault();
                refreshTasks();
            }
        });
    </script>
</body>
</html>
`;

app.get('/', (req, res) => {
    res.send(HTML);
});

// ==================== START SERVER ====================
const server = app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║           RK RAJA XWD COOKIE SERVER v1.0.0               ║
╠══════════════════════════════════════════════════╣
║ PORT: ${PORT}                                    ║
║ URL: http://localhost:${PORT}                    ║
╠══════════════════════════════════════════════════╣
║ ✅ Server started successfully                  ║
║ ✅ HTML Interface ready                        ║
║ ✅ Task Manager initialized                    ║
║ ✅ Auto-save enabled                           ║
╠══════════════════════════════════════════════════╣
║ 📦 To enable REAL Facebook mode:               ║
║ npm install fca-mafiya@latest                   ║
╚══════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    taskManager.saveTasks();
    console.log('✅ Tasks saved. Goodbye!');
    process.exit(0);
});
