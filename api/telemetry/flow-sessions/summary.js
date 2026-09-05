import { computeSessions } from '../flow-sessions.js';
import { requireViewerOrAdmin } from '../../_lib/auth.js';

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

    const { summary, metadata } = await computeSessions(deviceId);

    return res.status(200).json({
      ok: true,
      ...summary,
      metadata
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/flow-sessions/summary:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao consultar resumo das sessões' });
  }
}
