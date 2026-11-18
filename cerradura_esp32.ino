// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  NEXUS-7 — Cerradura Inteligente IoT (v8.0 · bloqueo por intentos)        ║
// ║  ESP32 + Matriz 4x4 (Core 1) + Firebase HTTPS en segundo plano (Core 0)   ║
// ║  • PIN maestro: "201106" + '#'  -> abre (queda abierta)                   ║
// ║  • '*' o 'D' con la cerradura abierta -> cierra                           ║
// ║  • 3 PIN incorrectos seguidos en el teclado -> TECLADO BLOQUEADO:         ║
// ║      cierra la cerradura, ignora el teclado y las aperturas remotas        ║
// ║      hasta que la web envíe "comando_desbloquear" (PIN 201106 en la web). ║
// ║      El bloqueo se guarda en memoria (NVS): sobrevive a un corte de luz.  ║
// ║  • Servo calibrado: CERRADO = 180° / ABIERTO = 0°                         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>
#include <Keypad.h>
#include <Preferences.h>

// ────────────────────────────────────────────────────────────
//  1. WI-FI
// ────────────────────────────────────────────────────────────
const char* ssid     = "Estudiantes";
const char* password = "educar_2018";

// ────────────────────────────────────────────────────────────
//  2. FIREBASE REALTIME DATABASE
// ────────────────────────────────────────────────────────────
const String FIREBASE_HOST = "https://nexus-cerradura-default-rtdb.firebaseio.com";

// ────────────────────────────────────────────────────────────
//  3. SERVO Y LEDS
// ────────────────────────────────────────────────────────────
#define PIN_SERVO 18
Servo miServo;
const int ANGULO_CERRADO = 180;
const int ANGULO_ABIERTO = 0;

#define LED_ROJO  15  // Cerrado / alarma
#define LED_VERDE  2  // Abierto / acceso OK

// ────────────────────────────────────────────────────────────
//  4. TECLADO 4x4
// ────────────────────────────────────────────────────────────
const byte FILAS = 4;
const byte COLUMNAS = 4;
char teclas[FILAS][COLUMNAS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};
byte pinesFilas[FILAS]       = {19, 21, 22, 23};
byte pinesColumnas[COLUMNAS] = {25, 26, 27, 32};
Keypad teclado = Keypad(makeKeymap(teclas), pinesFilas, pinesColumnas, FILAS, COLUMNAS);

const String CLAVE_MAESTRA = "201106";
const int    MAX_INTENTOS  = 3;
String bufferClave = "";

// ────────────────────────────────────────────────────────────
//  5. ESTADO (Core 1 escribe, Core 0 lee a través de un snapshot protegido)
// ────────────────────────────────────────────────────────────
Preferences memoria;           // NVS: guarda bloqueo e intentos

bool   abierta          = false;
bool   tecladoBloqueado = false;
int    intentosFallidos = 0;
String metodoAcceso     = "INICIO";

// Órdenes que llegan desde la web (Core 0 -> Core 1)
volatile bool ordenWebAbrir       = false;
volatile bool ordenWebCerrar      = false;
volatile bool ordenWebDesbloquear = false;

// Snapshot para Firebase (Core 1 -> Core 0)
portMUX_TYPE  muxSync = portMUX_INITIALIZER_UNLOCKED;
char          cuerpoPendiente[200];
volatile bool syncPendiente = false;

// Copias que Core 0 puede leer sin tocar Strings de Core 1
volatile bool vistaAbierta  = false;
volatile bool vistaBloqueo  = false;

TaskHandle_t tareaRedHandle = NULL;

// ════════════════════════════════════════════════════════════
//  UTILIDADES
// ════════════════════════════════════════════════════════════
void moverServo(int angulo) {
  miServo.setPeriodHertz(50);
  miServo.attach(PIN_SERVO, 500, 2400);
  miServo.write(angulo);
  delay(500);
  miServo.detach(); // sin pulsos PWM: sin vibración ni calor
}

void parpadear(int pin, int veces, int ms, bool terminarEncendido) {
  for (int i = 0; i < veces; i++) {
    digitalWrite(pin, !terminarEncendido); delay(ms);
    digitalWrite(pin,  terminarEncendido); delay(ms);
  }
}

void guardarMemoria() {
  memoria.putBool("bloqueo", tecladoBloqueado);
  memoria.putInt("intentos", intentosFallidos);
}

