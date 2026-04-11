import { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || '';

const HEAT_MODES = ['Off', 'Solar', 'Solar Preferred', 'Heater', 'Dual Heat'];

const LIGHT_COMMANDS = [
  { label: 'Off',        cmd: 0, color: '#64748b', icon: '\u25CB' },
  { label: 'On',         cmd: 1, color: '#facc15', icon: '\u2600' },
  { label: 'Color Set',  cmd: 2, color: '#a78bfa', icon: '\u25C9' },
  { label: 'Color Sync', cmd: 3, color: '#60a5fa', icon: '\u21BB' },
  { label: 'Party',      cmd: 5, color: '#f472b6', icon: '\u2605' },
  { label: 'Romance',    cmd: 6, color: '#fb923c', icon: '\u2665' },
  { label: 'Caribbean',  cmd: 7, color: '#34d399', icon: '\u223F' },
  { label: 'American',   cmd: 8, color: '#ef4444', icon: '\u2691' },
  { label: 'Sunset',     cmd: 9, color: '#f59e0b', icon: '\u263C' },
  { label: 'Royal',      cmd: 10, color: '#818cf8', icon: '\u2654' },
];

const NAV_ICONS = {
  dashboard: '\u25A3',
  'pool controls': '\u26A1',
  chlorinator: '\u2662',
  lights: '\u2738',
  schedules: '\u23F0',
  alerts: '\u26A0',
};

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

/* ── Gauge Component ── */
function TempGauge({ temp, setPoint, label, isOn }) {
  const min = 40, max = 104;
  const pct = Math.max(0, Math.min(1, ((temp || 0) - min) / (max - min)));
  const r = 54, cx = 64, cy = 64, sw = 6;
  const circ = 2 * Math.PI * r;
  const arc = 0.75;
  const dash = pct * circ * arc;
  const color = isOn ? '#22d3ee' : (temp > 80 ? '#f59e0b' : '#3b82f6');

  return (
    <div style={{ position: 'relative', width: 128, height: 128 }}>
      <svg width="128" height="128" style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id={`g-${label}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="1" />
            <stop offset="100%" stopColor={color} stopOpacity="0.3" />
          </linearGradient>
        </defs>
        {/* track */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={sw}
          strokeDasharray={`${circ * arc} ${circ * (1 - arc)}`}
          strokeDashoffset={circ * (arc / 2 + 0.25)} strokeLinecap="round"
          transform={`rotate(0 ${cx} ${cy})`} />
        {/* fill */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={`url(#g-${label})`} strokeWidth={sw}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ * (arc / 2 + 0.25)} strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.8s ease', filter: `drop-shadow(0 0 4px ${color}40)` }} />
      </svg>
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 28, fontWeight: 700, color: 'white', fontFamily: "'JetBrains Mono', monospace",
          lineHeight: 1 }}>{temp ?? '--'}</span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontFamily: "'JetBrains Mono', monospace",
          marginTop: 2 }}>SET {setPoint ?? '--'}&deg;F</span>
      </div>
    </div>
  );
}

/* ── Metric Card ── */
function Metric({ label, value, unit, color }) {
  return (
    <div style={{ padding: '14px 16px', background: 'rgba(255,255,255,0.025)', borderRadius: 8,
      border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontFamily: "'JetBrains Mono', monospace",
        textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: color || 'white',
        fontFamily: "'JetBrains Mono', monospace", lineHeight: 1 }}>
        {value}<span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginLeft: 3 }}>{unit}</span>
      </div>
    </div>
  );
}

