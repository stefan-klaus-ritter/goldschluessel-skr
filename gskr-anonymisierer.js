/**
 * GSKR Anonymisierer — Pseudonymisierung für KI-Verarbeitung
 * v1.7.0-SHOCK · 06.06.2026
 *
 * Architektur:
 *   1. Original-PII (Personen, Adressen, E-Mails, Telefon, Firmen) wird per
 *      regulärem Ausdruck erkannt.
 *   2. Jede PII wird per HMAC-SHA-256 (Akten-Schlüssel) deterministisch zu einem
 *      Token gemappt: gleicher Input → IMMER gleicher Token (innerhalb der Akte).
 *   3. Die Token-Map (Original ↔ Token) wird verschlüsselt in
 *      99_meta/anon_map.gskr-enc abgelegt — nur Stefan/SV kann sie entschlüsseln.
 *   4. Die KI sieht nur anonymisierte Texte. Sie produziert Texte, die weiterhin
 *      die Tokens enthalten.
 *   5. Beim Word/PDF/HTML-Export werden die Tokens zurück durch Originale ersetzt.
 *   6. Beide Varianten (original + anonym) werden archiviert.
 *
 * Wichtig:
 *   - Token-Format: [PERS_a3f2b1c8] — leicht erkennbar, leicht zu maskieren.
 *   - Determinismus: Mustermann → Hash(HMAC) → [PERS_a3f2b1c8] in Akte A.
 *                    In Akte B mit anderem Schlüssel → anderer Token.
 *   - Reverse-Map wird NIE roh gespeichert — immer AES-GCM-verschlüsselt.
 *
 * USP: Brikks, Hausgeist, ImmoSmart schicken Klartextdaten an OpenAI/Anthropic-API.
 *      Goldschlüssel SKR schickt nur Pseudonyme. DSGVO Art. 4 Nr. 5 erfüllt.
 */
