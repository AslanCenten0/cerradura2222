/**
 * lock.js — Enlace con la cerradura a través de Firebase Realtime Database.
 *
 * Nodo /cerradura (lo escribe el ESP32):
 *   estado     "ABIERTO" | "CERRADO"
 *   metodo     quién hizo el último cambio (TECLADO_4X4, WEB, PIN_INCORRECTO, BLOQUEO_TECLADO, DESBLOQUEO_WEB…)
 *   bloqueado  true cuando el teclado se bloqueó por 3 PIN incorrectos
 *   intentos   PIN incorrectos seguidos en el teclado (0-3)
 * Órdenes (las escribe la web, el ESP32 las consume y las vuelve a false):
 *   comando_abrir, comando_cerrar, comando_desbloquear
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getDatabase, ref, onValue, update } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";

const DB_URL = "https://nexus-cerradura-default-rtdb.firebaseio.com";

export class LockLink {
  constructor() {
    this.db = getDatabase(initializeApp({ databaseURL: DB_URL }));
    this.state = null; // { estado, metodo, bloqueado, intentos }
  }

  /** onState(state, previous) se llama con cada cambio; onOnline(bool) con la conexión. */
  listen({ onState, onOnline }) {
    onValue(ref(this.db, ".info/connected"), (snap) => onOnline?.(snap.val() === true));
    onValue(ref(this.db, "cerradura"), (snap) => {
      const raw = snap.val() || {};
      const next = {
        estado: raw.estado === "ABIERTO" ? "ABIERTO" : "CERRADO",
        metodo: raw.metodo || "",
        bloqueado: raw.bloqueado === true,
        intentos: Number.isFinite(raw.intentos) ? raw.intentos : 0,
      };
      const prev = this.state;
      this.state = next;
      onState?.(next, prev);
    });
  }

  abrir() {
    return update(ref(this.db, "cerradura"), { comando_cerrar: false, comando_abrir: true });
  }

  cerrar() {
    return update(ref(this.db, "cerradura"), { comando_abrir: false, comando_cerrar: true });
  }

  desbloquear() {
    return update(ref(this.db, "cerradura"), { comando_abrir: false, comando_desbloquear: true });
  }

  /** Retira una orden que la cerradura no llegó a tomar (para que no se ejecute horas después). */
  cancelar(accion) {
    return update(ref(this.db, "cerradura"), { [`comando_${accion}`]: false });
  }
}