/* ── Toast ── */
function Toast({ message, type }) {
  return (
    <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
      background: type === 'error' ? 'rgba(239,68,68,0.95)' : 'rgba(14,165,233,0.95)',
      color: 'white', padding: '10px 24px', borderRadius: 8, fontSize: 13,
      fontFamily: "'Inter', sans-serif", boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      backdropFilter: 'blur(12px)', zIndex: 999, animation: 'slideUp 0.25s ease' }}>
      {message}
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [alertsData, setAlertsData] = useState(null);
  const [schedulesData, setSchedulesData] = useState(null);
  const [chlorData, setChlorData] = useState(null);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState({});
  const [activeTab, setActiveTab] = useState('dashboard');
  const [tempInputs, setTempInputs] = useState({});
  const [chlorOutput, setChlorOutput] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const showToast = (msg, type = 'info') => {
    setToast({ message: msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchStatus = useCallback(async () => {
    try {
      const r = await apiGet('status');
      if (r.ok) { setStatus(r.data); setLastUpdated(new Date()); }
    } catch (e) {}
  }, []);

  const fetchAlerts = useCallback(async () => {
    try {
      const r = await apiGet('alerts');
      if (r.ok) setAlertsData(r.data);
    } catch (e) {}
  }, []);

  const fetchSchedules = useCallback(async () => {
    try {
      const r = await apiGet('schedules');
      if (r.ok) setSchedulesData(r.data);
    } catch (e) {}
  }, []);

  const fetchChlor = useCallback(async () => {
    try {
      const r = await apiGet('chlorinator');
      if (r.ok) setChlorData(r.data);
    } catch (e) {}
  }, []);

  usePoll(fetchStatus, 5000);
  usePoll(fetchAlerts, 10000);
  usePoll(fetchSchedules, 15000);
  usePoll(fetchChlor, 10000);

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
    if (!temp || temp < 50 || temp > 104) return showToast('Temperature must be 50-104\u00B0F', 'error');
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
      if (r.ok) showToast(r.message);
      else showToast(r.error, 'error');
    } catch (e) { showToast('Connection error', 'error'); }
    setLoading(l => ({ ...l, lights: false }));
  };

  const setChlorSetPoint = async (val) => {
    const pct = parseInt(val);
    if (isNaN(pct) || pct < 0 || pct > 100) return showToast('Output must be 0-100%', 'error');
    setLoading(l => ({ ...l, chlor: true }));
    try {
      const r = await apiPost('chlorinator', { poolOutput: pct });
      if (r.ok) { showToast(`Pool output set to ${pct}%`); fetchChlor(); }
      else showToast(r.error, 'error');
    } catch (e) { showToast('Connection error', 'error'); }
    setLoading(l => ({ ...l, chlor: false }));
  };

  const pool = status?.bodies?.find(b => b.name === 'Pool');
  const circuits = status?.circuits ?? [];
  const activeAlerts = alertsData?.alerts || [];
  const chlor = alertsData?.chlorinator || {};
  const sys = alertsData?.system || {};
  const alertCount = activeAlerts.length;

  const sevColors = {
    alarm: { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)', dot: '#ef4444', text: '#fca5a5' },
    warning: { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)', dot: '#f59e0b', text: '#fcd34d' },
    info: { bg: 'rgba(56,189,248,0.08)', border: 'rgba(56,189,248,0.25)', dot: '#38bdf8', text: '#7dd3fc' },
    ok: { bg: 'rgba(74,222,128,0.06)', border: 'rgba(74,222,128,0.2)', dot: '#4ade80', text: '#86efac' },
  };

  const inputStyle = {
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
    color: 'white', borderRadius: 6, padding: '8px 10px', fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace", outline: 'none',
  };

  return (
    <div style={{ minHeight: '100vh', background: '#0a0f1a', display: 'flex',
      fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        @keyframes slideUp { from { opacity:0; transform:translate(-50%,8px) } to { opacity:1; transform:translate(-50%,0) } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
        @keyframes glow { 0%,100% { box-shadow: 0 0 4px currentColor } 50% { box-shadow: 0 0 12px currentColor } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { margin: 0; background: #0a0f1a; }
        button { cursor: pointer; }
        button:hover:not(:disabled) { filter: brightness(1.1); }
        input, select { outline: none; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
      `}</style>

      {/* ── Sidebar ── */}
      <nav style={{
        width: 220, minHeight: '100vh', padding: '20px 12px',
        background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', flexDirection: 'column', flexShrink: 0,
      }}>
        {/* Logo area */}
        <div style={{ padding: '8px 12px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8,
              background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, color: 'white' }}>{'\u223F'}</div>
            <div>
              <div style={{ color: 'white', fontSize: 14, fontWeight: 600, lineHeight: 1.2 }}>Matthews</div>
              <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: 500 }}>Pool Control</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%',
              background: status ? '#4ade80' : '#f59e0b',
              boxShadow: status ? '0 0 6px #4ade80' : '0 0 6px #f59e0b' }} />
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)',
              fontFamily: "'JetBrains Mono', monospace" }}>
              {lastUpdated ? lastUpdated.toLocaleTimeString() : 'Connecting...'}
            </span>
          </div>
        </div>

        {/* Nav items */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {['dashboard','pool controls','chlorinator','lights','schedules','alerts'].map(t => (
            <button key={t} onClick={() => setActiveTab(t)} style={{
              background: activeTab === t ? 'rgba(255,255,255,0.06)' : 'transparent',
              border: 'none',
              borderLeft: activeTab === t ? '2px solid #3b82f6' : '2px solid transparent',
              color: activeTab === t ? 'white' : 'rgba(255,255,255,0.35)',
              borderRadius: '0 6px 6px 0', padding: '10px 14px', textAlign: 'left',
              fontSize: 13, fontWeight: activeTab === t ? 500 : 400,
              transition: 'all 0.15s', width: '100%',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 14, width: 20, textAlign: 'center',
                opacity: activeTab === t ? 1 : 0.5 }}>{NAV_ICONS[t]}</span>
              {t.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
              {t === 'alerts' && alertCount > 0 && (
                <span style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 6px', borderRadius: 10,
                  background: 'rgba(239,68,68,0.2)', color: '#fca5a5',
                  fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{alertCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Bottom status */}
        <div style={{ marginTop: 'auto', padding: '16px 12px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)',
            fontFamily: "'JetBrains Mono', monospace" }}>
            EasyTouch2 4P
          </div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.15)',
            fontFamily: "'JetBrains Mono', monospace" }}>
            IC40 &middot; v5.2 b738
          </div>
        </div>
      </nav>

      {/* ── Main Content ── */}
      <main style={{ flex: 1, padding: '24px 32px', overflowY: 'auto', minHeight: '100vh' }}>
        <div style={{ maxWidth: 1000 }}>

        {/* ─── DASHBOARD ─── */}
        {activeTab === 'dashboard' && (
          <div>
            {/* Top metrics row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
              <Metric label="Air Temp" value={sys.airTemp ?? '--'} unit="&deg;F" />
              <Metric label="Pool Temp" value={pool?.currentTemp ?? '--'} unit="&deg;F"
                color={pool?.currentTemp > 80 ? '#22d3ee' : undefined} />
              <Metric label="Salt Level" value={chlor.salt ?? '--'} unit="ppm"
                color={chlor.salt < 2700 ? '#fbbf24' : '#4ade80'} />
              <Metric label="Chlor Output" value={chlor.poolSetPoint ?? '--'} unit="%" />
            </div>

            {/* Main grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16 }}>

              {/* Pool gauge card */}
              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 12, padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 20 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'white' }}>Pool</span>
                  <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4,
                    fontFamily: "'JetBrains Mono', monospace", fontWeight: 500,
                    background: pool?.isActive ? 'rgba(34,211,238,0.1)' : 'rgba(255,255,255,0.04)',
                    color: pool?.isActive ? '#22d3ee' : 'rgba(255,255,255,0.3)',
                    border: `1px solid ${pool?.isActive ? 'rgba(34,211,238,0.3)' : 'rgba(255,255,255,0.08)'}`,
                  }}>{pool?.isActive ? 'RUNNING' : 'STANDBY'}</span>
                </div>
                {pool && <TempGauge temp={pool.currentTemp} setPoint={pool.setPoint} label="Pool" isOn={pool.isActive} />}
                <div style={{ width: '100%', marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <select value={pool?.heatMode ?? 0} onChange={e => setHeatMode(0, parseInt(e.target.value))}
                    style={{ ...inputStyle, width: '100%', cursor: 'pointer' }}>
                    {HEAT_MODES.map((m, i) => <option key={i} value={i}>{m}</option>)}
                  </select>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input type="number" min="50" max="104" placeholder="Temp"
                      value={tempInputs[0] ?? ''}
                      onChange={e => setTempInputs(t => ({ ...t, 0: e.target.value }))}
                      style={{ ...inputStyle, flex: 1, textAlign: 'center' }} />
                    <button onClick={() => setSetPoint(0)}
                      style={{ background: '#3b82f6', border: 'none', color: 'white',
                        borderRadius: 6, padding: '8px 16px', fontSize: 12, fontWeight: 600 }}>SET</button>
                  </div>
                </div>
              </div>

              {/* Right column */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Alerts banner */}
                <div style={{ background: alertCount > 0 ? 'rgba(239,68,68,0.06)' : 'rgba(74,222,128,0.04)',
                  border: `1px solid ${alertCount > 0 ? 'rgba(239,68,68,0.15)' : 'rgba(74,222,128,0.12)'}`,
                  borderRadius: 10, padding: '12px 16px' }}>
                  {alertCount === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#4ade80',
                        boxShadow: '0 0 6px #4ade80' }} />
                      <span style={{ fontSize: 12, color: '#86efac', fontWeight: 500 }}>All systems nominal</span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {activeAlerts.map((a, i) => {
                        const sc = sevColors[a.severity] || sevColors.info;
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: sc.dot,
                              animation: a.severity === 'alarm' ? 'pulse 1.5s ease infinite' : 'none', flexShrink: 0 }} />
                            <span style={{ fontSize: 12, color: sc.text, fontWeight: 500 }}>{a.source}: {a.message}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Quick circuits */}
                <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 12, padding: '16px 18px', flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.4)',
                    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12,
                    fontFamily: "'JetBrains Mono', monospace" }}>Pool Controls</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                    {circuits.filter(c => !c.isFeature).map(c => {
                      const on = c.isOn;
                      return (
                        <button key={c.id} onClick={() => toggleCircuit(c.id, on ? 0 : 1)}
                          disabled={loading[c.id]}
                          style={{
                            background: on ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.02)',
                            border: `1px solid ${on ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.06)'}`,
                            borderRadius: 6, padding: '10px 12px',
                            display: 'flex', alignItems: 'center', gap: 8,
                            opacity: loading[c.id] ? 0.5 : 1, transition: 'all 0.15s',
                          }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                            background: on ? '#3b82f6' : 'rgba(255,255,255,0.15)',
                            boxShadow: on ? '0 0 6px #3b82f6' : 'none' }} />
                          <span style={{ fontSize: 12, color: on ? 'white' : 'rgba(255,255,255,0.4)',
                            fontWeight: on ? 500 : 400 }}>{c.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom row: System + Chlorinator */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.4)',
                  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14,
                  fontFamily: "'JetBrains Mono', monospace" }}>System</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  {[
                    { l: 'Panel', v: sys.panelMode || '--', c: sys.panelMode === 'Auto' ? '#4ade80' : '#fbbf24' },
                    { l: 'Freeze', v: sys.freezeMode ? 'Active' : 'Off', c: sys.freezeMode ? '#fbbf24' : '#4ade80' },
                    { l: 'Pool Delay', v: sys.poolDelay ? 'Active' : 'None', c: sys.poolDelay ? '#fbbf24' : 'rgba(255,255,255,0.25)' },
                  ].map((item, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)',
                        fontFamily: "'JetBrains Mono', monospace", marginBottom: 4 }}>{item.l}</div>
                      <div style={{ fontSize: 13, color: item.c, fontWeight: 600,
                        fontFamily: "'JetBrains Mono', monospace" }}>{item.v}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.4)',
                  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14,
                  fontFamily: "'JetBrains Mono', monospace" }}>Chlorinator</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  {[
                    { l: 'Status', v: chlor.installed ? 'Online' : 'Offline', c: chlor.installed ? '#4ade80' : '#ef4444' },
                    { l: 'Salt', v: chlor.salt != null ? `${chlor.salt}` : '--', c: (chlor.salt || 0) < 2700 ? '#fbbf24' : 'white' },
                    { l: 'Output', v: chlor.poolSetPoint != null ? `${chlor.poolSetPoint}%` : '--', c: 'white' },
                  ].map((item, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)',
                        fontFamily: "'JetBrains Mono', monospace", marginBottom: 4 }}>{item.l}</div>
                      <div style={{ fontSize: 13, color: item.c, fontWeight: 600,
                        fontFamily: "'JetBrains Mono', monospace" }}>{item.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─── CIRCUITS ─── */}
        {activeTab === 'pool controls' && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: 'white', marginBottom: 4 }}>
              Pool Controls</h2>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', marginBottom: 20 }}>
              {circuits.length} circuits &middot; {circuits.filter(c => c.isOn).length} active</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              {circuits.map(c => {
                const on = c.isOn;
                return (
                  <button key={c.id} onClick={() => toggleCircuit(c.id, on ? 0 : 1)}
                    disabled={loading[c.id]}
                    style={{
                      background: on ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${on ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.06)'}`,
                      borderRadius: 8, padding: '14px 16px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      opacity: loading[c.id] ? 0.5 : 1, transition: 'all 0.15s',
                    }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                        background: on ? '#3b82f6' : 'rgba(255,255,255,0.15)',
                        boxShadow: on ? '0 0 8px #3b82f6' : 'none' }} />
                      <span style={{ fontSize: 13, color: on ? 'white' : 'rgba(255,255,255,0.4)',
                        fontWeight: on ? 500 : 400 }}>{c.name}</span>
                    </div>
                    <span style={{ fontSize: 10, color: on ? '#93c5fd' : 'rgba(255,255,255,0.2)',
                      fontFamily: "'JetBrains Mono', monospace", fontWeight: 500 }}>
                      {on ? 'ON' : 'OFF'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── LIGHTS ─── */}
        {activeTab === 'lights' && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: 'white', marginBottom: 4 }}>Light Controls</h2>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', marginBottom: 24 }}>
              IntelliBrite color modes</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
              {LIGHT_COMMANDS.map(lc => (
                <button key={lc.cmd} onClick={() => sendLightCommand(lc.cmd)}
                  disabled={loading.lights}
                  style={{
                    background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: 10, padding: '18px 12px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                    transition: 'all 0.15s', opacity: loading.lights ? 0.4 : 1,
                    position: 'relative', overflow: 'hidden',
                  }}>
                  <div style={{ width: 24, height: 24, borderRadius: '50%', background: lc.color,
                    boxShadow: `0 0 16px ${lc.color}60`, position: 'relative', zIndex: 1 }} />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: 500,
                    position: 'relative', zIndex: 1 }}>{lc.label}</span>
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '40%',
                    background: `linear-gradient(to top, ${lc.color}08, transparent)` }} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ─── CHLORINATOR ─── */}
        {activeTab === 'chlorinator' && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: 'white', marginBottom: 4 }}>IntelliChlor</h2>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', marginBottom: 24 }}>
              IC40 Salt Chlorine Generator</p>

            {chlorData ? (
              <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16 }}>
                {/* Pool Output Gauge (left) */}
                {(() => {
                  const pct = (chlorData.poolOutput || 0) / 100;
                  const r = 90, cx = 100, cy = 100, sw = 10;
                  const circ = 2 * Math.PI * r;
                  const gap = 0.2;
                  const arc = 1 - gap;
                  const dash = pct * circ * arc;
                  const color = '#84cc16';
                  return (
                    <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: 12, padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.4)',
                        textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 16,
                        fontFamily: "'JetBrains Mono', monospace" }}>Pool Output</div>
                      <div style={{ position: 'relative', width: 200, height: 200 }}>
                        <svg width="200" height="200" style={{ overflow: 'visible' }}>
                          <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={sw}
                            strokeDasharray={`${circ * arc} ${circ * gap}`}
                            strokeDashoffset={circ * (arc / 2 + 0.25)} strokeLinecap="round"
                            transform={`rotate(0 ${cx} ${cy})`} />
                          <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={sw}
                            strokeDasharray={`${dash} ${circ - dash}`}
                            strokeDashoffset={circ * (arc / 2 + 0.25)} strokeLinecap="round"
                            style={{ transition: 'stroke-dasharray 0.8s ease', filter: `drop-shadow(0 0 6px ${color}50)` }} />
                        </svg>
                        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <span style={{ fontSize: 48, fontWeight: 700, color: color,
                            fontFamily: "'JetBrains Mono', monospace", lineHeight: 1 }}>
                            {chlorData.poolOutput ?? 0}<span style={{ fontSize: 24, color: 'rgba(255,255,255,0.3)' }}>%</span>
                          </span>
                        </div>
                      </div>
                      {/* Output adjustment controls */}
                      <div style={{ width: '100%', marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <button onClick={() => { const v = Math.max(0, (chlorOutput != null ? chlorOutput : chlorData.poolOutput) - 5); setChlorOutput(v); }}
                            style={{ width: 36, height: 36, borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)',
                              background: 'rgba(255,255,255,0.04)', color: 'white', fontSize: 18, fontWeight: 600,
                              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{'\u2212'}</button>
                          <input type="range" min="0" max="100" step="5"
                            value={chlorOutput != null ? chlorOutput : chlorData.poolOutput}
                            onChange={e => setChlorOutput(parseInt(e.target.value))}
                            style={{ flex: 1, accentColor: '#84cc16', height: 4, cursor: 'pointer' }} />
                          <button onClick={() => { const v = Math.min(100, (chlorOutput != null ? chlorOutput : chlorData.poolOutput) + 5); setChlorOutput(v); }}
                            style={{ width: 36, height: 36, borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)',
                              background: 'rgba(255,255,255,0.04)', color: 'white', fontSize: 18, fontWeight: 600,
                              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                        </div>
                        {chlorOutput != null && chlorOutput !== chlorData.poolOutput && (
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => setChlorOutput(null)}
                              style={{ flex: 1, padding: '8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)',
                                background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.5)',
                                fontSize: 12, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>Cancel</button>
                            <button onClick={() => { setChlorSetPoint(chlorOutput); setChlorOutput(null); }}
                              disabled={loading.chlor}
                              style={{ flex: 1, padding: '8px', borderRadius: 6, border: 'none',
                                background: '#84cc16', color: '#0a0f1a',
                                fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                                opacity: loading.chlor ? 0.5 : 1 }}>
                              Set {chlorOutput}%
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Right column: Salt, Super Chlorination, Status */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Salt Level */}
                  <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: 12, padding: '18px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.5)',
                      textTransform: 'uppercase', letterSpacing: '0.08em',
                      fontFamily: "'JetBrains Mono', monospace" }}>Salt Level</span>
                    <span style={{ fontSize: 24, fontWeight: 700,
                      color: (chlorData.saltPPM || 0) < 2700 ? '#fbbf24' : '#84cc16',
                      fontFamily: "'JetBrains Mono', monospace" }}>
                      {chlorData.saltPPM ?? '--'}
                    </span>
                  </div>

                  {/* Super Chlorination */}
                  <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: 12, padding: '18px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.5)',
                      textTransform: 'uppercase', letterSpacing: '0.08em',
                      fontFamily: "'JetBrains Mono', monospace" }}>Super Chlorination</span>
                    <span style={{ fontSize: 13, fontWeight: 600, padding: '6px 16px', borderRadius: 6,
                      fontFamily: "'JetBrains Mono', monospace",
                      background: chlorData.isActive && (chlor.superChlorTimer > 0) ? 'rgba(132,204,22,0.15)' : 'rgba(255,255,255,0.04)',
                      color: chlorData.isActive && (chlor.superChlorTimer > 0) ? '#84cc16' : 'rgba(255,255,255,0.4)',
                      border: `1px solid ${chlorData.isActive && (chlor.superChlorTimer > 0) ? 'rgba(132,204,22,0.3)' : 'rgba(255,255,255,0.08)'}`,
                    }}>{chlorData.isActive && (chlor.superChlorTimer > 0) ? 'On' : 'Off'}</span>
                  </div>

                  {/* Status */}
                  <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: 12, padding: '18px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.5)',
                      textTransform: 'uppercase', letterSpacing: '0.08em',
                      fontFamily: "'JetBrains Mono', monospace" }}>Status</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%',
                        background: chlorData.isActive ? '#4ade80' : '#ef4444',
                        boxShadow: `0 0 6px ${chlorData.isActive ? '#4ade80' : '#ef4444'}` }} />
                      <span style={{ fontSize: 13, fontWeight: 600,
                        color: chlorData.isActive ? '#4ade80' : '#ef4444',
                        fontFamily: "'JetBrains Mono', monospace" }}>
                        {chlorData.isActive ? 'Online' : 'Offline'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ padding: '40px 0', textAlign: 'center' }}>
                <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>Loading chlorinator data...</div>
              </div>
            )}
          </div>
        )}

        {/* ─── SCHEDULES ─── */}
        {activeTab === 'schedules' && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: 'white', marginBottom: 4 }}>Schedules</h2>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', marginBottom: 20 }}>
              {schedulesData ? `${schedulesData.schedules.length} scheduled programs` : 'Loading...'}</p>

            {schedulesData && schedulesData.schedules.length > 0 && (
              <div>
                {/* Table header */}
                <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 100px 100px 1fr 70px',
                  gap: 8, padding: '0 16px 10px', alignItems: 'center' }}>
                  {['', 'Circuit', 'Start', 'Stop', 'Days', 'Status'].map((h, i) => (
                    <div key={i} style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)',
                      fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase',
                      letterSpacing: '0.08em', fontWeight: 600 }}>{h}</div>
                  ))}
                </div>

                {/* Schedule rows */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {schedulesData.schedules.map(s => {
                    const startH = parseInt(s.startTime.split(':')[0]);
                    const startM = s.startTime.split(':')[1];
                    const stopH = parseInt(s.stopTime.split(':')[0]);
                    const stopM = s.stopTime.split(':')[1];
                    const fmtTime = (h, m) => {
                      const ampm = h >= 12 ? 'PM' : 'AM';
                      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                      return `${h12}:${m} ${ampm}`;
                    };

                    return (
                      <div key={s.id} style={{
                        display: 'grid', gridTemplateColumns: '40px 1fr 100px 100px 1fr 70px',
                        gap: 8, padding: '14px 16px', alignItems: 'center',
                        background: s.isActive ? 'rgba(59,130,246,0.06)' : 'rgba(255,255,255,0.02)',
                        border: `1px solid ${s.isActive ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.05)'}`,
                        borderRadius: 8,
                      }}>
                        {/* Active indicator */}
                        <div style={{ display: 'flex', justifyContent: 'center' }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%',
                            background: s.isActive ? '#3b82f6' : 'rgba(255,255,255,0.1)',
                            boxShadow: s.isActive ? '0 0 8px #3b82f6' : 'none',
                            animation: s.isActive ? 'pulse 2s ease infinite' : 'none' }} />
                        </div>

                        {/* Circuit name */}
                        <div style={{ fontSize: 13, fontWeight: s.isActive ? 600 : 400,
                          color: s.isActive ? 'white' : 'rgba(255,255,255,0.6)' }}>
                          {s.circuitName}
                        </div>

                        {/* Start */}
                        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)',
                          fontFamily: "'JetBrains Mono', monospace" }}>
                          {fmtTime(startH, startM)}
                        </div>

                        {/* Stop */}
                        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)',
                          fontFamily: "'JetBrains Mono', monospace" }}>
                          {fmtTime(stopH, stopM)}
                        </div>

                        {/* Days */}
                        <div style={{ display: 'flex', gap: 3 }}>
                          {['M','T','W','T','F','S','S'].map((d, i) => {
                            const dayBits = [1, 2, 4, 8, 16, 32, 64];
                            const isOn = !!(s.dayMask & dayBits[i]);
                            return (
                              <span key={i} style={{
                                width: 22, height: 22, borderRadius: 4,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 9, fontWeight: 600,
                                fontFamily: "'JetBrains Mono', monospace",
                                background: isOn ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)',
                                color: isOn ? '#93c5fd' : 'rgba(255,255,255,0.15)',
                                border: `1px solid ${isOn ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.05)'}`,
                              }}>{d}</span>
                            );
                          })}
                        </div>

                        {/* Status */}
                        <div style={{ textAlign: 'right' }}>
                          <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4,
                            fontFamily: "'JetBrains Mono', monospace", fontWeight: 600,
                            background: s.isActive ? 'rgba(59,130,246,0.15)' : s.runsToday ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                            color: s.isActive ? '#60a5fa' : s.runsToday ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)',
                            border: `1px solid ${s.isActive ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.06)'}`,
                          }}>{s.isActive ? 'ACTIVE' : s.runsToday ? 'TODAY' : 'IDLE'}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {schedulesData && schedulesData.schedules.length === 0 && (
              <div style={{ padding: '40px 0', textAlign: 'center' }}>
                <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>No schedules configured</div>
              </div>
            )}
          </div>
        )}

        {/* ─── ALERTS ─── */}
        {activeTab === 'alerts' && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: 'white', marginBottom: 4 }}>
              Active Alerts
              {alertCount > 0 && (
                <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px', borderRadius: 4,
                  background: 'rgba(239,68,68,0.15)', color: '#fca5a5',
                  fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{alertCount}</span>
              )}
            </h2>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', marginBottom: 20 }}>
              Real-time equipment alerts and warnings</p>

            {alertCount === 0 ? (
              <div style={{ padding: '40px 0', textAlign: 'center' }}>
                <div style={{ width: 48, height: 48, borderRadius: '50%', margin: '0 auto 16px',
                  background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 20, color: '#4ade80' }}>{'\u2713'}</div>
                <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>All systems nominal</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', marginTop: 4 }}>No active alerts</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {activeAlerts.map((a, i) => {
                  const sc = sevColors[a.severity] || sevColors.info;
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 14,
                      padding: '14px 18px', borderRadius: 10,
                      background: sc.bg, border: `1px solid ${sc.border}`,
                    }}>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                        background: sc.dot, boxShadow: `0 0 8px ${sc.dot}`,
                        animation: a.severity === 'alarm' ? 'pulse 1.5s ease infinite' : 'none' }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                          <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 600, color: sc.text, padding: '1px 6px', borderRadius: 3,
                            background: `${sc.dot}15`, textTransform: 'uppercase' }}>
                            {a.severity}
                          </span>
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)',
                            fontFamily: "'JetBrains Mono', monospace" }}>{a.source}</span>
                        </div>
                        <div style={{ fontSize: 14, color: 'white', fontWeight: 500 }}>
                          {a.source}: {a.message}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Loading state */}
        {!status && (
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            textAlign: 'center' }}>
            <div style={{ width: 40, height: 40, border: '2px solid rgba(255,255,255,0.1)',
              borderTopColor: '#3b82f6', borderRadius: '50%', margin: '0 auto 16px',
              animation: 'spin 1s linear infinite' }} />
            <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13,
              fontFamily: "'JetBrains Mono', monospace" }}>Connecting to gateway...</div>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}

        </div>
      </main>

      {toast && <Toast message={toast.message} type={toast.type} />}
    </div>
  );
}
