// ===================================================================
// MONITOR DE CRISE - ESP32 + MPU6050 + MAX30102
// ===================================================================
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <MAX30105.h>     // SparkFun MAX3010x library (funciona com MAX30102)
#include <heartRate.h>    // Algoritmo de detecção de batimento da SparkFun (mesma biblioteca)

// -------------------------------------------------------------------
// PINOS
// -------------------------------------------------------------------
#define BUZZER_PIN  18
#define BUTTON_PIN  19
#define LED_STATUS  2

// -------------------------------------------------------------------
// PARÂMETROS
// -------------------------------------------------------------------
const float         LIMIAR_QUEDA          = 25.0;   // m/s² (~2,5g)
const unsigned long JANELA_CANCELAMENTO   = 3000;   // ms
const unsigned long INTERVALO_ENTRE_ALERTAS = 15000; // ms
const unsigned long INTERVALO_TELEMETRIA  = 10000;  // ms (10s economiza dados do chip 4G)
const unsigned long INTERVALO_RECONEXAO   = 10000;  // ms
const long          IR_MINIMO_PELE        = 50000;  // abaixo disso: sensor fora da pele

// -------------------------------------------------------------------
// OBJETOS DOS SENSORES
// -------------------------------------------------------------------
Adafruit_MPU6050 mpu;
MAX30105 sensorBatimento;

// -------------------------------------------------------------------
// CONFIGURAÇÕES DE REDE (Roteador Portátil)
// -------------------------------------------------------------------
const char* ssid     = "4G-UFI-9708";
const char* password = "1234567890";

// Servidor no seu PC: use o IP que o servidor mostra ao iniciar, ex.:
//   "http://192.168.100.25:3000/api/dados"
// Servidor publicado no Render: use o endereço dele, ex.:
//   "https://monitor-crise.onrender.com/api/dados"
String serverDados  = "http://192.168.43.100:3000/api/dados";
String serverAlerta = "http://192.168.43.100:3000/api/alerta";

// -------------------------------------------------------------------
// ESTADO DO CÁLCULO DE BPM
// -------------------------------------------------------------------
const byte TAMANHO_MEDIA = 4;
byte leiturasBpm[TAMANHO_MEDIA];
byte posLeitura = 0;
byte leiturasValidas = 0;
unsigned long ultimoBatimento = 0;
int bpmMedio = 0;   // 0 = ainda sem leitura confiável

// -------------------------------------------------------------------
// CONTROLE DE TEMPO
// -------------------------------------------------------------------
unsigned long ultimoAlerta = 0;
unsigned long ultimaTelemetria = 0;
unsigned long ultimaTentativaWiFi = 0;
bool jaHouveAlerta = false;

// -------------------------------------------------------------------
// FUNÇÃO AUXILIAR: BIPES NO BUZZER
// -------------------------------------------------------------------
void emitirBipe(int frequencia, int duracaoMs, int repeticoes) {
  for (int i = 0; i < repeticoes; i++) {
    tone(BUZZER_PIN, frequencia, duracaoMs);
    delay(duracaoMs + 50);
  }
}

// Espera o botão ser solto (evita que um cancelamento vire pânico)
void aguardarSoltarBotao() {
  while (digitalRead(BUTTON_PIN) == LOW) {
    delay(10);
  }
  delay(50); // debounce da soltura
}

// -------------------------------------------------------------------
// WI-FI
// -------------------------------------------------------------------
void conectarWiFi(unsigned long timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Conectando ao Roteador Portátil");

  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < timeoutMs) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWi-Fi conectado. IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\nWi-Fi indisponível. Tentarei novamente no loop.");
  }
}

void manterWiFi() {
  if (WiFi.status() != WL_CONNECTED &&
      millis() - ultimaTentativaWiFi > INTERVALO_RECONEXAO) {
    ultimaTentativaWiFi = millis();
    Serial.println("Wi-Fi caiu. Tentando reconectar...");
    WiFi.reconnect();
  }
}

// -------------------------------------------------------------------
// HTTP
// -------------------------------------------------------------------
bool enviarJSON(const String& url, const String& json) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  WiFiClient clienteSimples;
  WiFiClientSecure clienteSeguro;

  if (url.startsWith("https")) {
    clienteSeguro.setInsecure(); // não valida o certificado (aceitável para protótipo)
    http.begin(clienteSeguro, url);
  } else {
    http.begin(clienteSimples, url);
  }

  http.setTimeout(10000); // servidor na nuvem pode demorar mais para responder
  http.addHeader("Content-Type", "application/json");
  int codigo = http.POST(json);
  http.end();

  if (codigo > 0) return true;

  Serial.println("Erro HTTP: " + String(codigo));
  return false;
}

void enviarAlertaHTTP(const String& motivo, int bpm, float aceleracao) {
  // bpm = 0 significa "sem leitura" e vai como null no JSON
  String campoBpm = (bpm > 0) ? String(bpm) : "null";

  String jsonAlerta = "{\"tipo\":\"EMERGENCIA\",\"mensagem\":\"" + motivo +
                      "\",\"batimentos\":" + campoBpm +
                      ",\"aceleracao\":" + String(aceleracao, 2) + "}";

  // Alerta é crítico: até 3 tentativas
  for (int tentativa = 1; tentativa <= 3; tentativa++) {
    if (enviarJSON(serverAlerta, jsonAlerta)) {
      Serial.println("ALERTA ENVIADO: " + jsonAlerta);
      return;
    }
    Serial.println("Falha no envio do alerta (tentativa " + String(tentativa) + ")");
    delay(500);
  }
  Serial.println("ALERTA NÃO ENTREGUE após 3 tentativas!");
  emitirBipe(400, 500, 2); // aviso sonoro de falha
}

