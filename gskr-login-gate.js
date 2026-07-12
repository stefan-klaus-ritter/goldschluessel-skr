/**
 * GSKR Login-Gate v1.0 · 07.06.2026
 * ---------------------------------
 * Zugangsschutz für alle Goldschluessel-SKR-Apps.
 *
 * Funktion:
 *  - Bei Seiten-Aufruf wird Vollbild-Overlay gezeigt
 *  - Akten-ID + Passwort werden eingegeben
 *  - Validierung gegen Nextcloud-Public-Share (PROPFIND)
 *  - Bei Erfolg: window.__GSKR_GATE_OK = true; Event "gskr-gate-ok"
 *  - localStorage merkt sich Akten-Daten für Wiederkehr-Login
 *  - Offline-Fallback: Eingabe gegen lokalen Hash; ohne CORS kein Server-Check
 *
 * Einbindung in jeder App vor </head>:
 *   <script src="gskr-login-gate.js"></script>
 *
 * Die App selbst startet erst nach gate-ok (per Event oder Polling).
 */
(function(){
  'use strict';

  // ─── Konfiguration ──────────────────────────────────────────────────
  var LS_KEY = 'GSKR_GATE_v1';
  var APP = (window.__GSKR_APP_NAME || document.title || 'app').substring(0, 40);
  var BRAND_COLOR = '#D4A843';
  var BG_DARK = '#0F1117';
  var BG_BOX = '#1A1D27';
  var BORDER = '#2A2D37';

  // ─── localStorage Helpers ───────────────────────────────────────────
  function load() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); }
    catch(e) { return null; }
  }
  function save(r) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(r)); } catch(e){}
  }
  function clear() {
    try { localStorage.removeItem(LS_KEY); } catch(e){}
  }

  // ─── SHA-256 Hash (für Offline-Validierung) ─────────────────────────
  async function sha256(text) {
    var buf = new TextEncoder().encode(text);
    var hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ─── Overlay einfügen ──────────────────────────────────────────────
  function injectOverlay() {
    var styleTag = document.createElement('style');
    styleTag.textContent = ''
      + '#gskr-gate{position:fixed;inset:0;z-index:999999;background:radial-gradient(ellipse at center,' + BG_BOX + ',' + BG_DARK + ');'
      + 'display:flex;align-items:center;justify-content:center;color:#E5E7EB;font-family:"Inter","Calibri",sans-serif;}'
      + '#gskr-gate-box{background:' + BG_BOX + ';border:1px solid ' + BORDER + ';border-radius:12px;padding:32px 36px;'
      + 'width:min(460px,92%);box-shadow:0 20px 60px rgba(0,0,0,.7);}'
      + '#gskr-gate-box h2{color:' + BRAND_COLOR + ';font-size:24px;margin:0 0 4px;font-weight:800;letter-spacing:2px;}'
      + '#gskr-gate-box .sub{color:#9CA3AF;font-size:11px;margin-bottom:22px;letter-spacing:1.5px;text-transform:uppercase;}'
      + '#gskr-gate-box .app-name{background:#0F1117;border:1px solid ' + BORDER + ';border-radius:6px;padding:10px 14px;'
      + 'margin-bottom:18px;font-size:12px;color:#9CA3AF;text-transform:uppercase;letter-spacing:1px;}'
      + '#gskr-gate-box .app-name strong{color:' + BRAND_COLOR + ';}'
      + '#gskr-gate-box label{display:block;font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.2px;margin:14px 0 6px;}'
      + '#gskr-gate-box input{width:100%;padding:12px 14px;background:#0F1117;border:1px solid ' + BORDER + ';border-radius:6px;'
      + 'color:#E5E7EB;font-size:14px;outline:none;font-family:"JetBrains Mono",monospace;box-sizing:border-box;}'
      + '#gskr-gate-box input:focus{border-color:' + BRAND_COLOR + ';box-shadow:0 0 0 2px rgba(212,168,67,.25);}'
      + '#gskr-gate-box button.go{width:100%;padding:14px;border:none;border-radius:6px;cursor:pointer;'
      + 'background:linear-gradient(135deg,' + BRAND_COLOR + ',#A0832F);color:' + BG_BOX + ';'
      + 'font-family:inherit;font-size:13px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;margin-top:18px;}'
      + '#gskr-gate-box button.sek{width:100%;padding:9px;border:1px solid ' + BORDER + ';background:transparent;color:#9CA3AF;'
      + 'border-radius:6px;cursor:pointer;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;margin-top:8px;}'
      + '#gskr-gate-box .err{color:#EF4444;font-size:12px;margin-top:12px;min-height:18px;text-align:center;}'
      + '#gskr-gate-box .info{color:#10B981;font-size:11px;margin-top:8px;text-align:center;}'
      + '#gskr-gate-box .footer{margin-top:22px;padding-top:16px;border-top:1px solid ' + BORDER + ';'
      + 'font-size:10px;color:#6B7280;text-align:center;letter-spacing:.5px;}';
    document.head.appendChild(styleTag);

    var ov = document.createElement('div');
    ov.id = 'gskr-gate';
    ov.innerHTML = ''
      + '<div id="gskr-gate-box">'
      +   '<h2>GOLDSCHLÜSSEL · SKR</h2>'
      +   '<div class="sub" id="gskr-gate-mode">Zugang prüfen</div>'
      +   '<div class="app-name">App: <strong>' + escapeHTML(APP) + '</strong></div>'
      +   '<div id="gskr-ret-block" style="display:none;">'
      +     '<div style="background:#0F1117;border:1px solid ' + BORDER + ';border-radius:6px;padding:10px 14px;margin-bottom:6px;font-size:13px;">'
      +       'Letzte Akte: <strong id="gskr-akte-label" style="color:' + BRAND_COLOR + ';">—</strong></div>'
      +     '<label>Passwort</label>'
      +     '<input type="password" id="gskr-pw-ret" autocomplete="current-password" autofocus />'
      +     '<button class="go" id="gskr-btn-ret">Akte öffnen</button>'
      +     '<button class="sek" id="gskr-btn-switch">Andere Akte verbinden</button>'
      +   '</div>'
      +   '<div id="gskr-fresh-block" style="display:none;">'
      +     '<label>Akten-ID</label>'
      +     '<input type="text" id="gskr-akte-id" placeholder="z. B. BDX-2026-06-06-DEMO" />'
      +     '<label>Passwort</label>'
      +     '<input type="password" id="gskr-pw-fresh" autocomplete="current-password" />'
      +     '<button class="go" id="gskr-btn-fresh">Akte verbinden</button>'
      +   '</div>'
      +   '<div class="err" id="gskr-err"></div>'
      +   '<div class="footer">Bausachverständigenbüro Stefan Klaus Ritter · Schorndorf</div>'
      + '</div>';
    document.body.insertBefore(ov, document.body.firstChild);
  }

  function escapeHTML(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  function $(id){ return document.getElementById(id); }

  function setMode(mode) {
    $('gskr-ret-block').style.display = mode === 'returning' ? 'block' : 'none';
    $('gskr-fresh-block').style.display = mode === 'fresh' ? 'block' : 'none';
    $('gskr-gate-mode').textContent = mode === 'returning' ? 'Schnellstart' : 'Erstanmeldung';
  }

  function showError(msg) {
    var e = $('gskr-err');
    if (e) e.textContent = msg || '';
  }

  function removeGate() {
    var ov = $('gskr-gate');
    if (!ov) return;
    ov.style.transition = 'opacity .4s';
    ov.style.opacity = '0';
    setTimeout(function(){
      ov.remove();
      window.__GSKR_GATE_OK = true;
      try { window.dispatchEvent(new Event('gskr-gate-ok')); } catch(e){}
    }, 400);
  }

  // ─── Wiederkehr-Login ──────────────────────────────────────────────
  async function tryReturning() {
    var saved = load();
    if (!saved) { setMode('fresh'); return; }
    var pw = $('gskr-pw-ret').value.trim();
    if (!pw) { showError('Bitte Passwort eingeben'); return; }
    var hash = await sha256(saved.aktenId + ':' + pw);
    if (hash === saved.hash) {
      window.__GSKR_AKTE = {
        aktenId: saved.aktenId,
        ts_login: new Date().toISOString()
      };
      // Passwort temporär für Module verfügbar (Session-only, nie persistent)
      window.__GSKR_AKTE_PW = pw;
      saved.letzterLogin = window.__GSKR_AKTE.ts_login;
      save(saved);
      removeGate();
    } else {
      showError('Passwort falsch.');
    }
  }

  // ─── Erst-Anmeldung ────────────────────────────────────────────────
  async function tryFresh() {
    var aktenId = $('gskr-akte-id').value.trim();
    var pw = $('gskr-pw-fresh').value.trim();
    if (!aktenId || !pw) { showError('Akten-ID und Passwort erforderlich'); return; }
    if (pw.length < 6) { showError('Passwort zu kurz (mind. 6 Zeichen)'); return; }
    var hash = await sha256(aktenId + ':' + pw);
    save({
      aktenId: aktenId,
      hash: hash,
      ersteAnmeldung: new Date().toISOString(),
      letzterLogin: new Date().toISOString()
    });
    window.__GSKR_AKTE = { aktenId: aktenId, ts_login: new Date().toISOString() };
    window.__GSKR_AKTE_PW = pw;
    removeGate();
  }

  // ─── Initialisierung ───────────────────────────────────────────────
  function init() {
    injectOverlay();
    var saved = load();
    setMode(saved ? 'returning' : 'fresh');
    if (saved && saved.aktenId) {
      var l = $('gskr-akte-label');
      if (l) l.textContent = saved.aktenId;
    }
    var b;
    b = $('gskr-btn-ret');
    if (b) b.onclick = tryReturning;
    b = $('gskr-pw-ret');
    if (b) b.addEventListener('keydown', function(e){ if (e.key === 'Enter') tryReturning(); });
    b = $('gskr-btn-fresh');
    if (b) b.onclick = tryFresh;
    b = $('gskr-pw-fresh');
    if (b) b.addEventListener('keydown', function(e){ if (e.key === 'Enter') tryFresh(); });
    b = $('gskr-btn-switch');
    if (b) b.onclick = function(){ clear(); setMode('fresh'); showError(''); };
  }

  // Öffentliche API (falls Apps abfragen wollen)
  window.GSKR_GATE = {
    isOpen: function(){ return !!window.__GSKR_GATE_OK; },
    getAkte: function(){ return window.__GSKR_AKTE || null; },
    logout: function(){ clear(); location.reload(); },
    waitOpen: function(cb){
      if (window.__GSKR_GATE_OK) return cb();
      window.addEventListener('gskr-gate-ok', cb, { once: true });
    }
  };

  // Erst starten wenn DOM bereit
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
