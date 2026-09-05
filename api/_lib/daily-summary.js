import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const moduleClient = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

function getSupabaseClient() {
  if (moduleClient) return moduleClient;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const PAGE_SIZE = 1000;

/**
 * Retorna os limites UTC (startUtc e endUtc) para um dia civil (YYYY-MM-DD) no fuso America/Sao_Paulo.
 * Garante que a janela contemple 00:00:00.000 até 23:59:59.999 no horário local de Palmital/SP.
 */
export function getDayUtcBounds(localDateStr) {
  const [year, month, day] = localDateStr.split('-').map(Number);
  
  // Criar data de referência ao meio-dia para calcular o offset dinâmico de America/Sao_Paulo
  const testDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const spString = testDate.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', timeZoneName: 'shortOffset' });
  
  let offsetHours = 3; // Padrão BRT (UTC-3)
  if (spString.includes('GMT-2')) offsetHours = 2; // Horário de verão se aplicável

  const startUtc = new Date(Date.UTC(year, month - 1, day, offsetHours, 0, 0, 0)).toISOString();
  const nextDayDate = new Date(Date.UTC(year, month - 1, day + 1, offsetHours, 0, 0, 0) - 1);
  const endUtc = nextDayDate.toISOString();

  return { startUtc, endUtc };
}

/**
 * Retorna a data civil atual (YYYY-MM-DD) em America/Sao_Paulo.
 */
export function getTodayLocalDateStr() {
  const d = new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/**
 * Retorna a data civil de ontem (YYYY-MM-DD) em America/Sao_Paulo.
 */
export function getYesterdayLocalDateStr() {
  const [tYear, tMonth, tDay] = getTodayLocalDateStr().split('-').map(Number);
  const yesterdayDate = new Date(Date.UTC(tYear, tMonth - 1, tDay) - 86400000);
  const yyyy = yesterdayDate.getUTCFullYear();
  const mm = String(yesterdayDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(yesterdayDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Verifica se existem eventos de heartbeat para o dispositivo na janela de tempo especificada.
 */
export async function hasDeviceHeartbeats(deviceId, startUtc, endUtc) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('telemetry_events')
    .select('id')
    .eq('device_id', deviceId)
    .eq('type', 'heartbeat')
    .gte('received_at', startUtc)
    .lte('received_at', endUtc)
    .limit(1);

  if (error || !data) return false;
  return data.length > 0;
}

/**
 * Calcula o resumo diário de telemetria a partir de telemetry_events com paginação completa.
 * @param {string} deviceId
 * @param {string} localDateStr (YYYY-MM-DD)
 */
export async function calculateDailySummary(deviceId, localDateStr) {
  const { startUtc, endUtc } = getDayUtcBounds(localDateStr);
  const todayStr = getTodayLocalDateStr();
  const supabase = getSupabaseClient();

  // 1. Obter fator de calibração oficial do dispositivo
  const { data: devData } = await supabase
    .from('devices')
    .select('liters_per_pulse, calibration_status')
    .eq('device_id', deviceId)
    .maybeSingle();

  const litersPerPulse = (devData?.calibration_status === 'calibrated' && typeof devData?.liters_per_pulse === 'number')
    ? devData.liters_per_pulse
    : 101.63;

  // 2. Paginar todos os eventos pulse daquele dia (sem teto silencioso)
  let page = 0;
  let hasMore = true;
  let allRows = [];

  while (hasMore) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data: rows, error } = await supabase
      .from('telemetry_events')
      .select('id, pulse_delta, pulse_total, received_at')
      .eq('device_id', deviceId)
      .eq('type', 'pulse')
      .gte('received_at', startUtc)
      .lte('received_at', endUtc)
      .order('received_at', { ascending: true })
      .range(from, to);

    if (error) {
      throw new Error(`Erro ao consultar telemetry_events página ${page}: ${error.message}`);
    }

    if (!rows || rows.length === 0) {
      hasMore = false;
      break;
    }

    allRows = allRows.concat(rows);

    if (rows.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      page++;
    }
  }

  const isPartial = localDateStr === '2026-09-04';

  // Se não houver eventos pulse no dia
  if (allRows.length === 0) {
    // Verificar se houve comunicação/heartbeat comprovando telemetria ativa sem pulsos
    const hadHeartbeats = await hasDeviceHeartbeats(deviceId, startUtc, endUtc);

    if (hadHeartbeats) {
      let status = 'FECHADO';
      if (localDateStr === todayStr) {
        status = 'EM_ANDAMENTO';
      } else if (isPartial) {
        status = 'PARCIAL';
      }

      return {
        device_id: deviceId,
        local_date: localDateStr,
        pulse_count: 0,
        pulse_events: 0,
        volume_liters: 0,
        volume_m3: 0,
        average_flow_lpm: null,
        max_flow_lpm: null,
        flow_duration_seconds: 0,
        first_pulse_at: null,
        last_pulse_at: null,
        is_partial: isPartial,
        status: status,
        has_telemetry: true
      };
    }

    // Sem pulsos e sem heartbeats: sem registro de telemetria
    return {
      device_id: deviceId,
      local_date: localDateStr,
      pulse_count: null,
      pulse_events: null,
      volume_liters: null,
      volume_m3: null,
      average_flow_lpm: null,
      max_flow_lpm: null,
      flow_duration_seconds: null,
      first_pulse_at: null,
      last_pulse_at: null,
      is_partial: isPartial,
      status: 'SEM_REGISTRO',
      has_telemetry: false
    };
  }

  // 3. Cálculos agregados
  let sumPulses = 0;
  for (let i = 0; i < allRows.length; i++) {
    const d = Number(allRows[i].pulse_delta);
    sumPulses += (!isNaN(d) && d > 0) ? d : 1;
  }

  const pulseEventsCount = allRows.length;
  const volumeLiters = Number((sumPulses * litersPerPulse).toFixed(2));
  const volumeM3 = Number((volumeLiters / 1000).toFixed(3));
  const firstPulseAt = allRows[0].received_at;
  const lastPulseAt = allRows[allRows.length - 1].received_at;

  // 4. Vazão Média, Pico e Duração de Passagem
  const validFlowSamples = [];
  let flowDurationSec = 0;

  for (let i = 0; i < allRows.length - 1; i++) {
    const curr = allRows[i];
    const next = allRows[i + 1];

    if (curr.pulse_delta === 1 && next.pulse_delta === 1 && curr.received_at && next.received_at) {
      const tCurr = new Date(curr.received_at).getTime();
      const tNext = new Date(next.received_at).getTime();
      const dtSec = (tNext - tCurr) / 1000;

      // Se o intervalo for positivo e até 90s (limiar de sessão de fluxo)
      if (dtSec > 0 && dtSec <= 90) {
        const flowLpm = (litersPerPulse / dtSec) * 60;
        if (Number.isFinite(flowLpm) && flowLpm > 0) {
          validFlowSamples.push(flowLpm);
          flowDurationSec += dtSec;
        }
      }
    }
  }

  const samplesCount = validFlowSamples.length;
  let maxFlow = 0;
  let sumFlow = 0;
  for (let s = 0; s < samplesCount; s++) {
    const val = validFlowSamples[s];
    sumFlow += val;
    if (val > maxFlow) maxFlow = val;
  }

  const averageFlowLpm = samplesCount > 0
    ? Number((sumFlow / samplesCount).toFixed(2))
    : null;
  const maxFlowLpm = samplesCount > 0
    ? Number(maxFlow.toFixed(2))
    : null;

  // 5. Determinação de Status
  let status = 'FECHADO';
  if (localDateStr === todayStr) {
    status = 'EM_ANDAMENTO';
  } else if (isPartial) {
    status = 'PARCIAL';
  }

  return {
    device_id: deviceId,
    local_date: localDateStr,
    pulse_count: sumPulses,
    pulse_events: pulseEventsCount,
    volume_liters: volumeLiters,
    volume_m3: volumeM3,
    average_flow_lpm: averageFlowLpm,
    max_flow_lpm: maxFlowLpm,
    flow_duration_seconds: Math.round(flowDurationSec),
    first_pulse_at: firstPulseAt,
    last_pulse_at: lastPulseAt,
    is_partial: isPartial,
    status: status,
    has_telemetry: true
  };
}

/**
 * Consolida e persiste um dia encerrado via UPSERT idempotente em daily_telemetry_summary.
 * Nunca fecha o dia corrente ("Hoje") ou datas futuras.
 * @param {string} deviceId
 * @param {string} targetDateStr (YYYY-MM-DD)
 */
export async function finalizeDailySummary(deviceId, targetDateStr) {
  const todayStr = getTodayLocalDateStr();

  // Proteção: Nunca fechar a data atual ou datas futuras
  if (targetDateStr >= todayStr) {
    return {
      ok: false,
      skipped: true,
      reason: `Data ${targetDateStr} é a data atual ou futura em America/Sao_Paulo (hoje: ${todayStr}). Não pode ser fechada.`
    };
  }

  const summary = await calculateDailySummary(deviceId, targetDateStr);

  // Se não houve qualquer telemetria, não inventar linha fechada com zero
  if (summary.status === 'SEM_REGISTRO') {
    return {
      ok: true,
      persisted: false,
      reason: `Data ${targetDateStr} não possui telemetria registrada.`
    };
  }

  const nowIso = new Date().toISOString();
  const supabase = getSupabaseClient();

  const payload = {
    device_id: deviceId,
    local_date: targetDateStr,
    pulse_count: summary.pulse_count,
    pulse_events: summary.pulse_events,
    volume_liters: summary.volume_liters,
    average_flow_lpm: summary.average_flow_lpm,
    max_flow_lpm: summary.max_flow_lpm,
    flow_duration_seconds: summary.flow_duration_seconds,
    first_pulse_at: summary.first_pulse_at,
    last_pulse_at: summary.last_pulse_at,
    is_partial: summary.is_partial,
    status: summary.status,
    finalized_at: nowIso,
    updated_at: nowIso
  };

  const { data, error } = await supabase
    .from('daily_telemetry_summary')
    .upsert(payload, { onConflict: 'device_id,local_date' })
    .select()
    .single();

  if (error) {
    throw new Error(`Erro ao persistir daily_telemetry_summary para ${targetDateStr}: ${error.message}`);
  }

  return {
    ok: true,
    persisted: true,
    data: data
  };
}

/**
 * Recupera e fecha automaticamente todos os dias anteriores que ainda não estejam persistidos.
 * Escopo: desde a primeira data com telemetria até ontem (inclusive).
 * @param {string} deviceId
 */
export async function autoRecoverPastDays(deviceId) {
  const todayStr = getTodayLocalDateStr();
  const yesterdayStr = getYesterdayLocalDateStr();
  const supabase = getSupabaseClient();

  // 1. Obter a primeira data com telemetria para o dispositivo
  const { data: firstEv, error: evError } = await supabase
    .from('telemetry_events')
    .select('received_at')
    .eq('device_id', deviceId)
    .order('received_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (evError || !firstEv) {
    return { ok: true, processed: [], message: 'Nenhum evento histórico encontrado.' };
  }

  const firstDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(firstEv.received_at));

  // 2. Buscar datas já persistidas em daily_telemetry_summary
  const { data: existingRows } = await supabase
    .from('daily_telemetry_summary')
    .select('local_date')
    .eq('device_id', deviceId)
    .gte('local_date', firstDateStr)
    .lte('local_date', yesterdayStr);

  const existingSet = new Set((existingRows || []).map(r => r.local_date));

  // 3. Identificar datas faltantes entre firstDateStr e yesterdayStr
  const missingDates = [];
  const [fYear, fMonth, fDay] = firstDateStr.split('-').map(Number);
  const [yYear, yMonth, yDay] = yesterdayStr.split('-').map(Number);

  let curDate = new Date(Date.UTC(fYear, fMonth - 1, fDay));
  const endDate = new Date(Date.UTC(yYear, yMonth - 1, yDay));

  while (curDate <= endDate) {
    const yyyy = curDate.getUTCFullYear();
    const mm = String(curDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(curDate.getUTCDate()).padStart(2, '0');
    const dStr = `${yyyy}-${mm}-${dd}`;

    if (!existingSet.has(dStr)) {
      missingDates.push(dStr);
    }

    curDate = new Date(curDate.getTime() + 86400000);
  }

  // 4. Executar consolidação para cada dia faltante
  const results = [];
  for (const dateStr of missingDates) {
    try {
      const res = await finalizeDailySummary(deviceId, dateStr);
      results.push({ date: dateStr, ...res });
    } catch (err) {
      results.push({ date: dateStr, ok: false, error: err.message });
    }
  }

  return {
    ok: true,
    first_date: firstDateStr,
    yesterday: yesterdayStr,
    missing_dates_found: missingDates.length,
    processed: results
  };
}
