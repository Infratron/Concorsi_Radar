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
 * Aggiungere una pagina = aggiungere una voce a questo elenco: la schermata
 * d'aiuto è un INDICE di bottoni, uno per argomento, e si costruisce da questa
 * lista. Non ci sono frecce: con le frecce si poteva solo scorrere, e per
 * arrivare a "Impostazioni" servivano quindici tocchi e la memoria di dove
 * fosse. La sezione `aiuto:<id>` è accettata solo per gli id che esistono qui
 * (vedi isKnownSection in screens.ts): una pagina inventata non apre il vuoto.
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
      "Otto porte: gift card, auto e moto, viaggi, buoni spesa, premi certi e omaggi con acquisto — più 🆓 Gratis e 💸 Con acquisto, che dividono l'archivio in due metà.",
      "Non cambiano i tuoi filtri: entri, guardi, esci.",
      "💸 Con acquisto mostra i concorsi dove serve una spesa, anche se hai acceso il filtro \"solo senza acquisto\".",
    ],
  },
  {
    id: "premio-certo",
    section: "premi:premio_certo",
    title: "🎁 Premio certo",
    lines: [
      "Il premio è garantito a chi partecipa: non è un'estrazione.",
      "Oggi lo dichiarano quasi solo le pagine di Scontrino Felice · premio certo; le altre fonti usano raramente questa formula.",
      "La porta rispetta i filtri che hai già attivo (fonti, stelle, marche): non ne accende nessuno.",
      "Se il bando dichiara gli orari e la cadenza dei premi, la scheda aggiunge 🕐 Quando giocare e dice se adesso si è dentro o fuori: fuori orario scrive anche quando riapre.",
      "Quando il testo non li dichiara, la riga non c'è: gli orari non si inventano.",
    ],
  },
  {
    id: "omaggi",
    section: "premi:omaggio_con_acquisto",
    title: "🛍️ Omaggi con acquisto",
    lines: [
      "Regali che si ricevono comprando: richiedi il set, ritiri il gadget, ricevi il buono.",
      "Non sono estrazioni: il premio è tuo, non si vince.",
      "Quasi tutti arrivano dalla fonte dei premi certi, che è l'unica a pubblicarne tanti.",
    ],
  },
  {
    id: "salvati",
    section: "salvati",
    title: "⭐ Watchlist",
    lines: [
      "I concorsi che hai salvato, chi chiude prima in cima.",
      "Per salvarne uno: apri il concorso e tocca ⭐ Watchlist.",
      "Per toglierlo: nella sua scheda tocca ☆ Togli dalla watchlist. Nessun concorso ci resta per forza.",
      "Nella scheda leggi cosa conservare (scontrino, codice, bollini) e quando chiedere il premio, così resta lì anche senza promemoria.",
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
      "Da qui si apre 📚 Archivio, che è tutto quello che il bot ha mai visto, e 📊 I tuoi numeri.",
    ],
  },
  {
    id: "numeri",
    section: "numeri",
    title: "📊 I tuoi numeri",
    lines: [
      "Il riepilogo di questa chat: quanto c'è in archivio, cosa hai salvato, vinto e scartato, quante scadenze hai addosso.",
      "I rimborsi sono divisi in due: recuperati (tornati davvero) e in attesa (promessi, non ancora arrivati).",
      "Le decisioni sono di questa chat; l'archivio è condiviso con l'altra persona.",
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
      "Sotto l'elenco scegli la vista: 🗂 Tutti, 📋 Oggi, 📅 7 giorni, ⏳ In scadenza o ↩️ Rimborsi e cashback (spendi e riprendi). Quella attiva ha il • davanti.",
    ],
  },
  {
    id: "rimborsi",
    section: "rimborsi",
    title: "💰 Rimborsi",
    lines: [
      "Le richieste di rimborso e cashback fatte da questa chat, con quanto denaro è già tornato e quanto è ancora in attesa.",
      "Si registra dalla scheda di un coupon: 💰 Ho richiesto. Quando i soldi arrivano, tocca ✅ L'ho ricevuto.",
      "Se il bando dichiara una percentuale invece di una cifra, la chat te la chiede: quel rimborso non entra nei totali finché non lo scrivi.",
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
      "Cosa vuoi vedere in questa chat: tipi di concorso, categorie di fonti, stelle minime, solo senza acquisto e le marche che hai spento.",
      "Una marca si spegne dalla scheda di un concorso con 🔕 Mai più, e si riaccende da qui, in 🔕 Marche spente.",
      "Valgono nelle sezioni normali. Non valgono in ⭐ Watchlist, 📚 Archivio e 🔍 Cerca, dove hai scelto tu cosa guardare.",
    ],
  },
  {
    id: "promemoria",
    section: null,
    title: "📅 Promemoria",
    lines: [
      "Nella scheda di un concorso, 📅 mette nel calendario del telefono il giorno che conta: la scadenza, oppure la data entro cui chiedere il premio.",
      "L'evento arriva già compilato con titolo, premio e link: si apre Google Calendar, non c'è niente da collegare.",
      "Su un coupon la data è la validità dichiarata; se il buono non ne ha una, il bottone non c'è.",
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
    id: "vantaggio",
    section: "vantaggio",
    title: "🏁 Vantaggio di tempistica",
    lines: [
      "Di quanto il radar vede un concorso prima degli aggregatori che lo ripubblicano.",
      "Si misura solo dove la data è dichiarata da entrambi: i concorsi senza una seconda fonte non entrano nella media.",
      "Nella scheda di un concorso la stessa misura è scritta in fondo, così il numero si può controllare caso per caso.",
    ],
  },
  {
    id: "impostazioni",
    section: "impostazioni",
    title: "⚙️ Impostazioni",
    lines: [
      "Gli avvisi per punteggio, la fascia di silenzio e gli orari del digest: partono tutti spenti e si accendono qui.",
      "Il digest è un riepilogo periodico: si accende scegliendo le ore, e si spegne svuotandole.",
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

/** La pagina con quell'id, o null. */
export function helpPageById(pageId: string): HelpPage | null {
  return HELP_PAGES.find((pagina) => pagina.id === pageId) ?? null;
}

/**
 * La pagina che spiega una sezione (per il bottone contestuale "❓ Aiuto").
 *
 * Segue anche le sezioni con un prefisso — `coupon-oggi`, `archivio:coupon`,
 * `cerca:nutella`, `importo:12` — perché sono la stessa cosa vista da una
 * fetta, e la spiegazione è una sola: senza questo, in ⏳ Coupon in scadenza il
 * bottone d'aiuto sarebbe sparito proprio dove serve.
 */
export function helpPageForSection(section: string): HelpPage | null {
  const diretta = HELP_PAGES.find((pagina) => pagina.section === section);
  if (diretta) return diretta;
  if (section.startsWith("coupon-")) return helpPageById("coupon");
  if (section.startsWith("archivio")) return helpPageById("archivio");
  if (section.startsWith("cerca:")) return helpPageById("cerca");
  if (section.startsWith("importo:")) return helpPageById("rimborsi");
  if (section === "preferiti-lista") return helpPageById("preferiti");
  if (section === "filtri-marche") return helpPageById("filtri");
  if (section === "gratis" || section === "spesa" || section.startsWith("premi:")) {
    return helpPageById("premi");
  }
  return null;
}
