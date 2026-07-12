/* ==========================================================================
 * gskr-crypto.js — Krypto-Kern (GSKR_CRYPTO)
 * --------------------------------------------------------------------------
 * HERKUNFT : 1:1 extrahiert aus der internen Referenz-Fassung,
 *            Extraktion am 12.07.2026. Logik unveraendert (byte-gleich).
 * ZWECK    : AES-GCM Ver-/Entschluesselung, PBKDF2-Schluesselableitung, Datei-Krypto, Passwortgenerator, Fingerprint, Passkey/WebAuthn.
 * API      : GSKR_CRYPTO: ableiteSchluessel, verschluesseln, entschluesseln, verschluesselnJSON, entschluesselnJSON, verschluesseleDatei, entschluesseleDatei, generierePasswort, fingerprint, passkeyAnmelden, passkeyRegistrieren
 * ABHAENGIG: KEINE GSKR-Module. Browser: crypto.subtle, PublicKeyCredential (optional).
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
 * GSKR Crypto — Zero-Knowledge Client-Side Verschlüsselung
 * v1.7.0-SHOCK · 06.06.2026
 *
 * Architektur:
 *  - AES-GCM-256 für symmetrische Verschlüsselung
 *  - PBKDF2 (310.000 Iterationen, SHA-256) für Passwort-Ableitung
 *  - Schlüssel werden NIE auf den Server geladen
 *  - Mandanten-Daten verlassen das Gerät nur verschlüsselt
 *  - Per-File Salt + IV
 *
 * USP gegen Konkurrenz:
 *  - Brikks, Hausgeist, ImmoSmart: Server-side Encryption („at rest")
 *    → Provider hält die Schlüssel, kann theoretisch lesen.
 *  - Goldschlüssel SKR: Client-side Encryption („Zero Knowledge")
 *    → Selbst wenn Nextcloud kompromittiert wird, sind die Mandantendaten unlesbar.
 */
