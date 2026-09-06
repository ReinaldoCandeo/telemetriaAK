/**
 * MAPA OPERACIONAL DOS PONTOS - TELEMETRIA HÍDRICA
 * Centro de Supervisão Executivo Georreferenciado
 * Protegido por Supabase Auth (Viewer / Admin)
 */

// 1. Configuração dos Pontos Operacionais
const POINTS_CONFIG = [
  {
    device_id: 'HIDRO-001',
    name: 'RESERVATÓRIO CENTRAL',
    description: 'Ponto de Medição Hidrômetro DN50',
    latitude: -22.778683,
    longitude: -50.220552
  }
];

// 2. Estado Global e Auth Single-Flight
let supabaseClient = null;
let authFailureHandling = false;
let activeIntervals = [];
let map = null;
let marker = null;
let currentFilter = 'all';
let searchQuery = '';

let refreshSessionPromise = null;

function registerInterval(fn, ms) {
  const id = setInterval(fn, ms);
  activeIntervals.push(id);
  return id;
}

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

async function tryRefreshSession() {
  if (refreshSessionPromise) return refreshSessionPromise;

  refreshSessionPromise = (async () => {
    try {
      if (!supabaseClient) return null;
      const { data, error } = await supabaseClient.auth.refreshSession();
      if (error || !data?.session?.access_token) {
        const { data: sData } = await supabaseClient.auth.getSession();
        return sData?.session?.access_token || null;
      }
      return data.session.access_token;
    } catch (err) {
      console.warn('Falha ao renovar sessão no mapa:', err);
      return null;
    } finally {
      refreshSessionPromise = null;
    }
  })();

  return refreshSessionPromise;
}

async function handleUnauthorizedOnce() {
  if (authFailureHandling) return;
  authFailureHandling = true;
  clearAllIntervals();

  if (supabaseClient) {
    try {
      await supabaseClient.auth.signOut({ scope: 'local' });
    } catch (e) {
      try { await supabaseClient.auth.signOut(); } catch (err) {}
    }
  }

  window.location.replace('/login.html?expired=1');
}

let telemetryCache = null;
let systemSummaryCache = null;
let flowSummaryCache = null;
let sessionsCache = null;
let dailySummaryCache = null;

// Elementos do DOM - Cabeçalho e Ações
const commStatusBadge = document.getElementById('comm-status-badge');
const btnRefresh = document.getElementById('btn-refresh');
const btnLogout = document.getElementById('btn-logout');
const linkDashboard = document.getElementById('link-dashboard');

// Elementos do DOM - Top Metrics Executivas (Max 5 cards)
const valMonitoredPoints = document.getElementById('val-monitored-points');
const valOnlinePoints = document.getElementById('val-online-points');
const valTotalVolumeM3Main = document.getElementById('val-total-volume-m3-main');
const valTotalVolumeLitersSub = document.getElementById('val-total-volume-liters-sub');
const valFlowTitleTop = document.getElementById('val-flow-title-top');
const valCurrentFlowMain = document.getElementById('val-current-flow-main');
const valCurrentFlowM3hSub = document.getElementById('val-current-flow-m3h-sub');
const valSessionStatusTop = document.getElementById('val-session-status-top');
const valSessionDetailTop = document.getElementById('val-session-detail-top');

// Elementos do DOM - Card Lateral HIDRO-001
const cardHidro001 = document.getElementById('card-hidro-001');
const hidroStatusPill = document.getElementById('hidro-status-pill');
const hidroFlowLabel = document.getElementById('hidro-flow-label');
const hidroFlowRecent = document.getElementById('hidro-flow-recent');
const hidroFlowM3h = document.getElementById('hidro-flow-m3h');
const hidroVolumeM3 = document.getElementById('hidro-volume-m3');
const hidroVolumeLiters = document.getElementById('hidro-volume-liters');
const hidroFlowAvgLabel = document.getElementById('hidro-flow-avg-label');
const hidroFlowAvg = document.getElementById('hidro-flow-avg');
const hidroFlowMax = document.getElementById('hidro-flow-max');
const hidroSessionStatus = document.getElementById('hidro-session-status');
const hidroSessionDetail = document.getElementById('hidro-session-detail');
const hidroLastReceivedHuman = document.getElementById('hidro-last-received-human');
const hidroLastReceivedTime = document.getElementById('hidro-last-received-time');
const hidroRssi = document.getElementById('hidro-rssi');
const hidroCalibFactor = document.getElementById('hidro-calib-factor');
const hidroPulsesTotal = document.getElementById('hidro-pulses-total');
const hidroGeoStatus = document.getElementById('hidro-geo-status');
const geoNotice = document.getElementById('geo-notice');

// Elementos do DOM - Gráfico 24h Executivo
const mapChartFlowWrapper = document.getElementById('map-chart-flow-wrapper');
const mapChartFlowEmpty = document.getElementById('map-chart-flow-empty');
const mapChartFlowSvg = document.getElementById('map-chart-flow-svg');
const mapSessionStatusBadge = document.getElementById('map-session-status-badge');
const mapSessionStatusText = document.getElementById('map-session-status-text');
const mapValLastPulseRelative = document.getElementById('map-val-last-pulse-relative');

// Filtros e Busca
const inputSearch = document.getElementById('input-search');
const filterTabs = document.querySelectorAll('.filter-tab');
const countAll = document.getElementById('count-all');
const countOnline = document.getElementById('count-online');
const countOffline = document.getElementById('count-offline');

// Rodapé
const barLastEsp = document.getElementById('bar-last-esp');
const barLastRefresh = document.getElementById('bar-last-refresh');

// 3. Helper de Fetch Autenticado para o Mapa
async function apiFetch(url, options = {}, isRetry = false) {
  if (authFailureHandling) return new Response(null, { status: 401 });
  if (!supabaseClient) {
    handleUnauthorizedOnce();
    return new Response(null, { status: 401 });
  }

  let token = null;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    token = session?.access_token || null;
  } catch (e) {
    token = null;
  }

  if (!token) {
    token = await tryRefreshSession();
    if (!token) {
      handleUnauthorizedOnce();
      return new Response(null, { status: 401 });
    }
  }

  if (authFailureHandling) return new Response(null, { status: 401 });

  const tokenUsed = token;
  const headers = {
    ...(options.headers || {}),
    'Authorization': `Bearer ${tokenUsed}`
  };

  const response = await fetch(url, { ...options, headers });

  if (authFailureHandling) return new Response(null, { status: 401 });

  if (response.status === 401) {
    if (!isRetry) {
      // 1. Verificar se a sessão atual já foi renovada por outra requisição concorrente (stale 401)
      let currentToken = null;
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        currentToken = session?.access_token || null;
      } catch (e) {
        currentToken = null;
      }

      if (currentToken && currentToken !== tokenUsed) {
        // Sessão já possui token novo: retentar uma única vez sem disparar novo refresh
        return apiFetch(url, options, true);
      }

      // 2. Token ainda é o mesmo ou ausente: acionar refreshSession single-flight
      const newToken = await tryRefreshSession();
      if (newToken) {
        return apiFetch(url, options, true);
      }
    }
    handleUnauthorizedOnce();
    return response;
  }

  if (response.status === 403) {
    alert('Você não possui permissão para visualizar a telemetria.');
    return response;
  }

  return response;
}

