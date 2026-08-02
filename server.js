const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOST = "127.0.0.1";
const FIRST_PORT = Number(process.env.PORT || 4173);
let port = FIRST_PORT;
const ROOT = __dirname;
const CACHE_MS = 15 * 60 * 1000;
const RMB_CACHE_MS = 6 * 60 * 60 * 1000;
const RMB_RETRY_CACHE_MS = 10 * 60 * 1000;
const SF_PRICE_ENDPOINT = "https://htm.sf-express.com/sf-service-core-web/service/product/psds/freightPrice/query";

const RMB_ROUTES = {
  A: {
    label: "A區（廣州海珠代表）",
    dest: "A440105000",
    destCityCode: "020",
  },
  B: {
    label: "B區（北京東城代表）",
    dest: "A110101000",
    destCityCode: "010",
  },
};

const SOURCES = {
  fuel: "https://htm.sf-express.com/tw/tc/Customer_Zone/download_center/fuel_additional/",
  prices: "https://htm.sf-express.com/tw/tc/Customer_Zone/download_center/price_down/",
  resource: "https://htm.sf-express.com/tw/tc/news/detail/Announcement-on-the-Implementation-of-Peak-Resource-Adjustment-Fee-for-Taiwan-SF-Express-Shipments-to-Mainland-China-Hong-Kong-and-Macau/",
};

let liveCache = { expiresAt: 0, payload: null };
const rmbCache = new Map();

function stripHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&ndash;|&#8211;/gi, "-")
    .replace(/&mdash;|&#8212;/gi, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function taipeiDateParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function dateNumber(year, month, day) {
  return Number(year) * 10000 + Number(month) * 100 + Number(day);
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseFuelPage(html) {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => stripHtml(match[1]))
    .map((text) => {
      const period = text.match(/(20\d{2})\/(\d{1,2})\/(\d{1,2})\s*[-~～至]\s*(20\d{2})\/(\d{1,2})\/(\d{1,2})/);
      const percentages = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]));
      if (!period || percentages.length === 0) return null;
      return {
        period: `${period[1]}/${Number(period[2])}/${Number(period[3])}-${period[4]}/${Number(period[5])}/${Number(period[6])}`,
        start: dateNumber(period[1], period[2], period[3]),
        end: dateNumber(period[4], period[5], period[6]),
        startDate: isoDate(period[1], period[2], period[3]),
        endDate: isoDate(period[4], period[5], period[6]),
        rate: percentages[0],
      };
    })
    .filter(Boolean);

  if (!rows.length) throw new Error("官網燃油費表格式無法辨識");

  const today = taipeiDateParts();
  const todayNumber = dateNumber(today.year, today.month, today.day);
  const current = rows.find((row) => todayNumber >= row.start && todayNumber <= row.end) || rows[0];
  return {
    rate: current.rate,
    period: current.period,
    schedule: rows.map(({ period, startDate, endDate, rate }) => ({ period, startDate, endDate, rate })),
  };
}

