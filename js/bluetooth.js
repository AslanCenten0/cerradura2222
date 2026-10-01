/**
 * ═════════════════════════════════════════════════════════════════════
 *  bluetooth.js — Controlador Web Bluetooth API (BLE)
 *  Conexión inalámbrica directa del Navegador hacia el ESP32 (GATT/UART)
 * ═════════════════════════════════════════════════════════════════════
 */

// UUIDs estándar de Nordic UART Service (usados frecuentemente en ESP32 BLE)
const BLE_UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_UART_TX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write
const BLE_UART_RX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify

export class BluetoothController {
  constructor() {
    this.device = null;
    this.server = null;
    this.txCharacteristic = null;
    this.rxCharacteristic = null;
    this.isConnected = false;
    this.isSimulated = false;

    this.onStateChange = null; // Callback al conectar/desconectar
    this.onMessageReceived = null; // Callback al recibir datos del ESP32
  }

  /**
   * Comprueba si el navegador actual soporta Web Bluetooth API
   */
  isSupported() {
    return 'bluetooth' in navigator;
  }

  /**
   * Inicia el emparejamiento BLE con el ESP32
   */
  async connect() {
    if (!this.isSupported()) {
      console.warn("⚠️ Web Bluetooth no está soportado en este navegador. Activando modo simulación.");
      this.enableSimulation();
      return true;
    }

    try {
      console.log("🔍 Buscando dispositivo BLE ESP32...");
      
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'NEXUS' },
          { namePrefix: 'ESP32' }
        ],
        optionalServices: [
          BLE_UART_SERVICE_UUID,
          'generic_access',
          0xFFE0 // Algunos módulos BLE genéricos
        ]
      });

      this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());

      console.log(`📡 Conectando al servidor GATT de ${this.device.name}...`);
      this.server = await this.device.gatt.connect();

      // Intentar obtener el servicio UART
      try {
        const service = await this.server.getPrimaryService(BLE_UART_SERVICE_UUID);
        this.txCharacteristic = await service.getCharacteristic(BLE_UART_TX_CHAR_UUID);
        
        try {
          this.rxCharacteristic = await service.getCharacteristic(BLE_UART_RX_CHAR_UUID);
          await this.rxCharacteristic.startNotifications();
          this.rxCharacteristic.addEventListener('characteristicvaluechanged', (e) => {
            const val = new TextDecoder().decode(e.target.value);
            console.log("📥 [ESP32 BLE]:", val);
            if (this.onMessageReceived) this.onMessageReceived(val);
          });
        } catch (rxErr) {
          console.log("Canal RX no disponible (modo solo escritura)");
        }
      } catch (serviceErr) {
        console.warn("Servicio UART no encontrado, usando conexión GATT genérica:", serviceErr);
      }

      this.isConnected = true;
      this.isSimulated = false;
      if (this.onStateChange) this.onStateChange(true, this.device.name || "ESP32 BLE");
      return true;

    } catch (error) {
      if (error.name === 'NotFoundError') {
        console.log("El usuario canceló la selección de Bluetooth.");
      } else {
        console.error("Error al conectar por Bluetooth:", error);
      }
      return false;
    }
  }

  /**
   * Activa el modo de simulación (útil cuando no se tiene el ESP32 físico a mano)
   */
  enableSimulation() {
    this.isSimulated = true;
    this.isConnected = true;
    console.log("🟢 Modo Simulación Bluetooth activado.");
    if (this.onStateChange) this.onStateChange(true, "Simulador ESP32");
  }

  /**
   * Envía un comando de texto al ESP32 por BLE
   * @param {string} command - Ej: "ABRIR\n" o "OPEN:Juan\n"
   */
  async sendCommand(command) {
    if (!this.isConnected) {
      console.warn("No hay conexión Bluetooth activa. Comando no enviado:", command);
      return false;
    }

    if (this.isSimulated) {
      console.log(`[SIMULADOR BLE] ➡️ Comando transmitido: ${command.trim()}`);
      // Simular respuesta del ESP32 tras 100ms
      setTimeout(() => {
        if (this.onMessageReceived) this.onMessageReceived("OK: Puerta abierta (SIMULADA)");
      }, 100);
      return true;
    }

    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(command.endsWith('\n') ? command : command + '\n');
      
      if (this.txCharacteristic) {
        await this.txCharacteristic.writeValue(data);
        console.log("📤 [BLE TX Enviado]:", command.trim());
        return true;
      } else {
        console.warn("No hay característica TX disponible para escribir.");
        return false;
      }
    } catch (error) {
      console.error("Error enviando comando por Bluetooth:", error);
      return false;
    }
  }

  /**
   * Ordena al ESP32 abrir la cerradura
   */
  async openLock(userName = "Autorizado") {
    return await this.sendCommand(`ABRIR:${userName}`);
  }

  /**
   * Manejador de desconexión
   */
  handleDisconnect() {
    console.log("🔌 Dispositivo Bluetooth desconectado.");
    this.isConnected = false;
    this.isSimulated = false;
    this.device = null;
    this.server = null;
    this.txCharacteristic = null;
    this.rxCharacteristic = null;

    if (this.onStateChange) this.onStateChange(false, null);
  }

  /**
   * Desconectar voluntariamente
   */
  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.handleDisconnect();
  }
}
