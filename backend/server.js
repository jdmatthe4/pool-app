const express = require('express');
const cors = require('cors');
const ScreenLogic = require('node-screenlogic');
const https = require('https');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const MANUAL_IP = process.env.SL_IP || null;
const MANUAL_PORT = parseInt(process.env.SL_PORT || '80');

// ── Pushover notifications ──────────────────────────────────
const PUSHOVER_USER = process.env.PUSHOVER_USER || 'u84rkwhwa434yg5y6fvbz219xqy8ga';
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || 'av2u4z6m57rfun4mfzc3zo3mqf8fed';

var _previousAlertKeys = {};  // track known alerts to detect new ones
var _alertMonitorTimer = null;

function sendPushNotification(title, message, priority) {
  return new Promise(function (resolve, reject) {
    var postData = JSON.stringify({
      token: PUSHOVER_TOKEN,
      user: PUSHOVER_USER,
      title: title,
      message: message,
      priority: priority || 0,   // 0=normal, 1=high, 2=emergency
      sound: priority >= 1 ? 'siren' : 'pushover',
    });

    var options = {
      hostname: 'api.pushover.net',
      port: 443,
      path: '/1/messages.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    var req = https.request(options, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode === 200) {
          console.log('  Pushover sent: ' + title + ' - ' + message);
          resolve();
        } else {
          console.error('  Pushover error (' + res.statusCode + '): ' + body);
          reject(new Error('Pushover API error: ' + res.statusCode));
        }
      });
    });

    req.on('error', function (err) {
      console.error('  Pushover request error: ' + err.message);
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

function alertKey(a) {
  return a.source + ':' + a.message;
}

// ── Pump alarm decoding ─────────────────────────────────────
// The pumpUnknown1 field from getPumpStatusAsync is actually
// the pump alarm/warning bitmask. Known bit mappings:
var PUMP_ALARMS = {
  0x0001: 'Power Outage',
  0x0002: 'Overcurrent',
  0x0004: 'Overvoltage',
  0x0008: 'Drive Temperature',
  0x0010: 'Priming Error',
  0x0020: 'System Blocked',
  0x0040: 'System Interlock',
  0x0080: 'Over Temperature Shutdown',
  0x0100: 'Suction Blockage',
  0x0200: 'Communication Lost',
  0x0400: 'Anti-Freeze',
  0x0800: 'Priming',
  0x1000: 'Max Pressure Warning Alarm',
};

function decodePumpAlarms(alarmValue, pumpId) {
  var alerts = [];
  if (!alarmValue || alarmValue === 0) return alerts;
  for (var bit in PUMP_ALARMS) {
    var val = parseInt(bit);
    if (alarmValue & val) {
      // Bits above 0x0800 tend to be warnings; lower bits are hard alarms
      var severity = val >= 0x0400 ? 'warning' : 'alarm';
      if (val === 0x1000) severity = 'warning';
      alerts.push({
        source: 'Pump ' + pumpId,
        message: PUMP_ALARMS[val],
        severity: severity,
        code: val,
      });
    }
  }
  return alerts;
}

function startAlertMonitor() {
  if (_alertMonitorTimer) return;
  console.log('  Alert monitor started (checking every 30s)');
  console.log('  Notifications: Pushover');

  _alertMonitorTimer = setInterval(function () {
    // Only check if we have a live connection (don't reconnect just for monitoring)
    if (!_conn || !_conn.isConnected) return;

    withConnection(function (conn) {
      return Promise.all([
        conn.equipment.getEquipmentStateAsync(),
        conn.chlor.getIntellichlorConfigAsync(),
        conn.pump.getPumpStatusAsync(1).catch(function () { return null; }),
      ]).then(function (results) {
        var stateResult = results[0];
        var chlorResult = results[1];
        var pumpResult = results[2];

        var currentAlerts = [];

        // Chlorinator alerts
        var chlorAlerts = decodeChlorFlags(chlorResult.flags);
        chlorAlerts.forEach(function (a) {
          if (a.severity !== 'ok') currentAlerts.push(a);
        });

        // Pump alerts (pumpUnknown1 is the alarm bitmask)
        if (pumpResult && pumpResult.pumpUnknown1) {
          var pumpAlerts = decodePumpAlarms(pumpResult.pumpUnknown1, 1);
          pumpAlerts.forEach(function (a) { currentAlerts.push(a); });
        }

        // System alerts
        if (stateResult.freezeMode) {
          currentAlerts.push({ source: 'System', message: 'Freeze protection active', severity: 'warning' });
        }
        if (stateResult.panelMode === 2) {
          currentAlerts.push({ source: 'System', message: 'Panel is in Service mode', severity: 'warning' });
        } else if (stateResult.panelMode === 3) {
          currentAlerts.push({ source: 'System', message: 'Panel is in Timeout mode', severity: 'warning' });
        }

        // Build current key set
        var currentKeys = {};
        currentAlerts.forEach(function (a) { currentKeys[alertKey(a)] = a; });

        // Find NEW alerts (present now but not before)
        var newAlerts = [];
        for (var key in currentKeys) {
          if (!_previousAlertKeys[key]) {
            newAlerts.push(currentKeys[key]);
          }
        }

        // Find CLEARED alerts (were present before but not now)
        var clearedAlerts = [];
        for (var prevKey in _previousAlertKeys) {
          if (!currentKeys[prevKey]) {
            clearedAlerts.push(_previousAlertKeys[prevKey]);
          }
        }

        // Send Pushover notification for each new alert
        newAlerts.forEach(function (a) {
          var priority = a.severity === 'alarm' ? 1 : 0;
          sendPushNotification(
            '🏊 Pool Alert',
            a.source + ': ' + a.message,
            priority
          );
        });

        // Send Pushover notification for each cleared alert
        clearedAlerts.forEach(function (a) {
          sendPushNotification(
            '✅ Pool Alert Cleared',
            a.source + ': ' + a.message + ' has cleared',
            -1  // low priority — just informational
          );
        });

        // Update tracked alerts
        _previousAlertKeys = currentKeys;
      });
    }).catch(function () {
      // Silently ignore monitoring errors
    });
  }, 30000);
}

app.use(cors());
app.use(express.json());

// ── Persistent connection manager ────────────────────────────
// Keeps a single long-lived TCP connection to the ScreenLogic
// adapter and serialises all requests through a queue so we
// never open more than one socket at a time.

var _conn = null;
var _connecting = false;
var _queue = [];        // pending { fn, resolve, reject }
var _processing = false;
var _keepAliveTimer = null;

function getUnit() {
  return new Promise(function (resolve, reject) {
    if (MANUAL_IP) {
      return resolve({ address: MANUAL_IP, port: MANUAL_PORT, gatewayName: '', type: 0 });
    }
    var finder = new ScreenLogic.FindUnits();
    finder.searchAsync()
      .then(function (unit) {
        finder.close();
        if (!unit || !unit.address) return reject(new Error('No ScreenLogic gateway found on network'));
        resolve(unit);
      })
      .catch(function (err) {
        try { finder.close(); } catch (_) {}
        reject(err);
      });
  });
}

function connect() {
  if (_conn && _conn.isConnected) return Promise.resolve(_conn);
  if (_connecting) {
    // Wait for the in-progress connect
    return new Promise(function (resolve, reject) {
      var check = setInterval(function () {
        if (!_connecting) {
          clearInterval(check);
          if (_conn && _conn.isConnected) resolve(_conn);
          else reject(new Error('Connection failed'));
        }
      }, 100);
    });
  }
  _connecting = true;
  return getUnit().then(function (unit) {
    var conn = new ScreenLogic.UnitConnection();
    conn.initUnit(unit);
    return conn.connectAsync().then(function () {
      _conn = conn;
      _connecting = false;
      console.log('  Connected to gateway at ' + unit.address + ':' + unit.port);

      // Start keep-alive pings every 30s to hold the connection open
      if (_keepAliveTimer) clearInterval(_keepAliveTimer);
      _keepAliveTimer = setInterval(function () {
        if (_conn && _conn.isConnected) {
          try {
            var result = _conn.keepAliveAsync();
            if (result && typeof result.catch === 'function') {
              result.catch(function () {
                console.log('  Keep-alive failed, will reconnect on next request');
                cleanup();
              });
            }
          } catch (e) {
            console.log('  Keep-alive error: ' + e.message + ', will reconnect');
            cleanup();
          }
        }
      }, 30000);

      return _conn;
    });
  }).catch(function (err) {
    _connecting = false;
    throw err;
  });
}

function cleanup() {
  if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null; }
  if (_conn) {
    try { _conn.closeAsync(); } catch (_) {}
    _conn = null;
  }
}

function processQueue() {
  if (_processing || _queue.length === 0) return;
  _processing = true;

  var item = _queue.shift();
  connect()
    .then(function (conn) { return item.fn(conn); })
    .then(function (result) {
      _processing = false;
      item.resolve(result);
      processQueue();
    })
    .catch(function (err) {
      // If connection broke, clean up so next request reconnects
      if (err.message && (err.message.indexOf('ECONN') >= 0 ||
          err.message.indexOf('closed') >= 0 ||
          err.message.indexOf('timeout') >= 0 ||
          err.message.indexOf('EPIPE') >= 0)) {
        console.log('  Connection lost: ' + err.message + ', will reconnect');
        cleanup();
      }
      _processing = false;
      item.reject(err);
      processQueue();
    });
}

function withConnection(fn) {
  return new Promise(function (resolve, reject) {
    _queue.push({ fn: fn, resolve: resolve, reject: reject });
    processQueue();
  });
}

// ── API routes ───────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  try {
    const data = await withConnection(async (conn) => {
      const [stateResult, configResult] = await Promise.all([
        conn.equipment.getEquipmentStateAsync(),
        conn.equipment.getControllerConfigAsync(),
      ]);

      const bodies = (stateResult.bodies || []).map(b => ({
        id: b.id,
        name: b.id === 1 ? 'Pool' : 'Spa',
        currentTemp: b.currentTemp,
        setPoint: b.setPoint,
        heatMode: b.heatMode,
        isActive: b.heatStatus > 0,
      }));

      const stateCircuits = {};
      (stateResult.circuitArray || []).forEach(c => { stateCircuits[c.id] = c; });

      const circuits = (configResult.circuitArray || []).map(c => ({
        id: c.circuitId,
        name: c.name,
        isOn: stateCircuits[c.circuitId] ? stateCircuits[c.circuitId].state === 1 : false,
        isFeature: c.interface === 5,
      }));

      const alerts = [];
      if (stateResult.alarms) alerts.push({ type: 'alarm', message: 'System alarm active' });
      if (stateResult.freezeMode) alerts.push({ type: 'warning', message: 'Freeze protection active' });
      if (stateResult.poolDelay) alerts.push({ type: 'info', message: 'Pool startup delay active' });
      if (stateResult.spaDelay) alerts.push({ type: 'info', message: 'Spa startup delay active' });
      if (stateResult.cleanerDelay) alerts.push({ type: 'info', message: 'Cleaner startup delay active' });

      return {
        bodies,
        circuits,
        alerts,
        airTemp: stateResult.airTemp,
        panelMode: stateResult.panelMode,
      };
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/chemistry', async (req, res) => {
  try {
    const data = await withConnection(async (conn) => {
      const d = await conn.chem.getChemicalDataAsync();
      return {
        phReading: d.pH,
        orpReading: d.orp,
        phSetPoint: d.pHSetPoint,
        orpSetPoint: d.orpSetPoint,
        saturationIndex: d.saturation,
        calcium: d.calcium,
        cyanuricAcid: d.cyanuricAcid,
        alkalinity: d.alkalinity,
        saltPPM: d.saltPPM,
        temperature: d.temperature,
      };
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/chlorinator', async (req, res) => {
  try {
    const data = await withConnection(async (conn) => {
      const d = await conn.chlor.getIntellichlorConfigAsync();
      return {
        isActive: d.installed,
        poolOutput: d.poolSetPoint,
        spaOutput: d.spaSetPoint,
        saltPPM: d.salt,
        status: d.status,
      };
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/circuit', async (req, res) => {
  const { circuitId, state } = req.body;
  if (circuitId === undefined || state === undefined) {
    return res.status(400).json({ ok: false, error: 'circuitId and state are required' });
  }
  try {
    await withConnection(async (conn) => {
      await conn.circuits.setCircuitStateAsync(circuitId, state === 1 ? 1 : 0);
    });
    res.json({ ok: true, message: `Circuit ${circuitId} set to ${state === 1 ? 'ON' : 'OFF'}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/setpoint', async (req, res) => {
  const { bodyId, temperature } = req.body;
  if (bodyId === undefined || temperature === undefined) {
    return res.status(400).json({ ok: false, error: 'bodyId and temperature are required' });
  }
  try {
    await withConnection(async (conn) => {
      await conn.bodies.setSetPointAsync(bodyId, temperature);
    });
    res.json({ ok: true, message: `Setpoint for body ${bodyId} set to ${temperature}°` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/heatmode', async (req, res) => {
  const { bodyId, heatMode } = req.body;
  if (bodyId === undefined || heatMode === undefined) {
    return res.status(400).json({ ok: false, error: 'bodyId and heatMode are required' });
  }
  try {
    await withConnection(async (conn) => {
      await conn.bodies.setHeatModeAsync(bodyId, heatMode);
    });
    res.json({ ok: true, message: `Heat mode for body ${bodyId} set to ${heatMode}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/lights', async (req, res) => {
  const { command } = req.body;
  if (command === undefined) {
    return res.status(400).json({ ok: false, error: 'command is required' });
  }
  try {
    await withConnection(async (conn) => {
      await conn.circuits.sendLightCommandAsync(command);
    });
    res.json({ ok: true, message: `Light command ${command} sent` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/chlorinator', async (req, res) => {
  const { isActive, poolOutput, spaOutput } = req.body;
  try {
    await withConnection(async (conn) => {
      if (isActive !== undefined) {
        await conn.chlor.setIntellichlorIsActiveAsync(isActive);
      }
      if (poolOutput !== undefined || spaOutput !== undefined) {
        await conn.chlor.setIntellichlorOutputAsync(poolOutput != null ? poolOutput : 50, spaOutput != null ? spaOutput : 0);
      }
    });
    res.json({ ok: true, message: 'Chlorinator updated' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/schedules', async (req, res) => {
  try {
    var data = await withConnection(async function(conn) {
      var configResult = await conn.equipment.getControllerConfigAsync();
      var stateResult = await conn.equipment.getEquipmentStateAsync();
      var schedResult = await conn.schedule.getScheduleDataAsync(0);

      // Build circuit name map
      var circuitNames = {};
      (configResult.circuitArray || []).forEach(function(c) { circuitNames[c.circuitId] = c.name; });

      // Build circuit active state map
      var circuitStates = {};
      (stateResult.circuitArray || []).forEach(function(c) { circuitStates[c.id] = c.state === 1; });

      // Determine if schedule is currently active (circuit is on and current time is within range)
      var now = new Date();
      var nowMins = now.getHours() * 60 + now.getMinutes();
      var dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
      // dayMask: bit 0=Mon, bit 1=Tue, ..., bit 6=Sun
      var dayBit = dayOfWeek === 0 ? 64 : (1 << (dayOfWeek - 1));

      var schedules = (schedResult.data || []).map(function(s) {
        var startH = parseInt(s.startTime.substring(0, 2));
        var startM = parseInt(s.startTime.substring(2, 4));
        var stopH = parseInt(s.stopTime.substring(0, 2));
        var stopM = parseInt(s.stopTime.substring(2, 4));
        var startMins = startH * 60 + startM;
        var stopMins = stopH * 60 + stopM;

        var runsToday = !!(s.dayMask & dayBit);
        var isInTimeWindow;
        if (stopMins > startMins) {
          isInTimeWindow = nowMins >= startMins && nowMins < stopMins;
        } else {
          // overnight schedule
          isInTimeWindow = nowMins >= startMins || nowMins < stopMins;
        }
        var isActive = runsToday && isInTimeWindow && !!circuitStates[s.circuitId];

        return {
          id: s.scheduleId,
          circuitId: s.circuitId,
          circuitName: circuitNames[s.circuitId] || 'Circuit ' + s.circuitId,
          startTime: startH.toString().padStart(2, '0') + ':' + startM.toString().padStart(2, '0'),
          stopTime: stopH.toString().padStart(2, '0') + ':' + stopM.toString().padStart(2, '0'),
          days: s.days,
          dayMask: s.dayMask,
          isActive: isActive,
          runsToday: runsToday,
          heatMode: s.heatCmd,
          heatSetPoint: s.heatSetPoint,
        };
      });

      return { schedules: schedules };
    });
    res.json({ ok: true, data: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Pentair IntelliChlor flags (bitmask) — the "flags" field holds the alerts
var CHLOR_FLAGS = {
  1: { message: 'Low Flow', severity: 'warning' },
  2: { message: 'Low Salt', severity: 'warning' },
  4: { message: 'Very Low Salt', severity: 'alarm' },
  8: { message: 'High Current', severity: 'alarm' },
  16: { message: 'Clean Cell', severity: 'warning' },
  32: { message: 'Low Voltage', severity: 'alarm' },
  64: { message: 'Cold Water Cutoff', severity: 'warning' },
  // bit 128 in flags indicates the chlorinator is generating/active, not an alert
};

function decodeChlorFlags(flags) {
  var alerts = [];
  for (var bit in CHLOR_FLAGS) {
    var val = parseInt(bit);
    if (flags & val) {
      alerts.push({
        source: 'Chlorinator',
        message: CHLOR_FLAGS[val].message,
        severity: CHLOR_FLAGS[val].severity,
        code: val,
      });
    }
  }
  if (alerts.length === 0) {
    alerts.push({ source: 'Chlorinator', message: 'Operating normally', severity: 'ok', code: 0 });
  }
  return alerts;
}

var PANEL_MODES = { 0: 'Local', 1: 'Auto', 2: 'Service', 3: 'Timeout' };

app.get('/api/alerts', async (req, res) => {
  try {
    var data = await withConnection(async function(conn) {
      var stateResult = await conn.equipment.getEquipmentStateAsync();
      var chlorResult = await conn.chlor.getIntellichlorConfigAsync();
      var pumpResult = await conn.pump.getPumpStatusAsync(1).catch(function () { return null; });

      var alerts = [];

      // Decode chlorinator flags (alerts)
      var chlorAlerts = decodeChlorFlags(chlorResult.flags);
      chlorAlerts.forEach(function(a) {
        if (a.severity !== 'ok') alerts.push(a);
      });

      // Decode pump alarms (pumpUnknown1 is the alarm bitmask)
      if (pumpResult && pumpResult.pumpUnknown1) {
        var pumpAlerts = decodePumpAlarms(pumpResult.pumpUnknown1, 1);
        pumpAlerts.forEach(function(a) { alerts.push(a); });
      }

      // System-level alerts
      if (stateResult.freezeMode) {
        alerts.push({ source: 'System', message: 'Freeze protection active', severity: 'warning', code: null });
      }

      // Delays
      if (stateResult.poolDelay) {
        alerts.push({ source: 'System', message: 'Pool startup delay active', severity: 'info', code: null });
      }
      if (stateResult.spaDelay) {
        alerts.push({ source: 'System', message: 'Spa startup delay active', severity: 'info', code: null });
      }
      if (stateResult.cleanerDelay) {
        alerts.push({ source: 'System', message: 'Cleaner startup delay active', severity: 'info', code: null });
      }

      // Panel mode — only alert on unusual modes
      if (stateResult.panelMode === 2) {
        alerts.push({ source: 'System', message: 'Panel is in Service mode', severity: 'warning', code: null });
      } else if (stateResult.panelMode === 3) {
        alerts.push({ source: 'System', message: 'Panel is in Timeout mode', severity: 'warning', code: null });
      }

      return {
        alerts: alerts,
        chlorinator: {
          installed: chlorResult.installed,
          status: chlorResult.status,
          flags: chlorResult.flags,
          statusAlerts: chlorAlerts,
          poolSetPoint: chlorResult.poolSetPoint,
          spaSetPoint: chlorResult.spaSetPoint,
          salt: chlorResult.salt,
          superChlorTimer: chlorResult.superChlorTimer,
        },
        system: {
          panelMode: PANEL_MODES[stateResult.panelMode] || 'Unknown',
          freezeMode: !!stateResult.freezeMode,
          poolDelay: !!stateResult.poolDelay,
          spaDelay: !!stateResult.spaDelay,
          cleanerDelay: !!stateResult.cleanerDelay,
          airTemp: stateResult.airTemp,
        },
      };
    });
    res.json({ ok: true, data: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Pool API is running',
    connected: !!(_conn && _conn.isConnected),
    timestamp: new Date().toISOString(),
  });
});

// Clean shutdown
process.on('SIGTERM', function () { cleanup(); process.exit(0); });
process.on('SIGINT', function () { cleanup(); process.exit(0); });
process.on('uncaughtException', function (err) {
  console.error('  Uncaught exception:', err.message);
  cleanup();
});
process.on('unhandledRejection', function (err) {
  console.error('  Unhandled rejection:', err && err.message ? err.message : err);
  cleanup();
});

// Notification status & test endpoint
app.get('/api/notifications/status', function (req, res) {
  res.json({
    ok: true,
    data: {
      configured: !!(PUSHOVER_USER && PUSHOVER_TOKEN),
      provider: 'Pushover',
      trackedAlerts: Object.keys(_previousAlertKeys),
    },
  });
});

app.post('/api/notifications/test', async function (req, res) {
  try {
    await sendPushNotification('🏊 Pool Alert System', 'Test notification — alerts are working!', 0);
    res.json({ ok: true, message: 'Test notification sent via Pushover' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Chemistry database ──────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'chemistry.db');
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS water_tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_date TEXT NOT NULL,
    total_hardness REAL,
    total_chlorine REAL,
    free_chlorine REAL,
    combined_chlorine REAL,
    ph REAL,
    total_alkalinity REAL,
    cyanuric_acid REAL,
    salt REAL,
    source TEXT DEFAULT 'manual',
    raw_text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Add salt column to existing databases that don't have it yet
try { db.exec('ALTER TABLE water_tests ADD COLUMN salt REAL'); } catch (e) { /* column already exists */ }

// Ideal ranges for pool chemistry
const IDEAL_RANGES = {
  total_hardness:    { min: 200, max: 400, unit: 'ppm', label: 'Total Hardness' },
  total_chlorine:    { min: 1, max: 3, unit: 'ppm', label: 'Total Chlorine' },
  free_chlorine:     { min: 1, max: 3, unit: 'ppm', label: 'Free Chlorine' },
  combined_chlorine: { min: 0, max: 0.5, unit: 'ppm', label: 'Combined Chlorine' },
  ph:                { min: 7.2, max: 7.6, unit: 'pH', label: 'pH' },
  total_alkalinity:  { min: 80, max: 120, unit: 'ppm', label: 'Total Alkalinity' },
  cyanuric_acid:     { min: 30, max: 50, unit: 'ppm', label: 'Cyanuric Acid' },
  salt:              { min: 2700, max: 3400, unit: 'ppm', label: 'Salt' },
};

// Pool volume in gallons — used for dosage calculations
var POOL_GALLONS = 20000;

function generateRecommendations(test) {
  var recs = [];
  for (var key in IDEAL_RANGES) {
    var range = IDEAL_RANGES[key];
    var val = test[key];
    if (val == null) continue;
    if (val < range.min) {
      var target = (range.min + range.max) / 2; // aim for midpoint of ideal
      recs.push({ parameter: range.label, status: 'low', value: val, ideal: range.min + ' - ' + range.max + ' ' + range.unit, action: getDosage(key, 'low', val, target, range) });
    } else if (val > range.max) {
      var target2 = (range.min + range.max) / 2;
      recs.push({ parameter: range.label, status: 'high', value: val, ideal: range.min + ' - ' + range.max + ' ' + range.unit, action: getDosage(key, 'high', val, target2, range) });
    }
  }
  return recs;
}

function fmtWeight(oz) {
  if (oz >= 16) {
    var lbs = Math.floor(oz / 16);
    var rem = Math.round(oz % 16);
    return rem > 0 ? lbs + ' lb ' + rem + ' oz' : lbs + ' lbs';
  }
  return Math.round(oz) + ' oz';
}

function fmtFlOz(floz) {
  if (floz >= 128) {
    var gal = (floz / 128).toFixed(1);
    return gal + ' gal';
  }
  if (floz >= 16) {
    var cups = (floz / 8).toFixed(1);
    return cups + ' cups (' + Math.round(floz) + ' fl oz)';
  }
  return Math.round(floz) + ' fl oz';
}

function getDosage(key, status, current, target, range) {
  var delta = Math.abs(target - current);
  var gal = POOL_GALLONS;

  switch (key) {
    case 'free_chlorine':
    case 'total_chlorine': {
      if (status === 'high') return 'Reduce chlorinator output or wait for chlorine to dissipate naturally. Do not swim until below 5 ppm.';
      // Liquid chlorine (sodium hypochlorite 12.5%): ~1 fl oz per 1 ppm per 1,000 gal
      var liquidOz = delta * (gal / 1000);
      // DiChlor 56% (granular): ~2 oz per 1 ppm per 10,000 gal
      var dichlorOz = delta * (gal / 10000) * 2;
      var action = 'Add ' + fmtFlOz(liquidOz) + ' of liquid chlorine (12.5%)';
      action += ', or ' + fmtWeight(dichlorOz) + ' of DiChlor 56% granular';
      action += ' to raise ' + range.label + ' by ' + delta.toFixed(1) + ' ppm.';
      if (current === 0) action += ' Consider shocking the pool.';
      return action;
    }

    case 'ph': {
      if (status === 'high') {
        // Muriatic acid (31.45%): ~20 fl oz per 0.1 pH drop per 20,000 gal
        // Dry acid (sodium bisulfate): ~12 oz per 0.1 pH drop per 20,000 gal
        var phDrop = current - target;
        var muriaticOz = (phDrop / 0.1) * 20 * (gal / 20000);
        var dryAcidOz = (phDrop / 0.1) * 12 * (gal / 20000);
        return 'Add ' + fmtFlOz(muriaticOz) + ' of muriatic acid (31.45%), or ' + fmtWeight(dryAcidOz) + ' of dry acid (sodium bisulfate) to lower pH by ' + phDrop.toFixed(1) + '. Add to deep end with pump running, retest after 4 hours.';
      } else {
        // Soda ash (sodium carbonate): ~6 oz per 0.1 pH rise per 10,000 gal
        var phRise = target - current;
        var sodaAshOz = (phRise / 0.1) * 6 * (gal / 10000);
        return 'Add ' + fmtWeight(sodaAshOz) + ' of soda ash (sodium carbonate) to raise pH by ' + phRise.toFixed(1) + '. Dissolve in bucket first, add with pump running.';
      }
    }

    case 'total_alkalinity': {
      if (status === 'low') {
        // Sodium bicarbonate (baking soda): ~1.5 lbs per 10 ppm per 10,000 gal
        var bakingSodaLbs = (delta / 10) * 1.5 * (gal / 10000);
        return 'Add ' + bakingSodaLbs.toFixed(1) + ' lbs of sodium bicarbonate (baking soda) to raise alkalinity by ' + Math.round(delta) + ' ppm. Add no more than 2 lbs at a time, retest after 6 hours.';
      } else {
        // Muriatic acid: ~25 fl oz per 10 ppm reduction per 20,000 gal
        var acidOz2 = (delta / 10) * 25 * (gal / 20000);
        return 'Add ' + fmtFlOz(acidOz2) + ' of muriatic acid (31.45%) to lower alkalinity by ' + Math.round(delta) + ' ppm. Add in deep end with pump running. Aerate afterward to restore pH.';
      }
    }

    case 'cyanuric_acid': {
      if (status === 'low') {
        // Cyanuric acid (stabilizer): ~13 oz per 10 ppm per 10,000 gal
        var cyaOz = (delta / 10) * 13 * (gal / 10000);
        return 'Add ' + fmtWeight(cyaOz) + ' of cyanuric acid (stabilizer) to raise CYA by ' + Math.round(delta) + ' ppm. Dissolve in warm water or add to skimmer sock. Takes 3-7 days to fully dissolve.';
      } else {
        var drainPct = Math.round((1 - range.max / current) * 100);
        return 'CYA does not break down chemically. Drain approximately ' + drainPct + '% of the pool water and refill with fresh water to lower CYA from ' + current + ' to ~' + Math.round(range.max) + ' ppm.';
      }
    }

    case 'total_hardness': {
      if (status === 'low') {
        // Calcium chloride (77%): ~1.25 lbs per 10 ppm per 10,000 gal
        var calciumLbs = (delta / 10) * 1.25 * (gal / 10000);
        return 'Add ' + calciumLbs.toFixed(1) + ' lbs of calcium chloride to raise calcium hardness by ' + Math.round(delta) + ' ppm. Dissolve in bucket of pool water first, add slowly near a return jet.';
      } else {
        var drainPct2 = Math.round((1 - range.max / current) * 100);
        return 'Drain approximately ' + drainPct2 + '% of the pool water and refill with fresh water to lower hardness from ' + current + ' to ~' + Math.round(range.max) + ' ppm. You can also use a sequestering agent to manage scaling.';
      }
    }

    case 'salt': {
      if (status === 'low') {
        // Pool salt: ~0.6 lbs per 50 ppm per 1,000 gal → simplifies to lbs = delta * gal / 83333
        var saltLbs = Math.round(delta * gal / 83333);
        return 'Add ' + saltLbs + ' lbs of pool-grade salt (sodium chloride) to raise salt by ' + Math.round(delta) + ' ppm. Pour around the pool perimeter with pump running. Allow 24 hours to fully dissolve and circulate before retesting.';
      } else {
        var drainPct3 = Math.round((1 - range.max / current) * 100);
        return 'Drain approximately ' + drainPct3 + '% of the pool water and refill with fresh water to lower salt from ' + current + ' to ~' + Math.round(range.max) + ' ppm.';
      }
    }

    case 'combined_chlorine': {
      // Breakpoint chlorination: need to add 10x the combined chlorine level
      var shockPpm = current * 10;
      var shockLiquidOz = shockPpm * (gal / 1000);
      return 'Shock the pool to breakpoint chlorination. Add ' + fmtFlOz(shockLiquidOz) + ' of liquid chlorine (12.5%) to add ' + shockPpm.toFixed(1) + ' ppm FC (10x combined chlorine). Run pump for 8+ hours, preferably at dusk.';
    }

    default:
      return 'Adjust ' + range.label + ' to within ideal range (' + range.min + '-' + range.max + ' ' + range.unit + ').';
  }
}

// Parse AquaCheck email text
function parseAquaCheckEmail(text) {
  var result = { source: 'aquacheck' };

  // Extract date - look for patterns like "13 April 2026" or "April 13, 2026"
  var dateMatch = text.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (!dateMatch) {
    dateMatch = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i);
    if (dateMatch) {
      var months = { january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };
      var m = months[dateMatch[1].toLowerCase()];
      var d = parseInt(dateMatch[2]);
      var y = parseInt(dateMatch[3]);
      result.test_date = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }
  } else {
    var months2 = { january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };
    var m2 = months2[dateMatch[2].toLowerCase()];
    var d2 = parseInt(dateMatch[1]);
    var y2 = parseInt(dateMatch[3]);
    result.test_date = y2 + '-' + String(m2).padStart(2, '0') + '-' + String(d2).padStart(2, '0');
  }

  if (!result.test_date) {
    result.test_date = new Date().toISOString().split('T')[0];
  }

  // Helper: extract a value for a parameter. First tries the title line
  // ("Parameter - Value unit"), then falls back to the "Your value is X" line
  // in the paragraph following that parameter header. AquaCheck sometimes puts
  // the ideal range on the title line instead of the reading.
  function extractValue(txt, paramName, unit) {
    // Build a regex for the section starting with the parameter name
    var sectionRe = new RegExp(paramName + '\\s*[-–][^\\n]*\\n([\\s\\S]*?)(?=\\n\\n|$)', 'i');
    var section = txt.match(sectionRe);

    // Try title line first: "Parameter - 1.0 ppm" (single number, not a range like "30-50")
    var titleRe = new RegExp(paramName + '\\s*[-–]\\s*(\\d+\\.?\\d*)\\s*' + unit, 'i');
    var titleMatch = txt.match(titleRe);
    if (titleMatch) return parseFloat(titleMatch[1]);

    // Fallback: "Your value is X unit" in the section body
    if (section) {
      var bodyMatch = section[1].match(/Your value is\s*([\d.]+)\s*/i);
      if (bodyMatch) return parseFloat(bodyMatch[1]);
    }
    return undefined;
  }

  result.total_hardness = extractValue(text, 'Total Hardness', 'ppm');
  result.total_chlorine = extractValue(text, 'Total Chlorine', 'ppm');
  result.free_chlorine = extractValue(text, 'Free Chlorine', 'ppm');
  result.ph = extractValue(text, 'pH', 'pH');
  result.total_alkalinity = extractValue(text, 'Total Alkalinity', 'ppm');
  result.cyanuric_acid = extractValue(text, 'Cyanuric Acid', 'ppm');

  // Combined chlorine - sometimes listed explicitly, otherwise calculate
  var combinedMatch = text.match(/Combined Chlorine\s*(?:Value\s*(?:is)?)?\s*([\d.]+)\s*ppm/i);
  if (combinedMatch) {
    result.combined_chlorine = parseFloat(combinedMatch[1]);
  } else if (result.total_chlorine != null && result.free_chlorine != null) {
    result.combined_chlorine = Math.max(0, result.total_chlorine - result.free_chlorine);
  }

  return result;
}

// Helper: read current salt from chlorinator (best-effort, returns null on failure)
function getCurrentSalt() {
  return withConnection(function (conn) {
    return conn.chlor.getIntellichlorConfigAsync().then(function (d) { return d.salt || null; });
  }).catch(function () { return null; });
}

// POST /api/water-test/upload — parse and store email text
app.post('/api/water-test/upload', async function (req, res) {
  try {
    var emailText = req.body.text;
    if (!emailText || typeof emailText !== 'string') {
      return res.status(400).json({ ok: false, error: 'text field is required' });
    }

    var parsed = parseAquaCheckEmail(emailText);

    // Auto-capture salt from chlorinator
    var salt = await getCurrentSalt();

    var stmt = db.prepare(`
      INSERT INTO water_tests (test_date, total_hardness, total_chlorine, free_chlorine, combined_chlorine, ph, total_alkalinity, cyanuric_acid, salt, source, raw_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    var info = stmt.run(
      parsed.test_date,
      parsed.total_hardness ?? null,
      parsed.total_chlorine ?? null,
      parsed.free_chlorine ?? null,
      parsed.combined_chlorine ?? null,
      parsed.ph ?? null,
      parsed.total_alkalinity ?? null,
      parsed.cyanuric_acid ?? null,
      salt,
      parsed.source || 'aquacheck',
      emailText
    );

    var test = db.prepare('SELECT * FROM water_tests WHERE id = ?').get(info.lastInsertRowid);
    var recommendations = generateRecommendations(test);

    res.json({ ok: true, data: { test: test, recommendations: recommendations } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/water-test/manual — store manually entered values
app.post('/api/water-test/manual', async function (req, res) {
  try {
    var b = req.body;
    if (!b.test_date) {
      return res.status(400).json({ ok: false, error: 'test_date is required' });
    }

    // Auto-capture salt from chlorinator if not provided
    var salt = b.salt ?? await getCurrentSalt();

    var stmt = db.prepare(`
      INSERT INTO water_tests (test_date, total_hardness, total_chlorine, free_chlorine, combined_chlorine, ph, total_alkalinity, cyanuric_acid, salt, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
    `);
    var info = stmt.run(
      b.test_date,
      b.total_hardness ?? null,
      b.total_chlorine ?? null,
      b.free_chlorine ?? null,
      b.combined_chlorine ?? null,
      b.ph ?? null,
      b.total_alkalinity ?? null,
      b.cyanuric_acid ?? null,
      salt
    );

    var test = db.prepare('SELECT * FROM water_tests WHERE id = ?').get(info.lastInsertRowid);
    var recommendations = generateRecommendations(test);

    res.json({ ok: true, data: { test: test, recommendations: recommendations } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/water-tests — fetch history
app.get('/api/water-tests', function (req, res) {
  try {
    var limit = parseInt(req.query.limit) || 50;
    var tests = db.prepare('SELECT * FROM water_tests ORDER BY test_date DESC, created_at DESC LIMIT ?').all(limit);
    // Generate recommendations for the most recent test
    var latest = tests[0] || null;
    var recommendations = latest ? generateRecommendations(latest) : [];

    res.json({ ok: true, data: { tests: tests, latest: latest, recommendations: recommendations, idealRanges: IDEAL_RANGES } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/water-test/:id — delete a test
app.delete('/api/water-test/:id', function (req, res) {
  try {
    var id = parseInt(req.params.id);
    var info = db.prepare('DELETE FROM water_tests WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Test not found' });
    }
    res.json({ ok: true, message: 'Test deleted' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🏊 Pool API running on http://localhost:${PORT}`);
  console.log(`   Gateway: ${MANUAL_IP ? MANUAL_IP + ':' + MANUAL_PORT : 'auto-discovery'}`);
  console.log(`   Mode: persistent connection with request queue\n`);

  // Start background alert monitor after server is up
  startAlertMonitor();
});
