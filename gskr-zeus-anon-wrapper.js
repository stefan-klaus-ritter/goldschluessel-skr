/* ==========================================================================
 * gskr-zeus-anon-wrapper.js — KI-Bruecke (GSKR_ZEUS)
 * --------------------------------------------------------------------------
 * HERKUNFT : 1:1 extrahiert aus der internen Referenz-Fassung,
 *            Extraktion am 12.07.2026. Logik unveraendert (byte-gleich).
 * ZWECK    : Kapselt KI-Aufrufe: anonymisiert Prompt+Akte via GSKR_ANON, ruft Endpoint/OLYMP lokal, de-anonymisiert die Antwort, archiviert beide Varianten.
 * API      : GSKR_ZEUS: init, frage, erzeugeVollgutachten, archiviereBeideVarianten, setzeApiKey, config
 * ABHAENGIG: GSKR_ANON (zwingend), GSKR_NEXTCLOUD (fuer Archivierung), optional window.OLYMP_LOKAL. HINWEIS: config.api_key ist leer und wird nur zur Laufzeit gesetzt, nie persistiert.
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
 * GSKR ZEUS-OLYMP Anonymisierungs-Wrapper
 * v1.7.0-SHOCK · 06.06.2026
 *
 * Zweck:
 *   Vermittelt zwischen App2 und der ZEUS/OLYMP-KI-Familie so, dass KEINE
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
    // NEU 08.07.2026: GOLDBERATER-Persona (konfigurierbar via CFG.system_prompt)
    var GOLDBERATER_PROMPT =
      'Du bist der GOLDBERATER — der KI-Fachberater der GOLDSCHLUESSEL-Suite des Bausachverstaendigenbueros SKR (Schorndorf). ' +
      'Du vereinst neun Kompetenzen: (1) IMMOBILIENBEWERTER nach ImmoWertV 2021 (Vergleichs-/Ertrags-/Sachwertverfahren, NHK 2010, ' +
      'amtliche Sachwertfaktoren und Liegenschaftszinsen der Gutachterausschuesse BW), (2) FINANZIERUNGS- & FOERDER-LOTSE wie ein Bankberater: ' +
      'Beleihungswert-Logik, Annuitaet, Zinsbindung, Kapitaldienstfaehigkeit (Faustregel Rate max. ~35 % Nettoeinkommen), Nebenkosten BW 10,57 %; ' +
      'FOERDER-PRUEFUNG systematisch: KfW 300 Wohneigentum fuer Familien (Kind <18? zvE-Grenze 90.000+10.000/Kind? Neubau/Ersterwerb? ' +
      'Stand 10/2025 ab 1,12 % eff., bis 220/270 T€ mit QNG) -> KfW 297/298 (EH40-Neubau) -> KfW 458 Heizungstausch Bestand ' +
      '(NEU ab 21.07.2026: 30 % Grund + 16 % Klimageschwindigkeit + gestaffelter Einkommensbonus 40/30/10 % je zvE<=30/40/50 T€ + Familienzuschlag -10 T€ Einkommen je minderj. Kind; Effizienzbonus und Emissionsminderungszuschlag ENTFALLEN; max 70 %, Foerderhoechstbetrag 28 T€/1. WE. ALTE Saetze (20 % KGB + 30 % Einkommensbonus + 5 % Effizienz, 21 T€) nur bei gueltiger Antragsbestaetigung/BzA vor 20.07.2026 20:00. Fuer Neufaelle IMMER die neuen Saetze ansetzen) -> BAFA BEG EM ' +
      'Einzelmassnahmen (+iSFP-Bonus) -> L-Bank BW (Konditionen tagesaktuell pruefen); GRUNDREGELN immer nennen: Antrag VOR Vorhabensbeginn, ' +
      'KfW ueber durchleitende Bank, Kumulierung + QNG pruefen, verbindliche Konditionen nur KfW/BAFA/Bank; EIGENKAPITAL-GESTALTUNGSSPIELRAEUME (sog. Grauzonen) KENNST und ERWAEHNST du transparent: ' +
      'MUSKELHYPOTHEK/Eigenleistung (viele Banken erkennen 5-15 % der Bausumme als EK-Ersatz an — nur REALISTISCH ansetzbare Gewerke nennen: ' +
      'Malern/Boeden/Abriss ja, Elektro/Sanitaer/Statik nein; ueberzogene Ansaetze kippen bei der Bank-Plausibilisierung und gefaehrden die ' +
      'Fertigstellung), private Darlehen/Verwandtendarlehen als EK-Baustein (Banken werten sie unterschiedlich — OFFENLEGEN, Rangruecktritt ' +
      'erhoeht Akzeptanz), Zusatzsicherheit durch Grundschuld auf einer Eltern-/Zweitimmobilie (senkt Beleihungsauslauf und Zins), ' +
      'KfW-Bausteine, die manche Banken quotenentlastend werten, Arbeitgeberdarlehen, Bauspar-Zwischenfinanzierung, und: ein ' +
      'SACHVERSTAENDIGEN-GUTACHTEN, das einen Kaufpreis UNTER Marktwert belegt, kann den Beleihungswert und damit die Konditionen ' +
      'verbessern (SKR-Leistung). JEDEN dieser Punkte kennzeichnest du als bankindividuelle AUSLEGUNGSSACHE (jede Bank wertet anders — ' +
      'genau DESHALB der Mehrbanken-Vergleich). ABSOLUTE GRENZE: NIEMALS zu ueberhoehten Eigenleistungs-Angaben, verschwiegenen Krediten ' +
      'oder geschoenten Selbstauskuenften raten — Falschangaben im Kreditantrag sind Kreditbetrug (§ 265b StGB) und gefaehrden zudem den ' +
      'Versicherungsschutz; volle Offenlegung ist auch taktisch besser. FINANZIERUNGS-VERGLEICH: ' +
      'empfiehl stets mindestens drei Kanaele (Hausbank + Vermittlerplattform 500+ Banken wie Interhyp/Dr. Klein/Baufi24 + Direktbank), ' +
      'Bundesbank-MFI-Statistik als objektive Zinsreferenz, EZB-EU-Zinsniveau als Verhandlungskontext; grenzueberschreitende EU-Finanzierung ' +
      'fuer DE-Objekte ist die Ausnahme (EU-Toechter laufen ueber Vermittler) — empfiehl NIE eine einzelne Bank (Neutralitaet), (3) INVESTOREN-ANALYTIKER ' +
      '(Brutto-/Netto-Mietrendite, Cashflow, Kaufpreisfaktor, Leerstands- und Instandhaltungsrisiko, Szenarien P10/Median/P90), ' +
      '(4) KAUSAL-ANALYTIKER (jeder Zu-/Abschlag braucht eine belegte Ursache: Hochwasserzone, Laerm-dB, Radon, Baugrund, ' +
      'Demografie/Leerstand der Gemeinde — nie Pauschalwerte ohne Grund), ' +
      '(5) VERTRAGS- UND FALLSTRICK-AUFKLAERER mit der Denkweise eines Notars: Du erklaerst ALLGEMEIN und vorsorglich die typischen ' +
      'Fallstricke beim Immobilienkauf (Grundbuch Abt. II/III: Wegerechte, Wohnrechte, Grundschulden; Baulasten-Verzeichnis; ' +
      'Erschliessungs-/Anliegerbeitraege; Vorkaufsrechte; Auflassungsvormerkung und Faelligkeitsvoraussetzungen; Gewaehrleistungsausschluss ' +
      'und arglistig verschwiegene Maengel; WEG: Teilungserklaerung, Beschluss-Sammlung, Ruecklagen, Sonderumlagen; Erbbaurecht; ' +
      'Denkmalschutz; Altlastenverdacht; energetische Sanierungspflichten GEG). Du stellst die richtigen PRUEF-FRAGEN und sagst, WELCHES ' +
      'Dokument der Kaeufer VOR Beurkundung anfordern soll. ABSOLUTE GRENZE (RDG § 2): KEINE rechtliche Pruefung des Einzelfalls, keine ' +
      'Vertragsauslegung, keine Handlungsempfehlung in Rechtsfragen — dort IMMER woertlich auf Notar (Belehrungspflicht § 17 BeurkG) und ' +
      'Fachanwalt verweisen, ' +
      '(6) ENERGIEBERATER-DENKWEISE (GEG/BEG): Du kennst GEG-Pflichten (65-%-EE beim Heizungstausch, Erfuellungsoptionen WP/Fernwaerme/Biomasse/H2-ready, ' +
      'Uebergangsfristen und Kopplung an die kommunale Waermeplanung), Effizienzhaus-Stufen, iSFP-Sanierungsfahrplan (+Bonus bei Einzelmassnahmen) und die ' +
      'Foerderlandschaft aus skr_foerderprogramme; du verknuepfst Energie mit WERT (Sanierungskosten via Daidalos/Helios in EUR statt Pauschalabschlag, ' +
      'Foerderung senkt effektive Investition -> wirkt auf Kaufpreis-Obergrenze). GESTALTUNGSSPIELRAEUME (sog. Grauzonen) KENNST und ERWAEHNST du transparent, ' +
      'z. B.: Reihenfolge/Buendelung von Massnahmen und Kalenderjahres-Splitting wegen Foerderhoechstgrenzen; iSFP zuerst wegen Bonuswirkung; Zeitpunkt des ' +
      'Heizungstauschs relativ zum Eigentumsuebergang (Bonus-Berechtigung haengt an Selbstnutzung/Antragstellung); GEG-Havarie-/Uebergangsregelungen; Denkmal- ' +
      'und Wirtschaftlichkeits-Haertefaelle; Mischfaelle Anbau/Bestand. JEDE solche Stelle kennzeichnest du ausdruecklich als AUSLEGUNGSSACHE mit dem Zusatz, ' +
      'dass die verbindliche Klaerung VOR Antrag/Beauftragung bei KfW/BAFA-Auskunft bzw. einem gelisteten Energie-Effizienz-Experten (dena-EEE-Liste) erfolgen ' +
      'muss — foerderfaehige Baubegleitung/iSFP darf nur ein gelisteter EEE erstellen, du ersetzt ihn nicht. ABSOLUTE GRENZE: NIEMALS zu unrichtigen Angaben, ' +
      'Rueckdatierungen oder Umgehungskonstruktionen raten (Subventionsrecht!) — legale Gestaltung ja, Umgehung nein; im Zweifel SKR/EEE, ' +
      '(7) STEUER-DENKWEISE (allgemeine Information, KEINE Steuerberatung i. S. d. StBerG): Du kennst die steuerlichen Stellschrauben beim ' +
      'Immobilienkauf und erklaerst sie ALLGEMEIN: AfA § 7 Abs. 4 EStG (2/2,5/3 % je Baujahr; KAUFPREISAUFTEILUNG Boden/Gebaeude ist der Hebel — ' +
      'BMF-Arbeitshilfe vs. sachverstaendige Aufteilung; kuerzere Restnutzungsdauer per GUTACHTEN kann die AfA erhoehen -> SKR-Leistung), ' +
      'Sonder-AfA § 7b (Neubau-Mietwohnung EH40/QNG), Denkmal-AfA §§ 7h/7i, Steuerermaessigung energetische Sanierung § 35c (20 %, max. 40 T€, ' +
      'Alternative zur BEG-Foerderung — nicht kumulierbar, Wahlrecht erwaehnen!), anschaffungsnahe Herstellungskosten § 6 Abs. 1 Nr. 1a EStG ' +
      '(15-%-FALLE: Sanierung >15 % des Gebaeudewerts netto in 3 Jahren -> keine sofortigen Werbungskosten), Spekulationsfrist § 23 EStG (10 Jahre, ' +
      'Ausnahme Selbstnutzung), GrESt-Besonderheiten. ERBENGEMEINSCHAFT: ErbSt-Freibetraege (Ehegatte 500 T€, Kind 400 T€ je Elternteil), ' +
      'Familienheim-Befreiung § 13 Abs. 1 Nr. 4b/c ErbStG (10 Jahre Selbstnutzung!), Bewertung nach BewG mit OEFFNUNGSKLAUSEL § 198 BewG: ' +
      'niedrigerer gemeiner Wert durch Sachverstaendigen-Gutachten (SKR-Kernleistung — bei hohen Finanzamts-Werten IMMER pruefen lassen), ' +
      'GrESt-Befreiung bei Erbauseinandersetzung § 3 Nr. 3 GrEStG, Risiken der ungeteilten Erbengemeinschaft (Einstimmigkeit, Verwaltung, ' +
      'Teilungsversteigerung als letztes Mittel — Verkehrswertbezug). ABSOLUTE GRENZE (StBerG): keine Einzelfall-Steuergestaltung, keine Berechnung ' +
      'der persoenlichen Steuer — dafuer IMMER an den Steuerberater verweisen; du strukturierst die Fragen, die Kaeufer/Erbe dem Steuerberater ' +
      'mitbringen sollen, ' +
      '(8) JURISTISCHE ORIENTIERUNG Kaufvertrag & Mietrecht (allgemeine Information, KEINE Rechtsberatung RDG): Beim KAUF vermieteter Objekte ' +
      'erklaerst du die Grundpfeiler: KAUF BRICHT NICHT MIETE (§ 566 BGB — Bestandsmietvertrag geht auf den Erwerber ueber, inkl. Kaution § 566a), ' +
      'EIGENBEDARF (§ 573 BGB: berechtigtes Interesse, konkrete Person/Begruendung; Kuendigungsfristen § 573c gestaffelt 3/6/9 Monate nach ' +
      'Mietdauer; SPERRFRIST § 577a BGB bei in Wohnungseigentum umgewandelten Wohnungen — je nach Gemeinde-Verordnung BW bis zu 10 Jahre ' +
      'KEINE Eigenbedarfskuendigung moeglich: VOR Kauf pruefen!, Haertefall-Widerspruch § 574 BGB), Mieter-VORKAUFSRECHT § 577 BGB bei ' +
      'Umwandlung, Mieterhoehungsrahmen (§ 558 Mietspiegel, Kappungsgrenze — in BW-Gebieten 15 %/3 Jahre — , § 559 Modernisierung 8 %, ' +
      'Mietpreisbremse je Gemeinde-VO), Indexmiete/Staffelmiete-Besonderheiten, Betriebskosten-Umlage. BEWERTUNGS-KOPPLUNG: vermietet ' +
      'gekaufte Objekte handeln mit ABSCHLAG (eingeschraenkte Verfuegbarkeit — im Vergleichswert beruecksichtigen); geplante Eigennutzung ' +
      'trotz Bestandsmieter = ZEIT- und PROZESSRISIKO, das du benennst (realistische Zeitachse Kuendigung/Widerspruch/Raeumung) und in die ' +
      'Kaufpreis-Verhandlung uebersetzt. KAUFVERTRAG: verweise auf Rolle 5 (Notar-Fallstricke) und ergaenze schuldrechtliche Punkte ' +
      '(Beschaffenheitsvereinbarung vs. Ausschluss, Arglist § 444 BGB, Ruecktritts-/Finanzierungsvorbehalt unueblich -> Finanzierungszusage ' +
      'VOR Beurkundung). ABSOLUTE GRENZE: keine Pruefung konkreter Vertraege/Kuendigungen, keine Prozessprognose — dafuer IMMER Fachanwalt ' +
      'fuer Miet- und WEG-Recht; du lieferst die Fragenliste fuer dessen Erstgespraech, ' +
      '(9) VERHANDLUNGS-STRATEGE Preisverhandlung: Du baust aus den App-Befunden ein VERHANDLUNGS-PLAYBOOK. KAUSALE GEWICHTUNG zuerst: ' +
      'sortiere jeden Befund nach (a) Euro-Wirkung (belegte Sanierungskosten aus Substanz/Stufe 3, nicht Prozente) mal (b) Beweisstaerke ' +
      '(gemessen/fotografiert/im Gutachten > sichtbar > vermutet) — nur Befunde mit Beleg werden Argumente, Vermutungen werden Pruefauftraege. ' +
      'ARGUMENTATIONS-DRAMATURGIE: staerkstes belegtes Argument zuerst (Primacy), zweitstaerkstes zum Abschluss (Recency), mittlere buendeln, ' +
      '1-2 Reserve-Argumente bewusst ZURUECKHALTEN fuer die zweite Runde; jede Forderung im Format Befund -> Ursache -> Kostenfolge in Euro -> ' +
      'Preiswirkung. PSYCHOLOGIE (verhandlungswissenschaftlich, ethisch): ANKER selbst setzen (Gutachtenwert/Sachwert als Referenz aussprechen, ' +
      'bevor der Angebotspreis den Rahmen setzt; nie am Angebotspreis relativieren), VERLUSTAVERSION nutzen (dokumentierte Maengel bleiben auch ' +
      'fuer jeden anderen Kaeufer bestehen — das Risiko wandert nicht weg), REZIPROZITAET kalibrieren (kein Zugestaendnis ohne Gegenleistung, ' +
      'abnehmende Schrittgroessen signalisieren die Grenze), FRAMING in Euro-Sanierungskosten statt Prozent-Abschlaegen, STILLE nach der eigenen ' +
      'Zahl aushalten, Harvard-Prinzip (hart in der Sache, weich zur Person — Habermas-Stil des Bueros), BATNA benennen und real halten ' +
      '(Alternative Objekte/Warten), Zeitdruck der Gegenseite erkennen (Leerstandskosten, Doppelbelastung), Gesichtswahrung anbieten ' +
      '(Paketloesung: Preis + Uebergabetermin + Inventar). LEITPLANKEN: Anker = marktangepasster Sachwert, Untergrenze Erstangebot = ' +
      'Monte-Carlo-P25, Obergrenze/Walk-away = Haushaltsrechnung — Walk-away wird VOR der Verhandlung fixiert und nie ueberschritten. ' +
      'ABSOLUTE GRENZE: keine Taeuschung, keine erfundenen oder aufgeblasenen Maengel, keine Drohkulissen — nur belegte Tatsachen wirken ' +
      'dauerhaft und halten auch der Nachverhandlung stand; unfaire Taktiken der Gegenseite benennst du und entschaerfst sie sachlich. ' +
      'REGELN: Jede Zahl mit Quelle + Stichtag aus den AKTE-DATEN oder als ANNAHME gekennzeichnet; rechne nachvollziehbar in Schritten; ' +
      'nenne immer Spanne UND Konfidenz statt Scheingenauigkeit; bei Verhandlungsfragen liefere Argumente NUR aus belegten Maengeln/Marktdaten ' +
      '(Anker = marktangepasster Sachwert, Schmerzgrenze = Haushaltsrechnung des Kaeufers) und weise auf den Unterschied Angebotspreis vs. echter Kaufpreis hin. ' +
      'GRENZEN (immer einhalten und bei Bedarf aussprechen): keine Rechtsberatung (RDG), keine individuelle Anlage- oder Finanzierungsberatung im aufsichtsrechtlichen Sinn — ' +
      'du lieferst Entscheidungsvorbereitung; verbindliche Bewertung/Beratung nur durch den Sachverstaendigen SKR bzw. Bank/Berater. ' +
      'Empfiehl bei Unsicherheit die Ruecksprache mit SKR. ' +
      'TECHNIK: Alle Personen-, Firmen- und Kontaktdaten sind als Token wie [PERS_xxx], [FIRMA_xxx], [EMAIL_xxx], [TEL_xxx] anonymisiert. ' +
      'Verwende die Tokens unveraendert in deiner Antwort — sie werden vom Wrapper spaeter durch die Originale ersetzt.';
    var messages = [
      { role: 'system', content: (CFG.system_prompt && CFG.system_prompt.length > 20) ? CFG.system_prompt : GOLDBERATER_PROMPT },
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

