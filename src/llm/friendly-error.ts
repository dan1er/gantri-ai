/**
 * Helpers for producing friendly user-facing error messages that match
 * the language the user is speaking in. The bot's user base is bilingual
 * (Spanish + English) so a hardcoded message in either language sounds
 * jarring to half the users.
 *
 * Detection is heuristic — no LLM call (the whole point is we're already
 * in an error path because LLM calls just failed). We look for Spanish-
 * specific glyphs (ñ, ¿, ¡, accented vowels) and a few high-signal
 * function words. Short or mixed-language messages default to English.
 */

const SPANISH_DIACRITICS_AND_PUNCT = /[ñÑáéíóúÁÉÍÓÚ¿¡]/;

// High-signal Spanish function words. We require ≥2 distinct matches to
// avoid false positives on English text that happens to contain "los",
// "y", or one-off bilingual phrases.
const SPANISH_TOKENS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'y', 'o', 'pero', 'porque', 'que', 'qué', 'cuál', 'cuáles', 'cuando', 'cuándo',
  'como', 'cómo', 'donde', 'dónde', 'cuánto', 'cuánta', 'cuántos', 'cuántas',
  'es', 'son', 'está', 'están', 'fue', 'fueron', 'ser', 'estar',
  'tengo', 'tienes', 'tiene', 'tenemos', 'tienen',
  'hay', 'hace', 'hacer', 'puedo', 'puedes', 'puede', 'podemos',
  'me', 'te', 'se', 'nos', 'nuestro', 'nuestra',
  'esto', 'eso', 'aquello', 'esta', 'ese', 'este',
  'de', 'del', 'al', 'con', 'sin', 'por', 'para',
  'muy', 'mucho', 'mucha', 'más', 'menos',
  'sí', 'no', 'también', 'tampoco',
  'gracias', 'hola', 'adios', 'adiós', 'buenos', 'buenas',
  'ahora', 'hoy', 'mañana', 'ayer',
  'cliente', 'usuario', 'orden', 'pedido', 'cuenta', 'correo', 'mensaje',
  'dame', 'dime', 'cuéntame', 'mostrame', 'muéstrame', 'busca', 'búscame',
]);

/**
 * Best-effort detection: returns 'es' when the text looks Spanish, else 'en'.
 * Designed to fail safe to English (the bot's lingua franca for system
 * messages) rather than risk speaking Spanish at an English-only user.
 */
export function detectLanguage(text: string): 'es' | 'en' {
  if (!text || typeof text !== 'string') return 'en';

  if (SPANISH_DIACRITICS_AND_PUNCT.test(text)) return 'es';

  // Tokenize on whitespace + punctuation; lowercase; strip empty.
  const tokens = text
    .toLowerCase()
    .split(/[\s,.!?;:()\[\]"'/]+/)
    .filter(Boolean);

  if (tokens.length === 0) return 'en';

  let spanishHits = 0;
  const seen = new Set<string>();
  for (const tok of tokens) {
    if (SPANISH_TOKENS.has(tok) && !seen.has(tok)) {
      seen.add(tok);
      spanishHits += 1;
      if (spanishHits >= 2) return 'es';
    }
  }
  return 'en';
}

/**
 * Render the "Anthropic capacity exhausted" user-facing message in the
 * same language the user is speaking. Falls back to English.
 */
export function friendlyCapacityMessage(userText: string): string {
  const lang = detectLanguage(userText);
  if (lang === 'es') {
    return '⚠️ Anthropic está saturada por un momento — probá de nuevo en unos minutos. Si urge, podés DMear a Danny.';
  }
  return '⚠️ Anthropic is overloaded right now — try again in a few minutes. If urgent, DM Danny.';
}
