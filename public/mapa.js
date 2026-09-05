/**
 * MAPA OPERACIONAL DOS PONTOS - TELEMETRIA HÍDRICA
 * Supervisório Georreferenciado em Tempo Real
 * Protegido por Supabase Auth (Viewer / Admin)
 */

// 1. Configuração dos Pontos Operacionais
const POINTS_CONFIG = [
  {
    device_id: 'HIDRO-001',
    name: 'HIDRO-001',
    description: 'Ponto de Medição Hidrômetro DN50',
    latitude: null,
    longitude: null
  }
];

// 2. Estado Global e Auth
let supabaseClient = null;
let isLoggingOut = false;
let map = null;
let marker = null;
let currentFilter = 'all';
let searchQuery = '';

let telemetryCache = null;
let systemSummaryCache = null;
let flowSummaryCache = null;
let sessionsCache = null;

// Elementos do DOM
const commStatusBadge = document.getElementById('comm-status-badge');
const btnRefresh = document.getElementById('btn-refresh');
const btnLogout = document.getElementById('btn-logout');
const linkDashboard = document.getElementById('link-dashboard');

// Top Metrics
const valMonitoredPoints = document.getElementById('val-monitored-points');
const valOnlinePoints = document.getElementById('val-online-points');
const valOfflinePoints = document.getElementById('val-offline-points');
const valCalibStatus = document.getElementById('val-calib-status');
const valCalibFactor = document.getElementById('val-calib-factor');
const valTotalVolume = document.getElementById('val-total-volume');
const valTotalVolumeM3 = document.getElementById('val-total-volume-m3');

// Side Panel HIDRO-001
const cardHidro001 = document.getElementById('card-hidro-001');
const hidroStatusPill = document.getElementById('hidro-status-pill');
const hidroFlowRecent = document.getElementById('hidro-flow-recent');
const hidroFlowM3h = document.getElementById('hidro-flow-m3h');
const hidroVolumeLiters = document.getElementById('hidro-volume-liters');
const hidroPulsesTotal = document.getElementById('hidro-pulses-total');
const hidroFlowAvg = document.getElementById('hidro-flow-avg');
const hidroFlowMax = document.getElementById('hidro-flow-max');
const hidroSessionStatus = document.getElementById('hidro-session-status');
const hidroSessionDetail = document.getElementById('hidro-session-detail');
const hidroLastReceived = document.getElementById('hidro-last-received');
const hidroRssi = document.getElementById('hidro-rssi');
const hidroGeoStatus = document.getElementById('hidro-geo-status');
const geoNotice = document.getElementById('geo-notice');

// Filters & Search
const inputSearch = document.getElementById('input-search');
const filterTabs = document.querySelectorAll('.filter-tab');
const countAll = document.getElementById('count-all');
const countOnline = document.getElementById('count-online');
const countOffline = document.getElementById('count-offline');

// Footer Bar
const barLastEsp = document.getElementById('bar-last-esp');
const barLastRefresh = document.getElementById('bar-last-refresh');

// 3. Helper de Fetch Autenticado para o Mapa
async function apiFetch(url, options = {}) {
  if (isLoggingOut) return new Response(null, { status: 401 });
  if (!supabaseClient) {
    handleAuthError();
    return new Response(null, { status: 401 });
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.access_token) {
    handleAuthError();
    return new Response(null, { status: 401 });
  }

  const headers = {
    ...(options.headers || {}),
    'Authorization': `Bearer ${session.access_token}`
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    handleAuthError();
    return response;
  }

  if (response.status === 403) {
    handleForbiddenError();
    return response;
  }

  return response;
}

async function handleAuthError() {
  if (isLoggingOut) return;
  isLoggingOut = true;
  if (supabaseClient) {
    try { await supabaseClient.auth.signOut(); } catch (e) {}
  }
  window.location.replace('/login.html');
}

async function handleForbiddenError() {
  if (isLoggingOut) return;
  isLoggingOut = true;
  alert('Usuário sem permissão para visualizar a telemetria.');
  if (supabaseClient) {
    try { await supabaseClient.auth.signOut(); } catch (e) {}
  }
  window.location.replace('/login.html');
}

