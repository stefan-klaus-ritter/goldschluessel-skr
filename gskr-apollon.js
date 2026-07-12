/* ==========================================================================
 * gskr-apollon.js — Bildforensik (GSKR_APOLLON)
 * --------------------------------------------------------------------------
 * HERKUNFT : 1:1 extrahiert aus der internen Referenz-Fassung,
 *            Extraktion am 12.07.2026. Logik unveraendert (byte-gleich).
 * ZWECK    : EXIF-Auswertung (Aufnahmezeit, GPS, Geraet), JPEG-Quantisierungstabellen, Manipulations-Indizien, Batch-Analyse.
 * API      : GSKR_APOLLON: readExif, readJpegQuantTables, analyse, batchAnalyse, gpsMapUrl
 * ABHAENGIG: KEINE GSKR-Module. Browser: FileReader, DataView. gpsMapUrl erzeugt nur einen OpenStreetMap-Link (kein Abruf).
 *
 * DOPPELTE DEFINITION: Die interne Referenz-Fassung laedt diese Datei NICHT per <script src> — sie
 * enthaelt den Code weiterhin inline. Es entsteht in der internen Referenz-Fassung also KEINE doppelte
 * Definition. Geladen wird die Datei nur von App1/App2, wo bisher ein 404 lief.
 * Aendert sich diese Datei, muss der Inline-Block in der internen Referenz-Fassung nachgezogen werden
 * (sonst driften die Fassungen auseinander).
 *
 * KEIN GEHEIMNIS: enthaelt keine Keys/Passwoerter/URLs/Mandantendaten.
 *                 Alle Config-Felder sind leer und werden zur Laufzeit gesetzt.
 * ========================================================================== */
/**
 * GSKR Apollon — Bild-Forensik im Browser
 * v1.7.0-SHOCK · 06.06.2026
 *
 * - SHA-256-Hash jedes Bildes (Web Crypto API)
 * - EXIF-Auswertung: Kamera, Aufnahme-Zeit, GPS-Koordinaten
 * - JPEG-Quantisierungs-Tabellen extrahieren (für ELA-Analyse)
 * - Forensische Quittung als JSON pro Foto
 * - Funktioniert OHNE Server — alles client-side
 *
 * Kein Server, keine Drittland-API. Mandantendaten verlassen das Gerät nie.
 */
