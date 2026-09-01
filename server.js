const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'telemetry.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, '[]\n', 'utf8');
}

if (!fs.existsSync(CONFIG_FILE)) {
  const defaultConfig = {
    devices: {
      "HIDRO-001": {
        liters_per_pulse: null,
        calibration_status: "pending",
        calibrated_at: null
      }
    }
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf8');
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { devices: {} };
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (!raw || raw.trim() === '') return { devices: {} };
    return JSON.parse(raw);
  } catch (err) {
    console.error('Erro ao ler config.json:', err);
    return { devices: {} };
  }
}

function saveConfig(config) {
  const tmpFile = path.join(DATA_DIR, 'config.json.tmp');
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpFile, CONFIG_FILE);
    return true;
  } catch (err) {
    console.error('Erro ao salvar config.json:', err);
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch (e) {}
    }
    return false;
  }
}

function getDeviceCalibration(deviceId) {
  const config = loadConfig();
  const devConfig = (config.devices && config.devices[deviceId]) || null;
  if (devConfig && typeof devConfig.liters_per_pulse === 'number' && Number.isFinite(devConfig.liters_per_pulse) && devConfig.liters_per_pulse > 0) {
    return {
      status: devConfig.calibration_status || 'calibrated',
      liters_per_pulse: devConfig.liters_per_pulse,
      calibrated_at: devConfig.calibrated_at || null
    };
  }
  return {
    status: 'pending',
    liters_per_pulse: null,
    calibrated_at: null
  };
}

function loadHistoryArray() {
  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    if (!raw || raw.trim() === '') return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    console.error('history.json não contém um array JSON válido.');
    return null;
  } catch (err) {
    console.error('Erro ao ler history.json:', err);
    return null;
  }
}

function saveHistoryEvents(eventsToAppend) {
  if (!eventsToAppend || eventsToAppend.length === 0) return true;
  const history = loadHistoryArray();
  if (history === null) {
    console.error('Gravação abortada para preservar history.json inválido/corrompido.');
    return false;
  }
  history.push(...eventsToAppend);
  const tmpFile = path.join(DATA_DIR, 'history.json.tmp');
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(history, null, 2), 'utf8');
    fs.renameSync(tmpFile, HISTORY_FILE);
    return true;
  } catch (err) {
    console.error('Erro ao salvar history.json:', err);
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch (e) {}
    }
    return false;
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  let reqUrl = req.url.split('?')[0];
  if (reqUrl === '/') reqUrl = '/index.html';

  const safePath = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJSON(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        sendJSON(res, 404, { ok: false, error: 'File not found' });
      } else {
        sendJSON(res, 500, { ok: false, error: 'Internal server error' });
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      timestamp: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJSON(res, 200, {
      ok: true,
      data: loadConfig()
    });
  }

  if ((req.method === 'PUT' || req.method === 'POST') && pathname === '/api/config/calibration') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) req.destroy();
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload !== 'object') {
          return sendJSON(res, 400, { ok: false, error: 'Payload deve ser um objeto JSON' });
        }

        const { device_id, liters_per_pulse } = payload;
        if (typeof device_id !== 'string' || device_id.trim() === '') {
          return sendJSON(res, 400, { ok: false, error: 'device_id é obrigatório e deve ser texto' });
        }

        if (typeof liters_per_pulse !== 'number' || !Number.isFinite(liters_per_pulse) || liters_per_pulse <= 0) {
          return sendJSON(res, 400, { ok: false, error: 'liters_per_pulse deve ser um número finito maior que zero' });
        }

        const cleanId = device_id.trim();
        const config = loadConfig();
        if (!config.devices) config.devices = {};

        config.devices[cleanId] = {
          liters_per_pulse: liters_per_pulse,
          calibration_status: 'calibrated',
          calibrated_at: new Date().toISOString()
        };

        if (saveConfig(config)) {
          return sendJSON(res, 200, { ok: true, data: config.devices[cleanId] });
        } else {
          return sendJSON(res, 500, { ok: false, error: 'Erro ao salvar configuração' });
        }
      } catch (err) {
        return sendJSON(res, 400, { ok: false, error: 'JSON inválido' });
      }
    });
    return;
  }

