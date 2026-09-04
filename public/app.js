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

let systemTotalsCache = null;

async function fetchSystemSummary() {
  try {
    const response = await fetch('/api/telemetry/system-summary', { cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (result.ok) {
      systemTotalsCache = result;
    }
  } catch (err) {
    console.error('Erro ao buscar acumulado do sistema:', err);
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
    valLitersTotal.innerHTML = `${calcLiters.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} <span class="unit">L</span>`;
    if (valLitersSub) {
      valLitersSub.textContent = `Volume acumulado no sistema (persiste após reinício) • ${sysPulseTotal.toLocaleString('pt-BR')} pulsos acumulados`;
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
      fetch('/api/telemetry/latest', { cache: 'no-store' }),
      fetch('/api/telemetry/system-summary', { cache: 'no-store' })
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
    console.error('Erro ao buscar dados:', err);
  }
}

// Initial fetch and poll every 1s for telemetry, 2s for history, 15s for flow sessions, 60s for 24h chart
fetchLatestTelemetry();
fetchTelemetryHistory();
fetchFlowSessions();
fetchFlowChart24h();

setInterval(fetchLatestTelemetry, 1000);
setInterval(fetchTelemetryHistory, 2000);
setInterval(fetchFlowSessions, 15000);
setInterval(fetchFlowChart24h, 60000);

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

// Update relative time text every second
setInterval(updateRelativeTimeDisplay, 1000);

async function fetchFlowSummary() {
  try {
    const response = await fetch('/api/telemetry/flow-summary', { cache: 'no-store' });
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

    // Last Pulse Card
    if (last_pulse_at) {
      const d = new Date(last_pulse_at);
      if (valLastPulseTime) valLastPulseTime.textContent = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      if (valLastPulseDate) valLastPulseDate.textContent = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      if (valLastPulseRelative) valLastPulseRelative.textContent = formatRelativeTime(last_pulse_at);
    } else {
      if (valLastPulseTime) valLastPulseTime.textContent = '--:--:--';
      if (valLastPulseDate) valLastPulseDate.textContent = '--/--/----';
      if (valLastPulseRelative) valLastPulseRelative.textContent = 'Nenhum pulso registrado';
    }
  } catch (err) {
    console.error('Erro ao buscar resumo de vazão:', err);
  }
}

async function fetchFlowChart24h() {
  try {
    const response = await fetch('/api/telemetry/flow-chart-24h', { cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (!result.ok) return;
    renderFlowChart(result.data || []);
  } catch (err) {
    console.error('Erro ao buscar dados do gráfico de 24h:', err);
  }
}

// Render SVG Chart 3: VAZÃO AO LONGO DO TEMPO (24 HORAS)
function renderFlowChart(chartBuckets) {
  if (!chartFlowSvg || !chartFlowEmpty) return;

  if (!Array.isArray(chartBuckets) || chartBuckets.length === 0) {
    chartFlowEmpty.classList.remove('hidden');
    chartFlowSvg.classList.add('hidden');
    return;
  }

  chartFlowEmpty.classList.add('hidden');
  chartFlowSvg.classList.remove('hidden');

  const width = 500;
  const height = 180;
  const padX = 45;
  const padY = 30;
  const bottomY = height - padY;

  // Obter maior vazão válida para definir escala do eixo Y
  const flowVals = chartBuckets
    .filter(b => typeof b.flow_lpm === 'number' && b.flow_lpm > 0)
    .map(b => b.flow_lpm);

  const maxVal = flowVals.length > 0 ? Math.max(Math.ceil(Math.max(...flowVals) * 1.15), 10) : 300;
  const minVal = 0;
  const valRange = maxVal - minVal || 1;

  const total = chartBuckets.length;

  const points = chartBuckets.map((b, idx) => {
    const x = total > 1
      ? padX + (idx / (total - 1)) * (width - 2 * padX)
      : width / 2;

    let y = null;
    if (typeof b.flow_lpm === 'number') {
      y = bottomY - ((b.flow_lpm - minVal) / valRange) * (height - 2 * padY);
    }

    const recDate = b.timestamp ? new Date(b.timestamp) : null;
    const timeLabel = recDate
      ? recDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
      : '';

    return { ...b, x, y, timeLabel };
  });

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
      pathD = `M ${(seg[0].x - 2).toFixed(1)} ${seg[0].y.toFixed(1)} L ${(seg[0].x + 2).toFixed(1)} ${seg[0].y.toFixed(1)}`;
      areaD = `M ${(seg[0].x - 2).toFixed(1)} ${bottomY} L ${(seg[0].x - 2).toFixed(1)} ${seg[0].y.toFixed(1)} L ${(seg[0].x + 2).toFixed(1)} ${seg[0].y.toFixed(1)} L ${(seg[0].x + 2).toFixed(1)} ${bottomY} Z`;
    } else {
      pathD = seg.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      areaD = `${pathD} L ${seg[seg.length - 1].x.toFixed(1)} ${bottomY} L ${seg[0].x.toFixed(1)} ${bottomY} Z`;
    }
    pathsSvg += `
      <path d="${areaD}" fill="url(#flowAreaGrad)"/>
      <path d="${pathD}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  });

  const gridY1 = bottomY;
  const gridY2 = bottomY - (height - 2 * padY) / 2;
  const gridY3 = padY;

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
      const offsetTextX = pt.x;
      
      xGridAndLabels += `
        <line x1="${pt.x.toFixed(1)}" y1="${gridY3}" x2="${pt.x.toFixed(1)}" y2="${bottomY}" stroke="rgba(255,255,255,0.04)" stroke-dasharray="2,4"/>
        <text x="${offsetTextX.toFixed(1)}" y="${height - 8}" fill="#64748b" font-size="9" text-anchor="${anchor}" font-family="JetBrains Mono">${pt.timeLabel || '--'}</text>
      `;
    }
  });

  let svgContent = `
    <defs>
      <linearGradient id="flowAreaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="#06b6d4" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    <line x1="${padX}" y1="${gridY1}" x2="${width - padX}" y2="${gridY1}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4,4"/>
    <line x1="${padX}" y1="${gridY2}" x2="${width - padX}" y2="${gridY2}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4,4"/>
    <line x1="${padX}" y1="${gridY3}" x2="${width - padX}" y2="${gridY3}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="4,4"/>
    
    <text x="${padX - 8}" y="${gridY3 + 4}" fill="#64748b" font-size="10" text-anchor="end" font-family="JetBrains Mono">${maxVal.toFixed(0)} L/m</text>
    <text x="${padX - 8}" y="${gridY1 + 4}" fill="#64748b" font-size="10" text-anchor="end" font-family="JetBrains Mono">0 L/m</text>

    ${xGridAndLabels}
    ${pathsSvg}
  `;

  // Renderizar marcadores e títulos de tooltip
  points.forEach((pt) => {
    if (pt.status === 'flow') {
      svgContent += `
        <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="2" fill="#38bdf8" stroke="#090d16" stroke-width="1">
          <title>Horário: ${pt.timeLabel}\nVazão Média: ${pt.flow_lpm} L/min\nPico: ${pt.max_flow_lpm || pt.flow_lpm} L/min\nVolume: ${pt.volume_liters} L\nPulsos: ${pt.pulse_count}</title>
        </circle>
      `;
    } else if (pt.status === 'insufficient_data') {
      svgContent += `
        <circle cx="${pt.x.toFixed(1)}" cy="${bottomY}" r="2" fill="#f59e0b" opacity="0.7">
          <title>Horário: ${pt.timeLabel}\nDADOS INSUFICIENTES\nVolume: ${pt.volume_liters} L\nPulsos: ${pt.pulse_count}</title>
        </circle>
      `;
    } else {
      svgContent += `
        <circle cx="${pt.x.toFixed(1)}" cy="${bottomY}" r="3" fill="transparent">
          <title>Horário: ${pt.timeLabel}\nSEM PASSAGEM (0 L/min)\nVolume: 0 L</title>
        </circle>
      `;
    }
  });

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
    } else {
      if (valSessionSub) valSessionSub.textContent = 'Nenhuma passagem de água registrada até o momento.';
      if (valSessionBadge) valSessionBadge.textContent = 'Sem Dados';
      if (sessValStarted) sessValStarted.textContent = '--:--:--';
      if (sessValLastPulse) sessValLastPulse.textContent = '--:--:--';
      if (sessValDuration) sessValDuration.textContent = '--';
      if (sessValPulses) sessValPulses.textContent = '0';
      if (sessValVolume) sessValVolume.textContent = '--';
      if (sessValAvgFlow) sessValAvgFlow.textContent = '--';
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
    const response = await fetch('/api/telemetry/flow-sessions?limit=50', { cache: 'no-store' });
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
    const response = await fetch('/api/config/calibration/session', { cache: 'no-store' });
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
      const res = await fetch('/api/config/calibration/start', {
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
      showCalibError('Erro de conexão ao iniciar calibração.');
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
      const res = await fetch('/api/config/calibration/calculate', {
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
      showCalibError('Erro de conexão ao calcular fator.');
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
      const res = await fetch('/api/config/calibration/finish', {
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
      showCalibError('Erro de conexão ao confirmar calibração.');
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
      await fetch('/api/config/calibration/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: devId })
      });
      currentPreviewCalculation = null;
      if (inputKnownVolume) inputKnownVolume.value = '';
      showCalibState('idle');
      fetchCalibrationSession();
    } catch (err) {
      showCalibError('Erro ao cancelar sessão.');
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
    const response = await fetch('/api/telemetry/history?limit=100', { cache: 'no-store' });
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
      const response = await fetch('/api/config/calibration', {
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
      console.error('Erro ao salvar calibração:', err);
      alert('Erro de conexão ao salvar calibração.');
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
      const response = await fetch('/api/system/reset', {
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
      console.error('Erro ao chamar /api/system/reset:', err);
      alert('Erro de conexão ao tentar resetar o sistema.');
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




