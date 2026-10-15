// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  NEXUS-7 — Cerradura Inteligente Autónoma (v4.0 IoT Cloud)               ║
// ║  ESP32 + RFID RC522 + Servo + Telegram Bot + Sincronización Firebase    ║
// ║  Core 0: Tarea Segura Telegram | Core 1: Sensores, Servo y Firebase REST ║
// ║  (Teclado y WebServer local eliminados — 100% Autónomo a 5V)           ║
// ╚══════════════════════════════════════════════════════════════════════════╝

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ArduinoJson.h>
#include <UniversalTelegramBot.h>

// ────────────────────────────────────────────────────────────
//  1. CONFIGURACIÓN WI-FI
// ────────────────────────────────────────────────────────────
const char* ssid     = "Estudiantes";
const char* password = "educar_2018";

// ────────────────────────────────────────────────────────────
//  2. CONFIGURACIÓN FIREBASE REALTIME DATABASE (OPCIÓN 2)
//  (Reemplaza con la URL de tu base de datos de Firebase)
// ────────────────────────────────────────────────────────────
const String FIREBASE_HOST = "https://TU_PROYECTO-default-rtdb.firebaseio.com";

// ────────────────────────────────────────────────────────────
//  3. TELEGRAM BOT (CORE 0)
// ────────────────────────────────────────────────────────────
#define BOT_TOKEN "8666531292:AAEbz8E8FHfgvheELbMyETtH_YrtYgQfoCc"
#define CHAT_ID "7925238559"

WiFiClientSecure client_secure;
UniversalTelegramBot bot(BOT_TOKEN, client_secure);

// Cola segura de mensajes y Mutex de FreeRTOS
const int MAX_MENSAJES = 5;
String colaMensajes[MAX_MENSAJES];
int colaHead = 0;
int colaTail = 0;
int colaCount = 0;
SemaphoreHandle_t mutexCerradura;

// ────────────────────────────────────────────────────────────
//  4. HARDWARE: SERVO & RFID & LEDS
// ────────────────────────────────────────────────────────────
Servo miServo;
#define PIN_SERVO 4

#define SS_PIN  5
#define RST_PIN 22
MFRC522 mfrc522(SS_PIN, RST_PIN);
byte usuarioAutorizado[4] = {0x62, 0x55, 0x14, 0x5C}; // UID tarjeta autorizada

#define LED_ROJO  15
#define LED_VERDE  2

// ────────────────────────────────────────────────────────────
//  5. ESTADOS Y TIEMPOS
// ────────────────────────────────────────────────────────────
String estadoCerradura = "CERRADO";
String metodoAcceso    = "---";

unsigned long tiempoApertura       = 0;
const unsigned long TIEMPO_ABIERTO = 5000UL; // Cierre automático a los 5s

// Temporizador para consultar Firebase
unsigned long ultimoCheckFirebase   = 0;
const unsigned long INTERVALO_CHECK = 1200UL; // Cada 1.2 segundos

// Modo RFID Libre (Bypass 60 segundos)
bool         rfidLibre      = false;
unsigned long tRfidLibre    = 0;
const unsigned long DUR_RFID_LIBRE = 60000UL;

// Declaraciones adelantadas
void abrirCerradura(const char* metodo);
void cerrarCerradura();
void actualizarFirebase(const String& estado, const String& metodo);
void verificarComandoFirebase();

// ════════════════════════════════════════════════════════════
//  TELEGRAM (COLA Y TAREA EN CORE 0)
// ════════════════════════════════════════════════════════════
void agregarMensajeCola(const String& mensaje) {
  xSemaphoreTake(mutexCerradura, portMAX_DELAY);
  if (colaCount < MAX_MENSAJES) {
    colaMensajes[colaHead] = mensaje;
    colaHead = (colaHead + 1) % MAX_MENSAJES;
    colaCount++;
  }
  xSemaphoreGive(mutexCerradura);
}

void enviarAlertaTelegram(const String& mensaje) {
  agregarMensajeCola(mensaje);
}

