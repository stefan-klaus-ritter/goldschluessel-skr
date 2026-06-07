/**
 * GSKR ZEUS-OLYMP Anonymisierungs-Wrapper
 * v1.7.0-SHOCK · 06.06.2026
 *
 * Zweck:
 *   Vermittelt zwischen App2/App3 und der ZEUS/OLYMP-KI-Familie so, dass KEINE
 *   personenbezogenen Daten den Browser verlassen.
 *
 * Workflow:
 *   1. App ruft  GSKR_ZEUS.frage(prompt, akte_obj)  auf
 *   2. Wrapper anonymisiert  prompt  +  akte_obj  per GSKR_ANON
 *   3. Wrapper schickt anonymisiertes Prompt an ZEUS/Olymp-Endpoint
 *   4. Wrapper bekommt anonymisierten Output zurück (enthält weiterhin Tokens)
 *   5. Wrapper de-anonymisiert den Output und gibt ihn an die App zurück
 *   6. Beide Varianten werden in /80_archiv_original/ und /81_archiv_anonym/
 *      mit Zeitstempel + Hash protokolliert
 *
 * Voraussetzung:
 *   - GSKR_ANON ist mit Akten-Schlüssel initialisiert
 *   - GSKR_NEXTCLOUD ist verbunden (für Archivierung)
 *   - ZEUS-Endpoint ist konfiguriert (window.ZEUS_ENDPOINT) oder
 *     Olymp-Skills laufen lokal über window.OLYMP_LOKAL
 */
