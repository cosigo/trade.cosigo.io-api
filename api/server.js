const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3012);
const DATA_DIR = process.env.TRADE_REQUESTS_DIR || '/srv/data/trade-requests';
const ADMIN_KEY = process.env.TRADE_ADMIN_KEY || '';
const BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/';

const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TROY_OUNCE_MG = 31103.4768;

const CIGO_TOKEN_ADDRESS = '0x3a38e963f524E0dDFB75dFa1752b4Cd1364F5560';
const CIGO_CUSTODIAN_ADDRESS = '0x2B1B5E58C096d4ab402FEfBaa65f2b1Ddc399399';
const CIGO_TREASURY_ADDRESS = '0x8215C297A3303449787cCA34bBAed1DF929Fd2a9';
const CIGO_DECIMALS = 18;

const TRADE_NOTIFY_URL = 'https://contact.cosigo.io/api/mail.php';
const TRADE_NOTIFY_NAME = 'trade.cosigo.io notifier';
const TRADE_NOTIFY_EMAIL = process.env.TRADE_NOTIFY_EMAIL || 'admin@cosigo.io';

const DEFAULT_SETTINGS = {
  ozUsdReference: 100,
  digitalExitFeeRate: 0.015,
  physicalRedemptionFeeRate: 0.25,

  cigoUsdReference: 0.01,
  cigoInboundHaircutRate: 0.10,
  cigoOutboundPremiumRate: 0.05,

  inventoryCigo: 210000,
  depthFactor: 0.25,

  usdtDailyWalletCap: 1000,

  version: 1,
  updatedAt: null
};

async function sendTradeSubmittedEmail(record) {
  const form = new URLSearchParams();

  form.set('_gotcha', '');
  form.set('_redirect', 'https://trade.cosigo.io/admin.html');
  form.set('site', 'trade.cosigo.io');
  form.set('page', `request:${record.id}`);
  form.set('subject', `[trade.cosigo.io] submitted request ${record.id}`);
  form.set('name', TRADE_NOTIFY_NAME);
  form.set('email', TRADE_NOTIFY_EMAIL);
  form.set(
    'message',
    [
      'A new trade request is waiting for review.',
      '',
      `Request ID: ${record.id}`,
      `Status: ${record.status}`,
      `Wallet: ${record.wallet}`,
      `Route: ${record.route}`,
      `Input: ${record.inputAmount} ${record.fromAsset}`,
      `Output: ${record.outputAmount} ${record.toAsset}`,
      `Estimated value: $${record.basisValue ?? 0}`,
      `Created: ${record.createdAt || '-'}`,
      `Submitted: ${record.submittedAt || record.updatedAt || '-'}`,
      '',
      'Open admin queue and review this request.'
    ].join('\n')
  );

  const response = await fetch(TRADE_NOTIFY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (!response.ok) {
    throw new Error(`mail.php failed (${response.status})`);
  }
}

const VALID_ASSETS = new Set(['BNB', 'CIGO', 'USDT', 'COSIGO']);

const INTERNAL_ROUTES = new Set([
  'CIGO:USDT',
  'USDT:CIGO',
  'USDT:COSIGO',
  'COSIGO:USDT',
  'CIGO:COSIGO',
  'COSIGO:CIGO',
]);

const STATUS_FLOW = {
  draft: ['submitted'],
  submitted: ['reviewed'],
  reviewed: ['completed'],
  completed: [],
};

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: message });
}

function makeRequestId() {
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function isEthAddress(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function cleanString(value, fieldName) {
  const out = String(value ?? '').trim();
  if (!out) throw new Error(`${fieldName} is required`);
  return out;
}

function cleanPositiveAmount(value, fieldName) {
  const out = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(out)) {
    throw new Error(`${fieldName} must be a positive numeric string`);
  }
  if (Number(out) <= 0) {
    throw new Error(`${fieldName} must be greater than zero`);
  }
  return out;
}

function cleanNonNegativeAmount(value, fieldName) {
  const out = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(out)) {
    throw new Error(`${fieldName} must be a numeric string`);
  }
  if (Number(out) < 0) {
    throw new Error(`${fieldName} must not be negative`);
  }
  return out;
}

function cleanOptionalString(value, maxLen = 500) {
  const out = String(value ?? '').trim();
  return out.slice(0, maxLen);
}

