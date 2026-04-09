const express = require('express');
const cors = require('cors');
const ScreenLogic = require('node-screenlogic');

const app = express();
const PORT = process.env.PORT || 3000;
const MANUAL_IP = process.env.SL_IP || null;
const MANUAL_PORT = parseInt(process.env.SL_PORT || '80');

app.use(cors());
app.use(express.json());

async function withConnection(fn) {
  const conn = new ScreenLogic.UnitConnection();

  if (MANUAL_IP) {
    conn.initUnit({ address: MANUAL_IP, port: MANUAL_PORT, gatewayName: '', type: 0 });
  } else {
    const finder = new ScreenLogic.FindUnits();
    const unit = await finder.searchAsync();
    await finder.close();
    if (!unit || !unit.address) throw new Error('No ScreenLogic gateway found on network');
    conn.initUnit(unit);
  }

  try {
    await conn.connectAsync();
    const result = await fn(conn);
    await conn.closeAsync();
    return result;
  } catch (err) {
    try { await conn.closeAsync(); } catch (_) {}
    throw err;
  }
}

app.get('/api/status', async (req, res) => {
  try {
    const data = await withConnection(async (conn) => {
      const [stateResult, configResult] = await Promise.all([
        conn.equipment.getEquipmentStateAsync(),
        conn.equipment.getControllerConfigAsync(),
      ]);

      const bodies = (stateResult.ok ? stateResult.data.bodyArray : []).map(b => ({
        id: b.id,
        name: b.id === 0 ? 'Pool' : 'Spa',
        currentTemp: b.currentTemp,
        setPoint: b.heatSetPoint,
        heatMode: b.heatMode,
        isActive: b.isActive,
      }));

      const circuits = (configResult.ok ? configResult.data.circuitArray : []).map(c => ({
        id: c.id,
        name: c.name,
        isOn: c.isActive,
        isFeature: c.isFeature,
      }));

      return { bodies, circuits };
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/chemistry', async (req, res) => {
  try {
    const data = await withConnection(async (conn) => {
      const result = await conn.chem.getChemicalDataAsync();
      if (!result.ok) throw new Error('Could not retrieve chemistry data');
      const d = result.data;
      return {
        phReading: d.phReading,
        orpReading: d.orpReading,
        phSetPoint: d.phSetPoint,
        orpSetPoint: d.orpSetPoint,
        saturationIndex: d.saturationIndex,
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
      const result = await conn.chlor.getIntellichlorConfigAsync();
      if (!result.ok) throw new Error('Could not retrieve chlorinator data');
      const d = result.data;
      return {
        isActive: d.isActive,
        poolOutput: d.poolOutput,
        spaOutput: d.spaOutput,
        saltPPM: d.saltPPM,
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
        await conn.chlor.setIntellichlorOutputAsync(poolOutput ?? 50, spaOutput ?? 0);
      }
    });
    res.json({ ok: true, message: 'Chlorinator updated' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Pool API is running', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n🏊 Pool API running on http://localhost:${PORT}`);
  console.log(`   Gateway: ${MANUAL_IP ? MANUAL_IP + ':' + MANUAL_PORT : 'auto-discovery'}\n`);
});
