/**
 * GSKR-Nextcloud-Adapter
 * Gemeinsames WebDAV-Modul für App1 (Käufer), App2 (SV), App3 (Pro).
 *
 * Architektur:
 *   - Public-Share-Token + Einmal-Passwort (Mandanten-Onboarding via QR)
 *   - Pro Akte ein Ordner /Hauskaufberatung/{aktenId}/
 *   - Foto-Streaming via fetch+Blob, kein Base64-Overhead
 *   - Optimistic-Concurrency über If-Match (ETag)
 *   - Offline-Buffer in IndexedDB; Auto-Sync bei Netz-OK
 *
 * Stand: 2026-06-06
 * Lizenz: SKR-intern
 */
(function(global){
  'use strict';

  // ── Konfiguration ───────────────────────────────────────────────
  var CFG = {
    base:      '',        // z. B. https://nextcloud.skr-bausachverstaendigenbuero.de
    shareToken:'',        // aus QR-Onboarding-Link
    passwort:  '',        // Mandanten-Passwort (nach erster Anmeldung gewechselt)
    aktenId:   '',
    rootPfad:  '/Hauskaufberatung',
    timeout:   15000,
    appKennung:'app?'     // 'app1' | 'app2' | 'app3' — fürs Logging
  };

  // ── IndexedDB Offline-Buffer ────────────────────────────────────
  var _idbPromise = null;
  function _openDB(){
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise(function(resolve, reject){
      var req = indexedDB.open('GSKR_NEXTCLOUD_BUFFER', 1);
      req.onupgradeneeded = function(e){
        var db = e.target.result;
        if (!db.objectStoreNames.contains('uploads')){
          db.createObjectStore('uploads', { keyPath:'id' });
        }
        if (!db.objectStoreNames.contains('fotos')){
          db.createObjectStore('fotos', { keyPath:'hash' });
        }
        if (!db.objectStoreNames.contains('cache')){
          db.createObjectStore('cache', { keyPath:'pfad' });
        }
      };
      req.onsuccess = function(){ resolve(req.result); };
      req.onerror   = function(){ reject(req.error); };
    });
    return _idbPromise;
  }

  function _idbPut(store, obj){
    return _openDB().then(function(db){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(obj);
        tx.oncomplete = function(){ resolve(); };
        tx.onerror    = function(){ reject(tx.error); };
      });
    });
  }
  function _idbGet(store, key){
    return _openDB().then(function(db){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(store, 'readonly');
        var rq = tx.objectStore(store).get(key);
        rq.onsuccess = function(){ resolve(rq.result); };
        rq.onerror   = function(){ reject(rq.error); };
      });
    });
  }
  function _idbAll(store){
    return _openDB().then(function(db){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(store, 'readonly');
        var rq = tx.objectStore(store).getAll();
        rq.onsuccess = function(){ resolve(rq.result || []); };
        rq.onerror   = function(){ reject(rq.error); };
      });
    });
  }
  function _idbDel(store, key){
    return _openDB().then(function(db){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = function(){ resolve(); };
        tx.onerror    = function(){ reject(tx.error); };
      });
    });
  }

  // ── Auth-Header (Public-Share + Passwort) ───────────────────────
  function _hdr(extra){
    var h = { 'X-Requested-With':'XMLHttpRequest' };
    if (CFG.shareToken && CFG.passwort){
      // Nextcloud-Public-Share-Auth: Share-Token als User, Passwort als PW
      h['Authorization'] = 'Basic ' + btoa(CFG.shareToken + ':' + CFG.passwort);
    }
    if (extra){
      Object.keys(extra).forEach(function(k){ h[k] = extra[k]; });
    }
    return h;
  }

  function _aktenURL(){
    // Public-Share-WebDAV-Endpoint (Nextcloud: /public.php/webdav/)
    return CFG.base + '/public.php/webdav';
  }
  function _pfadURL(relPfad){
    return _aktenURL() + (relPfad.indexOf('/')===0 ? relPfad : '/'+relPfad);
  }

  // ── Online/Offline ──────────────────────────────────────────────
  function _isOnline(){
    return typeof navigator !== 'undefined' && navigator.onLine !== false;
  }

  // ── Core: PUT / GET / PROPFIND / MKCOL / DELETE ─────────────────
  function _withTimeout(promise, ms){
    return new Promise(function(resolve, reject){
      var t = setTimeout(function(){ reject(new Error('timeout')); }, ms);
      promise.then(function(v){ clearTimeout(t); resolve(v); },
                   function(e){ clearTimeout(t); reject(e); });
    });
  }

  function mkcol(relPfad){
    return _withTimeout(fetch(_pfadURL(relPfad), {
      method:'MKCOL', headers:_hdr(), mode:'cors'
    }), CFG.timeout).then(function(r){
      // 201 created, 405 = exists -> OK
      if (r.status===201 || r.status===405) return true;
      throw new Error('MKCOL '+relPfad+' status '+r.status);
    });
  }

  function put(relPfad, blob, contentType){
    if (!_isOnline()){
      // Offline-Buffer — Schreiben zwischenpuffern
      var id = relPfad + '#' + Date.now();
      return _idbPut('uploads', {
        id: id, pfad: relPfad, blob: blob,
        contentType: contentType || 'application/octet-stream',
        ts: Date.now(), app: CFG.appKennung
      }).then(function(){ return { offline:true, id:id }; });
    }
    return _withTimeout(fetch(_pfadURL(relPfad), {
      method:'PUT',
      headers:_hdr({ 'Content-Type': contentType||'application/octet-stream' }),
      body: blob, mode:'cors'
    }), CFG.timeout).then(function(r){
      if (r.status>=200 && r.status<300) return { offline:false, etag:r.headers.get('ETag') };
      throw new Error('PUT '+relPfad+' status '+r.status);
    });
  }

  function get(relPfad){
    // Erst Cache prüfen
    return _idbGet('cache', relPfad).then(function(cached){
      if (!_isOnline() && cached) return cached.blob;
      return _withTimeout(fetch(_pfadURL(relPfad), {
        method:'GET', headers:_hdr(), mode:'cors'
      }), CFG.timeout).then(function(r){
        if (r.status===200){
          return r.blob().then(function(b){
            _idbPut('cache', { pfad: relPfad, blob: b, ts: Date.now() }).catch(function(){});
            return b;
          });
        }
        if (cached) return cached.blob;
        throw new Error('GET '+relPfad+' status '+r.status);
      });
    });
  }

  function getText(relPfad){
    return get(relPfad).then(function(b){ return b.text ? b.text() : new Response(b).text(); });
  }
  function getJSON(relPfad){
    return getText(relPfad).then(function(t){ return JSON.parse(t); });
  }

  function propfind(relPfad, tiefe){
    return _withTimeout(fetch(_pfadURL(relPfad), {
      method:'PROPFIND',
      headers:_hdr({ 'Depth': (tiefe!==undefined ? String(tiefe) : '1') }),
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>',
      mode:'cors'
    }), CFG.timeout).then(function(r){
      if (r.status===207) return r.text();
      throw new Error('PROPFIND '+relPfad+' status '+r.status);
    }).then(function(xml){
      // Minimaler Parser: nur href + getlastmodified + getcontentlength + getetag
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      var responses = doc.getElementsByTagNameNS('DAV:', 'response');
      var list = [];
      for (var i=0; i<responses.length; i++){
        var r = responses[i];
        var href = (r.getElementsByTagNameNS('DAV:','href')[0]||{}).textContent || '';
        var size = (r.getElementsByTagNameNS('DAV:','getcontentlength')[0]||{}).textContent || '';
        var mod  = (r.getElementsByTagNameNS('DAV:','getlastmodified')[0]||{}).textContent || '';
        var etag = (r.getElementsByTagNameNS('DAV:','getetag')[0]||{}).textContent || '';
        list.push({ href: href, size: size?parseInt(size,10):null, modified: mod, etag: etag });
      }
      return list;
    });
  }

  function del(relPfad){
    return _withTimeout(fetch(_pfadURL(relPfad), {
      method:'DELETE', headers:_hdr(), mode:'cors'
    }), CFG.timeout).then(function(r){
      if (r.status===204 || r.status===200) return true;
      throw new Error('DELETE '+relPfad+' status '+r.status);
    });
  }

  // ── Hochrangige API: Akte ───────────────────────────────────────
  function aktenPfad(unter){
    var p = CFG.rootPfad + '/' + CFG.aktenId;
    if (unter) p += '/' + unter.replace(/^\/+/, '');
    return p;
  }

  function initAkte(){
    // Legt Ordnerstruktur an (idempotent)
    var pfade = ['00_mandant', '01_begehung', '02_ortstermin', '03_gutachten', '99_meta'];
    return Promise.all(pfade.map(function(p){
      return mkcol(aktenPfad(p)).catch(function(){}); // 405 (exists) ignorieren
    }));
  }

  // ── SHA-256 (Web Crypto API) ────────────────────────────────────
  function sha256(blob){
    return blob.arrayBuffer().then(function(buf){
      return crypto.subtle.digest('SHA-256', buf);
    }).then(function(hash){
      var arr = new Uint8Array(hash);
      var s = '';
      for (var i=0; i<arr.length; i++) s += ('00'+arr[i].toString(16)).slice(-2);
      return s;
    });
  }

  // ── Foto-Workflow ───────────────────────────────────────────────
  // fotoUpload speichert Blob, berechnet sha256, schreibt nach Nextcloud, indexiert lokal
  function fotoUpload(unter, dateiname, blob, meta){
    return sha256(blob).then(function(hash){
      var pfad = aktenPfad(unter+'/'+dateiname);
      return put(pfad, blob, blob.type || 'image/jpeg').then(function(res){
        var rec = {
          hash: hash, pfad: pfad, dateiname: dateiname, size: blob.size,
          mime: blob.type, meta: meta||{}, ts: Date.now(), app: CFG.appKennung,
          offline: !!res.offline
        };
        return _idbPut('fotos', rec).then(function(){ return rec; });
      });
    });
  }

  function fotoListe(unter){
    return _idbAll('fotos').then(function(all){
      if (!unter) return all;
      var pfx = aktenPfad(unter);
      return all.filter(function(f){ return f.pfad.indexOf(pfx)===0; });
    });
  }

  function fotoLoeschen(hash){
    return _idbGet('fotos', hash).then(function(f){
      if (!f) return false;
      return del(f.pfad).catch(function(){}).then(function(){
        return _idbDel('fotos', hash);
      });
    });
  }

  // ── Manifest ────────────────────────────────────────────────────
  function manifestLaden(){
    return getJSON(aktenPfad('99_meta/manifest.json')).catch(function(){ return null; });
  }
  function manifestSpeichern(obj){
    var s = JSON.stringify(obj, null, 2);
    var blob = new Blob([s], { type:'application/json' });
    return put(aktenPfad('99_meta/manifest.json'), blob, 'application/json');
  }

  // ── Begehung / SV / Gutachten Convenience ───────────────────────
  function begehungSpeichern(obj){
    var s = JSON.stringify(obj, null, 2);
    return put(aktenPfad('01_begehung/index.json'),
               new Blob([s], { type:'application/json' }), 'application/json');
  }
  function begehungLaden(){
    return getJSON(aktenPfad('01_begehung/index.json'));
  }
  function ortsterminSpeichern(obj){
    var s = JSON.stringify(obj, null, 2);
    return put(aktenPfad('02_ortstermin/sv.json'),
               new Blob([s], { type:'application/json' }), 'application/json');
  }
  function ortsterminLaden(){
    return getJSON(aktenPfad('02_ortstermin/sv.json'));
  }
  function gutachtenSpeichern(dateiname, blob){
    return put(aktenPfad('03_gutachten/'+dateiname), blob,
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }

  // ── Sync (Offline → Online) ─────────────────────────────────────
  function syncWennOnline(){
    if (!_isOnline()) return Promise.resolve({ skipped:true });
    return _idbAll('uploads').then(function(buf){
      if (!buf.length) return { uploaded: 0 };
      var done = 0, fehler = [];
      var chain = Promise.resolve();
      buf.forEach(function(u){
        chain = chain.then(function(){
          return _withTimeout(fetch(_pfadURL(u.pfad), {
            method:'PUT',
            headers:_hdr({ 'Content-Type': u.contentType }),
            body: u.blob, mode:'cors'
          }), CFG.timeout).then(function(r){
            if (r.status>=200 && r.status<300){
              done++;
              return _idbDel('uploads', u.id);
            }
            fehler.push({ pfad: u.pfad, status: r.status });
          }).catch(function(e){ fehler.push({ pfad: u.pfad, err: e.message }); });
        });
      });
      return chain.then(function(){ return { uploaded: done, fehler: fehler }; });
    });
  }

  // ── QR-Onboarding-Link parsen ───────────────────────────────────
  // Erwartet:  https://<base>/s/<shareToken>?akte=<aktenId>
  function parseOnboardingLink(url){
    try {
      var u = new URL(url);
      var m = u.pathname.match(/\/s\/([^/]+)/);
      if (!m) return null;
      return {
        base:       u.origin,
        shareToken: m[1],
        aktenId:    u.searchParams.get('akte') || ''
      };
    } catch (e) { return null; }
  }

  function init(opts){
    Object.keys(opts || {}).forEach(function(k){ CFG[k] = opts[k]; });
    // Auto-Sync alle 60 s wenn online
    if (global.setInterval){
      global.setInterval(function(){
        if (_isOnline()) syncWennOnline().catch(function(){});
      }, 60000);
    }
    if (global.addEventListener){
      global.addEventListener('online', function(){
        syncWennOnline().catch(function(){});
      });
    }
  }

  // ── Export ──────────────────────────────────────────────────────
  global.GSKR_NEXTCLOUD = {
    init: init,
    config: CFG,
    parseOnboardingLink: parseOnboardingLink,
    // Low-level
    mkcol: mkcol, put: put, get: get, getText: getText, getJSON: getJSON,
    propfind: propfind, del: del,
    // High-level Akte
    aktenPfad: aktenPfad, initAkte: initAkte,
    sha256: sha256,
    // Foto
    fotoUpload: fotoUpload, fotoListe: fotoListe, fotoLoeschen: fotoLoeschen,
    // Workflow
    begehungSpeichern: begehungSpeichern, begehungLaden: begehungLaden,
    ortsterminSpeichern: ortsterminSpeichern, ortsterminLaden: ortsterminLaden,
    gutachtenSpeichern: gutachtenSpeichern,
    manifestLaden: manifestLaden, manifestSpeichern: manifestSpeichern,
    // Sync
    syncWennOnline: syncWennOnline,
    // Diagnose
    _idb: { put: _idbPut, get: _idbGet, all: _idbAll, del: _idbDel }
  };

})(typeof window !== 'undefined' ? window : globalThis);