function getEnrichedHistory(historyArray) {
  if (!Array.isArray(historyArray)) return [];

  // historyArray é armazenado em ordem cronológica (índice 0 = mais antigo)
  const lastPulseEventByDevice = {};

  const enrichedChronological = historyArray.map(item => {
    const devId = item.device_id || 'HIDRO-001';
    const calib = getDeviceCalibration(devId);

    let calcDelta = null;
    let calcTotal = null;

    if (item.type === 'pulse' && calib.liters_per_pulse !== null) {
      calcDelta = (item.pulse_delta || 0) * calib.liters_per_pulse;
      calcTotal = (item.pulse_total || 0) * calib.liters_per_pulse;
    }

    let interval_seconds = null;
    let flow_lpm = null;
    let flow_m3h = null;
    let flow_type = null;
    let flow_status = 'insufficient_data';

    if (item.type === 'pulse') {
      const prevPulse = lastPulseEventByDevice[devId] || null;

      if (prevPulse && prevPulse.received_at && item.received_at) {
        const t1 = new Date(prevPulse.received_at).getTime();
        const t2 = new Date(item.received_at).getTime();
        const seconds = (t2 - t1) / 1000;

        if (seconds > 0) {
          interval_seconds = Number(seconds.toFixed(3));

          if (calib.liters_per_pulse === null) {
            flow_status = 'calibration_pending';
          } else {
            const deltaP = item.pulse_delta !== undefined && item.pulse_delta !== null ? item.pulse_delta : 1;
            const litersDelta = deltaP * calib.liters_per_pulse;
            const lpm = (litersDelta / seconds) * 60;
            const m3h = lpm * 0.06;

            flow_lpm = Number(lpm.toFixed(2));
            flow_m3h = Number(m3h.toFixed(3));
            flow_status = 'ok';

            if (deltaP === 1) {
              flow_type = 'inter_pulse';
            } else {
              flow_type = 'interval_average';
            }
          }
        } else {
          flow_status = 'invalid_interval';
        }
      } else {
        flow_status = calib.liters_per_pulse === null ? 'calibration_pending' : 'insufficient_data';
      }

      // Atualizar último evento de pulso para este dispositivo
      lastPulseEventByDevice[devId] = item;
    } else if (item.type === 'counter_reset') {
      flow_status = 'counter_reset';
    }

    return {
      ...item,
      calibration: calib,
      calculated_liters_delta: calcDelta,
      calculated_liters_total: calcTotal,
      interval_seconds,
      flow_lpm,
      flow_m3h,
      flow_type,
      flow_status
    };
  });

  return enrichedChronological;
}

  if (req.method === 'GET' && pathname === '/api/telemetry/latest') {
    try {
      if (!fs.existsSync(DATA_FILE)) {
        return sendJSON(res, 200, {
          ok: false,
          data: null,
          message: 'Aguardando primeira telemetria...'
        });
      }
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      if (!raw || raw.trim() === '' || raw.trim() === '{}') {
        return sendJSON(res, 200, {
          ok: false,
          data: null,
          message: 'Aguardando primeira telemetria...'
        });
      }
      const telemetry = JSON.parse(raw);
      if (!telemetry || !telemetry.device_id) {
        return sendJSON(res, 200, {
          ok: false,
          data: null,
          message: 'Aguardando primeira telemetria...'
        });
      }

      const calib = getDeviceCalibration(telemetry.device_id);
      const calculated_liters_total = calib.liters_per_pulse !== null
        ? (telemetry.pulse_total || 0) * calib.liters_per_pulse
        : null;

      const rawHistory = loadHistoryArray() || [];
      const enrichedChronological = getEnrichedHistory(rawHistory);
      const devicePulses = enrichedChronological.filter(e => (e.device_id || 'HIDRO-001') === telemetry.device_id && e.type === 'pulse');
      const latestPulse = devicePulses.length > 0 ? devicePulses[devicePulses.length - 1] : null;

      const flow = latestPulse ? {
        lpm: latestPulse.flow_lpm,
        m3h: latestPulse.flow_m3h,
        type: latestPulse.flow_type,
        status: latestPulse.flow_status,
        interval_seconds: latestPulse.interval_seconds
      } : {
        lpm: null,
        m3h: null,
        type: null,
        status: calib.liters_per_pulse === null ? 'calibration_pending' : 'insufficient_data',
        interval_seconds: null
      };

      return sendJSON(res, 200, {
        ok: true,
        data: {
          ...telemetry,
          calibration: calib,
          calculated_liters_total,
          flow
        }
      });
    } catch (err) {
      return sendJSON(res, 200, {
        ok: false,
        data: null,
        message: 'Aguardando primeira telemetria...'
      });
    }
  }

  if (req.method === 'GET' && pathname === '/api/telemetry/history') {
    try {
      const history = loadHistoryArray();
      if (history === null) {
        return sendJSON(res, 500, { ok: false, error: 'Erro ao ler arquivo de histórico' });
      }

      let limit = 100;
      if (parsedUrl.searchParams.has('limit')) {
        const rawLimit = parseInt(parsedUrl.searchParams.get('limit'), 10);
        if (!isNaN(rawLimit) && rawLimit > 0) {
          limit = Math.min(rawLimit, 1000);
        }
      }

      const enrichedChronological = getEnrichedHistory(history);
      // Ordenar mais recente primeiro para resposta da API
      const sorted = [...enrichedChronological].reverse().slice(0, limit);

      return sendJSON(res, 200, {
        ok: true,
        data: sorted
      });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: 'Erro interno ao buscar histórico' });
    }
  }

