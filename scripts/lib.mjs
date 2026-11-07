// Pure helpers: no network, no file system. Tested in test/lib.test.mjs.

export const CLASS_LABEL = {
  F: '일등석',
  P: '프레스티지',
  U: '프레스티지 승급',
  E: '일반석',
};

// Order in which class codes are stored and shown.
export const CLASS_ORDER = ['F', 'P', 'U', 'E'];

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

export function dirKey(from, to) {
  return `${from}-${to}`;
}

/** YYYYMM strings for the current month (KST) and the following n-1 months. */
export function monthList(now, n) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  let y = kst.getUTCFullYear();
  let m = kst.getUTCMonth() + 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Today's date in KST as YYYYMMDD. */
export function todayKst(now) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10).replaceAll('-', '');
}

function sortClasses(set) {
  return CLASS_ORDER.filter((c) => set.has(c)).join('') +
    [...set].filter((c) => !CLASS_ORDER.includes(c)).sort().join('');
}

/**
 * Turn one bonusSeatView API response into
 * { "YYYYMMDD": [[flightNumber, departureTime, "FPUE"], ...] }
 * keeping only flights, and only the classes that are open.
 * A flight with no open class is kept with "" so "operated but full" differs from "no flight".
 */
export function normalizeResponse(json) {
  const days = {};
  if (!json || !Array.isArray(json.flightList)) {
    throw new Error('unexpected response shape (no flightList)');
  }
  for (const day of json.flightList) {
    const date = String(day.departureDate || '');
    if (!/^\d{8}$/.test(date)) continue;
    const flights = new Map();
    for (const d of day.flightDetailList || []) {
      const fn = String(d.flightNumber || '').trim();
      if (!fn) continue;
      const key = `${fn}|${d.departureTime || ''}`;
      if (!flights.has(key)) flights.set(key, { fn, t: String(d.departureTime || ''), open: new Set() });
      const cls = String(d.frontBookingClass || '').trim();
      if (d.availableSeat === true && cls) flights.get(key).open.add(cls);
    }
    days[date] = [...flights.values()]
      .sort((a, b) => a.t.localeCompare(b.t) || a.fn.localeCompare(b.fn))
      .map((f) => [f.fn, f.t, sortClasses(f.open)]);
  }
  return days;
}

/**
 * Which (date, flight, class) combinations are open in `next` but were not open in `prev`.
 * Only classes in `watch` count, only dates >= today, and only months that were actually fetched this run.
 * If prev has no entry at all for this direction (first run), returns [] so the first run never floods the chat.
 */
export function diffDirection(prevDays, nextDays, { watch, today, fetchedMonths }) {
  if (!prevDays) return [];
  const prevDates = Object.keys(prevDays);
  if (!prevDates.length) return [];
  const prevMax = prevDates.reduce((a, b) => (a > b ? a : b));
  const opened = [];
  for (const [date, flights] of Object.entries(nextDays)) {
    if (date < today) continue;
    if (fetchedMonths && !fetchedMonths.has(date.slice(0, 6))) continue;
    // A date missing from prev inside its range means it was never fetched before (e.g. a partial run):
    // no baseline, so no alert. Dates after prevMax are newly released at the end of the 360-day window.
    if (!prevDays[date] && date <= prevMax) continue;
    const prevFlights = prevDays[date] || [];
    for (const [fn, t, open] of flights) {
      const before = prevFlights.find((p) => p[0] === fn && p[1] === t);
      const beforeOpen = before ? before[2] : '';
      for (const c of open) {
        if (watch.includes(c) && !beforeOpen.includes(c)) {
          opened.push({ date, flight: fn, time: t, cls: c });
        }
      }
    }
  }
  opened.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.cls.localeCompare(b.cls));
  return opened;
}

export function fmtDate(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  const wd = WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y % 100}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}(${wd})`;
}

/**
 * Build Telegram messages (each under the 4096-char limit) for newly opened seats.
 * groups: [{ fromName, toName, items: [{date, flight, time, cls}] }]
 */
export function buildAlertMessages(groups, { pageUrl, maxLen = 3800, maxPerRoute = 25, maxMessages = 4 } = {}) {
  const total = groups.reduce((s, g) => s + g.items.length, 0);
  if (total === 0) return [];
  const header = `✈️ 대한항공 보너스 좌석 새로 열림 (${total}건)\n※ 하루 1회 스냅샷 기준, 예약 전 공식 홈페이지에서 확인하세요.`;
  const footer = pageUrl ? `\n전체 현황: ${pageUrl}` : '';
  const blocks = [];
  for (const g of groups) {
    if (!g.items.length) continue;
    const lines = [`\n■ ${g.fromName} → ${g.toName}`];
    // Merge classes of the same flight on the same date into one line.
    const merged = new Map();
    for (const it of g.items) {
      const k = `${it.date}|${it.flight}|${it.time}`;
      if (!merged.has(k)) merged.set(k, { ...it, classes: [] });
      merged.get(k).classes.push(CLASS_LABEL[it.cls] || it.cls);
    }
    const rows = [...merged.values()];
    for (const r of rows.slice(0, maxPerRoute)) {
      lines.push(`  ${fmtDate(r.date)} ${r.flight} ${r.time} · ${r.classes.join(', ')}`);
    }
    if (rows.length > maxPerRoute) lines.push(`  … 외 ${rows.length - maxPerRoute}편`);
    blocks.push(lines.join('\n'));
  }
  const messages = [];
  let cur = header;
  let skipped = 0;
  for (const b of blocks) {
    if (messages.length >= maxMessages - 1 && (cur + '\n' + b + footer).length > maxLen) { skipped++; continue; }
    if ((cur + '\n' + b + footer).length > maxLen) {
      messages.push(cur + footer);
      cur = '(이어서)';
    }
    cur += '\n' + b;
  }
  if (skipped) cur += `\n\n… 노선 ${skipped}개는 길어서 생략했어요. 페이지에서 확인하세요.`;
  messages.push(cur + footer);
  return messages;
}
