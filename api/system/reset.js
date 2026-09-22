import { createClient } from '@supabase/supabase-js';
import { requireAdminAuth } from '../_lib/auth.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  // 1. Validação estrita de Autenticação ADMIN
  const authResult = await requireAdminAuth(req, res);
  if (!authResult) {
    return; // Resposta 401 ou 403 já enviada pelo helper
  }

  try {
    // 2. Extração e validação estrita de device_id (obrigatório, sem fallback)
    let deviceId = req.body?.device_id;

    if (!deviceId && req.url) {
      try {
        const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
        deviceId = url.searchParams.get('device_id');
      } catch (urlErr) {}
    }

    if (typeof deviceId !== 'string' || deviceId.trim() === '') {
      return res.status(400).json({
        ok: false,
        error: 'device_id é obrigatório'
      });
    }

    const cleanDeviceId = deviceId.trim();

    // 3. Deletar registros de telemetry_events exclusivamente para o device_id informado
    const { error: deleteEventsError } = await supabase
      .from('telemetry_events')
      .delete()
      .eq('device_id', cleanDeviceId);

    if (deleteEventsError) {
      console.error(`Erro ao deletar telemetry_events para ${cleanDeviceId}:`, deleteEventsError);
      return res.status(500).json({ ok: false, error: 'Erro ao zerar histórico no banco de dados.' });
    }

    // 4. Limpar sessão de calibração ativa exclusivamente para o device_id informado (preservando o cadastro e fator liters_per_pulse)
    const { error: updateDevicesError } = await supabase
      .from('devices')
      .update({ calibration_session: null })
      .eq('device_id', cleanDeviceId);

    if (updateDevicesError) {
      console.error(`Aviso ao resetar sessão de calibração para ${cleanDeviceId}:`, updateDevicesError);
    }

    console.log(`[SUPABASE] Hard Reset executado com sucesso para o dispositivo: ${cleanDeviceId}`);

    return res.status(200).json({
      ok: true,
      device_id: cleanDeviceId,
      message: `Dados de telemetria e histórico do dispositivo ${cleanDeviceId} resetados com sucesso.`
    });

  } catch (err) {
    console.error('Erro ao executar hard reset:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao resetar dados.' });
  }
}

