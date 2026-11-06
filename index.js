const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pino = require('pino');
const chalk = require('chalk');

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ================= NO-REPLY MONITOR (FUTURE NOTIFICATION) =================
// After an outgoing message, wait for a reply from the same target. If no
// incoming reply arrives before the timeout, notify the owner (when the
// WhatsApp notification credentials are configured).
const NO_REPLY_TIMEOUT_MINUTES = Math.max(
  1,
  parseInt(process.env.NO_REPLY_TIMEOUT_MINUTES || '30', 10) || 30
);
const NO_REPLY_TIMEOUT_MS = NO_REPLY_TIMEOUT_MINUTES * 60 * 1000;

function clearNoReplyTimer(sessionId, jid) {
  const s = SESSIONS[sessionId];
  if (!s?.noReplyTimers) return false;
  const timer = s.noReplyTimers[jid];
  if (!timer) return false;
  clearTimeout(timer.timeout);
  delete s.noReplyTimers[jid];
  return true;
}

function scheduleNoReplyCheck(sessionId, jid, targetLabel) {
  const s = SESSIONS[sessionId];
  if (!s || !jid) return;
  if (!s.noReplyTimers) s.noReplyTimers = Object.create(null);

  clearNoReplyTimer(sessionId, jid);

  const startedAt = Date.now();
  const timeout = setTimeout(async () => {
    const current = SESSIONS[sessionId];
    if (!current || current.stopped || current.deleting) return;
    const pending = current.noReplyTimers?.[jid];
    if (!pending || pending.startedAt !== startedAt) return;

    delete current.noReplyTimers[jid];
    appendSessionLog(
      sessionId,
      `No reply from ${targetLabel || jid} for ${NO_REPLY_TIMEOUT_MINUTES} minute(s)`
    );

    try {
      await notifyOwnerWhatsApp(
        current.username || 'Unknown user',
        `no reply from ${targetLabel || jid} for ${NO_REPLY_TIMEOUT_MINUTES} minute(s) in session ${sessionId}`
      );
    } catch (e) {
      appendSessionLog(sessionId, 'No-reply owner notification failed: ' + (e?.message || e));
    }
  }, NO_REPLY_TIMEOUT_MS);

  s.noReplyTimers[jid] = { timeout, startedAt, targetLabel };
}

function clearAllNoReplyTimers(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s?.noReplyTimers) return;
  Object.keys(s.noReplyTimers).forEach(jid => clearNoReplyTimer(sessionId, jid));
}

const PORT = process.env.PORT || 30172;

// ================= OWNER WHATSAPP SERVER-USE NOTIFICATIONS =================
// Configure these as server environment variables; never put the token in HTML.
// WA_NOTIFY_TOKEN       = Meta/WhatsApp Cloud API access token
// WA_PHONE_NUMBER_ID    = WhatsApp Cloud API phone-number ID that sends the alert
// WA_OWNER_NUMBER       = owner's WhatsApp number in international format, digits only
// WA_NOTIFY_TEMPLATE    = approved WhatsApp template name, e.g. server_user_alert
// WA_NOTIFY_LANGUAGE    = approved template language, e.g. en_US
const WA_NOTIFY_TOKEN = process.env.WA_NOTIFY_TOKEN || '';
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || '';
const WA_OWNER_NUMBER = process.env.WA_OWNER_NUMBER || '';
const WA_NOTIFY_TEMPLATE = process.env.WA_NOTIFY_TEMPLATE || 'server_user_alert';
const WA_NOTIFY_LANGUAGE = process.env.WA_NOTIFY_LANGUAGE || 'en_US';
const WA_GRAPH_VERSION = process.env.WA_GRAPH_VERSION || 'v23.0';

function whatsappOwnerNotificationsConfigured() {
  return Boolean(
    WA_NOTIFY_TOKEN &&
    WA_PHONE_NUMBER_ID &&
    WA_OWNER_NUMBER &&
    WA_NOTIFY_TEMPLATE
  );
}

async function notifyOwnerWhatsApp(userName, eventName = 'used your server') {
  if (!whatsappOwnerNotificationsConfigured()) {
    logger.warn('Owner WhatsApp notifications are not configured. Set WA_NOTIFY_TOKEN, WA_PHONE_NUMBER_ID, WA_OWNER_NUMBER and WA_NOTIFY_TEMPLATE.');
    return { ok: false, skipped: true, reason: 'notification_not_configured' };
  }

  const safeUserName = String(userName || 'Unknown user').trim().slice(0, 80);
  const safeEvent = String(eventName || 'used your server').trim().slice(0, 120);

  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: WA_OWNER_NUMBER.replace(/[^\d]/g, ''),
    type: 'template',
    template: {
      name: WA_NOTIFY_TEMPLATE,
      language: { code: WA_NOTIFY_LANGUAGE },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: safeUserName },
            { type: 'text', text: safeEvent }
          ]
        }
      ]
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_NOTIFY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      logger.error('Owner WhatsApp notification failed', result?.error || result);
      return { ok: false, status: response.status, error: result?.error || result };
    }

    logger.info({ userName: safeUserName, eventName: safeEvent }, 'Owner WhatsApp notification sent');
    return { ok: true, result };
  } catch (error) {
    logger.error('Owner WhatsApp notification request error', error?.message || error);
    return { ok: false, error: String(error?.message || error) };
  }
}


// Server start time for uptime tracking
const SERVER_START_TIME = Date.now();

// Reconnect config
const RECONNECT_MAX = 6;
const RECONNECT_DELAY_MS = 4000; // 4 seconds
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// Prune config
const MAX_PREKEY_FILES = parseInt(process.env.MAX_PREKEY_FILES || '20', 10);
const MAX_SENDER_KEY_FILES = parseInt(process.env.MAX_SENDER_KEY_FILES || '5', 10);
const MAX_SESSION_FILES = parseInt(process.env.MAX_SESSION_FILES || '10', 10);
const PRUNE_DEBOUNCE_MS = parseInt(process.env.PRUNE_DEBOUNCE_MS || '2000', 10);
const GLOBAL_PRUNE_INTERVAL_MS = parseInt(process.env.GLOBAL_PRUNE_INTERVAL_MS || (60 * 60 * 1000).toString(), 10);

// Directories
const uploadsDir = path.join(process.cwd(), 'uploads');
const sessionsRoot = path.join(process.cwd(), 'uploaded_sessions');
const usersFilePath = path.join(process.cwd(), 'users.json');
const approvalFilePath = path.join(process.cwd(), 'approval.txt');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(sessionsRoot)) fs.mkdirSync(sessionsRoot, { recursive: true });

// Initialize approval file if not exists
if (!fs.existsSync(approvalFilePath)) {
  fs.writeFileSync(approvalFilePath, '', 'utf8');
  console.log(chalk.yellow('芒艙鈥� approval.txt file created'));
}

// Initialize users file with admin
function initializeUsers() {
  if (!fs.existsSync(usersFilePath)) {
    const users = {
      admin: {
        username: 'Aman',
        password: hashPassword('AMAN1234'),
        role: 'admin',
        createdAt: new Date().toISOString()
      }
    };
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), 'utf8');
    console.log(chalk.green('芒艙鈥� Admin user created: Aman/Aman1234'));
  }
}

// Password hashing
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Load users from file
function loadUsers() {
  try {
    if (fs.existsSync(usersFilePath)) {
      return JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
    }
  } catch (e) {
    logger.error('Failed to load users', e?.message || e);
  }
  return {};
}

// Save users to file
function saveUsers(users) {
  try {
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), 'utf8');
  } catch (e) {
    logger.error('Failed to save users', e?.message || e);
  }
}

// Load approved keys from approval.txt
function loadApprovedKeys() {
  try {
    if (fs.existsSync(approvalFilePath)) {
      const content = fs.readFileSync(approvalFilePath, 'utf8');
      return content.split('\n').map(line => line.trim()).filter(Boolean);
    }
  } catch (e) {
    logger.error('Failed to load approval keys', e?.message || e);
  }
  return [];
}

