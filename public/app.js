let supabaseClient = null;
let authFailureHandling = false;
let activeIntervals = [];

function registerInterval(fn, ms) {
  const id = setInterval(fn, ms);
  activeIntervals.push(id);
  return id;
}

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

let refreshSessionPromise = null;

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
      console.warn('Falha ao renovar sessão:', err);
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
      try { await supabaseClient.auth.signOut(); } catch (err) { }
    }
  }

  window.location.replace('/login.html?expired=1');
}

// Obter token Bearer para chamadas administrativas
async function getAdminAccessToken() {
  try {
    if (!supabaseClient) return null;
    const { data: { session } } = await supabaseClient.auth.getSession();
    return session?.access_token || null;
  } catch (e) {
    return null;
  }
}

// Wrapper para requisições com Bearer token e tratamento de 401/403
async function adminFetch(url, options = {}, isRetry = false) {
  if (authFailureHandling) {
    return new Response(null, { status: 401 });
  }

  let token = await getAdminAccessToken();
  if (!token) {
    token = await tryRefreshSession();
    if (!token) {
      handleUnauthorizedOnce();
      return new Response(null, { status: 401 });
    }
  }

  if (authFailureHandling) {
    return new Response(null, { status: 401 });
  }

  const tokenUsed = token;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
    'Authorization': `Bearer ${tokenUsed}`
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (authFailureHandling) {
    return new Response(null, { status: 401 });
  }

  if (response.status === 401) {
    if (!isRetry) {
      // 1. Verificar se a sessão atual já foi renovada por outra requisição concorrente (stale 401)
      const currentToken = await getAdminAccessToken();
      if (currentToken && currentToken !== tokenUsed) {
        // Sessão já possui token novo: retentar uma única vez sem disparar novo refresh
        return adminFetch(url, options, true);
      }

      // 2. Token ainda é o mesmo ou ausente: acionar refreshSession single-flight
      const newToken = await tryRefreshSession();
      if (newToken) {
        return adminFetch(url, options, true);
      }
    }
    handleUnauthorizedOnce();
    return response;
  }

  if (response.status === 403) {
    alert('Você não possui permissão administrativa para esta ação.');
    return response;
  }

  return response;
}

// Inicializa e valida a sessão do Administrador antes de liberar a tela
async function bootstrapAdmin() {
  try {
    const cfgRes = await fetch('/api/auth/config', { cache: 'no-store' });
    if (!cfgRes.ok) {
      window.location.replace('/login.html');
      return false;
    }
    const cfg = await cfgRes.json();
    const key = cfg.supabase_publishable_key || cfg.supabase_anon_key;
    if (!cfg.ok || !cfg.supabase_url || !key || !window.supabase) {
      window.location.replace('/login.html');
      return false;
    }

    supabaseClient = window.supabase.createClient(cfg.supabase_url, key);

    const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
    if (sessionError || !session?.access_token) {
      window.location.replace('/login.html');
      return false;
    }

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      if (supabaseClient) await supabaseClient.auth.signOut().catch(() => { });
      window.location.replace('/login.html');
      return false;
    }

    const role = user.app_metadata?.role;
    if (role === 'admin') {
      document.body.classList.remove('auth-loading');
      return true;
    } else if (role === 'viewer') {
      window.location.replace('/mapa.html');
      return false;
    } else {
      if (supabaseClient) await supabaseClient.auth.signOut().catch(() => { });
      window.location.replace('/login.html');
      return false;
    }
  } catch (err) {
    console.error('Erro na verificação de autenticação:', err);
    window.location.replace('/login.html');
    return false;
  }
}

// Inicia aplicação e polling após autenticação validada
async function startApp() {
  const isAuth = await bootstrapAdmin();
  if (isAuth && !authFailureHandling) {
    await Promise.allSettled([
      fetchLatestTelemetry(),
      fetchTelemetryHistory(),
      fetchFlowSummary(),
      fetchFlowSessions(),
      fetchFlowChart24h(),
      fetchDailySummary()
    ]);

    if (!authFailureHandling) {
      registerInterval(fetchLatestTelemetry, 1000);
      registerInterval(fetchTelemetryHistory, 2000);
      registerInterval(fetchFlowSummary, 2000);
      registerInterval(fetchFlowSessions, 15000);
      registerInterval(fetchFlowChart24h, 60000);
      registerInterval(fetchDailySummary, 60000);
      registerInterval(updateRelativeTimeDisplay, 1000);
    }
  }
}

startApp();

// Logout Handler
const btnLogout = document.getElementById('btn-logout');
if (btnLogout) {
  btnLogout.addEventListener('click', async () => {
    authFailureHandling = true;
    clearAllIntervals();
    if (supabaseClient) {
      try { await supabaseClient.auth.signOut(); } catch (e) { }
    }
    window.location.replace('/login.html');
  });
}

let previousPulseTotal = null;
let toastTimeout = null;

const waitingView = document.getElementById('waiting-view');
const dashboardView = document.getElementById('dashboard-view');
const pulseToast = document.getElementById('pulse-toast');

const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const headerDeviceId = document.getElementById('header-device-id');

const valPulseTotal = document.getElementById('val-pulse-total');
const valPulseDelta = document.getElementById('val-pulse-delta');
const valLitersTotal = document.getElementById('val-liters-total');
const valLitersSub = document.getElementById('val-liters-sub');
const valLitersBadge = document.getElementById('val-liters-badge');
const valRssi = document.getElementById('val-rssi');
const valRssiQuality = document.getElementById('val-rssi-quality');
const valReceivedTime = document.getElementById('val-received-time');
const valReceivedDate = document.getElementById('val-received-date');
const valDeviceId = document.getElementById('val-device-id');
const valCardLastPulseTime = document.getElementById('val-card-last-pulse-time');

// Quick status card for calibration
const valCalibStatusText = document.getElementById('val-calib-status-text');
const valCalibBadge = document.getElementById('val-calib-badge');
const valCalibFactorSub = document.getElementById('val-calib-factor-sub');

// Calibration DOM Elements
const calibStatusBadge = document.getElementById('calib-status-badge');
const calibStatusText = document.getElementById('calib-status-text');
const calibFactorText = document.getElementById('calib-factor-text');
const inputLitersPerPulse = document.getElementById('input-liters-per-pulse');
const btnSaveCalibration = document.getElementById('btn-save-calibration');

// Chart Elements
const chartVolumeWrapper = document.getElementById('chart-volume-wrapper');
const chartVolumeEmpty = document.getElementById('chart-volume-empty');
const chartVolumeSvg = document.getElementById('chart-volume-svg');
const chartVolumeSubtitle = document.getElementById('chart-volume-subtitle');

const chartPulsesWrapper = document.getElementById('chart-pulses-wrapper');
const chartPulsesEmpty = document.getElementById('chart-pulses-empty');
const chartPulsesSvg = document.getElementById('chart-pulses-svg');

const valEspPulseCount = document.getElementById('val-esp-pulse-count');

// DOM Elements para o Resumo Diário (DAILY-UX-01)
const valTodayM3 = document.getElementById('val-today-m3');
const valTodaySub = document.getElementById('val-today-sub');
const valTodayBadge = document.getElementById('val-today-badge');

const valYesterdayM3 = document.getElementById('val-yesterday-m3');
const valYesterdaySub = document.getElementById('val-yesterday-sub');
const valYesterdayBadge = document.getElementById('val-yesterday-badge');

const valAvg7M3 = document.getElementById('val-avg7-m3');
const valAvg7Sub = document.getElementById('val-avg7-sub');
const valAvg7Badge = document.getElementById('val-avg7-badge');

const valPassageStatus = document.getElementById('val-passage-status');
const valPassageSub = document.getElementById('val-passage-sub');
const valPassageBadge = document.getElementById('val-passage-badge');

const chartDailyWrapper = document.getElementById('chart-daily-wrapper');
const chartDailyEmpty = document.getElementById('chart-daily-empty');
const dailyBarChartContainer = document.getElementById('daily-bar-chart-container');

let systemTotalsCache = null;
let dailySummaryCache = null;

async function fetchSystemSummary() {
  try {
    const response = await adminFetch('/api/telemetry/system-summary', { cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (result.ok) {
      systemTotalsCache = result;
    }
  } catch (err) {
    if (err.message !== 'Sessão expirada.') {
      console.error('Erro ao buscar acumulado do sistema:', err);
    }
  }
}

function showPulseToast() {
  if (!pulseToast) return;
  pulseToast.classList.remove('hidden');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    pulseToast.classList.add('hidden');
  }, 2500);
}

function getRssiQuality(rssi) {
  if (rssi === null || rssi === undefined) return { label: 'Sem dados', className: 'rssi-quality-pill' };
  if (rssi >= -60) return { label: 'Excelente', className: 'rssi-quality-pill rssi-excellent' };
  if (rssi >= -75) return { label: 'Bom', className: 'rssi-quality-pill rssi-good' };
  if (rssi >= -85) return { label: 'Regular', className: 'rssi-quality-pill rssi-fair' };
  return { label: 'Fraco', className: 'rssi-quality-pill rssi-weak' };
}

