export function hue(uid: string): number {
  let h = 0
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) % 360
  return h
}

/** Cents -> "$2" / "$2.50"; empty when money is not tracked. */
export function money(cents: number | undefined, signed = false): string {
  if (!cents && !signed) return ''
  const c = cents ?? 0
  const sign = c < 0 ? '-' : signed && c > 0 ? '+' : ''
  const abs = Math.abs(c)
  return `${sign}$${abs % 100 === 0 ? abs / 100 : (abs / 100).toFixed(2)}`
}