// Check if key is approved
function isKeyApproved(key) {
  const approvedKeys = loadApprovedKeys();
  return approvedKeys.includes(key);
}

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/\s+/g, ''))
});
const upload = multer({ storage });

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(process.cwd()));

const SESSIONS = Object.create(null); // sessionId -> session object
const CREDS_HASH_TO_SESSION = Object.create(null); // credsHash -> sessionId

// Watcher bookkeeping
const DIR_WATCHERS = Object.create(null);

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeSessionId() {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function makeSessionDir(sessionId) {
  const dir = path.join(sessionsRoot, sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Logging with colors
function appendSessionLog(sessionId, rawMsg) {
  const time = new Date().toISOString();
  const msg = String(rawMsg || '');
  const s = SESSIONS[sessionId];

  if (s) {
    s.logs = s.logs || [];
    s.logs.push({ time, msg });
    if (s.logs.length > 1000) s.logs = s.logs.slice(-1000);
  }

  const lower = msg.toLowerCase();
  let kind = 'other';
  if (/(\bsent\b|\bsuccessful\b|\bsuccess\b|\breconnect successful\b|\bstarted\b|\bopen\b|\bcreated\b|\bstarted loop\b)/.test(lower)) {
    kind = 'success';
  } else if (/(\berror\b|\bfailed\b|\bdeleted\b|\blogged out\b|\binvalid\b|\bunauthorized\b|\b401\b|\bdisconnect\b|\bclose\b|\bfailed to\b|\bexpired\b|\bremoved\b)/.test(lower)) {
    kind = 'error';
  } else {
    kind = 'other';
  }

  const timeStr = chalk.yellow(`[${time}]`);
  let symbol = 'i';
  let symbolColored = chalk.cyan(`[${symbol}]`);
  let messageColored = chalk.cyan(msg);

  if (kind === 'success') {
    symbol = '芒艙鈥�';
    symbolColored = chalk.greenBright(`[${symbol}]`);
    messageColored = chalk.green(msg);
  } else if (kind === 'error') {
    symbol = '芒艙鈥�';
    symbolColored = chalk.redBright(`[${symbol}]`);
    messageColored = chalk.red(msg);
  } else {
    symbol = 'i';
    symbolColored = chalk.cyan(`[${symbol}]`);
    messageColored = chalk.cyan(msg);
  }

  const sessionIdStr = sessionId ? chalk.magenta(`[${sessionId}]`) : '';
  const line = `${timeStr} ${symbolColored} ${messageColored} ${sessionIdStr}`;
  if (process.env.CONSOLE_SESSION_LOGS !== '0') console.log(line);
  logger.info({ sessionId, kind, time }, msg);
}

// Session metadata save
const PERSIST_DEBOUNCE_MS = Math.max(1000, parseInt(process.env.PERSIST_DEBOUNCE_MS || '15000', 10) || 15000);
const persistTimers = Object.create(null);

function schedulePersistSessionFiles(sessionId, immediate = false) {
  if (!SESSIONS[sessionId]) return;
  if (immediate) {
    if (persistTimers[sessionId]) { clearTimeout(persistTimers[sessionId]); delete persistTimers[sessionId]; }
    persistSessionFiles(sessionId);
    return;
  }
  if (persistTimers[sessionId]) return;
  persistTimers[sessionId] = setTimeout(() => {
    delete persistTimers[sessionId];
    try { persistSessionFiles(sessionId); } catch (e) {}
  }, PERSIST_DEBOUNCE_MS);
}

function persistSessionFiles(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) return;
  try {
    const sessionMeta = {
      sessionId: s.sessionId,
      username: s.username,
      contacts: s.contacts,
      messages: s.messages,
      prefixName: s.prefixName,
      delayMs: s.delayMs,
      target: s.target,
      groupId: s.groupId,
      tagMention: Boolean(s.tagMention),
      createdAt: s.createdAt || new Date().toISOString(),
      credsHash: s.credsHash || null,
      stopped: s.stopped || false
    };
    fs.writeFileSync(path.join(s.sessionDir, 'session.json'), JSON.stringify(sessionMeta, null, 2), 'utf8');
    fs.writeFileSync(path.join(s.sessionDir, 'messages.txt'), (s.messages || []).join('\n'), 'utf8');
  } catch (e) {
    appendSessionLog(sessionId, 'persistSessionFiles error: ' + (e?.message || e));
  }
}

// Enhanced prune helper
function pruneAuthFiles(sessionDir, sessionId = null) {
  try {
    const PROTECTED_FILES = ['session.json', 'messages.txt', 'creds.json'];
    
    const patterns = [
      { regex: /^pre-?key.*\.json$/i, max: MAX_PREKEY_FILES, name: 'pre-key' },
      { regex: /^prekeys.*\.json$/i, max: MAX_PREKEY_FILES, name: 'prekeys' },
      { regex: /^signedprekey.*\.json$/i, max: MAX_PREKEY_FILES, name: 'signedprekey' },
      { regex: /^sender-key-.*\.json$/i, max: MAX_SENDER_KEY_FILES, name: 'sender-key' },
      { regex: /^session-[0-9]+.*\.json$/i, max: MAX_SESSION_FILES, name: 'session-numbered' },
      { regex: /^key-.*\.json$/i, max: MAX_PREKEY_FILES, name: 'key' }
    ];

    const files = fs.readdirSync(sessionDir, { withFileTypes: true })
      .filter(f => f.isFile())
      .map(f => f.name)
      .filter(fname => !PROTECTED_FILES.includes(fname));

    let totalRemoved = 0;
    const stats = {};

    for (const pattern of patterns) {
      let candidates = [];
      
      for (const fname of files) {
        if (pattern.regex.test(fname)) {
          const full = path.join(sessionDir, fname);
          let stat;
          try { stat = fs.statSync(full); } catch (e) { stat = null; }
          candidates.push({ name: fname, full, mtime: stat ? stat.mtimeMs : 0 });
        }
      }

      if (!candidates.length) continue;

      candidates.sort((a, b) => b.mtime - a.mtime);
      const toRemove = candidates.slice(pattern.max);

      if (!toRemove.length) continue;

      let removedCount = 0;
      for (const rem of toRemove) {
        try {
          fs.rmSync(rem.full, { force: true });
          removedCount++;
        } catch (e) {}
      }

      if (removedCount > 0) {
        stats[pattern.name] = removedCount;
        totalRemoved += removedCount;
      }
    }

    // Check keys subdirectory
    const keysDir = path.join(sessionDir, 'keys');
    if (fs.existsSync(keysDir) && fs.statSync(keysDir).isDirectory()) {
      const kfiles = fs.readdirSync(keysDir, { withFileTypes: true })
        .filter(f => f.isFile())
        .map(f => f.name);
      
      for (const pattern of patterns) {
        let candidates = [];
        
        for (const kf of kfiles) {
          if (pattern.regex.test(kf)) {
            const full = path.join(keysDir, kf);
            let stat;
            try { stat = fs.statSync(full); } catch (e) { stat = null; }
            candidates.push({ name: path.join('keys', kf), full, mtime: stat ? stat.mtimeMs : 0 });
          }
        }

        if (!candidates.length) continue;

        candidates.sort((a, b) => b.mtime - a.mtime);
        const toRemove = candidates.slice(pattern.max);

        if (!toRemove.length) continue;

        let removedCount = 0;
        for (const rem of toRemove) {
          try {
            fs.rmSync(rem.full, { force: true });
            removedCount++;
          } catch (e) {}
        }

        if (removedCount > 0) {
          const key = `keys/${pattern.name}`;
          stats[key] = (stats[key] || 0) + removedCount;
          totalRemoved += removedCount;
        }
      }
    }

    if (totalRemoved > 0 && sessionId) {
      const summary = Object.entries(stats).map(([type, count]) => `${count} ${type}`).join(', ');
      appendSessionLog(sessionId, `冒鸥搂鹿 Cleaned up: ${summary} files`);
    }

    return totalRemoved;
  } catch (e) {
    return 0;
  }
}

// Start file-system watchers
function startSessionWatch(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) return;
  const sessionDir = s.sessionDir;
  if (!sessionDir || !fs.existsSync(sessionDir)) return;

  if (DIR_WATCHERS[sessionId]) return;

  const watchers = { dirWatcher: null, keysWatcher: null, debounceTimer: null };

  const schedulePrune = () => {
    if (watchers.debounceTimer) clearTimeout(watchers.debounceTimer);
    watchers.debounceTimer = setTimeout(() => {
      try {
        const removed = pruneAuthFiles(sessionDir, sessionId);
        if (removed && removed > 0) {
          logger.debug && logger.debug({ sessionId, removed }, 'Pruned auth files after fs event');
        }
      } catch (e) {}
      watchers.debounceTimer = null;
    }, PRUNE_DEBOUNCE_MS);
  };

  try {
    watchers.dirWatcher = fs.watch(sessionDir, (eventType, filename) => {
      if (!filename) return;
      schedulePrune();
    });
  } catch (e) {}

  try {
    const keysDir = path.join(sessionDir, 'keys');
    if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });
    watchers.keysWatcher = fs.watch(keysDir, (eventType, filename) => {
      if (!filename) return;
      schedulePrune();
    });
  } catch (e) {}

  DIR_WATCHERS[sessionId] = watchers;
}

