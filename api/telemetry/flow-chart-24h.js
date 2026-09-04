import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const WINDOW_HOURS = 24;
const BUCKET_MINUTES = 5;
const TOTAL_BUCKETS = (WINDOW_HOURS * 60) / BUCKET_MINUTES; // 288 buckets
const BUCKET_DURATION_MS = BUCKET_MINUTES * 60 * 1000; // 300.000 ms
const PAGE_SIZE = 1000;
const MAX_PULSE_EVENTS_24H = 8000;
const SESSION_GAP_SECONDS = 90;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const deviceId = url.searchParams.get('device_id') || 'HIDRO-001';

    // 1. Buscar calibração do dispositivo
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

    const isCalibrated = calib.status === 'calibrated' && typeof calib.liters_per_pulse === 'number' && calib.liters_per_pulse > 0;

    const nowMs = Date.now();
    const windowStartMs = nowMs - (WINDOW_HOURS * 60 * 60 * 1000);
    const windowEndMs = nowMs;
    const windowStartIso = new Date(windowStartMs).toISOString();
    const windowEndIso = new Date(windowEndMs).toISOString();

    if (!isCalibrated) {
      return res.status(200).json({
        ok: true,
        device_id: deviceId,
        calibration_status: calib.status,
        liters_per_pulse: calib.liters_per_pulse,
        metadata: {
          window_hours: WINDOW_HOURS,
          bucket_minutes: BUCKET_MINUTES,
          bucket_count: TOTAL_BUCKETS,
          pulse_events_loaded: 0,
          valid_flow_samples: 0,
          truncated: false,
          window_start: windowStartIso,
          window_end: windowEndIso
        },
        data: []
      });
    }

    // 2. Buscar eventos de pulso das últimas 24h paginados com ORDER BY received_at DESC
    let allPulses = [];
    let page = 0;
    let hasMore = true;
    let isTruncated = false;

    while (hasMore && allPulses.length < MAX_PULSE_EVENTS_24H) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { data: pageData, error } = await supabase
        .from('telemetry_events')
        .select('id, pulse_delta, pulse_total, received_at')
        .eq('device_id', deviceId)
        .eq('type', 'pulse')
        .gte('received_at', windowStartIso)
        .order('received_at', { ascending: false })
        .range(from, to);

      if (error) {
        console.error('Erro ao buscar eventos de pulso para gráfico 24h:', error);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar eventos de pulso' });
      }

      if (!pageData || pageData.length === 0) {
        hasMore = false;
        break;
      }

      allPulses = allPulses.concat(pageData);

      if (pageData.length < PAGE_SIZE) {
        hasMore = false;
      } else {
        page++;
      }
    }

    if (allPulses.length >= MAX_PULSE_EVENTS_24H) {
      isTruncated = true;
      allPulses = allPulses.slice(0, MAX_PULSE_EVENTS_24H);
    }

    // 3. Buscar 1 pulso imediatamente anterior a window_start para cálculo do primeiro intervalo (se existir)
    let preWindowPulse = null;
    try {
      const { data: prePulseData } = await supabase
        .from('telemetry_events')
        .select('id, pulse_delta, pulse_total, received_at')
        .eq('device_id', deviceId)
        .eq('type', 'pulse')
        .lt('received_at', windowStartIso)
        .order('received_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (prePulseData) {
        preWindowPulse = prePulseData;
      }
    } catch (preErr) {
      console.warn('Aviso: Não foi possível buscar pulso anterior à janela:', preErr);
    }

    // 4. Reordenar os pulsos da janela em ordem cronológica (ASC)
    const chronoPulses = [...allPulses].reverse();

    // 5. Inicializar os 288 buckets de 5 minutos
    const buckets = [];
    for (let i = 0; i < TOTAL_BUCKETS; i++) {
      const bStartMs = windowStartMs + (i * BUCKET_DURATION_MS);
      const bEndMs = bStartMs + BUCKET_DURATION_MS;
      buckets.push({
        bucket_index: i,
        timestamp: new Date(bStartMs).toISOString(),
        bucket_start: new Date(bStartMs).toISOString(),
        bucket_end: new Date(bEndMs).toISOString(),
        flow_lpm: 0,
        max_flow_lpm: 0,
        volume_liters: 0,
        pulse_count: 0,
        sample_count: 0,
        status: 'no_flow',
        _validFlowSamples: []
      });
    }

    function getBucketIndex(timeMs) {
      if (timeMs < windowStartMs || timeMs > windowEndMs) return -1;
      const idx = Math.floor((timeMs - windowStartMs) / BUCKET_DURATION_MS);
      return Math.min(Math.max(idx, 0), TOTAL_BUCKETS - 1);
    }

    // 6. Contabilizar volume e contagem de pulsos para todos os pulsos pertencentes aos buckets
    for (const p of chronoPulses) {
      if (p.received_at) {
        const t = new Date(p.received_at).getTime();
        const bIdx = getBucketIndex(t);
        if (bIdx >= 0) {
          const delta = typeof p.pulse_delta === 'number' && p.pulse_delta > 0 ? p.pulse_delta : 1;
          buckets[bIdx].pulse_count += delta;
          buckets[bIdx].volume_liters += delta * calib.liters_per_pulse;
        }
      }
    }

    // 7. Calcular amostras válidas de vazão cronologicamente entre pares consecutivos
    const evalPulses = preWindowPulse ? [preWindowPulse, ...chronoPulses] : chronoPulses;
    let totalValidFlowSamples = 0;

    for (let i = 0; i < evalPulses.length - 1; i++) {
      const p1 = evalPulses[i];
      const p2 = evalPulses[i + 1];

      // Proteção contra eventos acumulados/offline: ambos devem ser pulsos unitários (pulse_delta === 1)
      if (
        p1.pulse_delta === 1 &&
        p2.pulse_delta === 1 &&
        p1.received_at &&
        p2.received_at
      ) {
        const t1 = new Date(p1.received_at).getTime();
        const t2 = new Date(p2.received_at).getTime();

        if (!isNaN(t1) && !isNaN(t2) && t2 > t1) {
          const intervalSeconds = (t2 - t1) / 1000;

          // Somente se for dentro do limiar de passagem contínua (<= 90s)
          if (intervalSeconds > 0 && intervalSeconds <= SESSION_GAP_SECONDS) {
            const rawLpm = (calib.liters_per_pulse / intervalSeconds) * 60;

            if (Number.isFinite(rawLpm) && rawLpm > 0) {
              // Associar essa amostra de vazão ao bucket correspondente ao timestamp de P2
              const bIdx = getBucketIndex(t2);
              if (bIdx >= 0) {
                buckets[bIdx]._validFlowSamples.push(rawLpm);
                totalValidFlowSamples++;
              }
            }
          }
        }
      }
    }

    // 8. Finalizar métricas de cada bucket
    const finalizedData = buckets.map(b => {
      let flowLpm = 0;
      let maxFlowLpm = 0;
      let status = 'no_flow';
      const sampleCount = b._validFlowSamples.length;

      if (sampleCount > 0) {
        status = 'flow';
        const sum = b._validFlowSamples.reduce((acc, v) => acc + v, 0);
        flowLpm = Number((sum / sampleCount).toFixed(2));
        maxFlowLpm = Number(Math.max(...b._validFlowSamples).toFixed(2));
      } else if (b.pulse_count > 0) {
        // Houve atividade de pulsos no bucket, mas sem cálculo válido de vazão contínua
        status = 'insufficient_data';
        flowLpm = null;
        maxFlowLpm = null;
      } else {
        // Período sem passagem de água
        status = 'no_flow';
        flowLpm = 0;
        maxFlowLpm = 0;
      }

      return {
        timestamp: b.timestamp,
        bucket_start: b.bucket_start,
        bucket_end: b.bucket_end,
        flow_lpm: flowLpm,
        max_flow_lpm: maxFlowLpm,
        volume_liters: Number(b.volume_liters.toFixed(1)),
        pulse_count: b.pulse_count,
        sample_count: sampleCount,
        status: status
      };
    });

    return res.status(200).json({
      ok: true,
      device_id: deviceId,
      calibration_status: calib.status,
      liters_per_pulse: calib.liters_per_pulse,
      metadata: {
        window_hours: WINDOW_HOURS,
        bucket_minutes: BUCKET_MINUTES,
        bucket_count: TOTAL_BUCKETS,
        pulse_events_loaded: allPulses.length,
        valid_flow_samples: totalValidFlowSamples,
        truncated: isTruncated,
        window_start: windowStartIso,
        window_end: windowEndIso
      },
      data: finalizedData
    });

  } catch (err) {
    console.error('Erro no GET /api/telemetry/flow-chart-24h:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao gerar gráfico de vazão 24h' });
  }
}
