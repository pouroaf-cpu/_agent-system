// All displayed dates use the operator's timezone, independently of the browser.
function formatNZTime(value, options = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) {
  return new Intl.DateTimeFormat('en-NZ', { ...options, timeZone: 'Pacific/Auckland' }).format(new Date(value));
}
function nzDateTimeInput(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function nzInputToISO(value) {
  const wall = Date.parse(value + 'Z');
  let instant = wall;
  // Resolve the NZ offset at the requested date, including daylight saving.
  for (let i = 0; i < 3; i++) instant += wall - Date.parse(nzDateTimeInput(instant) + 'Z');
  if (nzDateTimeInput(instant) !== value) throw new Error('That time does not exist in New Zealand (daylight saving).');
  return new Date(instant).toISOString();
}

function formatNZText(text) {
  return String(text).replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, value => formatNZTime(value));
}