// 4. Utilitários de Data e Tempo Relativo
function getTodayLocalDateStr() {
  const d = new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function formatHumanRelativeTime(dateIso) {
  if (!dateIso) return 'Sem registro';
  const diffSec = Math.floor((Date.now() - new Date(dateIso).getTime()) / 1000);
  if (diffSec < 0) return 'agora';
  if (diffSec < 60) return `há ${diffSec} segundo${diffSec !== 1 ? 's' : ''}`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `há ${diffHours} h`;
  const diffDays = Math.floor(diffHours / 24);
  return `há ${diffDays} dia${diffDays !== 1 ? 's' : ''}`;
}

// 5. Normalização Centralizada de Dados (Snapshot Executivo Único)
// Executive UI consumes normalized backend metrics.
// Do not recalculate hydraulic metrics here.
function buildExecutiveSnapshot() {
  const now = Date.now();
  const recAt = telemetryCache?.received_at ? new Date(telemetryCache.received_at).getTime() : null;
  const isOnline = recAt !== null && (now - recAt <= 20000);

  const sum = sessionsCache?.summary;
  const hasOpenSession = Boolean(sum && sum.open_session);
  const latestSess = sum && sum.latest_session;

  let passageState = 'INDISPONÍVEL';
  let passageBadgeClass = 'status-offline';
  let passageDetail = 'Sem comunicação';

  if (isOnline) {
    if (hasOpenSession) {
      passageState = 'PASSAGEM ATIVA';
      passageBadgeClass = 'status-online';
      const durSec = latestSess?.duration_seconds || 0;
      passageDetail = `Em curso (${Math.round(durSec / 60)} min • ${latestSess?.pulse_count || 0}p)`;
    } else {
      passageState = 'SEM PASSAGEM';
      passageBadgeClass = 'status-offline';
      if (latestSess && latestSess.last_pulse_at) {
        const lastD = new Date(latestSess.last_pulse_at);
        passageDetail = `Última: ${lastD.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`;
      } else {
        passageDetail = 'Sem registros';
      }
    }
  } else {
    passageState = 'INDISPONÍVEL';
    passageBadgeClass = 'status-offline';
    passageDetail = 'Dispositivo offline';
  }

  let flowLabel = 'VAZÃO ATUAL';
  let flowLpmStr = '-- <span class="unit">L/min</span>';
  let flowM3hStr = '-- m³/h';
  let flowNumericLpm = null;

  const latestLpm = flowSummaryCache?.latest_flow_lpm;
  const latestM3h = flowSummaryCache?.latest_flow_m3h;

  if (isOnline) {
    flowLabel = 'VAZÃO ATUAL';
    if (hasOpenSession && typeof latestLpm === 'number') {
      flowNumericLpm = latestLpm;
      flowLpmStr = `${latestLpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} <span class="unit">L/min</span>`;
      flowM3hStr = `${typeof latestM3h === 'number' ? latestM3h.toLocaleString('pt-BR', { minimumFractionDigits: 3 }) : '--'} m³/h`;
    } else {
      flowNumericLpm = 0;
      flowLpmStr = `0,0 <span class="unit">L/min</span>`;
      flowM3hStr = `0,000 m³/h`;
    }
  } else {
    flowLabel = 'ÚLTIMA VAZÃO MEDIDA';
    if (typeof latestLpm === 'number') {
      flowNumericLpm = latestLpm;
      flowLpmStr = `${latestLpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} <span class="unit">L/min</span>`;
      flowM3hStr = `Última medição`;
    } else {
      flowLpmStr = `-- <span class="unit">L/min</span>`;
      flowM3hStr = `Sem medição`;
    }
  }

  let lastSignalHuman = 'Sem envio';
  let lastSignalTime = null;
  let lastSignalTimeStr = '--:--:--';
  if (telemetryCache?.received_at) {
    const d = new Date(telemetryCache.received_at);
    lastSignalHuman = formatHumanRelativeTime(telemetryCache.received_at);
    lastSignalTime = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    lastSignalTimeStr = lastSignalTime;
  }

  const todayStr = getTodayLocalDateStr();
  const todayItem = Array.isArray(dailySummaryCache?.items)
    ? dailySummaryCache.items.find(item => item.date === todayStr || item.local_date === todayStr)
    : null;

  let todayVolM3Str = '-- <span class="unit">m³</span>';
  let todayVolLitersSub = isOnline ? '00:00 → agora' : (lastSignalTime ? `00:00 → ${lastSignalTime}` : 'cobertura indisponível');
  let todayStatus = todayItem?.status || 'EM_ANDAMENTO';
  let hasTodayData = false;

  if (todayItem && todayItem.status !== 'SEM_REGISTRO' && typeof todayItem.volume_m3 === 'number') {
    hasTodayData = true;
    todayVolM3Str = `${todayItem.volume_m3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} <span class="unit">m³</span>`;
    const lit = typeof todayItem.volume_liters === 'number' ? todayItem.volume_liters.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '--';
    
    if (isOnline) {
      todayVolLitersSub = `${lit} L • 00:00 → agora`;
    } else if (lastSignalTime) {
      todayVolLitersSub = `${lit} L • 00:00 → ${lastSignalTime}`;
    } else {
      todayVolLitersSub = `${lit} L • cobertura indisponível`;
    }
  } else if (todayItem?.status === 'SEM_REGISTRO') {
    todayVolM3Str = `-- <span class="unit">m³</span>`;
    todayVolLitersSub = `Sem registros hoje`;
  }

  let todayAvgFlowStr = '-- <span class="unit">L/min</span>';
  let todayMaxFlowStr = 'Pico: -- L/min';
  let todayAvgFlowPopupStr = '--';
  let todayMaxFlowPopupStr = '--';

  if (hasTodayData && typeof todayItem.average_flow_lpm === 'number') {
    const formattedAvg = todayItem.average_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
    todayAvgFlowStr = `${formattedAvg} <span class="unit">L/min</span>`;
    todayAvgFlowPopupStr = `${formattedAvg} L/min`;
  }
  if (hasTodayData && typeof todayItem.max_flow_lpm === 'number') {
    const formattedMax = todayItem.max_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
    todayMaxFlowStr = `Pico: ${formattedMax} L/min`;
    todayMaxFlowPopupStr = `${formattedMax} L/min`;
  }

  const sysVol = systemSummaryCache?.system_volume_liters;
  let totalVolM3Str = '-- m³';
  let totalVolLitersStr = '-- L';
  if (typeof sysVol === 'number') {
    totalVolM3Str = `${(sysVol / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} m³`;
    totalVolLitersStr = `${sysVol.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L`;
  }

  let lastPulseTime = '--:--:--';
  const lastPulseIso = flowSummaryCache?.last_pulse_at || todayItem?.last_pulse_at || latestSess?.last_pulse_at;
  if (lastPulseIso) {
    lastPulseTime = new Date(lastPulseIso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }

  const wifiRssi = telemetryCache?.rssi !== null && telemetryCache?.rssi !== undefined ? `${telemetryCache.rssi} dBm` : '-- dBm';
  const calibFactor = systemSummaryCache?.liters_per_pulse || telemetryCache?.calibration?.liters_per_pulse || 101.63;
  const pulsesTotal = systemSummaryCache?.system_pulse_total !== undefined
    ? systemSummaryCache.system_pulse_total.toLocaleString('pt-BR')
    : (telemetryCache?.pulse_total ? telemetryCache.pulse_total.toLocaleString('pt-BR') : '--');

  return {
    deviceId: 'HIDRO-001',
    isOnline,
    passageState,
    passageBadgeClass,
    passageDetail,
    flowLabel,
    flowLpmStr,
    flowM3hStr,
    flowNumericLpm,
    todayStatus,
    todayVolM3Str,
    todayVolLitersSub,
    todayAvgFlowStr,
    todayMaxFlowStr,
    todayAvgFlowPopupStr,
    todayMaxFlowPopupStr,
    totalVolM3Str,
    totalVolLitersStr,
    lastSignalHuman,
    lastSignalTime: lastSignalTimeStr,
    lastPulseTime,
    lastPulseIso,
    wifiRssi,
    calibFactor,
    pulsesTotal
  };
}

// 6. Formatação do Popup Executivo com Dados Reais
function generatePopupContent(snapshot) {
  const snap = snapshot || buildExecutiveSnapshot();
  const statusBadge = snap.isOnline
    ? '<span class="popup-badge online">ONLINE</span>'
    : '<span class="popup-badge offline">OFFLINE</span>';

  const passageColor = snap.passageBadgeClass === 'status-online' ? 'color:#10b981;' : 'color:#64748b;';

  return `
    <div class="popup-executive-card">
      <div class="popup-header">
        <div>
          <div class="popup-title">RESERVATÓRIO CENTRAL</div>
          <span class="popup-tech-code">HIDRO-001</span>
        </div>
        <div>${statusBadge}</div>
      </div>
      <div class="popup-body">
        <div class="popup-metric-row">
          <span class="popup-metric-label">Passagem:</span>
          <span class="popup-metric-val" style="${passageColor} font-weight:700;">${snap.passageState}</span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">${snap.flowLabel}:</span>
          <span class="popup-metric-val">${snap.flowLpmStr} <span style="font-size:10px; color:#64748b;">(${snap.flowM3hStr})</span></span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Volume Hoje:</span>
          <span class="popup-metric-val">${snap.todayVolM3Str} <span style="font-size:10px; color:#64748b;">(${snap.todayVolLitersSub})</span></span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Média Hoje:</span>
          <span class="popup-metric-val">${snap.todayAvgFlowPopupStr}</span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Pico Hoje:</span>
          <span class="popup-metric-val">${snap.todayMaxFlowPopupStr}</span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Último Sinal:</span>
          <span class="popup-metric-val">${snap.lastSignalHuman} <span style="font-size:10px; color:#64748b;">(${snap.lastSignalTime})</span></span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Último Pulso:</span>
          <span class="popup-metric-val">${snap.lastPulseTime}</span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Acumulado Geral:</span>
          <span class="popup-metric-val">${snap.totalVolM3Str}</span>
        </div>
      </div>
      <div class="popup-tech-footer">
        <div style="display:flex; justify-content:space-between;">
          <span>Sinal: <strong>${snap.wifiRssi}</strong></span>
          <span>Calibração: <strong>${snap.calibFactor} L/p</strong></span>
        </div>
        <div style="display:flex; justify-content:space-between; margin-top:2px;">
          <span>Pulsos: <strong>${snap.pulsesTotal}</strong></span>
          <span>Palmital / SP</span>
        </div>
      </div>
    </div>
  `;
}

// 5. Inicialização do Mapa Leaflet
function createMarkerIcon(isOnline) {
  const statusClass = isOnline ? 'online' : 'offline';
  return L.divIcon({
    className: 'custom-scada-marker-icon',
    html: `
      <div class="scada-marker-container">
        <div class="scada-marker-halo ${statusClass}"></div>
        <div class="scada-marker-dot ${statusClass}"></div>
      </div>
    `,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -14]
  });
}

function initMap() {
  const hidro = POINTS_CONFIG[0];
  const initialCoords = (hidro.latitude !== null && hidro.longitude !== null)
    ? [hidro.latitude, hidro.longitude]
    : [-22.7885, -50.2195];
  const initialZoom = (hidro.latitude !== null && hidro.longitude !== null) ? 17 : 14;

  map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView(initialCoords, initialZoom);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  if (hidro.latitude !== null && hidro.longitude !== null) {
    if (geoNotice) geoNotice.classList.add('hidden');
    
    marker = L.marker([hidro.latitude, hidro.longitude], {
      icon: createMarkerIcon(false)
    }).addTo(map);

    marker.bindTooltip(`
      <div style="font-weight:700;">RESERVATÓRIO CENTRAL</div>
      <div style="font-size:11px; color:#94a3b8;">HIDRO-001</div>
    `, {
      className: 'scada-map-tooltip',
      direction: 'top',
      offset: [0, -10]
    });

    marker.bindPopup(generatePopupContent(buildExecutiveSnapshot()));
  } else {
    if (geoNotice) geoNotice.classList.remove('hidden');
  }
}

// 7. Consulta às APIs Reais Protegidas por Bearer
async function fetchTelemetryData() {
  if (authFailureHandling) return;
  try {
    const [latestRes, sysRes, flowRes] = await Promise.all([
      apiFetch('/api/telemetry/latest', { cache: 'no-store' }),
      apiFetch('/api/telemetry/system-summary', { cache: 'no-store' }),
      apiFetch('/api/telemetry/flow-summary', { cache: 'no-store' })
    ]);

    if (latestRes && latestRes.ok) {
      const j = await latestRes.json();
      if (j.ok) telemetryCache = j.data;
    }
    if (sysRes && sysRes.ok) {
      const j = await sysRes.json();
      if (j.ok) systemSummaryCache = j;
    }
    if (flowRes && flowRes.ok) {
      const j = await flowRes.json();
      if (j.ok) flowSummaryCache = j;
    }

    updateUI();
  } catch (err) {
    console.error('Erro ao buscar dados de telemetria no mapa:', err);
  }
}

async function fetchSessionsData() {
  if (authFailureHandling) return;
  try {
    const res = await apiFetch('/api/telemetry/flow-sessions?limit=50', { cache: 'no-store' });
    if (res && res.ok) {
      const j = await res.json();
      if (j.ok) {
        sessionsCache = j;
      }
    }
    updateUI();
  } catch (err) {
    console.error('Erro ao buscar sessões no mapa:', err);
  }
}

async function fetchDailySummary() {
  if (authFailureHandling) return;
  try {
    const res = await apiFetch('/api/telemetry/daily-summary?days=7', { cache: 'no-store' });
    if (res && res.ok) {
      const j = await res.json();
      if (j.ok) {
        dailySummaryCache = j;
      }
    }
    updateUI();
  } catch (err) {
    console.error('Erro ao buscar daily summary no mapa:', err);
  }
}

// 8. Atualização Visual da Interface com Snapshot Único
function updateUI() {
  const snapshot = buildExecutiveSnapshot();

  // A. Header Communication Status
  if (commStatusBadge) {
    if (snapshot.isOnline) {
      commStatusBadge.className = 'status-indicator status-online';
      commStatusBadge.textContent = 'ONLINE';
    } else {
      commStatusBadge.className = 'status-indicator status-offline';
      commStatusBadge.textContent = 'OFFLINE';
    }
  }

  // B. Top Metric Cards (5 Cards Executivos)
  if (valOnlinePoints) valOnlinePoints.textContent = snapshot.isOnline ? '1' : '0';

  // Volume Hoje (m³ em destaque)
  if (valTotalVolumeM3Main && valTotalVolumeLitersSub) {
    valTotalVolumeM3Main.innerHTML = snapshot.todayVolM3Str;
    valTotalVolumeLitersSub.textContent = `${snapshot.todayVolLitersSub} • Total: ${snapshot.totalVolM3Str}`;
  }

  // Vazão Atual ou Última Medição
  if (valFlowTitleTop) valFlowTitleTop.textContent = snapshot.flowLabel;
  if (valCurrentFlowMain && valCurrentFlowM3hSub) {
    valCurrentFlowMain.innerHTML = snapshot.flowLpmStr;
    valCurrentFlowM3hSub.textContent = snapshot.flowM3hStr;
  }

  // Passagem Top Card
  if (valSessionStatusTop && valSessionDetailTop) {
    const colorStyle = snapshot.passageBadgeClass === 'status-online' ? 'color: #10b981;' : 'color: #64748b;';
    valSessionStatusTop.innerHTML = `<span style="${colorStyle} font-weight: 800;">${snapshot.passageState}</span>`;
    valSessionDetailTop.textContent = snapshot.passageDetail;
  }

  // C. Side Card HIDRO-001 (RESERVATÓRIO CENTRAL)
  if (hidroStatusPill) {
    hidroStatusPill.className = snapshot.isOnline ? 'status-pill status-online' : 'status-pill status-offline';
    hidroStatusPill.textContent = snapshot.isOnline ? 'ONLINE' : 'OFFLINE';
  }

  if (hidroFlowLabel) hidroFlowLabel.textContent = snapshot.flowLabel;
  if (hidroFlowRecent && hidroFlowM3h) {
    hidroFlowRecent.innerHTML = snapshot.flowLpmStr;
    hidroFlowM3h.textContent = snapshot.flowM3hStr;
  }

  if (hidroVolumeM3 && hidroVolumeLiters) {
    hidroVolumeM3.innerHTML = snapshot.todayVolM3Str;
    hidroVolumeLiters.textContent = `${snapshot.todayVolLitersSub} • Total: ${snapshot.totalVolM3Str}`;
  }

  if (hidroFlowAvg && hidroFlowMax) {
    hidroFlowAvg.innerHTML = snapshot.todayAvgFlowStr;
    hidroFlowMax.textContent = snapshot.todayMaxFlowStr;
  }

  if (hidroSessionStatus && hidroSessionDetail) {
    const colorStyle = snapshot.passageBadgeClass === 'status-online' ? 'color: #10b981;' : 'color: #64748b;';
    hidroSessionStatus.innerHTML = `<span style="${colorStyle} font-weight: 700;">${snapshot.passageState}</span>`;
    hidroSessionDetail.textContent = snapshot.passageDetail;
  }

  if (hidroLastReceivedHuman && hidroLastReceivedTime) {
    hidroLastReceivedHuman.textContent = snapshot.lastSignalHuman;
    hidroLastReceivedTime.textContent = snapshot.lastSignalTime;
  }

  if (hidroRssi) hidroRssi.textContent = snapshot.wifiRssi;
  if (hidroCalibFactor) hidroCalibFactor.textContent = `${snapshot.calibFactor} L/p`;
  if (hidroPulsesTotal) hidroPulsesTotal.textContent = `${snapshot.pulsesTotal} p`;

  if (hidroGeoStatus) {
    const hidro = POINTS_CONFIG[0];
    if (hidro.latitude !== null && hidro.longitude !== null) {
      hidroGeoStatus.className = 'tech-val font-mono text-online';
      hidroGeoStatus.textContent = `${hidro.latitude.toFixed(6)}, ${hidro.longitude.toFixed(6)}`;
    } else {
      hidroGeoStatus.className = 'tech-val font-mono text-warning';
      hidroGeoStatus.textContent = 'Pendente';
    }
  }

  // D. Atualização do Marcador e Popup no Leaflet
  if (marker) {
    marker.setIcon(createMarkerIcon(snapshot.isOnline));
    marker.setPopupContent(generatePopupContent(snapshot));
  }

  // E. Filtros e Busca
  applyFilters(snapshot.isOnline);

  // F. Footer Status Bar
  if (barLastEsp) {
    if (telemetryCache?.received_at) {
      const d = new Date(telemetryCache.received_at);
      barLastEsp.textContent = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    } else {
      barLastEsp.textContent = '--:--:--';
    }
  }

  // F. Gráfico 24h Header Status Badge & Relative Time
  if (mapSessionStatusBadge && mapSessionStatusText) {
    const sum = sessionsCache?.summary;
    const hasOpen = sum && sum.open_session;
    if (hasOpen) {
      mapSessionStatusBadge.className = 'session-status-badge status-online';
      mapSessionStatusText.textContent = 'PASSAGEM';
    } else {
      mapSessionStatusBadge.className = 'session-status-badge status-offline';
      mapSessionStatusText.textContent = 'SEM PASSAGEM';
    }
  }

  if (mapValLastPulseRelative) {
    const lastPulseAt = flowSummaryCache?.last_pulse_at || sessionsCache?.summary?.latest_session?.last_pulse_at;
    mapValLastPulseRelative.textContent = lastPulseAt ? formatHumanRelativeTime(lastPulseAt) : 'Nenhum pulso registrado';
  }
}


// 9. Filtros e Busca em Memória
function applyFilters(isOnline) {
  if (countAll) countAll.textContent = '1';
  if (countOnline) countOnline.textContent = isOnline ? '1' : '0';
  if (countOffline) countOffline.textContent = isOnline ? '0' : '1';

  let visible = true;

  // Filtro de Status
  if (currentFilter === 'online' && !isOnline) visible = false;
  if (currentFilter === 'offline' && isOnline) visible = false;

  // Filtro de Busca
  if (searchQuery.trim() !== '') {
    const q = searchQuery.trim().toLowerCase();
    const match = 'reservatório central'.includes(q) ||
                  'reservatorio central'.includes(q) ||
                  'reservatório'.includes(q) ||
                  'reservatorio'.includes(q) ||
                  'central'.includes(q) ||
                  'hidro-001'.includes(q) ||
                  'hidrômetro'.includes(q) ||
                  'hidrometro'.includes(q) ||
                  'dn50'.includes(q) ||
                  'palmital'.includes(q);
    if (!match) visible = false;
  }

  if (cardHidro001) {
    if (visible) {
      cardHidro001.classList.remove('hidden');
    } else {
      cardHidro001.classList.add('hidden');
    }
  }
}

// 10. Funções do Gráfico 24h Executivo (Comportamento da Vazão)
function calculateNiceTicks(maxValue, targetTicks = 5) {
  if (typeof maxValue !== 'number' || isNaN(maxValue) || maxValue <= 0) {
    return [0, 10, 20, 30, 40, 50];
  }

  const rawStep = maxValue / (targetTicks - 1);
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = Math.pow(10, exponent);
  const fraction = rawStep / magnitude;

  let niceFraction;
  if (fraction <= 1.25) {
    niceFraction = 1;
  } else if (fraction <= 2.25) {
    niceFraction = 2;
  } else if (fraction <= 3.5) {
    niceFraction = 2.5;
  } else if (fraction <= 7.5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }

  const step = niceFraction * magnitude;
  const niceMax = Math.ceil(maxValue / step) * step;

  const ticks = [];
  const count = Math.round(niceMax / step);
  for (let i = 0; i <= count; i++) {
    const val = i * step;
    ticks.push(Math.round(val * 100) / 100);
  }

  if (ticks.length < 2) {
    return [0, Math.max(10, niceMax)];
  }
  return ticks;
}

const MAP_FLOW_CHART_GEOMETRY = {
  width: 700,
  height: 240,
  padLeft: 75,
  padRight: 25,
  padTop: 20,
  padBottom: 35
};

let cachedMapFlowChartPoints = [];

function handleMapFlowChartInteraction(e) {
  if (!mapChartFlowSvg || !cachedMapFlowChartPoints || cachedMapFlowChartPoints.length === 0) return;
  const flowTooltip = document.getElementById('map-flow-chart-tooltip');
  const interactiveGroup = document.getElementById('map-flow-interactive-group');
  const guideline = document.getElementById('map-flow-guideline');
  const highlightPoint = document.getElementById('map-flow-point-highlight');
  const highlightRing = document.getElementById('map-flow-point-ring');

  const rect = mapChartFlowSvg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  // 1. Converter coordenadas do cursor para o espaço do viewBox SVG (0..700, 0..240)
  const svgX = ((clientX - rect.left) / rect.width) * MAP_FLOW_CHART_GEOMETRY.width;
  const svgY = ((clientY - rect.top) / rect.height) * MAP_FLOW_CHART_GEOMETRY.height;

  // 2. Limites exatos do plot útil (área de desenho da curva)
  const plotLeft = MAP_FLOW_CHART_GEOMETRY.padLeft;
  const plotRight = MAP_FLOW_CHART_GEOMETRY.width - MAP_FLOW_CHART_GEOMETRY.padRight;
  const plotTop = MAP_FLOW_CHART_GEOMETRY.padTop;
  const plotBottom = MAP_FLOW_CHART_GEOMETRY.height - MAP_FLOW_CHART_GEOMETRY.padBottom;
  const TOLERANCE = 4;

  // 3. Hit-test estrito: se o cursor estiver fora da área do plot, esconder imediatamente
  if (
    svgX < plotLeft - TOLERANCE ||
    svgX > plotRight + TOLERANCE ||
    svgY < plotTop - TOLERANCE ||
    svgY > plotBottom + TOLERANCE
  ) {
    hideMapFlowChartInteraction();
    return;
  }

  // 4. Encontrar o ponto/bucket mais próximo dentro dos 288 buckets
  let closest = cachedMapFlowChartPoints[0];
  let minDiff = Math.abs(svgX - closest.x);
  for (let i = 1; i < cachedMapFlowChartPoints.length; i++) {
    const diff = Math.abs(svgX - cachedMapFlowChartPoints[i].x);
    if (diff < minDiff) {
      minDiff = diff;
      closest = cachedMapFlowChartPoints[i];
    }
  }

  if (!closest) {
    hideMapFlowChartInteraction();
    return;
  }

  const targetY = closest.y !== null ? closest.y : plotBottom;

  // 5. Atualizar marcador vertical ancorado no dado real do bucket
  if (interactiveGroup && guideline && highlightPoint && highlightRing) {
    guideline.setAttribute('x1', closest.x.toFixed(1));
    guideline.setAttribute('x2', closest.x.toFixed(1));
    highlightPoint.setAttribute('cx', closest.x.toFixed(1));
    highlightPoint.setAttribute('cy', targetY.toFixed(1));
    highlightRing.setAttribute('cx', closest.x.toFixed(1));
    highlightRing.setAttribute('cy', targetY.toFixed(1));

    let color = '#0284c7';
    if (closest.status === 'insufficient_data') color = '#f59e0b';
    else if (closest.status === 'no_flow') color = '#94a3b8';

    highlightPoint.setAttribute('fill', color);
    highlightRing.setAttribute('stroke', color);
    guideline.setAttribute('stroke', color);

    interactiveGroup.style.display = '';
  }

  // 6. Atualizar Tooltip HTML e posicionamento com acompanhamento do cursor + detecção de colisão
  if (flowTooltip && mapChartFlowWrapper) {
    let statusText = 'SEM PASSAGEM';
    let statusClass = 'status-no-flow';
    if (closest.status === 'flow') {
      statusText = 'PASSAGEM';
      statusClass = 'status-flow';
    } else if (closest.status === 'insufficient_data') {
      statusText = 'DADOS INSUFICIENTES';
      statusClass = 'status-insufficient';
    }

    let flowAvgStr = '--';
    if (closest.status === 'flow' && typeof closest.flow_lpm === 'number') {
      flowAvgStr = `${closest.flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L/min`;
    } else if (closest.status === 'no_flow') {
      flowAvgStr = '0,0 L/min';
    }

    let flowMaxStr = '--';
    if (typeof closest.max_flow_lpm === 'number' && closest.max_flow_lpm > 0) {
      flowMaxStr = `${closest.max_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L/min`;
    } else if (closest.status === 'flow' && typeof closest.flow_lpm === 'number') {
      flowMaxStr = `${closest.flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L/min`;
    } else if (closest.status === 'no_flow') {
      flowMaxStr = '0,0 L/min';
    }

    const volStr = typeof closest.volume_liters === 'number'
      ? `${closest.volume_liters.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} L`
      : '--';

    const pulseStr = typeof closest.pulse_count === 'number'
      ? `${closest.pulse_count.toLocaleString('pt-BR')}`
      : '--';

    flowTooltip.innerHTML = `
      <div class="tt-header">
        <span class="tt-date">${closest.timeLabel || '--'}</span>
        <span class="tt-status ${statusClass}">${statusText}</span>
      </div>
      <div class="tt-row"><span class="tt-label">Vazão Média:</span><span class="tt-val" style="color:#38bdf8;">${flowAvgStr}</span></div>
      <div class="tt-row"><span class="tt-label">PICO NO INTERVALO:</span><span class="tt-val">${flowMaxStr}</span></div>
      <div class="tt-row"><span class="tt-label">Volume:</span><span class="tt-val">${volStr}</span></div>
      <div class="tt-row"><span class="tt-label">Pulsos:</span><span class="tt-val">${pulseStr}</span></div>
      <div class="tt-hint">Média do intervalo de 5 min</div>
    `;

    const wrapperRect = mapChartFlowWrapper.getBoundingClientRect();
    const cursorX = clientX - wrapperRect.left;
    const cursorY = clientY - wrapperRect.top;

    // Posicionamento horizontal acompanhando o cursor e limitado pelas bordas do container
    const clampedX = Math.max(120, Math.min(wrapperRect.width - 120, cursorX));
    flowTooltip.style.left = `${clampedX}px`;

    // Posicionamento vertical acompanhando o cursor com inversão inteligente (Flip Top/Bottom)
    if (cursorY < 145) {
      // Abre abaixo do cursor quando próximo ao topo para evitar corte visual
      flowTooltip.style.top = `${cursorY}px`;
      flowTooltip.style.transform = 'translate(-50%, 0)';
      flowTooltip.style.marginTop = '14px';
    } else {
      // Abre acima do cursor
      flowTooltip.style.top = `${cursorY}px`;
      flowTooltip.style.transform = 'translate(-50%, -100%)';
      flowTooltip.style.marginTop = '-12px';
    }

    flowTooltip.classList.add('visible');
  }
}

function hideMapFlowChartInteraction() {
  const flowTooltip = document.getElementById('map-flow-chart-tooltip');
  const interactiveGroup = document.getElementById('map-flow-interactive-group');
  if (flowTooltip) {
    flowTooltip.classList.remove('visible');
    flowTooltip.style.transform = '';
    flowTooltip.style.marginTop = '';
  }
  if (interactiveGroup) interactiveGroup.style.display = 'none';
}

async function fetchFlowChart24h() {
  if (authFailureHandling) return;
  try {
    const res = await apiFetch('/api/telemetry/flow-chart-24h', { cache: 'no-store' });
    if (res && res.ok) {
      const j = await res.json();
      if (j.ok) {
        renderMapFlowChart(j.data || []);
      }
    }
  } catch (err) {
    console.error('Erro ao buscar dados do gráfico 24h no mapa:', err);
  }
}

function renderMapFlowChart(chartBuckets) {
  if (!mapChartFlowSvg || !mapChartFlowEmpty) return;

  if (!Array.isArray(chartBuckets) || chartBuckets.length === 0) {
    mapChartFlowEmpty.classList.remove('hidden');
    mapChartFlowSvg.classList.add('hidden');
    cachedMapFlowChartPoints = [];
    return;
  }

  mapChartFlowEmpty.classList.add('hidden');
  mapChartFlowSvg.classList.remove('hidden');

  const width = MAP_FLOW_CHART_GEOMETRY.width;
  const height = MAP_FLOW_CHART_GEOMETRY.height;
  const padLeft = MAP_FLOW_CHART_GEOMETRY.padLeft;
  const padRight = MAP_FLOW_CHART_GEOMETRY.padRight;
  const padTop = MAP_FLOW_CHART_GEOMETRY.padTop;
  const padBottom = MAP_FLOW_CHART_GEOMETRY.padBottom;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const bottomY = height - padBottom; // 205
  const topY = padTop; // 20

  // Obter maior vazão válida baseada SOMENTE em flow_lpm para definir escala do eixo Y
  const flowVals = chartBuckets
    .filter(b => typeof b.flow_lpm === 'number' && b.flow_lpm > 0)
    .map(b => b.flow_lpm);

  const rawMax = flowVals.length > 0 ? Math.max(...flowVals) : 50;
  const ticks = calculateNiceTicks(rawMax, 5);
  const niceMax = ticks[ticks.length - 1] || 50;

  const total = chartBuckets.length;

  const points = chartBuckets.map((b, idx) => {
    const x = total > 1
      ? padLeft + (idx / (total - 1)) * chartW
      : padLeft + chartW / 2;

    let y = null;
    if (typeof b.flow_lpm === 'number') {
      y = bottomY - (Math.max(0, b.flow_lpm) / niceMax) * chartH;
    }

    const recDate = b.timestamp
      ? new Date(b.timestamp)
      : (b.bucket_start ? new Date(b.bucket_start) : null);

    const timeLabel = recDate
      ? recDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
      : '';

    return { ...b, x, y, timeLabel, idx };
  });

  cachedMapFlowChartPoints = points;

  // Dividir em segmentos contínuos com valores numéricos (ignora gaps de insufficient_data)
  const segments = [];
  let currentSeg = [];

  points.forEach(p => {
    if (p.y !== null) {
      currentSeg.push(p);
    } else {
      if (currentSeg.length > 0) {
        segments.push(currentSeg);
        currentSeg = [];
      }
    }
  });
  if (currentSeg.length > 0) {
    segments.push(currentSeg);
  }

  let pathsSvg = '';
  segments.forEach(seg => {
    let pathD = '';
    let areaD = '';
    if (seg.length === 1) {
      pathD = `M ${(seg[0].x - 1.5).toFixed(1)} ${seg[0].y.toFixed(1)} L ${(seg[0].x + 1.5).toFixed(1)} ${seg[0].y.toFixed(1)}`;
      areaD = `M ${(seg[0].x - 1.5).toFixed(1)} ${bottomY} L ${(seg[0].x - 1.5).toFixed(1)} ${seg[0].y.toFixed(1)} L ${(seg[0].x + 1.5).toFixed(1)} ${seg[0].y.toFixed(1)} L ${(seg[0].x + 1.5).toFixed(1)} ${bottomY} Z`;
    } else {
      pathD = seg.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      areaD = `${pathD} L ${seg[seg.length - 1].x.toFixed(1)} ${bottomY} L ${seg[0].x.toFixed(1)} ${bottomY} Z`;
    }
    pathsSvg += `
      <path d="${areaD}" fill="url(#mapFlowAreaGrad)"/>
      <path d="${pathD}" fill="none" stroke="#0284c7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  });

  // Ticks e Grid do Eixo Y
  let yGridSvg = '';
  ticks.forEach(tickVal => {
    const tickY = bottomY - (tickVal / niceMax) * chartH;
    const isZero = tickVal === 0;
    const strokeColor = isZero ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.06)';
    const strokeDash = isZero ? 'none' : '3,3';

    yGridSvg += `
      <line x1="${padLeft}" y1="${tickY.toFixed(1)}" x2="${(width - padRight).toFixed(1)}" y2="${tickY.toFixed(1)}" stroke="${strokeColor}" stroke-dasharray="${strokeDash}"/>
      <text x="${(padLeft - 10).toFixed(1)}" y="${(tickY + 3.5).toFixed(1)}" fill="#64748b" font-size="10" text-anchor="end" font-family="JetBrains Mono">${tickVal.toLocaleString('pt-BR')} L/min</text>
    `;
  });

  // 5 marcas temporais de referência no Eixo X (24h)
  const timeTickIndices = [
    0,
    Math.floor(total * 0.25),
    Math.floor(total * 0.5),
    Math.floor(total * 0.75),
    total - 1
  ];

  let xGridAndLabels = '';
  timeTickIndices.forEach((tIdx, i) => {
    if (tIdx >= 0 && tIdx < points.length) {
      const pt = points[tIdx];
      const anchor = i === 0 ? 'start' : (i === timeTickIndices.length - 1 ? 'end' : 'middle');
      const isLast = i === timeTickIndices.length - 1;
      const labelContent = isLast
        ? `<tspan font-weight="700" fill="#0284c7">AGORA</tspan> <tspan font-size="8" fill="#64748b">(${pt.timeLabel})</tspan>`
        : (pt.timeLabel || '--');

      xGridAndLabels += `
        <line x1="${pt.x.toFixed(1)}" y1="${topY}" x2="${pt.x.toFixed(1)}" y2="${bottomY}" stroke="rgba(0,0,0,0.04)" stroke-dasharray="2,4"/>
        <text x="${pt.x.toFixed(1)}" y="${(bottomY + 18).toFixed(1)}" fill="#64748b" font-size="9" text-anchor="${anchor}" font-family="JetBrains Mono">${labelContent}</text>
      `;
    }
  });

  let svgContent = `
    <defs>
      <linearGradient id="mapFlowAreaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.30"/>
        <stop offset="85%" stop-color="#38bdf8" stop-opacity="0.04"/>
        <stop offset="100%" stop-color="#0284c7" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    ${yGridSvg}
    ${xGridAndLabels}
    ${pathsSvg}
    <g id="map-flow-interactive-group" style="display: none; pointer-events: none;">
      <line id="map-flow-guideline" x1="0" y1="${topY}" x2="0" y2="${bottomY}" stroke="#0284c7" stroke-width="1.2" stroke-dasharray="3,3" opacity="0.8"/>
      <circle id="map-flow-point-ring" cx="0" cy="0" r="9" fill="none" stroke="#0284c7" stroke-width="1.5" opacity="0.4"/>
      <circle id="map-flow-point-highlight" cx="0" cy="0" r="4.5" fill="#0284c7" stroke="#ffffff" stroke-width="2"/>
    </g>
  `;

  mapChartFlowSvg.innerHTML = svgContent;
}

// 11. Setup Event Listeners
function setupEventListeners() {
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      fetchTelemetryData();
      fetchSessionsData();
      fetchDailySummary();
      fetchFlowChart24h();
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      authFailureHandling = true;
      clearAllIntervals();
      if (supabaseClient) {
        try { await supabaseClient.auth.signOut(); } catch (e) {}
      }
      window.location.replace('/login.html');
    });
  }

  if (cardHidro001) {
    cardHidro001.addEventListener('click', () => {
      const hidro = POINTS_CONFIG[0];
      if (map && hidro.latitude !== null && hidro.longitude !== null) {
        map.flyTo([hidro.latitude, hidro.longitude], 17, { animate: true, duration: 0.8 });
        if (marker) marker.openPopup();
      }
    });
  }

  if (inputSearch) {
    inputSearch.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      const now = Date.now();
      const recAt = telemetryCache?.received_at ? new Date(telemetryCache.received_at).getTime() : null;
      const isOnline = recAt !== null && (now - recAt <= 20000);
      applyFilters(isOnline);
    });
  }

  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.getAttribute('data-filter') || 'all';
      
      const now = Date.now();
      const recAt = telemetryCache?.received_at ? new Date(telemetryCache.received_at).getTime() : null;
      const isOnline = recAt !== null && (now - recAt <= 20000);
      applyFilters(isOnline);
    });
  });

  // Listeners de Interatividade do Gráfico 24h
  if (mapChartFlowWrapper) {
    mapChartFlowWrapper.addEventListener('mousemove', handleMapFlowChartInteraction);
    mapChartFlowWrapper.addEventListener('mouseleave', hideMapFlowChartInteraction);
    mapChartFlowWrapper.addEventListener('touchstart', handleMapFlowChartInteraction, { passive: true });
    mapChartFlowWrapper.addEventListener('touchmove', handleMapFlowChartInteraction, { passive: true });
  }

  document.addEventListener('touchstart', (e) => {
    if (mapChartFlowWrapper && !mapChartFlowWrapper.contains(e.target)) {
      hideMapFlowChartInteraction();
    }
  }, { passive: true });
}

// Helper de carregamento de configuração com retry limitado
async function loadAuthConfigWithRetry(maxAttempts = 3) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch('/api/auth/config', { cache: 'no-store' });
      if (res.ok) {
        const cfg = await res.json();
        const key = cfg.supabase_publishable_key || cfg.supabase_anon_key;
        if (cfg.ok && cfg.supabase_url && key && window.supabase) {
          return { cfg, key };
        }
      }
    } catch (err) {}
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 150 * Math.pow(2, i)));
    }
  }
  return null;
}

// Obter sessão com retry curto para absorver latência de storage em mobile
async function getSessionWithShortRetry(client, maxAttempts = 3) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { data, error } = await client.auth.getSession();
      if (!error && data?.session?.access_token) {
        return data.session;
      }
    } catch (e) {}
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 100 * (i + 1)));
    }
  }
  return null;
}

// Obter usuário distinguindo erro transitório de rede vs falha definitiva de autenticação
async function getUserWithRetry(client, maxAttempts = 2) {
  let lastError = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { data, error } = await client.auth.getUser();
      if (!error && data?.user) {
        return { user: data.user, isAuthError: false, error: null };
      }
      if (error) {
        const isAuth = error.status === 401 || error.status === 400 || (error.message && /token|auth|expired|invalid/i.test(error.message));
        if (isAuth) {
          return { user: null, isAuthError: true, error };
        }
        lastError = error;
      }
    } catch (err) {
      lastError = err;
    }
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return { user: null, isAuthError: false, error: lastError };
}

// 12. Auth Guard e Inicialização
async function initAuthAndApp() {
  try {
    // A. Carregar configuração pública do Supabase com retry (falhas de rede/5xx NÃO deslogam)
    const authConfig = await loadAuthConfigWithRetry(3);
    if (!authConfig) {
      console.error('Falha temporária ao carregar configuração de autenticação no mapa.');
      document.body.classList.remove('auth-loading');
      alert('Não foi possível conectar ao servidor de autenticação. Verifique sua conexão e recarregue a página.');
      return;
    }

    const { cfg, key } = authConfig;
    supabaseClient = window.supabase.createClient(cfg.supabase_url, key);

    // B. Obter Sessão com retry curto (absorver sincronização de storage em mobile)
    const session = await getSessionWithShortRetry(supabaseClient, 3);
    if (!session) {
      // Sessão comprovadamente ausente: limpeza local defensiva antes de redirecionar
      try {
        await supabaseClient.auth.signOut({ scope: 'local' });
      } catch (e) {
        try { await supabaseClient.auth.signOut(); } catch (err) {}
      }
      window.location.replace('/login.html');
      return;
    }

    // C. Validar Usuário e Token
    let { user, isAuthError } = await getUserWithRetry(supabaseClient, 2);

    if (isAuthError || (!user && !isAuthError)) {
      const newToken = await tryRefreshSession();
      if (newToken) {
        const retryUser = await getUserWithRetry(supabaseClient, 1);
        if (retryUser.user) {
          user = retryUser.user;
          isAuthError = false;
        }
      }
    }

    if (!user) {
      if (isAuthError) {
        // Token inválido/expirado e sem recuperação: signOut local + login?expired=1
        try {
          await supabaseClient.auth.signOut({ scope: 'local' });
        } catch (e) {
          try { await supabaseClient.auth.signOut(); } catch (err) {}
        }
        window.location.replace('/login.html?expired=1');
        return;
      } else {
        // Erro temporário de rede: não redirecionar para login em loop
        console.warn('Falha temporária de rede ao validar usuário no mapa.');
        document.body.classList.remove('auth-loading');
        alert('Instabilidade temporária de rede ao validar a sessão. Recarregue a página.');
        return;
      }
    }

    // D. Validar Role
    const role = user.app_metadata?.role;
    if (role !== 'admin' && role !== 'viewer') {
      try {
        await supabaseClient.auth.signOut({ scope: 'local' });
      } catch (e) {
        try { await supabaseClient.auth.signOut(); } catch (err) {}
      }
      window.location.replace('/login.html');
      return;
    }

    // E. Ajustes de UI baseados no Perfil (ADMIN vê botão técnico, VIEWER não vê)
    if (role === 'admin') {
      if (linkDashboard) linkDashboard.classList.remove('hidden');
    } else {
      if (linkDashboard) linkDashboard.classList.add('hidden');
    }

    // F. Liberar Renderização (Remover anti-flash)
    document.body.classList.remove('auth-loading');

    // G. Inicializar Mapa e Listeners
    initMap();
    setupEventListeners();

    // H. Carga Inicial de Dados e Início de Polling Gerenciado
    if (!authFailureHandling) {
      await Promise.allSettled([
        fetchTelemetryData(),
        fetchSessionsData(),
        fetchDailySummary(),
        fetchFlowChart24h()
      ]);

      if (!authFailureHandling) {
        registerInterval(fetchTelemetryData, 5000);
        registerInterval(fetchSessionsData, 15000);
        registerInterval(fetchDailySummary, 60000); // Polling suave de 60s para daily summary
        registerInterval(fetchFlowChart24h, 60000); // Polling suave de 60s para o gráfico 24h
      }
    }

  } catch (err) {
    console.error('Erro inesperado na inicialização de autenticação do mapa:', err);
    document.body.classList.remove('auth-loading');
    alert('Erro inesperado ao inicializar o mapa. Recarregue a página.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initAuthAndApp();
});
