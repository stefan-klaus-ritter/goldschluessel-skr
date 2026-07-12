/* ==========================================================================
 * gskr-anon-tresor.js — SCHARFSCHALTUNG der Anonymisierung (GSKR_ANON_TRESOR)
 * --------------------------------------------------------------------------
 * STAND : 12.07.2026 · Auftrag TRESOR (T2 init, T3 fail-closed Gate, T5 Anzeiger)
 *
 * WAS DIESE DATEI TUT
 *   Sie schaltet die Anonymisierung scharf und haelt sie scharf:
 *   1. GSKR_ANON.init() wird aufgerufen — bei JEDEM Start. Ohne init bleibt der
 *      Anonymisierer wirkungslos.
 *   2. Der Gate ist FAIL-CLOSED: nicht bereit ODER Fehler = NICHT SENDEN (451).
 *      Ein Waechter, der bei eigenem Ausfall durchwinkt, ist kein Waechter.
 *   3. Ein sichtbarer Anzeiger sagt jederzeit, ob der Schutz laeuft.
 *
 * SCHLUESSELHERKUNFT (bestimmt, ob Tokens app-uebergreifend zusammenpassen)
 *   A) AKTE VORHANDEN (Onboarding-Link: Akten-ID + Akten-Passwort)
 *      -> init(akten_passwort, akten_id)
 *      Alle Apps erzeugen fuer denselben Namen DENSELBEN Token. Nur so passen
 *      anonymisierte Daten zwischen den Apps ueberhaupt zusammen.
 *   B) KEINE AKTE (rein lokaler Betrieb)
 *      -> geraete-lokaler Zufallsschluessel, in localStorage persistiert.
 *      Tokens bleiben ueber Sitzungen stabil. ready = true — sonst wuerde der
 *      fail-closed-Gate jede KI-Nutzung blockieren.
 *      ACHTUNG: Geraete-Schluessel != Akten-Schluessel. Tokens aus Modus B
 *      passen NICHT zu Tokens einer Akte. Das ist gewollt und richtig.
 *
 * INTEGRITAETS-PRUEFUNG
 *   Der Tresor verlangt GSKR_ANON.politik. Fehlt sie, laeuft eine ALTE
 *   Anonymisierer-Fassung (ohne Feld-Politik) — dann gilt: NICHT bereit,
 *   also GESPERRT. Lieber kein KI-Aufruf als einer mit unbekannter Politik.
 *
 * REIHENFOLGE: Diese Datei MUSS nach gskr-anonymisierer.js geladen werden.
 *   Sie legt ihren fetch-Wrapper UEBER den Cloud-Riegel: erst anonymisieren,
 *   dann fragt der Riegel nach der Freigabe. Anonymisieren heisst immer noch
 *   senden — der Riegel bleibt die aeussere Instanz.
 * ========================================================================== */