function cleanSettlementPayload(body, record) {
  const settlementAsset = cleanString(
    body.settlementAsset ?? record.fromAsset,
    'settlementAsset'
  ).toUpperCase();

  if (!VALID_ASSETS.has(settlementAsset)) {
    throw new Error('Invalid settlementAsset');
  }

  if (settlementAsset !== record.fromAsset) {
    throw new Error(`settlementAsset must match request fromAsset (${record.fromAsset})`);
  }

  const settlementAmount = cleanPositiveAmount(
    body.settlementAmount ?? record.inputAmount,
    'settlementAmount'
  );

  const settlementNetwork = cleanString(
    body.settlementNetwork ?? 'BNB Smart Chain',
    'settlementNetwork'
  );

  const settlementAddress = cleanString(body.settlementAddress, 'settlementAddress');
  if (!isEthAddress(settlementAddress)) {
    throw new Error('settlementAddress must be a full 0x address');
  }

  const settlementNote = cleanOptionalString(body.settlementNote, 500);
  const settlementWindow = cleanOptionalString(body.settlementWindow, 200);

  return {
    asset: settlementAsset,
    amount: settlementAmount,
    network: settlementNetwork,
    address: settlementAddress,
    note: settlementNote,
    window: settlementWindow,
    assignedAt: nowIso(),
    assignedBy: 'admin',
  };
}

function cleanNumber(value, fieldName, min = 0) {
  const out = Number(value);
  if (!Number.isFinite(out)) {
    throw new Error(`${fieldName} must be numeric`);
  }
  if (out < min) {
    throw new Error(`${fieldName} must be >= ${min}`);
  }
  return out;
}

function getRouteType(fromAsset, toAsset) {
  if (fromAsset === 'BNB' || toAsset === 'BNB') return 'external_market';
  if (INTERNAL_ROUTES.has(`${fromAsset}:${toAsset}`)) return 'internal';
  return 'unsupported';
}

function isAdmin(req) {
  return Boolean(ADMIN_KEY) && req.headers['x-trade-admin-key'] === ADMIN_KEY;
}

async function writeJsonAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

async function ensureDataLayout() {
  await fs.mkdir(path.join(DATA_DIR, 'history'), { recursive: true });

  try {
    await fs.access(INDEX_FILE);
  } catch {
    await writeJsonAtomic(INDEX_FILE, {});
  }

  await ensureSettingsFile();
}

