/*
 * TELEMETRIA HÍDRICA — PROTÓTIPO LOCAL (ETAPA 03)
 * Firmware de Teste para ESP32-S3 Uno / Dev Module
 *
 * Pinos de Hardware:
 * - GPIO18: Sensor Reed Switch (Borne PINO 1 -> GPIO18, PINO 2 -> GND)
 * - GPIO4:  LED Indicador (Sinalização visual de pulso)
 */

#include <HTTPClient.h>
#include <WiFi.h>

// ========================================
// CONFIGURACAO DO TESTE
// ========================================

const char *WIFI_SSID = "fsp";
const char *WIFI_PASSWORD = "fsp123456";

const char *SERVER_HOST = "172.20.10.2";
const uint16_t SERVER_PORT = 3000;

const char *DEVICE_ID = "HIDRO-001";

// ========================================
// CONFIGURAÇÃO DE PINOS E CONSTANTES
// ========================================

const int PINO_PULSO = 18;
const int PINO_LED = 4;

const unsigned long DEBOUNCE_MS = 100;
const unsigned long LED_DURATION_MS = 150;
const unsigned long HEARTBEAT_INTERVAL_MS = 10000;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 5000;
const uint16_t HTTP_TIMEOUT_MS = 1500;

// Fator temporário de simulação: 1 pulso = 1 litro.
// ATENÇÃO: Este valor é apenas para simulação nesta prova de conceito.
// Substituir futuramente pela constante de calibração real do hidrômetro
// Akvometer.
const float LITERS_PER_PULSE = 1.0f;

// ========================================
// VARIÁVEIS DE ESTADO DO SISTEMA
// ========================================

unsigned long pulseTotal = 0;
int lastPulseState = HIGH;
int consolidatedPulseState = HIGH;
unsigned long lastDebounceTime = 0;

// Controle do LED sem rotina bloqueante
bool ledActive = false;
unsigned long ledStartTime = 0;

// Controle de tempo para Heartbeat e Wi-Fi
unsigned long lastHeartbeatTime = 0;
unsigned long lastWifiAttemptTime = 0;
bool wifiConectadoNotificado = false;

// ========================================
// FUNÇÃO DE ENVIO HTTP DE TELEMETRIA
// ========================================

bool enviarTelemetria(int pulseDelta) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HTTP] Wi-Fi desconectado. Envio ignorado.");
    return false;
  }

  HTTPClient http;
  String url = "http://" + String(SERVER_HOST) + ":" + String(SERVER_PORT) +
               "/api/telemetry";

  http.begin(url);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");

  float litersTotal = pulseTotal * LITERS_PER_PULSE;
  int rssi = WiFi.RSSI();

  // Montagem do JSON no formato esperado pela API HTTP
  String payload = "{";
  payload += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"pulse_total\":" + String(pulseTotal) + ",";
  payload += "\"pulse_delta\":" + String(pulseDelta) + ",";
  payload += "\"liters_total\":" + String(litersTotal, 2) + ",";
  payload += "\"rssi\":" + String(rssi);
  payload += "}";

  Serial.println("\n------------------------------------");
  Serial.print("Enviando telemetria para ");
  Serial.println(url);
  Serial.println("Payload: " + payload);

  int httpResponseCode = http.POST(payload);

  if (httpResponseCode > 0) {
    String response = http.getString();
    Serial.print("HTTP Code: ");
    Serial.println(httpResponseCode);
    Serial.println("Resposta do servidor: " + response);
    Serial.println("Telemetria confirmada pelo servidor.");
    Serial.println("------------------------------------\n");
    http.end();
    return true;
  } else {
    Serial.print("Erro no envio HTTP: ");
    Serial.println(http.errorToString(httpResponseCode));
    Serial.println("HTTP ERROR - Contador preservado sem alterações.");
    Serial.println("------------------------------------\n");
    http.end();
    return false;
  }
}

