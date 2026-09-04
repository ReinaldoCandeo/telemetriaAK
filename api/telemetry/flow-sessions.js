import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const SESSION_GAP_SECONDS = 90;
const PAGE_SIZE = 1000;
const MAX_PULSE_EVENTS_24H = 8000;

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
  // Nota: session_id é um identificador visual calculado na janela atual; não é chave persistente.
  const sessions = grouped.map((group, idx) => {
    const sessionId = `SESS-${String(idx + 1).padStart(3, '0')}`;
    const startedAt = group[0].received_at;
    const lastPulseAt = group[group.length - 1].received_at;
    const durationSeconds = Math.max(0, Math.round((new Date(lastPulseAt).getTime() - new Date(startedAt).getTime()) / 1000));
    const pulseEvents = group.length;
    const pulseCount = group.reduce((acc, p) => acc + (p.pulse_delta || 1), 0);
    const volumeLiters = isCalibrated ? Number((pulseCount * calib.liters_per_pulse).toFixed(1)) : null;

    // Cálculo das amostras de vazão válidas dentro da sessão (excluindo pares com pulse_delta > 1)
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const deviceId = url.searchParams.get('device_id') || 'HIDRO-001';
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