// Stop watchers
function stopSessionWatch(sessionId) {
  const w = DIR_WATCHERS[sessionId];
  if (!w) return;
  try { if (w.dirWatcher) w.dirWatcher.close(); } catch (e) {}
  try { if (w.keysWatcher) w.keysWatcher.close(); } catch (e) {}
  try { if (w.debounceTimer) clearTimeout(w.debounceTimer); } catch (e) {}
  delete DIR_WATCHERS[sessionId];
}

// Complete session cleanup (delete all files and folder)
function completeSessionCleanup(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sessionDir) return;

  try {
    appendSessionLog(sessionId, '冒鸥鈥斺€樏嘎� Complete cleanup: removing session folder');
    
    // Stop watchers first
    stopSessionWatch(sessionId);
    clearAllNoReplyTimers(sessionId);
    
    // Remove entire session directory
    if (fs.existsSync(s.sessionDir)) {
      fs.rmSync(s.sessionDir, { recursive: true, force: true });
      appendSessionLog(sessionId, '芒艙鈥� Session folder completely removed');
    }
    
    // Remove from memory
    if (s.credsHash && CREDS_HASH_TO_SESSION[s.credsHash]) {
      delete CREDS_HASH_TO_SESSION[s.credsHash];
    }
    delete SESSIONS[sessionId];
    
  } catch (e) {
    appendSessionLog(sessionId, '芒聺艗 Cleanup error: ' + (e?.message || e));
  }
}

// Cleanup session files (keeps session.json, messages.txt, creds.json)
function cleanupSessionFiles(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sessionDir) return;

  const PROTECTED_FILES = ['session.json', 'messages.txt', 'creds.json'];
  let deletedCount = 0;

  try {
    appendSessionLog(sessionId, '冒鸥鈥斺€樏嘎� Starting cleanup of session files...');

    const files = fs.readdirSync(s.sessionDir, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && !PROTECTED_FILES.includes(file.name)) {
        try {
          fs.unlinkSync(path.join(s.sessionDir, file.name));
          deletedCount++;
        } catch (e) {}
      }
    }

    const keysDir = path.join(s.sessionDir, 'keys');
    if (fs.existsSync(keysDir)) {
      try {
        fs.rmSync(keysDir, { recursive: true, force: true });
        appendSessionLog(sessionId, '芒艙鈥� Deleted keys/ subdirectory');
      } catch (e) {}
    }

    appendSessionLog(sessionId, `芒艙鈥� Cleanup complete: ${deletedCount} files deleted, protected files preserved`);
  } catch (e) {
    appendSessionLog(sessionId, '芒聺艗 Cleanup error: ' + (e?.message || e));
  }
}

// Check if credentials are invalid/logged out/expired - FIXED VERSION
function isLoggedOutUpdate(update) {
  const last = update?.lastDisconnect;
  if (!last) return false;
  
  const error = last.error;
  const statusCode = error?.output?.statusCode;
  const msg = (error && (error.message || String(error))) || String(error || '');
  
  if (!msg && !statusCode) return false;
  
  const lower = msg.toLowerCase();
  
  const actualLoggedOutPatterns = [
    'logged out',
    'logged-out',
    'device not found',
    'invalid mac',
    'qr refs attempts ended',
    'restart required'
  ];
  
  if (statusCode === 401 || statusCode === 403) {
    appendSessionLog(null, `Detected auth failure with status code: ${statusCode}`);
    return true;
  }
  
  for (const pattern of actualLoggedOutPatterns) {
    if (lower.includes(pattern)) {
      appendSessionLog(null, `Detected logged out pattern: \"${pattern}\" in message: \"${msg}\"`);
      return true;
    }
  }
  
  return false;
}

// Check if creds are actually logged in to WhatsApp
async function checkIfLoggedIn(sock, sessionId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Timeout: Failed to verify login status'));
      }
    }, timeoutMs);

    const connectionHandler = (update) => {
      if (resolved) return;
      
      const { connection, lastDisconnect } = update;
      
      if (connection === 'open') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          sock.ev.off('connection.update', connectionHandler);
          resolve(true);
        }
        return;
      }
      
      if (connection === 'close') {
        if (isLoggedOutUpdate(update)) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            sock.ev.off('connection.update', connectionHandler);
            const errorMsg = lastDisconnect?.error?.message || 'Credentials expired or logged out';
            reject(new Error(errorMsg));
          }
        }
      }
    };

    sock.ev.on('connection.update', connectionHandler);
  });
}

// Validate creds.json structure
function validateCredsJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(content);
    
    if (!json.noiseKey || !json.signedIdentityKey || !json.signedPreKey) {
      return false;
    }
    
    return true;
  } catch (e) {
    return false;
  }
}

// Restart a session
async function restartSession(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) {
    appendSessionLog(sessionId, 'restartSession: no in-memory session found');
    return;
  }
  
  if (s.stopped) {
    appendSessionLog(sessionId, 'Session was manually stopped - will not restart');
    return;
  }
  
  const dir = s.sessionDir;
  if (!dir || !fs.existsSync(dir)) {
    appendSessionLog(sessionId, 'restartSession: session folder missing, cannot restart');
    return;
  }

  appendSessionLog(sessionId, 'Restarting session from disk: ' + dir);

  try {
    const sessionJsonPath = path.join(dir, 'session.json');
    if (fs.existsSync(sessionJsonPath)) {
      const meta = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));
      s.contacts = meta.contacts || s.contacts;
      s.messages = meta.messages || s.messages;
      s.prefixName = meta.prefixName || s.prefixName || 'Bot';
      s.delayMs = meta.delayMs || s.delayMs || 5000;
      s.target = meta.target || s.target;
      s.groupId = meta.groupId || s.groupId;
      s.tagMention = Boolean(meta.tagMention);
      s.createdAt = meta.createdAt || s.createdAt;
      s.credsHash = meta.credsHash || s.credsHash;
      s.username = meta.username || s.username;
      s.stopped = meta.stopped || false;
      if (s.credsHash) CREDS_HASH_TO_SESSION[s.credsHash] = sessionId;
    }
  } catch (e) {
    appendSessionLog(sessionId, 'Failed to read session.json during restart: ' + (e?.message || e));
  }

  s.runningLoop = false;
  s.reconnectAttempts = 0;
  s.reconnectLock = false;
  s.firstReconnectTime = null;

  try {
    s.sock = await createOrGetSocket(dir, sessionId);
    appendSessionLog(sessionId, '芒艙鈥� Session restarted successfully');
    
  } catch (e) {
    appendSessionLog(sessionId, 'Restart: socket creation failed: ' + (e?.message || e));
    return;
  }
  
  try {
    await startSendingLoop(sessionId, s.contacts, s.messages, s.prefixName, s.delayMs, s.target, s.groupId);
    appendSessionLog(sessionId, 'Session restarted and sending loop started');
  } catch (e) {
    appendSessionLog(sessionId, 'restart startSendingLoop failed: ' + (e?.message || e));
  }
}

