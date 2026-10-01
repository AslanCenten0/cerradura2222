# 👁️ Nexus Access — Biometría Facial & Web Bluetooth PWA
**Sistema de Control de Acceso Biométrico 100% en Cliente (JavaScript) + Web Bluetooth API**

Aplicación web progresiva (**PWA**) minimalista lista para desplegar en **Vercel** y subir a **GitHub**. Permite escanear rostros en tiempo real desde cualquier dispositivo (iPhone, Android o PC), comparar descriptores biométricos neuronales de 128 dimensiones de forma privada en el navegador, y enviar la señal de apertura a un ESP32 mediante **Web Bluetooth API**.

---

## ⚡ Características Principales

1. **Reconocimiento Facial en Cliente (100% Privado):**
   - Basado en `@vladmandic/face-api` (TensorFlow.js en WebGL).
   - Detección ultrarrápida a **30-60 FPS** optimizada para móviles con `TinyFaceDetector`.
   - Extracción de vectores faciales de 128 dimensiones y comparación euclidiana en milisegundos.
   - **Enrolamiento en vivo:** Permite registrar nuevos rostros directamente desde la cámara con un clic, almacenándolos en el `localStorage` del dispositivo.

2. **Conexión Directa por Web Bluetooth API (BLE):**
   - Se comunica directamente desde el navegador con el ESP32 (GATT Nordic UART Service) sin pasar por ningún servidor intermedio.
   - **Modo Simulación Integrado:** Si aún no tienes el ESP32 conectado, la app activa automáticamente un simulador para que puedas probar todo el flujo de reconocimiento y apertura.

3. **PWA (Progressive Web App):**
   - **En iPhone (iOS Safari):** Botón *Compartir* ➔ *Añadir a la pantalla de inicio*. Se abre a pantalla completa con aspecto de aplicación nativa.
   - **En Android (Chrome):** Muestra el banner *"Instalar aplicación"* directamente. Puede empaquetarse a APK en 1 clic usando [PWABuilder](https://www.pwabuilder.com/).

4. **Diseño Minimalista de Alta Gama:**
   - Modo oscuro mate (`#09090b`), tipografía neogrotesca limpia, microinteracciones tácticas sin elementos recargados.

---

## 📂 Estructura del Repositorio

```text
nexus_facial_pwa/
├── index.html              # Interfaz HTML5 minimalista y visor de cámara
├── manifest.webmanifest    # Configuración PWA para instalación en celulares
├── sw.js                   # Service Worker (Soporte offline y PWA)
├── vercel.json             # Cabeceras y optimización de despliegue en Vercel
├── css/
│   └── style.css           # Estilos minimalistas tipo Apple/Tesla
├── js/
│   ├── app.js              # Controlador principal y orquestador de UI
│   ├── recognition.js      # Motor biométrico TensorFlow / face-api
│   └── bluetooth.js        # Módulo Web Bluetooth (BLE UART + Simulación)
└── icons/
    └── icon.svg            # Icono vectorial para el launcher
```

---

## 🚀 Despliegue en GitHub y Vercel (Paso a Paso)

### 1. Subir el código a GitHub

Abre tu terminal en la carpeta `nexus_facial_pwa` y ejecuta:

```bash
# 1. Inicializar git
git init

# 2. Agregar todos los archivos
git add .

# 3. Primer commit
git commit -m "feat: nexus access pwa face recognition + web bluetooth"

# 4. Cambiar a rama main
git branch -M main

# 5. Vincular a tu repositorio de GitHub (reemplaza con tu URL)
git remote add origin https://github.com/TU_USUARIO/TU_REPOSITORIO.git

# 6. Subir
git push -u origin main
```

---

### 2. Desplegar en Vercel

1. Inicia sesión en [Vercel](https://vercel.com/) con tu cuenta de GitHub.
2. Haz clic en el botón **"Add New..."** ➔ **"Project"**.
3. Selecciona tu repositorio recién subido.
4. En **Framework Preset**, déjalo en **"Other"** (es un proyecto estático puro sin dependencias de Node.js).
5. Haz clic en **"Deploy"**.
6. ¡Listo! En menos de 10 segundos Vercel te entregará una URL HTTPS segura (ej: `https://nexus-access.vercel.app`), indispensable para que el navegador autorice el acceso a la cámara y a Web Bluetooth.

---

## 📱 Cómo Instalar la App en tu Celular

### En iPhone (iOS Safari):
1. Abre la URL de Vercel en **Safari**.
2. Toca el botón **Compartir** (icono de cuadrado con flecha hacia arriba en la barra inferior).
3. Desliza hacia abajo y presiona **"Añadir a la pantalla de inicio"**.
4. ¡Listo! Tendrás el icono en tu pantalla de inicio y se abrirá en pantalla completa sin barra de navegación.

### En Android (Google Chrome):
1. Abre la URL de Vercel en **Chrome**.
2. Toca el menú de los 3 puntos (arriba a la derecha) o el botón inferior **"Instalar aplicación"**.
3. Acepta y la app se integrará al cajón de aplicaciones de tu teléfono.

---

## 🔧 Integración Futura con ESP32 (BLE)

Cuando tengas tu ESP32, simplemente flashea un sketch básico con **BLE UART** (servicio `6e400001-b5a3-f393-e0a9-e50e24dcca9e` con nombre `NEXUS-ESP32`). La aplicación enviará la cadena `ABRIR:Nombre\n` al reconocer un rostro autorizado.
