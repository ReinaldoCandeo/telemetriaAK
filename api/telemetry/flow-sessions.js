import { createClient } from '@supabase/supabase-js';
import { requireViewerOrAdmin } from '../_lib/auth.js';
import { getDayUtcBounds, getTodayLocalDateStr } from '../_lib/daily-summary.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const SESSION_GAP_SECONDS = 90;
const INTERRUPTION_THRESHOLD_SECONDS = 90;
const TELEMETRY_TIMEOUT_SECONDS = 60;
const PAGE_SIZE = 1000;
const MAX_PULSE_EVENTS_24H = 8000;

// ==========================================================================
// 1. LÓGICA DE SESSÕES DE FLUXO (HISTÓRICO 24H)
// ==========================================================================

export async function computeSessions(deviceId, limit = 50) {
  // 1. Buscar configuração de calibração
  const { data: devData } = await supabase
    .from('devices')
    .select('*')
    .eq('device_id', deviceId)
    .maybeSingle();

  const calib = {
    status: devData?.calibration_status || 'pending',
    liters_per_pulse: devData?.liters_per_pulse ? Number(devData.liters_per_pulse) : null
  };

  const isCalibrated = calib.status === 'calibrated' && typeof calib.liters_per_pulse === 'number' && calib.liters_per_pulse > 0;

  // 2. Buscar eventos de pulso das últimas 24h paginados com ORDER BY received_at DESC
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let allPulses = [];
  let page = 0;
  let hasMore = true;
  let isTruncated = false;

  while (hasMore && allPulses.length < MAX_PULSE_EVENTS_24H) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data: pageData, error } = await supabase
      .from('telemetry_events')
      .select('id, pulse_delta, pulse_total, received_at')
      .eq('device_id', deviceId)
      .eq('type', 'pulse')
      .gte('received_at', sinceIso)
      .order('received_at', { ascending: false })
      .range(from, to);

    if (error) {
      console.error('Erro ao buscar página de pulsos para sessões:', error);
      throw error;
    }

    if (!pageData || pageData.length === 0) {
      hasMore = false;
      break;
    }

    allPulses = allPulses.concat(pageData);

    if (pageData.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      page++;
    }
  }

  if (allPulses.length >= MAX_PULSE_EVENTS_24H) {
    isTruncated = true;
    allPulses = allPulses.slice(0, MAX_PULSE_EVENTS_24H);
  }

  const metadata = {
    window_hours: 24,
    session_gap_seconds: SESSION_GAP_SECONDS,
    truncated: isTruncated,
    pulse_events_loaded: allPulses.length
  };

  if (allPulses.length === 0) {
    return {
      sessions: [],
      summary: {
        open_session: false,
        latest_session: null,
        session_count: 0,
        total_duration_seconds: 0,
        total_pulses: 0,
        total_volume_liters: null
      },
      metadata
    };
  }

  // 3. Reordenar em memória para ordem cronológica ASC para cálculo do agrupamento
  const chronoPulses = [...allPulses].reverse();

  // 4. Agrupamento por inatividade (gap > 90s)
  const grouped = [];
  let currentGroup = [];

  for (let i = 0; i < chronoPulses.length; i++) {
    const p = chronoPulses[i];
    if (currentGroup.length === 0) {
      currentGroup.push(p);
    } else {
      const prevP = currentGroup[currentGroup.length - 1];
      const diffMs = new Date(p.received_at).getTime() - new Date(prevP.received_at).getTime();
      if (diffMs <= SESSION_GAP_SECONDS * 1000) {
        currentGroup.push(p);
      } else {
        grouped.push(currentGroup);
        currentGroup = [p];
      }
    }
  }
  if (currentGroup.length > 0) {
    grouped.push(currentGroup);
  }

  const nowMs = Date.now();

  // 5. Construção dos objetos de sessão
  const sessions = grouped.map((group, idx) => {
    const sessionId = `SESS-${String(idx + 1).padStart(3, '0')}`;
    const startedAt = group[0].received_at;
    const lastPulseAt = group[group.length - 1].received_at;
    const durationSeconds = Math.max(0, Math.round((new Date(lastPulseAt).getTime() - new Date(startedAt).getTime()) / 1000));
    const pulseEvents = group.length;
    const pulseCount = group.reduce((acc, p) => acc + (p.pulse_delta || 1), 0);
    const volumeLiters = isCalibrated ? Number((pulseCount * calib.liters_per_pulse).toFixed(1)) : null;

    // Cálculo das amostras de vazão válidas dentro da sessão
    const validFlows = [];
    for (let j = 0; j < group.length - 1; j++) {
      const pa = group[j];
      const pb = group[j + 1];
      if (pa.pulse_delta === 1 && pb.pulse_delta === 1 && pa.received_at && pb.received_at) {
        const dt = (new Date(pb.received_at).getTime() - new Date(pa.received_at).getTime()) / 1000;
        if (dt > 0 && isCalibrated) {
          const flow = (calib.liters_per_pulse / dt) * 60;
          if (Number.isFinite(flow) && flow > 0) {
            validFlows.push(flow);
          }
        }
      }
    }

    const averageFlowLpm = validFlows.length > 0
      ? Number((validFlows.reduce((acc, val) => acc + val, 0) / validFlows.length).toFixed(1))
      : null;

    const maxFlowLpm = validFlows.length > 0
      ? Number(Math.max(...validFlows).toFixed(1))
      : null;

    const isLastSession = idx === grouped.length - 1;
    const diffFromNowSec = (nowMs - new Date(lastPulseAt).getTime()) / 1000;
    const isOpen = isLastSession && diffFromNowSec <= SESSION_GAP_SECONDS;

    return {
      session_id: sessionId,
      started_at: startedAt,
      last_pulse_at: lastPulseAt,
      duration_seconds: durationSeconds,
      pulse_events: pulseEvents,
      pulse_count: pulseCount,
      volume_liters: volumeLiters,
      average_flow_lpm: averageFlowLpm,
      max_flow_lpm: maxFlowLpm,
      status: isOpen ? 'open' : 'closed'
    };
  });

  const latestSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  const hasOpen = latestSession ? latestSession.status === 'open' : false;

  const summary = {
    open_session: hasOpen,
    latest_session: latestSession,
    session_count: sessions.length,
    total_duration_seconds: sessions.reduce((acc, s) => acc + s.duration_seconds, 0),
    total_pulses: sessions.reduce((acc, s) => acc + s.pulse_count, 0),
    total_volume_liters: isCalibrated ? Number((sessions.reduce((acc, s) => acc + (s.volume_liters || 0), 0)).toFixed(1)) : null
  };

  return {
    sessions,
    summary,
    metadata
  };
}