(function(g){
  'use strict';

  // ── SHA-256 (Web Crypto API) ────────────────────────────────────
  async function sha256(blob){
    const buf = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('');
  }

  // ── EXIF-Reader (minimal, JPEG only) ────────────────────────────
  async function readExif(blob){
    const buf = await blob.arrayBuffer();
    const dv = new DataView(buf);
    if (dv.byteLength < 4) return null;
    if (dv.getUint16(0) !== 0xFFD8) return null; // kein JPEG

    let offset = 2;
    while (offset < dv.byteLength) {
      if (dv.getUint8(offset) !== 0xFF) return null;
      const marker = dv.getUint8(offset+1);
      const size = dv.getUint16(offset+2);
      if (marker === 0xE1) { // APP1 (EXIF)
        // "Exif\0\0"
        if (dv.getUint32(offset+4) === 0x45786966 && dv.getUint16(offset+8) === 0x0000) {
          return parseTiff(dv, offset+10, size-8);
        }
      }
      if (marker === 0xDA) break; // SOS
      offset += 2 + size;
    }
    return null;
  }

  function parseTiff(dv, start, length) {
    const little = dv.getUint16(start) === 0x4949;
    function u16(o){ return dv.getUint16(start+o, little); }
    function u32(o){ return dv.getUint32(start+o, little); }
    function s16(o){ return dv.getInt16(start+o, little); }
    function s32(o){ return dv.getInt32(start+o, little); }
    function readEntry(o) {
      return { tag: u16(o), type: u16(o+2), count: u32(o+4), valOff: u32(o+8), entryOff: o };
    }
    function readValue(e) {
      const offset = e.count * typeSize(e.type) <= 4 ? e.entryOff + 8 : e.valOff;
      switch (e.type) {
        case 1: case 7: return new Uint8Array(dv.buffer, dv.byteOffset + start + offset, e.count);
        case 2: { // ASCII
          let s = '';
          for (let i=0; i<e.count; i++) {
            const c = dv.getUint8(start+offset+i);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        }
        case 3: { // SHORT
          const arr = []; for (let i=0; i<e.count; i++) arr.push(u16(offset+i*2));
          return e.count===1?arr[0]:arr;
        }
        case 4: { // LONG
          const arr = []; for (let i=0; i<e.count; i++) arr.push(u32(offset+i*4));
          return e.count===1?arr[0]:arr;
        }
        case 5: { // RATIONAL
          const arr = [];
          for (let i=0; i<e.count; i++) {
            arr.push([u32(offset+i*8), u32(offset+i*8+4)]);
          }
          return e.count===1?arr[0]:arr;
        }
        case 10: { // SRATIONAL
          const arr = [];
          for (let i=0; i<e.count; i++) arr.push([s32(offset+i*8), s32(offset+i*8+4)]);
          return e.count===1?arr[0]:arr;
        }
        default: return null;
      }
    }
    function typeSize(t){ return [0,1,1,2,4,8,1,1,2,4,8,4,8][t] || 1; }

    const ifd0Off = u32(4);
    const numEntries = u16(ifd0Off);
    const result = { _raw: {}, kamera: null, software: null, aufnahmeZeit: null, gps: null, abmessungen: null };

    // TAGS:  0x010F=Make, 0x0110=Model, 0x0131=Software, 0x9003=DateTimeOriginal,
    //        0x8825=GPSIFDPointer, 0x8769=ExifIFDPointer, 0xA002=PixelXDim, 0xA003=PixelYDim
    let exifIfdOff = null, gpsIfdOff = null;
    for (let i=0; i<numEntries; i++) {
      const e = readEntry(ifd0Off + 2 + i*12);
      const v = readValue(e);
      result._raw['ifd0_'+e.tag.toString(16)] = v;
      if (e.tag === 0x010F) result.kamera = (result.kamera||{}); result.kamera = result.kamera||{}; if (e.tag===0x010F) result.kamera.hersteller = (v||'').toString().trim();
      if (e.tag === 0x0110) { result.kamera = result.kamera || {}; result.kamera.modell = (v||'').toString().trim(); }
      if (e.tag === 0x0131) result.software = (v||'').toString().trim();
      if (e.tag === 0x8769) exifIfdOff = v;
      if (e.tag === 0x8825) gpsIfdOff = v;
    }
    if (exifIfdOff != null) {
      const n2 = u16(exifIfdOff);
      for (let i=0; i<n2; i++) {
        const e = readEntry(exifIfdOff + 2 + i*12);
        const v = readValue(e);
        result._raw['exif_'+e.tag.toString(16)] = v;
        if (e.tag === 0x9003) result.aufnahmeZeit = formatExifDate(v);
        if (e.tag === 0x9004) result.digitalisiertAm = formatExifDate(v);
        if (e.tag === 0xA002) { result.abmessungen = result.abmessungen||{}; result.abmessungen.breitePixel = v; }
        if (e.tag === 0xA003) { result.abmessungen = result.abmessungen||{}; result.abmessungen.hoehePixel = v; }
      }
    }
    if (gpsIfdOff != null) {
      const n3 = u16(gpsIfdOff);
      const g = { _raw:{} };
      for (let i=0; i<n3; i++) {
        const e = readEntry(gpsIfdOff + 2 + i*12);
        const v = readValue(e);
        g._raw[e.tag.toString(16)] = v;
        if (e.tag === 0x0001) g.latRef = (v||'').toString().replace(/\0/g,'').trim();
        if (e.tag === 0x0002) g.lat = dms2dec(v);
        if (e.tag === 0x0003) g.lonRef = (v||'').toString().replace(/\0/g,'').trim();
        if (e.tag === 0x0004) g.lon = dms2dec(v);
        if (e.tag === 0x0005) g.altRef = (Array.isArray(v)?v[0]:v) === 0 ? 'über NN' : 'unter NN';
        if (e.tag === 0x0006) g.alt = ratio2num(v);
      }
      if (g.lat != null && g.lon != null) {
        result.gps = {
          latitude:  g.latRef === 'S' ? -g.lat : g.lat,
          longitude: g.lonRef === 'W' ? -g.lon : g.lon,
          hoehe_m:   g.alt != null ? g.alt : null,
          quelle:    'EXIF GPS-IFD'
        };
      }
    }
    return result;
  }

  function dms2dec(v) {
    if (!Array.isArray(v) || v.length < 3) return null;
    const deg = ratio2num(v[0]) || 0;
    const min = ratio2num(v[1]) || 0;
    const sec = ratio2num(v[2]) || 0;
    return deg + min/60 + sec/3600;
  }
  function ratio2num(r) {
    if (Array.isArray(r) && r.length === 2 && r[1] !== 0) return r[0]/r[1];
    if (typeof r === 'number') return r;
    return null;
  }
  function formatExifDate(s) {
    if (!s || typeof s !== 'string') return null;
    // "2026:06:06 14:30:25"
    const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m) return s;
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }

  // ── JPEG-Quantisierungs-Tabellen für ELA-Analyse ────────────────
  async function readJpegQuantTables(blob){
    const buf = await blob.arrayBuffer();
    const dv = new DataView(buf);
    if (dv.getUint16(0) !== 0xFFD8) return null;
    const tables = [];
    let o = 2;
    while (o < dv.byteLength - 1) {
      if (dv.getUint8(o) !== 0xFF) break;
      const marker = dv.getUint8(o+1);
      if (marker === 0xDB) { // DQT
        const size = dv.getUint16(o+2);
        const pq = dv.getUint8(o+4) >> 4;
        const tq = dv.getUint8(o+4) & 0x0F;
        const precision = pq === 0 ? 8 : 16;
        const vals = [];
        for (let i = 0; i < 64; i++) {
          if (precision === 8) vals.push(dv.getUint8(o+5+i));
          else vals.push(dv.getUint16(o+5+i*2));
        }
        tables.push({ id: tq, precision: precision, dc_acQuant: vals });
        o += 2 + size;
      } else if (marker === 0xDA) break;
      else {
        const size = dv.getUint16(o+2);
        o += 2 + size;
      }
    }
    return tables;
  }

  // ── Forensische Voll-Analyse ────────────────────────────────────
  async function analyse(blob) {
    const [hash, exif, dqt] = await Promise.all([
      sha256(blob),
      readExif(blob).catch(()=>null),
      readJpegQuantTables(blob).catch(()=>null)
    ]);

    const stand = new Date().toISOString();
    const quittung = {
      apollon_version: '1.7.0-SHOCK',
      ts_quittung: stand,
      dateiname: blob.name || '(unbenannt)',
      mime: blob.type,
      groesse_byte: blob.size,
      sha256: hash,
      exif: exif,
      jpeg_dqt: dqt ? {
        anzahl_tabellen: dqt.length,
        praezision: dqt[0] ? dqt[0].precision : null,
        signatur: dqt ? dqt.map(t => t.dc_acQuant.slice(0,8).join(',')).join('|') : null
      } : null,
      hinweise: []
    };

    // Plausibilitätshinweise
    if (exif && exif.aufnahmeZeit) {
      const aufnahme = new Date(exif.aufnahmeZeit);
      const jetzt = new Date();
      const tageDiff = (jetzt - aufnahme) / (24*3600*1000);
      if (tageDiff < -1) quittung.hinweise.push('Aufnahmedatum liegt in der Zukunft — Kamera-Uhr falsch?');
      if (tageDiff > 730) quittung.hinweise.push('Foto > 2 Jahre alt — Aktualität prüfen.');
    }
    if (!exif) {
      quittung.hinweise.push('Keine EXIF-Daten — möglicherweise nachbearbeitet (Screenshot, Re-Encoder oder Strippen).');
    }
    if (exif && exif.software) {
      const sw = exif.software.toLowerCase();
      if (sw.includes('photoshop') || sw.includes('gimp') || sw.includes('lightroom')) {
        quittung.hinweise.push('Bearbeitungs-Software in EXIF: '+exif.software+' — Bearbeitungs-Hinweis dokumentieren.');
      }
    }
    if (exif && exif.gps) {
      quittung.hinweise.push('GPS-Position verfügbar: '+exif.gps.latitude.toFixed(6)+', '+exif.gps.longitude.toFixed(6));
    }

    return quittung;
  }

  // ── Stapel-Quittung über mehrere Bilder ────────────────────────
  async function batchAnalyse(blobs, onProgress) {
    const results = [];
    for (let i=0; i<blobs.length; i++) {
      results.push(await analyse(blobs[i]));
      if (onProgress) onProgress(i+1, blobs.length);
    }
    // Gesamthash über alle Hashes — Akten-Bündel-Hash
    const sammelHash = await sha256(new Blob([results.map(r=>r.sha256).join('\n')], {type:'text/plain'}));
    return {
      apollon_version: '1.7.0-SHOCK',
      ts: new Date().toISOString(),
      anzahl_bilder: blobs.length,
      sammel_sha256: sammelHash,
      einzel_quittungen: results
    };
  }

  // ── Karte für GPS-Bilder (für UI-Anzeige) ──────────────────────
  function gpsMapUrl(lat, lon, zoom){
    return 'https://www.openstreetmap.org/?mlat='+lat+'&mlon='+lon+'#map='+(zoom||18)+'/'+lat+'/'+lon;
  }

  g.GSKR_APOLLON = {
    sha256: sha256,
    readExif: readExif,
    readJpegQuantTables: readJpegQuantTables,
    analyse: analyse,
    batchAnalyse: batchAnalyse,
    gpsMapUrl: gpsMapUrl
  };

})(typeof window !== 'undefined' ? window : globalThis);