const FLOW_SESSION_GAP_SECONDS = 60;

function buildSessionObject(index, deviceId, sessionEvents, calib) {
  const startedAt = sessionEvents[0].received_at;
  const lastPulseAt = sessionEvents[sessionEvents.length - 1].received_at;
  const durationSeconds = Math.max(0, Math.round((new Date(lastPulseAt).getTime() - new Date(startedAt).getTime()) / 1000));

  const pulseEventsCount = sessionEvents.length;
  const pulseCountSum = sessionEvents.reduce((acc, e) => acc + (e.pulse_delta !== undefined && e.pulse_delta !== null ? e.pulse_delta : 1), 0);

  let volumeLiters = null;
  if (calib && calib.liters_per_pulse !== null) {
    volumeLiters = Number((pulseCountSum * calib.liters_per_pulse).toFixed(2));
  }

  const validFlowSamples = sessionEvents
    .filter(e => e.flow_status === 'ok' && typeof e.flow_lpm === 'number' && Number.isFinite(e.flow_lpm))
    .map(e => e.flow_lpm);

  let averageFlowLpm = null;
  let maxFlowLpm = null;
  let minFlowLpm = null;

  if (validFlowSamples.length > 0) {
    averageFlowLpm = Number((validFlowSamples.reduce((a, b) => a + b, 0) / validFlowSamples.length).toFixed(2));
    maxFlowLpm = Number(Math.max(...validFlowSamples).toFixed(2));
    minFlowLpm = Number(Math.min(...validFlowSamples).toFixed(2));
  }

  return {
    session_id: `session-${String(index).padStart(3, '0')}`,
    device_id: deviceId,
    started_at: startedAt,
    last_pulse_at: lastPulseAt,
    ended_at: lastPulseAt,
    duration_seconds: durationSeconds,
    pulse_events: pulseEventsCount,
    pulse_count: pulseCountSum,
    volume_liters: volumeLiters,
    average_flow_lpm: averageFlowLpm,
    max_flow_lpm: maxFlowLpm,
    min_flow_lpm: minFlowLpm,
    status: 'closed'
  };
}

