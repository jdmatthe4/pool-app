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
    source TEXT DEFAULT 'manual',
    raw_text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Ideal ranges for pool chemistry
const IDEAL_RANGES = {
  total_hardness:    { min: 200, max: 400, unit: 'ppm', label: 'Total Hardness' },
  total_chlorine:    { min: 1, max: 3, unit: 'ppm', label: 'Total Chlorine' },
  free_chlorine:     { min: 1, max: 3, unit: 'ppm', label: 'Free Chlorine' },
  combined_chlorine: { min: 0, max: 0.5, unit: 'ppm', label: 'Combined Chlorine' },
  ph:                { min: 7.2, max: 7.6, unit: 'pH', label: 'pH' },
  total_alkalinity:  { min: 80, max: 120, unit: 'ppm', label: 'Total Alkalinity' },
  cyanuric_acid:     { min: 30, max: 50, unit: 'ppm', label: 'Cyanuric Acid' },
};

function generateRecommendations(test) {
  var recs = [];
  for (var key in IDEAL_RANGES) {
    var range = IDEAL_RANGES[key];
    var val = test[key];
    if (val == null) continue;
    if (val < range.min) {
      recs.push({ parameter: range.label, status: 'low', value: val, ideal: range.min + ' - ' + range.max + ' ' + range.unit, action: getAction(key, 'low', val, range) });
    } else if (val > range.max) {
      recs.push({ parameter: range.label, status: 'high', value: val, ideal: range.min + ' - ' + range.max + ' ' + range.unit, action: getAction(key, 'high', val, range) });
    }
  }
  return recs;
}

function getAction(key, status, value, range) {
  var actions = {
    ph: {
      high: 'Add muriatic acid or dry acid (pH decreaser) to lower pH',
      low: 'Add soda ash (sodium carbonate) to raise pH',
    },
    free_chlorine: {
      low: 'Add liquid chlorine, DiChlor, or TriChlor to raise chlorine level. Shock the pool if very low.',
      high: 'Reduce chlorinator output or wait for chlorine to dissipate. Do not swim until below 5 ppm.',
    },
    total_chlorine: {
      low: 'Add chlorine to raise total chlorine level',
      high: 'High total chlorine with normal free chlorine indicates combined chlorine (chloramines). Shock the pool.',
    },
    combined_chlorine: {
      high: 'Combined chlorine indicates chloramines. Shock the pool with a breakpoint chlorination (10x the combined chlorine level).',
    },
    total_alkalinity: {
      low: 'Add sodium bicarbonate (baking soda) to raise alkalinity',
      high: 'Add muriatic acid to lower alkalinity. Aerate the pool to raise pH back up afterward.',
    },
    cyanuric_acid: {
      low: 'Add cyanuric acid (stabilizer/conditioner) to protect chlorine from UV breakdown',
      high: 'Dilute by partially draining and refilling with fresh water. CYA does not break down chemically.',
    },
    total_hardness: {
      low: 'Add calcium chloride to raise calcium hardness',
      high: 'Dilute by partially draining and refilling with fresh water, or use a sequestering agent.',
    },
  };
  return (actions[key] && actions[key][status]) || ('Adjust ' + IDEAL_RANGES[key].label + ' to within ideal range');
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

  // Parse values - look for "Parameter - Value unit" pattern
  var hardnessMatch = text.match(/Total Hardness\s*[-–]\s*([\d.]+)\s*ppm/i);
  if (hardnessMatch) result.total_hardness = parseFloat(hardnessMatch[1]);

  var totalChlorMatch = text.match(/Total Chlorine\s*[-–]\s*([\d.]+)\s*ppm/i);
  if (totalChlorMatch) result.total_chlorine = parseFloat(totalChlorMatch[1]);

  var freeChlorMatch = text.match(/Free Chlorine\s*[-–]\s*([\d.]+)\s*ppm/i);
  if (freeChlorMatch) result.free_chlorine = parseFloat(freeChlorMatch[1]);

  // Combined chlorine - sometimes listed explicitly, otherwise calculate
  var combinedMatch = text.match(/Combined Chlorine\s*(?:Value\s*(?:is)?)?\s*([\d.]+)\s*ppm/i);
  if (combinedMatch) {
    result.combined_chlorine = parseFloat(combinedMatch[1]);
  } else if (result.total_chlorine != null && result.free_chlorine != null) {
    result.combined_chlorine = Math.max(0, result.total_chlorine - result.free_chlorine);
  }

  var phMatch = text.match(/pH\s*[-–]\s*([\d.]+)/i);
  if (phMatch) result.ph = parseFloat(phMatch[1]);

  var alkMatch = text.match(/Total Alkalinity\s*[-–]\s*([\d.]+)\s*ppm/i);
  if (alkMatch) result.total_alkalinity = parseFloat(alkMatch[1]);

  var cyaMatch = text.match(/Cyanuric Acid\s*[-–]\s*([\d.]+)\s*ppm/i);
  if (cyaMatch) result.cyanuric_acid = parseFloat(cyaMatch[1]);

  return result;
}

// POST /api/water-test/upload — parse and store email text
app.post('/api/water-test/upload', function (req, res) {
  try {
    var emailText = req.body.text;
    if (!emailText || typeof emailText !== 'string') {
      return res.status(400).json({ ok: false, error: 'text field is required' });
    }

    var parsed = parseAquaCheckEmail(emailText);
    var stmt = db.prepare(`
      INSERT INTO water_tests (test_date, total_hardness, total_chlorine, free_chlorine, combined_chlorine, ph, total_alkalinity, cyanuric_acid, source, raw_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
app.post('/api/water-test/manual', function (req, res) {
  try {
    var b = req.body;
    if (!b.test_date) {
      return res.status(400).json({ ok: false, error: 'test_date is required' });
    }

    var stmt = db.prepare(`
      INSERT INTO water_tests (test_date, total_hardness, total_chlorine, free_chlorine, combined_chlorine, ph, total_alkalinity, cyanuric_acid, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')
    `);
    var info = stmt.run(
      b.test_date,
      b.total_hardness ?? null,
      b.total_chlorine ?? null,
      b.free_chlorine ?? null,
      b.combined_chlorine ?? null,
      b.ph ?? null,
      b.total_alkalinity ?? null,
      b.cyanuric_acid ?? null
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