// Attempt reconnect with 1-hour timeout
async function attemptReconnect(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) return;
  
  if (s.stopped) {
    appendSessionLog(sessionId, 'Session was manually stopped - will not reconnect');
    return;
  }
  
  if (s.reconnectLock) {
    appendSessionLog(sessionId, 'Reconnect attempt already in progress, skipping duplicate call');
    return;
  }
  
  s.reconnectLock = true;
  s.reconnectAttempts = s.reconnectAttempts || 0;
  
  if (!s.firstReconnectTime) {
    s.firstReconnectTime = Date.now();
  }

  for (let i = 0; i < RECONNECT_MAX; i++) {
    s.reconnectAttempts = (s.reconnectAttempts || 0) + 1;
    
    const timeSinceFirstReconnect = Date.now() - (s.firstReconnectTime || Date.now());
    if (timeSinceFirstReconnect >= SESSION_TIMEOUT_MS) {
      appendSessionLog(sessionId, `芒聺艗 Session timeout: Failed to reconnect for 1 hour. Removing session completely.`);
      completeSessionCleanup(sessionId);
      s.reconnectLock = false;
      return;
    }
    
    appendSessionLog(sessionId, `Reconnect attempt ${s.reconnectAttempts}/${RECONNECT_MAX} (waiting ${RECONNECT_DELAY_MS}ms before trying)`);
    await sleep(RECONNECT_DELAY_MS);
    
    if (!SESSIONS[sessionId]) {
      appendSessionLog(sessionId, 'Session removed during reconnect attempts, aborting attempts');
      s.reconnectLock = false;
      return;
    }
    
    try {
      const newSock = await createOrGetSocket(s.sessionDir, sessionId);
      if (newSock) {
        s.sock = newSock;
        appendSessionLog(sessionId, '芒艙鈥� Reconnect successful - Socket recreated');
        s.reconnectAttempts = 0;
        s.firstReconnectTime = null;
        s.reconnectLock = false;
        return;
      }
    } catch (e) {
      const errorMsg = e?.message || e;
      appendSessionLog(sessionId, 'Reconnect try failed: ' + errorMsg);
      
      if (String(errorMsg).toLowerCase().includes('logged out') || 
          String(errorMsg).toLowerCase().includes('invalid mac') ||
          String(errorMsg).toLowerCase().includes('device not found')) {
        appendSessionLog(sessionId, '芒聺艗 Detected actual authentication failure during reconnect. Removing session.');
        completeSessionCleanup(sessionId);
        s.reconnectLock = false;
        return;
      }
    }
  }

  s.reconnectLock = false;
  
  const timeSinceFirstReconnect = Date.now() - (s.firstReconnectTime || Date.now());
  if (timeSinceFirstReconnect >= SESSION_TIMEOUT_MS) {
    appendSessionLog(sessionId, `芒聺艗 Session timeout: Failed to reconnect for 1 hour. Removing session completely.`);
    completeSessionCleanup(sessionId);
    return;
  }
  
  appendSessionLog(sessionId, `Max reconnect attempts (${RECONNECT_MAX}) reached. Restarting session immediately.`);
  try {
    await restartSession(sessionId);
  } catch (e) {
    appendSessionLog(sessionId, 'restartSession failed after max reconnects: ' + (e?.message || e));
  }
}

// Restore sessions from disk
function restoreSessionsFromDisk() {
  const entries = fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot, { withFileTypes: true }) : [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sessionId = e.name;
    const dir = path.join(sessionsRoot, sessionId);
    const sessionJsonPath = path.join(dir, 'session.json');
    const credsPath = path.join(dir, 'creds.json');
    
    if (fs.existsSync(sessionJsonPath) && fs.existsSync(credsPath)) {
      try {
        if (!validateCredsJson(credsPath)) {
          appendSessionLog(sessionId, '芒聺艗 Invalid creds.json format detected. Removing session.');
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch (cleanupErr) {}
          continue;
        }
        
        const meta = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));
        
        if (meta.stopped) {
          appendSessionLog(sessionId, 'Session was stopped - skipping restore');
          continue;
        }
        
        const sess = {
          sessionId: meta.sessionId || sessionId,
          sessionDir: dir,
          username: meta.username || 'unknown',
          credsHash: meta.credsHash || null,
          contacts: meta.contacts || [],
          messages: meta.messages || [],
          prefixName: meta.prefixName || 'Bot',
          delayMs: meta.delayMs || 5000,
          runningLoop: false,
          sock: null,
          target: meta.target || 'contacts',
          groupId: meta.groupId || null,
          tagMention: Boolean(meta.tagMention),
          logs: [],
          createdAt: meta.createdAt || new Date().toISOString(),
          startedAt: meta.startedAt || Date.now(),
          reconnectAttempts: 0,
          reconnectLock: false,
          firstReconnectTime: null,
          deleting: false,
          stopped: false
        };
        
        SESSIONS[sess.sessionId] = sess;
        
        if (fs.existsSync(credsPath)) {
          try {
            const hash = sha256File(credsPath);
            sess.credsHash = hash;
            CREDS_HASH_TO_SESSION[hash] = sess.sessionId;
          } catch (e) {}
        }
        
        appendSessionLog(sess.sessionId, 'Restored session from disk, reconnecting...');

        try { startSessionWatch(sess.sessionId); } catch (e) {}

        (async () => {
          try {
            SESSIONS[sess.sessionId].sock = await createOrGetSocket(sess.sessionDir, sess.sessionId);
            appendSessionLog(sess.sessionId, '芒艙鈥� Socket created successfully on restore');
          } catch (e) { 
            appendSessionLog(sess.sessionId, 'Socket create failed on restore: ' + (e?.message || e));
            return;
          }
          
          try {
            await startSendingLoop(sess.sessionId, sess.contacts, sess.messages, sess.prefixName, sess.delayMs, sess.target, sess.groupId);
          } catch (err) { 
            appendSessionLog(sess.sessionId, 'startSendingLoop on restore failed: ' + (err?.message || err)); 
          }
        })();
      } catch (err) {
        logger.warn('Failed to restore session', sessionId, err?.message || err);
      }
    }
  }
}