void telegramTask(void* parameter) {
  delay(2000);
  client_secure.setInsecure(); // No validar certificados SSL para ahorrar RAM
  
  while (true) {
    vTaskDelay(1000 / portTICK_PERIOD_MS); 
    
    if (WiFi.status() == WL_CONNECTED) {
      // 1. Enviar alertas pendientes
      bool hayMensaje = false;
      String mensajeAEnviar = "";

      xSemaphoreTake(mutexCerradura, portMAX_DELAY);
      if (colaCount > 0) {
        mensajeAEnviar = colaMensajes[colaTail];
        hayMensaje = true;
      }
      xSemaphoreGive(mutexCerradura);

      if (hayMensaje) {
        bool ok = bot.sendMessage(CHAT_ID, mensajeAEnviar, "");
        if (ok) {
          xSemaphoreTake(mutexCerradura, portMAX_DELAY);
          colaTail = (colaTail + 1) % MAX_MENSAJES;
          colaCount--;
          xSemaphoreGive(mutexCerradura);
        } else {
          vTaskDelay(1000 / portTICK_PERIOD_MS);
          continue;
        }
      }
      
      // 2. Escuchar comandos remotos de Telegram
      int numMensajes = bot.getUpdates(bot.last_message_received + 1);
      while (numMensajes) {
        for (int i = 0; i < numMensajes; i++) {
          telegramMessage msg = bot.messages[i];
          String chat_id = msg.chat_id;
          String text = msg.text;

          if (text == "/start") {
            String welcome = "🔐 *NEXUS-7 Control Remoto*\n\nSelecciona una acción:";
            String keyboardJson = "[[{\"text\":\"🔓 Abrir Puerta\",\"callback_data\":\"abrir\"},{\"text\":\"🔒 Cerrar Puerta\",\"callback_data\":\"cerrar\"}]]";
            bot.sendMessageWithInlineKeyboard(chat_id, welcome, "", keyboardJson);

          } else if (msg.type == "callback_query") {
            String callbackData = msg.text;
            if (callbackData == "abrir") {
              abrirCerradura("TELEGRAM");
              bot.sendMessage(CHAT_ID, "✅ Puerta abierta desde Telegram", "");
            } else if (callbackData == "cerrar") {
              cerrarCerradura();
              bot.sendMessage(CHAT_ID, "✅ Puerta cerrada desde Telegram", "");
            }
          }
        }
        numMensajes = bot.getUpdates(bot.last_message_received + 1);
      }
    }
    yield();
  }
}

// ════════════════════════════════════════════════════════════
//  SINCRONIZACIÓN CON FIREBASE (NUBE)
// ════════════════════════════════════════════════════════════
void actualizarFirebase(const String& estado, const String& metodo) {
  if (WiFi.status() != WL_CONNECTED || FIREBASE_HOST.indexOf("TU_PROYECTO") >= 0) return;
  
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;

  String url = FIREBASE_HOST + "/cerradura.json";
  if (https.begin(client, url)) {
    https.addHeader("Content-Type", "application/json");
    String body = "{\"estado\":\"" + estado + "\",\"metodo\":\"" + metodo + "\"}";
    https.PATCH(body);
    https.end();
  }
}

void verificarComandoFirebase() {
  if (WiFi.status() != WL_CONNECTED || FIREBASE_HOST.indexOf("TU_PROYECTO") >= 0) return;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;

  String url = FIREBASE_HOST + "/cerradura/comando_abrir.json";
  if (https.begin(client, url)) {
    int httpCode = https.GET();
    if (httpCode == 200) {
      String payload = https.getString();
      if (payload == "true") {
        Serial.println("🌐 [VERCEL] Orden de apertura remota recibida desde Firebase");
        
        // Resetear la orden a false inmediatamente
        https.begin(client, url);
        https.addHeader("Content-Type", "application/json");
        https.PUT("false");
        
        abrirCerradura("WEB_VERCEL");
      }
    }
    https.end();
  }
}