async function loadIndex() {
  try {
    const raw = await fs.readFile(INDEX_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function ensureSettingsFile() {
  try {
    await fs.access(SETTINGS_FILE);
  } catch {
    const initial = {
      ...DEFAULT_SETTINGS,
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(SETTINGS_FILE, initial);
  }
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      updatedAt: nowIso(),
    };
  }
}

function buildSettingsPayload(settings) {
  return {
    ozUsdReference: Number(settings.ozUsdReference),
    cigoUsdReference: Number(settings.cigoUsdReference || 0.01),
    cigoInboundHaircutRate: Number(settings.cigoInboundHaircutRate || 0),
    cigoOutboundPremiumRate: Number(settings.cigoOutboundPremiumRate || 0),
    cigoSellBasis: getCigoSellBasis(settings),
    cigoBuyBasis: getCigoBuyBasis(settings),
    cosigoUsdBasis: getCosigoUsdBasis(settings.ozUsdReference),
    usdtUsdBasis: 1,
    digitalExitFeeRate: Number(settings.digitalExitFeeRate || 0),
    physicalRedemptionFeeRate: Number(settings.physicalRedemptionFeeRate || 0),
    inventoryCigo: Number(settings.inventoryCigo || 0),
    depthFactor: Number(settings.depthFactor || 0),
    usdtDailyWalletCap: Number(settings.usdtDailyWalletCap || 0),
    version: Number(settings.version || 1),
    updatedAt: settings.updatedAt || null,
  };
}

function getCosigoUsdBasis(ozUsdReference) {
  return Number(ozUsdReference) / TROY_OUNCE_MG;
}

function getCigoSellBasis(settings) {
  return Number(settings.cigoUsdReference || 0.01) *
    (1 - Number(settings.cigoInboundHaircutRate || 0));
}

function getCigoBuyBasis(settings) {
  return Number(settings.cigoUsdReference || 0.01) *
    (1 + Number(settings.cigoOutboundPremiumRate || 0));
}

function getCigoInboundBasis(settings) {
  return Number(settings.cigoUsdReference || 0.01) *
    (1 - Number(settings.cigoInboundHaircutRate || 0));
}

function getCigoOutboundBasis(settings) {
  return Number(settings.cigoUsdReference || 0.01) *
    (1 + Number(settings.cigoOutboundPremiumRate || 0));
}

function getUsdBasis(asset, settings) {
  if (asset === 'USDT') return 1;
  if (asset === 'CIGO') return 0.01;
  if (asset === 'COSIGO') return getCosigoUsdBasis(settings.ozUsdReference);
  return null;
}

function getPricingPolicy(fromAsset, toAsset, settings) {
  if (fromAsset === 'USDT' && toAsset === 'COSIGO') {
    return { type: 'usdt_to_cosigo', feeRate: 0 };
  }

  if (fromAsset === 'COSIGO' && toAsset === 'USDT') {
    return {
      type: 'cosigo_to_usdt',
      feeRate: Number(settings.digitalExitFeeRate || 0)
    };
  }

  if (fromAsset === 'USDT' && toAsset === 'CIGO') {
    return { type: 'usdt_to_cigo', feeRate: 0 };
  }

  if (fromAsset === 'CIGO' && toAsset === 'USDT') {
    return { type: 'cigo_to_usdt', feeRate: 0 };
  }

  if (fromAsset === 'CIGO' && toAsset === 'COSIGO') {
    return { type: 'cigo_to_cosigo', feeRate: 0 };
  }

  if (fromAsset === 'COSIGO' && toAsset === 'CIGO') {
    return {
      type: 'cosigo_to_cigo',
      feeRate: Number(settings.digitalExitFeeRate || 0)
    };
  }

  return { type: 'unsupported', feeRate: 0 };
}

function formatAmount(value, digits = 18) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error('Invalid numeric value');
  }

  return num.toFixed(digits).replace(/\.?0+$/, '');
}

function quoteRoute(fromAsset, toAsset, inputAmount, settings) {
  const inputNum = Number(inputAmount);
  if (!Number.isFinite(inputNum) || inputNum <= 0) {
    throw new Error('inputAmount must be greater than zero');
  }

  const pricing = getPricingPolicy(fromAsset, toAsset, settings);
  if (pricing.type === 'unsupported') {
    throw new Error('Unsupported route');
  }

  const cosigoUsdBasis = getCosigoUsdBasis(settings.ozUsdReference);
  const cigoUsdReference = Number(settings.cigoUsdReference || 0.01);
  const cigoSellBasis = getCigoSellBasis(settings);
  const cigoBuyBasis = getCigoBuyBasis(settings);
  const cosigoExitFeeRate = Number(settings.digitalExitFeeRate || 0);

  let grossUsdValue = 0;
  let feeUsdValue = 0;
  let netUsdValue = 0;
  let outputAmountNum = 0;

  if (pricing.type === 'usdt_to_cosigo') {
    grossUsdValue = inputNum;
    feeUsdValue = 0;
    netUsdValue = grossUsdValue;
    outputAmountNum = netUsdValue / cosigoUsdBasis;
  } else if (pricing.type === 'cosigo_to_usdt') {
    grossUsdValue = inputNum * cosigoUsdBasis;
    feeUsdValue = grossUsdValue * cosigoExitFeeRate;
    netUsdValue = grossUsdValue - feeUsdValue;
    outputAmountNum = netUsdValue;
  } else if (pricing.type === 'usdt_to_cigo') {
    grossUsdValue = inputNum;
    feeUsdValue = 0;
    netUsdValue = grossUsdValue;
    outputAmountNum = netUsdValue / cigoBuyBasis;
  } else if (pricing.type === 'cigo_to_usdt') {
    grossUsdValue = inputNum * cigoSellBasis;
    feeUsdValue = 0;
    netUsdValue = grossUsdValue;
    outputAmountNum = netUsdValue;
  } else if (pricing.type === 'cigo_to_cosigo') {
    grossUsdValue = inputNum * cigoSellBasis;
    feeUsdValue = 0;
    netUsdValue = grossUsdValue;
    outputAmountNum = netUsdValue / cosigoUsdBasis;
  } else if (pricing.type === 'cosigo_to_cigo') {
    grossUsdValue = inputNum * cosigoUsdBasis;
    feeUsdValue = grossUsdValue * cosigoExitFeeRate;
    netUsdValue = grossUsdValue - feeUsdValue;
    outputAmountNum = netUsdValue / cigoBuyBasis;
  }

  let outputDigits = 6;
  if (toAsset === 'COSIGO') {
    outputDigits = 0;
  } else if (toAsset === 'CIGO') {
    outputDigits = 1;
  }

  return {
    pricingPolicy: pricing.type,
    feeRate: pricing.feeRate,
    grossUsdValue,
    feeUsdValue,
    netUsdValue,
    outputAmount: formatAmount(outputAmountNum, outputDigits),
    feeAmount: formatAmount(feeUsdValue, 6),
    basisSnapshot: {
      ozUsdReference: Number(settings.ozUsdReference),
      cosigoUsdBasis,
      cigoUsdReference,
      cigoInboundHaircutRate: Number(settings.cigoInboundHaircutRate || 0),
      cigoOutboundPremiumRate: Number(settings.cigoOutboundPremiumRate || 0),
      cigoSellBasis,
      cigoBuyBasis,
      usdtUsdBasis: 1,
      digitalExitFeeRate: cosigoExitFeeRate,
      physicalRedemptionFeeRate: Number(settings.physicalRedemptionFeeRate || 0),
      version: Number(settings.version || 1),
      updatedAt: settings.updatedAt || nowIso(),
    }
  };
}