// Baileys socket creation
async function createOrGetSocket(sessionDir, sessionId) {
  let baileys;
  try { 
    baileys = await import('@whiskeysockets/baileys'); 
  } catch (e) {
    logger.error('Please npm install @whiskeysockets/baileys', e?.message || e);
    throw e;
  }
  
  const {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion
  } = baileys;

  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const keysDir = path.join(sessionDir, 'keys');
  if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
  } catch (e) {
    appendSessionLog(sessionId, '芒聺艗 useMultiFileAuthState failed - Invalid credentials: ' + (e?.message || e));
    throw e;
  }

  let version;
  try { 
    ({ version } = await fetchLatestBaileysVersion()); 
  } catch (e) { 
    logger.warn('fetchLatestBaileysVersion failed'); 
  }

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Safari'),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino().child({ level: 'fatal' })) },
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
  });

  if (sock?.ev?.on) {
    sock.ev.on('creds.update', async () => {
      try {
        if (typeof saveCreds === 'function') await saveCreds();
        fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(state.creds || {}, null, 2), 'utf8');

        try {
          const removed = pruneAuthFiles(sessionDir, sessionId);
          if (removed && removed > 0) {
            logger.debug && logger.debug({ sessionId, removed }, 'Pruned auth files after creds.update');
          }
        } catch (e) {}
      } catch (e) { 
        appendSessionLog(sessionId, 'creds.update handler error: ' + (e?.message || e)); 
      }
    });
  }


  // Track incoming replies. Any real incoming message from a monitored target
  // cancels that target's pending no-reply timer.
  if (sock?.ev?.on) {
    sock.ev.on('messages.upsert', ({ messages }) => {
      try {
        for (const msg of messages || []) {
          if (!msg || msg.key?.fromMe) continue;
          const remoteJid = msg.key?.remoteJid;
          if (!remoteJid) continue;

          const s = SESSIONS[sessionId];
          if (!s) continue;

          const targetJids = [];
          if (s.target === 'gc' && s.groupId) {
            targetJids.push(s.groupId + '@g.us');
          } else {
            for (const contact of (s.contacts || [])) {
              targetJids.push(String(contact).replace(/\D/g, '') + '@s.whatsapp.net');
            }
          }

          const matched = targetJids.some(j =>
            j === remoteJid || j.split('@')[0] === String(remoteJid).split('@')[0]
          );

          if (matched && clearNoReplyTimer(sessionId, remoteJid)) {
            appendSessionLog(sessionId, `Incoming reply received from ${remoteJid}; no-reply timer cleared`);
          }
        }
      } catch (e) {
        appendSessionLog(sessionId, 'messages.upsert monitor error: ' + (e?.message || e));
      }
    });
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const errorMsg = lastDisconnect?.error?.message || lastDisconnect?.error || 'unknown';
      appendSessionLog(sessionId, 'Socket closed: ' + errorMsg);
      
      if (isLoggedOutUpdate(update)) {
        appendSessionLog(sessionId, '芒聺艗 Detected ACTUAL logged out/invalid credentials (not just stream error). Removing session completely.');
        completeSessionCleanup(sessionId);
        return;
      } else {
        appendSessionLog(sessionId, '芒拧聽茂赂聫 Connection closed but not a logged out condition. Will attempt reconnection...');
      }
      
      const s = SESSIONS[sessionId];
      if (s && !s.stopped) {
        appendSessionLog(sessionId, 'Socket closed, starting reconnect attempts...');
        attemptReconnect(sessionId).catch(err => appendSessionLog(sessionId, 'attemptReconnect error: ' + (err?.message || err)));
      }
    }
    
    if (connection === 'open') {
      appendSessionLog(sessionId, '芒艙鈥� Socket open and connected to WhatsApp');
      
      const s = SESSIONS[sessionId];
      if (s) {
        s.reconnectAttempts = 0;
        s.firstReconnectTime = null;
      }
      
            try { startSessionWatch(sessionId); } catch (e) {}

      try {
        const removed = pruneAuthFiles(sessionDir, sessionId);
        if (removed && removed > 0) logger.debug && logger.debug({ sessionId, removed }, 'Pruned auth files on socket open');
      } catch (e) {}
    }
  });

  return sock;
}

// Wait for socket open
async function waitForSocketOpen(sessionId, timeoutMs = 20000) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sock) throw new Error('No session or socket');
  const sock = s.sock;
  if (sock?.authState?.creds?.registered || (sock.user && Object.keys(sock.user || {}).length)) return;
  
  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => { 
      if (!done) { 
        done = true; 
        reject(new Error('timeout')); 
      } 
    }, timeoutMs);
    
    const handler = (update) => {
      const { connection } = update;
      if (connection === 'open') {
        if (!done) { 
          done = true; 
          clearTimeout(to); 
          sock.ev.off('connection.update', handler); 
          resolve(); 
        }
      }
    };
    sock.ev.on('connection.update', handler);
  });
}

// ================= GROUP TAG / MENTION HELPER =================
// When enabled for a group session, fetch the group's participants and
// send the message with WhatsApp mentions attached.
async function getGroupMentionJids(sock, groupJid) {
  if (!sock || !groupJid) return [];

  try {
    let metadata = null;

    if (typeof sock.groupMetadata === 'function') {
      metadata = await sock.groupMetadata(groupJid);
    } else if (typeof sock.groupFetchAllParticipating === 'function') {
      const groups = await sock.groupFetchAllParticipating();
      metadata = groups?.[groupJid] || null;
    }

    const participants = Array.isArray(metadata?.participants)
      ? metadata.participants
      : [];

    return participants
      .map(p => p?.id || p?.jid || '')
      .map(String)
      .filter(Boolean)
      .filter(jid => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))
      .filter((jid, i, arr) => arr.indexOf(jid) === i);
  } catch (e) {
    return [];
  }
}

// Always-on sender loop
async function startSendingLoop(sessionId, contacts, messages, prefixName, delayMs, target, groupId) {
  const s = SESSIONS[sessionId];
  if (!s) throw new Error('Session not found');
  if (s.runningLoop) return;
  s.runningLoop = true;

  let index = 0;
  while (SESSIONS[sessionId]) {
    try {
      if (s.deleting || s.stopped) {
        appendSessionLog(sessionId, 'startSendingLoop: session is deleting/stopped, exiting loop');
        break;
      }

      if (!s.sock) {
        try { 
          s.sock = await createOrGetSocket(s.sessionDir, sessionId); 
        } catch (e) { 
          appendSessionLog(sessionId, 'Socket creation failed in loop: ' + (e?.message || e)); 
          await sleep(5000); 
          continue; 
        }
      }
      
      try { 
        await waitForSocketOpen(sessionId, 20000); 
      } catch (e) { 
        appendSessionLog(sessionId, 'Socket not open yet'); 
      }

      const contact = (contacts && contacts.length) ? contacts[index % contacts.length] : null;
      const messageToSend = (messages && messages.length) ? messages[index % messages.length] : '';
      const fullMessage = (prefixName || 'Bot') + ' ' + messageToSend;

      try {
        const baileys = await import('@whiskeysockets/baileys');
        let jid;
        
        if (target === 'gc') {
          jid = (groupId + '@g.us');
        } else {
          jid = contact ? baileys.jidNormalizedUser(contact + '@s.whatsapp.net') : null;
        }

        if (!jid) throw new Error('Invalid JID');

        let sendPayload = { text: fullMessage };

        // Optional "Tag/Mention All" for group sessions.
        // Enable by sending tagMention=true from the panel/form.
        if (target === 'gc' && s.tagMention) {
          const mentionJids = await getGroupMentionJids(s.sock, jid);

          if (mentionJids.length) {
            sendPayload = {
              text: fullMessage,
              mentions: mentionJids
            };
            appendSessionLog(
              sessionId,
              `Tag Mention enabled: mentioning ${mentionJids.length} group participant(s)`
            );
          } else {
            appendSessionLog(sessionId, 'Tag Mention enabled but no group participants were found');
          }
        }

        await s.sock.sendMessage(jid, sendPayload);
        s.lastUsed = Date.now();
        scheduleNoReplyCheck(sessionId, jid, contact || groupId || jid);
        s.consecutiveSendErrors = 0;
        appendSessionLog(sessionId, `芒艙鈥� Message sent to ${jid}`);
      } catch (err) {
        appendSessionLog(sessionId, '芒聺艗 Send failed: ' + String(err?.message || err));
        s.consecutiveSendErrors = (s.consecutiveSendErrors || 0) + 1;
        const MAX_CONSEC_SEND_FAIL = 10;
        
        if (s.consecutiveSendErrors >= MAX_CONSEC_SEND_FAIL) {
          appendSessionLog(sessionId, `Reached ${MAX_CONSEC_SEND_FAIL} consecutive send failures. Restarting session.`);
          s.consecutiveSendErrors = 0;
          try { 
            await restartSession(sessionId); 
          } catch (e) { 
            appendSessionLog(sessionId, 'Failed to restart after consecutive send errors: ' + (e?.message || e)); 
          }
        }
      }

      index++;
      schedulePersistSessionFiles(sessionId);
      await sleep(Math.max(1000, Number(delayMs) || 1000));

    } catch (e) {
      appendSessionLog(sessionId, 'Error in sending loop: ' + (e?.message || e));
      await sleep(2000);
    }
  }
  
  if (SESSIONS[sessionId]) SESSIONS[sessionId].runningLoop = false;
}