function updateUI(telemetry) {
  if (!telemetry || !telemetry.device_id) {
    waitingView.classList.remove('hidden');
    dashboardView.classList.add('hidden');

    statusBadge.className = 'status-indicator status-offline';
    statusText.textContent = 'OFFLINE';
    return;
  }

  waitingView.classList.add('hidden');
  dashboardView.classList.remove('hidden');

  // Pulse increment check
  const currentPulse = Number(telemetry.pulse_total);
  if (previousPulseTotal !== null && currentPulse > previousPulseTotal) {
    showPulseToast();
  }
  previousPulseTotal = currentPulse;

  // Header & Device
  headerDeviceId.textContent = telemetry.device_id;
  valDeviceId.textContent = telemetry.device_id;

  // ESP32 RAM Counter Diagnostic
  if (valEspPulseCount) {
    valEspPulseCount.textContent = currentPulse.toLocaleString('pt-BR');
  }

  // System Cumulative Persistent Totals (Fonte oficial: Supabase system_pulse_total)
  const sysPulseTotal = systemTotalsCache && typeof systemTotalsCache.system_pulse_total === 'number'
    ? systemTotalsCache.system_pulse_total
    : currentPulse;
  const sysVolLiters = systemTotalsCache ? systemTotalsCache.system_volume_liters : null;

  valPulseTotal.textContent = sysPulseTotal.toLocaleString('pt-BR');
  valPulseDelta.textContent = `Acumulado preservado • Último envio: +${telemetry.pulse_delta || 0}`;

  // Calibration check for VOLUME MEDIDO Card & Calibration Card (NÃO usa liters_total do ESP)
  const calib = (systemTotalsCache && systemTotalsCache.calibration_status)
    ? { status: systemTotalsCache.calibration_status, liters_per_pulse: systemTotalsCache.liters_per_pulse }
    : telemetry.calibration;

  if (calib && calib.status === 'calibrated' && sysVolLiters !== null) {
    const calcLiters = Number(sysVolLiters);
    const calcM3 = calcLiters / 1000;
    valLitersTotal.innerHTML = `${calcM3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="unit">m³</span>`;
    if (valLitersSub) {
      valLitersSub.textContent = `${calcLiters.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L acumulados desde o início • ${sysPulseTotal.toLocaleString('pt-BR')} pulsos acumulados`;
    }
    if (valLitersBadge) {
      valLitersBadge.textContent = `Fator: 1p = ${calib.liters_per_pulse}L`;
    }

    if (valCalibStatusText) valCalibStatusText.textContent = 'CALIBRADO';
    if (valCalibBadge) valCalibBadge.textContent = 'Calibrado';
    if (valCalibFactorSub) valCalibFactorSub.textContent = `1 pulso = ${calib.liters_per_pulse} Litros`;

    if (calibStatusBadge) {
      calibStatusBadge.className = 'status-indicator status-online';
      calibStatusText.textContent = 'CALIBRADO';
    }
    if (calibFactorText) {
      calibFactorText.textContent = `Fator de calibração ativo: 1 pulso = ${calib.liters_per_pulse} Litros`;
    }
    if (inputLitersPerPulse && !document.activeElement.matches('#input-liters-per-pulse')) {
      inputLitersPerPulse.value = calib.liters_per_pulse;
    }
  } else {
    valLitersTotal.innerHTML = `<span style="font-size: 1.75rem; color: #f59e0b;">CALIBRAÇÃO PENDENTE</span>`;
    if (valLitersSub) {
      valLitersSub.textContent = `Volume ainda não calibrado • ${sysPulseTotal.toLocaleString('pt-BR')} pulsos acumulados no histórico`;
    }
    if (valLitersBadge) {
      valLitersBadge.textContent = 'Leitura Estimada';
    }

    if (valCalibStatusText) valCalibStatusText.textContent = 'PENDENTE';
    if (valCalibBadge) valCalibBadge.textContent = 'Pendente';
    if (valCalibFactorSub) valCalibFactorSub.textContent = 'Fator: não configurado';

    if (calibStatusBadge) {
      calibStatusBadge.className = 'status-indicator status-offline';
      calibStatusText.textContent = 'CALIBRAÇÃO PENDENTE';
    }
    if (calibFactorText) {
      calibFactorText.textContent = 'Calibração pendente (fator não configurado)';
    }
  }

  if (telemetry.rssi !== null && telemetry.rssi !== undefined) {
    valRssi.innerHTML = `${telemetry.rssi} <span class="unit">dBm</span>`;
    const rssiObj = getRssiQuality(telemetry.rssi);
    valRssiQuality.textContent = rssiObj.label;
    valRssiQuality.className = rssiObj.className;
  } else {
    valRssi.innerHTML = `-- <span class="unit">dBm</span>`;
    valRssiQuality.textContent = 'Sem dados';
    valRssiQuality.className = 'rssi-quality-pill';
  }

  // Date & Time formatting & ONLINE / OFFLINE Status check (limiar 20s)
  if (telemetry.received_at) {
    const receivedDate = new Date(telemetry.received_at);
    valReceivedTime.textContent = receivedDate.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    valReceivedDate.textContent = receivedDate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const diffMs = Date.now() - receivedDate.getTime();
    const isOnline = diffMs <= 20000;

    if (isOnline) {
      statusBadge.className = 'status-indicator status-online';
      statusText.textContent = 'ONLINE';
    } else {
      statusBadge.className = 'status-indicator status-offline';
      statusText.textContent = 'OFFLINE';
    }
  } else {
    valReceivedTime.textContent = '--:--:--';
    valReceivedDate.textContent = '--/--/----';
    statusBadge.className = 'status-indicator status-offline';
    statusText.textContent = 'OFFLINE';
  }
}

async function fetchLatestTelemetry() {
  try {
    const [latestRes, summaryRes] = await Promise.all([
      adminFetch('/api/telemetry/latest', { cache: 'no-store' }),
      adminFetch('/api/telemetry/system-summary', { cache: 'no-store' })
    ]);

    if (summaryRes.ok) {
      const summaryJson = await summaryRes.json();
      if (summaryJson.ok) {
        systemTotalsCache = summaryJson;
      }
    }

    if (!latestRes.ok) {
      updateUI(null);
      return;
    }
    const result = await latestRes.json();
    if (result.ok && result.data) {
      updateUI(result.data);
    } else {
      updateUI(null);
    }
  } catch (err) {
    if (err.message !== 'Sessão expirada.') {
      console.error('Erro ao buscar dados:', err);
    }
  }
}

// History DOM elements
const histCount = document.getElementById('hist-count');
const histPulseSum = document.getElementById('hist-pulse-sum');
const histLastTime = document.getElementById('hist-last-time');
const histLastDate = document.getElementById('hist-last-date');
const historyTableBody = document.getElementById('history-table-body');
const historyEmptyState = document.getElementById('history-empty-state');

// Render SVG Chart 1: EVOLUÇÃO DO VOLUME
function renderVolumeEvolutionChart(historyList) {
  if (!chartVolumeSvg || !chartVolumeEmpty) return;

  const pulseEvents = (historyList || []).filter(e => e.type === 'pulse');
  if (pulseEvents.length === 0) {
    chartVolumeEmpty.classList.remove('hidden');
    chartVolumeSvg.classList.add('hidden');
    return;
  }

  chartVolumeEmpty.classList.add('hidden');
  chartVolumeSvg.classList.remove('hidden');

  const chronoEvents = [...pulseEvents].reverse();
  const isCalibrated = chronoEvents[0].calculated_liters_total !== null && chronoEvents[0].calculated_liters_total !== undefined;

  if (chartVolumeSubtitle) {
    chartVolumeSubtitle.textContent = isCalibrated
      ? "Progressão do volume medido ao longo do tempo (em litros)"
      : "Progressão acumulada de pulsos ao longo do tempo (leitura estimada)";
  }

  const values = chronoEvents.map(e => isCalibrated ? Number(e.calculated_liters_total || 0) : Number(e.pulse_total || 0));

  const width = 500;
  const height = 180;
  const padX = 40;
  const padY = 30;

  const minVal = Math.min(...values, 0);
  const maxVal = Math.max(...values, 1);
  const valRange = maxVal - minVal || 1;

  const points = values.map((val, idx) => {
    const x = chronoEvents.length > 1
      ? padX + (idx / (chronoEvents.length - 1)) * (width - 2 * padX)
      : width / 2;
    const y = height - padY - ((val - minVal) / valRange) * (height - 2 * padY);
    return { x, y, val };
  });

  let pathD = '';
  let areaD = '';

  if (points.length === 1) {
    const pt = points[0];
    pathD = `M ${pt.x - 30} ${pt.y} L ${pt.x + 30} ${pt.y}`;
    areaD = `M ${pt.x - 30} ${height - padY} L ${pt.x - 30} ${pt.y} L ${pt.x + 30} ${pt.y} L ${pt.x + 30} ${height - padY} Z`;
  } else {
    pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    areaD = `${pathD} L ${points[points.length - 1].x.toFixed(1)} ${height - padY} L ${points[0].x.toFixed(1)} ${height - padY} Z`;
  }

  const gridY1 = height - padY;
  const gridY2 = height - padY - (height - 2 * padY) / 2;
  const gridY3 = padY;
  const unitStr = isCalibrated ? 'L' : 'p';

  let svgContent = `
    <defs>
      <linearGradient id="volAreaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#06b6d4" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    <line x1="${padX}" y1="${gridY1}" x2="${width - padX}" y2="${gridY1}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4,4"/>
    <line x1="${padX}" y1="${gridY2}" x2="${width - padX}" y2="${gridY2}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4,4"/>
    <line x1="${padX}" y1="${gridY3}" x2="${width - padX}" y2="${gridY3}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4,4"/>
    
    <text x="${padX - 8}" y="${gridY3 + 4}" fill="#64748b" font-size="10" text-anchor="end" font-family="JetBrains Mono">${maxVal.toFixed(0)}${unitStr}</text>
    <text x="${padX - 8}" y="${gridY1 + 4}" fill="#64748b" font-size="10" text-anchor="end" font-family="JetBrains Mono">${minVal.toFixed(0)}${unitStr}</text>

    <path d="${areaD}" fill="url(#volAreaGrad)"/>
    <path d="${pathD}" fill="none" stroke="#06b6d4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  `;

  points.forEach((pt) => {
    svgContent += `
      <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="4" fill="#06b6d4" stroke="#090d16" stroke-width="2"/>
    `;
  });

  chartVolumeSvg.innerHTML = svgContent;
}