(function(g){
  'use strict';

  const PBKDF2_ITER = 310000;
  const SALT_LEN = 16;
  const IV_LEN = 12;
  const KEY_LEN = 256;

  // ── Master-Schlüssel aus Passwort ableiten ──────────────────────
  async function ableiteSchluessel(passwort, salt) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw', enc.encode(passwort),
      'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: KEY_LEN },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ── Verschlüsseln: nimmt String oder Blob, gibt verschlüsseltes Blob ──
  async function verschluesseln(klartext, passwort) {
    const enc = new TextEncoder();
    const klartextBytes = typeof klartext === 'string'
      ? enc.encode(klartext)
      : new Uint8Array(await (klartext.arrayBuffer ? klartext.arrayBuffer() : klartext));

    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv   = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key  = await ableiteSchluessel(passwort, salt);

    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      klartextBytes
    );

    // Format: [Magic 4B][Salt 16B][IV 12B][Cipher...]
    // Magic = "GSKR" um Format zu erkennen
    const magic = new Uint8Array([0x47, 0x53, 0x4B, 0x52]); // "GSKR"
    const out = new Uint8Array(magic.length + salt.length + iv.length + cipher.byteLength);
    out.set(magic, 0);
    out.set(salt, magic.length);
    out.set(iv, magic.length + salt.length);
    out.set(new Uint8Array(cipher), magic.length + salt.length + iv.length);

    return new Blob([out], { type: 'application/octet-stream+gskr-enc' });
  }

  // ── Entschlüsseln: Blob → Klartext-String ──
  async function entschluesseln(verschluesseltesBlob, passwort) {
    const buf = new Uint8Array(await verschluesseltesBlob.arrayBuffer());
    if (buf.length < 4 + SALT_LEN + IV_LEN + 16) {
      throw new Error('Zu kurz für GSKR-verschlüsselten Inhalt');
    }
    // Magic prüfen
    if (buf[0] !== 0x47 || buf[1] !== 0x53 || buf[2] !== 0x4B || buf[3] !== 0x52) {
      throw new Error('Kein GSKR-verschlüsseltes Format (Magic-Bytes fehlen)');
    }
    const salt = buf.slice(4, 4 + SALT_LEN);
    const iv   = buf.slice(4 + SALT_LEN, 4 + SALT_LEN + IV_LEN);
    const cipher = buf.slice(4 + SALT_LEN + IV_LEN);
    const key = await ableiteSchluessel(passwort, salt);

    try {
      const klar = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        cipher
      );
      const dec = new TextDecoder();
      return dec.decode(klar);
    } catch (e) {
      throw new Error('Entschlüsselung fehlgeschlagen — Passwort falsch oder Daten manipuliert');
    }
  }

  // ── Bequemlichkeits-Wrapper für JSON-Akten ─────────────────────
  async function verschluesselnJSON(obj, passwort) {
    return verschluesseln(JSON.stringify(obj), passwort);
  }
  async function entschluesselnJSON(blob, passwort) {
    const text = await entschluesseln(blob, passwort);
    return JSON.parse(text);
  }

  // ── Datei-Verschlüsselung (z. B. PDFs vor Upload) ──────────────
  async function verschluesseleDatei(file, passwort) {
    const verschluesselt = await verschluesseln(file, passwort);
    return new File([verschluesselt], file.name + '.gskr-enc',
      { type: 'application/octet-stream+gskr-enc' });
  }
  async function entschluesseleDatei(verschluesselteDatei, passwort) {
    const buf = new Uint8Array(await verschluesselteDatei.arrayBuffer());
    if (buf[0] !== 0x47 || buf[1] !== 0x53 || buf[2] !== 0x4B || buf[3] !== 0x52) {
      throw new Error('Kein GSKR-verschlüsseltes Format');
    }
    const salt = buf.slice(4, 4 + SALT_LEN);
    const iv   = buf.slice(4 + SALT_LEN, 4 + SALT_LEN + IV_LEN);
    const cipher = buf.slice(4 + SALT_LEN + IV_LEN);
    const key = await ableiteSchluessel(passwort, salt);
    const klar = await crypto.subtle.decrypt({ name:'AES-GCM', iv: iv }, key, cipher);
    const originalName = verschluesselteDatei.name.replace(/\.gskr-enc$/, '');
    return new File([klar], originalName, { type: 'application/octet-stream' });
  }

  // ── Zufalls-Passwort generieren (für Mandanten-Schlüssel) ──────
  function generierePasswort(laenge) {
    laenge = laenge || 24;
    const arr = new Uint8Array(laenge);
    crypto.getRandomValues(arr);
    // Base64URL ohne Padding
    return btoa(String.fromCharCode.apply(null, arr))
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
      .substring(0, laenge);
  }

  // ── Schlüssel-Fingerprint (für UI-Anzeige „Zertifikat-Pinning") ─
  async function fingerprint(passwort) {
    const enc = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(passwort));
    return [...new Uint8Array(hash)].slice(0,8)
      .map(b => b.toString(16).padStart(2,'0'))
      .join(':').toUpperCase();
  }

  // ── WebAuthn / Passkey-Login (für SV — Hardware-Key statt Passwort) ─
  async function passkeyAnmelden(challenge) {
    if (!window.PublicKeyCredential) throw new Error('Browser unterstützt WebAuthn nicht');
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: challenge instanceof Uint8Array ? challenge : new TextEncoder().encode(String(challenge)),
        timeout: 60000,
        userVerification: 'preferred'
      }
    });
    return cred;
  }
  async function passkeyRegistrieren(userId, userName, challenge) {
    if (!window.PublicKeyCredential) throw new Error('Browser unterstützt WebAuthn nicht');
    return navigator.credentials.create({
      publicKey: {
        challenge: challenge instanceof Uint8Array ? challenge : new TextEncoder().encode(String(challenge)),
        rp: { name: 'Goldschlüssel SKR' },
        user: {
          id: new TextEncoder().encode(String(userId)),
          name: userName,
          displayName: userName
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7  }, // ES256
          { type: 'public-key', alg: -257 } // RS256
        ],
        authenticatorSelection: { userVerification: 'preferred' },
        timeout: 60000,
        attestation: 'none'
      }
    });
  }

  g.GSKR_CRYPTO = {
    ableiteSchluessel: ableiteSchluessel,
    verschluesseln: verschluesseln,
    entschluesseln: entschluesseln,
    verschluesselnJSON: verschluesselnJSON,
    entschluesselnJSON: entschluesselnJSON,
    verschluesseleDatei: verschluesseleDatei,
    entschluesseleDatei: entschluesseleDatei,
    generierePasswort: generierePasswort,
    fingerprint: fingerprint,
    passkeyAnmelden: passkeyAnmelden,
    passkeyRegistrieren: passkeyRegistrieren,
    PBKDF2_ITER: PBKDF2_ITER
  };

})(typeof window !== 'undefined' ? window : globalThis);

