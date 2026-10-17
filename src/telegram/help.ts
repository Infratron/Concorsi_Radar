/**
 * La wiki della chat: una pagina breve per ogni sezione.
 *
 * Regole di scrittura, perché resti una wiki e non un manuale:
 *  - **poche righe**: tre o quattro, mai più. Una pagina che si scorre è una
 *    pagina che si legge;
 *  - **cosa vedi, poi cosa fare**: la prima riga dice a cosa serve la sezione,
 *    l'ultima cosa toccare;
 *  - **niente gergo**: "punteggio", "soglia" e "filtri" sono parole che l'app ha
 *    già introdotto in chat; "cluster", "deduplica", "ingestione" no;
 *  - **italiano corretto**: la wiki è il posto dove un errore di lingua si nota
 *    di più, perché la si legge per capire.
 *
 * Aggiungere una pagina = aggiungere una voce a questo elenco. La tastiera
 * (⬅️ Prec / Succ ➡️) si costruisce da sola sul numero di voci, e la sezione
 * `aiuto:<indice>` è accettata solo per gli indici che esistono qui (vedi
 * isKnownSection in screens.ts): una pagina inventata non apre il vuoto.
 */

export interface HelpPage {
  /** Ancora stabile: è quella che la sezione `aiuto:<indice>` cerca. */
  id: string;
  /** Sezione dell'app spiegata (null per la pagina introduttiva). */
  section: string | null;
  title: string;
  /** Le righe del testo, già pronte: niente HTML, si aggiunge in resa. */
  lines: string[];
}

