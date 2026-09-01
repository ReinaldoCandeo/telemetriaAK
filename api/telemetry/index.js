import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const deviceId = url.searchParams.get('device_id') || 'HIDRO-001';

  try {
    // 1. Consulta da Configuração do Dispositivo
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

    // 2. Rota: /api/telemetry/latest
    if (pathname.includes('/latest')) {
      const { data: latestEvents } = await supabase
        .from('telemetry_events')
        .select('*')
        .eq('device_id', deviceId)
        .order('received_at', { ascending: false })
        .limit(1);

      if (!latestEvents || latestEvents.length === 0) {
        return res.status(200).json({ ok: false, data: null, message: 'Aguardando primeira telemetria...' });
      }

      const tel = latestEvents[0];
      const calcTotal = calib.liters_per_pulse !== null ? (tel.pulse_total * calib.liters_per_pulse) : null;

      return res.status(200).json({
        ok: true,
        data: {
          ...tel,
          calibration: calib,
          calculated_liters_total: calcTotal,
          flow: { lpm: null, m3h: null, type: null, status: calib.status }
        }
      });
    }

    // 3. Rota: /api/telemetry/system-summary
    if (pathname.includes('/system-summary')) {
      const { data: events } = await supabase
        .from('telemetry_events')
        .select('pulse_delta, received_at')
        .eq('device_id', deviceId)
        .eq('type', 'pulse')
        .order('received_at', { ascending: true });

      const sumPulses = (events || []).reduce((acc, ev) => acc + (ev.pulse_delta || 1), 0);
      const sumLiters = calib.liters_per_pulse !== null ? Number((sumPulses * calib.liters_per_pulse).toFixed(2)) : null;

      return res.status(200).json({
        ok: true,
        device_id: deviceId,
        system_pulse_total: sumPulses,
        system_volume_liters: sumLiters,
        pulse_events_total: (events || []).length,
        calibration_status: calib.status,
        liters_per_pulse: calib.liters_per_pulse
      });
    }

    // 4. Rota: /api/telemetry/history
    if (pathname.includes('/history')) {
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const { data: history } = await supabase
        .from('telemetry_events')
        .select('*')
        .eq('device_id', deviceId)
        .order('received_at', { ascending: false })
        .limit(limit);

      return res.status(200).json({ ok: true, data: history || [] });
    }

    return res.status(200).json({ ok: true, data: null });
  } catch (err) {
    console.error('Erro na rota de telemetria:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao consultar telemetria' });
  }
}
