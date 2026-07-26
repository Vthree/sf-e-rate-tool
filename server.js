const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOST = "127.0.0.1";
const FIRST_PORT = Number(process.env.PORT || 4173);
let port = FIRST_PORT;
const ROOT = __dirname;
const CACHE_MS = 15 * 60 * 1000;

const SOURCES = {
  fuel: "https://htm.sf-express.com/tw/tc/Customer_Zone/download_center/fuel_additional/",
  prices: "https://htm.sf-express.com/tw/tc/Customer_Zone/download_center/price_down/",
  resource: "https://htm.sf-express.com/tw/tc/news/detail/Announcement-on-the-Implementation-of-Peak-Resource-Adjustment-Fee-for-Taiwan-SF-Express-Shipments-to-Mainland-China-Hong-Kong-and-Macau/",
};

let liveCache = { expiresAt: 0, payload: null };

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

  if (url.pathname === "/" || url.pathname === "/index.html") {
    serveFile(response, path.join(ROOT, "index.html"), "text/html; charset=utf-8");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

function onListening() {
  const url = `http://${HOST}:${port}`;
  console.log(`E順遞運費工具已啟動：${url}`);
  console.log("按 Ctrl+C 可停止服務。");

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
