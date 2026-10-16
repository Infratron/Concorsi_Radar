import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  databaseIdFromToml,
  d1OptionsForLocalRun,
  oauthExpiryFromConfig,
  oauthTokenFromConfig,
  wranglerConfigPaths,
} from "../scripts/wrangler-auth.ts";

/**
 * Le credenziali della raccolta locale: quelle dichiarate vincono, e quando non
 * ci sono si riusa il login di wrangler. La seconda strada è una comodità — vale
 * per una raccolta a mano — quindi quello che va bloccato qui è che non prenda
 * mai il posto di una credenziale esplicita e che, quando non trova niente, dica
 * cosa manca invece di provare a scrivere su D1 con un token vuoto.
 */

const CONFIG = [
  'oauth_token = "token-del-login"',
  'expiration_time = "2026-10-16T22:04:16.000Z"',
  'refresh_token = "refresh"',
].join("\n");

const TOML = [
  'name = "concorsi-radar"',
  "[[d1_databases]]",
  'binding = "DB"',
  'database_name = "concorsi-radar"',
  'database_id = "2c47a097-ad0e-4872-b868-9d9b3efe0dbb"',
].join("\n");

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "account-da-env",
  CLOUDFLARE_API_TOKEN: "token-da-env",
  D1_DATABASE_ID: "db-da-env",
};

/** Un finto filesystem: solo i percorsi dichiarati esistono. */
function files(map: Record<string, string>) {
  return (path: string): string | null => map[path] ?? null;
}

describe("lettura del file di configurazione di wrangler", () => {
  it("prende token e scadenza, senza dipendere dall'ordine delle righe", () => {
    expect(oauthTokenFromConfig(CONFIG)).toBe("token-del-login");
    expect(oauthExpiryFromConfig(CONFIG)?.toISOString()).toBe("2026-10-16T22:04:16.000Z");
  });

  it("un file di un'altra forma non fa inventare un token", () => {
    expect(oauthTokenFromConfig("scopes = []\n")).toBeNull();
    expect(oauthTokenFromConfig('oauth_token = ""')).toBeNull();
    expect(oauthExpiryFromConfig('expiration_time = "non una data"')).toBeNull();
  });

  it("l'id del database viene dal wrangler.toml del progetto", () => {
    expect(databaseIdFromToml(TOML)).toBe("2c47a097-ad0e-4872-b868-9d9b3efe0dbb");
    expect(databaseIdFromToml('name = "concorsi-radar"')).toBeNull();
  });

  it("il login si cerca prima dove lo mette la piattaforma", () => {
    // Su Windows il percorso di wrangler sta sotto %APPDATA%/xdg.config: è il
    // caso di questa installazione, e `join` tiene separatori giusti per la
    // piattaforma (il test non deve imporre i "/" ).
    const appData = join("C:", "Users", "x", "AppData", "Roaming");
    const percorsi = wranglerConfigPaths({ APPDATA: appData }, join("C:", "Users", "x"));
    expect(percorsi[0]).toBe(join(appData, "xdg.config", ".wrangler", "config", "default.toml"));
    // Il percorso XDG esplicito, quando c'è, viene per primo.
    expect(wranglerConfigPaths({ XDG_CONFIG_HOME: join("/", "xdg") }, "/home/x")[0]).toBe(
      join("/", "xdg", ".wrangler", "config", "default.toml"),
    );
    // E la candidate list finisce sempre su una delle due case dell'utente.
    expect(percorsi.at(-1)).toContain(join(".config", ".wrangler"));
  });
});

describe("d1OptionsForLocalRun", () => {
  it("con le tre variabili non legge nessun file", async () => {
    const options = await d1OptionsForLocalRun(ENV, {
      readTextFile: () => {
        throw new Error("non doveva leggere niente");
      },
    });
    expect(options).toEqual({ accountId: "account-da-env", apiToken: "token-da-env", databaseId: "db-da-env" });
  });

  it("senza variabili usa il login di wrangler e il database del progetto", async () => {
    const options = await d1OptionsForLocalRun(
      {},
      {
        configPaths: ["/config/default.toml"],
        projectToml: "/progetto/wrangler.toml",
        readTextFile: files({ "/config/default.toml": CONFIG, "/progetto/wrangler.toml": TOML }),
        fetcher: (async () =>
          new Response(JSON.stringify({ result: [{ id: "account-dall-api" }] }))) as typeof fetch,
        now: new Date("2026-10-16T21:00:00.000Z"),
      },
    );
    expect(options).toEqual({
      accountId: "account-dall-api",
      apiToken: "token-del-login",
      databaseId: "2c47a097-ad0e-4872-b868-9d9b3efe0dbb",
    });
  });

  it("l'account dichiarato vince su quello chiesto all'API", async () => {
    const options = await d1OptionsForLocalRun(
      { CLOUDFLARE_ACCOUNT_ID: "account-da-env" },
      {
        configPaths: ["/config/default.toml"],
        projectToml: "/progetto/wrangler.toml",
        readTextFile: files({ "/config/default.toml": CONFIG, "/progetto/wrangler.toml": TOML }),
        fetcher: (async () => {
          throw new Error("non doveva chiedere all'API");
        }) as unknown as typeof fetch,
        now: new Date("2026-10-16T21:00:00.000Z"),
      },
    );
    expect(options.accountId).toBe("account-da-env");
    expect(options.apiToken).toBe("token-del-login");
  });

  it("un login scaduto lo dice, e dice come rinnovarlo", async () => {
    await expect(
      d1OptionsForLocalRun(
        {},
        {
          configPaths: ["/config/default.toml"],
          projectToml: "/progetto/wrangler.toml",
          readTextFile: files({ "/config/default.toml": CONFIG, "/progetto/wrangler.toml": TOML }),
          fetcher: (async () =>
            new Response(JSON.stringify({ result: [{ id: "account-dall-api" }] }))) as typeof fetch,
          // La scadenza nel file è il 16/10/2026 alle 22:04: qui è passata.
          now: new Date("2026-10-16T22:30:00.000Z"),
        },
      ),
    ).rejects.toThrow(/scaduto.*wrangler whoami/s);
  });

  it("senza niente elenca tutte le credenziali che mancano", async () => {
    await expect(
      d1OptionsForLocalRun(
        { D1_DATABASE_ID: "db-da-env" },
        {
          configPaths: ["/config/default.toml"],
          projectToml: "/progetto/wrangler.toml",
          readTextFile: () => null,
          fetcher: (async () => new Response("{}")) as typeof fetch,
        },
      ),
    ).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN/);
  });
});
