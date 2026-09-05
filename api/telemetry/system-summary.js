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

    // 2. Buscar eventos físicos de pulso com paginação completa (sem teto silencioso)
    const PAGE_SIZE = 1000;
    let sumPulses = 0;
    let pulseEventsTotal = 0;
    let firstPulseAt = null;
    let lastPulseAt = null;

    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { data: pageRows, error: queryError } = await supabase
        .from('telemetry_events')
        .select('pulse_delta, received_at')
        .eq('device_id', deviceId)
        .eq('type', 'pulse')
        .order('received_at', { ascending: true })
        .range(from, to);

      if (queryError) {
        console.error(`Erro ao consultar página ${page} de telemetry_events:`, queryError);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar banco de dados' });
      }

      const rows = pageRows || [];
      if (rows.length > 0) {
        if (firstPulseAt === null) {
          firstPulseAt = rows[0].received_at;
        }
        lastPulseAt = rows[rows.length - 1].received_at;

        for (let i = 0; i < rows.length; i++) {
          const delta = Number(rows[i].pulse_delta);
          sumPulses += (!isNaN(delta) && delta > 0) ? delta : 1;
        }

        pulseEventsTotal += rows.length;
      }

      if (rows.length < PAGE_SIZE) {
        hasMore = false;
      } else {
        page++;
      }
    }

    const sumLiters = (calib.status === 'calibrated' && calib.liters_per_pulse !== null)
      ? Number((sumPulses * calib.liters_per_pulse).toFixed(2))
      : null;

    return res.status(200).json({
      ok: true,
      device_id: deviceId,
      system_pulse_total: sumPulses,
      system_volume_liters: sumLiters,
      pulse_events_total: pulseEventsTotal,
      first_pulse_at: firstPulseAt,
      last_pulse_at: lastPulseAt,
      calibration_status: calib.status,
      liters_per_pulse: calib.liters_per_pulse
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/system-summary:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao gerar resumo do sistema' });
  }
}