(function(g){
  'use strict';

  var CFG = {
    zeus_endpoint: '',          // z.B. 'https://api.openai.com/v1/chat/completions'
    zeus_modell: 'gpt-4o',      // oder 'claude-opus-4', 'mistral-large', etc.
    olymp_lokal: false,         // wenn true: OLYMP-Skills laufen lokal
    api_key: '',                // wird NUR im Speicher gehalten, nie persistiert
    max_tokens: 4000,
    temperatur: 0.3,
    timeout_ms: 60000,
    archiv_aktiv: true,         // beide Varianten in NC archivieren
    audit_jeden_aufruf: true
  };

  function init(opts) {
    Object.keys(opts || {}).forEach(function(k){ CFG[k] = opts[k]; });
  }

  // ── Haupt-Funktion: Frage stellen ─────────────────────────────────────
  async function frage(user_prompt, akte_obj, opts) {
    opts = opts || {};
    if (!window.GSKR_ANON || !window.GSKR_ANON._STATE.ready) {
      throw new Error('GSKR_ANON nicht initialisiert — Akten-Schlüssel fehlt');
    }

    // 1. Original-Daten archivieren (Hash-Quittung)
    var sammel_original = {
      ts: new Date().toISOString(),
      typ: 'zeus-anfrage',
      prompt: user_prompt,
      akte: akte_obj,
      modell: opts.modell || CFG.zeus_modell
    };

    // 2. Anonymisierung
    var prompt_anon = await window.GSKR_ANON.anonymisiereText(user_prompt);
    var akte_anon = await window.GSKR_ANON.anonymisiereObjekt(akte_obj);

    var sammel_anon = {
      ts: sammel_original.ts,
      typ: 'zeus-anfrage-anonymisiert',
      prompt: prompt_anon,
      akte: akte_anon,
      modell: sammel_original.modell,
      anon_statistik: window.GSKR_ANON.statistik()
    };

    // 3. ZEUS aufrufen (mit anonymisierten Daten)
    var antwort_anon;
    try {
      if (CFG.olymp_lokal && window.OLYMP_LOKAL && typeof window.OLYMP_LOKAL.frage === 'function') {
        // Olymp-Skills laufen lokal (z. B. via Web Worker mit Mistral.cpp WASM)
        antwort_anon = await window.OLYMP_LOKAL.frage(prompt_anon, akte_anon, opts);
      } else if (CFG.zeus_endpoint) {
        antwort_anon = await _zeusHTTPAufruf(prompt_anon, akte_anon, opts);
      } else {
        // Fallback / Dry-Run: Echo zurückgeben (für Test)
        antwort_anon = '[DRY-RUN] Anonymisierter Prompt erhalten ('+prompt_anon.length+' Zeichen). ' +
                       'KEIN externer ZEUS-Endpoint konfiguriert.';
      }
    } catch (e) {
      throw new Error('ZEUS-Aufruf fehlgeschlagen: ' + (e.message || e));
    }

    // 4. De-Anonymisierung des Outputs
    var antwort_original = window.GSKR_ANON.deAnonymisiereText(antwort_anon);

    // 5. Beide Varianten archivieren
    if (CFG.archiv_aktiv && window.GSKR_NEXTCLOUD) {
      try {
        await archiviereBeideVarianten(sammel_original, sammel_anon,
          antwort_original, antwort_anon);
      } catch (e) {
        console.warn('[ZEUS-Wrapper] Archivierung fehlgeschlagen:', e);
      }
    }

    return {
      original_antwort: antwort_original,
      anonymisierte_antwort: antwort_anon,
      anonymisierte_anfrage: prompt_anon,
      ts: sammel_original.ts,
      modell: sammel_original.modell,
      anon_statistik: sammel_anon.anon_statistik
    };
  }

  // ── HTTP-Aufruf an ZEUS-Endpoint (OpenAI-kompatibles Format) ──────────
  async function _zeusHTTPAufruf(prompt_anon, akte_anon, opts) {
    // OpenAI-kompatibles Chat-API
    var messages = [
      { role: 'system', content: 'Du bist ZEUS, der digitale Baugutachter im SKR-Stil. ' +
        'Alle Personen-, Firmen- und Kontaktdaten sind als Token wie [PERS_xxx], [FIRMA_xxx], ' +
        '[EMAIL_xxx], [TEL_xxx] anonymisiert. Verwende die Tokens unverändert in deiner Antwort — ' +
        'sie werden vom Wrapper später durch die Originale ersetzt.' },
      { role: 'user', content: prompt_anon + '\n\nAKTE-DATEN (JSON, anonymisiert):\n' +
        JSON.stringify(akte_anon, null, 2) }
    ];

    var resp = await fetch(CFG.zeus_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CFG.api_key
      },
      body: JSON.stringify({
        model: opts.modell || CFG.zeus_modell,
        messages: messages,
        max_tokens: opts.max_tokens || CFG.max_tokens,
        temperature: opts.temperatur != null ? opts.temperatur : CFG.temperatur
      })
    });

    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()).substring(0, 200));
    }
    var data = await resp.json();

    // OpenAI / Anthropic Format
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content || '';
    }
    if (data.content && Array.isArray(data.content) && data.content[0]) {
      return data.content[0].text || '';
    }
    if (typeof data.completion === 'string') return data.completion;
    return JSON.stringify(data);
  }

  // ── Archivierung beider Varianten ─────────────────────────────────────
  async function archiviereBeideVarianten(orig_anfrage, anon_anfrage, orig_antwort, anon_antwort) {
    var nc = window.GSKR_NEXTCLOUD;
    if (!nc) return;
    var ts = orig_anfrage.ts.replace(/[:.]/g, '-');

    // Ordner anlegen (idempotent)
    await nc.mkcol(nc.aktenPfad('80_archiv_original')).catch(function(){});
    await nc.mkcol(nc.aktenPfad('81_archiv_anonym')).catch(function(){});

    // Original-Sammelarchiv
    var archivOrig = {
      typ: 'zeus-aufruf',
      anfrage: orig_anfrage,
      antwort: orig_antwort,
      ts_archiviert: new Date().toISOString()
    };
    var blobOrig = new Blob([JSON.stringify(archivOrig, null, 2)],
      { type: 'application/json' });
    await nc.put(nc.aktenPfad('80_archiv_original/zeus_'+ts+'.json'),
      blobOrig, 'application/json');

    // Anonymisierte Variante
    var archivAnon = {
      typ: 'zeus-aufruf-anonymisiert',
      anfrage: anon_anfrage,
      antwort: anon_antwort,
      ts_archiviert: new Date().toISOString(),
      hinweis: 'Diese Variante darf von der KI ungehindert eingesehen werden — enthält nur Tokens.'
    };
    var blobAnon = new Blob([JSON.stringify(archivAnon, null, 2)],
      { type: 'application/json' });
    await nc.put(nc.aktenPfad('81_archiv_anonym/zeus_'+ts+'.json'),
      blobAnon, 'application/json');

    return { original: '80_archiv_original/zeus_'+ts+'.json',
             anonym:   '81_archiv_anonym/zeus_'+ts+'.json' };
  }

  // ── Spezial-Workflow: Vollgutachten erzeugen ──────────────────────────
  // Lädt Akten-Daten von Nextcloud, schickt anonymisiert an ZEUS,
  // bekommt Gutachten-Text zurück, de-anonymisiert ihn, archiviert beide
  // Varianten und speichert das fertige Gutachten in 03_gutachten/
  async function erzeugeVollgutachten(akten_id, anweisung_prompt) {
    var nc = window.GSKR_NEXTCLOUD;
    if (!nc) throw new Error('Nextcloud-Adapter nicht verbunden');

    // 1. Akten-Daten laden
    var auftrag = await nc.getJSON(nc.aktenPfad('00_auftrag/auftrag.json')).catch(function(){ return {}; });
    var befunde = await _ladeOrdnerJSON('01_vorortdoku', nc);
    var messungen = await _ladeOrdnerJSON('02_messungen', nc);
    var kosten = await nc.getJSON(nc.aktenPfad('04_kosten/kalkulation.json')).catch(function(){ return {}; });

    var akte = {
      akten_id: akten_id,
      auftrag: auftrag,
      befunde: befunde,
      messungen: messungen,
      kosten: kosten
    };

    // 2. ZEUS aufrufen
    var ergebnis = await frage(anweisung_prompt || 'Erstelle ein vollständiges Bausachverständigen-Gutachten im SKR-Stil.', akte);

    // 3. Gutachten als HTML/Text speichern
    var ts = ergebnis.ts.replace(/[:.]/g, '-');
    var dateiname = 'Vollgutachten_ZEUS_' + ts + '.md';
    var blob = new Blob([ergebnis.original_antwort], { type: 'text/markdown' });
    await nc.put(nc.aktenPfad('03_gutachten/' + dateiname), blob, 'text/markdown');

    return {
      gutachten_pfad: '03_gutachten/' + dateiname,
      anonym_statistik: ergebnis.anon_statistik,
      laenge_zeichen: ergebnis.original_antwort.length
    };
  }

  async function _ladeOrdnerJSON(unterordner, nc) {
    // Lädt alle .json-Dateien in einem Akten-Unterordner per PROPFIND + GET
    try {
      var liste = await nc.propfind(nc.aktenPfad(unterordner), 1);
      var jsons = [];
      for (var eintrag of liste) {
        if (eintrag.href.endsWith('.json')) {
          var rel = eintrag.href.replace(/^.*\/Hauskaufberatung\//,'/Hauskaufberatung/');
          try {
            var data = await nc.getJSON(rel);
            jsons.push(data);
          } catch(e) {}
        }
      }
      return jsons;
    } catch(e) { return []; }
  }

  // ── API-Schlüssel sicher speichern (Session-only, nie in localStorage) ─
  function setzeApiKey(key) {
    CFG.api_key = key;
    // KEIN localStorage.setItem — Schlüssel verschwindet bei Tab-Schließung
  }

  g.GSKR_ZEUS = {
    init: init,
    frage: frage,
    erzeugeVollgutachten: erzeugeVollgutachten,
    archiviereBeideVarianten: archiviereBeideVarianten,
    setzeApiKey: setzeApiKey,
    config: CFG
  };

})(typeof window !== 'undefined' ? window : globalThis);
