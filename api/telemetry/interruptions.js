import { createClient } from '@supabase/supabase-js';
import { requireViewerOrAdmin } from '../_lib/auth.js';
import { getDayUtcBounds, getTodayLocalDateStr } from '../_lib/daily-summary.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const INTERRUPTION_THRESHOLD_SECONDS = 90;
const TELEMETRY_TIMEOUT_SECONDS = 60;
const PAGE_SIZE = 1000;

/**
 * Consulta eventos com paginação completa usando range() para garantir que
 * grandes volumes (ex: >1000 heartbeats) não sofram truncamento silencioso.
 */
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

/**
 * Classifica uma janela de gap (>90s) correlacionando com a telemetria do dispositivo.
 */
async function classifyGapWindow(deviceId, startIso, endIso, isOpen = false) {
  // Buscar todos os eventos (heartbeat, counter_reset, pulse) que ocorreram dentro da janela
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
    // Nenhum evento de telemetria durante o gap
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
    // Verificar se houve qualquer intervalo >= TELEMETRY_TIMEOUT_SECONDS
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
  // Eventos de pulso: type === 'pulse' ou pulse_delta > 0
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
    // Verificar se o dispositivo já teve pulsos no histórico geral
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

  // Gaps fechados entre pulsos consecutivos do dia (a partir do primeiro pulso)
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

  // Ordenar interrupções da mais recente para a mais antiga
  const sortedInterruptions = [...interruptions].reverse();
  const latestInterruption = sortedInterruptions.length > 0 ? sortedInterruptions[0] : null;

  // Retornar as últimas 5 interrupções para o frontend
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  const auth = await requireViewerOrAdmin(req, res);
  if (!auth) return;

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const rawDeviceId = url.searchParams.get('device_id');
    const deviceId = typeof rawDeviceId === 'string' ? rawDeviceId.trim() : '';

    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id é obrigatório' });
    }

    const result = await computeInterruptions(deviceId);
    return res.status(200).json(result);

  } catch (err) {
    console.error('Erro no GET /api/telemetry/interruptions:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao diagnosticar interrupções' });
  }
}
