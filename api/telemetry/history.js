import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

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
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 1000);

    // 1. Buscar configuração de calibração
    const { data: devData } = await supabase
      .from('devices')
      .select('*')
      .eq('device_id', deviceId)
      .maybeSingle();

    const calib = {
      status: devData?.calibration_status || 'pending',
      liters_per_pulse: devData?.liters_per_pulse ? Number(devData.liters_per_pulse) : null,
      calibrated_at: devData?.calibrated_at || null
    };

    // 2. Buscar histórico de eventos
    const { data: history, error: queryError } = await supabase
      .from('telemetry_events')
      .select('*')
      .eq('device_id', deviceId)
      .order('received_at', { ascending: false })
      .limit(limit);

    if (queryError) {
      console.error('Erro ao consultar history no Supabase:', queryError);
      return res.status(500).json({ ok: false, error: 'Erro ao consultar histórico' });
    }

    const isCalibrated = calib.status === 'calibrated' && typeof calib.liters_per_pulse === 'number' && calib.liters_per_pulse > 0;

    // Extrair apenas eventos de pulso para encontrar pares cronológicos consecutivos
    const pulseEvents = (history || []).filter(item => item.type === 'pulse');

    // Mapear cada evento e calcular vazão quando aplicável
    const enriched = (history || []).map(item => {
      const calcDelta = (item.type === 'pulse' && calib.liters_per_pulse !== null)
        ? Number(((item.pulse_delta || 0) * calib.liters_per_pulse).toFixed(2))
        : null;
      const calcTotal = (calib.liters_per_pulse !== null)
        ? Number(((item.pulse_total || 0) * calib.liters_per_pulse).toFixed(2))
        : null;

      let intervalSeconds = null;
      let flowLpm = null;
      let flowM3h = null;
      let flowType = null;
      let flowStatus = !isCalibrated ? 'calibration_pending' : 'insufficient_data';

      if (item.type === 'pulse') {
        const pulseIndex = pulseEvents.findIndex(p => p.id === item.id);
        const prevPulse = pulseIndex !== -1 ? pulseEvents[pulseIndex + 1] : null;

        // Proteção estrita contra agregação offline: ambos os pulsos devem ser delta === 1
        if (
          prevPulse &&
          item.pulse_delta === 1 &&
          prevPulse.pulse_delta === 1 &&
          item.received_at &&
          prevPulse.received_at
        ) {
          const tCurrent = new Date(item.received_at).getTime();
          const tPrev = new Date(prevPulse.received_at).getTime();

          if (!isNaN(tCurrent) && !isNaN(tPrev) && tCurrent > tPrev) {
            const rawIntervalSec = (tCurrent - tPrev) / 1000;

            if (rawIntervalSec > 0 && isCalibrated) {
              const rawLpm = (calib.liters_per_pulse / rawIntervalSec) * 60;
              const rawM3h = rawLpm * 0.06;

              if (Number.isFinite(rawLpm) && Number.isFinite(rawM3h) && rawLpm > 0) {
                intervalSeconds = Number(rawIntervalSec.toFixed(2));
                flowLpm = Number(rawLpm.toFixed(2));
                flowM3h = Number(rawM3h.toFixed(3));
                flowType = 'single_pulse';
                flowStatus = 'ok';
              }
            }
          }
        }
      }

      return {
        ...item,
        calibration: calib,
        calculated_liters_delta: calcDelta,
        calculated_liters_total: calcTotal,
        interval_seconds: intervalSeconds,
        flow_lpm: flowLpm,
        flow_m3h: flowM3h,
        flow_type: flowType,
        flow_status: flowStatus
      };
    });

    // Calcular estatísticas de vazão na memória com as amostras válidas da janela
    const validFlows = enriched
      .filter(item => item.flow_status === 'ok' && typeof item.flow_lpm === 'number')
      .map(item => item.flow_lpm);

    const averageFlowLpm = validFlows.length > 0
      ? Number((validFlows.reduce((acc, val) => acc + val, 0) / validFlows.length).toFixed(2))
      : null;

    const maxFlowLpm = validFlows.length > 0
      ? Number(Math.max(...validFlows).toFixed(2))
      : null;

    return res.status(200).json({
      ok: true,
      data: enriched,
      metrics: {
        average_flow_lpm: averageFlowLpm,
        max_flow_lpm: maxFlowLpm,
        samples: validFlows.length
      }
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/history:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao buscar histórico' });
  }
}