// ========================================
// GERENCIAMENTO DA CONEXÃO WI-FI (NÃO BLOQUEANTE)
// ========================================

void verificarWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConectadoNotificado) {
      Serial.println("\nWIFI CONECTADO");
      Serial.print("SSID: ");
      Serial.println(WIFI_SSID);
      Serial.print("IP ESP32: ");
      Serial.println(WiFi.localIP());
      Serial.print("RSSI: ");
      Serial.print(WiFi.RSSI());
      Serial.println(" dBm");
      Serial.print("Servidor: http://");
      Serial.print(SERVER_HOST);
      Serial.print(":");
      Serial.print(SERVER_PORT);
      Serial.println("/api/telemetry\n");
      wifiConectadoNotificado = true;
    }
    return;
  }

  wifiConectadoNotificado = false;
  unsigned long currentMillis = millis();

  if (currentMillis - lastWifiAttemptTime >= WIFI_RECONNECT_INTERVAL_MS) {
    lastWifiAttemptTime = currentMillis;
    Serial.println("[Wi-Fi] Tentando conectar ao hotspot...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

// ========================================
// INICIALIZAÇÃO
// ========================================

void setup() {
  Serial.begin(115200);

  pinMode(PINO_PULSO, INPUT_PULLUP);
  pinMode(PINO_LED, OUTPUT);
  digitalWrite(PINO_LED, LOW);

  lastPulseState = digitalRead(PINO_PULSO);
  consolidatedPulseState = lastPulseState;

  Serial.println();
  Serial.println("====================================");
  Serial.print("TELEMETRIA HIDRICA - ");
  Serial.println(DEVICE_ID);
  Serial.println("====================================");
  Serial.print("Sensor: GPIO");
  Serial.println(PINO_PULSO);
  Serial.print("LED: GPIO");
  Serial.println(PINO_LED);
  Serial.print("Servidor: ");
  Serial.print(SERVER_HOST);
  Serial.print(":");
  Serial.println(SERVER_PORT);
  Serial.println("Aguardando Wi-Fi...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// ========================================
// LOOP PRINCIPAL
// ========================================

void loop() {
  unsigned long currentMillis = millis();

  // 1. Gerenciamento do Wi-Fi sem bloquear o loop
  verificarWifi();

  // 2. Leitura do Sensor com Debounce por Software
  int reading = digitalRead(PINO_PULSO);

  if (reading != lastPulseState) {
    lastDebounceTime = currentMillis;
  }

  if ((currentMillis - lastDebounceTime) > DEBOUNCE_MS) {
    if (reading != consolidatedPulseState) {
      consolidatedPulseState = reading;

      // Transição de HIGH -> LOW = Contato fechado com GND (Pulso Válido)
      if (consolidatedPulseState == LOW) {
        pulseTotal++;
        float litersTotal = pulseTotal * LITERS_PER_PULSE;

        // Acionar LED de confirmação (sem delay)
        digitalWrite(PINO_LED, HIGH);
        ledActive = true;
        ledStartTime = currentMillis;

        Serial.println("------------------------------------");
        Serial.println("PULSO DETECTADO");
        Serial.print("Pulsos: ");
        Serial.println(pulseTotal);
        Serial.print("Litros: ");
        Serial.print(litersTotal, 3);
        Serial.println(" L");

        // Enviar telemetria com delta 1
        enviarTelemetria(1);

        // Resetar timer do heartbeat
        lastHeartbeatTime = currentMillis;
      }
    }
  }

  lastPulseState = reading;

  // 3. Desligar LED após LED_DURATION_MS (sem delay)
  if (ledActive && (currentMillis - ledStartTime >= LED_DURATION_MS)) {
    digitalWrite(PINO_LED, LOW);
    ledActive = false;
  }

  // 4. Heartbeat Periódico (cada 10 segundos)
  if (currentMillis - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatTime = currentMillis;
    enviarTelemetria(0);
  }
}