// Render SVG Chart 2: PULSOS RECENTES
function renderRecentPulsesChart(historyList) {
  if (!chartPulsesSvg || !chartPulsesEmpty) return;

  const pulseEvents = (historyList || []).filter(e => e.type === 'pulse');
  if (pulseEvents.length === 0) {
    chartPulsesEmpty.classList.remove('hidden');
    chartPulsesSvg.classList.add('hidden');
    return;
  }

  chartPulsesEmpty.classList.add('hidden');
  chartPulsesSvg.classList.remove('hidden');

  const recentEvents = [...pulseEvents].slice(0, 12).reverse();
  const values = recentEvents.map(e => Number(e.pulse_delta || 1));

  const width = 500;
  const height = 180;
  const padX = 35;
  const padY = 30;

  const maxVal = Math.max(...values, 1);
  const n = recentEvents.length;
  const availableWidth = width - 2 * padX;
  const barGap = 8;
  const barWidth = Math.max(12, (availableWidth - (n - 1) * barGap) / n);

  let svgContent = `
    <defs>
      <linearGradient id="pulseBarGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6"/>
        <stop offset="100%" stop-color="#06b6d4"/>
      </linearGradient>
    </defs>
  `;

  recentEvents.forEach((e, i) => {
    const val = values[i];
    const x = padX + i * (barWidth + barGap);
    const barHeight = Math.max(14, (val / maxVal) * (height - 2 * padY));
    const y = height - padY - barHeight;

    svgContent += `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="5" fill="url(#pulseBarGrad)"/>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" fill="#60a5fa" font-size="10" font-weight="700" text-anchor="middle" font-family="JetBrains Mono">+${val}</text>
    `;
  });

  svgContent += `<line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>`;

  chartPulsesSvg.innerHTML = svgContent;
}

// Flow UI DOM Elements
const valFlowRecent = document.getElementById('val-flow-recent');
const valFlowM3h = document.getElementById('val-flow-m3h');
const valFlowRecentSub = document.getElementById('val-flow-recent-sub');
const valFlowBadge = document.getElementById('val-flow-badge');
const valFlowAvg = document.getElementById('val-flow-avg');
const valFlowMax = document.getElementById('val-flow-max');
const valLastPulseTime = document.getElementById('val-last-pulse-time');
const valLastPulseDate = document.getElementById('val-last-pulse-date');
const valLastPulseRelative = document.getElementById('val-last-pulse-relative');
const flowCalibNotice = document.getElementById('flow-calib-notice');

const chartFlowWrapper = document.getElementById('chart-flow-wrapper');
const chartFlowEmpty = document.getElementById('chart-flow-empty');
const chartFlowSvg = document.getElementById('chart-flow-svg');

let currentLastPulseAt = null;

