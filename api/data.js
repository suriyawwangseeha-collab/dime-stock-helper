// Vercel Serverless Function: GET /api/data
// ดึงราคาปิดรายวันย้อนหลัง ~6 เดือน + ราคาล่าสุด จาก Yahoo Finance
// แล้วจัดรูปให้ทุกตัวใช้วันที่ชุดเดียวกับ SPY (ดัชนีเทียบ)

const SYMBOLS = ['SPY','BND','VT','VOO','SCHD','GLD','QQQ','KO','PG','JNJ','WMT','PEP','BRK-B',
  'MSFT','AAPL','GOOGL','V','JPM','COST','AMZN','META','NVDA','AMD','TSLA','PLTR'];
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

let memo = { t: 0, body: null };          // แคชในหน่วยความจำของ instance
const TTL_MS = 60 * 1000;

async function fetchChart(sym) {
  let lastErr;
  for (const h of HOSTS) {
    try {
      const r = await fetch(`${h}/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d&includePrePost=false`,
        { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res || !res.timestamp) throw new Error('no data');
      return res;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`${sym}: ${lastErr?.message || 'failed'}`);
}

const ymd = (ts, off) => new Date((ts + off) * 1000).toISOString().slice(2, 10).replace(/-/g, '');

function marketState(meta, now) {
  const p = meta?.currentTradingPeriod?.regular;
  if (!p) return 'unknown';
  return now >= p.start && now < p.end ? 'open' : 'closed';
}

async function build() {
  const results = await Promise.allSettled(SYMBOLS.map(fetchChart));
  const ok = {}, errors = [];
  results.forEach((r, i) => r.status === 'fulfilled' ? (ok[SYMBOLS[i]] = r.value) : errors.push(String(r.reason?.message || r.reason)));
  if (!ok.SPY) throw new Error('SPY unavailable: ' + errors.join('; '));

  const spy = ok.SPY, off = spy.meta.gmtoffset || 0;
  const dates = [];
  spy.timestamp.forEach((t, i) => { if (spy.indicators.quote[0].close[i] != null) dates.push(ymd(t, off)); });

  const now = Math.floor(Date.now() / 1000);
  const m = {}, c = {}, live = {};
  for (const [sym, res] of Object.entries(ok)) {
    const o = res.meta.gmtoffset || 0, map = new Map();
    res.timestamp.forEach((t, i) => { const v = res.indicators.quote[0].close[i]; if (v != null) map.set(ymd(t, o), +v.toFixed(2)); });
    let prev = null; const arr = [];
    for (const d of dates) { const v = map.has(d) ? map.get(d) : prev; arr.push(v); if (v != null) prev = v; }
    // เติมค่าว่างช่วงต้น (ถ้ามี) ด้วยค่าแรกที่มี
    const first = arr.find(v => v != null); for (let i = 0; i < arr.length && arr[i] == null; i++) arr[i] = first;
    if (first == null) { errors.push(sym + ': empty'); continue; }
    const mt = res.meta;
    const price = mt.regularMarketPrice ?? arr[arr.length - 1];
    arr[arr.length - 1] = +(+price).toFixed(2);           // ให้จุดสุดท้ายเป็นราคาล่าสุด
    const prevClose = arr.length > 1 ? arr[arr.length - 2] : (mt.chartPreviousClose ?? null);
    m[sym] = [+(+price).toFixed(2), mt.fiftyTwoWeekHigh ?? null, mt.fiftyTwoWeekLow ?? null];
    c[sym] = arr.join(',');
    live[sym] = { price: +(+price).toFixed(2), prevClose, time: mt.regularMarketTime, state: marketState(mt, now) };
  }
  return {
    source: 'Yahoo Finance',
    asof: new Date((spy.meta.regularMarketTime || now) * 1000).toISOString(),
    fetchedAt: new Date().toISOString(),
    market: live.SPY?.state || 'unknown',
    dates: dates.join(','), m, c, live, errors
  };
}

export default async function handler(req, res) {
  try {
    if (!memo.body || Date.now() - memo.t > TTL_MS) {
      memo = { t: Date.now(), body: await build() };
    }
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(memo.body));
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
}
