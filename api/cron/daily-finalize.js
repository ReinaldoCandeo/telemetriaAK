import { autoRecoverPastDays, getTodayLocalDateStr, getYesterdayLocalDateStr } from '../_lib/daily-summary.js';

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
    const deviceId = url.searchParams.get('device_id') || 'HIDRO-001';

    const todayStr = getTodayLocalDateStr();
    const yesterdayStr = getYesterdayLocalDateStr();

    // 2. Executar autorrecuperação e fechamento de dias passados pendentes
    const recoveryResult = await autoRecoverPastDays(deviceId);

    return res.status(200).json({
      ok: true,
      message: 'Fechamento diário automático e autorrecuperação concluídos com sucesso.',
      device_id: deviceId,
      today_local: todayStr,
      yesterday_local: yesterdayStr,
      recovery_summary: recoveryResult
    });

  } catch (err) {
    console.error('Erro no processamento do cron /api/cron/daily-finalize:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno durante o fechamento diário.' });
  }
}