// ════════════════════════════════════════════════════════════
//  CONTROL DE CERRADURA (SERVO Y LEDS)
// ════════════════════════════════════════════════════════════
void abrirCerradura(const char* metodo) {
  metodoAcceso    = metodo;
  estadoCerradura = "ABIERTO";
  
  miServo.write(180); // Giro de apertura
  digitalWrite(LED_ROJO,  LOW);
  digitalWrite(LED_VERDE, HIGH);
  tiempoApertura = millis();

  // Actualizar la nube para que la web en Vercel se ponga en verde
  actualizarFirebase("ABIERTO", metodoAcceso);

  // Notificar al bot de Telegram
  String notif = "🔓 *Puerta abierta*\nMétodo: ";
  notif += metodo;
  enviarAlertaTelegram(notif);
  
  Serial.print("ABIERTO — Método: "); Serial.println(metodo);
}

void cerrarCerradura() {
  estadoCerradura = "CERRADO";
  
  miServo.write(0); // Giro de bloqueo
  digitalWrite(LED_ROJO,  HIGH);
  digitalWrite(LED_VERDE, LOW);

  // Actualizar la nube para que la web en Vercel se ponga en rojo
  actualizarFirebase("CERRADO", metodoAcceso);
  Serial.println("Cerradura cerrada.");
}

// ════════════════════════════════════════════════════════════
//  SETUP
// ════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(1000);

  mutexCerradura = xSemaphoreCreateMutex();

  pinMode(LED_ROJO,  OUTPUT);
  pinMode(LED_VERDE, OUTPUT);
  digitalWrite(LED_ROJO,  HIGH);
  digitalWrite(LED_VERDE, LOW);

  miServo.attach(PIN_SERVO);
  miServo.write(0); // Posición inicial cerrada

  SPI.begin();
  mfrc522.PCD_Init();
  Serial.println("\n--- INICIANDO NEXUS-7 ---");

  // Conexión Wi-Fi
  Serial.printf("Conectando a Wi-Fi: %s\n", ssid);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWi-Fi Conectado — IP: %s\n", WiFi.localIP().toString().c_str());

  // Estado inicial en la nube
  actualizarFirebase("CERRADO", "INICIO");

  // Crear Tarea de Telegram en CORE 0
  xTaskCreatePinnedToCore(
    telegramTask,
    "TelegramTask",
    8192,
    NULL,
    1,
    NULL,
    0 // Core 0 dedicado
  );

  Serial.println("Sistema sincronizado. Listo para operar.\n");
}

// ════════════════════════════════════════════════════════════
//  LOOP PRINCIPAL (CORE 1)
// ════════════════════════════════════════════════════════════
void loop() {
  unsigned long ahora = millis();

  // 1. Consultar comandos remotos desde la web de Vercel
  if (ahora - ultimoCheckFirebase >= INTERVALO_CHECK) {
    ultimoCheckFirebase = ahora;
    verificarComandoFirebase();
  }

  // 2. Cierre automático no bloqueante tras 5 segundos
  if (estadoCerradura == "ABIERTO" && (ahora - tiempoApertura >= TIEMPO_ABIERTO)) {
    cerrarCerradura();
  }

  // 3. Expiración de modo RFID Libre (Bypass)
  if (rfidLibre && (ahora - tRfidLibre >= DUR_RFID_LIBRE)) {
    rfidLibre = false;
    Serial.println("[RFID] Bypass de 60s finalizado.");
  }

  // 4. Lectura de tarjeta RFID física
  if (mfrc522.PICC_IsNewCardPresent() && mfrc522.PICC_ReadCardSerial()) {
    Serial.print("Tarjeta detectada. UID:");
    for (byte i = 0; i < mfrc522.uid.size; i++) {
      Serial.printf(" %02X", mfrc522.uid.uidByte[i]);
    }
    Serial.println();

    if (rfidLibre) {
      abrirCerradura("RFID_LIBRE");
    } else {
      bool autorizada = (mfrc522.uid.size == 4);
      for (byte i = 0; i < 4 && autorizada; i++) {
        if (mfrc522.uid.uidByte[i] != usuarioAutorizado[i]) autorizada = false;
      }

      if (autorizada) {
        abrirCerradura("RFID");
      } else {
        Serial.println("RFID DENEGADO.");
        digitalWrite(LED_ROJO, LOW); delay(150); digitalWrite(LED_ROJO, HIGH);
      }
    }

    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
  }

  yield();
}