function calculateFlowSessions(historyArray, targetDeviceId = 'HIDRO-001') {
  if (!Array.isArray(historyArray) || historyArray.length === 0) {
    return [];
  }

  const calib = getDeviceCalibration(targetDeviceId);
  const enrichedHistory = getEnrichedHistory(historyArray);

  const devicePulseEvents = enrichedHistory.filter(e =>
    (e.device_id || 'HIDRO-001') === targetDeviceId && e.type === 'pulse'
  );

  if (devicePulseEvents.length === 0) {
    return [];
  }

  const sessions = [];
  let currentSessionEvents = [];

  for (let i = 0; i < devicePulseEvents.length; i++) {
    const event = devicePulseEvents[i];

    if (currentSessionEvents.length === 0) {
      currentSessionEvents.push(event);
    } else {
      const prevEvent = currentSessionEvents[currentSessionEvents.length - 1];
      const gapSeconds = (new Date(event.received_at).getTime() - new Date(prevEvent.received_at).getTime()) / 1000;

      if (gapSeconds <= FLOW_SESSION_GAP_SECONDS) {
        currentSessionEvents.push(event);
      } else {
        sessions.push(buildSessionObject(sessions.length + 1, targetDeviceId, currentSessionEvents, calib));
        currentSessionEvents = [event];
      }
    }
  }

  if (currentSessionEvents.length > 0) {
    sessions.push(buildSessionObject(sessions.length + 1, targetDeviceId, currentSessionEvents, calib));
  }

  const nowMs = Date.now();
  sessions.forEach((sess, idx) => {
    const isLatest = idx === sessions.length - 1;
    const lastPulseMs = new Date(sess.last_pulse_at).getTime();
    const secSinceLastPulse = (nowMs - lastPulseMs) / 1000;

    if (isLatest && secSinceLastPulse <= FLOW_SESSION_GAP_SECONDS) {
      sess.status = 'open';
      sess.ended_at = null;
    } else {
      sess.status = 'closed';
      sess.ended_at = sess.last_pulse_at;
    }
  });

  return sessions;
}

  if (req.method === 'GET' && pathname === '/api/telemetry/flow-summary') {
    try {
      const history = loadHistoryArray();
      if (history === null) {
        return sendJSON(res, 500, { ok: false, error: 'Erro ao ler arquivo de histórico' });
      }

      const targetDeviceId = parsedUrl.searchParams.get('device_id') || 'HIDRO-001';
      const calib = getDeviceCalibration(targetDeviceId);
      const enrichedChronological = getEnrichedHistory(history);

      const devicePulses = enrichedChronological.filter(e => (e.device_id || 'HIDRO-001') === targetDeviceId && e.type === 'pulse');
      const validSamples = devicePulses.filter(e => e.flow_status === 'ok' && typeof e.flow_lpm === 'number' && Number.isFinite(e.flow_lpm) && e.flow_lpm >= 0);

      const latestPulse = devicePulses.length > 0 ? devicePulses[devicePulses.length - 1] : null;

      const latest_flow_lpm = (latestPulse && typeof latestPulse.flow_lpm === 'number') ? latestPulse.flow_lpm : null;
      const latest_flow_m3h = (latestPulse && typeof latestPulse.flow_m3h === 'number') ? latestPulse.flow_m3h : null;

      const average_flow_lpm = validSamples.length > 0
        ? Number((validSamples.reduce((acc, s) => acc + s.flow_lpm, 0) / validSamples.length).toFixed(2))
        : null;

      const max_flow_lpm = validSamples.length > 0
        ? Number(Math.max(...validSamples.map(s => s.flow_lpm)).toFixed(2))
        : null;

      const last_pulse_at = latestPulse ? latestPulse.received_at : null;

      return sendJSON(res, 200, {
        ok: true,
        device_id: targetDeviceId,
        calibration_status: calib.status,
        liters_per_pulse: calib.liters_per_pulse,
        latest_flow_lpm,
        latest_flow_m3h,
        average_flow_lpm,
        max_flow_lpm,
        last_pulse_at,
        samples: validSamples.length
      });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: 'Erro interno ao gerar resumo de vazão' });
    }
  }

