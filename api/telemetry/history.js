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

    const enriched = (history || []).map(item => {
      const calcDelta = (item.type === 'pulse' && calib.liters_per_pulse !== null)
        ? Number(((item.pulse_delta || 0) * calib.liters_per_pulse).toFixed(2))
        : null;
      const calcTotal = (calib.liters_per_pulse !== null)
        ? Number(((item.pulse_total || 0) * calib.liters_per_pulse).toFixed(2))
        : null;

      return {
        ...item,
        calibration: calib,
        calculated_liters_delta: calcDelta,
        calculated_liters_total: calcTotal,
        interval_seconds: null,
        flow_lpm: null,
        flow_m3h: null,
        flow_type: null,
        flow_status: calib.liters_per_pulse === null ? 'calibration_pending' : 'insufficient_data'
      };
    });

    return res.status(200).json({ ok: true, data: enriched });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/history:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao buscar histórico' });
  }
}