function formatRelativeTime(dateIso) {
  if (!dateIso) return 'Nenhum pulso registrado';
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

function updateRelativeTimeDisplay() {
  if (currentLastPulseAt && valLastPulseRelative) {
    valLastPulseRelative.textContent = formatRelativeTime(currentLastPulseAt);
  }
}

async function fetchFlowSummary() {
  try {
    const response = await adminFetch('/api/telemetry/flow-summary', { cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (!result.ok) return;

    const { calibration_status, liters_per_pulse, latest_flow_lpm, latest_flow_m3h, average_flow_lpm, max_flow_lpm, last_pulse_at } = result;

    currentLastPulseAt = last_pulse_at || null;

    // Check calibration
    if (calibration_status !== 'calibrated' || liters_per_pulse === null) {
      if (flowCalibNotice) flowCalibNotice.classList.remove('hidden');
      if (valFlowRecent) valFlowRecent.innerHTML = `<span style="font-size: 1.75rem; color: #f59e0b;">Calibração pendente</span>`;
      if (valFlowM3h) valFlowM3h.textContent = '-- m³/h';
      if (valFlowRecentSub) valFlowRecentSub.textContent = 'Defina a calibração do hidrômetro para calcular vazão em L/min.';
      if (valFlowBadge) valFlowBadge.textContent = 'Calibração Pendente';
      if (valFlowAvg) valFlowAvg.innerHTML = `-- <span class="unit">L/min</span>`;
      if (valFlowMax) valFlowMax.innerHTML = `-- <span class="unit">L/min</span>`;
    } else {
      if (flowCalibNotice) flowCalibNotice.classList.add('hidden');

      if (latest_flow_lpm === null) {
        if (valFlowRecent) valFlowRecent.innerHTML = `<span style="font-size: 1.5rem; color: #38bdf8;">AGUARDANDO 2º PULSO</span>`;
        if (valFlowM3h) valFlowM3h.textContent = '-- m³/h';
        if (valFlowRecentSub) valFlowRecentSub.textContent = 'São necessários dois pulsos válidos para calcular o primeiro intervalo de vazão.';
        if (valFlowBadge) valFlowBadge.textContent = 'Aguardando Dados';
        if (valFlowAvg) valFlowAvg.innerHTML = `-- <span class="unit">L/min</span>`;
        if (valFlowMax) valFlowMax.innerHTML = `-- <span class="unit">L/min</span>`;
      } else {
        if (valFlowRecent) valFlowRecent.innerHTML = `${latest_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} <span class="unit">L/min</span>`;
        if (valFlowM3h) valFlowM3h.textContent = `${latest_flow_m3h !== null ? latest_flow_m3h.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 3 }) : '--'} m³/h`;
        if (valFlowRecentSub) valFlowRecentSub.textContent = 'Calculada pelo intervalo mais recente entre pulsos.';
        if (valFlowBadge) valFlowBadge.textContent = 'Último Intervalo';

        if (valFlowAvg) {
          valFlowAvg.innerHTML = average_flow_lpm !== null
            ? `${average_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} <span class="unit">L/min</span>`
            : `-- <span class="unit">L/min</span>`;
        }

        if (valFlowMax) {
          valFlowMax.innerHTML = max_flow_lpm !== null
            ? `${max_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} <span class="unit">L/min</span>`
            : `-- <span class="unit">L/min</span>`;
        }
      }
    }

    // Last Pulse Card & Technical Card
    if (last_pulse_at) {
      const d = new Date(last_pulse_at);
      const timeStr = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const dateStr = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      if (valLastPulseTime) valLastPulseTime.textContent = timeStr;
      if (valLastPulseDate) valLastPulseDate.textContent = dateStr;
      if (valLastPulseRelative) valLastPulseRelative.textContent = formatRelativeTime(last_pulse_at);
      if (valCardLastPulseTime) valCardLastPulseTime.textContent = timeStr;
    } else {
      if (valLastPulseTime) valLastPulseTime.textContent = '--:--:--';
      if (valLastPulseDate) valLastPulseDate.textContent = '--/--/----';
      if (valLastPulseRelative) valLastPulseRelative.textContent = 'Nenhum pulso registrado';
      if (valCardLastPulseTime) valCardLastPulseTime.textContent = '--:--:--';
    }
  } catch (err) {
    console.error('Erro ao buscar resumo de vazão:', err);
  }
}

async function fetchFlowChart24h() {
  try {
    const response = await adminFetch('/api/telemetry/flow-chart-24h', { cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (!result.ok) return;
    renderFlowChart(result.data || []);
  } catch (err) {
    console.error('Erro ao buscar dados do gráfico de 24h:', err);
  }
}

// Helper para cálculo de escala com ticks arredondados e elegantes
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

let cachedFlowChartPoints = [];

// Interatividade customizada do gráfico 24h (Hover e Touch)
function handleFlowChartInteraction(e) {
  if (!chartFlowSvg || !cachedFlowChartPoints || cachedFlowChartPoints.length === 0) return;
  const flowTooltip = document.getElementById('flow-chart-tooltip');
  const interactiveGroup = document.getElementById('flow-interactive-group');
  const guideline = document.getElementById('flow-guideline');
  const highlightPoint = document.getElementById('flow-point-highlight');
  const highlightRing = document.getElementById('flow-point-ring');

  const rect = chartFlowSvg.getBoundingClientRect();
  if (rect.width === 0) return;

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;

  // Normalizar coordenada X para o viewBox 0..700
  const svgX = ((clientX - rect.left) / rect.width) * 700;

  // Encontrar o ponto/bucket mais próximo entre os 288
  let closest = cachedFlowChartPoints[0];
  let minDiff = Math.abs(svgX - closest.x);
  for (let i = 1; i < cachedFlowChartPoints.length; i++) {
    const diff = Math.abs(svgX - cachedFlowChartPoints[i].x);
    if (diff < minDiff) {
      minDiff = diff;
      closest = cachedFlowChartPoints[i];
    }
  }

  if (!closest) return;

  const bottomY = 205;
  const targetY = closest.y !== null ? closest.y : bottomY;

  // Atualizar marcador e linha vertical no SVG
  if (interactiveGroup && guideline && highlightPoint && highlightRing) {
    guideline.setAttribute('x1', closest.x.toFixed(1));
    guideline.setAttribute('x2', closest.x.toFixed(1));
    highlightPoint.setAttribute('cx', closest.x.toFixed(1));
    highlightPoint.setAttribute('cy', targetY.toFixed(1));
    highlightRing.setAttribute('cx', closest.x.toFixed(1));
    highlightRing.setAttribute('cy', targetY.toFixed(1));

    let color = '#38bdf8';
    if (closest.status === 'insufficient_data') color = '#f59e0b';
    else if (closest.status === 'no_flow') color = '#94a3b8';

    highlightPoint.setAttribute('fill', color);
    highlightRing.setAttribute('stroke', color);
    guideline.setAttribute('stroke', color);

    interactiveGroup.style.display = '';
  }

  // Atualizar Tooltip HTML
  if (flowTooltip && chartFlowWrapper) {
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

    const wrapperRect = chartFlowWrapper.getBoundingClientRect();
    const xInWrapper = clientX - wrapperRect.left;
    const yInWrapper = (targetY / 240) * wrapperRect.height;

    flowTooltip.style.left = `${Math.max(130, Math.min(wrapperRect.width - 130, xInWrapper))}px`;
    flowTooltip.style.top = `${Math.max(40, yInWrapper)}px`;
    flowTooltip.classList.add('visible');
  }
}

function hideFlowChartInteraction() {
  const flowTooltip = document.getElementById('flow-chart-tooltip');
  const interactiveGroup = document.getElementById('flow-interactive-group');
  if (flowTooltip) flowTooltip.classList.remove('visible');
  if (interactiveGroup) interactiveGroup.style.display = 'none';
}

// Inicializar listeners de interação no gráfico 24h
if (chartFlowWrapper) {
  chartFlowWrapper.addEventListener('mousemove', handleFlowChartInteraction);
  chartFlowWrapper.addEventListener('mouseleave', hideFlowChartInteraction);
  chartFlowWrapper.addEventListener('touchstart', handleFlowChartInteraction, { passive: true });
  chartFlowWrapper.addEventListener('touchmove', handleFlowChartInteraction, { passive: true });
}

document.addEventListener('touchstart', (e) => {
  if (chartFlowWrapper && !chartFlowWrapper.contains(e.target)) {
    hideFlowChartInteraction();
  }
}, { passive: true });

// Render SVG Chart 3: VAZÃO AO LONGO DO TEMPO (24 HORAS)
function renderFlowChart(chartBuckets) {
  if (!chartFlowSvg || !chartFlowEmpty) return;

  if (!Array.isArray(chartBuckets) || chartBuckets.length === 0) {
    chartFlowEmpty.classList.remove('hidden');
    chartFlowSvg.classList.add('hidden');
    cachedFlowChartPoints = [];
    return;
  }

  chartFlowEmpty.classList.add('hidden');
  chartFlowSvg.classList.remove('hidden');

  const width = 700;
  const height = 240;
  const padLeft = 75;
  const padRight = 25;
  const padTop = 20;
  const padBottom = 35;
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

  cachedFlowChartPoints = points;

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
      <path d="${areaD}" fill="url(#flowAreaGrad)"/>
      <path d="${pathD}" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  });

  // Ticks e Grid do Eixo Y
  let yGridSvg = '';
  ticks.forEach(tickVal => {
    const tickY = bottomY - (tickVal / niceMax) * chartH;
    const isZero = tickVal === 0;
    const strokeColor = isZero ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)';
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
        ? `<tspan font-weight="700" fill="#38bdf8">AGORA</tspan> <tspan font-size="8" fill="#64748b">(${pt.timeLabel})</tspan>`
        : (pt.timeLabel || '--');

      xGridAndLabels += `
        <line x1="${pt.x.toFixed(1)}" y1="${topY}" x2="${pt.x.toFixed(1)}" y2="${bottomY}" stroke="rgba(255,255,255,0.04)" stroke-dasharray="2,4"/>
        <text x="${pt.x.toFixed(1)}" y="${(bottomY + 18).toFixed(1)}" fill="#64748b" font-size="9" text-anchor="${anchor}" font-family="JetBrains Mono">${labelContent}</text>
      `;
    }
  });

  let svgContent = `
    <defs>
      <linearGradient id="flowAreaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.30"/>
        <stop offset="85%" stop-color="#38bdf8" stop-opacity="0.04"/>
        <stop offset="100%" stop-color="#0284c7" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    ${yGridSvg}
    ${xGridAndLabels}
    ${pathsSvg}
    <g id="flow-interactive-group" style="display: none; pointer-events: none;">
      <line id="flow-guideline" x1="0" y1="${topY}" x2="0" y2="${bottomY}" stroke="#38bdf8" stroke-width="1.2" stroke-dasharray="3,3" opacity="0.8"/>
      <circle id="flow-point-ring" cx="0" cy="0" r="9" fill="none" stroke="#38bdf8" stroke-width="1.5" opacity="0.4"/>
      <circle id="flow-point-highlight" cx="0" cy="0" r="4.5" fill="#38bdf8" stroke="#0f172a" stroke-width="2"/>
    </g>
  `;

  chartFlowSvg.innerHTML = svgContent;
}

function updateHistoryUI(historyList) {
  // Render Charts
  renderVolumeEvolutionChart(historyList);
  renderRecentPulsesChart(historyList);

  if (!Array.isArray(historyList) || historyList.length === 0) {
    if (historyEmptyState) historyEmptyState.classList.remove('hidden');
    if (historyTableBody) historyTableBody.innerHTML = '';
    if (histCount) histCount.textContent = '0';
    if (histPulseSum) histPulseSum.textContent = '0';
    if (histLastTime) histLastTime.textContent = '--:--:--';
    if (histLastDate) histLastDate.textContent = '--/--/----';
    return;
  }

  if (historyEmptyState) historyEmptyState.classList.add('hidden');

  // Filter pulse events for summary counters
  const pulseEvents = historyList.filter(e => e.type === 'pulse');
  const count = pulseEvents.length;
  const pulseSum = pulseEvents.reduce((acc, item) => acc + (item.pulse_delta || 0), 0);

  if (histCount) histCount.textContent = count.toLocaleString('pt-BR');
  if (histPulseSum) histPulseSum.textContent = pulseSum.toLocaleString('pt-BR');

  if (pulseEvents.length > 0 && pulseEvents[0].received_at) {
    const lastDate = new Date(pulseEvents[0].received_at);
    if (histLastTime) histLastTime.textContent = lastDate.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    if (histLastDate) histLastDate.textContent = lastDate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } else {
    if (histLastTime) histLastTime.textContent = '--:--:--';
    if (histLastDate) histLastDate.textContent = '--/--/----';
  }

  // Render rows
  if (historyTableBody) {
    const rowsHtml = historyList.map(item => {
      const recDate = item.received_at ? new Date(item.received_at) : null;
      const dateStr = recDate ? recDate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '--';
      const timeStr = recDate ? recDate.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '--';

      let eventBadgeHtml = '';
      let pulseDeltaStr = '--';
      let pulseTotalStr = '--';
      let litersEstimatedStr = '<span style="color: #94a3b8;">Pendente</span>';
      let intervalStr = '--';
      let flowLpmStr = '--';

      if (item.type === 'pulse') {
        const delta = item.pulse_delta || 1;
        if (delta > 1) {
          eventBadgeHtml = `<span class="badge-event badge-event-accumulated">Pulsos acumulados</span>`;
        } else {
          eventBadgeHtml = `<span class="badge-event badge-event-pulse">Pulso</span>`;
        }
        pulseDeltaStr = `+${delta}`;
        pulseTotalStr = (item.pulse_total !== undefined && item.pulse_total !== null) ? item.pulse_total.toLocaleString('pt-BR') : '--';

        if (item.calculated_liters_delta !== null && item.calculated_liters_delta !== undefined) {
          const liters = Number(item.calculated_liters_delta);
          litersEstimatedStr = `${liters.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L`;
        } else {
          litersEstimatedStr = `<span style="color: #f59e0b; font-size: 0.75rem; font-weight: 600;">Pendente</span>`;
        }

        if (item.interval_seconds !== null && item.interval_seconds !== undefined) {
          intervalStr = `${item.interval_seconds} s`;
        }

        if (item.flow_lpm !== null && item.flow_lpm !== undefined && item.flow_status === 'ok') {
          intervalStr = `${item.interval_seconds} s`;
          flowLpmStr = `<span style="color: #38bdf8; font-weight: 700;">${item.flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L/min</span>`;
        } else if (item.flow_status === 'calibration_pending') {
          flowLpmStr = `<span style="color: #f59e0b; font-size: 0.75rem;">Pendente</span>`;
        } else if (item.flow_status === 'insufficient_data') {
          flowLpmStr = `<span style="color: #64748b; font-size: 0.75rem;">--</span>`;
        }
      } else if (item.type === 'counter_reset') {
        eventBadgeHtml = `<span class="badge-event badge-event-reset">Reinício do contador</span>`;
        pulseDeltaStr = `--`;
        pulseTotalStr = item.new_pulse_total !== undefined ? item.new_pulse_total : '0';
        litersEstimatedStr = `--`;
        intervalStr = `--`;
        flowLpmStr = `--`;
      } else {
        eventBadgeHtml = `<span class="badge-event">${item.type || 'Evento'}</span>`;
      }

      const rssiStr = (item.rssi !== null && item.rssi !== undefined) ? `${item.rssi} dBm` : '--';

      return `
        <tr>
          <td class="td-mono">${dateStr}</td>
          <td class="td-mono">${timeStr}</td>
          <td>${eventBadgeHtml}</td>
          <td class="td-mono td-bold">${pulseDeltaStr}</td>
          <td class="td-mono">${intervalStr}</td>
          <td class="td-mono">${flowLpmStr}</td>
          <td class="td-mono">${pulseTotalStr}</td>
          <td class="td-mono">${litersEstimatedStr}</td>
          <td class="td-mono">${rssiStr}</td>
        </tr>
      `;
    }).join('');

    historyTableBody.innerHTML = rowsHtml;
  }
}

// Sessions DOM Elements
const sessionStatusBadge = document.getElementById('session-status-badge');
const sessionStatusText = document.getElementById('session-status-text');
const cardSessionHero = document.getElementById('card-session-hero');
const valSessionTitle = document.getElementById('val-session-title');
const valSessionSub = document.getElementById('val-session-sub');
const valSessionBadge = document.getElementById('val-session-badge');
const sessValStarted = document.getElementById('sess-val-started');
const sessValLastPulse = document.getElementById('sess-val-last-pulse');
const sessValDuration = document.getElementById('sess-val-duration');
const sessValPulses = document.getElementById('sess-val-pulses');
const sessValVolume = document.getElementById('sess-val-volume');
const sessValAvgFlow = document.getElementById('sess-val-avg-flow');
const sessionsTableBody = document.getElementById('sessions-table-body');
const sessionsEmptyState = document.getElementById('sessions-empty-state');

function formatDuration(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '--';
  const s = Math.floor(sec);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) {
    return remS > 0 ? `${m} min ${remS} s` : `${m} min`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h} h ${remM} min` : `${h} h`;
}

function updateSessionsUI(sessionsList, summaryData) {
  const hasOpen = summaryData && summaryData.open_session;
  const latestSession = summaryData && summaryData.latest_session;

  if (hasOpen && latestSession) {
    if (sessionStatusBadge) sessionStatusBadge.className = 'session-status-badge status-online';
    if (sessionStatusText) sessionStatusText.textContent = 'PASSAGEM ATIVA';
    if (cardSessionHero) cardSessionHero.className = 'card card-session-hero';
    if (valSessionTitle) valSessionTitle.textContent = 'PASSAGEM DETECTADA EM ANDAMENTO';
    if (valSessionSub) valSessionSub.textContent = 'Fluxo de água ativo e registrando pulsos no hidrômetro.';
    if (valSessionBadge) valSessionBadge.textContent = 'Sessão Ativa';

    if (sessValStarted) sessValStarted.textContent = new Date(latestSession.started_at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    if (sessValLastPulse) sessValLastPulse.textContent = new Date(latestSession.last_pulse_at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    if (sessValDuration) sessValDuration.textContent = formatDuration(latestSession.duration_seconds);
    if (sessValPulses) sessValPulses.textContent = `${latestSession.pulse_count} pulsos (${latestSession.pulse_events} envios)`;

    if (sessValVolume) {
      sessValVolume.innerHTML = latestSession.volume_liters !== null
        ? `${latestSession.volume_liters.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L`
        : `<span style="color:#f59e0b;">Pendente</span>`;
    }

    if (sessValAvgFlow) {
      sessValAvgFlow.innerHTML = latestSession.average_flow_lpm !== null
        ? `${latestSession.average_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L/min`
        : `--`;
    }

    // Atualiza Card de Apoio PASSAGEM ATUAL
    if (valPassageStatus) valPassageStatus.innerHTML = `<span style="color:#059669;">PASSAGEM ATIVA</span>`;
    if (valPassageSub) valPassageSub.textContent = `Início: ${new Date(latestSession.started_at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} • ${formatDuration(latestSession.duration_seconds)}`;
    if (valPassageBadge) {
      valPassageBadge.textContent = 'EM FLUXO';
      valPassageBadge.className = 'scada-badge badge-closed';
    }
  } else {
    if (sessionStatusBadge) sessionStatusBadge.className = 'session-status-badge status-offline';
    if (sessionStatusText) sessionStatusText.textContent = 'SEM PASSAGEM';
    if (cardSessionHero) cardSessionHero.className = 'card card-session-hero card-session-hero-closed';
    if (valSessionTitle) valSessionTitle.textContent = 'SEM PASSAGEM DETECTADA NO MOMENTO';

    if (latestSession) {
      const endD = new Date(latestSession.last_pulse_at);
      if (valSessionSub) valSessionSub.textContent = `Última passagem registrada em ${endD.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} às ${endD.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`;
      if (valSessionBadge) valSessionBadge.textContent = 'Última Sessão';
      if (sessValStarted) sessValStarted.textContent = new Date(latestSession.started_at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      if (sessValLastPulse) sessValLastPulse.textContent = endD.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      if (sessValDuration) sessValDuration.textContent = formatDuration(latestSession.duration_seconds);
      if (sessValPulses) sessValPulses.textContent = `${latestSession.pulse_count} pulsos`;

      if (sessValVolume) {
        sessValVolume.innerHTML = latestSession.volume_liters !== null
          ? `${latestSession.volume_liters.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L`
          : `<span style="color:#f59e0b;">Pendente</span>`;
      }

      if (sessValAvgFlow) {
        sessValAvgFlow.innerHTML = latestSession.average_flow_lpm !== null
          ? `${latestSession.average_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L/min`
          : `--`;
      }

      // Atualiza Card de Apoio PASSAGEM ATUAL
      if (valPassageStatus) valPassageStatus.textContent = 'SEM PASSAGEM';
      if (valPassageSub) valPassageSub.textContent = `Última: ${endD.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} • ${latestSession.pulse_count} pulsos`;
      if (valPassageBadge) {
        valPassageBadge.textContent = 'Repouso';
        valPassageBadge.className = 'scada-badge badge-slate';
      }
    } else {
      if (valSessionSub) valSessionSub.textContent = 'Nenhuma passagem de água registrada até o momento.';
      if (valSessionBadge) valSessionBadge.textContent = 'Sem Dados';
      if (sessValStarted) sessValStarted.textContent = '--:--:--';
      if (sessValLastPulse) sessValLastPulse.textContent = '--:--:--';
      if (sessValDuration) sessValDuration.textContent = '--';
      if (sessValPulses) sessValPulses.textContent = '0';
      if (sessValVolume) sessValVolume.textContent = '--';
      if (sessValAvgFlow) sessValAvgFlow.textContent = '--';

      if (valPassageStatus) valPassageStatus.textContent = 'SEM PASSAGEM';
      if (valPassageSub) valPassageSub.textContent = 'Nenhum fluxo registrado';
      if (valPassageBadge) {
        valPassageBadge.textContent = 'Repouso';
        valPassageBadge.className = 'scada-badge badge-slate';
      }
    }
  }

  // Render Sessions Table
  if (sessionsTableBody) {
    if (!Array.isArray(sessionsList) || sessionsList.length === 0) {
      if (sessionsEmptyState) sessionsEmptyState.classList.remove('hidden');
      sessionsTableBody.innerHTML = '';
      return;
    }

    if (sessionsEmptyState) sessionsEmptyState.classList.add('hidden');

    const rowsHtml = sessionsList.map(sess => {
      const startD = new Date(sess.started_at);
      const dateStr = startD.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const startTimeStr = startD.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });

      let lastPulseOrEndStr = '--';
      if (sess.status === 'open') {
        lastPulseOrEndStr = `<span class="badge-event badge-session-open">EM ANDAMENTO</span>`;
      } else if (sess.last_pulse_at) {
        lastPulseOrEndStr = new Date(sess.last_pulse_at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      }

      const durationStr = formatDuration(sess.duration_seconds);
      const pulsesStr = `${sess.pulse_count}`;
      const volumeStr = sess.volume_liters !== null ? `${sess.volume_liters.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L` : '<span style="color:#f59e0b; font-size:0.75rem;">Pendente</span>';
      const avgFlowStr = sess.average_flow_lpm !== null ? `${sess.average_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L/min` : '--';
      const maxFlowStr = sess.max_flow_lpm !== null ? `${sess.max_flow_lpm.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L/min` : '--';

      return `
        <tr>
          <td class="td-mono td-bold" style="color:#38bdf8;">${sess.session_id}</td>
          <td class="td-mono">${dateStr}</td>
          <td class="td-mono">${startTimeStr}</td>
          <td>${lastPulseOrEndStr}</td>
          <td class="td-mono">${durationStr}</td>
          <td class="td-mono td-bold">${pulsesStr}</td>
          <td class="td-mono">${volumeStr}</td>
          <td class="td-mono">${avgFlowStr}</td>
          <td class="td-mono">${maxFlowStr}</td>
        </tr>
      `;
    }).join('');

    sessionsTableBody.innerHTML = rowsHtml;
  }
}

async function fetchFlowSessions() {
  try {
    const response = await adminFetch('/api/telemetry/flow-sessions?limit=50', { cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (!result.ok) return;

    const listData = Array.isArray(result.data) ? result.data : [];
    const sumData = result.summary || null;

    updateSessionsUI(listData, sumData);
  } catch (err) {
    console.error('Erro ao buscar sessões de fluxo:', err);
  }
}

// ==========================================================================
// RESUMO DIÁRIO & GRÁFICO 7 DIAS (DAILY-UX-01)
// ==========================================================================

function showDailyUnavailable() {
  if (valTodayM3) valTodayM3.innerHTML = `-- <span class="unit">m³</span>`;
  if (valTodaySub) valTodaySub.textContent = 'Dados diários indisponíveis';
  if (valYesterdayM3) valYesterdayM3.innerHTML = `-- <span class="unit">m³</span>`;
  if (valYesterdaySub) valYesterdaySub.textContent = 'Dados diários indisponíveis';
  if (valAvg7M3) valAvg7M3.innerHTML = `-- <span class="unit">m³/dia</span>`;
  if (valAvg7Sub) valAvg7Sub.textContent = 'Dados diários indisponíveis';
  if (chartDailyEmpty) chartDailyEmpty.classList.remove('hidden');
  if (dailyBarChartContainer) dailyBarChartContainer.innerHTML = '';
}

async function fetchDailySummary() {
  try {
    const response = await adminFetch('/api/telemetry/daily-summary?days=7', { cache: 'no-store' });
    if (!response.ok) {
      showDailyUnavailable();
      return;
    }
    const result = await response.json();
    if (result.ok && Array.isArray(result.items)) {
      dailySummaryCache = result.items;
      updateDailyUI(result.items);
    } else {
      showDailyUnavailable();
    }
  } catch (err) {
    if (err.message !== 'Sessão expirada.') {
      console.error('Erro ao buscar resumo diário:', err);
    }
    showDailyUnavailable();
  }
}

function updateDailyUI(items) {
  if (!Array.isArray(items) || items.length === 0) {
    showDailyUnavailable();
    return;
  }

  if (chartDailyEmpty) chartDailyEmpty.classList.add('hidden');

  // 1. Identificar o item de "Hoje" (último item da lista cronológica ou status === 'EM_ANDAMENTO')
  const todayItem = items[items.length - 1];

  if (todayItem && valTodayM3) {
    if (todayItem.volume_m3 !== null && todayItem.volume_m3 !== undefined) {
      valTodayM3.innerHTML = `${Number(todayItem.volume_m3).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="unit">m³</span>`;
      const litersFormatted = todayItem.volume_liters !== null ? Number(todayItem.volume_liters).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) : '--';
      if (valTodaySub) {
        valTodaySub.textContent = `${litersFormatted} L • 00:00 → agora`;
      }
    } else if (todayItem.volume_liters !== null && todayItem.volume_liters !== undefined) {
      const m3 = Number(todayItem.volume_liters) / 1000;
      valTodayM3.innerHTML = `${m3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="unit">m³</span>`;
      if (valTodaySub) {
        valTodaySub.textContent = `${Number(todayItem.volume_liters).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L • 00:00 → agora`;
      }
    } else {
      valTodayM3.innerHTML = `0,00 <span class="unit">m³</span>`;
      if (valTodaySub) valTodaySub.textContent = `0 L • 00:00 → agora`;
    }
    if (valTodayBadge) {
      valTodayBadge.textContent = 'EM ANDAMENTO';
      valTodayBadge.className = 'scada-badge badge-today';
    }
  }

  // 2. Identificar o item de "Ontem" (penúltimo item da lista de 7 dias)
  const yesterdayItem = items.length >= 2 ? items[items.length - 2] : null;
  if (yesterdayItem && valYesterdayM3) {
    const yStatus = yesterdayItem.status;
    const yDate = yesterdayItem.date ? yesterdayItem.date.split('-').reverse().join('/') : 'Ontem';

    if (yStatus === 'FECHADO') {
      const m3 = yesterdayItem.volume_m3 !== null ? Number(yesterdayItem.volume_m3) : (yesterdayItem.volume_liters ? Number(yesterdayItem.volume_liters) / 1000 : 0);
      const liters = yesterdayItem.volume_liters !== null ? Number(yesterdayItem.volume_liters) : 0;
      valYesterdayM3.innerHTML = `${m3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="unit">m³</span>`;
      if (valYesterdaySub) {
        valYesterdaySub.textContent = `${liters.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L • Dia Completo (${yDate})`;
      }
      if (valYesterdayBadge) {
        valYesterdayBadge.textContent = 'FECHADO';
        valYesterdayBadge.className = 'scada-badge badge-closed';
      }
    } else if (yStatus === 'PARCIAL') {
      const m3 = yesterdayItem.volume_m3 !== null ? Number(yesterdayItem.volume_m3) : (yesterdayItem.volume_liters ? Number(yesterdayItem.volume_liters) / 1000 : 0);
      const liters = yesterdayItem.volume_liters !== null ? Number(yesterdayItem.volume_liters) : 0;
      valYesterdayM3.innerHTML = `${m3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="unit">m³</span>`;
      if (valYesterdaySub) {
        valYesterdaySub.textContent = `${liters.toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L • Janela incompleta de medição`;
      }
      if (valYesterdayBadge) {
        valYesterdayBadge.textContent = 'PARCIAL';
        valYesterdayBadge.className = 'scada-badge badge-partial';
      }
    } else {
      // SEM_REGISTRO ou outro
      valYesterdayM3.innerHTML = `-- <span class="unit">m³</span>`;
      if (valYesterdaySub) {
        valYesterdaySub.textContent = `Sem registros de medição (${yDate})`;
      }
      if (valYesterdayBadge) {
        valYesterdayBadge.textContent = 'SEM REGISTRO';
        valYesterdayBadge.className = 'scada-badge badge-slate';
      }
    }
  }

  // 3. Média 7 Dias (SOMENTE dias FECHADOS)
  if (valAvg7M3) {
    const closedDays = items.filter(d => d.status === 'FECHADO');
    if (closedDays.length === 0) {
      valAvg7M3.innerHTML = `-- <span class="unit">m³/dia</span>`;
      if (valAvg7Sub) valAvg7Sub.textContent = 'Aguardando dias completos';
      if (valAvg7Badge) {
        valAvg7Badge.textContent = '0 DIAS FECHADOS';
        valAvg7Badge.className = 'scada-badge badge-slate';
      }
    } else {
      const sumM3 = closedDays.reduce((acc, d) => {
        const v = d.volume_m3 !== null ? Number(d.volume_m3) : (d.volume_liters ? Number(d.volume_liters) / 1000 : 0);
        return acc + v;
      }, 0);
      const avgM3 = sumM3 / closedDays.length;
      valAvg7M3.innerHTML = `${avgM3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span class="unit">m³/dia</span>`;
      if (valAvg7Sub) {
        valAvg7Sub.textContent = `${closedDays.length} ${closedDays.length === 1 ? 'dia completo considerado' : 'dias completos considerados'}`;
      }
      if (valAvg7Badge) {
        valAvg7Badge.textContent = `${closedDays.length} DIAS FECHADOS`;
        valAvg7Badge.className = 'scada-badge badge-closed';
      }
    }
  }

  // 4. Renderizar Gráfico de Barras Diário
  renderDailyBarChart(items);
}

function renderDailyBarChart(items) {
  if (!dailyBarChartContainer) return;

  const width = 700;
  const height = 210;
  const padLeft = 65;
  const padRight = 20;
  const padTop = 32;
  const padBottom = 40;

  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;
  const bottomY = height - padBottom;

  // Max volume in m3
  const maxDataM3 = Math.max(...items.map(d => {
    if (d.volume_m3 !== null && d.volume_m3 !== undefined) return Number(d.volume_m3);
    if (d.volume_liters !== null && d.volume_liters !== undefined) return Number(d.volume_liters) / 1000;
    return 0;
  }), 10);

  const maxScale = Math.ceil(maxDataM3 * 1.15);
  const midScale = maxScale / 2;

  const numSlots = items.length;
  const slotW = chartW / numSlots;
  const barW = Math.min(48, slotW * 0.65);

  let gridSvg = `
    <line x1="${padLeft}" y1="${padTop}" x2="${width - padRight}" y2="${padTop}" stroke="rgba(255,255,255,0.07)" stroke-dasharray="3,3"/>
    <line x1="${padLeft}" y1="${padTop + chartH * 0.5}" x2="${width - padRight}" y2="${padTop + chartH * 0.5}" stroke="rgba(255,255,255,0.07)" stroke-dasharray="3,3"/>
    <line x1="${padLeft}" y1="${bottomY}" x2="${width - padRight}" y2="${bottomY}" stroke="rgba(255,255,255,0.2)"/>
    
    <text x="${padLeft - 8}" y="${padTop + 4}" fill="#64748b" font-size="10" text-anchor="end" font-family="JetBrains Mono">${maxScale.toFixed(0)} m³</text>
    <text x="${padLeft - 8}" y="${padTop + chartH * 0.5 + 4}" fill="#64748b" font-size="10" text-anchor="end" font-family="JetBrains Mono">${midScale.toFixed(0)} m³</text>
    <text x="${padLeft - 8}" y="${bottomY + 4}" fill="#64748b" font-size="10" text-anchor="end" font-family="JetBrains Mono">0 m³</text>
  `;

  let barsSvg = '';
  let tooltipDataMap = [];

  items.forEach((d, idx) => {
    const slotCenterX = padLeft + (idx + 0.5) * slotW;
    const barX = slotCenterX - barW / 2;

    const [yYear, yMonth, yDay] = (d.date || '').split('-');
    const dateLabel = yDay && yMonth ? `${yDay}/${yMonth}` : d.date;
    const isToday = d.status === 'EM_ANDAMENTO';

    const volM3 = d.volume_m3 !== null && d.volume_m3 !== undefined ? Number(d.volume_m3) : (d.volume_liters !== null && d.volume_liters !== undefined ? Number(d.volume_liters) / 1000 : null);
    const volLiters = d.volume_liters !== null && d.volume_liters !== undefined ? Number(d.volume_liters) : null;

    let barHeight = 0;
    if (volM3 !== null && maxScale > 0) {
      barHeight = (volM3 / maxScale) * chartH;
    }
    const barY = bottomY - barHeight;

    let fillAttr = '';
    let strokeAttr = '';
    let statusText = d.status;
    let badgeClass = 'badge-slate';

    if (d.status === 'FECHADO') {
      fillAttr = 'url(#dailyClosedGrad)';
      strokeAttr = '#38bdf8';
      statusText = 'FECHADO';
      badgeClass = 'badge-closed';
    } else if (d.status === 'PARCIAL') {
      fillAttr = 'url(#dailyPartialGrad)';
      strokeAttr = '#fbbf24';
      statusText = 'PARCIAL';
      badgeClass = 'badge-partial';
    } else if (d.status === 'EM_ANDAMENTO') {
      fillAttr = 'url(#dailyTodayGrad)';
      strokeAttr = '#67e8f9';
      statusText = 'HOJE (EM ANDAMENTO)';
      badgeClass = 'badge-today';
    } else {
      fillAttr = 'rgba(51, 65, 85, 0.3)';
      strokeAttr = '#475569';
      statusText = 'SEM REGISTRO';
      badgeClass = 'badge-slate';
    }

    tooltipDataMap.push({
      date: d.date ? `${yDay}/${yMonth}/${yYear}` : '--',
      status: statusText,
      badgeClass: badgeClass,
      volume_m3: volM3 !== null ? `${volM3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m³` : '--',
      volume_liters: volLiters !== null ? `${volLiters.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L` : '--',
      pulses: d.pulse_count !== null && d.pulse_count !== undefined ? Number(d.pulse_count).toLocaleString('pt-BR') : '--',
      avg_flow: d.average_flow_lpm !== null && d.average_flow_lpm !== undefined ? `${Number(d.average_flow_lpm).toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L/min` : '--',
      max_flow: d.max_flow_lpm !== null && d.max_flow_lpm !== undefined ? `${Number(d.max_flow_lpm).toLocaleString('pt-BR', { minimumFractionDigits: 1 })} L/min` : '--',
      duration: d.flow_duration_seconds ? formatDuration(d.flow_duration_seconds) : '--'
    });

    if (d.status === 'SEM_REGISTRO' || volM3 === null) {
      barsSvg += `
        <g class="daily-bar-item" data-idx="${idx}">
          <line x1="${slotCenterX - 10}" y1="${bottomY - 1}" x2="${slotCenterX + 10}" y2="${bottomY - 1}" stroke="#475569" stroke-width="2" stroke-dasharray="3,3"/>
          <text x="${slotCenterX}" y="${bottomY - 10}" fill="#64748b" font-size="9" text-anchor="middle" font-family="JetBrains Mono">--</text>
          <text x="${slotCenterX}" y="${height - 12}" fill="#64748b" font-size="10" text-anchor="middle" font-family="JetBrains Mono">${dateLabel}</text>
          <rect x="${barX}" y="${padTop}" width="${barW}" height="${chartH}" fill="transparent"/>
        </g>
      `;
    } else {
      const valLabel = volM3 > 0 ? `${volM3.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}` : '0';
      const labelColor = isToday ? '#67e8f9' : (d.status === 'PARCIAL' ? '#fbbf24' : '#38bdf8');
      const dateColor = isToday ? '#38bdf8' : '#94a3b8';
      const dateWeight = isToday ? 'bold' : 'normal';

      barsSvg += `
        <g class="daily-bar-item" data-idx="${idx}">
          <rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(barHeight, 2).toFixed(1)}" rx="3" ry="3" fill="${fillAttr}" stroke="${strokeAttr}" stroke-width="1"/>
          <text x="${slotCenterX.toFixed(1)}" y="${(barY - 6).toFixed(1)}" fill="${labelColor}" font-size="10" font-weight="700" text-anchor="middle" font-family="JetBrains Mono">${valLabel}</text>
          ${isToday ? `<text x="${slotCenterX.toFixed(1)}" y="${(barY - 18).toFixed(1)}" fill="#38bdf8" font-size="8" font-weight="800" text-anchor="middle" font-family="JetBrains Mono">HOJE</text>` : ''}
          <text x="${slotCenterX.toFixed(1)}" y="${height - 12}" fill="${dateColor}" font-weight="${dateWeight}" font-size="10" text-anchor="middle" font-family="JetBrains Mono">${dateLabel}</text>
          <rect x="${barX.toFixed(1)}" y="${padTop}" width="${barW.toFixed(1)}" height="${chartH}" fill="transparent"/>
        </g>
      `;
    }
  });

  const fullSvg = `
    <svg class="daily-bar-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="dailyClosedGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0284c7" stop-opacity="0.9"/>
          <stop offset="100%" stop-color="#0369a1" stop-opacity="0.4"/>
        </linearGradient>
        <linearGradient id="dailyPartialGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.9"/>
          <stop offset="100%" stop-color="#d97706" stop-opacity="0.35"/>
        </linearGradient>
        <linearGradient id="dailyTodayGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.95"/>
          <stop offset="100%" stop-color="#0284c7" stop-opacity="0.5"/>
        </linearGradient>
      </defs>
      ${gridSvg}
      ${barsSvg}
    </svg>
    <div id="daily-chart-tooltip" class="daily-chart-tooltip"></div>
  `;

  dailyBarChartContainer.innerHTML = fullSvg;

  // Tooltip interaction events
  const tooltipEl = document.getElementById('daily-chart-tooltip');
  const barElements = dailyBarChartContainer.querySelectorAll('.daily-bar-item');

  barElements.forEach(el => {
    const idx = parseInt(el.getAttribute('data-idx'), 10);
    const data = tooltipDataMap[idx];
    if (!data || !tooltipEl) return;

    function showTooltip(e) {
      const containerRect = dailyBarChartContainer.getBoundingClientRect();
      const clientX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
      const clientY = e.clientY || (e.touches && e.touches[0].clientY) || 0;

      const x = clientX - containerRect.left;
      const y = clientY - containerRect.top;

      let html = `
        <div class="tt-header">
          <span class="tt-date">${data.date}</span>
          <span class="tt-status scada-badge ${data.badgeClass}">${data.status}</span>
        </div>
        <div class="tt-row"><span class="tt-label">Volume:</span><span class="tt-val" style="color:#38bdf8;">${data.volume_m3} (${data.volume_liters})</span></div>
        <div class="tt-row"><span class="tt-label">Pulsos:</span><span class="tt-val">${data.pulses}</span></div>
      `;

      if (data.avg_flow !== '--') {
        html += `<div class="tt-row"><span class="tt-label">Vazão Média:</span><span class="tt-val">${data.avg_flow}</span></div>`;
      }
      if (data.max_flow !== '--') {
        html += `<div class="tt-row"><span class="tt-label">Pico:</span><span class="tt-val">${data.max_flow}</span></div>`;
      }
      if (data.duration !== '--') {
        html += `<div class="tt-row"><span class="tt-label">Tempo de Fluxo:</span><span class="tt-val">${data.duration}</span></div>`;
      }

      tooltipEl.innerHTML = html;
      tooltipEl.style.left = `${Math.max(120, Math.min(containerRect.width - 120, x))}px`;
      tooltipEl.style.top = `${Math.max(50, y)}px`;
      tooltipEl.classList.add('visible');
    }

    function hideTooltip() {
      tooltipEl.classList.remove('visible');
    }

    el.addEventListener('mouseenter', showTooltip);
    el.addEventListener('mousemove', showTooltip);
    el.addEventListener('mouseleave', hideTooltip);
    el.addEventListener('touchstart', showTooltip, { passive: true });
    el.addEventListener('touchend', hideTooltip);
  });
}

// CALIB-02 Semiautomatic Calibration DOM Elements
const calibStateIdle = document.getElementById('calib-state-idle');
const calibStateActive = document.getElementById('calib-state-active');
const calibStatePreview = document.getElementById('calib-state-preview');

const btnStartCalibration = document.getElementById('btn-start-calibration');
const btnCalculateCalibration = document.getElementById('btn-calculate-calibration');
const btnCancelCalibration = document.getElementById('btn-cancel-calibration');
const btnConfirmCalibration = document.getElementById('btn-confirm-calibration');
const btnBackCalibration = document.getElementById('btn-back-calibration');

const inputKnownVolume = document.getElementById('input-known-volume');
const calibValStartedAt = document.getElementById('calib-val-started-at');
const calibValStartPulses = document.getElementById('calib-val-start-pulses');
const calibValCurrentPulses = document.getElementById('calib-val-current-pulses');
const calibValDiffPulses = document.getElementById('calib-val-diff-pulses');

const prevValVolume = document.getElementById('prev-val-volume');
const prevValPulses = document.getElementById('prev-val-pulses');
const prevValFactor = document.getElementById('prev-val-factor');
const prevValFormula = document.getElementById('prev-val-formula');

const calibErrorMessage = document.getElementById('calib-error-message');

let currentPreviewCalculation = null;

async function fetchCalibrationSession() {
  try {
    const response = await adminFetch('/api/config/calibration/session', { cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (result.ok) {
      updateCalibrationSessionUI(result.calibration_session);
    }
  } catch (err) {
    console.error('Erro ao buscar sessão de calibração:', err);
  }
}

function updateCalibrationSessionUI(session) {
  if (currentPreviewCalculation) {
    if (!session) {
      currentPreviewCalculation = null;
      showCalibState('idle');
    }
    return;
  }

  if (!session || session.status !== 'active') {
    showCalibState('idle');
    return;
  }

  showCalibState('active');

  if (calibValStartedAt && session.started_at) {
    calibValStartedAt.textContent = new Date(session.started_at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }
  if (calibValStartPulses) {
    calibValStartPulses.textContent = (session.start_system_pulse_total || 0).toLocaleString('pt-BR');
  }
  if (calibValCurrentPulses) {
    calibValCurrentPulses.textContent = (session.current_system_pulse_total || 0).toLocaleString('pt-BR');
  }
  if (calibValDiffPulses) {
    calibValDiffPulses.textContent = (session.pulse_difference || 0).toLocaleString('pt-BR');
  }
}

function showCalibState(stateName) {
  if (calibStateIdle) calibStateIdle.classList.add('hidden');
  if (calibStateActive) calibStateActive.classList.add('hidden');
  if (calibStatePreview) calibStatePreview.classList.add('hidden');

  if (stateName === 'idle') {
    if (calibStateIdle) calibStateIdle.classList.remove('hidden');
  } else if (stateName === 'active') {
    if (calibStateActive) calibStateActive.classList.remove('hidden');
  } else if (stateName === 'preview') {
    if (calibStatePreview) calibStatePreview.classList.remove('hidden');
  }
}

function showCalibError(msg) {
  if (!calibErrorMessage) return;
  if (!msg) {
    calibErrorMessage.classList.add('hidden');
    calibErrorMessage.textContent = '';
  } else {
    calibErrorMessage.classList.remove('hidden');
    calibErrorMessage.textContent = `⚠️ ${msg}`;
  }
}

// CALIB-02 Semiautomatic Event Listeners
if (btnStartCalibration) {
  btnStartCalibration.addEventListener('click', async () => {
    btnStartCalibration.disabled = true;
    showCalibError(null);
    try {
      const devId = (headerDeviceId ? headerDeviceId.textContent.trim() : 'HIDRO-001') || 'HIDRO-001';
      const res = await adminFetch('/api/config/calibration/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: devId })
      });
      const result = await res.json();
      if (result.ok) {
        updateCalibrationSessionUI(result.calibration_session);
      } else {
        showCalibError(result.error || 'Erro ao iniciar calibração.');
      }
    } catch (err) {
      if (err.message !== 'Sessão expirada.' && err.message !== 'Você não possui permissão administrativa para esta ação.') {
        showCalibError('Erro de conexão ao iniciar calibração.');
      }
    } finally {
      btnStartCalibration.disabled = false;
    }
  });
}

if (btnCalculateCalibration && inputKnownVolume) {
  btnCalculateCalibration.addEventListener('click', async () => {
    showCalibError(null);
    const rawVal = inputKnownVolume.value;
    const volume = parseFloat(rawVal);

    if (isNaN(volume) || volume <= 0) {
      showCalibError('Por favor, informe um volume real numérico e positivo em litros.');
      return;
    }

    btnCalculateCalibration.disabled = true;
    try {
      const devId = (headerDeviceId ? headerDeviceId.textContent.trim() : 'HIDRO-001') || 'HIDRO-001';
      const res = await adminFetch('/api/config/calibration/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: devId, known_volume_liters: volume })
      });

      const result = await res.json();
      if (result.ok) {
        currentPreviewCalculation = result;
        if (prevValVolume) prevValVolume.textContent = `${result.known_volume_liters.toLocaleString('pt-BR')} L`;
        if (prevValPulses) prevValPulses.textContent = `${result.pulse_difference} pulsos`;
        if (prevValFactor) prevValFactor.textContent = `1 PULSO = ${result.calculated_liters_per_pulse.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 4 })} L`;
        if (prevValFormula) prevValFormula.textContent = `${result.known_volume_liters} L ÷ ${result.pulse_difference} pulsos = ${result.calculated_liters_per_pulse.toFixed(4)} L/pulso`;

        showCalibState('preview');
      } else {
        showCalibError(result.error || 'Erro ao calcular fator de calibração.');
      }
    } catch (err) {
      if (err.message !== 'Sessão expirada.' && err.message !== 'Você não possui permissão administrativa para esta ação.') {
        showCalibError('Erro de conexão ao calcular fator.');
      }
    } finally {
      btnCalculateCalibration.disabled = false;
    }
  });
}

if (btnConfirmCalibration) {
  btnConfirmCalibration.addEventListener('click', async () => {
    if (!currentPreviewCalculation) return;
    showCalibError(null);
    btnConfirmCalibration.disabled = true;

    try {
      const devId = (headerDeviceId ? headerDeviceId.textContent.trim() : 'HIDRO-001') || 'HIDRO-001';
      const res = await adminFetch('/api/config/calibration/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: devId,
          known_volume_liters: currentPreviewCalculation.known_volume_liters
        })
      });

      const result = await res.json();
      if (result.ok) {
        currentPreviewCalculation = null;
        if (inputKnownVolume) inputKnownVolume.value = '';
        showCalibState('idle');
        fetchLatestTelemetry();
        fetchTelemetryHistory();
      } else {
        showCalibError(result.error || 'Erro ao confirmar calibração.');
      }
    } catch (err) {
      if (err.message !== 'Sessão expirada.' && err.message !== 'Você não possui permissão administrativa para esta ação.') {
        showCalibError('Erro de conexão ao confirmar calibração.');
      }
    } finally {
      btnConfirmCalibration.disabled = false;
    }
  });
}

if (btnCancelCalibration) {
  btnCancelCalibration.addEventListener('click', async () => {
    btnCancelCalibration.disabled = true;
    showCalibError(null);
    try {
      const devId = (headerDeviceId ? headerDeviceId.textContent.trim() : 'HIDRO-001') || 'HIDRO-001';
      await adminFetch('/api/config/calibration/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: devId })
      });
      currentPreviewCalculation = null;
      if (inputKnownVolume) inputKnownVolume.value = '';
      showCalibState('idle');
      fetchCalibrationSession();
    } catch (err) {
      if (err.message !== 'Sessão expirada.' && err.message !== 'Você não possui permissão administrativa para esta ação.') {
        showCalibError('Erro ao cancelar sessão.');
      }
    } finally {
      btnCancelCalibration.disabled = false;
    }
  });
}

if (btnBackCalibration) {
  btnBackCalibration.addEventListener('click', () => {
    currentPreviewCalculation = null;
    showCalibError(null);
    fetchCalibrationSession();
  });
}

async function fetchTelemetryHistory() {
  try {
    const response = await adminFetch('/api/telemetry/history?limit=100', { cache: 'no-store' });
    fetchFlowSummary();
    fetchCalibrationSession();
    if (!response.ok) return;
    const result = await response.json();
    if (result.ok && Array.isArray(result.data)) {
      updateHistoryUI(result.data);
    }
  } catch (err) {
    console.error('Erro ao buscar histórico:', err);
  }
}

// Calibration Save Event Listener
if (btnSaveCalibration && inputLitersPerPulse) {
  btnSaveCalibration.addEventListener('click', async () => {
    const rawVal = inputLitersPerPulse.value;
    const val = parseFloat(rawVal);
    if (isNaN(val) || val <= 0) {
      alert('Por favor, informe um valor numérico positivo para o fator de calibração (litros por pulso).');
      return;
    }

    const devId = (headerDeviceId ? headerDeviceId.textContent.trim() : 'HIDRO-001') || 'HIDRO-001';

    try {
      const response = await adminFetch('/api/config/calibration', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: devId,
          liters_per_pulse: val
        })
      });

      const result = await response.json();
      if (result.ok) {
        fetchLatestTelemetry();
        fetchTelemetryHistory();
      } else {
        alert('Erro ao salvar calibração: ' + (result.error || 'Erro desconhecido'));
      }
    } catch (err) {
      if (err.message !== 'Sessão expirada.' && err.message !== 'Você não possui permissão administrativa para esta ação.') {
        console.error('Erro ao salvar calibração:', err);
        alert('Erro de conexão ao salvar calibração.');
      }
    }
  });
}

// Hard Reset (Zerar Banco de Dados e Histórico)
const btnFactoryReset = document.getElementById('btn-factory-reset');
if (btnFactoryReset) {
  btnFactoryReset.addEventListener('click', async () => {
    const confirmReset = window.confirm(
      '⚠️ ATENÇÃO: Isso apagará todo o histórico de pulsos, sessões de vazão e a telemetria gravada no servidor.\n\nOs fatores de calibração salvos serão preservados.\n\nDeseja continuar com o Hard Reset?'
    );

    if (!confirmReset) return;

    btnFactoryReset.disabled = true;
    try {
      const response = await adminFetch('/api/system/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const result = await response.json();
      if (result.ok) {
        alert('✅ Sistema resetado com sucesso! A página será recarregada.');
        window.location.reload();
      } else {
        alert('Erro ao resetar sistema: ' + (result.error || 'Erro desconhecido'));
        btnFactoryReset.disabled = false;
      }
    } catch (err) {
      if (err.message !== 'Sessão expirada.' && err.message !== 'Você não possui permissão administrativa para esta ação.') {
        console.error('Erro ao chamar /api/system/reset:', err);
        alert('Erro de conexão ao tentar resetar o sistema.');
      }
      btnFactoryReset.disabled = false;
    }
  });
}

// Accordion toggle listener para atualizar gráficos quando aberto
document.querySelectorAll('details').forEach(detail => {
  detail.addEventListener('toggle', () => {
    if (detail.open) {
      fetchTelemetryHistory();
    }
  });
});




