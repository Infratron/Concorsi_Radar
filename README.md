# Concorsi Radar

Bot Telegram che scandaglia le fonti italiane di **concorsi a premi** e ti avvisa
*solo* di quello che conta: due digest al giorno più un avviso immediato per i
concorsi di alto valore o in scadenza. Gira su Cloudflare Workers (piano
gratuito) con database D1. Costo: **€0**.

Ideato per l'uso in due (tu + una persona di fiducia, o più): ognuno ha le
proprie preferenze, i propri pesi appresi dai bottoni e le proprie consegne,
ma le fonti e i concorsi sono condivisi.

---

## 1. Come funziona

```
Cron ogni 15 minuti ──► ingestione a rotazione (entro il budget di CPU di 6 ms)
                         ├─ fetch con ETag/Last-Modified e retry
                         ├─ parsing RSS/Atom, sitemap, Google News, liste HTML
                         ├─ deduplica: stesso concorso da più aggregatori → un solo item
                         ├─ arricchimento: scadenza, premio, come partecipare, sforzo
                         │   (regole deterministiche; Workers AI solo sui casi dubbi)
                         └─ punteggio 0-100 + pesi appresi dai tuoi bottoni
                                   │
Cron 06:05 e 17:05 UTC ──► digest  ──► Telegram
nuovo item sopra soglia ──► avviso immediato con bottoni ✅ 🚫 🏆
Telegram ──webhook──► comandi e feedback
```

Decisioni di progetto che contano:

- **La deduplica è il cuore.** Lo stesso concorso compare su 4-5 aggregatori con
  titoli diversi: senza deduplica il bot diventa esattamente lo spam che non
  vuoi. Vedi la sezione 6.
- **Il cron ruota le fonti**: mai tutte insieme. Sul piano gratuito di Workers
  il vincolo vero sono i 10 ms di CPU per invocazione, non il numero di richieste
  (100.000 al giorno): a decidere quanto si fa in un giro è il budget di CPU, con
  un tetto di sicurezza sul numero di fonti. Numeri e metodi nella sezione 9.
- **Google News è la fonte più fresca** (batte gli aggregatori di ore), ma porta
  anche rumore: le sue notizie passano un filtro di pertinenza prima di entrare.
- **Al primo giro in assoluto nessun avviso immediato**: si riempirebbe
  l'archivio di concorsi vecchi. Ci pensa il digest.

## 2. Requisiti

