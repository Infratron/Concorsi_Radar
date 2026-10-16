import type { InlineKeyboardMarkup } from "./api.ts";

/**
 * Bottoni sotto ogni concorso. I callback_data sono corti e stabili:
 * "save:<id>", "ign:<id>", "won:<id>" — li legge src/telegram/bot.ts.
 */
export function itemKeyboard(itemId: number, url: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Salva", callback_data: `save:${itemId}` },
        { text: "🚫 Non mi interessa", callback_data: `ign:${itemId}` },
        { text: "🏆 Vinto", callback_data: `won:${itemId}` },
      ],
      [{ text: "🔗 Apri", url }],
    ],
  };
}

/** Variante con il link diretto al regolamento, quando lo abbiamo trovato. */
export function itemKeyboardWithRegolamento(
  itemId: number,
  url: string,
  regolamentoUrl: string,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Salva", callback_data: `save:${itemId}` },
        { text: "🚫 Non mi interessa", callback_data: `ign:${itemId}` },
        { text: "🏆 Vinto", callback_data: `won:${itemId}` },
      ],
      [
        { text: "🔗 Apri", url },
        { text: "📄 Regolamento", url: regolamentoUrl },
      ],
    ],
  };
}
