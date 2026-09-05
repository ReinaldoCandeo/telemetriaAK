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

function registerInterval(fn, ms) {
  const id = setInterval(fn, ms);
  activeIntervals.push(id);
  return id;
}

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

async function handleUnauthorizedOnce() {
  if (authFailureHandling) return;
  authFailureHandling = true;
  clearAllIntervals();

  if (supabaseClient) {
    try { await supabaseClient.auth.signOut(); } catch (e) {}
  }

  alert('Sessão expirada. Entre novamente.');
  window.location.replace('/login.html');
}

let telemetryCache = null;
let systemSummaryCache = null;
let flowSummaryCache = null;
let sessionsCache = null;

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
const valCurrentFlowMain = document.getElementById('val-current-flow-main');
const valCurrentFlowM3hSub = document.getElementById('val-current-flow-m3h-sub');
const valSessionStatusTop = document.getElementById('val-session-status-top');
const valSessionDetailTop = document.getElementById('val-session-detail-top');

// Elementos do DOM - Card Lateral HIDRO-001
const cardHidro001 = document.getElementById('card-hidro-001');
const hidroStatusPill = document.getElementById('hidro-status-pill');
const hidroFlowRecent = document.getElementById('hidro-flow-recent');
const hidroFlowM3h = document.getElementById('hidro-flow-m3h');
const hidroVolumeM3 = document.getElementById('hidro-volume-m3');
const hidroVolumeLiters = document.getElementById('hidro-volume-liters');
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
async function apiFetch(url, options = {}) {
  if (authFailureHandling) return new Response(null, { status: 401 });
  if (!supabaseClient) {
    handleUnauthorizedOnce();
    return new Response(null, { status: 401 });
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.access_token) {
    handleUnauthorizedOnce();
    return new Response(null, { status: 401 });
  }

  const headers = {
    ...(options.headers || {}),
    'Authorization': `Bearer ${session.access_token}`
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    handleUnauthorizedOnce();
    return response;
  }

  if (response.status === 403) {
    alert('Você não possui permissão para visualizar a telemetria.');
    return response;
  }

  return response;
}

// 4. Utilitário de Formatação de Tempo Relativo
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

    marker.bindPopup(generatePopupContent(false));
  } else {
    if (geoNotice) geoNotice.classList.remove('hidden');
  }
}