// ==========================================================================
// 2. LÓGICA DE DIAGNÓSTICO DE INTERRUPÇÕES (HOJE / AMERICA/SAO_PAULO)
// ==========================================================================

async function fetchAllEventsInRange(deviceId, startIso, endIso, types = null) {
  let allEvents = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from('telemetry_events')
      .select('id, type, pulse_delta, pulse_total, received_at')
      .eq('device_id', deviceId)
      .gte('received_at', startIso)
      .lte('received_at', endIso)
      .order('received_at', { ascending: true })
      .range(from, to);

    if (types && Array.isArray(types) && types.length > 0) {
      query = query.in('type', types);
    }

    const { data: pageData, error } = await query;

    if (error) {
      console.error(`[INTERRUPTIONS] Erro na paginação (página ${page}):`, error);
      throw error;
    }

    if (!pageData || pageData.length === 0) {
      hasMore = false;
      break;
    }

    allEvents = allEvents.concat(pageData);

    if (pageData.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      page++;
    }
  }

  return allEvents;
}

async function classifyGapWindow(deviceId, startIso, endIso, isOpen = false) {
  const eventsInGap = await fetchAllEventsInRange(deviceId, startIso, endIso);

  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const durationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));

  // Prioridade 1: Reinício detectado
  const hasCounterReset = eventsInGap.some(e => e.type === 'counter_reset');
  if (hasCounterReset) {
    return {
      classification: 'counter_reset',
      label: 'REINÍCIO DETECTADO',
      description: 'O contador do dispositivo reiniciou durante esta janela. Verifique alimentação ou reinicialização do equipamento.',
      badge_class: 'badge-blue',
      events_count: eventsInGap.length
    };
  }

  // Prioridade 2 & 3: Análise de continuidade de telemetria
  if (eventsInGap.length === 0) {
    if (durationSeconds >= TELEMETRY_TIMEOUT_SECONDS) {
      return {
        classification: 'telemetry_unavailable',
        label: 'TELEMETRIA INDISPONÍVEL',
        description: 'O dispositivo também deixou de transmitir durante este período. Não é possível concluir pela telemetria se houve ou não passagem de água.',
        badge_class: 'badge-coral',
        events_count: 0
      };
    }
  } else {
    let maxSubGapSec = 0;

    // Gap do início da janela até o primeiro evento
    const firstEventMs = new Date(eventsInGap[0].received_at).getTime();
    const leadingGapSec = Math.round((firstEventMs - startMs) / 1000);
    if (leadingGapSec > maxSubGapSec) maxSubGapSec = leadingGapSec;

    // Gaps entre eventos consecutivos
    for (let i = 0; i < eventsInGap.length - 1; i++) {
      const t1 = new Date(eventsInGap[i].received_at).getTime();
      const t2 = new Date(eventsInGap[i + 1].received_at).getTime();
      const subGap = Math.round((t2 - t1) / 1000);
      if (subGap > maxSubGapSec) maxSubGapSec = subGap;
    }

    // Gap do último evento até o fim da janela
    const lastEventMs = new Date(eventsInGap[eventsInGap.length - 1].received_at).getTime();
    const trailingGapSec = Math.round((endMs - lastEventMs) / 1000);
    if (trailingGapSec > maxSubGapSec) maxSubGapSec = trailingGapSec;

    if (maxSubGapSec >= TELEMETRY_TIMEOUT_SECONDS) {
      return {
        classification: 'telemetry_unavailable',
        label: 'TELEMETRIA INDISPONÍVEL',
        description: 'O dispositivo também deixou de transmitir durante parte deste período. Não é possível concluir pela telemetria se houve ou não passagem de água.',
        badge_class: 'badge-coral',
        events_count: eventsInGap.length,
        max_telemetry_gap_seconds: maxSubGapSec
      };
    }
  }

  // Prioridade 3: Telemetria permaneceu ativa
  return {
    classification: 'telemetry_active',
    label: 'SEM PULSO • TELEMETRIA ATIVA',
    description: 'O ESP permaneceu comunicando durante este período. A ausência de pulsos pode representar interrupção real do fluxo ou ausência de acionamento do sensor/hidrômetro.',
    badge_class: 'badge-amber',
    events_count: eventsInGap.length
  };
}

