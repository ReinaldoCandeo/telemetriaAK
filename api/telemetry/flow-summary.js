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

    // 1. Buscar calibração
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

    // 2. Buscar os dois últimos eventos de pulso físico
    const { data: pulseEvents, error: queryError } = await supabase
      .from('telemetry_events')
      .select('*')
      .eq('device_id', deviceId)
      .eq('type', 'pulse')
      .order('received_at', { ascending: false })
      .limit(2);

    if (queryError) {
      console.error('Erro ao consultar eventos de pulso no Supabase:', queryError);
      return res.status(500).json({ ok: false, error: 'Erro ao consultar banco de dados' });
    }

    const lastEvent = (pulseEvents && pulseEvents.length > 0) ? pulseEvents[0] : null;
    const lastPulseAt = lastEvent ? lastEvent.received_at : null;

    let latestFlowLpm = null;
    let latestFlowM3h = null;
    let intervalSeconds = null;
    let samples = 0;

    // 3. Condições estritas para cálculo da vazão instantânea real
    if (
      calib.status === 'calibrated' &&
      typeof calib.liters_per_pulse === 'number' &&
      calib.liters_per_pulse > 0 &&
      pulseEvents &&
      pulseEvents.length >= 2
    ) {
      const p2 = pulseEvents[0]; // mais recente
      const p1 = pulseEvents[1]; // anterior

      // Proteção contra agregação offline: ambos devem ser pulsos individuais reais (pulse_delta === 1)
      if (p2.pulse_delta === 1 && p1.pulse_delta === 1 && p2.received_at && p1.received_at) {
        const t2 = new Date(p2.received_at).getTime();
        const t1 = new Date(p1.received_at).getTime();

        if (!isNaN(t1) && !isNaN(t2) && t2 > t1) {
          const rawIntervalSec = (t2 - t1) / 1000;

          if (rawIntervalSec > 0) {
            const rawLpm = (calib.liters_per_pulse / rawIntervalSec) * 60;
            const rawM3h = rawLpm * 0.06;

            if (Number.isFinite(rawLpm) && Number.isFinite(rawM3h) && rawLpm > 0) {
              intervalSeconds = Number(rawIntervalSec.toFixed(2));
              latestFlowLpm = Number(rawLpm.toFixed(2));
              latestFlowM3h = Number(rawM3h.toFixed(3));
              samples = 1;
            }
          }
        }
      }
    }

    return res.status(200).json({
      ok: true,
      device_id: deviceId,
      calibration_status: calib.status,
      liters_per_pulse: calib.liters_per_pulse,
      latest_flow_lpm: latestFlowLpm,
      latest_flow_m3h: latestFlowM3h,
      interval_seconds: intervalSeconds,
      average_flow_lpm: null,
      max_flow_lpm: null,
      last_pulse_at: lastPulseAt,
      samples: samples
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/flow-summary:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao consultar resumo de vazão' });
  }
}