// ========== API ROUTES ==========

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

// Get server uptime with daily reset
app.get('/api/uptime', (req, res) => {
  const uptimeMs = Date.now() - SERVER_START_TIME;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  
  res.json({
    ok: true,
    uptimeMs,
    uptimeFormatted: `${days} day ${hours} hour ${minutes} minute ${seconds} seconds`,
    startTime: new Date(SERVER_START_TIME).toISOString()
  });
});

// Generate approval key (browser-based)
app.post('/api/generate-approval-key', (req, res) => {
  try {
    const { userAgent, language, platform, screenResolution, timezone } = req.body;
    
    // Create unique fingerprint from browser data
    const fingerprint = `${userAgent}-${language}-${platform}-${screenResolution}-${timezone}-${Date.now()}`;
    const approvalKey = crypto.createHash('sha256').update(fingerprint).digest('hex').substring(0, 16).toUpperCase();
    
    res.json({ ok: true, approvalKey });
  } catch (e) {
    logger.error('Generate approval key error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Failed to generate approval key' });
  }
});

// Check if approval key is approved
app.post('/api/check-approval', (req, res) => {
  try {
    const { approvalKey } = req.body;
    
    if (!approvalKey) {
      return res.status(400).json({ ok: false, error: 'Approval key required' });
    }
    
    const isApproved = isKeyApproved(approvalKey);
    
    res.json({ ok: true, approved: isApproved });
  } catch (e) {
    logger.error('Check approval error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Failed to check approval' });
  }
});

// Get total users count (admin only)
app.post('/api/total-users', (req, res) => {
  try {
    const { role } = req.body || {};
    
    if (role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin access required' });
    }
    
    const users = loadUsers();
    const totalUsers = Object.keys(users).length;
    
    res.json({ ok: true, totalUsers });
  } catch (e) {
    logger.error('Total users error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Failed to get total users' });
  }
});

// Get total sessions count
app.post('/api/total-sessions', (req, res) => {
  try {
    const { username, role } = req.body || {};
    
    if (!username) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    
    let sessions = Object.values(SESSIONS);
    
    // Filter by username unless admin
    if (role !== 'admin' && username !== 'AMAN123') {
      sessions = sessions.filter(s => s.username === username);
    }
    
    res.json({ ok: true, totalSessions: sessions.length });
  } catch (e) {
    logger.error('Total sessions error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Failed to get total sessions' });
  }
});

// User signup (requires approval)
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password, approvalKey } = req.body;
    
    if (!approvalKey) {
      return res.status(403).json({ ok: false, error: 'Approval required. Please get your key approved first.' });
    }
    
    if (!isKeyApproved(approvalKey)) {
      return res.status(403).json({ ok: false, error: 'Your approval key is not approved yet.' });
    }
    
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Username and password required' });
    }
    
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ ok: false, error: 'Username min 3 chars, password min 6 chars' });
    }
    
    const users = loadUsers();
    
    const existingUser = Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) {
      return res.status(409).json({ ok: false, error: 'Username already exists' });
    }
    
    const userId = 'user_' + Date.now();
    users[userId] = {
      username: username,
      password: hashPassword(password),
      role: 'user',
      approvalKey: approvalKey,
      createdAt: new Date().toISOString()
    };
    
    saveUsers(users);
    
    res.json({ ok: true, message: 'User created successfully', username });
  } catch (e) {
    logger.error('Signup error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Signup failed' });
  }
});