function parsePriceSource(html) {
  const row = html.match(/<tr\b[^>]*>[\s\S]*?href=["'][^"']*Taiwan-Export-Rates-EC-Ship-Personal-Shipment[^"']*\.pdf["'][\s\S]*?<\/tr>/i);
  if (!row) throw new Error("找不到 E順遞官方價目表");

  const hrefMatch = row[0].match(/href=["']([^"']*Taiwan-Export-Rates-EC-Ship-Personal-Shipment[^"']*\.pdf)["']/i);
  const dateMatch = stripHtml(row[0]).match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  const href = hrefMatch ? new URL(hrefMatch[1], SOURCES.prices).href : null;
  const fileDateMatch = href ? href.match(/(20\d{2})(\d{2})(\d{2})/) : null;
  const effectiveDate = dateMatch
    ? `${dateMatch[1]}年${Number(dateMatch[2])}月${Number(dateMatch[3])}日`
    : fileDateMatch
      ? `${fileDateMatch[1]}年${Number(fileDateMatch[2])}月${Number(fileDateMatch[3])}日`
      : "未辨識";
  return {
    effectiveDate,
    pdfUrl: href,
    expected: href ? href.includes("20250401") : false,
  };
}

function parseResourceFee(html) {
  const text = stripHtml(html);
  const match = text.match(/TWD\s*([\d,.]+)\s*\/\s*KG/i);
  if (!match) throw new Error("找不到資源調節費");
  return { perKg: Number(match[1].replace(/,/g, "")) };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept-language": "zh-TW,zh;q=0.9,en;q=0.7",
      "user-agent": "Mozilla/5.0 SF-E-Rate-Tool/1.0",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-TW,zh;q=0.9,en;q=0.7",
      referer: "https://htm.sf-express.com/we/ow/#/tw/tc/price-query",
      "user-agent": "Mozilla/5.0 SF-E-Rate-Tool/1.3.2",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function normalizeShippingTime(value) {
  const match = String(value || "").match(/^(20\d{2})-(\d{2})-(\d{2})[T ](\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:00:00`;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = values.hour === "24" ? "00" : values.hour;
  return `${values.year}-${values.month}-${values.day} ${hour}:00:00`;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function fetchOfficialRmbRate(zone, weight, shippingTime) {
  const route = RMB_ROUTES[zone];
  const params = new URLSearchParams({
    label: "1",
    origin: "A000710900",
    dest: route.dest,
    originCityCode: "886",
    destCityCode: route.destCityCode,
    srcZoneCode: "",
    destZoneCode: "",
    weight: String(weight),
    weightUnit: "kg",
    postcode: "",
    time: shippingTime,
    width: "1",
    height: "1",
    length: "1",
    lengthUnit: "",
    lang: "tc",
    region: "tw",
    translate: "",
    commodityName: "",
    orderCount: "1",
    destPostcode: "",
    payMethod: "2",
    paymentCountry: "CN",
  });

  const data = await fetchJson(`${SF_PRICE_ENDPOINT}?${params}`);
  if (!data || data.code !== 0) throw new Error(data?.message || "順豐查價失敗");

  const products = data.result?.productFreightPrices || [];
  const product = products.find((item) => item.productCode === "EC-Ship")
    || products.find((item) => item.productDisplayName === "E順遞");
  if (!product) throw new Error("此路線沒有 E順遞到付價");

  const items = product.freightPriceItemList || [];
  const fuelItem = items.find((item) => item.code === "IN15" || /燃油/.test(item.name || ""));
  const resourceItem = items.find((item) => item.code === "IN104" || /資源|調節/.test(item.name || ""));
  const result = {
    base: numberOrNull(product.freight),
    fuel: numberOrNull(fuelItem?.price ?? product.fuelFreight),
    resource: numberOrNull(resourceItem?.price ?? 0),
    total: numberOrNull(product.totalFreight),
    chargedWeight: numberOrNull(product.weight),
    currency: product.currencyCode,
  };
  if ([result.base, result.fuel, result.resource, result.total].some((item) => item === null)) {
    throw new Error("順豐回傳的 E順遞拆價不完整");
  }
  if (result.currency !== "CNY") throw new Error(`預期 CNY，實際為 ${result.currency || "未知"}`);
  return result;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function getOfficialRmbRates(shippingDateTime, force = false) {
  const shippingTime = normalizeShippingTime(shippingDateTime);
  const cacheKey = shippingTime;
  const cached = rmbCache.get(cacheKey);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.payload;

  const jobs = [];
  for (const zone of Object.keys(RMB_ROUTES)) {
    for (let index = 1; index <= 40; index += 1) {
      jobs.push({ zone, weight: index / 2 });
    }
  }

  const rates = { A: {}, B: {} };
  const errors = [];
  await mapWithConcurrency(jobs, 4, async ({ zone, weight }) => {
    try {
      rates[zone][weight.toFixed(1)] = await fetchOfficialRmbRate(zone, weight, shippingTime);
    } catch (error) {
      errors.push(`${zone}區 ${weight.toFixed(1)}kg：${error.message}`);
    }
  });

  const count = Object.values(rates).reduce((sum, zoneRates) => sum + Object.keys(zoneRates).length, 0);
  const payload = {
    ok: count === jobs.length,
    checkedAt: new Date().toISOString(),
    shippingTime,
    count,
    expectedCount: jobs.length,
    routes: RMB_ROUTES,
    rates,
    source: SF_PRICE_ENDPOINT,
    errors: errors.slice(0, 12),
  };
  rmbCache.set(cacheKey, {
    payload,
    expiresAt: Date.now() + (payload.ok ? RMB_CACHE_MS : RMB_RETRY_CACHE_MS),
  });
  return payload;
}

async function getLiveRates(force = false) {
  if (!force && liveCache.payload && Date.now() < liveCache.expiresAt) return liveCache.payload;

  const [fuelResult, priceResult, resourceResult] = await Promise.allSettled([
    fetchText(SOURCES.fuel).then(parseFuelPage),
    fetchText(SOURCES.prices).then(parsePriceSource),
    fetchText(SOURCES.resource).then(parseResourceFee),
  ]);

  const errors = [];
  if (fuelResult.status === "rejected") errors.push(`燃油費：${fuelResult.reason.message}`);
  if (priceResult.status === "rejected") errors.push(`價目表：${priceResult.reason.message}`);
  if (resourceResult.status === "rejected") errors.push(`調節費：${resourceResult.reason.message}`);

  const payload = {
    ok: fuelResult.status === "fulfilled",
    checkedAt: new Date().toISOString(),
    fuel: fuelResult.status === "fulfilled" ? fuelResult.value : null,
    baseSource: priceResult.status === "fulfilled" ? priceResult.value : null,
    resource: resourceResult.status === "fulfilled" ? resourceResult.value : null,
    sources: SOURCES,
    errors,
  };

  liveCache = { payload, expiresAt: Date.now() + CACHE_MS };
  return payload;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function serveFile(response, filePath, contentType) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${HOST}`);

  if (url.pathname === "/api/live-rates") {
    try {
      sendJson(response, 200, await getLiveRates(url.searchParams.get("force") === "1"));
    } catch (error) {
      sendJson(response, 500, { ok: false, errors: [error.message] });
    }
    return;
  }

  if (url.pathname === "/api/rmb-rates") {
    try {
      const payload = await getOfficialRmbRates(
        url.searchParams.get("shippingDateTime"),
        url.searchParams.get("force") === "1",
      );
      sendJson(response, payload.count ? 200 : 502, payload);
    } catch (error) {
      sendJson(response, 500, { ok: false, errors: [error.message] });
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    serveFile(response, path.join(ROOT, "index.html"), "text/html; charset=utf-8");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

function onListening() {
  const url = `http://${HOST}:${port}`;
  console.log(`SF E-Ship rate tool started: ${url}`);
  console.log("Press Ctrl+C to stop the server.");

  if (process.env.OPEN_BROWSER !== "0") {
    const browserCommand = process.platform === "win32"
      ? { command: "cmd.exe", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { command: "open", args: [url] }
        : null;

    if (browserCommand) {
      const child = spawn(browserCommand.command, browserCommand.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    }
  }
}

function listen() {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && port < FIRST_PORT + 20) {
      port += 1;
      listen();
      return;
    }
    throw error;
  });
  server.listen(port, HOST, onListening);
}

listen();