// 6. Formatação do Popup Executivo com Dados Reais
function generatePopupContent(isOnline) {
  const statusBadge = isOnline
    ? '<span class="popup-badge online">ONLINE</span>'
    : '<span class="popup-badge offline">OFFLINE</span>';

  let lastRecHuman = 'Sem envio';
  let lastRecTime = '--:--:--';
  if (telemetryCache?.received_at) {
    const d = new Date(telemetryCache.received_at);
    lastRecHuman = formatHumanRelativeTime(telemetryCache.received_at);
    lastRecTime = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }

  // Volume
  const sysVolLiters = systemSummaryCache?.system_volume_liters;
  const volM3Str = typeof sysVolLiters === 'number'
    ? `${(sysVolLiters / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} m³`
    : '-- m³';
  const volLitersStr = typeof sysVolLiters === 'number'
    ? `${sysVolLiters.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L`
    : '-- L';

  // Vazão
  const flowInstStr = flowSummaryCache?.latest_flow_lpm !== null && flowSummaryCache?.latest_flow_lpm !== undefined
    ? `${flowSummaryCache.latest_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L/min`
    : '-- L/min';
  const flowM3hStr = flowSummaryCache?.latest_flow_m3h !== null && flowSummaryCache?.latest_flow_m3h !== undefined
    ? `${flowSummaryCache.latest_flow_m3h.toLocaleString('pt-BR', { minimumFractionDigits: 3 })} m³/h`
    : '-- m³/h';
  const flowAvgStr = flowSummaryCache?.average_flow_lpm !== null && flowSummaryCache?.average_flow_lpm !== undefined
    ? `${flowSummaryCache.average_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L/min`
    : '-- L/min';
  const flowMaxStr = flowSummaryCache?.max_flow_lpm !== null && flowSummaryCache?.max_flow_lpm !== undefined
    ? `${flowSummaryCache.max_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L/min`
    : '-- L/min';

  // Sessão / Passagem
  const sum = sessionsCache?.summary;
  const hasOpen = sum && sum.open_session;
  const sessionStr = hasOpen
    ? '<span style="color:#10b981; font-weight:700;">PASSAGEM ATIVA</span>'
    : '<span style="color:#64748b; font-weight:700;">SEM PASSAGEM</span>';

  // Detalhes Secundários
  const rssiStr = telemetryCache?.rssi !== null && telemetryCache?.rssi !== undefined ? `${telemetryCache.rssi} dBm` : '-- dBm';
  const calibFactor = systemSummaryCache?.liters_per_pulse || telemetryCache?.calibration?.liters_per_pulse || 101.63;
  const pulsesStr = systemSummaryCache?.system_pulse_total !== undefined
    ? systemSummaryCache.system_pulse_total.toLocaleString('pt-BR')
    : (telemetryCache?.pulse_total ? telemetryCache.pulse_total.toLocaleString('pt-BR') : '--');

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
          <span class="popup-metric-val">${sessionStr}</span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Vazão Atual:</span>
          <span class="popup-metric-val">${flowInstStr} <span style="font-size:10px; color:#64748b;">(${flowM3hStr})</span></span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Volume Acumulado:</span>
          <span class="popup-metric-val">${volM3Str} <span style="font-size:10px; color:#64748b;">(${volLitersStr})</span></span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Vazão Média:</span>
          <span class="popup-metric-val">${flowAvgStr}</span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Pico de Vazão:</span>
          <span class="popup-metric-val">${flowMaxStr}</span>
        </div>
        <div class="popup-metric-row">
          <span class="popup-metric-label">Último Envio:</span>
          <span class="popup-metric-val">${lastRecHuman} <span style="font-size:10px; color:#64748b;">(${lastRecTime})</span></span>
        </div>
      </div>
      <div class="popup-tech-footer">
        <div style="display:flex; justify-content:space-between;">
          <span>Sinal: <strong>${rssiStr}</strong></span>
          <span>Calibração: <strong>${calibFactor} L/p</strong></span>
        </div>
        <div style="display:flex; justify-content:space-between; margin-top:2px;">
          <span>Pulsos: <strong>${pulsesStr}</strong></span>
          <span>Palmital / SP</span>
        </div>
      </div>
    </div>
  `;
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

// 8. Atualização Visual da Interface
function updateUI() {
  const now = Date.now();
  const recAt = telemetryCache?.received_at ? new Date(telemetryCache.received_at).getTime() : null;
  const isOnline = recAt !== null && (now - recAt <= 20000);

  // A. Header Communication Status
  if (commStatusBadge) {
    if (isOnline) {
      commStatusBadge.className = 'status-indicator status-online';
      commStatusBadge.textContent = 'ONLINE';
    } else {
      commStatusBadge.className = 'status-indicator status-offline';
      commStatusBadge.textContent = 'OFFLINE';
    }
  }

  // B. Top Metric Cards (5 Cards Executivos)
  if (valOnlinePoints) valOnlinePoints.textContent = isOnline ? '1' : '0';

  // Volume Acumulado (m³ em destaque)
  const sysVol = systemSummaryCache?.system_volume_liters;
  if (valTotalVolumeM3Main && valTotalVolumeLitersSub) {
    if (typeof sysVol === 'number') {
      const m3 = sysVol / 1000;
      valTotalVolumeM3Main.innerHTML = `${m3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} <span class="unit">m³</span>`;
      valTotalVolumeLitersSub.textContent = `${sysVol.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L acumulados`;
    } else {
      valTotalVolumeM3Main.innerHTML = `-- <span class="unit">m³</span>`;
      valTotalVolumeLitersSub.textContent = 'Volume pendente';
    }
  }

  // Vazão Atual (L/min em destaque)
  if (valCurrentFlowMain && valCurrentFlowM3hSub) {
    const flowLpm = flowSummaryCache?.latest_flow_lpm;
    const flowM3h = flowSummaryCache?.latest_flow_m3h;
    if (flowLpm !== null && flowLpm !== undefined) {
      valCurrentFlowMain.innerHTML = `${flowLpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} <span class="unit">L/min</span>`;
      valCurrentFlowM3hSub.textContent = `${flowM3h !== null && flowM3h !== undefined ? flowM3h.toLocaleString('pt-BR', { minimumFractionDigits: 3 }) : '--'} m³/h`;
    } else {
      valCurrentFlowMain.innerHTML = `-- <span class="unit">L/min</span>`;
      valCurrentFlowM3hSub.textContent = '-- m³/h';
    }
  }

  // Passagem Top Card
  if (valSessionStatusTop && valSessionDetailTop) {
    const sum = sessionsCache?.summary;
    const hasOpen = sum && sum.open_session;
    const latestSess = sum && sum.latest_session;

    if (hasOpen) {
      valSessionStatusTop.innerHTML = `<span style="color: #10b981; font-weight: 800;">PASSAGEM ATIVA</span>`;
      const durSec = latestSess?.duration_seconds || 0;
      valSessionDetailTop.textContent = `Em curso (${Math.round(durSec / 60)} min • ${latestSess?.pulse_count || 0}p)`;
    } else {
      valSessionStatusTop.innerHTML = `<span style="color: #64748b; font-weight: 800;">SEM PASSAGEM</span>`;
      if (latestSess && latestSess.last_pulse_at) {
        const lastD = new Date(latestSess.last_pulse_at);
        valSessionDetailTop.textContent = `Última: ${lastD.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`;
      } else {
        valSessionDetailTop.textContent = 'Sem registros';
      }
    }
  }

  // C. Side Card HIDRO-001 (RESERVATÓRIO CENTRAL)
  if (hidroStatusPill) {
    if (isOnline) {
      hidroStatusPill.className = 'status-pill status-online';
      hidroStatusPill.textContent = 'ONLINE';
    } else {
      hidroStatusPill.className = 'status-pill status-offline';
      hidroStatusPill.textContent = 'OFFLINE';
    }
  }

  // Vazão do Card Lateral
  if (hidroFlowRecent && hidroFlowM3h) {
    if (flowSummaryCache?.latest_flow_lpm !== null && flowSummaryCache?.latest_flow_lpm !== undefined) {
      hidroFlowRecent.innerHTML = `${flowSummaryCache.latest_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} <span class="unit">L/min</span>`;
      hidroFlowM3h.textContent = `${flowSummaryCache.latest_flow_m3h !== null ? flowSummaryCache.latest_flow_m3h.toLocaleString('pt-BR', { minimumFractionDigits: 3 }) : '--'} m³/h`;
    } else {
      hidroFlowRecent.innerHTML = `-- <span class="unit">L/min</span>`;
      hidroFlowM3h.textContent = '-- m³/h';
    }
  }

  // Volume do Card Lateral
  if (hidroVolumeM3 && hidroVolumeLiters) {
    if (typeof sysVol === 'number') {
      const m3 = sysVol / 1000;
      hidroVolumeM3.innerHTML = `${m3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} <span class="unit">m³</span>`;
      hidroVolumeLiters.textContent = `${sysVol.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L acumulados`;
    } else {
      hidroVolumeM3.innerHTML = `-- <span class="unit">m³</span>`;
      hidroVolumeLiters.textContent = '-- L';
    }
  }

  // Vazão Média e Pico do Card Lateral
  if (hidroFlowAvg && hidroFlowMax) {
    const avgFlow = flowSummaryCache?.average_flow_lpm;
    const maxFlow = flowSummaryCache?.max_flow_lpm;
    hidroFlowAvg.innerHTML = avgFlow !== null && avgFlow !== undefined
      ? `${avgFlow.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} <span class="unit">L/min</span>`
      : `-- <span class="unit">L/min</span>`;
    hidroFlowMax.textContent = maxFlow !== null && maxFlow !== undefined
      ? `Pico: ${maxFlow.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L/min`
      : `Pico: -- L/min`;
  }

  // Passagem do Card Lateral
  if (hidroSessionStatus && hidroSessionDetail) {
    const sum = sessionsCache?.summary;
    const hasOpen = sum && sum.open_session;
    const latestSess = sum && sum.latest_session;

    if (hasOpen) {
      hidroSessionStatus.innerHTML = `<span style="color: #10b981; font-weight: 700;">PASSAGEM ATIVA</span>`;
      const durSec = latestSess?.duration_seconds || 0;
      hidroSessionDetail.textContent = `Duração: ${Math.round(durSec / 60)} min • ${latestSess?.pulse_count || 0}p`;
    } else {
      hidroSessionStatus.innerHTML = `<span style="color: #64748b; font-weight: 700;">SEM PASSAGEM</span>`;
      if (latestSess && latestSess.last_pulse_at) {
        const lastD = new Date(latestSess.last_pulse_at);
        hidroSessionDetail.textContent = `Última: ${lastD.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`;
      } else {
        hidroSessionDetail.textContent = 'Sem registros';
      }
    }
  }

  // Informações de Recebimento do Card Lateral
  if (hidroLastReceivedHuman && hidroLastReceivedTime) {
    if (telemetryCache?.received_at) {
      const d = new Date(telemetryCache.received_at);
      hidroLastReceivedHuman.textContent = formatHumanRelativeTime(telemetryCache.received_at);
      hidroLastReceivedTime.textContent = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    } else {
      hidroLastReceivedHuman.textContent = '--';
      hidroLastReceivedTime.textContent = '--:--:--';
    }
  }

  // Detalhes Secundários do Card Lateral
  if (hidroRssi) {
    hidroRssi.textContent = telemetryCache?.rssi !== null && telemetryCache?.rssi !== undefined
      ? `${telemetryCache.rssi} dBm`
      : '-- dBm';
  }

  if (hidroCalibFactor) {
    const calib = systemSummaryCache?.liters_per_pulse || telemetryCache?.calibration?.liters_per_pulse || 101.63;
    hidroCalibFactor.textContent = `${calib} L/p`;
  }

  if (hidroPulsesTotal) {
    const pulses = systemSummaryCache?.system_pulse_total !== undefined
      ? systemSummaryCache.system_pulse_total
      : (telemetryCache?.pulse_total || 0);
    hidroPulsesTotal.textContent = `${pulses.toLocaleString('pt-BR')} p`;
  }

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

  // Atualização do Marcador e Popup no Leaflet
  if (marker) {
    marker.setIcon(createMarkerIcon(isOnline));
    marker.setPopupContent(generatePopupContent(isOnline));
  }

  // D. Filtros e Busca
  applyFilters(isOnline);

  // E. Footer Status Bar
  if (barLastEsp) {
    if (telemetryCache?.received_at) {
      const d = new Date(telemetryCache.received_at);
      barLastEsp.textContent = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    } else {
      barLastEsp.textContent = '--:--:--';
    }
  }

  if (barLastRefresh) {
    barLastRefresh.textContent = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
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

// 10. Setup Event Listeners
function setupEventListeners() {
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      fetchTelemetryData();
      fetchSessionsData();
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
}

// 11. Auth Guard e Inicialização
async function initAuthAndApp() {
  try {
    // A. Carregar configuração pública do Supabase
    const cfgRes = await fetch('/api/auth/config', { cache: 'no-store' });
    if (!cfgRes.ok) {
      window.location.replace('/login.html');
      return;
    }
    const cfg = await cfgRes.json();
    const key = cfg.supabase_publishable_key || cfg.supabase_anon_key;
    if (!cfg.ok || !cfg.supabase_url || !key || !window.supabase) {
      window.location.replace('/login.html');
      return;
    }

    supabaseClient = window.supabase.createClient(cfg.supabase_url, key);

    // B. Obter Sessão
    const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
    if (sessionError || !session?.access_token) {
      window.location.replace('/login.html');
      return;
    }

    // C. Validar Usuário e Role
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      if (supabaseClient) await supabaseClient.auth.signOut().catch(() => {});
      window.location.replace('/login.html');
      return;
    }

    const role = user.app_metadata?.role;
    if (role !== 'admin' && role !== 'viewer') {
      if (supabaseClient) await supabaseClient.auth.signOut().catch(() => {});
      window.location.replace('/login.html');
      return;
    }

    // D. Ajustes de UI baseados no Perfil (ADMIN vê botão técnico, VIEWER não vê)
    if (role === 'admin') {
      if (linkDashboard) linkDashboard.classList.remove('hidden');
    } else {
      if (linkDashboard) linkDashboard.classList.add('hidden');
    }

    // E. Liberar Renderização (Remover anti-flash)
    document.body.classList.remove('auth-loading');

    // F. Inicializar Mapa e Listeners
    initMap();
    setupEventListeners();

    // G. Carga Inicial de Dados e Início de Polling Gerenciado
    if (!authFailureHandling) {
      await Promise.allSettled([
        fetchTelemetryData(),
        fetchSessionsData()
      ]);

      if (!authFailureHandling) {
        registerInterval(fetchTelemetryData, 5000);
        registerInterval(fetchSessionsData, 15000);
      }
    }

  } catch (err) {
    console.error('Erro na inicialização de autenticação do mapa:', err);
    window.location.replace('/login.html');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initAuthAndApp();
});
