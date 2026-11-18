/**
 * app.js — Nexus · Cerradura
 * Estado en vivo, órdenes con PIN, bloqueo del teclado, reconocimiento facial y actividad.
 */
import { LockLink } from './lock.js';
import { FaceRecognitionEngine } from './recognition.js';

const PIN = '201106';
const PIN_LENGTH = 6;
const MAX_TRIES = 3;
const FACE_COOLDOWN_MS = 6000;
const COMMAND_TIMEOUT_MS = 12000;
const ACTIVITY_KEY = 'nexus_activity_v2';
const TAB_KEY = 'nexus_tab_v2';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado */ }
  },
};

// Cómo se describe cada "metodo" que publica el ESP32
const VIA = {
  TECLADO_4X4: 'con el teclado',
  WEB: 'desde la web',
  WEB_MANUAL: 'desde la web',
  BLOQUEO_TECLADO: 'por bloqueo del teclado',
  DESBLOQUEO_WEB: 'desde la web',
  PIN_INCORRECTO: '',
  INICIO: 'al encender',
};

// Texto bajo el estado grande, según el último "metodo"
const SUB = {
  TECLADO_4X4: 'Último cambio con el teclado',
  WEB: 'Último cambio desde la web',
  WEB_MANUAL: 'Último cambio desde la web',
  BLOQUEO_TECLADO: 'Se cerró por el bloqueo del teclado',
  DESBLOQUEO_WEB: 'Teclado desbloqueado desde la web',
  PIN_INCORRECTO: 'Hubo un PIN incorrecto en el teclado',
  INICIO: 'Recién encendida',
};

class App {
  constructor() {
    this.link = null;
    this.lock = null;          // último estado conocido
    this.online = false;
    this.pending = null;       // { action, label, timer }
    this.lastChangeAt = null;
    this.activity = store.get(ACTIVITY_KEY, []);

    this.engine = new FaceRecognitionEngine($('#webcam'), $('#overlay'));
    this.cameraState = 'off';  // off | starting | on | error
    this.faceCooldownUntil = 0;
    this.frames = 0;

    this.pin = { value: '', onOk: null };
    this.installPrompt = null;
  }