export async function computeInterruptions(deviceId, targetDateStr = null) {
  const todayStr = targetDateStr || getTodayLocalDateStr();
  const { startUtc, endUtc } = getDayUtcBounds(todayStr);
  const nowIso = new Date().toISOString();
  const effectiveNowIso = nowIso < endUtc ? nowIso : endUtc;

  // 1. Buscar todos os eventos do dia de hoje com paginação completa
  let allDayEvents = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data: pageRows, error: pageErr } = await supabase
      .from('telemetry_events')
      .select('id, type, pulse_delta, pulse_total, received_at')
      .eq('device_id', deviceId)
      .gte('received_at', startUtc)
      .lte('received_at', effectiveNowIso)
      .order('received_at', { ascending: true })
      .range(from, to);

    if (pageErr) {
      console.error('[INTERRUPTIONS] Erro ao buscar eventos do dia:', pageErr);
      throw pageErr;
    }

    if (!pageRows || pageRows.length === 0) {
      hasMore = false;
      break;
    }

    allDayEvents = allDayEvents.concat(pageRows);

    if (pageRows.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      page++;
    }
  }

  // Filtrar pulsos reais
  const pulseEvents = allDayEvents.filter(e => e.type === 'pulse' || (typeof e.pulse_delta === 'number' && e.pulse_delta > 0));

  // Se não houver pulsos registrados hoje
  if (pulseEvents.length === 0) {
    const { count: historicalPulsesCount } = await supabase
      .from('telemetry_events')
      .select('id', { count: 'exact', head: true })
      .eq('device_id', deviceId)
      .eq('type', 'pulse');

    const hadHistoricalPulses = (typeof historicalPulsesCount === 'number' && historicalPulsesCount > 0);
    const hadHeartbeatsToday = allDayEvents.some(e => e.type === 'heartbeat');

    const stateReason = !hadHistoricalPulses ? 'no_pulse_history' : 'no_pulses_today';
    const message = !hadHistoricalPulses
      ? 'Sem histórico de pulsos suficiente para análise.'
      : (hadHeartbeatsToday
          ? 'Dispositivo comunicando hoje, porém sem registro de pulsos no período.'
          : 'Sem pulsos suficientes hoje para determinar interrupções.');

    return {
      ok: true,
      device_id: deviceId,
      date: todayStr,
      timezone: 'America/Sao_Paulo',
      threshold_seconds: INTERRUPTION_THRESHOLD_SECONDS,
      telemetry_timeout_seconds: TELEMETRY_TIMEOUT_SECONDS,
      summary: {
        interruptions_today: 0,
        longest_gap_seconds: 0,
        current_gap_seconds: 0,
        current_state: stateReason,
        message: message
      },
      latest_interruption: null,
      interruptions: []
    };
  }

  // 2. Identificar janelas de interrupção (gaps > 90s)
  const interruptions = [];
  let longestGapSeconds = 0;

  for (let i = 0; i < pulseEvents.length - 1; i++) {
    const pPrev = pulseEvents[i];
    const pNext = pulseEvents[i + 1];

    const prevMs = new Date(pPrev.received_at).getTime();
    const nextMs = new Date(pNext.received_at).getTime();
    const gapSec = Math.round((nextMs - prevMs) / 1000);

    if (gapSec > INTERRUPTION_THRESHOLD_SECONDS) {
      if (gapSec > longestGapSeconds) longestGapSeconds = gapSec;

      const classification = await classifyGapWindow(deviceId, pPrev.received_at, pNext.received_at, false);

      interruptions.push({
        id: `int_${pPrev.id}_${pNext.id}`,
        status: 'closed',
        start_at: pPrev.received_at,
        end_at: pNext.received_at,
        duration_seconds: gapSec,
        ...classification
      });
    }
  }

  // Gap em andamento (após o último pulso até o momento atual)
  const lastPulse = pulseEvents[pulseEvents.length - 1];
  const lastPulseMs = new Date(lastPulse.received_at).getTime();
  const nowMs = new Date(effectiveNowIso).getTime();
  const currentGapSeconds = Math.max(0, Math.round((nowMs - lastPulseMs) / 1000));

  let currentState = 'flow_active';

  if (currentGapSeconds > INTERRUPTION_THRESHOLD_SECONDS) {
    currentState = 'interrupted';
    if (currentGapSeconds > longestGapSeconds) longestGapSeconds = currentGapSeconds;

    const classification = await classifyGapWindow(deviceId, lastPulse.received_at, effectiveNowIso, true);

    interruptions.push({
      id: `int_open_${lastPulse.id}`,
      status: 'open',
      start_at: lastPulse.received_at,
      end_at: null,
      duration_seconds: currentGapSeconds,
      ...classification
    });
  }

  const sortedInterruptions = [...interruptions].reverse();
  const latestInterruption = sortedInterruptions.length > 0 ? sortedInterruptions[0] : null;
  const recent5 = sortedInterruptions.slice(0, 5);

  return {
    ok: true,
    device_id: deviceId,
    date: todayStr,
    timezone: 'America/Sao_Paulo',
    threshold_seconds: INTERRUPTION_THRESHOLD_SECONDS,
    telemetry_timeout_seconds: TELEMETRY_TIMEOUT_SECONDS,
    summary: {
      interruptions_today: interruptions.length,
      longest_gap_seconds: longestGapSeconds,
      current_gap_seconds: currentGapSeconds,
      current_state: currentState,
      first_pulse_today_at: pulseEvents[0].received_at,
      last_pulse_today_at: lastPulse.received_at
    },
    latest_interruption: latestInterruption,
    interruptions: recent5
  };
}