// 4. Inicialização do Mapa Leaflet
function initMap() {
  const palmitalCoords = [-22.7885, -50.2195];
  
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView(palmitalCoords, 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  const hidro = POINTS_CONFIG[0];

  if (hidro.latitude !== null && hidro.longitude !== null) {
    if (geoNotice) geoNotice.classList.add('hidden');
    
    marker = L.circleMarker([hidro.latitude, hidro.longitude], {
      radius: 9,
      fillColor: '#ef4444',
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.9
    }).addTo(map);

    marker.bindPopup(generatePopupContent(false));
  } else {
    if (geoNotice) geoNotice.classList.remove('hidden');
  }
}

// 5. Formatação de Popup Leaflet
function generatePopupContent(isOnline) {
  const statusStr = isOnline ? '<strong style="color:#10b981;">ONLINE</strong>' : '<strong style="color:#ef4444;">OFFLINE</strong>';
  const flowStr = flowSummaryCache?.latest_flow_lpm !== null && flowSummaryCache?.latest_flow_lpm !== undefined
    ? `${flowSummaryCache.latest_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L/min (${flowSummaryCache.latest_flow_m3h || '--'} m³/h)`
    : '--';
  const volStr = systemSummaryCache?.system_volume_liters !== null && systemSummaryCache?.system_volume_liters !== undefined
    ? `${systemSummaryCache.system_volume_liters.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L`
    : '--';
  const pulsesStr = systemSummaryCache?.system_pulse_total !== undefined
    ? systemSummaryCache.system_pulse_total.toLocaleString('pt-BR')
    : '--';

  return `
    <div style="font-family: system-ui, sans-serif; min-width: 200px; font-size: 12px; line-height: 1.4;">
      <h4 style="margin: 0 0 4px 0; font-size: 14px; color: #0284c7;">HIDRO-001</h4>
      <div style="margin-bottom: 6px;">Status: ${statusStr}</div>
      <div><strong>Vazão:</strong> ${flowStr}</div>
      <div><strong>Volume:</strong> ${volStr}</div>
      <div><strong>Pulsos:</strong> ${pulsesStr}</div>
      <div style="margin-top: 6px; font-size: 10px; color: #64748b;">Palmital / SP</div>
    </div>
  `;
}

// 6. Consulta às APIs Reais Protegidas por Bearer
async function fetchTelemetryData() {
  if (isLoggingOut) return;
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
  if (isLoggingOut) return;
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

// 7. Atualização Visual da Interface
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

  // B. Top Metric Cards
  if (valOnlinePoints) valOnlinePoints.textContent = isOnline ? '1' : '0';
  if (valOfflinePoints) valOfflinePoints.textContent = isOnline ? '0' : '1';

  // Calibration Metric
  const calib = systemSummaryCache?.calibration_status || telemetryCache?.calibration?.status;
  const litersPerPulse = systemSummaryCache?.liters_per_pulse || telemetryCache?.calibration?.liters_per_pulse;

  if (valCalibStatus && valCalibFactor) {
    if (calib === 'calibrated' && litersPerPulse) {
      valCalibStatus.innerHTML = `<span style="color: #10b981; font-weight: 800;">CALIBRADO</span>`;
      valCalibFactor.textContent = `1 pulso = ${litersPerPulse} L`;
    } else {
      valCalibStatus.innerHTML = `<span style="color: #f59e0b; font-weight: 800;">PENDENTE</span>`;
      valCalibFactor.textContent = 'Fator não configurado';
    }
  }

  // Total Volume Metric
  if (valTotalVolume && valTotalVolumeM3) {
    const sysVol = systemSummaryCache?.system_volume_liters;
    if (typeof sysVol === 'number') {
      valTotalVolume.innerHTML = `${sysVol.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} <span class="unit">L</span>`;
      const m3 = sysVol / 1000;
      valTotalVolumeM3.textContent = `${m3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} m³ acumulados`;
    } else {
      valTotalVolume.innerHTML = `-- <span class="unit">L</span>`;
      valTotalVolumeM3.textContent = 'Volume pendente';
    }
  }

  // C. Side Card HIDRO-001
  if (hidroStatusPill) {
    if (isOnline) {
      hidroStatusPill.className = 'status-pill status-online';
      hidroStatusPill.textContent = 'ONLINE';
    } else {
      hidroStatusPill.className = 'status-pill status-offline';
      hidroStatusPill.textContent = 'OFFLINE';
    }
  }

  // Flow Recent
  if (hidroFlowRecent && hidroFlowM3h) {
    if (flowSummaryCache?.latest_flow_lpm !== null && flowSummaryCache?.latest_flow_lpm !== undefined) {
      hidroFlowRecent.innerHTML = `${flowSummaryCache.latest_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} <span class="unit">L/min</span>`;
      hidroFlowM3h.textContent = `${flowSummaryCache.latest_flow_m3h !== null ? flowSummaryCache.latest_flow_m3h.toLocaleString('pt-BR', { minimumFractionDigits: 3 }) : '--'} m³/h`;
    } else {
      hidroFlowRecent.innerHTML = `-- <span class="unit">L/min</span>`;
      hidroFlowM3h.textContent = '-- m³/h';
    }
  }

  // Volume & Pulses
  if (hidroVolumeLiters && hidroPulsesTotal) {
    const sysVol = systemSummaryCache?.system_volume_liters;
    const sysPulses = systemSummaryCache?.system_pulse_total !== undefined
      ? systemSummaryCache.system_pulse_total
      : (telemetryCache?.pulse_total || 0);

    if (typeof sysVol === 'number') {
      hidroVolumeLiters.innerHTML = `${sysVol.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} <span class="unit">L</span>`;
    } else {
      hidroVolumeLiters.innerHTML = `-- <span class="unit">L</span>`;
    }
    hidroPulsesTotal.textContent = `${sysPulses.toLocaleString('pt-BR')} pulsos`;
  }

  // Flow Avg / Peak
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

  // Session Status
  if (hidroSessionStatus && hidroSessionDetail) {
    const sum = sessionsCache?.summary;
    const hasOpen = sum && sum.open_session;
    const latestSess = sum && sum.latest_session;

    if (hasOpen) {
      hidroSessionStatus.innerHTML = `<span style="color: #10b981; font-weight: 700;">PASSAGEM ATIVA</span>`;
      const durSec = latestSess?.duration_seconds || 0;
      hidroSessionDetail.textContent = `Duração: ${Math.round(durSec / 60)} min • ${latestSess?.pulse_count || 0} pulsos`;
    } else {
      hidroSessionStatus.innerHTML = `<span style="color: #64748b; font-weight: 700;">SEM PASSAGEM</span>`;
      if (latestSess && latestSess.last_pulse_at) {
        const lastD = new Date(latestSess.last_pulse_at);
        hidroSessionDetail.textContent = `Última: ${lastD.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`;
      } else {
        hidroSessionDetail.textContent = 'Nenhuma sessão registrada';
      }
    }
  }

  // Footer info of card
  if (hidroLastReceived) {
    if (telemetryCache?.received_at) {
      const d = new Date(telemetryCache.received_at);
      const diffSec = Math.floor((now - d.getTime()) / 1000);
      hidroLastReceived.textContent = `${d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (há ${diffSec}s)`;
    } else {
      hidroLastReceived.textContent = '--:--:--';
    }
  }

  if (hidroRssi) {
    hidroRssi.textContent = telemetryCache?.rssi !== null && telemetryCache?.rssi !== undefined
      ? `${telemetryCache.rssi} dBm`
      : '-- dBm';
  }

  // Leaflet Marker Color Update if marker exists
  if (marker) {
    marker.setStyle({
      fillColor: isOnline ? '#10b981' : '#ef4444'
    });
    marker.setPopupContent(generatePopupContent(isOnline));
  }

  // D. Search and Filters
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

// 8. Filtros e Busca em Memória
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
    const match = 'hidro-001'.includes(q) || 'hidrômetro'.includes(q) || 'dn50'.includes(q) || 'palmital'.includes(q);
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

// 9. Setup Event Listeners
function setupEventListeners() {
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      fetchTelemetryData();
      fetchSessionsData();
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      if (supabaseClient) {
        try { await supabaseClient.auth.signOut(); } catch (e) {}
      }
      window.location.replace('/login.html');
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

// 10. Auth Guard e Inicialização
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
    if (!cfg.supabase_url || !key) {
      window.location.replace('/login.html');
      return;
    }

    supabaseClient = window.supabase.createClient(cfg.supabase_url, key);

    // B. Obter Sessão
    const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
    if (sessionError || !session) {
      window.location.replace('/login.html');
      return;
    }

    // C. Validar Usuário e Role
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      await supabaseClient.auth.signOut();
      window.location.replace('/login.html');
      return;
    }

    const role = user.app_metadata?.role;
    if (role !== 'admin' && role !== 'viewer') {
      await supabaseClient.auth.signOut();
      window.location.replace('/login.html');
      return;
    }

    // D. Ajustes de UI baseados no Perfil
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

    // G. Carga Inicial de Dados
    fetchTelemetryData();
    fetchSessionsData();

    // H. Polling
    setInterval(fetchTelemetryData, 5000);
    setInterval(fetchSessionsData, 15000);

  } catch (err) {
    console.error('Erro na inicialização de autenticação do mapa:', err);
    window.location.replace('/login.html');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initAuthAndApp();
});

