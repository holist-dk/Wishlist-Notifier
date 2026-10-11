'use strict';

const STEAM_ID       = process.env.STEAM_ID;
const STEAM_API_KEY  = process.env.STEAM_API_KEY;
const NTFY_TOPIC     = process.env.NTFY_TOPIC;
const MAX_PRICE_PKR  = parseFloat(process.env.MAX_PRICE_PKR || '5000');

let cachedRate = null;

async function getPkrRate() {
  if (cachedRate) return cachedRate;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    cachedRate = j?.rates?.PKR || 278.5;
  } catch {
    cachedRate = 278.5;
  }
  return cachedRate;
}

async function fetchWishlist() {
  const url = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?key=${STEAM_API_KEY}&steamid=${STEAM_ID}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'WishlistBot/1.0' } });
  const j = await r.json();
  return j?.response?.items || [];
}

async function fetchPrice(appId, rate) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=pk&filters=basic,price_overview`;
    const r = await fetch(url, { headers: { 'User-Agent': 'WishlistBot/1.0' } });
    const j = await r.json();
    const info = j?.[appId];
    if (!info?.success || !info?.data?.price_overview) return null;

    const p = info.data.price_overview;
    const isPkr = p.currency === 'PKR';
    const saleNum = p.final / 100;
    const origNum = p.initial / 100;
    const salePKR = isPkr ? Math.round(saleNum) : Math.round(saleNum * rate);
    const origPKR = isPkr ? Math.round(origNum) : Math.round(origNum * rate);

    const fmt = (n, pkr) => isPkr ? `${pkr} pkr` : `${n.toFixed(2)}usd (${pkr} pkr)`;

    return {
      appId,
      name: info.data.name || `App ${appId}`,
      discount: p.discount_percent,
      salePKR,
      formattedPrice: fmt(saleNum, salePKR),
      formattedOriginalPrice: fmt(origNum, origPKR),
      storeUrl: `https://store.steampowered.com/app/${appId}`,
    };
  } catch {
    return null;
  }
}

async function sendNtfy(game) {
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      Title: `${game.name} is on sale! ${game.discount}% off`,
      Click: game.storeUrl,
      Tags: 'steam,gaming,sale',
      Priority: 'high',
    },
    body: `${game.formattedOriginalPrice} -> ${game.formattedPrice}\nTap to open Steam store`,
  });
}

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const items = await fetchWishlist();
    if (items.length === 0) return res.status(200).json({ checked: 0, notified: 0 });

    const rate = await getPkrRate();
    const results = await Promise.all(items.map(i => fetchPrice(i.appid, rate)));

    const sales = results.filter(g => g && g.discount > 0 && g.salePKR <= MAX_PRICE_PKR);
    for (const game of sales) await sendNtfy(game);

    console.log(`Checked ${items.length}, notified ${sales.length}`);
    return res.status(200).json({ checked: items.length, notified: sales.length });
  } catch (err) {
    console.error('WishlistNotifier error:', err);
    return res.status(500).json({ error: err.message });
  }
};