// ==========================================================================
// 3. HANDLER PRINCIPAL
// ==========================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  // Validação de autenticação: somente VIEWER ou ADMIN
  const auth = await requireViewerOrAdmin(req, res);
  if (!auth) return;

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const rawDeviceId = url.searchParams.get('device_id');
    const deviceId = typeof rawDeviceId === 'string' ? rawDeviceId.trim() : '';

    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id é obrigatório' });
    }

    const rawMode = url.searchParams.get('mode');
    const mode = typeof rawMode === 'string' ? rawMode.trim() : null;

    // Se mode foi informado
    if (mode !== null && mode !== '') {
      if (mode === 'interruptions') {
        const result = await computeInterruptions(deviceId);
        return res.status(200).json(result);
      } else {
        return res.status(400).json({ ok: false, error: 'mode inválido' });
      }
    }

    // Comportamento normal histórico (flow-sessions)
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

    const { sessions, summary, metadata } = await computeSessions(deviceId, limit);

    // Rota auxiliar caso /summary seja roteada para este handler
    if (url.pathname.endsWith('/summary')) {
      return res.status(200).json({ ok: true, ...summary, metadata });
    }

    // Retornar sessões em ordem cronológica decrescente (mais recente primeiro)
    const reversed = [...sessions].reverse().slice(0, limit);

    return res.status(200).json({
      ok: true,
      data: reversed,
      summary: summary,
      metadata: metadata
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/flow-sessions:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao consultar sessões de fluxo' });
  }
}
