/**
 * GSKR Werte-Loader v1.0 · 14.06.2026
 * -----------------------------------
 * Laedt zentrale Konfiguration aus gskr-config.json und stellt sie als
 * window.GSKR_CONFIG bereit. Apps koennen damit ihre hardcoded Werte
 * ueberschreiben, ohne neu verschluesselt werden zu muessen.
 *
 * Anwendung in der App:
 *   var NHK = (window.GSKR_CONFIG && window.GSKR_CONFIG.bewertung.NHK_RICHTWERT_2026) || 2200;
 *
 * Wenn das Laden fehlschlaegt: GSKR_CONFIG bleibt null, App nutzt eingebackene
 * Defaults. Damit bleibt die App auch offline funktionsfaehig.
 */
(function(g){
  'use strict';
  var URL = 'gskr-config.json';
  g.GSKR_CONFIG = null;
  g.GSKR_CONFIG_READY = false;

  function setReady(){
    g.GSKR_CONFIG_READY = true;
    try { g.dispatchEvent(new Event('gskr-config-ready')); } catch(e){}
  }

  // Sync-Versuch via XHR (damit Apps die Werte vor App-Mount sehen)
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', URL + '?t=' + Date.now(), false);  // synchron — bewusst, weil vor App-Mount
    xhr.send(null);
    if (xhr.status >= 200 && xhr.status < 400) {
      var data = JSON.parse(xhr.responseText);
      g.GSKR_CONFIG = data;
      setReady();
      console.log('[GSKR-Config] geladen, Stand:', data && data._meta && data._meta.aktualisiert);
    } else {
      console.warn('[GSKR-Config] HTTP', xhr.status);
    }
  } catch(e) {
    console.warn('[GSKR-Config] Sync-Laden fehlgeschlagen:', e.message);
  }

  // Async-Fallback (falls Sync geblockt war — z. B. file://)
  if (!g.GSKR_CONFIG) {
    fetch(URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(data){
        g.GSKR_CONFIG = data;
        setReady();
        console.log('[GSKR-Config] async geladen');
      })
      .catch(function(e){
        console.warn('[GSKR-Config] auch async fehlgeschlagen, Apps nutzen Defaults:', e.message);
      });
  }

  // Komfort-Helfer für Apps
  g.GSKR_WERT = function(pfad, defaultWert) {
    if (!g.GSKR_CONFIG) return defaultWert;
    var teile = pfad.split('.');
    var v = g.GSKR_CONFIG;
    for (var i = 0; i < teile.length; i++) {
      if (v && Object.prototype.hasOwnProperty.call(v, teile[i])) v = v[teile[i]];
      else return defaultWert;
    }
    return (v !== undefined && v !== null) ? v : defaultWert;
  };

  // Beispiel-Aufrufe:
  // var nhk = window.GSKR_WERT('bewertung.NHK_RICHTWERT_2026', 2200);
  // var bpi = window.GSKR_WERT('bewertung.BPI_2010_2026', 1.65);

})(typeof window !== 'undefined' ? window : globalThis);
