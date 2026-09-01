import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  try {
    // 1. Deletar todos os registros de telemetry_events no Supabase
    const { error: deleteEventsError } = await supabase
      .from('telemetry_events')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');

    if (deleteEventsError) {
      console.error('Erro ao deletar telemetry_events no Supabase:', deleteEventsError);
      return res.status(500).json({ ok: false, error: 'Erro ao zerar histórico no banco de dados.' });
    }

    // 2. Limpar qualquer sessão de calibração ativa nos dispositivos (preservando o fator liters_per_pulse)
    const { error: updateDevicesError } = await supabase
      .from('devices')
      .update({ calibration_session: null })
      .neq('device_id', '');

    if (updateDevicesError) {
      console.error('Aviso ao resetar sessões ativas de calibração:', updateDevicesError);
    }

    console.log('[SUPABASE] Hard Reset executado com sucesso. telemetry_events zerados.');

    return res.status(200).json({
      ok: true,
      message: 'Dados de telemetria e histórico resetados no Supabase com sucesso.'
    });

  } catch (err) {
    console.error('Erro ao executar hard reset:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao resetar dados.' });
  }
}
