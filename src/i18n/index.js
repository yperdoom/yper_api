import enUS, { values as enUSValues } from './locales/en-US.js';
import ptBR, { values as ptBRValues } from './locales/pt-BR.js';

export const DEFAULT_LOCALE = 'pt-BR';

const LOCALES = Object.freeze({
  'pt-BR': { messages: ptBR, values: ptBRValues },
  'en-US': { messages: enUS, values: enUSValues },
});

// So o idioma importa: pt-PT, pt e pt-BR caem todos no pt-BR.
const BY_LANGUAGE = Object.freeze({ pt: 'pt-BR', en: 'en-US' });

/** Primeira tag suportada do Accept-Language; sem nenhuma, pt-BR. */
export function resolveLocale(request) {
  const header = String(request?.headers?.['accept-language'] || '');
  for (const part of header.split(',')) {
    const language = part.split(';')[0].trim().toLowerCase().split('-')[0];
    if (BY_LANGUAGE[language]) return BY_LANGUAGE[language];
  }
  return DEFAULT_LOCALE;
}

/** Monta a mensagem do codigo trocando {param}; valores conhecidos (ex: status) tambem sao traduzidos. */
export function translate(locale, code, params = {}) {
  const { messages, values } = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
  const template = messages[code] ?? code;
  return template.replace(/\{(\w+)\}/g, (placeholder, name) => {
    if (!(name in params)) return placeholder;
    const value = String(params[name]);
    return Object.hasOwn(values, value) ? values[value] : value;
  });
}