(function (g) {
  'use strict';

  if (g.GSKR_ANON_TRESOR) return;              // nur einmal

  var KEY_SCHLUESSEL = 'GSKR_ANON_GERAETESCHLUESSEL';
  var KEY_AKTE       = 'GSKR_ANON_GERAETE_AKTE';
  var KI_HOST        = 'api.anthropic.com';

  var ZUSTAND = {
    bereit:  false,
    quelle:  null,     // 'akte' | 'geraet'
    aktenId: null,
    grund:   'noch nicht gestartet'
  };

  // ---------------------------------------------------------------- Speicher
  function lese(k) { try { return g.localStorage ? g.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function schreibe(k, v) { try { if (g.localStorage) g.localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  function zufallsHex(bytes) {
    var a = new Uint8Array(bytes);
    g.crypto.getRandomValues(a);
    return [].slice.call(a).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // Geraete-Schluessel: einmal erzeugt, danach persistent. Ohne Persistenz
  // bekaeme derselbe Name nach jedem Neustart einen anderen Token — die
  // Token-Map waere wertlos und der Rueckweg (De-Anonymisierung) kaputt.
  function geraeteSchluessel() {
    var s = lese(KEY_SCHLUESSEL);
    if (!s) { s = zufallsHex(32); schreibe(KEY_SCHLUESSEL, s); }
    var a = lese(KEY_AKTE);
    if (!a) { a = 'LOKAL-' + zufallsHex(4); schreibe(KEY_AKTE, a); }
    return { passwort: s, aktenId: a };
  }

  // ---------------------------------------------------------------- Akte
  // Akten-Daten kommen aus dem Nextcloud-Adapter (QR-Onboarding-Link).
  function akteAusAdapter() {
    try {
      var c = g.GSKR_NEXTCLOUD && g.GSKR_NEXTCLOUD.config;
      if (c && c.aktenId && c.passwort) return { aktenId: c.aktenId, passwort: c.passwort };
    } catch (e) {}
    return null;
  }

  function anonymisiererTauglich() {
    var A = g.GSKR_ANON;
    if (!A || typeof A.anonymisiereText !== 'function' || typeof A.init !== 'function') {
      return { ok: false, grund: 'GSKR_ANON fehlt' };
    }
    if (!A.politik) {
      // Alte Fassung ohne Feld-Politik -> unbekanntes Verhalten -> gesperrt.
      return { ok: false, grund: 'veraltete Anonymisierer-Fassung ohne Feld-Politik' };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- Start
  var _laeuft = null;

  function starten() {
    if (_laeuft) return _laeuft;
    _laeuft = (async function () {
      var t = anonymisiererTauglich();
      if (!t.ok) {
        ZUSTAND.bereit = false; ZUSTAND.grund = t.grund;
        anzeigerZeichnen();
        return ZUSTAND;
      }
      try {
        var akte = akteAusAdapter();
        var q;
        if (akte) { q = akte; ZUSTAND.quelle = 'akte'; }
        else      { q = geraeteSchluessel(); ZUSTAND.quelle = 'geraet'; }

        await g.GSKR_ANON.init(q.passwort, q.aktenId);

        ZUSTAND.bereit  = !!(g.GSKR_ANON._STATE && g.GSKR_ANON._STATE.ready);
        ZUSTAND.aktenId = q.aktenId;
        ZUSTAND.grund   = ZUSTAND.bereit ? 'ok' : 'init lief, ready blieb false';
      } catch (e) {
        ZUSTAND.bereit = false;
        ZUSTAND.grund  = 'init fehlgeschlagen: ' + (e && e.message ? e.message : e);
      }
      anzeigerZeichnen();
      return ZUSTAND;
    })();
    return _laeuft;
  }

  // Wechselt die Akte (Onboarding-Link eingelesen), muss der Schluessel neu
  // abgeleitet werden — sonst tokenisiert die App weiter mit dem Geraete-
  // Schluessel und die Tokens passen NICHT zu den anderen Apps.
  function neuStarten() {
    _laeuft = null;
    try { if (g.GSKR_ANON && g.GSKR_ANON.reset) g.GSKR_ANON.reset(); } catch (e) {}
    ZUSTAND.bereit = false; ZUSTAND.grund = 'Neustart nach Akten-Wechsel';
    anzeigerZeichnen();
    return starten();
  }

  // GSKR_NEXTCLOUD.init(opts) setzt aktenId/passwort. Danach MUSS der Tresor
  // neu ableiten. Wir haengen uns an, ohne den Adapter zu veraendern.
  function anAdapterHaengen() {
    try {
      var NC = g.GSKR_NEXTCLOUD;
      if (!NC || typeof NC.init !== 'function' || NC.__tresorHook) return;
      var orig = NC.init;
      NC.init = function (opts) {
        var r = orig.apply(this, arguments);
        try { if (opts && opts.aktenId && opts.passwort) neuStarten(); } catch (e) {}
        return r;
      };
      NC.__tresorHook = true;
    } catch (e) {}
  }

  // ---------------------------------------------------------------- T5 Anzeiger
  // Wer nicht sieht, ob der Schutz laeuft, hat keinen Schutz.
  var anzeiger = null;

  function anzeigerZeichnen() {
    if (typeof g.document === 'undefined' || !g.document.body) return;
    if (!anzeiger) {
      anzeiger = g.document.createElement('div');
      anzeiger.id = 'gskr-anon-anzeiger';
      anzeiger.style.cssText = [
        'position:fixed', 'bottom:10px', 'left:10px', 'z-index:2147483646',
        'font:600 12px/1.35 system-ui,Segoe UI,sans-serif', 'padding:6px 11px',
        'border-radius:5px', 'box-shadow:0 2px 8px rgba(0,0,0,.35)',
        'user-select:none', 'cursor:default', 'max-width:280px'
      ].join(';');
      g.document.body.appendChild(anzeiger);
    }
    if (ZUSTAND.bereit) {
      anzeiger.style.background = '#1B7F3B';
      anzeiger.style.color = '#fff';
      anzeiger.textContent = 'Anonymisierung AKTIV'
        + (ZUSTAND.quelle === 'akte' ? ' · Akte ' + ZUSTAND.aktenId : ' · lokal');
      anzeiger.title = 'PII wird vor jedem KI-Aufruf tokenisiert. PLZ/Ort bleibt bewusst im Klartext (Marktkontext).';
    } else {
      anzeiger.style.background = '#B4261A';
      anzeiger.style.color = '#fff';
      anzeiger.textContent = 'Anonymisierung NICHT AKTIV — KI gesperrt';
      anzeiger.title = 'Grund: ' + ZUSTAND.grund + '\nKI-Aufrufe werden mit HTTP 451 blockiert.';
    }
  }

  // ---------------------------------------------------------------- T3 Gate
  // FAIL-CLOSED. Im Zweifel NICHT senden.
  var _f = (typeof g.fetch === 'function') ? g.fetch.bind(g) : null;

  function sperre(grund) {
    try { console.error('ANON-GATE: ' + grund + ' — KI-Anfrage NICHT gesendet.'); } catch (e) {}
    return new Response(JSON.stringify({
      error: 'ANON-GATE blockiert',
      grund: grund,
      hinweis: 'Es wurden KEINE Daten gesendet. Der Anonymisierer ist nicht scharf. '
             + 'Status: GSKR_ANON_TRESOR.status() in der Konsole.'
    }), { status: 451, headers: { 'Content-Type': 'application/json' } });
  }

  if (_f) {
    g.fetch = async function (url, opts) {
      var u = (typeof url === 'string') ? url : (url && url.url ? String(url.url) : '');
      var isKI = u.indexOf(KI_HOST) >= 0;
      if (!isKI) return _f(url, opts);          // fachliche Dienste bleiben unberuehrt

      // (1) Anonymisierer ueberhaupt brauchbar?
      var t = anonymisiererTauglich();
      if (!t.ok) return sperre(t.grund);

      // (2) Scharf? Falls der Start noch laeuft, hier abwarten.
      try { await starten(); } catch (e) {}
      if (!ZUSTAND.bereit || !g.GSKR_ANON._STATE.ready) {
        return sperre('Anonymisierer nicht initialisiert (' + ZUSTAND.grund + ')');
      }

      // (3) Maskieren. Schlaegt das fehl -> NICHT SENDEN.
      if (opts && opts.body) {
        try {
          var b = (typeof opts.body === 'string') ? JSON.parse(opts.body) : opts.body;
          if (b && b.messages && b.messages.length) {
            for (var i = 0; i < b.messages.length; i++) {
              var c = b.messages[i].content;
              if (typeof c === 'string') {
                b.messages[i].content = await g.GSKR_ANON.anonymisiereText(c);
              } else if (Array.isArray(c)) {
                for (var j = 0; j < c.length; j++) {
                  if (c[j] && c[j].type === 'text' && typeof c[j].text === 'string') {
                    c[j].text = await g.GSKR_ANON.anonymisiereText(c[j].text);
                  }
                }
              }
            }
          }
          if (b && typeof b.system === 'string') {
            b.system = await g.GSKR_ANON.anonymisiereText(b.system);
          }
          opts = Object.assign({}, opts, { body: JSON.stringify(b) });
        } catch (e) {
          // Genau hier stand frueher console.warn() — und danach ging der
          // KLARTEXT raus. Das ist der Fehler, den diese Datei behebt.
          return sperre('Maskierung fehlgeschlagen: ' + (e && e.message ? e.message : e));
        }
      }

      var resp = await _f(url, opts);

      // (4) Rueckweg: Tokens lokal wieder in Klartext.
      try {
        var txt = await resp.clone().text();
        var de  = g.GSKR_ANON.deAnonymisiereText(txt);
        if (de && de !== txt) {
          return new Response(de, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
        }
      } catch (e) { /* Original-Antwort durchreichen */ }
      return resp;
    };
  }

  // ---------------------------------------------------------------- API
  g.GSKR_ANON_TRESOR = {
    version: '1.0',
    starten: starten,
    neuStarten: neuStarten,
    status: function () {
      return {
        bereit: ZUSTAND.bereit,
        quelle: ZUSTAND.quelle,
        akten_id: ZUSTAND.aktenId,
        grund: ZUSTAND.grund,
        politik: (g.GSKR_ANON && g.GSKR_ANON.politik) ? Object.assign({}, g.GSKR_ANON.politik) : null
      };
    },
    _zustand: ZUSTAND
  };

  // ---------------------------------------------------------------- Autostart
  function los() { anAdapterHaengen(); starten(); anzeigerZeichnen(); }
  if (typeof g.document !== 'undefined') {
    if (g.document.readyState === 'loading') g.document.addEventListener('DOMContentLoaded', los);
    else los();
  } else {
    anAdapterHaengen();   // Node/Selbsttest: kein DOM, kein Autostart
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GSKR_ANON_TRESOR;

})(typeof window !== 'undefined' ? window : globalThis);
