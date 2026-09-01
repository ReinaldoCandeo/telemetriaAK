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
      if (typeof liters_total !== 'number' || !Number.isFinite(liters_total)) {
        return res.status(400).json({ ok: false, error: 'liters_total deve ser número' });
      }

      const cleanDeviceId = device_id.trim();
      const cleanRssi = (typeof rssi === 'number' && Number.isFinite(rssi)) ? rssi : null;
      const nowIso = new Date().toISOString();

      // 1. Garantir que o dispositivo existe no banco
      await supabase
        .from('devices')
        .upsert({ device_id: cleanDeviceId }, { onConflict: 'device_id', ignoreDuplicates: true });

      // 2. Buscar último evento de telemetria registrado para o dispositivo
      const { data: lastEvents, error: queryError } = await supabase
        .from('telemetry_events')
        .select('pulse_total')
        .eq('device_id', cleanDeviceId)
        .order('received_at', { ascending: false })
        .limit(1);

      if (queryError) {
        console.error('Erro ao consultar último evento:', queryError);
      }

      const prevPulseTotal = (lastEvents && lastEvents.length > 0) ? Number(lastEvents[0].pulse_total) : null;
      const eventsToInsert = [];

      // 3. Regra de Negócio: Incremento, Primeiro Registro ou Reinício do ESP32 (Counter Reset)
      if (prevPulseTotal === null) {
        if (pulse_total > 0) {
          eventsToInsert.push({
            device_id: cleanDeviceId,
            type: 'pulse',
            pulse_delta: pulse_total,
            pulse_total: pulse_total,
            liters_total_estimated: liters_total,
            rssi: cleanRssi,
            received_at: nowIso
          });
        }
      } else if (pulse_total > prevPulseTotal) {
        const effectiveDelta = pulse_total - prevPulseTotal;
        eventsToInsert.push({
          device_id: cleanDeviceId,
          type: 'pulse',
          pulse_delta: effectiveDelta,
          pulse_total: pulse_total,
          liters_total_estimated: liters_total,
          rssi: cleanRssi,
          received_at: nowIso
        });
      } else if (pulse_total < prevPulseTotal) {
        // Evento de reinício do microcontrolador
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
            liters_total_estimated: liters_total,
            rssi: cleanRssi,
            received_at: nowIso
          });
        }
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
        pulse_delta: pulse_delta !== undefined ? pulse_delta : 0,
        liters_total,
        rssi: cleanRssi,
        received_at: nowIso
      };

      return res.status(200).json({
        ok: true,
        data: telemetryRecord
      });

    } catch (err) {
      console.error('Erro interno no handler:', err);
      return res.status(500).json({ ok: false, error: 'Erro interno no servidor' });
    }
  }

  return res.status(405).json({ ok: false, error: 'Método não permitido' });
}
