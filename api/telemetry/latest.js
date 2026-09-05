import { createClient } from '@supabase/supabase-js';
import { requireViewerOrAdmin } from '../_lib/auth.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

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
    const deviceId = url.searchParams.get('device_id') || 'HIDRO-001';

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

    // 2. Buscar último evento registrado (pulso ou heartbeat)
    const { data: latestEvents, error: queryError } = await supabase
      .from('telemetry_events')
      .select('*')
      .eq('device_id', deviceId)
      .order('received_at', { ascending: false })
      .limit(1);

    if (queryError) {
      console.error('Erro ao consultar telemetria no Supabase:', queryError);
      return res.status(500).json({ ok: false, error: 'Erro ao consultar banco de dados' });
    }

    if (!latestEvents || latestEvents.length === 0) {
      return res.status(200).json({
        ok: false,
        data: null,
        message: 'Aguardando primeira telemetria...'
      });
    }

    const tel = latestEvents[0];
    const calculatedLitersTotal = (calib.status === 'calibrated' && calib.liters_per_pulse !== null)
      ? Number((tel.pulse_total * calib.liters_per_pulse).toFixed(2))
      : null;

    return res.status(200).json({
      ok: true,
      data: {
        device_id: tel.device_id,
        pulse_total: Number(tel.pulse_total),
        pulse_delta: Number(tel.pulse_delta || 0),
        liters_total: tel.liters_total_estimated ? Number(tel.liters_total_estimated) : null,
        rssi: tel.rssi !== null ? Number(tel.rssi) : null,
        received_at: tel.received_at,
        calibration: calib,
        calculated_liters_total: calculatedLitersTotal,
        flow: { lpm: null, m3h: null, type: null, status: calib.status }
      }
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/latest:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao consultar telemetria' });
  }
}
