import { createClient } from '@supabase/supabase-js';
import { requireViewerOrAdmin } from '../_lib/auth.js';
import { calculateDailySummary, getTodayLocalDateStr } from '../_lib/daily-summary.js';

function getSupabaseClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

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
    const daysParam = url.searchParams.get('days') || '7';

    const days = parseInt(daysParam, 10);
    if (isNaN(days) || days < 1 || days > 31) {
      return res.status(400).json({
        ok: false,
        error: 'Parâmetro days inválido. Deve ser um número inteiro entre 1 e 31.'
      });
    }

    const todayStr = getTodayLocalDateStr();

    // 1. Gerar array de datas no fuso local (ordem cronológica ascendente)
    const datesList = [];
    const [tYear, tMonth, tDay] = todayStr.split('-').map(Number);
    const todayBaseUtc = new Date(Date.UTC(tYear, tMonth - 1, tDay));

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(todayBaseUtc.getTime() - i * 86400000);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      datesList.push(`${yyyy}-${mm}-${dd}`);
    }

    // 2. Tentar buscar dias fechados persistidos em daily_telemetry_summary (somente leitura)
    const startDate = datesList[0];
    const endDate = datesList[datesList.length - 1];
    const supabase = getSupabaseClient();

    let persistedMap = new Map();
    try {
      const { data: persistedRows, error: dbError } = await supabase
        .from('daily_telemetry_summary')
        .select('*')
        .eq('device_id', deviceId)
        .gte('local_date', startDate)
        .lte('local_date', endDate);

      if (!dbError && Array.isArray(persistedRows)) {
        persistedRows.forEach(row => {
          persistedMap.set(row.local_date, row);
        });
      }
    } catch (e) {
      // Se a tabela ainda não existir no banco, fallback dinâmico somente leitura
    }

    // 3. Processar cada data da janela sem efetuar qualquer escrita no banco
    const items = [];

    for (const dateStr of datesList) {
      // Para o dia corrente ("Hoje"), calcular SEMPRE dinamicamente
      if (dateStr === todayStr) {
        const dynamicToday = await calculateDailySummary(deviceId, dateStr);
        items.push({
          date: dateStr,
          status: 'EM_ANDAMENTO',
          source: 'dynamic',
          persisted: false,
          pulse_count: dynamicToday.pulse_count,
          pulse_events: dynamicToday.pulse_events,
          volume_liters: dynamicToday.volume_liters,
          volume_m3: dynamicToday.volume_m3,
          average_flow_lpm: dynamicToday.average_flow_lpm,
          max_flow_lpm: dynamicToday.max_flow_lpm,
          flow_duration_seconds: dynamicToday.flow_duration_seconds,
          first_pulse_at: dynamicToday.first_pulse_at,
          last_pulse_at: dynamicToday.last_pulse_at,
          is_partial: dynamicToday.is_partial
        });
        continue;
      }

      // Para dias passados, usar registro persistido se disponível
      if (persistedMap.has(dateStr)) {
        const pRow = persistedMap.get(dateStr);
        const volLiters = typeof pRow.volume_liters === 'number' ? pRow.volume_liters : Number(pRow.volume_liters);
        const volM3 = volLiters !== null && !isNaN(volLiters) ? Number((volLiters / 1000).toFixed(3)) : null;

        items.push({
          date: dateStr,
          status: pRow.status,
          source: 'persisted',
          persisted: true,
          pulse_count: Number(pRow.pulse_count || 0),
          pulse_events: Number(pRow.pulse_events || 0),
          volume_liters: volLiters,
          volume_m3: volM3,
          average_flow_lpm: pRow.average_flow_lpm !== null ? Number(pRow.average_flow_lpm) : null,
          max_flow_lpm: pRow.max_flow_lpm !== null ? Number(pRow.max_flow_lpm) : null,
          flow_duration_seconds: pRow.flow_duration_seconds,
          first_pulse_at: pRow.first_pulse_at,
          last_pulse_at: pRow.last_pulse_at,
          is_partial: Boolean(pRow.is_partial)
        });
      } else {
        // Fallback dinâmico SOMENTE DE LEITURA (não grava no banco)
        const computed = await calculateDailySummary(deviceId, dateStr);
        items.push({
          date: dateStr,
          status: computed.status,
          source: 'dynamic',
          persisted: false,
          pulse_count: computed.pulse_count,
          pulse_events: computed.pulse_events,
          volume_liters: computed.volume_liters,
          volume_m3: computed.volume_m3,
          average_flow_lpm: computed.average_flow_lpm,
          max_flow_lpm: computed.max_flow_lpm,
          flow_duration_seconds: computed.flow_duration_seconds,
          first_pulse_at: computed.first_pulse_at,
          last_pulse_at: computed.last_pulse_at,
          is_partial: computed.is_partial
        });
      }
    }

    return res.status(200).json({
      ok: true,
      device_id: deviceId,
      timezone: 'America/Sao_Paulo',
      days: days,
      items: items
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/daily-summary:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao consultar resumo diário' });
  }
}
