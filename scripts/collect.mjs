// Daily collector: fetches Korean Air's public "보너스 좌석 조회" snapshot (updated once a day by Korean Air),
// stores it in docs/data/latest.json, detects newly opened First/Prestige seats, and posts them to Telegram.
//
// Env:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (optional; without them nothing is sent)
//   PAGE_URL                              (optional; link added to messages)
//   ONLY=ICN-LAX,LAX-ICN                  (optional; limit directions, for testing)
//   MONTHS=2                              (optional; override monthsAhead, for testing)
//   TELEGRAM_TEST=1                       (optional; send a test message and exit)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dirKey, monthList, todayKst, normalizeResponse, diffDirection, buildAlertMessages, buildDailyReport,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');
const LATEST = path.join(DATA_DIR, 'latest.json');
const CHANGES = path.join(DATA_DIR, 'changes.json');
const API = 'https://www.koreanair.com/api/hmp/bonusSeatView/bonusSeatView';
const REPORTS_DIR = path.join(ROOT, 'reports');
const CHANGES_KEEP_DAYS = 45;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([a, b]) => a + Math.floor(Math.random() * (b - a));

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function fetchMonth(from, to, yyyymm) {
  const body = JSON.stringify({ departureAirport: from, arrivalAirport: to, departureDate: `${yyyymm}01` });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          Origin: 'https://www.koreanair.com',
          Referer: 'https://www.koreanair.com/booking/book-and-manage/award-seat-availability',
          'User-Agent': process.env.USER_AGENT || 'ke-award-seats/1.0 (personal daily snapshot reader)',
        },
        body,
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`non-JSON response (${text.slice(0, 60).replace(/\s+/g, ' ')})`); }
      return { json, days: normalizeResponse(json) };
    } catch (e) {
      lastErr = e;
      // 4xx other than 429 will not get better by retrying quickly.
      if (/HTTP 4(?!29)/.test(e.message)) break;
      await sleep(5000 * attempt);
    }
  }
  throw lastErr;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[telegram] not configured; message would be:\n' + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram send failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
}

async function main() {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'routes.json'), 'utf8'));
  const pageUrl = process.env.PAGE_URL || '';

  if (process.env.TELEGRAM_TEST) {
    await sendTelegram(`✅ 보너스 좌석 알림 봇 연결 테스트입니다.${pageUrl ? `\n${pageUrl}` : ''}`);
    console.log('test message sent');
    return;
  }

  const now = new Date();
  const today = todayKst(now);
  const months = monthList(now, Number(process.env.MONTHS) || cfg.monthsAhead);
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((s) => s.trim())) : null;

  // Directions: origin -> dest and dest -> origin for every destination.
  const directions = [];
  for (const region of cfg.regions) {
    for (const d of region.destinations) {
      directions.push({ from: cfg.origin, to: d.code, fromName: cfg.originName, toName: d.name, region: region.id, dir: 'out' });
      directions.push({ from: d.code, to: cfg.origin, fromName: d.name, toName: cfg.originName, region: region.id, dir: 'in' });
    }
  }

  const prev = await readJson(LATEST, null);
  const prevRoutes = prev?.routes || {};
  const routes = {};
  const alertGroups = [];
  let ok = 0; let failed = 0;
  const failures = [];

  for (const d of directions) {
    const key = dirKey(d.from, d.to);
    if (only && !only.has(key)) { if (prevRoutes[key]) routes[key] = prevRoutes[key]; continue; }

    const prevDays = prevRoutes[key]?.days;
    // Start from previous data so a failed month keeps its last known state instead of looking "closed".
    const days = {};
    for (const [date, v] of Object.entries(prevDays || {})) if (date >= today) days[date] = v;
    const fetchedMonths = new Set();
    const staleMonths = [];

    for (const m of months) {
      try {
        const { days: got } = await fetchMonth(d.from, d.to, m);
        for (const date of Object.keys(days)) if (date.startsWith(m)) delete days[date];
        Object.assign(days, got);
        fetchedMonths.add(m);
        ok++;
      } catch (e) {
        failed++;
        staleMonths.push(m);
        failures.push(`${key} ${m}: ${e.message}`);
        console.warn(`[warn] ${key} ${m}: ${e.message}`);
      }
      await sleep(process.env.DELAY_MS ? Number(process.env.DELAY_MS) : rand(cfg.requestDelayMs));
    }

    const sortedDays = Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)));
    routes[key] = {
      from: d.from, to: d.to, fromName: d.fromName, toName: d.toName, region: d.region, dir: d.dir,
      updatedAt: fetchedMonths.size ? now.toISOString() : (prevRoutes[key]?.updatedAt || null),
      staleMonths,
      days: sortedDays,
    };

    const items = diffDirection(prevDays, sortedDays, { watch: cfg.alertClasses, today, fetchedMonths });
    if (items.length) alertGroups.push({ key, fromName: d.fromName, toName: d.toName, items });
    console.log(`${key}: ${fetchedMonths.size}/${months.length} months ok, ${items.length} newly opened`);
  }

  const latest = {
    collectedAt: now.toISOString(),
    today,
    months,
    origin: cfg.origin,
    regions: cfg.regions.map((r) => ({ id: r.id, name: r.name, destinations: r.destinations })),
    stats: { ok, failed },
    routes,
  };

  // Change log for the page ("최근 새로 열린 좌석").
  const changes = await readJson(CHANGES, []);
  const cutoff = new Date(now.getTime() - CHANGES_KEEP_DAYS * 86400000).toISOString();
  const keptChanges = changes.filter((c) => c.seenAt >= cutoff && c.date >= today);
  for (const g of alertGroups) {
    for (const it of g.items) keptChanges.push({ seenAt: now.toISOString(), key: g.key, ...it });
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  // Do not overwrite good data with an all-failed run.
  if (ok > 0) {
    await fs.writeFile(LATEST, JSON.stringify(latest));
    await fs.writeFile(CHANGES, JSON.stringify(keptChanges));

    // Daily markdown report (skipped for partial test runs).
    if (!only) {
      const kstStr = (d) => d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      const dateKst = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`;
      const report = buildDailyReport({
        routes, regions: cfg.regions, origin: cfg.origin, groups: alertGroups,
        meta: { dateKst, collectedAtKst: kstStr(now), ok, failed, firstRun: !prev, pageUrl, months, today },
      });
      await fs.mkdir(REPORTS_DIR, { recursive: true });
      await fs.writeFile(path.join(REPORTS_DIR, `${dateKst}.md`), report);
      await fs.writeFile(path.join(REPORTS_DIR, 'latest.md'), report);
    }
  }

  const attempted = ok + failed;
  console.log(`done: ${ok}/${attempted} requests ok`);

  if (alertGroups.length) {
    for (const msg of buildAlertMessages(alertGroups, { pageUrl })) {
      await sendTelegram(msg);
      await sleep(process.env.DELAY_MS ? 0 : 1100);
    }
  }
  if (attempted > 0 && failed / attempted > 0.3) {
    await sendTelegram(`⚠️ 보너스 좌석 수집 중 실패가 많았어요 (${failed}/${attempted}).\n예: ${failures.slice(0, 3).join(' / ')}\n대한항공 쪽 차단이나 사이트 변경일 수 있어요.`);
  }
  if (ok === 0 && attempted > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  try { await sendTelegram(`⚠️ 보너스 좌석 수집기 오류: ${e.message}`); } catch {}
  process.exit(1);
});