function getRequestPath(record) {
  const d = new Date(record.createdAt);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return path.join(DATA_DIR, 'history', yyyy, mm, `${record.id}.json`);
}

async function writeRequest(record) {
  const index = await loadIndex();
  const filePath = getRequestPath(record);

  await writeJsonAtomic(filePath, record);

  index[record.id] = path.relative(DATA_DIR, filePath);
  await writeJsonAtomic(INDEX_FILE, index);

  return filePath;
}

async function readRequest(id) {
  const index = await loadIndex();
  const relativePath = index[id];
  if (!relativePath) return null;

  const fullPath = path.join(DATA_DIR, relativePath);
  const raw = await fs.readFile(fullPath, 'utf8');
  return JSON.parse(raw);
}

async function listRequests({ status = '', limit = 100 } = {}) {
  const index = await loadIndex();
  const ids = Object.keys(index);
  const items = [];

  for (const id of ids) {
    try {
      const record = await readRequest(id);
      if (!record) continue;
      if (status && record.status !== status) continue;
      items.push(record);
    } catch (err) {
      console.error(`Failed reading request ${id}`, err);
    }
  }

  items.sort((a, b) => {
    const aa = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bb - aa;
  });

  return items.slice(0, limit);
}

function normalizeWallet(value) {
  return String(value || '').trim().toLowerCase();
}

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function getRequestTimestamp(record) {
  const ts = Date.parse(record?.createdAt || record?.updatedAt || '');
  return Number.isFinite(ts) ? ts : 0;
}

async function getWalletUsdtUsedLast24h(wallet) {
  const requests = await listRequests({ limit: Number.MAX_SAFE_INTEGER });
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  const walletNorm = normalizeWallet(wallet);

  return requests.reduce((sum, record) => {
    if (normalizeWallet(record.wallet) !== walletNorm) return sum;
    if (String(record.fromAsset || '').toUpperCase() !== 'USDT') return sum;

    const ts = getRequestTimestamp(record);
    if (!ts || ts < cutoff) return sum;

    return sum + toPositiveNumber(record.inputAmount);
  }, 0);
}

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;

      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function buildHistoryEntry({ action, by, fromStatus = null, toStatus = null, note = '' }) {
  return {
    at: nowIso(),
    action,
    by,
    fromStatus,
    toStatus,
    note: String(note || ''),
  };
}

async function bscRpc(method, params = []) {
  const response = await fetch(BSC_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`BSC RPC request failed (${response.status})`);
  }

  if (data.error) {
    throw new Error(data.error.message || 'BSC RPC returned an error');
  }

  return data.result;
}

