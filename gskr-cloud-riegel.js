/**
 * GSKR CLOUD-RIEGEL v2.0
 * ======================
 * Diese Anwendung arbeitet grundsaetzlich OFFLINE: kein Server, kein Backend,
 * keine Cloud. Der Riegel setzt das technisch durch.
 *
 * KI-Endpunkte sind im Auslieferungszustand GESPERRT (fail-closed). Sie oeffnen
 * sich erst, wenn der Nutzer sie im Dialog ausdruecklich freigibt. Die Freigabe
 * ist dauerhaft (localStorage) und jederzeit widerrufbar.
 *
 * Warum nicht einfach erlauben: Eine bewusst getragene Ausnahme muss SICHTBAR
 * und BELEGT sein, sonst ist sie keine Entscheidung, sondern ein Versehen.
 * Deshalb:
 *   1. Fail-closed: ohne Freigabe geht nichts raus.
 *   2. Voller Warntext im Dialog (was, wohin, welches Risiko).
 *   3. PROTOKOLL jedes freigegebenen Aufrufs (Zeit, Ziel, Groesse, Bild ja/nein) —
 *      persistent, exportierbar.
 *   4. SICHTBARER ANZEIGER, solange der KI-Modus offen ist. Eine dauerhafte
 *      Freigabe, die man vergisst, ist eine offene Tuer. Der Anzeiger verhindert,
 *      dass sie unbemerkt offen steht — und sperrt per Klick wieder zu.
 *
 * WICHTIG: Anonymisieren heisst immer noch senden. Der Text-Tresor (GSKR_ANON)
 * schwaerzt Namen, Kontaktdaten und Strasse — das BILD-GATE fragt vor Bildversand.
 * Beide bleiben aktiv.
 *
 * WAS ERLAUBT BLEIBT (nie gesperrt): alles, was nicht auf der Sperrliste steht —
 * insbesondere die fachlichen Dienste (Geokodierung, Bodenrichtwert-Abruf) und
 * WebDAV. Der Riegel regelt KI-Uebertragung, nicht das Internet.
 *
 * BEDIENUNG (Browser-Konsole):
 *   GSKR_CLOUD_RIEGEL.status()      -> gesperrt/frei, seit wann
 *   GSKR_CLOUD_RIEGEL.sperren()     -> KI-Modus sofort zusperren
 *   GSKR_CLOUD_RIEGEL.freigeben()   -> Dialog erzwingen
 *   GSKR_CLOUD_RIEGEL.protokoll()   -> alle freigegebenen Aufrufe
 *   GSKR_CLOUD_RIEGEL.export()      -> Protokoll als JSON-Datei herunterladen
 *   GSKR_CLOUD_RIEGEL.test()        -> Selbsttest
 *
 * EINBINDUNG: nach dem Anonymisierer-Tresor, als aeusserster fetch-Waechter.
 */