// Prepara el JSON con el estado completo y avisa a Core 0 que lo envíe
void pedirSync() {
  char cuerpo[200];
  snprintf(cuerpo, sizeof(cuerpo),
    "{\"estado\":\"%s\",\"metodo\":\"%s\",\"bloqueado\":%s,\"intentos\":%d}",
    abierta ? "ABIERTO" : "CERRADO",
    metodoAcceso.c_str(),
    tecladoBloqueado ? "true" : "false",
    intentosFallidos);

  portENTER_CRITICAL(&muxSync);
  strncpy(cuerpoPendiente, cuerpo, sizeof(cuerpoPendiente) - 1);
  cuerpoPendiente[sizeof(cuerpoPendiente) - 1] = '\0';
  syncPendiente = true;
  vistaAbierta  = abierta;
  vistaBloqueo  = tecladoBloqueado;
  portEXIT_CRITICAL(&muxSync);
}

// ════════════════════════════════════════════════════════════
//  ACCIONES (Core 1)
// ════════════════════════════════════════════════════════════
void abrirCerradura(const char* metodo) {
  metodoAcceso = metodo;
  abierta = true;
  digitalWrite(LED_ROJO,  LOW);
  digitalWrite(LED_VERDE, HIGH);
  moverServo(ANGULO_ABIERTO);
  pedirSync();
  Serial.printf("🔓 ABIERTO — Método: %s\n", metodo);
}

void cerrarCerradura(const char* metodo) {
  metodoAcceso = metodo;
  abierta = false;
  bufferClave = "";
  digitalWrite(LED_ROJO,  HIGH);
  digitalWrite(LED_VERDE, LOW);
  moverServo(ANGULO_CERRADO);
  pedirSync();
  Serial.println("🔒 Cerradura cerrada.");
}

void bloquearTeclado() {
  tecladoBloqueado = true;
  guardarMemoria();
  Serial.println("⛔ 3 PIN incorrectos: TECLADO BLOQUEADO. Desbloquear desde la web.");
  if (abierta) {
    cerrarCerradura("BLOQUEO_TECLADO");   // ya hace pedirSync()
  } else {
    metodoAcceso = "BLOQUEO_TECLADO";
    pedirSync();
  }
  parpadear(LED_ROJO, 6, 70, true);
}

void desbloquearTeclado() {
  tecladoBloqueado = false;
  intentosFallidos = 0;
  bufferClave = "";
  metodoAcceso = "DESBLOQUEO_WEB";
  guardarMemoria();
  pedirSync();
  parpadear(LED_VERDE, 3, 90, false);
  Serial.println("✅ Teclado desbloqueado desde la web.");
}

// ════════════════════════════════════════════════════════════
//  TECLADO (Core 1, tiempo real)
// ════════════════════════════════════════════════════════════
void procesarTeclado() {
  char tecla = teclado.getKey();
  if (!tecla) return;

  // Bloqueado: el teclado no hace nada, solo avisa con el LED rojo
  if (tecladoBloqueado) {
    Serial.println("⛔ Teclado bloqueado: tecla ignorada.");
    parpadear(LED_ROJO, 2, 60, true);
    return;
  }

  // Abierta: '*' o 'D' cierra
  if (abierta && (tecla == '*' || tecla == 'D')) {
    cerrarCerradura("TECLADO_4X4");
    return;
  }

  // '*' borra lo escrito
  if (tecla == '*') {
    bufferClave = "";
    parpadear(LED_ROJO, 1, 80, true);
    return;
  }

  // '#' confirma
  if (tecla == '#') {
    if (bufferClave.length() == 0) return; // '#' suelto no cuenta como intento

    if (bufferClave == CLAVE_MAESTRA) {
      Serial.println("✅ PIN correcto.");
      bool habiaErrores = intentosFallidos > 0;
      intentosFallidos = 0;
      if (habiaErrores) guardarMemoria();
      parpadear(LED_VERDE, 2, 60, false);
      if (!abierta) abrirCerradura("TECLADO_4X4");
      else pedirSync();
    } else {
      intentosFallidos++;
      guardarMemoria();
      Serial.printf("⛔ PIN incorrecto (%d de %d).\n", intentosFallidos, MAX_INTENTOS);
      parpadear(LED_ROJO, 3, 80, true);
      if (intentosFallidos >= MAX_INTENTOS) {
        bloquearTeclado();
      } else {
        metodoAcceso = "PIN_INCORRECTO";
        pedirSync();
      }
    }
    bufferClave = "";
    return;
  }

  // Dígitos y letras
  if (bufferClave.length() < 10) {
    bufferClave += tecla;
    digitalWrite(LED_VERDE, HIGH);
    delay(15);
    digitalWrite(LED_VERDE, abierta ? HIGH : LOW);
  }
}

// ════════════════════════════════════════════════════════════
//  RED (Core 0)
// ════════════════════════════════════════════════════════════
void enviarSnapshot() {
  char cuerpo[200];
  portENTER_CRITICAL(&muxSync);
  strncpy(cuerpo, cuerpoPendiente, sizeof(cuerpo));
  syncPendiente = false;
  portEXIT_CRITICAL(&muxSync);

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(2);
  HTTPClient https;
  https.setTimeout(2000);
  if (https.begin(client, FIREBASE_HOST + "/cerradura.json")) {
    https.addHeader("Content-Type", "application/json");
    int code = https.PATCH(String(cuerpo));
    https.end();
    if (code != 200) {
      // reintentar en la próxima vuelta
      portENTER_CRITICAL(&muxSync);
      syncPendiente = true;
      portEXIT_CRITICAL(&muxSync);
    }
  }
}

