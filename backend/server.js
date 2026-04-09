const express = require('express');
const cors = require('cors');
const ScreenLogic = require('node-screenlogic');
const https = require('https');

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
      ]).then(function (results) {
        var stateResult = results[0];
        var chlorResult = results[1];

        var currentAlerts = [];

        // Chlorinator alerts
        var chlorAlerts = decodeChlorFlags(chlorResult.flags);
        chlorAlerts.forEach(function (a) {
          if (a.severity !== 'ok') currentAlerts.push(a);
        });

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

        // Send Pushover notification for each new alert
        newAlerts.forEach(function (a) {
          var priority = a.severity === 'alarm' ? 1 : 0;
          sendPushNotification(
            '🏊 Pool Alert',
            a.source + ': ' + a.message,
            priority
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

      var alerts = [];

      // Decode chlorinator flags (alerts)
      var chlorAlerts = decodeChlorFlags(chlorResult.flags);
      chlorAlerts.forEach(function(a) {
        if (a.severity !== 'ok') alerts.push(a);
      });

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

app.listen(PORT, () => {
  console.log(`\n🏊 Pool API running on http://localhost:${PORT}`);
  console.log(`   Gateway: ${MANUAL_IP ? MANUAL_IP + ':' + MANUAL_PORT : 'auto-discovery'}`);
  console.log(`   Mode: persistent connection with request queue\n`);

  // Start background alert monitor after server is up
  startAlertMonitor();
});