(function (g) {
  'use strict';

  var VERSION = '2.0';

  // KI-Endpunkte, die der Freigabe beduerfen
  var SPERRLISTE = [
    'api.anthropic.com',
    'api.openai.com',
    'api.claude.ai',
    'claude.ai/api',
    'api.cohere.com',
    'api.mistral.ai',
    'generativelanguage.googleapis.com',
    'api.groq.com',
    'api.perplexity.ai'
  ];

  var KEY_FREIGABE  = 'GSKR_KI_FREIGABE';
  var KEY_PROTOKOLL = 'GSKR_KI_PROTOKOLL';
  var PROTOKOLL_MAX = 500;   // aeltere Eintraege rollen raus

  // ---------------------------------------------------------------- Speicher
  function lese(schluessel, standard) {
    try {
      var s = g.localStorage.getItem(schluessel);
      return s ? JSON.parse(s) : standard;
    } catch (e) { return standard; }
  }
  function schreibe(schluessel, wert) {
    try { g.localStorage.setItem(schluessel, JSON.stringify(wert)); return true; }
    catch (e) { return false; }   // localStorage gesperrt -> Freigabe gilt nur fuer die Sitzung
  }
  function loesche(schluessel) {
    try { g.localStorage.removeItem(schluessel); } catch (e) {}
  }

  var freigabeSitzung = null;   // Fallback, falls localStorage nicht schreibbar ist

  function freigabe() {
    if (freigabeSitzung) return freigabeSitzung;
    return lese(KEY_FREIGABE, null);
  }
  function istFrei() { return !!freigabe(); }

  // ---------------------------------------------------------------- Protokoll
  function protokolliere(eintrag) {
    var p = lese(KEY_PROTOKOLL, []);
    p.push(eintrag);
    if (p.length > PROTOKOLL_MAX) p = p.slice(p.length - PROTOKOLL_MAX);
    schreibe(KEY_PROTOKOLL, p);
    return eintrag;
  }

  function groesse(opts) {
    try {
      if (!opts || !opts.body) return 0;
      var b = (typeof opts.body === 'string') ? opts.body : JSON.stringify(opts.body);
      return b.length;
    } catch (e) { return 0; }
  }

  function enthaeltBild(opts) {
    try {
      if (!opts || !opts.body) return false;
      var b = (typeof opts.body === 'string') ? opts.body : JSON.stringify(opts.body);
      return b.indexOf('"image"') >= 0 || b.indexOf('base64') >= 0;
    } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- Hilfsmittel
  function urlText(u) {
    if (typeof u === 'string') return u;
    try { return (u && u.url) ? String(u.url) : String(u); } catch (e) { return ''; }
  }
  function trifft(u) {
    var s = urlText(u).toLowerCase();
    for (var i = 0; i < SPERRLISTE.length; i++) {
      if (s.indexOf(SPERRLISTE[i]) !== -1) return SPERRLISTE[i];
    }
    return null;
  }

  // ---------------------------------------------------------------- Dialog
  var DIALOG =
    'KI-MODUS FREIGEBEN?\n' +
    '========================================\n\n' +
    'Diese App arbeitet grundsaetzlich OFFLINE (kein Server, kein Backend,\n' +
    'keine Cloud). Sie sind im Begriff, diese Regel bewusst auszunehmen.\n\n' +
    'ZIEL DER UEBERTRAGUNG:\n' +
    '  {HOST}\n\n' +
    'WAS DAS BEDEUTET:\n' +
    '  - Die uebermittelten Inhalte verlassen Ihren Rechner.\n' +
    '  - Der Text-Tresor schwaerzt Namen, Kontaktdaten und die Strasse —\n' +
    '    aber Anonymisieren heisst immer noch SENDEN.\n' +
    '  - Bilder kann der Anonymisierer NICHT schwaerzen (Klingelschild,\n' +
    '    Kennzeichen, Briefkasten, Ausweis = Klarname).\n\n' +
    'PRUEFEN SIE VORHER:\n' +
    '  - Keine Lichtbilder mit erkennbaren Personendaten\n' +
    '  - Kein API-Schluessel dauerhaft in der Datei gespeichert\n\n' +
    'DIE FREIGABE GILT DAUERHAFT, bis Sie sie widerrufen.\n' +
    'Solange sie gilt, sehen Sie oben rechts einen Hinweis — ein Klick\n' +
    'darauf sperrt wieder zu. Jeder Aufruf wird protokolliert.\n\n' +
    'OK        = KI-Modus freigeben (bewusst getragene Ausnahme)\n' +
    'Abbrechen = gesperrt lassen (kein Datenabfluss)';

  function frageNach(host) {
    var ok = false;
    try { ok = g.confirm(DIALOG.replace('{HOST}', host)); } catch (e) { ok = false; }
    if (!ok) return false;

    var eintrag = {
      frei: true,
      zeit: new Date().toISOString(),
      host: host,
      version: VERSION,
      hinweis: 'Bewusste Ausnahme von der Offline-Regel, im Dialog bestaetigt.'
    };
    freigabeSitzung = eintrag;
    if (!schreibe(KEY_FREIGABE, eintrag)) {
      try { console.warn('[CLOUD-RIEGEL] localStorage nicht schreibbar — Freigabe gilt nur fuer diese Sitzung.'); } catch (x) {}
    }
    protokolliere({ zeit: eintrag.zeit, art: 'FREIGABE ERTEILT', host: host, weg: '-', bytes: 0, bild: false });
    anzeigerZeichnen();
    try { console.warn('[CLOUD-RIEGEL v' + VERSION + '] KI-MODUS FREIGEGEBEN — ' + host + ' — ' + eintrag.zeit); } catch (x) {}
    return true;
  }

  function verweigert(host, weg) {
    protokolliere({ zeit: new Date().toISOString(), art: 'ABGELEHNT', host: host, weg: weg, bytes: 0, bild: false });
    try {
      console.error('[CLOUD-RIEGEL] BLOCKIERT (' + weg + '): ' + host +
        ' — KI-Modus nicht freigegeben. Kein Datenabfluss erfolgt.');
    } catch (x) {}
    return new Error(
      'CLOUD-RIEGEL: Aufruf an ' + host + ' verweigert — KI-Modus ist gesperrt. ' +
      'Freigabe: im Dialog bestaetigen oder GSKR_CLOUD_RIEGEL.freigeben() in der Konsole. ' +
      'Kein Datenabfluss erfolgt.'
    );
  }

  // ---------------------------------------------------------------- Anzeiger
  // Eine dauerhafte Freigabe, die man vergisst, ist eine offene Tuer.
  // Der Anzeiger macht sie sichtbar und sperrt per Klick wieder zu.
  var anzeiger = null;

  function anzeigerZeichnen() {
    if (typeof g.document === 'undefined' || !g.document.body) return;
    if (!istFrei()) { anzeigerEntfernen(); return; }
    if (anzeiger) return;

    anzeiger = g.document.createElement('div');
    anzeiger.id = 'gskr-ki-anzeiger';
    anzeiger.setAttribute('title', 'KI-Modus ist freigegeben. Klicken, um wieder zu sperren.');
    anzeiger.style.cssText = [
      'position:fixed', 'top:10px', 'right:10px', 'z-index:2147483647',
      'background:#B4261A', 'color:#fff', 'font:600 12px/1.3 system-ui,Segoe UI,sans-serif',
      'padding:7px 12px', 'border-radius:5px', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.35)', 'user-select:none'
    ].join(';');
    anzeiger.innerHTML = 'KI-MODUS AKTIV &nbsp;&bull;&nbsp; Daten gehen an die Cloud' +
                         '<br><span style="font-weight:400;opacity:.85">Klicken zum Sperren</span>';
    anzeiger.onclick = function () {
      if (g.confirm('KI-Modus wieder SPERREN?\n\nDanach gehen keine Daten mehr an die Cloud.\nDas Protokoll bleibt erhalten.')) {
        API.sperren();
      }
    };
    g.document.body.appendChild(anzeiger);
  }

  function anzeigerEntfernen() {
    if (anzeiger && anzeiger.parentNode) anzeiger.parentNode.removeChild(anzeiger);
    anzeiger = null;
  }

  // ---------------------------------------------------------------- Wachen
  // 1) fetch
  var origFetch = g.fetch ? g.fetch.bind(g) : null;
  if (origFetch) {
    g.fetch = function (url, opts) {
      var host = trifft(url);
      if (!host) return origFetch(url, opts);      // fachliche Dienste: frei

      if (!istFrei() && !frageNach(host)) {
        return Promise.reject(verweigert(host, 'fetch'));
      }
      protokolliere({
        zeit: new Date().toISOString(), art: 'GESENDET', host: host, weg: 'fetch',
        bytes: groesse(opts), bild: enthaeltBild(opts)
      });
      return origFetch(url, opts);
    };
  }

  // 2) XMLHttpRequest
  if (g.XMLHttpRequest && g.XMLHttpRequest.prototype && g.XMLHttpRequest.prototype.open) {
    var origOpen = g.XMLHttpRequest.prototype.open;
    g.XMLHttpRequest.prototype.open = function (m, url) {
      var host = trifft(url);
      if (host) {
        if (!istFrei() && !frageNach(host)) throw verweigert(host, 'XHR');
        protokolliere({ zeit: new Date().toISOString(), art: 'GESENDET', host: host, weg: 'XHR', bytes: 0, bild: false });
      }
      return origOpen.apply(this, arguments);
    };
  }

  // 3) sendBeacon — bleibt HART gesperrt: ein Beacon kann nicht nachfragen
  //    (feuert oft beim Schliessen der Seite) und hat hier nichts zu suchen.
  if (g.navigator && typeof g.navigator.sendBeacon === 'function') {
    var origBeacon = g.navigator.sendBeacon.bind(g.navigator);
    g.navigator.sendBeacon = function (url, daten) {
      var host = trifft(url);
      if (host) { verweigert(host, 'sendBeacon'); return false; }
      return origBeacon(url, daten);
    };
  }

  // ---------------------------------------------------------------- API
  var API = {
    version: VERSION,
    sperrliste: SPERRLISTE.slice(),

    status: function () {
      var f = freigabe();
      return f
        ? { zustand: 'FREI', seit: f.zeit, host: f.host, hinweis: 'KI-Modus freigegeben — Ausnahme aktiv.' }
        : { zustand: 'GESPERRT', hinweis: 'Kein Datenabfluss an KI-Endpunkte moeglich.' };
    },

    freigeben: function () {
      if (istFrei()) return API.status();
      frageNach('api.anthropic.com');
      return API.status();
    },

    sperren: function () {
      freigabeSitzung = null;
      loesche(KEY_FREIGABE);
      protokolliere({ zeit: new Date().toISOString(), art: 'FREIGABE WIDERRUFEN', host: '-', weg: '-', bytes: 0, bild: false });
      anzeigerEntfernen();
      try { console.warn('[CLOUD-RIEGEL] KI-Modus GESPERRT. Kein Datenabfluss mehr moeglich.'); } catch (x) {}
      return API.status();
    },

    protokoll: function () { return lese(KEY_PROTOKOLL, []); },

    protokollLeeren: function () {
      if (!g.confirm('Protokoll wirklich loeschen?\n\nEs ist Ihr Nachweis, was wann an die Cloud ging.')) return false;
      loesche(KEY_PROTOKOLL);
      return true;
    },

    // Protokoll als Datei sichern — der eigentliche Sorgfaltsnachweis
    export: function () {
      var p = lese(KEY_PROTOKOLL, []);
      var inhalt = JSON.stringify({
        erzeugt: new Date().toISOString(),
        riegel_version: VERSION,
        status: API.status(),
        eintraege: p
      }, null, 2);
      try {
        var blob = new Blob([inhalt], { type: 'application/json' });
        var a = g.document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'GSKR_KI-Protokoll_' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
        return 'Protokoll exportiert (' + p.length + ' Eintraege).';
      } catch (e) { return inhalt; }
    },

    test: function () {
      var vorher = API.status().zustand;
      return g.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' })
        .then(function () { return 'Riegel liess durch — Zustand war: ' + vorher + ' (bei FREI ist das korrekt).'; })
        .catch(function (e) { return 'Riegel griff — ' + e.message; });
    }
  };

  g.GSKR_CLOUD_RIEGEL = API;

  // Anzeiger setzen, sobald das DOM steht
  if (typeof g.document !== 'undefined') {
    if (g.document.readyState === 'loading') {
      g.document.addEventListener('DOMContentLoaded', anzeigerZeichnen);
    } else {
      anzeigerZeichnen();
    }
  }

  try {
    console.log('[CLOUD-RIEGEL v' + VERSION + '] aktiv — Zustand: ' + API.status().zustand +
                ' — ' + SPERRLISTE.length + ' KI-Endpunkte ueberwacht. ' +
                'Konsole: GSKR_CLOUD_RIEGEL.status()');
  } catch (x) {}

})(typeof window !== 'undefined' ? window : globalThis);
