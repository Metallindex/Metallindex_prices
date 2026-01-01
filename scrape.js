// scrape.js
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');

const COINS_FILE = path.join(__dirname, 'coins.json');
const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, 'prices.json');

const USER_AGENT = 'Metallindex Preisreferenz (Kontakt: deine.email@domain.tld)';

function normalizeNumberString(s) {
    if (!s || typeof s !== 'string') return null;
    // zuerst mögliche € entfernen
    s = s.replace(/\u202f/g, '').replace(/\s+/g, ' ').trim();
    // Suche nach erstes numerisches Muster wie 1.234,56 oder 1234,56 oder 1 234,56
    const m = s.match(/(\d{1,3}(?:[.\s]\d{3})*(?:[\,\.]\d+)?)/);
    if (!m) return null;
    let num = m[1];
    // Entferne Tausender-Trenner (Punkte oder Spaces), ersetze Komma durch Punkt
    num = num.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
    const v = parseFloat(num);
    return Number.isFinite(v) ? v : null;
}

async function trySelector(page, selector) {
    try {
        await page.waitForSelector(selector, { timeout: 5000 });
        const txt = await page.$eval(selector, el => (el.innerText || el.textContent || '').trim());
        const v = normalizeNumberString(txt);
        return v;
    } catch (err) {
        return null;
    }
}

async function tryJSONLD(page) {
    try {
        const data = await page.$$eval('script[type="application/ld+json"]', els => els.map(e => e.innerText));
        for (const txt of data) {
            try {
                const parsed = JSON.parse(txt);
                // parsed can be array or object
                const arr = Array.isArray(parsed) ? parsed : [parsed];
                for (const item of arr) {
                    if (item && item.offers) {
                        const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
                        if (offer && (offer.price || offer.priceSpecification)) {
                            const price = offer.price || (offer.priceSpecification && offer.priceSpecification.price);
                            if (price) return Number(price);
                        }
                    }
                }
            } catch (e) {
                // ignore JSON parse errors
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function tryMeta(page) {
    try {
        const metas = await page.$$eval('meta', ms => ms.map(m => ({ name: m.getAttribute('name') || m.getAttribute('property'), content: m.getAttribute('content') })));
        for (const m of metas) {
            if (!m || !m.name || !m.content) continue;
            const low = (m.name || '').toLowerCase();
            if (low.includes('price') || low.includes('og:price') || low.includes('product:price:amount')) {
                const v = normalizeNumberString(m.content);
                if (v !== null) return v;
            }
            // sometimes price in twitter:data or other
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function tryHeuristic(page) {
    try {
        // runs inside browser
        const found = await page.evaluate(() => {
            const keywords = ['ankauf', 'ankaufspreis', 'ankaufs', 'kaufpreis', 'ankaufswert'];
            function findNumberInText(text) {
                const re = /(\d{1,3}(?:[\.\s]\d{3})*(?:[\,\.]\d+)?)/;
                const m = text.match(re);
                return m ? m[0] : null;
            }
            // search elements that contain a euro sign or the keywords
            const els = Array.from(document.querySelectorAll('body *'));
            for (const el of els) {
                const t = (el.innerText || '').trim();
                if (!t) continue;
                const low = t.toLowerCase();
                for (const kw of keywords) {
                    if (low.includes(kw)) {
                        const num = findNumberInText(t);
                        if (num) return num;
                    }
                }
            }
            // fallback: find first element with € and a number
            for (const el of els) {
                const t = (el.innerText || '').trim();
                if (!t) continue;
                if (t.indexOf('€') !== -1) {
                    const num = findNumberInText(t);
                    if (num) return num;
                }
            }
            return null;
        });

        if (!found) return null;
        return normalizeNumberString(found);
    } catch (err) {
        return null;
    }
}

(async () => {
    try {
        console.log('Loading coins.json ...');
        const raw = await fs.readFile(COINS_FILE, 'utf8');
        const coins = JSON.parse(raw);

        console.log('Launching browser...');
        const browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: 1200, height: 900 });

        const results = [];

        for (const coin of coins) {
            console.log(`Processing ${coin.id} — ${coin.name}`);
            let price = null;
            let notes = [];

            try {
                await page.goto(coin.url, { waitUntil: 'networkidle2', timeout: 30000 });
            } catch (err) {
                notes.push('page-load-failed: ' + (err.message || err));
            }

            // 1) explicit selector (if provided)
            if (coin.selector && coin.selector.trim()) {
                const p = await trySelector(page, coin.selector);
                if (p !== null) {
                    price = p;
                    notes.push('selector');
                } else {
                    notes.push('selector-not-found');
                }
            }

            // 2) JSON-LD
            if (price === null) {
                const p = await tryJSONLD(page);
                if (p !== null) {
                    price = p;
                    notes.push('json-ld');
                }
            }

            // 3) meta tags
            if (price === null) {
                const p = await tryMeta(page);
                if (p !== null) {
                    price = p;
                    notes.push('meta');
                }
            }

            // 4) heuristic search
            if (price === null) {
                const p = await tryHeuristic(page);
                if (p !== null) {
                    price = p;
                    notes.push('heuristic');
                } else {
                    notes.push('not-found');
                }
            }

            // polite delay
            await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 800)));

            results.push({
                id: coin.id,
                name: coin.name,
                url: coin.url,
                metal: coin.metal || null,
                fineInGrams: coin.fineInGrams || null,
                price_eur: price,
                ok: price !== null,
                notes: notes
            });
        }

        await browser.close();

        const out = {
            source: 'philoro.at',
            generated_at: (new Date()).toISOString(),
            items: results
        };

        await fs.mkdir(OUT_DIR, { recursive: true });
        await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
        console.log('Wrote', OUT_FILE);
        process.exit(0);
    } catch (err) {
        console.error('Fatal', err);
        process.exit(2);
    }
})();