// Lee /cerradura/<nombre>; si vale true lo vuelve a false y devuelve true
bool consumirComando(const char* nombre) {
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(2);
  HTTPClient https;
  https.setTimeout(2000);

  String url = FIREBASE_HOST + "/cerradura/" + nombre + ".json";
  if (!https.begin(client, url)) return false;
  int code = https.GET();
  String payload = code == 200 ? https.getString() : "";
  https.end();
  payload.trim();
  if (payload != "true") return false;

  if (https.begin(client, url)) {
    https.addHeader("Content-Type", "application/json");
    https.PUT("false");
    https.end();
  }
  return true;
}

void verificarComandos() {
  bool bloqueo, abiertaAhora;
  portENTER_CRITICAL(&muxSync);
  bloqueo = vistaBloqueo;
  abiertaAhora = vistaAbierta;
  portEXIT_CRITICAL(&muxSync);

  if (bloqueo) {
    // Mientras está bloqueada solo se acepta el desbloqueo
    if (consumirComando("comando_desbloquear")) {
      Serial.println("🌐 [WEB] Orden de DESBLOQUEO recibida.");
      ordenWebDesbloquear = true;
    }
    return;
  }

  if (!abiertaAhora) {
    if (consumirComando("comando_abrir")) {
      Serial.println("🌐 [WEB] Orden de APERTURA recibida.");
      ordenWebAbrir = true;
    }
  } else {
    if (consumirComando("comando_cerrar")) {
      Serial.println("🌐 [WEB] Orden de CIERRE recibida.");
      ordenWebCerrar = true;
    }
  }
}

void tareaRedCore0(void *pvParameters) {
  for (;;) {
    if (WiFi.status() == WL_CONNECTED) {
      if (syncPendiente) enviarSnapshot();
      verificarComandos();
    }
    vTaskDelay(pdMS_TO_TICKS(1200));
  }
}

// ════════════════════════════════════════════════════════════
//  SETUP
// ════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(LED_ROJO,  OUTPUT);
  pinMode(LED_VERDE, OUTPUT);
  digitalWrite(LED_ROJO,  HIGH);
  digitalWrite(LED_VERDE, LOW);

  moverServo(ANGULO_CERRADO);

  teclado.setDebounceTime(25);
  teclado.setHoldTime(400);

  // Recuperar bloqueo e intentos (un corte de luz no borra el bloqueo)
  memoria.begin("cerradura", false);
  tecladoBloqueado = memoria.getBool("bloqueo", false);
  intentosFallidos = memoria.getInt("intentos", 0);
  metodoAcceso     = tecladoBloqueado ? "BLOQUEO_TECLADO" : "INICIO";

  Serial.println("\n╔══════════════════════════════════════════════╗");
  Serial.println("║  NEXUS-7 v8 — bloqueo tras 3 PIN incorrectos ║");
  Serial.println("╚══════════════════════════════════════════════╝");
  if (tecladoBloqueado) Serial.println("⛔ Arranca con el teclado BLOQUEADO (desbloquear desde la web).");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  Serial.printf("Conectando a Wi-Fi: %s", ssid);
  WiFi.begin(ssid, password);
  int intentosWifi = 0;
  while (WiFi.status() != WL_CONNECTED && intentosWifi < 20) {
    delay(300);
    Serial.print(".");
    intentosWifi++;
  }
  Serial.println(WiFi.status() == WL_CONNECTED
    ? "\nWi-Fi conectado."
    : "\nSin Wi-Fi: funciona solo con el teclado.");

  pedirSync(); // publica el estado inicial (incluye bloqueo e intentos)

  xTaskCreatePinnedToCore(tareaRedCore0, "TareaRed", 8192, NULL, 1, &tareaRedHandle, 0);
  Serial.println("Listo. Abre con [201106#], cierra con [*].\n");
}

// ════════════════════════════════════════════════════════════
//  LOOP (Core 1)
// ════════════════════════════════════════════════════════════
void loop() {
  procesarTeclado();

  if (ordenWebDesbloquear) {
    ordenWebDesbloquear = false;
    if (tecladoBloqueado) desbloquearTeclado();
  }
  if (ordenWebAbrir) {
    ordenWebAbrir = false;
    if (!tecladoBloqueado && !abierta) abrirCerradura("WEB");
  }
  if (ordenWebCerrar) {
    ordenWebCerrar = false;
    if (abierta) cerrarCerradura("WEB");
  }

  yield();
}
