# Goldschlüssel SKR — App-Suite

Web-Auslieferung der Goldschlüssel-Anwendungen des Bausachverständigenbüros
Stefan Klaus Ritter.

## Was hier liegt

| Anwendung | Zweck |
|---|---|
| **App 1 · Käufer** | Hauskaufberatung — Bewertung und Einordnung eines Kaufobjekts |
| **App 2 · SV** | Werkzeug für Sachverständige |

Beide Anwendungen werden über `index.html` (App-Portal) gestartet.

## Verschlüsselung

Die Anwendungskerne liegen **ausschließlich verschlüsselt** in diesem Repository
(`*.enc`):

* AES-GCM, 256 Bit
* Schlüsselableitung PBKDF2-HMAC-SHA256, 310.000 Iterationen
* Containerformat `GSKR1` + Salt + IV + Ciphertext

Die Entschlüsselung erfolgt **vollständig im Browser** (WebCrypto), nach Eingabe
des Master-Passworts. Ohne Passwort ist der Inhalt der `.enc`-Dateien nicht
lesbar. Es gibt keinen Server, der das Passwort kennt oder prüft.

## Architektur

* **Kein Backend, keine Cloud-Datenbank, kein Tracking.**
  Anwendungsdaten verbleiben lokal im Browser (IndexedDB / localStorage).
* Die `gskr-*.js`-Module (Kryptografie, Anonymisierung, Bildforensik,
  WebDAV-Adapter, Zugangsschutz) werden von den Anwendungen zur Laufzeit
  nachgeladen. Sie enthalten **keine** Zugangsdaten, Schlüssel oder Hostnamen —
  alle Verbindungsparameter werden erst zur Laufzeit gesetzt.
* `lizenzen.json` enthält ausschließlich **SHA-256-Hashes** der Lizenz-Codes
  sowie deren Laufzeit- und Sperrstatus. Keine Klarnamen.

## Was hier bewusst NICHT liegt

* **App 3 (Pro)** — das interne Sachverständigen-Werkzeug. Es wird ausschließlich
  lokal im Büro betrieben und ist **kein** Bestandteil dieser Auslieferung.
* Mandanten-, Akten- oder Objektdaten jeglicher Art.
* Zugangsdaten, API-Schlüssel, Serveradressen.

## Datenschutz

Es werden keine personenbezogenen Daten an dieses Repository oder an Dritte
übertragen. Die Anwendungen laufen im Browser des Nutzers.

---

© Bausachverständigenbüro Stefan Klaus Ritter. Alle Rechte vorbehalten.
Die Nutzung setzt eine gültige Lizenz voraus.
