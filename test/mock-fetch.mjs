// Preload for offline end-to-end runs: node --import ./test/mock-fetch.mjs scripts/collect.mjs
// Generates deterministic fake bonusSeatView responses. MOCK_SEED changes which seats are open.
const seed = Number(process.env.MOCK_SEED || 1);
const sent = [];
globalThis.__telegramSent = sent;

function hash(s) { let h = seed * 2654435761; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; }

globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.telegram.org')) {
    sent.push(JSON.parse(opts.body).text);
    return new Response('{"ok":true}', { status: 200 });
  }
  const b = JSON.parse(opts.body);
  if (process.env.MOCK_FAIL && b.arrivalAirport === process.env.MOCK_FAIL) return new Response('<html>blocked</html>', { status: 403 });
  const y = +b.departureDate.slice(0, 4); const m = +b.departureDate.slice(4, 6);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const flightList = [];
  for (let d = 1; d <= days; d++) {
    const date = `${b.departureDate.slice(0, 6)}${String(d).padStart(2, '0')}`;
    const fl = [];
    for (const [fn, t] of [['KE0' + (10 + (b.arrivalAirport.charCodeAt(0) % 80)), '10:20'], ['KE9' + (b.departureAirport.charCodeAt(1) % 90), '19:40']]) {
      for (const cls of ['E', 'P', 'U', 'F']) {
        const p = { E: 0.9, P: 0.15, U: 0.3, F: 0.06 }[cls];
        fl.push({ departureTime: t, flightNumber: fn, availableSeat: hash(date + fn + cls + b.departureAirport) < p, bookingClass: 'X', frontBookingClass: cls });
      }
    }
    flightList.push({ departureDate: date, flightDetailList: fl });
  }
  return new Response(JSON.stringify({ departureAirport: b.departureAirport, arrivalAirport: b.arrivalAirport, flightList }), { status: 200 });
};

process.on('exit', () => {
  if (sent.length) console.log(`[mock] telegram messages: ${sent.length}\n---\n${sent[0].slice(0, 700)}\n---`);
});
