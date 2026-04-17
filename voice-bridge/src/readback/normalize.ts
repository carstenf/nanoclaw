// voice-bridge/src/readback/normalize.ts
// D-13: German numeric / time / date normalization for two-form readback validation.
// Pure functions; no side effects; no I/O.

const ONES: Record<string, number> = {
  null: 0,
  ein: 1,
  eins: 1,
  eine: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fuenf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwoelf: 12,
}

const TEENS: Record<string, number> = {
  dreizehn: 13,
  vierzehn: 14,
  fuenfzehn: 15,
  sechzehn: 16,
  siebzehn: 17,
  achtzehn: 18,
  neunzehn: 19,
}

const TENS: Record<string, number> = {
  zwanzig: 20,
  dreissig: 30,
  vierzig: 40,
  fuenfzig: 50,
  sechzig: 60,
  siebzig: 70,
  achtzig: 80,
  neunzig: 90,
}

const ORDINALS: Record<string, number> = {
  erste: 1,
  erster: 1,
  zweite: 2,
  zweiter: 2,
  dritte: 3,
  dritter: 3,
  vierte: 4,
  fuenfte: 5,
  sechste: 6,
  siebte: 7,
  siebente: 7,
  achte: 8,
  neunte: 9,
  zehnte: 10,
  elfte: 11,
  zwoelfte: 12,
  dreizehnte: 13,
  vierzehnte: 14,
  fuenfzehnte: 15,
  sechzehnte: 16,
  siebzehnte: 17,
  achtzehnte: 18,
  neunzehnte: 19,
  zwanzigste: 20,
  einundzwanzigste: 21,
  zweiundzwanzigste: 22,
  dreiundzwanzigste: 23,
  vierundzwanzigste: 24,
  fuenfundzwanzigste: 25,
  sechsundzwanzigste: 26,
  siebenundzwanzigste: 27,
  achtundzwanzigste: 28,
  neunundzwanzigste: 29,
  dreissigste: 30,
  einunddreissigste: 31,
}

export function foldDiacritics(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function germanWordToNumber(word: string): number | null {
  if (!word) return null
  const w = foldDiacritics(word).trim()
  if (!w) return null
  if (/^\d+$/.test(w)) return parseInt(w, 10)
  if (w in ONES) return ONES[w]
  if (w in TEENS) return TEENS[w]
  if (w in TENS) return TENS[w]
  // Compound: "NundM" (written together) or "N und M" (with spaces).
  const compact = w.replace(/\s+/g, '')
  const m = compact.match(/^([a-z]+)und([a-z]+)$/)
  if (m) {
    const [, left, right] = m
    const a = ONES[left]
    const b = TENS[right]
    if (a !== undefined && b !== undefined) return b + a
  }
  return null
}

/**
 * Return DD as zero-padded 2-char string. Accepts ordinals
 * ("dreiundzwanzigste"), cardinals ("dreiundzwanzig"), and digits ("23.").
 * Out-of-range (<1 or >31) returns null.
 */
export function normalizeGermanDate(text: string): string | null {
  if (!text) return null
  const t = foldDiacritics(text).trim().replace(/\.$/, '')
  if (!t) return null
  if (t in ORDINALS) return pad(ORDINALS[t])
  const n = germanWordToNumber(t)
  if (n === null) return null
  if (n < 1 || n > 31) return null
  return pad(n)
}

/**
 * Return HH:MM or 'HH_AM:MM|HH_PM:MM' when morning/afternoon is ambiguous.
 *
 *   'halb drei'      -> '02:30|14:30'
 *   'siebzehn Uhr'   -> '17:00'
 *   '17 Uhr'         -> '17:00'
 *   '17:00'          -> '17:00'
 *   'Viertel nach 3' -> '03:15|15:15'
 *   'Viertel vor 3'  -> '02:45|14:45'
 */
export function normalizeGermanTime(text: string): string | null {
  if (!text) return null
  const raw = foldDiacritics(text).trim()
  if (!raw) return null

  // "NN:MM" / "NN.MM" optional trailing " uhr"
  const hhmm = raw.match(/^(\d{1,2})[:.](\d{2})(\s*uhr)?$/)
  if (hhmm) {
    const h = parseInt(hhmm[1], 10)
    const m = parseInt(hhmm[2], 10)
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return `${pad(h)}:${pad(m)}`
    return null
  }

  // "<word> uhr [<word>]"
  const uhr = raw.match(/^(\S+)\s*uhr(?:\s+(\S+))?$/)
  if (uhr) {
    const h = germanWordToNumber(uhr[1])
    const m = uhr[2] ? germanWordToNumber(uhr[2]) : 0
    if (h !== null && m !== null && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${pad(h)}:${pad(m)}`
    }
    return null
  }

  // "halb drei" = (N-1):30 AM | (N-1+12):30 PM
  const halb = raw.match(/^halb\s+(\S+)$/)
  if (halb) {
    const n = germanWordToNumber(halb[1])
    if (n !== null && n >= 1 && n <= 12) {
      const hAm = (n - 1 + 12) % 12
      const hPm = hAm + 12
      return `${pad(hAm)}:30|${pad(hPm)}:30`
    }
    return null
  }

  // "viertel nach N" = N:15 AM | N+12:15 PM
  const vn = raw.match(/^viertel\s+nach\s+(\S+)$/)
  if (vn) {
    const n = germanWordToNumber(vn[1])
    if (n !== null && n >= 1 && n <= 12) {
      return `${pad(n % 12)}:15|${pad((n % 12) + 12)}:15`
    }
    return null
  }

  // "viertel vor N" = (N-1):45 AM | (N-1+12):45 PM
  const vv = raw.match(/^viertel\s+vor\s+(\S+)$/)
  if (vv) {
    const n = germanWordToNumber(vv[1])
    if (n !== null && n >= 1 && n <= 12) {
      const hAm = (n - 1 + 12) % 12
      const hPm = hAm + 12
      return `${pad(hAm)}:45|${pad(hPm)}:45`
    }
    return null
  }

  return null
}
