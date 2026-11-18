# Nexus · Cerradura

Web (PWA) para controlar la cerradura ESP32: estado en vivo, apertura con PIN, reconocimiento facial y bloqueo del teclado. Sitio estático, sin build: se publica tal cual en Vercel.

## Qué hace

- **Cerradura**: estado en vivo (Cerrada / Abierta / Bloqueada), Abrir con PIN, Cerrar, intentos fallidos del teclado y actividad.
- **Cámara**: reconoce rostros registrados y abre sola (6 s de espera entre aperturas). Registrar un rostro pide el PIN.
- **Bloqueo del teclado**: si en el teclado 4x4 de la puerta se erra el PIN **3 veces seguidas**, el ESP32 cierra la cerradura, ignora el teclado y las aperturas remotas, y la web muestra un aviso rojo. Se desbloquea **solo desde la web** con el PIN `201106`. El bloqueo queda guardado en el ESP32 aunque se corte la luz.
- Si la cerradura no responde en 12 s, la orden se cancela (no queda pendiente para ejecutarse horas después).

## Archivos

```text
index.html             interfaz
style.css              estilos (claro/oscuro automático)
js/app.js              lógica de la app
js/lock.js             conexión con Firebase
js/recognition.js      reconocimiento facial (face-api, se descarga al abrir la cámara)
sw.js                  service worker (PWA)
arduino/cerradura_esp32/cerradura_esp32.ino   firmware del ESP32 (copia idéntica en la raíz)
```

## Firebase (`/cerradura`)

| Campo | Lo escribe | Significado |
| --- | --- | --- |
| `estado` | ESP32 | `ABIERTO` o `CERRADO` |
| `metodo` | ESP32 | último cambio: `TECLADO_4X4`, `WEB`, `PIN_INCORRECTO`, `BLOQUEO_TECLADO`, `DESBLOQUEO_WEB`, `INICIO` |
| `bloqueado` | ESP32 | `true` tras 3 PIN incorrectos |
| `intentos` | ESP32 | PIN incorrectos seguidos (0–3) |
| `comando_abrir` / `comando_cerrar` / `comando_desbloquear` | Web | órdenes; el ESP32 las ejecuta y las vuelve a `false` |

## Firmware

Hay que **volver a cargar el `.ino` al ESP32** (Arduino IDE, placa "ESP32 Dev Module") para que funcione el bloqueo. Librerías: ESP32Servo y Keypad (`Preferences` viene con el núcleo ESP32).

Teclado: `201106#` abre · `*` cierra · `*` con la cerradura cerrada borra lo escrito.

## Instalar en el celular

- iPhone (Safari): Compartir → Agregar a inicio.
- Android (Chrome): menú ⋮ → Instalar aplicación.