function calculateSystemTotals(historyArray, targetDeviceId = 'HIDRO-001') {
  const calib = getDeviceCalibration(targetDeviceId);
  if (!Array.isArray(historyArray) || historyArray.length === 0) {
    return {
      device_id: targetDeviceId,
      system_pulse_total: 0,
      system_volume_liters: calib.liters_per_pulse !== null ? 0 : null,
      pulse_events_total: 0,
      first_pulse_at: null,
      last_pulse_at: null,
      calibration_status: calib.status,
      liters_per_pulse: calib.liters_per_pulse
    };
  }

  const pulseEvents = historyArray.filter(e =>
    (e.device_id || 'HIDRO-001') === targetDeviceId && e.type === 'pulse'
  );

  if (pulseEvents.length === 0) {
    return {
      device_id: targetDeviceId,
      system_pulse_total: 0,
      system_volume_liters: calib.liters_per_pulse !== null ? 0 : null,
      pulse_events_total: 0,
      first_pulse_at: null,
      last_pulse_at: null,
      calibration_status: calib.status,
      liters_per_pulse: calib.liters_per_pulse
    };
  }

  let system_pulse_total = 0;
  for (const ev of pulseEvents) {
    const delta = typeof ev.pulse_delta === 'number' && Number.isFinite(ev.pulse_delta) && ev.pulse_delta > 0
      ? ev.pulse_delta
      : 1;
    system_pulse_total += delta;
  }

  const system_volume_liters = calib.liters_per_pulse !== null
    ? Number((system_pulse_total * calib.liters_per_pulse).toFixed(2))
    : null;

  const first_pulse_at = pulseEvents[0].received_at || null;
  const last_pulse_at = pulseEvents[pulseEvents.length - 1].received_at || null;

  return {
    device_id: targetDeviceId,
    system_pulse_total,
    system_volume_liters,
    pulse_events_total: pulseEvents.length,
    first_pulse_at,
    last_pulse_at,
    calibration_status: calib.status,
    liters_per_pulse: calib.liters_per_pulse
  };
}

  if (req.method === 'GET' && pathname === '/api/telemetry/system-summary') {
    try {
      const history = loadHistoryArray();
      if (history === null) {
        return sendJSON(res, 500, { ok: false, error: 'Erro ao ler arquivo de histórico' });
      }

      const targetDeviceId = parsedUrl.searchParams.get('device_id') || 'HIDRO-001';
      const summary = calculateSystemTotals(history, targetDeviceId);

      return sendJSON(res, 200, {
        ok: true,
        device_id: summary.device_id,
        system_pulse_total: summary.system_pulse_total,
        system_volume_liters: summary.system_volume_liters,
        pulse_events_total: summary.pulse_events_total,
        first_pulse_at: summary.first_pulse_at,
        last_pulse_at: summary.last_pulse_at,
        calibration_status: summary.calibration_status,
        liters_per_pulse: summary.liters_per_pulse
      });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: 'Erro interno ao gerar resumo do sistema' });
    }
  }