  init() {
    this.bindTabs();
    this.bindActions();
    this.bindPinPad();
    this.bindSheets();
    this.bindEnroll();
    this.bindUsers();
    this.bindInstall();
    this.renderActivity();
    this.renderUsers();
    this.render();

    try {
      this.link = new LockLink();
      this.link.listen({
        onState: (s, prev) => this.onLockState(s, prev),
        onOnline: (on) => { this.online = on; this.renderLink(); },
      });
    } catch (err) {
      console.error('Firebase no disponible:', err);
      this.toast('No se pudo conectar con la cerradura', 'alert');
    }

    this.setTab(store.get(TAB_KEY, 'camara'));
    setInterval(() => this.renderSub(), 30000);
    setInterval(() => { $('#camFps').textContent = this.cameraState === 'on' && !document.hidden ? `${this.frames} fps` : ''; this.frames = 0; }, 1000);
    document.addEventListener('visibilitychange', () => this.syncCameraLoop());

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js?v=20').catch(() => {});
    }
  }

  /* ═════════ Estado de la cerradura ═════════ */

  get uiState() {
    if (!this.lock) return 'unknown';
    if (this.lock.bloqueado) return 'blocked';
    return this.lock.estado === 'ABIERTO' ? 'open' : 'closed';
  }

  onLockState(s, prev) {
    if (prev) {
      this.lastChangeAt = Date.now();
      const label = this.pending?.label;

      if (!prev.bloqueado && s.bloqueado) {
        this.log('Teclado bloqueado: 3 PIN incorrectos', 'alert');
        this.toast('Teclado bloqueado por 3 PIN incorrectos', 'alert', 4200);
        navigator.vibrate?.([80, 60, 80]);
      } else if (prev.bloqueado && !s.bloqueado) {
        this.log('Teclado desbloqueado desde la web', 'open');
      } else if (!s.bloqueado && s.intentos > prev.intentos) {
        this.log(`PIN incorrecto en el teclado (${s.intentos} de ${MAX_TRIES})`, 'alert');
      }

      if (prev.estado !== s.estado) {
        const open = s.estado === 'ABIERTO';
        const via = label || VIA[s.metodo] || '';
        this.log(`${open ? 'Abierta' : 'Cerrada'}${via ? ' ' + via : ''}`, open ? 'open' : 'neutral');
      }
    }

    this.lock = s;
    this.resolvePending();
    this.render();
  }

  resolvePending() {
    const p = this.pending;
    if (!p || !this.lock) return;
    const done =
      (p.action === 'abrir' && this.lock.estado === 'ABIERTO') ||
      (p.action === 'cerrar' && this.lock.estado === 'CERRADO') ||
      (p.action === 'desbloquear' && !this.lock.bloqueado);
    if (!done) return;
    clearTimeout(p.timer);
    this.pending = null;
    const msg = { abrir: 'Cerradura abierta', cerrar: 'Cerradura cerrada', desbloquear: 'Teclado desbloqueado' }[p.action];
    this.toast(msg, p.action === 'cerrar' ? 'neutral' : 'open');
  }

  async send(action, label) {
    if (!this.link || this.pending) return;
    navigator.vibrate?.(12);
    this.pending = { action, label };
    this.render();
    try {
      await this.link[action]();
    } catch (err) {
      console.error(err);
      this.pending = null;
      this.toast('No se pudo enviar la orden', 'alert');
      this.render();
      return;
    }
    if (!this.pending) return; // ya se resolvió
    this.pending.timer = setTimeout(() => {
      this.pending = null;
      this.link.cancelar(action).catch(() => {});
      this.toast('La cerradura no respondió. ¿Está encendida y con Wi-Fi?', 'alert', 4500);
      this.render();
    }, COMMAND_TIMEOUT_MS);
  }

  /* ═════════ Render ═════════ */

  render() {
    const state = this.uiState;
    const pending = !!this.pending;
    document.body.dataset.state = state;
    if (pending) document.body.dataset.pending = this.pending.action;
    else delete document.body.dataset.pending;

    $('#stateTitle').textContent = {
      unknown: 'Conectando…', closed: 'Cerrada', open: 'Abierta', blocked: 'Bloqueada',
    }[state];
    this.renderSub();

    const canOpen = state === 'closed' && !pending;
    const canClose = state === 'open' && !pending;
    $$('[data-action="abrir"]').forEach((b) => { b.disabled = !canOpen; });
    $$('[data-action="cerrar"]').forEach((b) => { b.disabled = !canClose; });
    $$('[data-action="desbloquear"]').forEach((b) => {
      b.disabled = pending;
      b.textContent = this.pending?.action === 'desbloquear' ? 'Desbloqueando…' : 'Desbloquear';
    });

    $('#blockBanner').hidden = state !== 'blocked';

    const tries = this.lock?.bloqueado ? MAX_TRIES : Math.min(this.lock?.intentos || 0, MAX_TRIES);
    $$('#tries span').forEach((el, i) => el.classList.toggle('on', i < tries));
    $('#triesText').textContent =
      this.lock?.bloqueado ? 'Bloqueado. Solo se puede desbloquear desde esta web con el PIN.'
      : tries === 0 ? 'Sin intentos fallidos.'
      : `${tries} de ${MAX_TRIES} intentos fallidos. Al tercero se bloquea.`;

    this.renderLink();
  }

  renderSub() {
    const sub = $('#stateSub');
    if (this.pending) {
      sub.textContent = { abrir: 'Abriendo…', cerrar: 'Cerrando…', desbloquear: 'Desbloqueando…' }[this.pending.action] + ' esperando a la cerradura';
      return;
    }
    if (!this.lock) { sub.textContent = this.online ? 'Esperando datos de la cerradura' : 'Buscando la cerradura'; return; }
    if (this.lock.bloqueado) { sub.textContent = 'El teclado de la puerta no responde'; return; }
    const what = SUB[this.lock.metodo] || '';
    const when = this.lastChangeAt ? relTime(this.lastChangeAt) : '';
    sub.textContent = [what, when].filter(Boolean).join(' · ') || ' ';
  }

  renderLink() {
    const chip = $('#linkChip');
    chip.dataset.online = String(this.online);
    $('#linkText').textContent = this.online ? 'En línea' : 'Sin conexión';
  }

  /* ═════════ Actividad ═════════ */

  log(text, tone = 'neutral') {
    this.activity.unshift({ t: Date.now(), text, tone });
    this.activity = this.activity.slice(0, 20);
    store.set(ACTIVITY_KEY, this.activity);
    this.renderActivity(true);
  }

  renderActivity(fresh = false) {
    const list = $('#activity');
    list.replaceChildren(...this.activity.map((a, i) => {
      const li = document.createElement('li');
      if (fresh && i === 0) li.className = 'fresh';
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.dataset.tone = a.tone;
      const text = document.createElement('span');
      text.textContent = a.text;
      const time = document.createElement('time');
      time.dateTime = new Date(a.t).toISOString();
      time.textContent = clock(a.t);
      li.append(mark, text, time);
      return li;
    }));
    $('#activityEmpty').hidden = this.activity.length > 0;
  }

  /* ═════════ Pestañas ═════════ */

  bindTabs() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => this.setTab(t.dataset.tab)));
  }

  setTab(tab) {
    if (tab !== 'cerradura' && tab !== 'camara') tab = 'cerradura';
    document.body.dataset.tab = tab;
    $('#viewCerradura').hidden = tab !== 'cerradura';
    $('#viewCamara').hidden = tab !== 'camara';
    $$('.tab').forEach((t) => {
      if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    store.set(TAB_KEY, tab);
    window.scrollTo(0, 0);
    if (tab === 'camara') this.startCamera();
    this.syncCameraLoop();
  }

  /* ═════════ Botones de acción ═════════ */

  bindActions() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      if (action === 'abrir') {
        this.askPin({ title: 'Abrir la cerradura', sub: 'Ingresá el PIN de seguridad', onOk: () => this.send('abrir', 'desde la web') });
      } else if (action === 'cerrar') {
        this.send('cerrar', 'desde la web');
      } else if (action === 'desbloquear') {
        this.askPin({ title: 'Desbloquear el teclado', sub: 'Ingresá el PIN para volver a habilitarlo', onOk: () => this.send('desbloquear') });
      }
    });
  }

  /* ═════════ PIN ═════════ */

  askPin({ title, sub, onOk }) {
    this.pin = { value: '', onOk };
    $('#pinTitle').textContent = title;
    $('#pinSub').textContent = sub;
    $('#pinError').textContent = '';
    this.renderPinDots();
    this.openSheet('sheetPin');
  }

  bindPinPad() {
    $('#pinpad').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this.pinKey(b.dataset.k);
    });
    document.addEventListener('keydown', (e) => {
      if (!$('#sheetPin').classList.contains('open')) return;
      if (/^\d$/.test(e.key)) this.pinKey(e.key);
      else if (e.key === 'Backspace') this.pinKey('back');
    });
  }

  pinKey(k) {
    if (k === 'cancel') return this.closeSheets();
    if ($('#pinDots').classList.contains('shake')) return;
    $('#pinError').textContent = '';
    if (k === 'back') this.pin.value = this.pin.value.slice(0, -1);
    else if (this.pin.value.length < PIN_LENGTH) this.pin.value += k;
    this.renderPinDots();

    if (this.pin.value.length === PIN_LENGTH) {
      if (this.pin.value === PIN) {
        const ok = this.pin.onOk;
        this.pin = { value: '', onOk: null };
        setTimeout(() => { this.closeSheets(); ok?.(); }, 120);
      } else {
        const dots = $('#pinDots');
        dots.classList.add('shake');
        $('#pinError').textContent = 'PIN incorrecto';
        navigator.vibrate?.([40, 40, 40]);
        setTimeout(() => {
          dots.classList.remove('shake');
          this.pin.value = '';
          this.renderPinDots();
        }, 420);
      }
    }
  }

  renderPinDots() {
    $$('#pinDots i').forEach((d, i) => d.classList.toggle('on', i < this.pin.value.length));
  }

  /* ═════════ Hojas ═════════ */

  bindSheets() {
    $('#scrim').addEventListener('click', () => this.closeSheets());
    document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) this.closeSheets(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeSheets(); });
  }

  openSheet(id) {
    $$('.sheet.open').forEach((s) => s.classList.remove('open'));
    this.lastFocus = document.activeElement;
    $('#scrim').classList.add('on');
    const sheet = $('#' + id);
    sheet.classList.add('open');
    const focusable = sheet.querySelector('input') || sheet.querySelector('button:not([disabled])');
    setTimeout(() => focusable?.focus({ preventScroll: true }), 60);
  }

  closeSheets() {
    $$('.sheet.open').forEach((s) => s.classList.remove('open'));
    $('#scrim').classList.remove('on');
    this.lastFocus?.focus?.({ preventScroll: true });
  }

  /* ═════════ Cámara y reconocimiento ═════════ */

  async startCamera() {
    if (this.cameraState === 'starting' || this.cameraState === 'on') return;
    this.cameraState = 'starting';
    const veil = $('#cameraVeil');
    veil.classList.remove('gone');
    $('#btnCameraRetry').hidden = true;
    $('#cameraMsg').textContent = 'Pidiendo permiso de cámara…';

    const models = this.modelsPromise ||= this.engine.loadModels();

    try {
      await this.engine.startCamera();
    } catch (err) {
      console.error(err);
      this.cameraState = 'error';
      $('#cameraMsg').textContent = 'Necesito permiso para usar la cámara.';
      const retry = $('#btnCameraRetry');
      retry.hidden = false;
      retry.onclick = () => this.startCamera();
      this.setScan('Cámara desactivada', 'alert');
      return;
    }

    this.cameraState = 'on';
    veil.classList.add('gone');
    this.setScan('Cargando reconocimiento…', 'idle');
    this.engine.onFaceDetected = (r) => this.onFace(r);
    const ok = await models;
    if (!ok) { this.modelsPromise = null; this.setScan('No se pudo cargar el reconocimiento. Revisá internet.', 'alert'); return; }
    this.setScan(this.engine.knownFaces.length ? 'Mirá a la cámara' : 'Registrá un rostro para empezar', 'idle');
    this.syncCameraLoop();
  }

  syncCameraLoop() {
    const active = document.body.dataset.tab === 'camara' && !document.hidden && this.cameraState === 'on';
    if (active) this.engine.startLoop();
    else this.engine.stopLoop();
  }

  setScan(text, tone) {
    $('#scanText').textContent = text;
    $('#scanLine').dataset.tone = tone;
  }

  onFace({ hasFace, match }) {
    this.frames++;
    const reticle = $('#reticle');
    const state = this.uiState;

    if (state === 'blocked') {
      reticle.dataset.mode = 'idle';
      return this.setScan('Cerradura bloqueada: desbloqueala primero', 'alert');
    }
    if (state === 'open') {
      reticle.dataset.mode = 'ok';
      return this.setScan('La cerradura está abierta', 'ok');
    }
    if (this.pending?.action === 'abrir') return;
    if (Date.now() < this.faceCooldownUntil) return;

    if (!hasFace) {
      reticle.dataset.mode = 'idle';
      return this.setScan(this.engine.knownFaces.length ? 'Mirá a la cámara' : 'Registrá un rostro para empezar', 'idle');
    }
    if (!match) {
      reticle.dataset.mode = 'unknown';
      return this.setScan('Rostro no registrado', 'alert');
    }

    reticle.dataset.mode = 'ok';
    this.setScan(`Hola, ${match.name}`, 'ok');
    if (state === 'closed') {
      this.faceCooldownUntil = Date.now() + FACE_COOLDOWN_MS;
      this.send('abrir', `por ${match.name} (rostro)`);
    }
  }

  /* ═════════ Registrar rostro ═════════ */

  bindEnroll() {
    $('#btnEnroll').addEventListener('click', () => {
      if (this.cameraState !== 'on') return this.toast('Primero activá la cámara', 'alert');
      if (!this.engine.isModelLoaded) return this.toast('El reconocimiento todavía se está cargando', 'alert');
      $('#enrollName').value = '';
      $('#enrollError').textContent = '';
      this.openSheet('sheetEnroll');
    });
    $('#enrollName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btnEnrollNext').click(); } });
    $('#btnEnrollNext').addEventListener('click', () => {
      const name = $('#enrollName').value.trim();
      if (!name) { $('#enrollError').textContent = 'Escribí un nombre'; return $('#enrollName').focus(); }
      this.askPin({
        title: 'Confirmá con el PIN',
        sub: `Para registrar a ${name}`,
        onOk: async () => {
          this.setScan('Mirá de frente a la cámara…', 'idle');
          try {
            const user = await this.engine.enrollCurrentFace(name);
            this.renderUsers();
            this.toast(`${user.name} quedó registrado`, 'open');
          } catch (err) {
            this.toast(err.message || 'No se pudo registrar', 'alert', 4000);
          }
        },
      });
    });
  }

  /* ═════════ Usuarios ═════════ */

  bindUsers() {
    $('#btnUsers').addEventListener('click', () => { this.renderUsers(); this.resetClearAll(); this.openSheet('sheetUsers'); });
    $('#userList').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      this.engine.removeUser(del.dataset.del);
      this.renderUsers();
    });
    $('#btnClearUsers').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.armed !== 'true') {
        btn.dataset.armed = 'true';
        btn.textContent = 'Tocá de nuevo para eliminar todos';
        this.clearTimer = setTimeout(() => this.resetClearAll(), 3000);
        return;
      }
      this.engine.clearAllUsers();
      this.resetClearAll();
      this.renderUsers();
      this.toast('Se eliminaron todos los rostros');
    });
  }

  resetClearAll() {
    clearTimeout(this.clearTimer);
    const btn = $('#btnClearUsers');
    btn.dataset.armed = 'false';
    btn.textContent = 'Eliminar todos';
  }

  renderUsers() {
    const users = this.engine.knownFaces;
    const count = $('#userCount');
    count.textContent = String(users.length);
    count.dataset.zero = String(users.length === 0);
    $('#usersEmpty').hidden = users.length > 0;
    $('#btnClearUsers').hidden = users.length === 0;
    $('#userList').replaceChildren(...users.map((u) => {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.src = u.thumbnail; img.alt = '';
      const who = document.createElement('div');
      who.className = 'who';
      const name = document.createElement('strong'); name.textContent = u.name;
      const date = document.createElement('span'); date.textContent = `Registrado el ${u.date}`;
      who.append(name, date);
      const del = document.createElement('button');
      del.className = 'del'; del.dataset.del = u.id; del.textContent = 'Quitar';
      del.setAttribute('aria-label', `Quitar a ${u.name}`);
      li.append(img, who, del);
      return li;
    }));
  }

  /* ═════════ Instalar ═════════ */

  bindInstall() {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const btn = $('#btnInstall');
    btn.hidden = !!standalone;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    $('#stepsIos').hidden = !ios;
    $('#stepsAndroid').hidden = ios;

    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); this.installPrompt = e; });
    window.addEventListener('appinstalled', () => { btn.hidden = true; this.toast('App instalada'); });
    btn.addEventListener('click', async () => {
      if (this.installPrompt) {
        this.installPrompt.prompt();
        await this.installPrompt.userChoice.catch(() => {});
        this.installPrompt = null;
      } else {
        this.openSheet('sheetInstall');
      }
    });
  }

  /* ═════════ Toasts ═════════ */

  toast(text, tone = 'neutral', ms = 2600) {
    const host = $('#toasts');
    while (host.children.length >= 2) host.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.tone = tone;
    el.textContent = text;
    host.append(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 220);
    }, ms);
  }
}

/* ───── utilidades de tiempo ───── */
function clock(t) {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return today ? hm : `${d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })} ${hm}`;
}
function relTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'recién';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `hace ${h} h` : clock(t);
}

new App().init();