export const HELP_PAGES: HelpPage[] = [
  {
    id: "intro",
    section: null,
    title: "Come funziona",
    lines: [
      "Il bot legge ogni mezz'ora i siti che pubblicano concorsi, scarta quello che non è un concorso e tiene il resto in archivio.",
      "Qui si tocca, non si scrive: c'è un solo messaggio, che cambia quando scegli una sezione.",
      "I numeri sui bottoni dicono quanti concorsi ci sono dentro adesso. 🔄 Aggiorna rilegge tutto.",
    ],
  },
  {
    id: "nuovi",
    section: "nuovi",
    title: "🆕 Nuovi",
    lines: [
      "I concorsi arrivati dall'ultimo controllo.",
      "Se è vuota, dall'ultimo giro non è arrivato niente di nuovo: non è un guasto.",
    ],
  },
  {
    id: "oggi",
    section: "oggi",
    title: "📋 Oggi",
    lines: [
      "Quello che è arrivato da mezzanotte.",
      "A mezzanotte la sezione riparte da zero: i concorsi di ieri sono in 📅 7 giorni.",
    ],
  },
  {
    id: "settimana",
    section: "settimana",
    title: "📅 7 giorni",
    lines: [
      "Gli ultimi sette giorni di concorsi, dal punteggio più alto.",
      "Serve a recuperare quello che è arrivato mentre non guardavi.",
    ],
  },
  {
    id: "scadenze",
    section: "scadenze",
    title: "⏳ Scadenze",
    lines: [
      "I concorsi che chiudono entro sette giorni.",
      "Ti avviso tre giorni prima e il giorno prima della chiusura.",
      "Per le raccolte punti e i premi da richiedere l'avviso arriva molto prima: lì serve tempo per mettere via gli scontrini.",
    ],
  },
  {
    id: "premi",
    section: "premi",
    title: "🎁 Tipi di premio",
    lines: [
      "Cinque porte per tipo di premio: gift card, auto e moto, viaggi, buoni spesa, gratis.",
      "Non cambiano i tuoi filtri: entri, guardi, esci.",
    ],
  },
  {
    id: "salvati",
    section: "salvati",
    title: "⭐ Watchlist",
    lines: [
      "I concorsi che hai salvato, chi chiude prima in cima.",
      "Per salvarne uno: apri il concorso e tocca ⭐ Watchlist.",
    ],
  },
  {
    id: "news",
    section: "news",
    title: "📰 News",
    lines: [
      "Articoli che parlano di concorsi.",
      "Non sono concorsi: il link porta al pezzo, non alla pagina ufficiale.",
    ],
  },
  {
    id: "cerca",
    section: "cerca",
    title: "🔍 Cerca",
    lines: [
      "Scrivi una parola e premi invio.",
      "Cerca nei titoli e nei riassunti, anche fra quelli già chiusi.",
    ],
  },
  {
    id: "storico",
    section: "storico",
    title: "🗂 Storico",
    lines: [
      "Le tue decisioni: vinti, chiusi, scartati.",
      "Da qui si apre 📚 Archivio, che è tutto quello che il bot ha mai visto.",
    ],
  },
  {
    id: "archivio",
    section: "archivio",
    title: "📚 Archivio",
    lines: [
      "Tutto quello che il bot ha visto: concorsi, coupon e articoli, anche chiusi.",
      "I filtri di 🎛 Cosa vedi qui non valgono: se l'abbiamo visto, si trova.",
      "⛔ significa che non si partecipa più.",
    ],
  },
  {
    id: "coupon",
    section: "coupon",
    title: "💶 Coupon e rimborsi",
    lines: [
      "Buoni sconto, rimborsi e cashback ancora spendibili.",
      "Non sono concorsi, non si vince niente e non mandano notifiche.",
    ],
  },
  {
    id: "preferiti",
    section: "preferiti",
    title: "🏷 Marche seguite",
    lines: [
      "Tocca una marca per seguirla: i suoi concorsi valgono dieci punti in più e finiscono in 📋 I loro concorsi.",
      "Ti avviso appena esce un concorso di una marca che segui, anche sotto la soglia degli avvisi.",
    ],
  },
  {
    id: "filtri",
    section: "filtri",
    title: "🎛 Cosa vedi",
    lines: [
      "Cosa vuoi vedere in questa chat: tipi di concorso, categorie di fonti, stelle minime, solo senza acquisto.",
      "Valgono nelle sezioni normali. Non valgono in ⭐ Watchlist, 📚 Archivio e 🔍 Cerca, dove hai scelto tu cosa guardare.",
    ],
  },
  {
    id: "punteggio",
    section: null,
    title: "📊 Il punteggio",
    lines: [
      "Da 0 a 100: quanto vale la pena guardare un concorso adesso.",
      "Conta il premio, lo sforzo, la scadenza, quanto è fresco, se serve comprare, più i tuoi gusti e le marche che segui.",
      "Nella scheda di un concorso trovi le voci una per una e quanto manca alla soglia delle stelle.",
    ],
  },
  {
    id: "fonti",
    section: "fonti",
    title: "📡 Fonti",
    lines: [
      "Chi risponde e chi no: l'ultimo tentativo, il codice HTTP e quanti concorsi ha portato.",
      "Puoi spegnere una fonte solo per te: i suoi concorsi non arrivano più né negli elenchi né negli avvisi.",
    ],
  },
  {
    id: "impostazioni",
    section: "impostazioni",
    title: "⚙️ Impostazioni",
    lines: [
      "La soglia degli avvisi, la fascia di silenzio e gli orari del digest.",
      "La soglia non vale per le marche che segui: quelle avvisano comunque.",
      "Sono di questa chat: quello che cambi tu non cambia la chat dell'altra persona.",
    ],
  },
];

/** L'indice di una pagina, o null se non esiste. */
export function helpIndexFor(pageId: string): number | null {
  const indice = HELP_PAGES.findIndex((pagina) => pagina.id === pageId);
  return indice >= 0 ? indice : null;
}

/** L'indice della pagina che spiega una sezione (per il bottone contestuale). */
export function helpIndexForSection(section: string): number | null {
  const indice = HELP_PAGES.findIndex((pagina) => pagina.section === section);
  return indice >= 0 ? indice : null;
}
