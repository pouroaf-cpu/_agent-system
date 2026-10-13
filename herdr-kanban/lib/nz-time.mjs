const formatter = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
export const formatNZTime = (value = Date.now()) => formatter.format(new Date(value))
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' })
export const nzDay = value => dayFormatter.format(new Date(value))
const clockFormatter = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hour: 'numeric', minute: '2-digit' })
export const formatNZClock = value => clockFormatter.format(new Date(value))

export function formatNZText(text) {
  return String(text).replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, value => formatNZTime(value));
}
