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

    const isCalibrated = calib.status === 'calibrated' && typeof calib.liters_per_pulse === 'number' && calib.liters_per_pulse > 0;

    // 2. Buscar janela recente de eventos de pulso físico (sem heartbeats)
    const { data: pulseEvents, error: queryError } = await supabase
      .from('telemetry_events')
      .select('*')
      .eq('device_id', deviceId)
      .eq('type', 'pulse')
      .order('received_at', { ascending: false })
      .limit(50);

    if (queryError) {
      console.error('Erro ao consultar eventos de pulso no Supabase:', queryError);
      return res.status(500).json({ ok: false, error: 'Erro ao consultar banco de dados' });
    }

    const lastEvent = (pulseEvents && pulseEvents.length > 0) ? pulseEvents[0] : null;
    const lastPulseAt = lastEvent ? lastEvent.received_at : null;

    let latestFlowLpm = null;
    let latestFlowM3h = null;
    let intervalSeconds = null;

    // 3. Vazão Instantânea Real (baseada estritamente no par mais recente P2 e P1)
    if (isCalibrated && pulseEvents && pulseEvents.length >= 2) {
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
            }
          }
        }
      }
    }

    // 4. Estatísticas Históricas da Janela: Vazão Média, Pico e Quantidade de Amostras Válidas
    const validFlowSamples = [];

    if (isCalibrated && pulseEvents && pulseEvents.length >= 2) {
      for (let i = 0; i < pulseEvents.length - 1; i++) {
        const curr = pulseEvents[i];
        const prev = pulseEvents[i + 1];

        if (
          curr.pulse_delta === 1 &&
          prev.pulse_delta === 1 &&
          curr.received_at &&
          prev.received_at
        ) {
          const tCurr = new Date(curr.received_at).getTime();
          const tPrev = new Date(prev.received_at).getTime();

          if (!isNaN(tCurr) && !isNaN(tPrev) && tCurr > tPrev) {
            const dtSec = (tCurr - tPrev) / 1000;

            if (dtSec > 0) {
              const flowLpm = (calib.liters_per_pulse / dtSec) * 60;

              if (Number.isFinite(flowLpm) && flowLpm > 0) {
                validFlowSamples.push(flowLpm);
              }
            }
          }
        }
      }
    }

    const samplesCount = validFlowSamples.length;

    const averageFlowLpm = samplesCount > 0
      ? Number((validFlowSamples.reduce((acc, val) => acc + val, 0) / samplesCount).toFixed(2))
      : null;

    const maxFlowLpm = samplesCount > 0
      ? Number(Math.max(...validFlowSamples).toFixed(2))
      : null;

    return res.status(200).json({
      ok: true,
      device_id: deviceId,
      calibration_status: calib.status,
      liters_per_pulse: calib.liters_per_pulse,
      latest_flow_lpm: latestFlowLpm,
      latest_flow_m3h: latestFlowM3h,
      interval_seconds: intervalSeconds,
      average_flow_lpm: averageFlowLpm,
      max_flow_lpm: maxFlowLpm,
      last_pulse_at: lastPulseAt,
      samples: samplesCount
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/flow-summary:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao consultar resumo de vazão' });
  }
}