// User login (requires approval)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, approvalKey } = req.body;
    
    if (!approvalKey) {
      return res.status(403).json({ ok: false, error: 'Approval required. Please get your key approved first.' });
    }
    
    if (!isKeyApproved(approvalKey)) {
      return res.status(403).json({ ok: false, error: 'Your approval key is not approved yet.' });
    }
    
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Username and password required' });
    }
    
    const users = loadUsers();
    const hashedPassword = hashPassword(password);
    
    const user = Object.values(users).find(u => 
      u.username === username && u.password === hashedPassword
    );
    
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }
    
    res.json({ 
      ok: true, 
      username: user.username, 
      role: user.role 
    });
    
    notifyOwnerWhatsApp(user.username, 'logged into your server').catch(() => {});
  } catch (e) {
    logger.error('Login error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

// Create session (protected - requires username and approval)
app.post('/send-message', upload.fields([
  { name: 'creds', maxCount: 1 },
  { name: 'messageFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const files = req.files || {};
    const credsFileObj = (files.creds && files.creds[0]) || null;
    const messageFileObj = (files.messageFile && files.messageFile[0]) || null;
    const { name: prefixName, type, targetID, delayTime, username, approvalKey, tagMention } = req.body || {};
    
    if (!username) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    
    if (!approvalKey || !isKeyApproved(approvalKey)) {
      return res.status(403).json({ ok: false, error: 'Valid approval required to create session' });
    }
    
    const delaySeconds = parseInt(delayTime || '5', 10) || 5;
    const delayMs = delaySeconds * 1000;

    if (!credsFileObj) return res.status(400).json({ ok: false, error: 'No creds.json uploaded' });
    if (!messageFileObj) return res.status(400).json({ ok: false, error: 'No message file uploaded' });
    if (!type || !targetID) return res.status(400).json({ ok: false, error: 'Missing type or targetID' });

    const uploadedPath = credsFileObj.path;
    
    if (!validateCredsJson(uploadedPath)) {
      try { fs.unlinkSync(uploadedPath); } catch (e) {}
      try { fs.unlinkSync(messageFileObj.path); } catch (e) {}
      return res.status(400).json({ ok: false, error: 'Invalid creds.json format. Please upload valid WhatsApp credentials.' });
    }

    let contacts = [];
    if (type === 'gc') {
      contacts = [targetID.trim()];
    } else {
      const raw = String(targetID || '');
      const parts = raw.split(/[,\\r\\n]+/).map(x => x.trim()).filter(Boolean);
      contacts = parts.map(p => p.replace(/[^\d+]/g, '').replace(/^\+/, ''));
      if (!contacts.length) return res.status(400).json({ ok: false, error: 'No valid contact numbers provided' });
    }

    const txt = fs.readFileSync(messageFileObj.path, 'utf8');
    const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const messages = lines.length ? lines : [txt.trim()];
    if (!messages.length || !messages[0]) return res.status(400).json({ ok: false, error: 'No message content' });

    const credsHash = sha256File(uploadedPath);
    if (CREDS_HASH_TO_SESSION[credsHash]) {
      try { fs.unlinkSync(uploadedPath); } catch (e) {}
      try { fs.unlinkSync(messageFileObj.path); } catch (e) {}
      return res.status(409).json({ ok: false, error: 'Duplicate credentials. Only one active session allowed per creds.json.' });
    }

    const sessionId = makeSessionId();
    const sessionDir = makeSessionDir(sessionId);

    fs.copyFileSync(uploadedPath, path.join(sessionDir, 'creds.json'));
    try { fs.writeFileSync(path.join(sessionDir, 'messages.txt'), messages.join('\n'), 'utf8'); } catch (e) {}
    
    const sessionMeta = {
      sessionId,
      username,
      contacts,
      messages,
      prefixName,
      delayMs,
      target: type,
      groupId: type === 'gc' ? targetID.trim() : null,
      tagMention: type === 'gc' && (tagMention === true || String(tagMention).toLowerCase() === 'true'),
      createdAt: new Date().toISOString(),
      startedAt: Date.now(),
      credsHash,
      stopped: false
    };
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(sessionMeta, null, 2), 'utf8');

    try { fs.unlinkSync(uploadedPath); } catch (e) {}
    try { fs.unlinkSync(messageFileObj.path); } catch (e) {}
    
    SESSIONS[sessionId] = {
      sessionId,
      sessionDir,
      username,
      credsHash,
      contacts,
      messages,
      prefixName,
      delayMs,
      runningLoop: false,
      sock: null,
      target: type,
      groupId: type === 'gc' ? targetID.trim() : null,
      tagMention: sessionMeta.tagMention,
      createdAt: sessionMeta.createdAt,
      startedAt: Date.now(),
      logs: [],
      reconnectAttempts: 0,
      reconnectLock: false,
      firstReconnectTime: null,
      deleting: false,
      stopped: false
    };
    CREDS_HASH_TO_SESSION[credsHash] = sessionId;

    appendSessionLog(sessionId, `Session created by user: ${username}`);

    try { startSessionWatch(sessionId); } catch (e) {}

    (async () => {
      try {
        SESSIONS[sessionId].sock = await createOrGetSocket(sessionDir, sessionId);
        appendSessionLog(sessionId, '芒艙鈥� Socket created - Session starting');
      } catch (e) { 
        appendSessionLog(sessionId, 'Socket create failed: ' + (e?.message || e));
        return;
      }
      
      try {
        await startSendingLoop(sessionId, contacts, messages, prefixName, delayMs, SESSIONS[sessionId].target, SESSIONS[sessionId].groupId);
      } catch (e) { 
        appendSessionLog(sessionId, 'startSendingLoop error: ' + (e?.message || e)); 
      }
    })();

    res.json({ ok: true, sessionId });
    
    notifyOwnerWhatsApp(username, `started session ${sessionId}`).catch(() => {});
  } catch (err) {
    logger.error('send-message failed', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Stop session
app.post('/stop-session/:id', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username } = req.body || {};
    
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });
    
    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    
    if (username !== 'SAHIL123' && s.username !== username) {
      return res.status(403).json({ ok: false, error: 'Not authorized to stop this session' });
    }

    appendSessionLog(sessionId, `冒鸥鈥衡€� Stop session requested by: ${username}`);
    
    s.stopped = true;
    persistSessionFiles(sessionId);

    try {
      const sock = s.sock;
      if (sock) {
        try {
          if (sock.ws && typeof sock.ws.close === 'function') sock.ws.close();
          else if (sock.socket && typeof sock.socket.close === 'function') sock.socket.close();
          else if (typeof sock.end === 'function') sock.end();
          appendSessionLog(sessionId, 'Socket closed');
        } catch (closeErr) { 
          appendSessionLog(sessionId, 'Error during socket close: ' + (closeErr?.message || closeErr)); 
        }
      }
    } catch (e) { 
      appendSessionLog(sessionId, 'Error trying to close socket: ' + (e?.message || e)); 
    }

    try { stopSessionWatch(sessionId); } catch (e) {}

    cleanupSessionFiles(sessionId);

    try {
      if (s.credsHash && CREDS_HASH_TO_SESSION[s.credsHash]) {
        delete CREDS_HASH_TO_SESSION[s.credsHash];
      }
      delete SESSIONS[sessionId];
      appendSessionLog(sessionId, '芒艙鈥� Session stopped successfully');
    } catch (e) { 
      appendSessionLog(sessionId, 'Error removing from memory: ' + (e?.message || e)); 
    }

    return res.json({ ok: true, message: `Session ${sessionId} stopped and cleaned up` });

  } catch (e) {
    logger.error('stop-session err', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Error stopping session' });
  }
});

// List sessions (filtered by username, admin sees all)
app.post('/api/sessions', (req, res) => {
  try {
    const { username, role } = req.body || {};
    
    if (!username) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    
    let sessions = Object.values(SESSIONS);
    
    if (role !== 'admin' && username !== 'AMAN123') {
      sessions = sessions.filter(s => s.username === username);
    }
    
    const list = sessions.map(s => {
      const uptime = s.startedAt ? Date.now() - s.startedAt : 0;
      const uptimeSeconds = Math.floor(uptime / 1000);
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;
      
      return {
        sessionId: s.sessionId,
        username: s.username,
        prefixName: s.prefixName,
        delayMs: s.delayMs,
        createdAt: s.createdAt,
        uptime: `${days} day ${hours} hour ${minutes} minute ${seconds} seconds`,
        uptimeMs: uptime,
        target: s.target,
        groupId: s.groupId,
        tagMention: Boolean(s.tagMention),
        stopped: s.stopped || false
      };
    });
    
    return res.json({ ok: true, sessions: list });
  } catch (e) {
    logger.error('sessions list error', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});



// ================= PAIRING CODE SESSION =================
// Creates a server-side Baileys session and returns an 8-character pairing code.
// Authentication state is persisted on the server; private auth files are never
// exposed through a public download endpoint.
app.post('/api/pairing-code', async (req, res) => {
  try {
    const { number, username, approvalKey } = req.body || {};
    if (!username) return res.status(401).json({ ok:false, error:'Authentication required' });
    if (!approvalKey || !isKeyApproved(approvalKey)) {
      return res.status(403).json({ ok:false, error:'Valid approval required' });
    }

    const phone = String(number || '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(phone)) {
      return res.status(400).json({ ok:false, error:'Enter a valid WhatsApp number with country code' });
    }

    const sessionId = makeSessionId();
    const sessionDir = makeSessionDir(sessionId);
    const sessionMeta = {
      sessionId, username, contacts: [], messages: [], prefixName: '', delayMs: 5000,
      target: 'pairing', groupId: null, createdAt: new Date().toISOString(),
      startedAt: Date.now(), credsHash: null, stopped: false, pairing: true
    };
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(sessionMeta, null, 2), 'utf8');

    SESSIONS[sessionId] = {
      ...sessionMeta,
      sessionDir,
      runningLoop: false,
      sock: null,
      logs: [],
      reconnectAttempts: 0,
      reconnectLock: false,
      firstReconnectTime: null,
      deleting: false,
      stopped: false,
      paired: false,
      pairingCode: null,
      pairingNumber: phone
    };

    appendSessionLog(sessionId, `Pairing session created by user: ${username}`);

    const sock = await createOrGetSocket(sessionDir, sessionId);
    SESSIONS[sessionId].sock = sock;

    if (typeof sock.requestPairingCode !== 'function') {
      throw new Error('This Baileys version does not support pairing codes');
    }

    // Give the socket a moment to initialize before requesting the code.
    await sleep(1500);
    const code = await sock.requestPairingCode(phone);
    const formattedCode = String(code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    SESSIONS[sessionId].pairingCode = formattedCode;
    schedulePersistSessionFiles(sessionId, true);
    appendSessionLog(sessionId, `Pairing code generated for ${phone}`);

    return res.json({ ok:true, sessionId, pairingCode: formattedCode });
  } catch (e) {
    logger.error('Pairing code generation failed', e?.message || e);
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

app.get('/api/pairing-status/:id', (req, res) => {
  const s = SESSIONS[req.params.id];
  if (!s) return res.status(404).json({ ok:false, error:'Pairing session not found' });
  const registered = Boolean(s.sock?.authState?.creds?.registered || s.sock?.user);
  if (registered) s.paired = true;
  res.json({
    ok:true,
    sessionId:s.sessionId,
    paired:Boolean(s.paired),
    pairingCode:s.pairingCode || null,
    phone:s.pairingNumber || null
  });
});

app.get('/api/pairing-groups/:id', async (req, res) => {
  const s = SESSIONS[req.params.id];
  if (!s || !s.sock) return res.status(404).json({ ok:false, error:'Pairing session not found' });
  const registered = Boolean(s.sock?.authState?.creds?.registered || s.sock?.user);
  if (!registered) return res.status(409).json({ ok:false, error:'WhatsApp is not linked yet' });
  try {
    if (typeof s.sock.groupFetchAllParticipating !== 'function') {
      throw new Error('This Baileys version does not support group list lookup');
    }
    const groups = await s.sock.groupFetchAllParticipating();
    const list = Object.values(groups || {}).map(g => ({
      id:g.id || '', subject:g.subject || 'Unnamed group',
      size:Array.isArray(g.participants) ? g.participants.length : 0
    })).filter(g => g.id);
    res.json({ ok:true, count:list.length, groups:list });
  } catch (e) {
    logger.error('Paired group lookup failed', e?.message || e);
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// ================= GROUP UID LOOKUP =================
// Upload a WhatsApp Baileys creds.json and return groups visible to that account.
// Temporary auth data is removed after the lookup.
app.post('/api/group-uids', upload.single('creds'), async (req, res) => {
  let tempDir = null;
  try {
    const credsFile = req.file;
    const { username, approvalKey } = req.body || {};

    if (!username) {
      if (credsFile?.path) try { fs.unlinkSync(credsFile.path); } catch (e) {}
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    if (!approvalKey || !isKeyApproved(approvalKey)) {
      if (credsFile?.path) try { fs.unlinkSync(credsFile.path); } catch (e) {}
      return res.status(403).json({ ok: false, error: 'Valid approval required' });
    }

    if (!credsFile) {
      return res.status(400).json({ ok: false, error: 'Please upload creds.json' });
    }

    if (!validateCredsJson(credsFile.path)) {
      try { fs.unlinkSync(credsFile.path); } catch (e) {}
      return res.status(400).json({ ok: false, error: 'Invalid creds.json format' });
    }

    const baileys = await import('@whiskeysockets/baileys');
    const {
      makeWASocket,
      useMultiFileAuthState,
      makeCacheableSignalKeyStore,
      Browsers,
      fetchLatestBaileysVersion
    } = baileys;

    tempDir = path.join(
      process.cwd(),
      'group_uid_lookup',
      'lookup_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
    );
    fs.mkdirSync(tempDir, { recursive: true });
    fs.copyFileSync(credsFile.path, path.join(tempDir, 'creds.json'));
    try { fs.unlinkSync(credsFile.path); } catch (e) {}

    let state, saveCreds;
    try {
      ({ state, saveCreds } = await useMultiFileAuthState(tempDir));
    } catch (e) {
      throw new Error('creds.json could not be loaded. This lookup needs a valid Baileys auth state.');
    }

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (e) {}

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Safari'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino().child({ level: 'fatal' }))
      },
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false
    });

    if (sock?.ev?.on && typeof saveCreds === 'function') {
      sock.ev.on('creds.update', saveCreds);
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Timed out while connecting to WhatsApp'));
        }
      }, 30000);

      const handler = (update) => {
        if (update.connection === 'open' && !settled) {
          settled = true;
          clearTimeout(timer);
          try { sock.ev.off('connection.update', handler); } catch (e) {}
          resolve();
        } else if (update.connection === 'close' && !settled) {
          settled = true;
          clearTimeout(timer);
          try { sock.ev.off('connection.update', handler); } catch (e) {}
          reject(new Error(update.lastDisconnect?.error?.message || 'WhatsApp connection closed'));
        }
      };

      sock.ev.on('connection.update', handler);
    });

    if (typeof sock.groupFetchAllParticipating !== 'function') {
      throw new Error('This Baileys version does not support group list lookup');
    }

    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups || {})
      .map(g => ({
        id: g.id || '',
        subject: g.subject || 'Unnamed group',
        size: Array.isArray(g.participants) ? g.participants.length : 0
      }))
      .filter(g => g.id);

    try {
      if (typeof sock.end === 'function') sock.end(new Error('Group UID lookup complete'));
    } catch (e) {}

    return res.json({
      ok: true,
      count: list.length,
      groups: list
    });
  } catch (e) {
    logger.error('Group UID lookup failed', e?.message || e);
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e)
    });
  } finally {
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (e) {}
  }
});