function getCalibrationSession(deviceId = 'HIDRO-001') {
  const config = loadConfig();
  const devConfig = (config.devices && config.devices[deviceId]) || null;
  if (!devConfig || !devConfig.calibration_session || devConfig.calibration_session.status !== 'active') {
    return null;
  }

  const session = devConfig.calibration_session;
  const rawHistory = loadHistoryArray() || [];
  const systemTotals = calculateSystemTotals(rawHistory, deviceId);
  const currentPulses = systemTotals.system_pulse_total;
  const startPulses = typeof session.start_system_pulse_total === 'number' ? session.start_system_pulse_total : 0;
  const pulseDiff = Math.max(0, currentPulses - startPulses);

  return {
    status: 'active',
    started_at: session.started_at,
    start_system_pulse_total: startPulses,
    current_system_pulse_total: currentPulses,
    pulse_difference: pulseDiff
  };
}

  if (req.method === 'POST' && pathname === '/api/config/calibration/start') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        let payload = {};
        if (body && body.trim() !== '') {
          payload = JSON.parse(body);
        }
        const deviceId = payload.device_id || 'HIDRO-001';

        const rawHistory = loadHistoryArray();
        if (rawHistory === null) {
          return sendJSON(res, 500, { ok: false, error: 'Erro ao ler arquivo de histórico' });
        }

        const systemTotals = calculateSystemTotals(rawHistory, deviceId);
        const currentPulses = systemTotals.system_pulse_total;

        const config = loadConfig();
        if (!config.devices) config.devices = {};
        if (!config.devices[deviceId]) {
          config.devices[deviceId] = {
            liters_per_pulse: null,
            calibration_status: 'pending',
            calibrated_at: null
          };
        }

        const sessionObj = {
          status: 'active',
          started_at: new Date().toISOString(),
          start_system_pulse_total: currentPulses
        };

        config.devices[deviceId].calibration_session = sessionObj;

        if (saveConfig(config)) {
          return sendJSON(res, 200, {
            ok: true,
            device_id: deviceId,
            calibration_session: {
              status: 'active',
              started_at: sessionObj.started_at,
              start_system_pulse_total: currentPulses,
              current_system_pulse_total: currentPulses,
              pulse_difference: 0
            }
          });
        } else {
          return sendJSON(res, 500, { ok: false, error: 'Erro ao salvar sessão de calibração' });
        }
      } catch (err) {
        return sendJSON(res, 400, { ok: false, error: 'Payload JSON inválido' });
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config/calibration/session') {
    try {
      const deviceId = parsedUrl.searchParams.get('device_id') || 'HIDRO-001';
      const sessionInfo = getCalibrationSession(deviceId);

      return sendJSON(res, 200, {
        ok: true,
        device_id: deviceId,
        calibration_session: sessionInfo
      });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: 'Erro interno ao consultar sessão de calibração' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/config/calibration/calculate') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const deviceId = payload.device_id || 'HIDRO-001';
        const knownVolume = parseFloat(payload.known_volume_liters);

        if (isNaN(knownVolume) || !Number.isFinite(knownVolume) || knownVolume <= 0) {
          return sendJSON(res, 400, { ok: false, error: 'O volume informado deve ser um número positivo.' });
        }

        const sessionInfo = getCalibrationSession(deviceId);
        if (!sessionInfo) {
          return sendJSON(res, 400, { ok: false, error: 'Nenhuma sessão de calibração ativa para este dispositivo.' });
        }

        if (sessionInfo.pulse_difference <= 0) {
          return sendJSON(res, 400, { ok: false, error: 'Nenhum pulso foi registrado durante a calibração.' });
        }

        const calculatedFactor = knownVolume / sessionInfo.pulse_difference;

        return sendJSON(res, 200, {
          ok: true,
          device_id: deviceId,
          start_pulses: sessionInfo.start_system_pulse_total,
          end_pulses: sessionInfo.current_system_pulse_total,
          pulse_difference: sessionInfo.pulse_difference,
          known_volume_liters: knownVolume,
          calculated_liters_per_pulse: calculatedFactor
        });
      } catch (err) {
        return sendJSON(res, 400, { ok: false, error: 'Payload JSON inválido' });
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/config/calibration/finish') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const deviceId = payload.device_id || 'HIDRO-001';
        const knownVolume = parseFloat(payload.known_volume_liters);

        if (isNaN(knownVolume) || !Number.isFinite(knownVolume) || knownVolume <= 0) {
          return sendJSON(res, 400, { ok: false, error: 'O volume informado deve ser um número positivo.' });
        }

        const sessionInfo = getCalibrationSession(deviceId);
        if (!sessionInfo) {
          return sendJSON(res, 400, { ok: false, error: 'Nenhuma sessão de calibração ativa para este dispositivo.' });
        }

        if (sessionInfo.pulse_difference <= 0) {
          return sendJSON(res, 400, { ok: false, error: 'Nenhum pulso foi registrado durante a calibração.' });
        }

        const calculatedFactor = knownVolume / sessionInfo.pulse_difference;

        const config = loadConfig();
        if (!config.devices) config.devices = {};
        if (!config.devices[deviceId]) config.devices[deviceId] = {};

        config.devices[deviceId].liters_per_pulse = calculatedFactor;
        config.devices[deviceId].calibration_status = 'calibrated';
        config.devices[deviceId].calibrated_at = new Date().toISOString();
        config.devices[deviceId].calibration_session = null;

        if (saveConfig(config)) {
          return sendJSON(res, 200, {
            ok: true,
            device_id: deviceId,
            liters_per_pulse: calculatedFactor,
            calibration_status: 'calibrated',
            calibrated_at: config.devices[deviceId].calibrated_at
          });
        } else {
          return sendJSON(res, 500, { ok: false, error: 'Erro ao salvar calibração finalizada' });
        }
      } catch (err) {
        return sendJSON(res, 400, { ok: false, error: 'Payload JSON inválido' });
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/config/calibration/cancel') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const deviceId = payload.device_id || 'HIDRO-001';

        const config = loadConfig();
        if (config.devices && config.devices[deviceId]) {
          config.devices[deviceId].calibration_session = null;
          saveConfig(config);
        }

        return sendJSON(res, 200, {
          ok: true,
          device_id: deviceId,
          message: 'Sessão de calibração cancelada.'
        });
      } catch (err) {
        return sendJSON(res, 400, { ok: false, error: 'Payload JSON inválido' });
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/telemetry/flow-sessions') {
    try {
      const history = loadHistoryArray();
      if (history === null) {
        return sendJSON(res, 500, { ok: false, error: 'Erro ao ler arquivo de histórico' });
      }

      const targetDeviceId = parsedUrl.searchParams.get('device_id') || 'HIDRO-001';
      let limit = 50;
      if (parsedUrl.searchParams.has('limit')) {
        const rawLimit = parseInt(parsedUrl.searchParams.get('limit'), 10);
        if (!isNaN(rawLimit) && rawLimit > 0) {
          limit = Math.min(rawLimit, 500);
        }
      }

      const sessions = calculateFlowSessions(history, targetDeviceId);
      const sorted = [...sessions].reverse().slice(0, limit);

      return sendJSON(res, 200, {
        ok: true,
        device_id: targetDeviceId,
        data: sorted
      });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: 'Erro interno ao buscar sessões de fluxo' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/telemetry/flow-sessions/summary') {
    try {
      const history = loadHistoryArray();
      if (history === null) {
        return sendJSON(res, 500, { ok: false, error: 'Erro ao ler arquivo de histórico' });
      }

      const targetDeviceId = parsedUrl.searchParams.get('device_id') || 'HIDRO-001';
      const calib = getDeviceCalibration(targetDeviceId);
      const sessions = calculateFlowSessions(history, targetDeviceId);

      const latestSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
      const isOpen = latestSession ? latestSession.status === 'open' : false;

      return sendJSON(res, 200, {
        ok: true,
        device_id: targetDeviceId,
        calibration_status: calib.status,
        liters_per_pulse: calib.liters_per_pulse,
        total_sessions: sessions.length,
        open_session: isOpen,
        latest_session: latestSession
      });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: 'Erro interno ao buscar resumo de sessões' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/system/reset') {
    try {
      // 1. Sobrescrever histórico com array vazio
      fs.writeFileSync(HISTORY_FILE, '[]\n', 'utf8');

      // 2. Sobrescrever última telemetria com objeto vazio
      fs.writeFileSync(DATA_FILE, '{}\n', 'utf8');

      console.log('[SISTEMA] Hard Reset executado com sucesso. Histórico e telemetria zerados.');

      return sendJSON(res, 200, {
        ok: true,
        message: 'Dados de telemetria e histórico resetados com sucesso.'
      });
    } catch (err) {
      console.error('Erro ao executar hard reset do sistema:', err);
      return sendJSON(res, 500, {
        ok: false,
        error: 'Erro interno ao resetar dados do sistema.'
      });
    }
  }

  if (req.method === 'POST' && pathname === '/api/telemetry') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) {
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body);

        if (!payload || typeof payload !== 'object') {
          return sendJSON(res, 400, { ok: false, error: 'Payload deve ser um objeto JSON' });
        }

        const { device_id, pulse_total, pulse_delta, liters_total, rssi } = payload;

        if (typeof device_id !== 'string' || device_id.trim() === '') {
          return sendJSON(res, 400, { ok: false, error: 'device_id é obrigatório e deve ser texto' });
        }

        if (typeof pulse_total !== 'number' || !Number.isFinite(pulse_total)) {
          return sendJSON(res, 400, { ok: false, error: 'pulse_total é obrigatório e deve ser número' });
        }

        if (typeof liters_total !== 'number' || !Number.isFinite(liters_total)) {
          return sendJSON(res, 400, { ok: false, error: 'liters_total é obrigatório e deve ser número' });
        }

        if (pulse_delta !== undefined && (typeof pulse_delta !== 'number' || !Number.isFinite(pulse_delta))) {
          return sendJSON(res, 400, { ok: false, error: 'pulse_delta deve ser número' });
        }

        if (rssi !== undefined && (typeof rssi !== 'number' || !Number.isFinite(rssi))) {
          return sendJSON(res, 400, { ok: false, error: 'rssi deve ser número' });
        }

        // 1. Ler estado anterior para comparacao de histórico
        let prevPulseTotal = null;
        if (fs.existsSync(DATA_FILE)) {
          try {
            const prevRaw = fs.readFileSync(DATA_FILE, 'utf8');
            if (prevRaw && prevRaw.trim() !== '') {
              const prevParsed = JSON.parse(prevRaw);
              if (prevParsed && typeof prevParsed.pulse_total === 'number') {
                prevPulseTotal = prevParsed.pulse_total;
              }
            }
          } catch (e) {}
        }

        const nowIso = new Date().toISOString();
        const cleanDeviceId = device_id.trim();
        const cleanRssi = rssi !== undefined ? rssi : null;
        const eventsToSave = [];

        if (prevPulseTotal === null) {
          if (pulse_total > 0) {
            eventsToSave.push({
              id: crypto.randomUUID(),
              type: 'pulse',
              device_id: cleanDeviceId,
              pulse_delta: pulse_total,
              pulse_total: pulse_total,
              liters_total_estimated: liters_total,
              rssi: cleanRssi,
              received_at: nowIso
            });
          }
        } else if (pulse_total > prevPulseTotal) {
          const effectiveDelta = pulse_total - prevPulseTotal;
          eventsToSave.push({
            id: crypto.randomUUID(),
            type: 'pulse',
            device_id: cleanDeviceId,
            pulse_delta: effectiveDelta,
            pulse_total: pulse_total,
            liters_total_estimated: liters_total,
            rssi: cleanRssi,
            received_at: nowIso
          });
        } else if (pulse_total < prevPulseTotal) {
          // Evento de Counter Reset
          eventsToSave.push({
            id: crypto.randomUUID(),
            type: 'counter_reset',
            device_id: cleanDeviceId,
            previous_pulse_total: prevPulseTotal,
            new_pulse_total: pulse_total,
            received_at: nowIso
          });

          if (pulse_total > 0) {
            eventsToSave.push({
              id: crypto.randomUUID(),
              type: 'pulse',
              device_id: cleanDeviceId,
              pulse_delta: pulse_total,
              pulse_total: pulse_total,
              liters_total_estimated: liters_total,
              rssi: cleanRssi,
              received_at: nowIso
            });
          }
        }

        // Salvar eventos históricos de forma segura se houver novos eventos
        if (eventsToSave.length > 0) {
          saveHistoryEvents(eventsToSave);
        }

        const telemetryRecord = {
          device_id: cleanDeviceId,
          pulse_total,
          pulse_delta: pulse_delta !== undefined ? pulse_delta : 0,
          liters_total,
          rssi: cleanRssi,
          received_at: nowIso
        };

        fs.writeFileSync(DATA_FILE, JSON.stringify(telemetryRecord, null, 2), 'utf8');

        return sendJSON(res, 200, {
          ok: true,
          data: telemetryRecord
        });
      } catch (err) {
        return sendJSON(res, 400, { ok: false, error: 'JSON inválido' });
      }
    });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }

  return sendJSON(res, 405, { ok: false, error: 'Método não permitido' });
});

server.listen(PORT, HOST, () => {
  console.log(`Servidor de telemetria rodando em http://${HOST}:${PORT}`);
});
