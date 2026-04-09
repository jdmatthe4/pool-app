import { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || '';

const HEAT_MODES = ['Off', 'Solar', 'Solar Preferred', 'Heater', 'Dual Heat'];

const LIGHT_COMMANDS = [
  { label: 'Off',        cmd: 0, color: '#555' },
  { label: 'On',         cmd: 1, color: '#f5c842' },
  { label: 'Color Set',  cmd: 2, color: '#a78bfa' },
  { label: 'Color Sync', cmd: 3, color: '#60a5fa' },
  { label: 'Party',      cmd: 5, color: '#f472b6' },
  { label: 'Romance',    cmd: 6, color: '#fb923c' },
  { label: 'Caribbean',  cmd: 7, color: '#34d399' },
  { label: 'American',   cmd: 8, color: '#ef4444' },
  { label: 'Sunset',     cmd: 9, color: '#f59e0b' },
  { label: 'Royal',      cmd: 10, color: '#818cf8' },
];

function usePoll(fn, ms) {
  useEffect(() => {
    fn();
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, [fn, ms]);
}

async function apiGet(path) {
  const r = await fetch(`${API}/api/${path}`);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(`${API}/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function TempRing({ temp, setPoint, label, isActive }) {
  const max = 104, min = 50;
  const pct = Math.max(0, Math.min(1, (temp - min) / (max - min)));
  const r = 48, cx = 60, cy = 60;
  const circ = 2 * Math.PI * r;
  const dash = pct * circ * 0.75;
  const spPct = Math.max(0, Math.min(1, (setPoint - min) / (max - min)));
  const angle = -225 + spPct * 270;
  const rad = (angle * Math.PI) / 180;
  const spX = cx + (r + 2) * Math.cos(rad);
  const spY = cy + (r + 2) * Math.sin(rad);

  return (
    <div style={{ textAlign: 'center' }}>
      <svg width="120" height="120" style={{ overflow: 'visible' }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="8"
          strokeDasharray={`${circ * 0.75} ${circ * 0.25}`}
          strokeDashoffset={circ * 0.125}
          strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={r} fill="none"
          stroke={isActive ? '#38bdf8' : 'rgba(255,255,255,0.2)'} strokeWidth="8"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ * 0.125}
          strokeLinecap="round"
          style={{ transition: 'all 0.8s ease' }} />
        <circle cx={spX} cy={spY} r="4" fill="#f59e0b" opacity="0.9" />
        <text x={cx} y={cy - 8} textAnchor="middle" fill="white" fontSize="22" fontWeight="600"
          fontFamily="DM Sans, sans-serif">{temp ?? '--'}°</text>
        <text x={cx} y={cy + 12} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="11"
          fontFamily="DM Sans, sans-serif">{label}</text>
        <text x={cx} y={cy + 28} textAnchor="middle" fill="rgba(255,255,255,0.35)" fontSize="10"
          fontFamily="DM Mono, monospace">sp {setPoint ?? '--'}°</text>
      </svg>
    </div>
  );
}

function CircuitButton({ circuit, onToggle, loading }) {
  const on = circuit.isOn;
  return (
    <button onClick={() => onToggle(circuit.id, on ? 0 : 1)} disabled={loading}
      style={{
        background: on ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.04)',
        border: on ? '1px solid rgba(56,189,248,0.4)' : '1px solid rgba(255,255,255,0.1)',
        borderRadius: '10px',
        padding: '12px 14px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        transition: 'all 0.2s ease',
        opacity: loading ? 0.6 : 1,
        width: '100%',
      }}>
      <span style={{
        width: 10, height: 10, borderRadius: '50%',
        background: on ? '#38bdf8' : 'rgba(255,255,255,0.2)',
        boxShadow: on ? '0 0 6px #38bdf8' : 'none',
        flexShrink: 0,
        transition: 'all 0.2s',
      }} />
      <span style={{ color: on ? 'white' : 'rgba(255,255,255,0.5)', fontSize: 13,
        fontFamily: 'DM Sans', fontWeight: on ? 500 : 400 }}>
        {circuit.name}
      </span>
    </button>
  );
}

function ChemRow({ label, value, unit, low, high, ideal }) {
  const inRange = value >= low && value <= high;
  const pct = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, fontFamily: 'DM Sans' }}>{label}</span>
        <span style={{ color: inRange ? '#4ade80' : '#f87171', fontSize: 13, fontFamily: 'DM Mono', fontWeight: 500 }}>
          {value ?? '--'} {unit}
        </span>
      </div>
      <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, position: 'relative' }}>
        <div style={{
          position: 'absolute', left: `${pct * 100}%`, top: -2, width: 8, height: 8,
          background: inRange ? '#4ade80' : '#f87171', borderRadius: '50%', transform: 'translateX(-50%)',
          transition: 'left 0.6s ease',
        }} />
        <div style={{
          position: 'absolute', left: '25%', right: '25%', top: 0, height: 4,
          background: 'rgba(74,222,128,0.2)', borderRadius: 2,
        }} />
      </div>
    </div>
  );
}

function Toast({ message, type }) {
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24,
      background: type === 'error' ? '#ef4444' : '#0ea5e9',
      color: 'white', padding: '10px 18px', borderRadius: 10,
      fontSize: 13, fontFamily: 'DM Sans', boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      zIndex: 999, animation: 'fadeIn 0.2s ease',
    }}>
      {message}
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [chemistry, setChemistry] = useState(null);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState({});
  const [activeTab, setActiveTab] = useState('dashboard');
  const [tempInputs, setTempInputs] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);

  const showToast = (msg, type = 'info') => {
    setToast({ message: msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchStatus = useCallback(async () => {
    try {
      const r = await apiGet('status');
      if (r.ok) { setStatus(r.data); setLastUpdated(new Date()); }
    } catch (e) { /* silently fail on poll */ }
  }, []);

  const fetchChemistry = useCallback(async () => {
    try {
      const r = await apiGet('chemistry');
      if (r.ok) setChemistry(r.data);
    } catch (e) {}
  }, []);

  usePoll(fetchStatus, 5000);
  usePoll(fetchChemistry, 30000);

  const toggleCircuit = async (circuitId, state) => {
    setLoading(l => ({ ...l, [circuitId]: true }));
    try {
      const r = await apiPost('circuit', { circuitId, state });
      if (r.ok) { showToast(r.message); fetchStatus(); }
      else showToast(r.error, 'error');
    } catch (e) { showToast('Connection error', 'error'); }
    setLoading(l => ({ ...l, [circuitId]: false }));
  };

  const setHeatMode = async (bodyId, heatMode) => {
    try {
      const r = await apiPost('heatmode', { bodyId, heatMode });
      if (r.ok) { showToast(r.message); fetchStatus(); }
      else showToast(r.error, 'error');
    } catch (e) { showToast('Connection error', 'error'); }
  };

  const setSetPoint = async (bodyId) => {
    const temp = parseInt(tempInputs[bodyId]);
    if (!temp || temp < 50 || temp > 104) return showToast('Temperature must be 50–104°F', 'error');
    try {
      const r = await apiPost('setpoint', { bodyId, temperature: temp });
      if (r.ok) { showToast(r.message); fetchStatus(); }
      else showToast(r.error, 'error');
    } catch (e) { showToast('Connection error', 'error'); }
  };

  const sendLightCommand = async (cmd) => {
    setLoading(l => ({ ...l, lights: true }));
    try {
      const r = await apiPost('lights', { command: cmd });
      if (r.ok) showToast(`Lights: ${r.message}`);
      else showToast(r.error, 'error');
    } catch (e) { showToast('Connection error', 'error'); }
    setLoading(l => ({ ...l, lights: false }));
  };

  const bg = `
    radial-gradient(ellipse at 20% 80%, rgba(14,165,233,0.12) 0%, transparent 60%),
    radial-gradient(ellipse at 80% 20%, rgba(99,102,241,0.08) 0%, transparent 50%),
    #080e1a
  `;

  const card = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 16,
    padding: '20px 24px',
    backdropFilter: 'blur(8px)',
  };

  const tab = (id, label) => ({
    background: activeTab === id ? 'rgba(56,189,248,0.15)' : 'transparent',
    border: activeTab === id ? '1px solid rgba(56,189,248,0.3)' : '1px solid transparent',
    color: activeTab === id ? '#38bdf8' : 'rgba(255,255,255,0.4)',
    borderRadius: 8, padding: '7px 18px',
    cursor: 'pointer', fontSize: 13, fontFamily: 'DM Sans', fontWeight: 500,
    transition: 'all 0.2s',
  });

  const pool = status?.bodies?.find(b => b.id === 0);
  const spa = status?.bodies?.find(b => b.id === 1);
  const circuits = status?.circuits ?? [];

  return (
    <div style={{ minHeight: '100vh', background: bg, padding: '24px', boxSizing: 'border-box',
      fontFamily: 'DM Sans, sans-serif' }}>
      <style>{`
        @keyframes fadeIn { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:translateY(0) } }
        * { box-sizing: border-box; }
        button:hover:not(:disabled) { filter: brightness(1.15); }
        input { outline: none; }
        select { outline: none; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
      `}</style>

      <div style={{ maxWidth: 900, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
          <div>
            <h1 style={{ color: 'white', fontSize: 24, fontWeight: 600, margin: 0, letterSpacing: '-0.5px' }}>
              Pool Control
            </h1>
            <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12, margin: '4px 0 0',
              fontFamily: 'DM Mono' }}>
              {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Connecting...'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {['dashboard','circuits','chemistry','lights'].map(t => (
              <button key={t} onClick={() => setActiveTab(t)} style={tab(t, t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Pool body */}
            {pool && (
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                  <h2 style={{ color: 'white', fontSize: 16, fontWeight: 500, margin: 0 }}>Pool</h2>
                  <span style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 20,
                    background: pool.isActive ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.06)',
                    color: pool.isActive ? '#38bdf8' : 'rgba(255,255,255,0.3)',
                    border: pool.isActive ? '1px solid rgba(56,189,248,0.3)' : '1px solid transparent',
                  }}>
                    {pool.isActive ? 'Active' : 'Standby'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
                  <TempRing temp={pool.currentTemp} setPoint={pool.setPoint} label="Pool" isActive={pool.isActive} />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select value={pool.heatMode} onChange={e => setHeatMode(0, parseInt(e.target.value))}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                      color: 'white', borderRadius: 8, padding: '8px 10px', fontSize: 12,
                      fontFamily: 'DM Sans', cursor: 'pointer' }}>
                    {HEAT_MODES.map((m, i) => <option key={i} value={i}>{m}</option>)}
                  </select>
                  <input type="number" min="50" max="104" placeholder="°F"
                    value={tempInputs[0] ?? ''}
                    onChange={e => setTempInputs(t => ({ ...t, 0: e.target.value }))}
                    style={{ width: 60, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                      color: 'white', borderRadius: 8, padding: '8px', fontSize: 12,
                      fontFamily: 'DM Mono', textAlign: 'center' }} />
                  <button onClick={() => setSetPoint(0)}
                    style={{ background: '#0ea5e9', border: 'none', color: 'white',
                      borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontSize: 12,
                      fontFamily: 'DM Sans', fontWeight: 500 }}>Set</button>
                </div>
              </div>
            )}

            {/* Spa body */}
            {spa && (
              <div style={card}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                  <h2 style={{ color: 'white', fontSize: 16, fontWeight: 500, margin: 0 }}>Spa</h2>
                  <span style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 20,
                    background: spa.isActive ? 'rgba(251,146,60,0.15)' : 'rgba(255,255,255,0.06)',
                    color: spa.isActive ? '#fb923c' : 'rgba(255,255,255,0.3)',
                    border: spa.isActive ? '1px solid rgba(251,146,60,0.3)' : '1px solid transparent',
                  }}>
                    {spa.isActive ? 'Active' : 'Standby'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
                  <TempRing temp={spa.currentTemp} setPoint={spa.setPoint} label="Spa" isActive={spa.isActive} />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select value={spa.heatMode} onChange={e => setHeatMode(1, parseInt(e.target.value))}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                      color: 'white', borderRadius: 8, padding: '8px 10px', fontSize: 12,
                      fontFamily: 'DM Sans', cursor: 'pointer' }}>
                    {HEAT_MODES.map((m, i) => <option key={i} value={i}>{m}</option>)}
                  </select>
                  <input type="number" min="50" max="104" placeholder="°F"
                    value={tempInputs[1] ?? ''}
                    onChange={e => setTempInputs(t => ({ ...t, 1: e.target.value }))}
                    style={{ width: 60, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                      color: 'white', borderRadius: 8, padding: '8px', fontSize: 12,
                      fontFamily: 'DM Mono', textAlign: 'center' }} />
                  <button onClick={() => setSetPoint(1)}
                    style={{ background: '#fb923c', border: 'none', color: 'white',
                      borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontSize: 12,
                      fontFamily: 'DM Sans', fontWeight: 500 }}>Set</button>
                </div>
              </div>
            )}

            {/* Quick circuits (first 4) */}
            <div style={{ ...card, gridColumn: '1 / -1' }}>
              <h2 style={{ color: 'white', fontSize: 16, fontWeight: 500, margin: '0 0 16px' }}>Quick Controls</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
                {circuits.slice(0, 8).map(c => (
                  <CircuitButton key={c.id} circuit={c} onToggle={toggleCircuit} loading={loading[c.id]} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Circuits Tab */}
        {activeTab === 'circuits' && (
          <div style={card}>
            <h2 style={{ color: 'white', fontSize: 16, fontWeight: 500, margin: '0 0 20px' }}>
              All Circuits ({circuits.length})
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
              {circuits.map(c => (
                <CircuitButton key={c.id} circuit={c} onToggle={toggleCircuit} loading={loading[c.id]} />
              ))}
            </div>
          </div>
        )}

        {/* Chemistry Tab */}
        {activeTab === 'chemistry' && chemistry && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div style={card}>
              <h2 style={{ color: 'white', fontSize: 16, fontWeight: 500, margin: '0 0 20px' }}>Water Chemistry</h2>
              <ChemRow label="pH" value={chemistry.phReading} unit="" low={7.2} high={7.8} />
              <ChemRow label="ORP" value={chemistry.orpReading} unit="mV" low={650} high={800} />
              <ChemRow label="Saturation Index" value={chemistry.saturationIndex} unit="" low={-0.3} high={0.3} />
            </div>
            <div style={card}>
              <h2 style={{ color: 'white', fontSize: 16, fontWeight: 500, margin: '0 0 20px' }}>Levels</h2>
              <ChemRow label="Calcium Hardness" value={chemistry.calcium} unit="ppm" low={200} high={400} />
              <ChemRow label="Cyanuric Acid" value={chemistry.cyanuricAcid} unit="ppm" low={30} high={80} />
              <ChemRow label="Total Alkalinity" value={chemistry.alkalinity} unit="ppm" low={80} high={120} />
              <ChemRow label="Salt" value={chemistry.saltPPM} unit="ppm" low={2700} high={3400} />
            </div>
            <div style={{ ...card, gridColumn: '1 / -1' }}>
              <div style={{ display: 'flex', gap: 24 }}>
                <div>
                  <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, margin: '0 0 4px', fontFamily: 'DM Mono' }}>SETPOINTS</p>
                  <p style={{ color: 'white', fontSize: 13, margin: '0 0 4px' }}>
                    pH: <span style={{ color: '#38bdf8', fontFamily: 'DM Mono' }}>{chemistry.phSetPoint}</span>
                    &nbsp;&nbsp; ORP: <span style={{ color: '#38bdf8', fontFamily: 'DM Mono' }}>{chemistry.orpSetPoint} mV</span>
                  </p>
                </div>
                <div>
                  <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, margin: '0 0 4px', fontFamily: 'DM Mono' }}>WATER TEMP</p>
                  <p style={{ color: 'white', fontSize: 13, margin: 0, fontFamily: 'DM Mono' }}>{chemistry.temperature}°F</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'chemistry' && !chemistry && (
          <div style={{ ...card, textAlign: 'center', padding: 48 }}>
            <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14 }}>
              No chemistry data — IntelliChem may not be installed.
            </p>
          </div>
        )}

        {/* Lights Tab */}
        {activeTab === 'lights' && (
          <div style={card}>
            <h2 style={{ color: 'white', fontSize: 16, fontWeight: 500, margin: '0 0 6px' }}>Light Controls</h2>
            <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12, margin: '0 0 24px' }}>
              IntelliBrite & color light commands
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
              {LIGHT_COMMANDS.map(lc => (
                <button key={lc.cmd} onClick={() => sendLightCommand(lc.cmd)}
                  disabled={loading.lights}
                  style={{
                    background: `${lc.color}18`,
                    border: `1px solid ${lc.color}40`,
                    borderRadius: 10, padding: '14px 10px',
                    cursor: 'pointer', color: 'white', fontSize: 13,
                    fontFamily: 'DM Sans', fontWeight: 500,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                    transition: 'all 0.2s', opacity: loading.lights ? 0.5 : 1,
                  }}>
                  <span style={{ width: 14, height: 14, borderRadius: '50%',
                    background: lc.color, boxShadow: `0 0 8px ${lc.color}80` }} />
                  {lc.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {!status && (
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            textAlign: 'center' }}>
            <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 14, fontFamily: 'DM Mono' }}>
              Connecting to gateway...
            </div>
          </div>
        )}

      </div>

      {toast && <Toast message={toast.message} type={toast.type} />}
    </div>
  );
}