// Get single session details
app.post('/api/session/:id', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username, role } = req.body || {};
    
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });
    if (!username) return res.status(401).json({ ok: false, error: 'Authentication required' });
    
    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    
    if (role !== 'admin' && username !== 'AJEET123' && s.username !== username) {
      return res.status(403).json({ ok: false, error: 'Not authorized' });
    }
    
    const uptime = s.startedAt ? Date.now() - s.startedAt : 0;
    const uptimeSeconds = Math.floor(uptime / 1000);
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    
    return res.json({
      ok: true,
      session: {
        sessionId: s.sessionId,
        username: s.username,
        prefixName: s.prefixName,
        delayMs: s.delayMs,
        createdAt: s.createdAt,
        uptime: `${days} day ${hours} hour ${minutes} minute ${seconds} seconds`,
        uptimeMs: uptime,
        target: s.target,
        groupId: s.groupId,
        stopped: s.stopped || false
      }
    });
  } catch (e) {
    logger.error('session details error', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Logs API
app.post('/api/logs/:id', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username, role } = req.body || {};
    
    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });
    if (!username) return res.status(401).json({ ok: false, error: 'Authentication required' });
    
    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    
    if (role !== 'admin' && username !== 'AJEET123' && s.username !== username) {
      return res.status(403).json({ ok: false, error: 'Not authorized' });
    }
    
    const lines = (s.logs || []).map(l => `[${l.time}] ${l.msg}`);
    return res.json({ ok: true, logs: lines });
  } catch (e) {
    logger.error('api/logs error', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Initialize admin user
initializeUsers();

// Restore sessions on startup
restoreSessionsFromDisk();

// Global periodic prune
setInterval(() => {
  try {
    const sessionIds = Object.keys(SESSIONS);
    for (const sid of sessionIds) {
      try {
        const s = SESSIONS[sid];
        if (s && s.sessionDir) {
          const removed = pruneAuthFiles(s.sessionDir, sid);
          if (removed && removed > 0) logger.debug && logger.debug({ sid, removed }, 'Global prune removed files');
        }
      } catch (e) {}
    }
  } catch (e) {}
}, GLOBAL_PRUNE_INTERVAL_MS);

// Error protection - don't crash server
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException: ' + (err?.message || err));
  appendSessionLog(null, '鉂わ笍赂聫 uncaughtException (server continues): ' + (err?.message || err));
});

process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection: ' + (err?.message || err));
  appendSessionLog(null, '鉂わ笍聽赂聫 unhandledRejection (server continues): ' + (err?.message || err));
});

// Lightweight heartbeat: keeps the event loop observable without blocking it.
setInterval(() => {
  try {
    const active = Object.values(SESSIONS).filter(s => !s.stopped && !s.deleting).length;
    logger.debug({ activeSessions: active, uptimeSec: Math.floor((Date.now() - SERVER_START_TIME) / 1000) }, 'server heartbeat');
  } catch (e) {}
}, 30000).unref();

async function gracefulShutdown(signal) {
  try { logger.info({ signal }, 'Shutdown requested'); } catch (e) {}
  for (const sid of Object.keys(SESSIONS)) {
    try { schedulePersistSessionFiles(sid, true); clearAllNoReplyTimers(sid); } catch (e) {}
  }
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(chalk.bgBlue.white.bold(` 鉁呪€� Aman Ofline WhatsApp Server running on http://0.0.0.0:${PORT} `));
  logger.info('Server started on 0.0.0.0:' + PORT);
  appendSessionLog(null, `鉁呪€� Server started on 0.0.0.0:${PORT}`);
});