// -------------------------------------------------------------------
// CÁLCULO DE BPM (precisa ser chamado com frequência)
// -------------------------------------------------------------------
void atualizarBPM(long irValue) {
  if (irValue < IR_MINIMO_PELE) {
    bpmMedio = 0;
    leiturasValidas = 0;
    return;
  }

  if (checkForBeat(irValue)) {
    unsigned long agora = millis();
    unsigned long delta = agora - ultimoBatimento;
    ultimoBatimento = agora;

    float bpm = 60.0 / (delta / 1000.0);
    if (bpm > 30 && bpm < 220) {
      leiturasBpm[posLeitura] = (byte)bpm;
      posLeitura = (posLeitura + 1) % TAMANHO_MEDIA;
      if (leiturasValidas < TAMANHO_MEDIA) leiturasValidas++;

      int soma = 0;
      for (byte i = 0; i < leiturasValidas; i++) soma += leiturasBpm[i];
      bpmMedio = soma / leiturasValidas;
    }
  }
}

// -------------------------------------------------------------------
// SETUP
// -------------------------------------------------------------------
void setup() {
  Serial.begin(115200);

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_STATUS, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  digitalWrite(LED_STATUS, HIGH);
  emitirBipe(2000, 100, 2);

  Wire.begin(21, 22);

  // MPU-6050
  if (!mpu.begin()) {
    Serial.println("MPU6050 não localizado no barramento I2C!");
  } else {
    // Padrão da biblioteca é ±2g (~19,6 m/s²), que satura antes do limiar de 25 m/s²
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    Serial.println("MPU6050 inicializado (faixa ±8g).");
  }

  // MAX30102
  if (!sensorBatimento.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30102 não localizado no barramento I2C!");
  } else {
    sensorBatimento.setup();                      // liga LEDs e configura amostragem
    sensorBatimento.setPulseAmplitudeRed(0x0A);   // LED vermelho baixo = indica funcionamento
    sensorBatimento.setPulseAmplitudeGreen(0);    // LED verde desligado
    Serial.println("MAX30102 inicializado.");
  }

  conectarWiFi(15000); // não trava para sempre se não houver rede
}

// -------------------------------------------------------------------
// LOOP PRINCIPAL
// -------------------------------------------------------------------
void loop() {
  manterWiFi();

  // 1. BOTÃO DE PÂNICO (com debounce)
  if (digitalRead(BUTTON_PIN) == LOW) {
    delay(50);
    if (digitalRead(BUTTON_PIN) == LOW) {
      emitirBipe(2500, 200, 3);
      Serial.println("BOTÃO DE PÂNICO APERTADO!");
      enviarAlertaHTTP("Botão de emergência acionado manualmente pelo usuário!",
                       bpmMedio, 0.0);
      aguardarSoltarBotao();
    }
  }

  // 2. LEITURA DOS SENSORES
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  float aceleracaoTotal = sqrt(a.acceleration.x * a.acceleration.x +
                               a.acceleration.y * a.acceleration.y +
                               a.acceleration.z * a.acceleration.z);

  long irValue = sensorBatimento.getIR();
  atualizarBPM(irValue);

  // 3. DETECÇÃO DE QUEDA / TREMOR FORTE (com intervalo mínimo entre alertas)
  bool podeAlertar = !jaHouveAlerta || (millis() - ultimoAlerta > INTERVALO_ENTRE_ALERTAS);

  if (aceleracaoTotal > LIMIAR_QUEDA && podeAlertar) {
    Serial.println("Anomalia detectada! Janela de cancelamento de 3s...");

    bool cancelado = false;
    unsigned long inicio = millis();

    while (millis() - inicio < JANELA_CANCELAMENTO) {
      tone(BUZZER_PIN, 1800, 100);
      delay(150);

      if (digitalRead(BUTTON_PIN) == LOW) {
        cancelado = true;
        noTone(BUZZER_PIN);
        Serial.println("Alerta cancelado pelo usuário.");
        emitirBipe(800, 300, 1);
        aguardarSoltarBotao(); // impede que o mesmo toque vire pânico
        break;
      }
    }

    if (!cancelado) {
      enviarAlertaHTTP("Tremor forte / Queda detectada!", bpmMedio, aceleracaoTotal);
    }

    ultimoAlerta = millis();
    jaHouveAlerta = true;
  }

  // 4. TELEMETRIA PERIÓDICA (só com sensor na pele)
  if (irValue > IR_MINIMO_PELE &&
      millis() - ultimaTelemetria >= INTERVALO_TELEMETRIA) {
    ultimaTelemetria = millis();

    String campoBpm = (bpmMedio > 0) ? String(bpmMedio) : "null";
    String jsonDados = "{\"batimentos\":" + campoBpm +
                       ",\"aceleracao\":" + String(aceleracaoTotal, 2) + "}";

    if (enviarJSON(serverDados, jsonDados)) {
      Serial.println("Telemetria enviada: " + jsonDados);
    }
  }
}
