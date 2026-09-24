import { createClient } from '@supabase/supabase-js';
import { requireViewerOrAdmin } from '../_lib/auth.js';
import { calculateDailySummary, getTodayLocalDateStr, getDayClassification } from '../_lib/daily-summary.js';

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
    const rawDeviceId = url.searchParams.get('device_id');
    const deviceId = typeof rawDeviceId === 'string' ? rawDeviceId.trim() : '';

    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id é obrigatório' });
    }
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
      const classification = getDayClassification(deviceId, dateStr, todayStr);

      // Para o dia corrente ("Hoje"), calcular SEMPRE dinamicamente
      if (dateStr === todayStr) {
        const dynamicToday = await calculateDailySummary(deviceId, dateStr);
        items.push({
          date: dateStr,
          status: 'EM_ANDAMENTO',
          is_operational: false,
          is_partial: true,
          is_test: false,
          classification_reason: classification.reason,
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
          last_pulse_at: dynamicToday.last_pulse_at
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
          status: classification.status,
          is_operational: classification.is_operational,
          is_partial: classification.is_partial,
          is_test: classification.is_test,
          classification_reason: classification.reason,
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
          last_pulse_at: pRow.last_pulse_at
        });
      } else {
        // Fallback dinâmico SOMENTE DE LEITURA (não grava no banco)
        const computed = await calculateDailySummary(deviceId, dateStr);
        items.push({
          date: dateStr,
          status: computed.status,
          is_operational: computed.is_operational,
          is_partial: computed.is_partial,
          is_test: computed.is_test,
          classification_reason: computed.classification_reason,
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
          last_pulse_at: computed.last_pulse_at
        });
      }
    }

    // 4. Calcular métricas operacionais consolidadas (apenas dias fechados e operacionais)
    const operationalDays = items.filter(d => d.is_operational === true && d.status === 'FECHADO');
    const operationalSumM3 = operationalDays.reduce((acc, d) => acc + (d.volume_m3 !== null ? Number(d.volume_m3) : 0), 0);
    const operationalAvgM3 = operationalDays.length > 0 ? Number((operationalSumM3 / operationalDays.length).toFixed(3)) : null;

    return res.status(200).json({
      ok: true,
      device_id: deviceId,
      timezone: 'America/Sao_Paulo',
      days: days,
      operational_days_count: operationalDays.length,
      operational_sum_m3: Number(operationalSumM3.toFixed(3)),
      operational_avg_m3: operationalAvgM3,
      items: items
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/daily-summary:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao consultar resumo diário' });
  }
}