(function(g){
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  var STATE = {
    aktenSchluessel: null,    // CryptoKey für HMAC
    aktenSchluesselRaw: null, // Roh-Material für Persistenz (nicht in Klartext)
    tokenMap: new Map(),      // Original (lowercase) → { token, typ, original_case }
    reverseMap: new Map(),    // Token → Original (case-erhaltend)
    ready: false
  };

  // ── HMAC-Schlüssel aus Mandanten-Master-Passwort ableiten ──────────────
  async function init(akten_master_passwort, akten_id) {
    var enc = new TextEncoder();
    // Salt aus Akten-ID — somit ist Schlüssel akten-spezifisch
    var saltBytes = await crypto.subtle.digest('SHA-256', enc.encode('GSKR-ANON-SALT-' + akten_id));
    var salt = new Uint8Array(saltBytes).slice(0, 16);

    var baseKey = await crypto.subtle.importKey(
      'raw', enc.encode(akten_master_passwort),
      'PBKDF2', false, ['deriveKey']
    );
    var hmacKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: 310000, hash: 'SHA-256' },
      baseKey,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign']
    );
    STATE.aktenSchluessel = hmacKey;
    STATE.ready = true;
    STATE.aktenId = akten_id;
  }

  // ── Token-Erzeugung (deterministisch via HMAC) ─────────────────────────
  async function _hmacHexShort(input) {
    if (!STATE.ready) throw new Error('Anonymisierer nicht initialisiert (gskr_anon.init)');
    var enc = new TextEncoder();
    var sig = await crypto.subtle.sign('HMAC', STATE.aktenSchluessel, enc.encode(input));
    return [...new Uint8Array(sig)].slice(0, 4)
      .map(b => b.toString(16).padStart(2,'0')).join('');
  }

  async function tokenFuer(typ, original_text) {
    var key = typ.toUpperCase() + ':' + original_text.trim().toLowerCase();
    if (STATE.tokenMap.has(key)) return STATE.tokenMap.get(key).token;
    var hex = await _hmacHexShort(key);
    var token = '[' + typ.toUpperCase() + '_' + hex + ']';
    STATE.tokenMap.set(key, { token: token, typ: typ, original: original_text });
    STATE.reverseMap.set(token, original_text);
    return token;
  }

  // ── PII-Erkenner (deutsch) ─────────────────────────────────────────────
  var REGEX = {
    // E-Mail: RFC 5322 vereinfacht
    EMAIL: /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi,

    // Deutsche Telefonnummern (sehr tolerant)
    //   +49 ..., 0049 ..., 0 ... mit Klammern, Bindestrichen, Leerzeichen
    TEL: /(?:\+49|0049|0)[\s\-\(\)\/]?\d{2,5}[\s\-\/]?\d{2,4}[\s\-\/]?\d{2,8}/g,

    // Postleitzahl + Stadt: "71384 Weinstadt" oder "71384 Weinstadt-Endersbach"
    PLZ_STADT: /\b(\d{5})\s+([A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?)/g,

    // Straße + Hausnummer: "Hauptstr. 12" / "Hauptstraße 12a" / "Schillerstraße 12-14"
    STRASSE_HNR: /\b([A-ZÄÖÜ][a-zäöüß]+(?:str\.|straße|strasse|weg|allee|platz|gasse|ring|damm))\s+(\d{1,4}[a-zA-Z]?(?:-\d{1,4})?)/g,

    // Firmen-Endung: "Mustermann GmbH" / "Müller AG" / "Klaus & Sohn KG"
    FIRMA: /\b([A-ZÄÖÜ][\wäöüß\s\.\&\-]{1,40}?)\s+(GmbH|AG|KG|GbR|OHG|e\.\s?K\.|UG\s*\(?haftungsbeschränkt\)?|SE|mbH|GmbH\s+&\s+Co\.\s*KG)\b/g,

    // Personen (Vor- + Nachname): zwei Großbuchstaben-Wörter direkt hintereinander
    //   "Stefan Klaus Ritter" (3 Wörter) wird ebenfalls erfasst
    PERSON: /\b([A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?)\s+([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)?)/g,

    // IBAN
    IBAN: /\b(DE\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{2})\b/g,

    // Steuer-Nummer (vereinfacht — Variationen)
    STEUER: /\b\d{2,3}\/\d{3}\/\d{4,5}\b/g
  };

  // Whitelist deutscher Wörter, die wie Namen aussehen aber keine sind
  var PERSON_WHITELIST = new Set([
    'Herr', 'Frau', 'Herrn', 'Eigentümer', 'Eigentuemer', 'Bauherr', 'Bauherrin',
    'Käufer', 'Kaeufer', 'Käuferin', 'Verkäufer', 'Verkaeufer', 'Mieter', 'Mieterin',
    'Sachverständiger', 'Sachverstaendiger', 'Sachverständige',
    'Datum', 'Ortstermin', 'Akte', 'Mandant', 'Mandantin',
    'Wand', 'Decke', 'Boden', 'Fenster', 'Tür', 'Tueren', 'Türen',
    'Berlin', 'München', 'Hamburg', 'Köln', 'Frankfurt', 'Stuttgart' // Großstädte ausnehmen
    // (Mikrostädte besser separat behandeln)
  ]);

  // Listen für besseren Vornamen-Match
  var DEUTSCHE_VORNAMEN = new Set([
    'Stefan','Klaus','Hans','Peter','Michael','Thomas','Wolfgang','Jürgen','Andreas','Christian','Martin',
    'Maria','Anna','Sabine','Petra','Susanne','Brigitte','Andrea','Monika','Birgit','Heike','Karin',
    'Alexander','Christoph','Daniel','Frank','Gerhard','Helmut','Jens','Joachim','Manfred','Markus','Matthias',
    'Mustermann','Müller','Schmidt','Schneider','Fischer','Weber','Meyer','Wagner','Becker','Schulz'
  ]);

  // ── Anonymisierung eines Strings ──────────────────────────────────────
  async function anonymisiereText(text) {
    if (typeof text !== 'string' || !text) return text;
    var result = text;

    // Reihenfolge: spezifische Muster zuerst, weniger spezifische zuletzt
    result = await _ersetzeAlle(result, REGEX.EMAIL, 'EMAIL');
    result = await _ersetzeAlle(result, REGEX.TEL, 'TEL');
    result = await _ersetzeAlle(result, REGEX.IBAN, 'IBAN');
    result = await _ersetzeAlle(result, REGEX.STEUER, 'STEUERNR');

    // Firma vor Person — vermeidet dass "Mustermann GmbH" als Person erkannt wird
    result = await _ersetzeAlle(result, REGEX.FIRMA, 'FIRMA',
      m => m[1].trim() + ' ' + m[2].trim());

    // Straße + Hausnummer (kombiniert als 1 Adresse)
    result = await _ersetzeAlle(result, REGEX.STRASSE_HNR, 'STRASSE',
      m => m[1].trim() + ' ' + m[2].trim());

    // PLZ + Stadt (kombiniert)
    result = await _ersetzeAlle(result, REGEX.PLZ_STADT, 'PLZSTADT',
      m => m[1] + ' ' + m[2].trim());

    // Personen — mit Whitelist-Filter und Vornamen-Heuristik
    result = await _ersetzeAlle(result, REGEX.PERSON, 'PERS', function(m) {
      // Ablehnen wenn erstes oder zweites Wort in Whitelist
      if (PERSON_WHITELIST.has(m[1]) || PERSON_WHITELIST.has(m[2])) return null;
      // Wenn beide Wörter NICHT in Vornamen-Liste UND mehrteilig, eher ablehnen
      // Hier: akzeptiere wenn das erste Wort wie deutscher Vorname aussieht,
      //       oder wenn das ganze Match drei Wörter hat (typisch Vor-Mittel-Nach)
      var teile = m[0].split(/\s+/);
      if (teile.length >= 3) return m[0]; // 3+ Wörter, vermutlich Vor-Mittel-Nach
      if (DEUTSCHE_VORNAMEN.has(m[1])) return m[0];
      if (DEUTSCHE_VORNAMEN.has(m[2])) return m[0];
      // Fallback: wenn zweites Wort kurz und mit deutschem Endmuster
      if (/[ae]r$/.test(m[2]) || /sson$/.test(m[2]) || /mann$/.test(m[2])) return m[0];
      return null; // ablehnen
    });

    return result;
  }

  // Hilfsfunktion: ein Regex auf String anwenden und Matches durch Tokens ersetzen
  async function _ersetzeAlle(text, regex, typ, normalizer) {
    var matches = [];
    var re = new RegExp(regex.source, regex.flags);
    var m;
    while ((m = re.exec(text)) !== null) {
      var original_match = m[0];
      var normalized = normalizer ? normalizer(m) : original_match;
      if (normalized === null) continue; // wird verworfen
      matches.push({ start: m.index, end: m.index + original_match.length,
                     match: original_match, normalized: normalized });
    }
    // Von hinten nach vorn ersetzen, damit Indizes stabil bleiben
    matches.sort((a,b) => b.start - a.start);
    for (var i = 0; i < matches.length; i++) {
      var token = await tokenFuer(typ, matches[i].normalized);
      // Original-Casing für Reverse-Map merken
      STATE.reverseMap.set(token, matches[i].match);
      text = text.substring(0, matches[i].start) + token +
             text.substring(matches[i].end);
    }
    return text;
  }

  // ── De-Anonymisierung: Tokens zurück durch Originale ───────────────────
  function deAnonymisiereText(text) {
    if (typeof text !== 'string' || !text) return text;
    // Pattern für Tokens: [TYP_xxxxxxxx]
    return text.replace(/\[([A-Z]+)_([0-9a-f]{8})\]/g, function(treffer) {
      return STATE.reverseMap.get(treffer) || treffer;
    });
  }

  // ── Rekursiv über JSON-Strukturen ──────────────────────────────────────
  async function anonymisiereObjekt(obj) {
    if (obj == null) return obj;
    if (typeof obj === 'string') return await anonymisiereText(obj);
    if (Array.isArray(obj)) {
      var out = [];
      for (var i = 0; i < obj.length; i++) out.push(await anonymisiereObjekt(obj[i]));
      return out;
    }
    if (typeof obj === 'object') {
      var out2 = {};
      for (var k of Object.keys(obj)) {
        // Schlüssel nicht anonymisieren, nur Werte
        out2[k] = await anonymisiereObjekt(obj[k]);
      }
      return out2;
    }
    return obj;
  }

  function deAnonymisiereObjekt(obj) {
    if (obj == null) return obj;
    if (typeof obj === 'string') return deAnonymisiereText(obj);
    if (Array.isArray(obj)) return obj.map(deAnonymisiereObjekt);
    if (typeof obj === 'object') {
      var out = {};
      for (var k of Object.keys(obj)) out[k] = deAnonymisiereObjekt(obj[k]);
      return out;
    }
    return obj;
  }

  // ── Token-Map persistieren (AES-GCM verschlüsselt) ─────────────────────
  async function mapExportieren(verschluesselungs_passwort) {
    if (!window.GSKR_CRYPTO) throw new Error('gskr-crypto.js fehlt');
    var serialisierbar = {
      version: '1.0',
      akten_id: STATE.aktenId,
      erstellt: new Date().toISOString(),
      eintraege: [...STATE.tokenMap.entries()].map(([k,v]) => ({
        key: k, token: v.token, typ: v.typ, original: v.original
      })),
      // Auch reverse für case-erhaltend
      reverse: [...STATE.reverseMap.entries()].map(([t,o]) => ({ token: t, original: o }))
    };
    return await window.GSKR_CRYPTO.verschluesselnJSON(serialisierbar, verschluesselungs_passwort);
  }

  async function mapImportieren(verschluesselter_blob, verschluesselungs_passwort) {
    if (!window.GSKR_CRYPTO) throw new Error('gskr-crypto.js fehlt');
    var serialisiert = await window.GSKR_CRYPTO.entschluesselnJSON(verschluesselter_blob, verschluesselungs_passwort);
    STATE.tokenMap.clear();
    STATE.reverseMap.clear();
    for (var e of serialisiert.eintraege) {
      STATE.tokenMap.set(e.key, { token: e.token, typ: e.typ, original: e.original });
    }
    for (var r of (serialisiert.reverse || [])) {
      STATE.reverseMap.set(r.token, r.original);
    }
    return { eintraege: serialisiert.eintraege.length };
  }

  // ── Statistik / Audit ──────────────────────────────────────────────────
  function statistik() {
    var nach_typ = {};
    for (var v of STATE.tokenMap.values()) {
      nach_typ[v.typ] = (nach_typ[v.typ]||0) + 1;
    }
    return {
      gesamt_eintraege: STATE.tokenMap.size,
      verteilung_nach_typ: nach_typ,
      akten_id: STATE.aktenId,
      bereit: STATE.ready
    };
  }

  // ── Map zurücksetzen (z. B. bei Akten-Wechsel) ─────────────────────────
  function reset() {
    STATE.tokenMap.clear();
    STATE.reverseMap.clear();
    STATE.aktenSchluessel = null;
    STATE.ready = false;
    STATE.aktenId = null;
  }

  g.GSKR_ANON = {
    init: init,
    anonymisiereText: anonymisiereText,
    anonymisiereObjekt: anonymisiereObjekt,
    deAnonymisiereText: deAnonymisiereText,
    deAnonymisiereObjekt: deAnonymisiereObjekt,
    tokenFuer: tokenFuer,
    mapExportieren: mapExportieren,
    mapImportieren: mapImportieren,
    statistik: statistik,
    reset: reset,
    _STATE: STATE, // debug
    _REGEX: REGEX
  };

})(typeof window !== 'undefined' ? window : globalThis);
