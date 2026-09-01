import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // ==========================================================================
  // 1. RECEPÇÃO DE TELEMETRIA (POST /api/telemetry)
  // ==========================================================================
  if (req.method === 'POST') {
    try {
      const payload = req.body;

      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ ok: false, error: 'Payload JSON inválido' });
      }

      const { device_id, pulse_total, pulse_delta, liters_total, rssi } = payload;

      if (typeof device_id !== 'string' || device_id.trim() === '') {
        return res.status(400).json({ ok: false, error: 'device_id é obrigatório' });
      }
      if (typeof pulse_total !== 'number' || !Number.isFinite(pulse_total)) {
        return res.status(400).json({ ok: false, error: 'pulse_total deve ser número' });
      }

      const cleanDeviceId = device_id.trim();
      const cleanRssi = (typeof rssi === 'number' && Number.isFinite(rssi)) ? rssi : null;
      const cleanLitersEstimated = (typeof liters_total === 'number' && Number.isFinite(liters_total)) ? liters_total : null;
      const effectiveDeltaInput = (typeof pulse_delta === 'number' && Number.isFinite(pulse_delta)) ? pulse_delta : 0;
      const nowIso = new Date().toISOString();

      // 1. Garantir que o dispositivo existe no banco
      await supabase
        .from('devices')
        .upsert({ device_id: cleanDeviceId, updated_at: nowIso }, { onConflict: 'device_id', ignoreDuplicates: false });

      // 2. Buscar último evento de telemetria registrado para o dispositivo
      const { data: lastEvents, error: queryError } = await supabase
        .from('telemetry_events')
        .select('pulse_total, type')
        .eq('device_id', cleanDeviceId)
        .order('received_at', { ascending: false })
        .limit(1);

      if (queryError) {
        console.error('Erro ao consultar último evento:', queryError);
      }

      const prevPulseTotal = (lastEvents && lastEvents.length > 0) ? Number(lastEvents[0].pulse_total) : null;
      const eventsToInsert = [];

      // 3. Regra de Negócio: Primeiro Registro, Incremento de Pulso, Counter Reset ou Heartbeat
      if (prevPulseTotal === null) {
        eventsToInsert.push({
          device_id: cleanDeviceId,
          type: effectiveDeltaInput > 0 ? 'pulse' : 'heartbeat',
          pulse_delta: effectiveDeltaInput,
          pulse_total: pulse_total,
          liters_total_estimated: cleanLitersEstimated,
          rssi: cleanRssi,
          received_at: nowIso
        });
      } else if (pulse_total > prevPulseTotal) {
        const calculatedDelta = pulse_total - prevPulseTotal;
        eventsToInsert.push({
          device_id: cleanDeviceId,
          type: 'pulse',
          pulse_delta: calculatedDelta,
          pulse_total: pulse_total,
          liters_total_estimated: cleanLitersEstimated,
          rssi: cleanRssi,
          received_at: nowIso
        });
      } else if (pulse_total < prevPulseTotal) {
        // Evento de reinício do microcontrolador (Counter Reset)
        eventsToInsert.push({
          device_id: cleanDeviceId,
          type: 'counter_reset',
          previous_pulse_total: prevPulseTotal,
          new_pulse_total: pulse_total,
          pulse_total: pulse_total,
          received_at: nowIso
        });

        if (pulse_total > 0) {
          eventsToInsert.push({
            device_id: cleanDeviceId,
            type: 'pulse',
            pulse_delta: pulse_total,
            pulse_total: pulse_total,
            liters_total_estimated: cleanLitersEstimated,
            rssi: cleanRssi,
            received_at: nowIso
          });
        }
      } else {
        // Heartbeat periódico (pulse_total == prevPulseTotal)
        eventsToInsert.push({
          device_id: cleanDeviceId,
          type: 'heartbeat',
          pulse_delta: 0,
          pulse_total: pulse_total,
          liters_total_estimated: cleanLitersEstimated,
          rssi: cleanRssi,
          received_at: nowIso
        });
      }

      // 4. Inserção no Supabase (PostgreSQL)
      if (eventsToInsert.length > 0) {
        const { error: insertError } = await supabase
          .from('telemetry_events')
          .insert(eventsToInsert);

        if (insertError) {
          console.error('Erro ao gravar telemetria no Supabase:', insertError);
          return res.status(500).json({ ok: false, error: 'Erro ao persistir telemetria' });
        }
      }

      const telemetryRecord = {
        device_id: cleanDeviceId,
        pulse_total,
        pulse_delta: effectiveDeltaInput,
        liters_total: cleanLitersEstimated,
        rssi: cleanRssi,
        received_at: nowIso
      };

      return res.status(200).json({
        ok: true,
        data: telemetryRecord
      });

    } catch (err) {
      console.error('Erro interno no POST /api/telemetry:', err);
      return res.status(500).json({ ok: false, error: 'Erro interno no servidor' });
    }
  }

  // ==========================================================================
  // 2. CONSULTA DA ÚLTIMA TELEMETRIA (GET /api/telemetry)
  // ==========================================================================
  if (req.method === 'GET') {
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

      // 2. Buscar último evento (seja pulso ou heartbeat)
      const { data: latestEvents, error: queryError } = await supabase
        .from('telemetry_events')
        .select('*')
        .eq('device_id', deviceId)
        .order('received_at', { ascending: false })
        .limit(1);

      if (queryError) {
        console.error('Erro ao consultar telemetria no Supabase:', queryError);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar banco de dados' });
      }

      if (!latestEvents || latestEvents.length === 0) {
        return res.status(200).json({
          ok: false,
          data: null,
          message: 'Aguardando primeira telemetria...'
        });
      }

      const tel = latestEvents[0];
      const calculatedLitersTotal = (calib.status === 'calibrated' && calib.liters_per_pulse !== null)
        ? Number((tel.pulse_total * calib.liters_per_pulse).toFixed(2))
        : null;

      return res.status(200).json({
        ok: true,
        data: {
          device_id: tel.device_id,
          pulse_total: Number(tel.pulse_total),
          pulse_delta: Number(tel.pulse_delta || 0),
          liters_total: tel.liters_total_estimated ? Number(tel.liters_total_estimated) : null,
          rssi: tel.rssi !== null ? Number(tel.rssi) : null,
          received_at: tel.received_at,
          calibration: calib,
          calculated_liters_total: calculatedLitersTotal,
          flow: { lpm: null, m3h: null, type: null, status: calib.status }
        }
      });

    } catch (err) {
      console.error('Erro interno no GET /api/telemetry:', err);
      return res.status(500).json({ ok: false, error: 'Erro interno ao consultar telemetria' });
    }
  }

  return res.status(405).json({ ok: false, error: 'Método não permitido' });
}
