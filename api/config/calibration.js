import { createClient } from '@supabase/supabase-js';
import { requireAdminAuth } from '../_lib/auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // 1. GET /api/config/calibration (Leitura pública nesta etapa)
    if (req.method === 'GET') {
      const deviceId = url.searchParams.get('device_id') || 'HIDRO-001';
      const { data: dev, error } = await supabase
        .from('devices')
        .select('*')
        .eq('device_id', deviceId)
        .maybeSingle();

      if (error) throw error;

      return res.status(200).json({
        ok: true,
        data: dev || {
          device_id: deviceId,
          liters_per_pulse: null,
          calibration_status: 'pending',
          calibrated_at: null
        }
      });
    }

    // 2. PUT ou POST /api/config/calibration (Salvar fator de calibração - Exige ADMIN)
    if (req.method === 'PUT' || req.method === 'POST') {
      const authResult = await requireAdminAuth(req, res);
      if (!authResult) {
        return; // Resposta 401 ou 403 já enviada pelo helper
      }

      const payload = req.body || {};
      const deviceId = (payload.device_id || 'HIDRO-001').trim();
      const litersPerPulse = parseFloat(payload.liters_per_pulse);

      if (isNaN(litersPerPulse) || litersPerPulse <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'liters_per_pulse deve ser um número positivo.'
        });
      }

      const nowIso = new Date().toISOString();

      const { data, error } = await supabase
        .from('devices')
        .upsert({
          device_id: deviceId,
          liters_per_pulse: litersPerPulse,
          calibration_status: 'calibrated',
          calibrated_at: nowIso,
          calibration_session: null,
          updated_at: nowIso
        }, { onConflict: 'device_id' })
        .select()
        .single();

      if (error) {
        console.error('Erro ao atualizar calibração no Supabase:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao gravar calibração no banco.' });
      }

      return res.status(200).json({
        ok: true,
        data: {
          device_id: deviceId,
          liters_per_pulse: litersPerPulse,
          calibration_status: 'calibrated',
          calibrated_at: nowIso
        }
      });
    }

    return res.status(405).json({ ok: false, error: 'Método não permitido' });

  } catch (err) {
    console.error('Erro em /api/config/calibration:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao processar calibração.' });
  }
}
