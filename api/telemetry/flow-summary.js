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

    // 2. Buscar último evento
    const { data: lastEvents } = await supabase
      .from('telemetry_events')
      .select('*')
      .eq('device_id', deviceId)
      .order('received_at', { ascending: false })
      .limit(1);

    const lastEvent = (lastEvents && lastEvents.length > 0) ? lastEvents[0] : null;

    return res.status(200).json({
      ok: true,
      device_id: deviceId,
      calibration_status: calib.status,
      liters_per_pulse: calib.liters_per_pulse,
      latest_flow_lpm: null,
      latest_flow_m3h: null,
      average_flow_lpm: null,
      max_flow_lpm: null,
      last_pulse_at: lastEvent ? lastEvent.received_at : null,
      samples: 0
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/flow-summary:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao consultar resumo de vazão' });
  }
}
