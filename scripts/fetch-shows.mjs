// 每天自動抓「今天的表演時間」，輸出成 shows.json（給 Apps Script 讀）
// 1) 先用真正的瀏覽器開 USJ 官網時刻表頁（JavaScript 會執行，所以讀得到內容）
// 2) 官網讀不到或日期不是今天，改讀「ユニバリアル」每日更新頁
// 都失敗就不動 shows.json（保留上一份），並以失敗結束，讓你在 Actions 頁面看得到紅燈。
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const OUT = opt('out', 'shows.json');
const OFFICIAL = opt('official', 'https://www.usj.co.jp/web/ja/jp/attractions/show-and-attraction-schedule');
const FALLBACK = opt('fallback', 'https://usjreal.asumirai.info/show/usj-show-realtime.html');
const TODAY = opt('date', new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10));   // 日本時間的今天

const TIME_RE = /\d{1,2}:\d{2}|休演|休止中|随時運行/;
const SYMBOLS_RE = /^[〜～~\-から・＆&™®\s]+$/;

// 把文字行解析成 [{name, text}]：支援「名稱 時間…」同一行，或名稱一行、時間在後面幾行
export function parseEntries(lines) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.name && cur.tokens.length) out.push({ name: cur.name, text: cur.tokens.join(' ') }); cur = null; };
  for (const raw of lines) {
    const s = raw.replace(/^[-*•・]\s*/, '').replace(/^\d+\.\s*/, '').replace(/開始\s*\d{1,2}:\d{2}/g, '').trim();
    if (!s || /^\d+\.?$/.test(s)) continue;
    const m = s.match(TIME_RE);
    if (!m) {
      if (SYMBOLS_RE.test(s) && cur) { if (cur.tokens.length) cur.tokens.push(s); else { cur.name += s; if (/[＆&]/.test(s)) cur.joiner = true; } continue; }
      if (cur && cur.joiner && !cur.tokens.length) { cur.name += ' ' + s; cur.joiner = false; continue; }
      flush(); cur = { name: s, tokens: [], joiner: false };
      continue;
    }
    const namePart = s.slice(0, m.index).trim();
    const rest = s.slice(m.index);
    if (namePart && !SYMBOLS_RE.test(namePart)) {
      if (cur && cur.joiner && !cur.tokens.length) { cur.name += ' ' + namePart; cur.joiner = false; cur.tokens.push(rest); }
      else { flush(); cur = { name: namePart, tokens: [rest], joiner: false }; }
    } else if (cur) cur.tokens.push(s);
  }
  flush();
  return out;
}

const ymd = (m) => `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
const DATE_ONLY_RE = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*[（(][日月火水木金土][）)])?$/;

// 官網（渲染後的文字）：日期標題 → 「時刻表」區段 → 「運行時間」區段
export function parseOfficialText(text, today) {
  const lines = text.split('\n').map((s) => s.replace(/[\u00a0\u3000]/g, ' ').trim()).filter(Boolean);
  const dates = lines.map((l) => l.match(DATE_ONLY_RE)).filter(Boolean).map(ymd);
  if (!dates.includes(today)) return { error: `官網頁面的日期不是今天（找到：${dates.slice(0, 3).join(', ') || '沒有日期'}）` };
  const iShow = lines.findIndex((l) => /^時刻表$/.test(l));
  const iOp = lines.findIndex((l) => /^運行時間$/.test(l));
  if (iShow < 0) return { error: '官網頁面找不到「時刻表」區段' };
  const endShow = iOp > iShow ? iOp : lines.length;
  const stop = lines.findIndex((l, i) => i > Math.max(iOp, iShow) && /休止情報|お知らせ|Copyright|©|ご来場前に/.test(l));
  const shows = parseEntries(lines.slice(iShow + 1, endShow));
  const operations = iOp >= 0 ? parseEntries(lines.slice(iOp + 1, stop > 0 ? stop : lines.length)).filter((e) => /随時運行|[〜～]/.test(e.text)) : [];
  if (shows.length < 5) return { error: `官網只解析到 ${shows.length} 個表演（頁面格式可能改了）` };
  return { shows, operations };
}

// 「ユニバリアル」每日更新頁
export function parseFallbackText(text, today) {
  const lines = text.split('\n').map((s) => s.replace(/[\u00a0\u3000]/g, ' ').trim()).filter(Boolean);
  const SEC = /^(?:ユニバ\s*)?(?:期間限定！?イベント|人気のショー|ショー運営状況)$/;
  const first = lines.findIndex((l) => SEC.test(l));
  if (first < 0) return { error: '備援頁面找不到表演區段' };
  let heading = '';
  for (let i = first - 1; i >= Math.max(0, first - 8); i--) {
    const m = lines[i].match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m && /[（(][日月火水木金土][）)]/.test(lines[i])) { heading = ymd(m); break; }
  }
  if (heading !== today) return { error: `備援頁面的日期不是今天（${heading || '找不到'}）` };
  const endRel = lines.slice(first + 1).findIndex((l) => /今日のショー時刻表はこちら|待ち時間ショートカット|休止のショー/.test(l));
  const region = lines.slice(first + 1, endRel >= 0 ? first + 1 + endRel : lines.length).filter((l) => !/^(?:ユニバ\s*)?(?:期間限定|人気のショー|ショー運営状況)/.test(l));
  const shows = parseEntries(region);
  if (shows.length < 5) return { error: `備援頁面只解析到 ${shows.length} 個表演` };
  return { shows, operations: [] };
}

async function pageText(browser, url, readyText) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja,zh-TW;q=0.8,en;q=0.6' });
    const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
    if (readyText) await page.waitForFunction((t) => document.body && document.body.innerText.includes(t), { timeout: 25000 }, readyText);
    return await page.evaluate(() => document.body.innerText);
  } finally { await page.close(); }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  let result = null, source = '';
  const problems = [];
  try {
    try { const r = parseOfficialText(await pageText(browser, OFFICIAL, '時刻表'), TODAY); if (r.error) problems.push('官網：' + r.error); else { result = r; source = 'official'; } }
    catch (e) { problems.push('官網：' + String(e.message || e).slice(0, 120)); }
    if (!result) {
      try { const r = parseFallbackText(await pageText(browser, FALLBACK, 'ショー'), TODAY); if (r.error) problems.push('備援：' + r.error); else { result = r; source = 'usjreal'; } }
      catch (e) { problems.push('備援：' + String(e.message || e).slice(0, 120)); }
    }
  } finally { await browser.close(); }
  if (!result) { console.error('抓取失敗，不更新 ' + OUT + '：\n - ' + problems.join('\n - ')); process.exit(1); }
  const next = { date: TODAY, fetched_at: new Date().toISOString(), source, shows: result.shows, operations: result.operations };
  let changed = true;
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    changed = JSON.stringify([prev.date, prev.source, prev.shows, prev.operations]) !== JSON.stringify([next.date, next.source, next.shows, next.operations]);
  } catch (e) { /* 第一次執行：沒有舊檔 */ }
  if (changed) { fs.writeFileSync(OUT, JSON.stringify(next, null, 2) + '\n'); console.log(`已更新 ${OUT}（來源：${source}，表演 ${next.shows.length} 個，運行時間 ${next.operations.length} 個）`); }
  else console.log('內容沒有變，不改檔案');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