function formatTokenUnits(rawValue, decimals = 18, fractionDigits = 4) {
  const raw = BigInt(rawValue || '0x0');
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = raw % base;

  let fractionText = fraction.toString().padStart(decimals, '0');
  fractionText = fractionText.slice(0, fractionDigits).replace(/0+$/, '');

  return Number(fractionText ? `${whole}.${fractionText}` : whole.toString());
}

async function getErc20Balance(tokenAddress, walletAddress, decimals = 18) {
  const data = '0x70a08231' + walletAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0');

  const result = await bscRpc('eth_call', [
    {
      to: tokenAddress,
      data,
    },
    'latest',
  ]);

  return formatTokenUnits(result, decimals, 4);
}

async function getCigoPoolSnapshot() {
  const [custodianBalance, treasuryBalance] = await Promise.all([
    getErc20Balance(CIGO_TOKEN_ADDRESS, CIGO_CUSTODIAN_ADDRESS, CIGO_DECIMALS),
    getErc20Balance(CIGO_TOKEN_ADDRESS, CIGO_TREASURY_ADDRESS, CIGO_DECIMALS),
  ]);

  return {
    token: 'CIGO',
    custodianAddress: CIGO_CUSTODIAN_ADDRESS,
    treasuryAddress: CIGO_TREASURY_ADDRESS,
    custodianBalance,
    treasuryBalance,
    availableFulfillment: custodianBalance,
    committedReserve: custodianBalance + treasuryBalance,
    updatedAt: nowIso(),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'trade-request-api' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/pool/cigo') {
      const pool = await getCigoPoolSnapshot();

      sendJson(res, 200, {
        ok: true,
        pool,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/settings/public') {
      const settings = await loadSettings();

      sendJson(res, 200, {
        ok: true,
        settings: buildSettingsPayload(settings),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/admin/settings') {
      if (!isAdmin(req)) {
        sendError(res, 403, 'Admin key required');
        return;
      }

      const settings = await loadSettings();

      sendJson(res, 200, {
        ok: true,
        settings: buildSettingsPayload(settings),
      });
      return;
    }

    const walletLimitMatch = pathname.match(/^\/api\/limits\/wallet\/(0x[a-fA-F0-9]{40})$/);
    if (req.method === 'GET' && walletLimitMatch) {
      const wallet = walletLimitMatch[1].trim();
      const settings = await loadSettings();

      const usdtDailyWalletCap = Number(settings.usdtDailyWalletCap || 0);
      const usedLast24h = await getWalletUsdtUsedLast24h(wallet);
      const remaining24h = Math.max(0, usdtDailyWalletCap - usedLast24h);

      sendJson(res, 200, {
        ok: true,
        wallet,
        usdtDailyWalletCap,
        usedLast24h,
        remaining24h,
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/admin/settings') {
      if (!isAdmin(req)) {
        sendError(res, 403, 'Admin key required');
        return;
      }

      const body = await parseJsonBody(req);
      const current = await loadSettings();

      const nextSettings = {
        ...current,
        ozUsdReference: cleanNumber(body.ozUsdReference, 'ozUsdReference', 0),
        digitalExitFeeRate: cleanNumber(body.digitalExitFeeRate, 'digitalExitFeeRate', 0),
        physicalRedemptionFeeRate: cleanNumber(body.physicalRedemptionFeeRate, 'physicalRedemptionFeeRate', 0),
        cigoUsdReference: cleanNumber(body.cigoUsdReference, 'cigoUsdReference', 0),
        cigoInboundHaircutRate: cleanNumber(body.cigoInboundHaircutRate, 'cigoInboundHaircutRate', 0),
        cigoOutboundPremiumRate: cleanNumber(body.cigoOutboundPremiumRate, 'cigoOutboundPremiumRate', 0),
        inventoryCigo: cleanNumber(body.inventoryCigo, 'inventoryCigo', 0),
        depthFactor: cleanNumber(body.depthFactor, 'depthFactor', 0),
        usdtDailyWalletCap: cleanNumber(
          body.usdtDailyWalletCap ?? current.usdtDailyWalletCap,
          'usdtDailyWalletCap',
          0
        ),
        version: Number(current.version || 1) + 1,
        updatedAt: nowIso(),
      };

      await writeJsonAtomic(SETTINGS_FILE, nextSettings);

      sendJson(res, 200, {
        ok: true,
        settings: buildSettingsPayload(nextSettings),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/requests/create') {
      const body = await parseJsonBody(req);

      const wallet = cleanString(body.wallet, 'wallet');
      if (!isEthAddress(wallet)) {
        throw new Error('wallet must be a full 0x address');
      }

      const fromAsset = cleanString(body.fromAsset, 'fromAsset').toUpperCase();
      const toAsset = cleanString(body.toAsset, 'toAsset').toUpperCase();

      if (!VALID_ASSETS.has(fromAsset) || !VALID_ASSETS.has(toAsset)) {
        throw new Error('Invalid asset symbol');
      }

      if (fromAsset === toAsset) {
        throw new Error('fromAsset and toAsset must be different');
      }

      const routeType = getRouteType(fromAsset, toAsset);
      if (routeType === 'unsupported') {
        throw new Error('Unsupported route');
      }

      if (routeType === 'external_market') {
        throw new Error('BNB routes are external-market-only and not server-settled here');
      }

      const inputAmount = cleanPositiveAmount(body.inputAmount, 'inputAmount');

      const settings = await loadSettings();
      const usdtDailyWalletCap = Number(settings.usdtDailyWalletCap || 0);

      if (fromAsset === 'USDT' && usdtDailyWalletCap > 0) {
        const usedLast24h = await getWalletUsdtUsedLast24h(wallet);
        const remaining24h = Math.max(0, usdtDailyWalletCap - usedLast24h);
        const requestedAmount = Number(inputAmount);

        if (requestedAmount > remaining24h + 1e-9) {
          sendJson(res, 400, {
            ok: false,
            error: `24-hour USDT cap exceeded for this wallet. Remaining allowance: ${remaining24h.toFixed(2)} USDT.`,
            code: 'USDT_DAILY_CAP_EXCEEDED',
            wallet,
            usdtDailyWalletCap,
            usedLast24h,
            remaining24h,
          });
          return;
        }
      }

      const serverQuote = quoteRoute(fromAsset, toAsset, inputAmount, settings);

      const outputAmount = serverQuote.outputAmount;
      const feeAmount = serverQuote.feeAmount;
      const feeRate = serverQuote.feeRate;
      const basisValue = serverQuote.netUsdValue;

      const basis = {
        CIGO_USD_REFERENCE: serverQuote.basisSnapshot.cigoUsdReference,
        CIGO_SELL_BASIS: serverQuote.basisSnapshot.cigoSellBasis,
        CIGO_BUY_BASIS: serverQuote.basisSnapshot.cigoBuyBasis,
        COSIGO_USD_BASIS: serverQuote.basisSnapshot.cosigoUsdBasis,
        USDT_USD_BASIS: serverQuote.basisSnapshot.usdtUsdBasis,
      };

      const createdAt = nowIso();

      const record = {
        id: makeRequestId(),
        createdAt,
        updatedAt: createdAt,
        source: 'trade.cosigo.io',
        wallet,
        fromAsset,
        toAsset,
        route: `${fromAsset} → ${toAsset}`,
        routeType,
        inputAmount,
        outputAmount,
        basisValue,
        basis,
        feeRate,
        feeAmount,
        pricingPolicy: serverQuote.pricingPolicy,
        basisSnapshot: serverQuote.basisSnapshot,
        status: 'draft',
        settlement: null,
        history: [
          buildHistoryEntry({
            action: 'created',
            by: wallet,
            fromStatus: null,
            toStatus: 'draft',
            note: 'Initial request created',
          }),
        ],
      };

      await writeRequest(record);

      sendJson(res, 201, { ok: true, request: record });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/requests') {
      if (!isAdmin(req)) {
        sendError(res, 403, 'Admin key required');
        return;
      }

      const status = String(url.searchParams.get('status') || '').trim().toLowerCase();
      const limitRaw = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;

      const requests = await listRequests({ status, limit });
      sendJson(res, 200, { ok: true, requests });
      return;
    }

    const requestMatch = pathname.match(/^\/api\/requests\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && requestMatch) {
      const id = requestMatch[1];
      const record = await readRequest(id);

      if (!record) {
        sendError(res, 404, 'Request not found');
        return;
      }

      sendJson(res, 200, { ok: true, request: record });
      return;
    }

    const statusMatch = pathname.match(/^\/api\/requests\/([A-Za-z0-9_-]+)\/status$/);
    if (req.method === 'POST' && statusMatch) {
      const id = statusMatch[1];
      const body = await parseJsonBody(req);

      const record = await readRequest(id);
      if (!record) {
        sendError(res, 404, 'Request not found');
        return;
      }

      const previousStatus = record.status;
      const nextStatus = cleanString(body.status, 'status').toLowerCase();
      const allowedNext = STATUS_FLOW[previousStatus] || [];

      if (previousStatus === nextStatus) {
        sendJson(res, 200, { ok: true, request: record });
        return;
      }

      if (!allowedNext.includes(nextStatus)) {
        sendError(res, 400, `Invalid transition: ${previousStatus} -> ${nextStatus}`);
        return;
      }

      const adminRequired = nextStatus !== 'submitted';
      if (adminRequired && !isAdmin(req)) {
        sendError(res, 403, 'Admin key required for this status transition');
        return;
      }

      if (nextStatus === 'reviewed') {
        record.settlement = cleanSettlementPayload(body, record);
      }

      record.status = nextStatus;
      record.updatedAt = nowIso();

      if (nextStatus === 'completed' && record.settlement) {
        record.settlement.completedAt = record.updatedAt;
        record.settlement.completedNote = cleanOptionalString(body.completedNote, 500);

        let inventoryDeltaCigo = 0;

        if (record.toAsset === 'CIGO') {
          inventoryDeltaCigo = -Number(record.outputAmount || 0);
        } else if (record.fromAsset === 'CIGO') {
          inventoryDeltaCigo = Number(record.inputAmount || 0);
        }

        if (inventoryDeltaCigo !== 0) {
          const currentSettings = await loadSettings();

          const currentInventory = Number(
            currentSettings.inventoryCigo || DEFAULT_SETTINGS.inventoryCigo || 210000
          );

          const currentCigoUsdReference = Number(
            currentSettings.cigoUsdReference || DEFAULT_SETTINGS.cigoUsdReference || 0.01
          );

          const nextInventory = Math.max(0, currentInventory + inventoryDeltaCigo);
          const depthFactor = Number(currentSettings.depthFactor || 0);

          const inventoryPressure = currentInventory > 0
            ? (currentInventory - nextInventory) / currentInventory
            : 0;

          const nextCigoUsdReference = Math.max(
            0.000001,
            Number((currentCigoUsdReference * (1 + inventoryPressure * depthFactor)).toFixed(8))
          );

          const nextSettings = {
            ...currentSettings,
            inventoryCigo: nextInventory,
            cigoUsdReference: nextCigoUsdReference,
            version: Number(currentSettings.version || 1) + 1,
            updatedAt: nowIso(),
          };

          await writeJsonAtomic(SETTINGS_FILE, nextSettings);
        }
      }

      if (nextStatus === 'submitted' && !record.submittedAt) {
        record.submittedAt = record.updatedAt;
      }

      if (nextStatus === 'reviewed' && !record.reviewedAt) {
        record.reviewedAt = record.updatedAt;
      }

      if (nextStatus === 'completed' && !record.completedAt) {
        record.completedAt = record.updatedAt;
      }

      record.history = Array.isArray(record.history) ? record.history : [];
      record.history.push(
        buildHistoryEntry({
          action: 'status_changed',
          by: adminRequired ? 'admin' : record.wallet,
          fromStatus: previousStatus,
          toStatus: nextStatus,
          note: String(body.note || ''),
        })
      );

      await writeRequest(record);

      if (nextStatus === 'submitted') {
        try {
          await sendTradeSubmittedEmail(record);
        } catch (mailErr) {
          console.error('Trade email notification failed', mailErr);
        }
      }

      sendJson(res, 200, { ok: true, request: record });
      return;
    }

    sendError(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    sendError(res, 400, err.message || 'Request failed');
  }
});

ensureDataLayout()
  .then(() => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`trade-request-api listening on 127.0.0.1:${PORT}`);
      console.log(`data dir: ${DATA_DIR}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start trade-request-api', err);
    process.exit(1);
  });