- Node 20+ (testato su Node 24) e npm
- Un account Cloudflare (gratuito)
- Un bot creato con [@BotFather](https://t.me/BotFather)
- Un account GitHub, solo se volete il deploy continuo (opzionale)

## 3. Configurazione dell'ambiente

I segreti **non stanno nel repository**. Ci sono due strade:

| Dove | File/comando | A cosa serve |
|---|---|---|
| Sviluppo locale | `.dev.vars` (ignorato da git) | letto da `wrangler dev` |
| Produzione | `npx wrangler secret put NOME` | valori cifrati su Cloudflare |

Il template con le spiegazioni è [.dev.vars.example](.dev.vars.example): copialo
in `.dev.vars` e riempi i quattro valori.

| Variabile | Significato |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token di @BotFather |
| `WEBHOOK_SECRET` | segreto condiviso col webhook; generalo con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_CHAT_ID` | **tuo** chat id: riceve anche gli avvisi tecnici (fonte in errore) |
| `ALLOWED_CHAT_IDS` | chat autorizzate a usare il bot, separate da virgola: `111111111,222222222` |

> Nota: `.env` non serve. Workers non legge file `.env`: i valori arrivano dai
> binding dell'ambiente, che in locale sono `.dev.vars` e in produzione i secret.

**Non conosci il tuo chat id?** Scrivi qualsiasi cosa al bot: se non sei ancora
autorizzato risponde con il tuo id (e non fa nient'altro). Aggiungilo a
`ALLOWED_CHAT_IDS`, ridistribuisci e riscrivi `/start`.

## 4. Installazione e primo deploy

```bash
npm install
npx wrangler login                # una volta sola: apre il browser su Cloudflare

# 1. database
npm run db:create                 # copia il database_id restituito in wrangler.toml
npm run db:init                   # crea le tabelle
npm run db:seed                   # sincronizza le fonti dal file di configurazione

# 2. segreti (uno alla volta, incolla il valore quando richiesto)
npm run secrets:token
npm run secrets:webhook
npm run secrets:admin
npm run secrets:chats

# 3. pubblica
npm run deploy                    # stampa l'URL del Worker, es. https://concorsi-radar.<tuo>.workers.dev

# 4. registra webhook e menu comandi (usa lo stesso WEBHOOK_SECRET)
curl "https://concorsi-radar.<tuo>.workers.dev/setup?secret=IL_TUO_WEBHOOK_SECRET"
```

Nota sull'ordine: i segreti si aggiungono a un Worker che esiste già. Se non hai
mai pubblicato, fai prima `npm run deploy` (o la prima build, se usi il deploy
continuo) e poi i quattro `secrets:*`. Finché i segreti mancano, `/status`
risponde elencandoli in `missing`: è il modo normale di accorgersene.

Poi, **da entrambi gli account Telegram**, aprite il bot e premete `/start`:
è quello che vi iscrive alle notifiche (il bot non può scrivere per primo a
chi non ha mai avviato la conversazione). Verifica con `/help` e `/health`.

### Prova in locale

```bash
npm run db:init:local
npm run db:seed:local
npm run dev:cron                  # wrangler dev --local --test-scheduled
curl "http://127.0.0.1:8787/status"                                   # variabili mancanti
curl "http://127.0.0.1:8787/__scheduled?cron=*/15+*+*+*+*"            # esegue l'ingestione vera
curl "http://127.0.0.1:8787/health?secret=IL_TUO_WEBHOOK_SECRET"
```

Gli script di sviluppo passano `--local` di proposito: da wrangler 4 i binding
che non si possono simulare (Workers AI) verrebbero aperti in modalità *remote* e
senza credenziali il server non partirebbe. In locale l'arricchimento AI resta
spento — fanno tutto le regole — e si accende sul deploy, dove `env.AI` esiste.

`npm run dry-run` è la prova generale **senza inviare nulla**: scarica le fonti
vere e stampa i messaggi esatti che il bot manderebbe.

```bash
npm run dry-run -- --fonti 8
```

### Deploy continuo da GitHub (ogni push = bot aggiornato)

Il primo deploy si fa una volta a mano, come sopra. Da lì in poi conviene
collegare il repository a Cloudflare: ogni push su `main` pubblica la nuova
versione, senza `npm run deploy` e senza toccare segreti o database.

La repository è già pronta per questo: `.gitignore` esclude `.dev.vars` (i
segreti non entrano in git) e `.wrangler/` (il database locale di prova).

```bash
# 1. crea su GitHub un repository PRIVATO e vuoto (niente README né .gitignore: ci sono già)
# 2. collega e spingi
cd "<cartella del progetto>"
git remote add origin git@github.com:<utente>/<repo>.git
git push -u origin main
```

Poi nel dashboard Cloudflare: **Workers & Pages → Create application → GitHub**
(se il Worker esistesse già: **Settings → Builds → Connect**), scegli il
repository e imposta:

| Impostazione | Valore |
|---|---|
| Production branch | `main` |
| Root directory | *(vuota: il progetto è nella radice)* |
| Build command | `npm ci && npm run typecheck && npm test` |
| Deploy command | `npx wrangler deploy` |
| Preview builds | **disattivate** (vedi sotto) |

Il *build command* è la rete di sicurezza: se il typecheck o uno dei 153 test
fallisce, la build si ferma e **il deploy non parte**. `npm ci` serve a rendere
l'installazione riproducibile dal `package-lock.json`.

Cosa **non** cambia a ogni deploy: i segreti (un deploy non li cancella), il
database D1 e i suoi dati, il webhook Telegram già registrato. Non serve
rieseguire `/setup` né `/start`. Serve invece che `wrangler.toml` abbia il
`database_id` vero: con il segnaposto la build fallisce.

Cosa **non** fa il deploy: le modifiche allo schema del database. Se aggiungi
una tabella, esegui `npm run db:init` a mano (è idempotente, usa
`CREATE TABLE IF NOT EXISTS`) oppure passa alle migrazioni tracciate di D1
(`wrangler d1 migrations`).

**Se un deploy va storto**: dashboard → Worker → **Deployments** → scegli la
versione precedente → Rollback (istantaneo, non ricompila nulla); da riga di
comando `npx wrangler rollback`.

**Lavoro in due**: ogni push su `main` va subito in produzione, quindi per le
modifiche delicate usate un ramo e una pull request, e solo il merge pubblica.
Se attiverete i *Preview builds*, ogni ramo ottiene un URL di prova: ricordate
che i Preview **non** ereditano i segreti di produzione e, con lo stesso
`database_id`, condividono lo stesso database (per isolarli serve un secondo
database D1).

## 5. Comandi del bot

| Comando | Cosa fa |
|---|---|
| `/start` `/stop` | attiva / sospende le **tue** notifiche |
| `/oggi` `/settimana` | concorsi trovati nelle ultime 24 ore / 7 giorni |
| `/scadenze` | concorsi che chiudono entro 7 giorni |
| `/cerca gift card` | ricerca per parola chiave |
| `/salva <id>` `/ignora <id>` `/vinto <id>` | gestione di un concorso |
| `/fonti` | stato delle fonti (attiva, ultimo successo, errori di fila) |
| `/health` | ultime esecuzioni |
| `/help` | elenco comandi |

Sotto ogni concorso ci sono i bottoni ✅ Salva, 🚫 Non mi interessa, 🏆 Vinto e
🔗 Apri (più 📄 Regolamento quando l'URL è nel testo). **Salva** e **Non mi
interessa** addestrano i pesi: ogni tag dei concorsi che salvi guadagna punti e
quelli che ignori li perde, quindi i punteggi si adattano ai tuoi gusti
(clamp ±5 per tag).

## 6. Deduplica: perché è fatta così

Prima di scrivere la regola ho misurato 10 coppie di duplicati veri (stesso
concorso su fonti diverse) e 10 coppie di concorsi diversi:

| Segnale | Duplicati veri | Concorsi diversi |
|---|---|---|
| Distanza di Hamming (SimHash) | 10-20 | da 8 in su |
| Somiglianza Jaccard sui token | 0,63-1,00 | fino a 0,75 |

Il solo SimHash **non separa** le due popolazioni: come giudice darebbe falsi
accoppiamenti. La regola finale è quindi a due stadi:

1. **prefilter**: SimHash con soglia larga (≤ 32) per non scansionare tutto;
2. **giudice**: `isDuplicateTitle` → Jaccard ≥ 0,6 sui **token distintivi**
   (le parole generiche come *vinci, concorso, premio, euro, spesa* vengono
   ignorate) **e** importi coerenti (`1000 euro` ≠ `500 euro`).

Prima di confrontare, il titolo viene ripulito dal nome della fonte (gli
aggregatori antepongono il proprio marchio, "Scontrino Felice - Concorso…") e dal
boilerplate ("[…] Leggi l'articolo: …").

Risultato misurato su quel campione: **10 duplicati su 11 riconosciuti, 0 falsi
accoppiamenti** (11ª coppia: `1000 euro` vs nessun importo, che ora la regola
unisce). La scelta è deliberata: un duplicato mancato costa un messaggio in più,
un falso accoppiamento costa un concorso perso. Le stesse coppie sono bloccate
come test in [test/text.test.ts](test/text.test.ts) e
[test/dedupe.test.ts](test/dedupe.test.ts).

## 7. Punteggio e antispam

Punteggio 0-100 (`src/enrich/score.ts`), pesi trasparenti: valore del premio
(30), sforzo richiesto (20), scadenza entro 3 giorni (18) o 14 (12), freschezza
(12/6), nessun obbligo d'acquisto (10), parole chiave come *gift card* o
*in palio* (5), più bonus/malus dai tuoi feedback.

Le regole di arricchimento estraggono scadenza (date numeriche e "30 novembre
2026", con inferenza dell'anno), premio (importi e marche, comprese le auto
citate solo per marca), modalità di partecipazione e sforzo. Workers AI
(`@cf/meta/llama-3.1-8b-instruct`) interviene **solo** sugli item senza scadenza
né premio, massimo 3 chiamate per esecuzione e con un tetto giornaliero di
10.000 Neurons: oltre il tetto si torna alle regole, senza errori.

Freni antispam, tutti attivi per default:

| Regola | Valore |
|---|---|
| Concorsi per digest | max 8 (`…e altri N su /oggi`) |
| Digest vuoto | non viene inviato |
| Avvisi immediati | max 2 per esecuzione, uno ogni 20 minuti, solo item scoperti da ≤ 3 ore |
| Fascia di silenzio | 23:00-07:00 italiane |
| Primo giro | nessun avviso immediato |
| Notizie fuori tema | filtrate sulle fonti Google News |
| Fonte rotta | 3 errori di fila → **un solo** avviso all'admin |

## 8. Fonti monitorate

Verificate il 16/10/2026 (feed leggibili senza login): Premi e Concorsi,
Scontrino Felice (con acquisto + gratuiti), DimmiCosaCerchi, Soldissimi, Vincimi,
più quattro query Google News e due sitemap. L'elenco completo con stato di
verifica è in [src/config/sources.ts](src/config/sources.ts).

**Aggiungere una fonte**: aggiungi una voce in `SOURCES` (basta `id`, `name`,
`kind`, `url`, `category`, `tags`, `cadenceMin`), poi `npm run db:seed` e
`npm run deploy`. Le fonti marcate `enabled: false` sono da validare a mano
(i selettori/pattern non sono ancora verificati sul markup reale).

**Rimuoverne una**: imposta `enabled: false` e riesegui il seed, oppure
disattivala dal database (lo stato in D1 comanda a runtime).

Nota su `robots.txt`: viene rispettato per le fonti HTML e sitemap; i feed
RSS/Atom e Google News sono endpoint di sindacazione pubblicati per il consumo
automatico, quindi non vengono bloccati da robots (decisione documentata in
`src/ingest/index.ts`). Frequenze basse, User-Agent identificabile.

## 9. Budget gratuito e la CPU misurata

| Risorsa | Uso previsto | Limite Free |
|---|---|---|
| Cron | ~98 esecuzioni/giorno | 5 trigger per account |
| Richieste Worker | ~100/giorno | 100.000/giorno |
| CPU | 3-7 ms per invocazione (misurati in workerd) | **10 ms per invocazione** |
| D1 | qualche decina di scritture/giorno | 5M righe lette · 100k scritte |
| Workers AI | ≤ 40 chiamate/giorno | 10.000 Neurons/giorno |
| Telegram | 2 digest + pochi avvisi | gratuito |

### I 10 ms di CPU reggono il parsing dei feed?

Il parsing da solo sì: una fonte intera costa 0,3-1,4 ms. A sfondare i 10 ms è il
lavoro per **item** (preparazione + decisione del duplicato + arricchimento),
0,24-0,37 ms per item: 45 item in un tick fanno 9-13 ms. Due modi per misurarlo,
entrambi ripetibili:

```bash
npm run bench:cpu                                       # su Node, fonti vere
curl "http://127.0.0.1:8788/bench?secret=WEBHOOK_SECRET&fonti=8"   # dentro workerd
```

Ultima misura su 6-8 fonti reali (16/10/2026):

| Voce | Node | workerd (runtime del deploy) |
|---|---|---|
| parsing di una fonte (12-79 KB · 10-25 item) | 0,36-0,75 ms | 0-1 ms |
| costo per item (preparazione + dedup + arricchimento) | 0,24-0,31 ms | 0,26-0,37 ms |
| tick con **1 fonte piena**, tutti item nuovi | 3,8-4,7 ms | 4,5-5,5 ms |
| tick con **2 fonti piene** | 7,3-9,1 ms | 9-11 ms → sul limite |
| tick a regime, 4 fonti (304 o duplicati) | — | 1-4 ms |

Quindi il tetto non è sul numero di fonti: è sugli **item nuovi lavorati in una
invocazione**. Una fonte da 15-20 item nuovi entra nel budget; due no, e in
workerd due fonti piene arrivano a 9-11 ms, cioè sul filo dei 10 ms (errore 1102
oltre).

Come è tenuto sotto controllo:

- `CPU_BUDGET_MS = 6` è il limitatore vero: la pipeline cronometra parsing,
  preparazione, decisione del duplicato e arricchimento, e quando supera il
  budget smette di leggere item e rimanda il resto al giro dopo, con una
  garanzia: il **primo item di ogni fonte letta si lavora sempre**, così una
  fonte più pesante del budget non viene scaricata a vuoto a ogni giro. Verificato
  sul cron vero in workerd: tick a freddo con una fonte ricca = 7 ms contati, coda
  rimandata, invocazione viva (nessun 1102).
- `MAX_SOURCES_PER_RUN = 4` è solo un tetto di sicurezza. Un feed invariato
  risponde 304 e costa ~0,05 ms, quindi conviene poter controllare più fonti per
  tick e spendere la CPU dove serve invece di contingentare le fonti.
- i tetti per fonte (15 item per i feed, 20 per le sitemap) impediscono a una
  singola fonte di sfondare da sola;
- il margine 6 su 10 esiste perché il conteggio **non** copre la decodifica del
  corpo delle risposte né l'idratazione delle righe D1, e perché la prima
  invocazione dopo un deploy paga la compilazione del codice: il bench scalda
  prima di misurare, la produzione no.

### L'alternativa

- **Workers Paid, 5 $/mese**: 30 secondi di CPU per invocazione (e 30M
  CPU-ms/mese). Toglie il vincolo dalla radice: si alza
  `MAX_SOURCES_PER_RUN` a tutte le fonti e `CPU_BUDGET_MS` a qualche secondo, si
  legge tutto a ogni tick da 15 minuti e si può usare Workers AI per arricchire i
  casi dubbi. Raccomandato se vuoi la freschezza massima senza pensare al budget.
- **Restare gratis senza perdere freschezza**: spostare la raccolta fuori da
  Workers (un cron di GitHub Actions che scarica i feed con Node, nessun limite di
  CPU, e scrive su D1 via API), lasciando al Worker solo digest e chat. Non
  implementato: è la via gratis, ma aggiunge un secondo sistema da mantenere.
- **Scegliere le fonti**: con questo budget si controllano 4 fonti per tick, quindi
  6 fonti attive sono tutte passate ogni ~30 minuti e 12 in ~45. Disattiva quelle
  che non ti servono (`enabled: false`) o allunga la `cadenceMin` di quelle pigre.

**Non verificato**: la contabilità CPU di Cloudflare stessa sul Worker
pubblicato. Le misure qui sopra sono cronometro interno, dentro il runtime vero;
per leggere il numero della piattaforma serve `npx wrangler tail` su un deploy.

## 10. Diagnostica

```bash
curl "https://<worker>/health?secret=WEBHOOK_SECRET"   # esecuzioni e stato fonti
npm run dry-run                                        # cosa verrebbe inviato, senza inviare
npm test                                               # 153 test
npm run typecheck
```

In chat: `/health` per le ultime esecuzioni, `/fonti` per lo stato delle fonti.
La tabella `runs` in D1 conserva la nota di ogni esecuzione (fonti dovute,
duplicati, fuori tema, avvisi inviati).

## 11. Limiti noti

- **Nessuna consegna Telegram reale è stata provata**: senza il vostro token non
  si può. Il percorso di invio è coperto da test con client finto
  ([test/telegram.test.ts](test/telegram.test.ts)) e il resto del Worker è stato
  eseguito davvero in workerd con D1 locale.
- **Google News** restituisce URL di redirect `news.google.com/rss/articles/...`:
  funzionano ma risultano meno leggibili in anteprima.
- **Concorsi fisici/cartacei** restano invisibili se nessuno li pubblica online;
  la copertura reale è "aggregatori + brand mappati". Il registro ufficiale
  MIMIT/PREMA **non è pubblico** (richiede SPID/CNS), quindi nessun bot può
  leggerlo.
- OmaggioMania e scontOmaggio rispondono 403 al fetch diretto: esclusi
  (servirebbe un browser headless su un secondo host).
- Promo ibride (cashback con buoni) possono passare il filtro pertinenza.
- Il digest delle 06:05/17:05 UTC slitta di un'ora tra ora solare e legale: la
  finestra lo tollera, ma se vuoi orari fissi cambia i cron in `wrangler.toml`.
- Il codice gira senza build anche su Node (type-stripping): evita `enum`,
  `namespace` e le "parameter properties" di TypeScript, non supportate.
- **Tutto ciò che è esportato da `src/index.ts` diventa un entry point** del
  Worker: costanti e helper di schedulazione vivono in
  [src/schedule.ts](src/schedule.ts), altrimenti workerd non avvia.

## 12. Mappa del progetto

```
wrangler.toml              Worker, binding D1, Workers AI, tre cron
.dev.vars.example          template delle variabili (copialo in .dev.vars)
src/
  index.ts                 entry point: webhook, /setup, /health, /bench, scheduled()
  schedule.ts              cron → digest o ingestione, finestra digest
  pipeline.ts              rotazione fonti, deduplica, arricchimento, punteggio
  dedupe.ts                preparazione item e decisione di duplicato
  types.ts                 tipi condivisi
  config/sources.ts        fonti dichiarative + cap di sicurezza
  config/env.ts            allow-list chat, variabili mancanti
  lib/text.ts              normalizzazione, URL canonico, SimHash, deduplica titoli
  lib/http.ts              fetch con ETag, retry, timeout
  lib/robots.ts            parsing e matching di robots.txt
  ingest/                  rss.ts, sitemap.ts, httplist.ts, index.ts
  enrich/                  rules.ts, score.ts, ai.ts
  db/                      schema.sql, store.ts, d1.ts, memory.ts
  telegram/                api.ts, format.ts, keyboard.ts, bot.ts, digest.ts
  debug/bench.ts           misura della CPU per invocazione (Node e workerd)
scripts/
  dry-run.ts               prova generale senza inviare nulla
  bench-cpu.ts             stessa misura su Node, con le fonti vere
  seed-sources.ts          genera l'SQL di sincronizzazione delle fonti
test/                      9 file, 153 test (vitest, nessuna rete)
```
