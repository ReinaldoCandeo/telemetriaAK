import { createClient } from '@supabase/supabase-js';
import { autoRecoverPastDays, getTodayLocalDateStr, getYesterdayLocalDateStr } from '../_lib/daily-summary.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  // 1. Validação estrita de segurança via CRON_SECRET
  const expectedSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || req.headers.Authorization;

  if (!expectedSecret || typeof expectedSecret !== 'string' || expectedSecret.trim() === '') {
    // Se o segredo não estiver configurado no ambiente, bloqueia por segurança
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  if (!authHeader || typeof authHeader !== 'string') {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  const parts = authHeader.trim().split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  const token = parts[1].trim();
  if (!token || token !== expectedSecret) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const explicitDeviceId = url.searchParams.get('device_id');

    let targetDeviceIds = [];

    // Se um device_id específico for passado por parâmetro, processa apenas ele
    if (explicitDeviceId && explicitDeviceId.trim() !== '') {
      targetDeviceIds = [explicitDeviceId.trim()];
    } else {
      // Caso contrário (execução padrão do cron), busca todos os dispositivos cadastrados na tabela devices
      if (supabase) {
        const { data: devicesList, error: devError } = await supabase
          .from('devices')
          .select('device_id')
          .order('device_id', { ascending: true });

        if (!devError && Array.isArray(devicesList) && devicesList.length > 0) {
          targetDeviceIds = devicesList
            .map(d => d.device_id)
            .filter(id => typeof id === 'string' && id.trim() !== '');
        }
      }

      // Fallback de segurança: se a tabela devices estiver vazia ou inacessível, processa HIDRO-001
      if (targetDeviceIds.length === 0) {
        targetDeviceIds = ['HIDRO-001'];
      }
    }

    const todayStr = getTodayLocalDateStr();
    const yesterdayStr = getYesterdayLocalDateStr();

    // 2. Executar autorrecuperação e fechamento diário individual para cada dispositivo
    const results = [];
    for (const deviceId of targetDeviceIds) {
      try {
        const recoveryResult = await autoRecoverPastDays(deviceId);
        results.push({
          device_id: deviceId,
          ok: true,
          recovery_summary: recoveryResult
        });
      } catch (devErr) {
        console.error(`Erro no fechamento diário para ${deviceId}:`, devErr);
        results.push({
          device_id: deviceId,
          ok: false,
          error: devErr.message || String(devErr)
        });
      }
    }

    const hasAnySuccess = results.some(r => r.ok);

    return res.status(hasAnySuccess ? 200 : 500).json({
      ok: hasAnySuccess,
      message: 'Fechamento diário automático e autorrecuperação processados.',
      total_devices: targetDeviceIds.length,
      today_local: todayStr,
      yesterday_local: yesterdayStr,
      results: results
    });

  } catch (err) {
    console.error('Erro no processamento geral do cron /api/cron/daily-finalize:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno durante o fechamento diário.' });
  }
}

