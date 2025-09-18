/**
 * hoodi_spammer.js — private (builder) compliance-slot spammer + public mempool spammer
 *
 * Private mode:
 *   - Fetches validator schedule
 *   - Finds the next slot with cfg.complianceFilter (e.g., "f_compliance_1")
 *   - Waits until that slot is active
 *   - Rapid-fires bundles ONLY for that slot's target block
 *   - Logs both slot and block, and tells you if it landed in the targeted slot block
 *
 * Public mode:
 *   - Sends raw transactions repeatedly until the time limit
 *
 * Run:
 *   node hoodi_spammer.js -c ./config.public.json
 *   node hoodi_spammer.js -c ./config.public.json --duration 900
 *
 */

import fs from "fs";
import process, { argv, exit } from "process";
import { randomUUID } from "node:crypto"; // core; relays prefer a real UUID
import { ethers } from "ethers";

/*==============================*
 *  CLI & CONFIG
 *==============================*/

function parseCli() {
  const ci = Math.max(argv.indexOf("-c"), argv.indexOf("--config"));
  const di = argv.indexOf("--duration");
  return {
    configPath: ci > -1 ? argv[ci + 1] : "config.json",
    durationOverrideSecs: di > -1 ? Number(argv[di + 1]) : null
  };
}

function normalizeAddress(addr, label) {
  try { return ethers.getAddress(addr); }
  catch {
    try { return ethers.getAddress(String(addr).toLowerCase()); }
    catch {
      console.error(`Invalid ${label}: ${addr}`);
      exit(1);
    }
  }
}

function loadConfig(path) {
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));

  const required = [
    "mode","readRpcUrl","privateKey","expectedChainId",
    "recipientAddress","transferAmountEth","ethGasLimit",
    "minPriorityFeeGwei","priorityFeeBufferGwei",
    "retryPriorityFeeBumpGwei","baseFeeMultiplier","httpTimeoutSecs"
  ];
  const missing = required.filter(k => cfg[k] === undefined);
  if (missing.length) {
    console.error(`Config missing: ${missing.join(", ")}`);
    exit(1);
  }

  cfg.mode = String(cfg.mode || "").toLowerCase();
  if (!["private","public"].includes(cfg.mode)) {
    console.error(`Config "mode" must be "private" or "public".`);
    exit(1);
  }

  // Asset selector
  cfg.asset = (cfg.asset || "ETH").toUpperCase();
  if (!["ETH","WETH"].includes(cfg.asset)) {
    console.error(`Config "asset" must be "ETH" or "WETH".`);
    exit(1);
  }

  // Normalize addresses
  cfg.recipientAddress = normalizeAddress(cfg.recipientAddress, "recipientAddress");
  if (cfg.asset === "WETH") {
    if (!cfg.wethAddress) {
      console.error(`Config error: asset "WETH" requires "wethAddress".`);
      exit(1);
    }
    cfg.wethAddress = normalizeAddress(cfg.wethAddress, "wethAddress");
    cfg.erc20GasLimit ??= 150000;
    cfg.wrapGasLimit  ??= 70000;
    cfg.wrapIfNeeded  ??= true; // public: pre-wrap if WETH balance is low
  }

  if (cfg.mode === "private") {
    cfg.privateRelayUrl = cfg.privateRelayUrl || cfg.builderUrl;
    if (!cfg.privateRelayUrl) {
      console.error(`Config error: mode "private" requires "privateRelayUrl".`);
      exit(1);
    }
    if (!cfg.complianceFilter || !cfg.validatorListUrl) {
      console.error(`Private mode requires "complianceFilter" and "validatorListUrl".`);
      exit(1);
    }
  }

  cfg.authorizationHeader ??= null;
  cfg.runDurationSecs =
    Number.isFinite(Number(cfg.runDurationSecs)) ? Number(cfg.runDurationSecs) : null;
  cfg.compliancePollIntervalSecs ??= 12;
  cfg.slotOffset ??= 0;
  cfg.retryAttempts ??= 0; // public only; 0 = unlimited (time limit controls)
  cfg.maxTxFeeEth ??= null;

  // Slot-head sources (private mode logs/clock)
  cfg.beaconchainUrl ??= "https://hoodi.beaconcha.in/";
  cfg.beaconchainLightUrl ??= "https://light-hoodi.beaconcha.in/";
  cfg.doraUrl ??= "https://dora.hoodi.ethpandaops.io/";

  if (!String(cfg.privateKey).startsWith("0x")) cfg.privateKey = "0x" + cfg.privateKey;

  return cfg;
}

/*==============================*
 *  TIME & HTTP HELPERS
 *==============================*/

const MS = 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getStopTimeMs(runDurationSecs, overrideSecs) {
  const secs = Number.isFinite(overrideSecs) && overrideSecs > 0
    ? overrideSecs
    : (Number.isFinite(runDurationSecs) && runDurationSecs > 0 ? runDurationSecs : null);
  return secs ? Date.now() + secs * MS : null;
}
const stillRunning = (stopMs) => stopMs === null || Date.now() <= stopMs;
const secsLeft = (stopMs) => stopMs === null ? Infinity : Math.max(0, Math.ceil((stopMs - Date.now())/1000));

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } finally {
    clearTimeout(id);
  }
}
async function getText(url, timeoutSecs = 6, headers = {}) {
  const r = await fetchWithTimeout(url, { method: "GET", headers }, timeoutSecs * MS);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return await r.text();
}
async function getJson(url, timeoutSecs = 6, headers = {}) {
  const r = await fetchWithTimeout(url, { method: "GET", headers }, timeoutSecs * MS);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return await r.json();
}
async function postJson(url, body, timeoutSecs = 6, headers = {}) {
  return await fetchWithTimeout(
    url,
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
    timeoutSecs * MS
  );
}

/*==============================*
 *  WEB3 & ENCODING
 *==============================*/

function makeProvider(rpc) {
  return new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: null });
}
async function assertChain(provider, expected) {
  const net = await provider.getNetwork();
  const actual = Number(net.chainId);
  if (actual !== Number(expected)) {
    console.error(`RPC chainId=${actual}, expected ${expected}. Check readRpcUrl.`);
    exit(1);
  }
  return actual;
}
function makeWallet(pk, provider) {
  return new ethers.Wallet(pk, provider);
}

function toBigInt(v) { return (typeof v === "bigint" ? v : BigInt(v)); }

async function calcLegacyGasPriceWei(provider, cfg, attempt) {
  const latest = await provider.getBlock("latest");
  const baseFee = latest?.baseFeePerGas ? BigInt(latest.baseFeePerGas) : 0n;
  const tip    = ethers.parseUnits(String(cfg.minPriorityFeeGwei), "gwei");
  const buffer = ethers.parseUnits(String(cfg.priorityFeeBufferGwei), "gwei");
  const bump   = ethers.parseUnits(String((cfg.retryPriorityFeeBumpGwei || 0) * attempt), "gwei");
  const scaled = BigInt(Math.floor(Number(baseFee) * (cfg.baseFeeMultiplier || 0)));
  let gasPrice = scaled + tip + buffer + bump;
  if (gasPrice <= baseFee) gasPrice = baseFee + tip + buffer + bump;

  // Optional per-tx fee cap: gasPrice * gasLimit <= maxTxFeeEth
  if (cfg.maxTxFeeEth != null) {
    const capWei = ethers.parseEther(String(cfg.maxTxFeeEth));
    let maxGasPrice = capWei / toBigInt(cfg.ethGasLimit);
    if (capWei % toBigInt(cfg.ethGasLimit) !== 0n) {
      maxGasPrice += 1n; // round up to avoid truncation
    }
    if (gasPrice > maxGasPrice) gasPrice = maxGasPrice;
  }
  return gasPrice;
}

async function signLegacyTx({ wallet, to, valueWei, data, gasLimit, gasPriceWei, chainId, nonce }) {
  const tx = {
    to,
    value: toBigInt(valueWei || 0n),
    data: data || "0x",
    gasLimit: toBigInt(gasLimit),
    gasPrice: toBigInt(gasPriceWei),
    chainId: Number(chainId),
    nonce,
    type: 0
  };
  const rawTx = await wallet.signTransaction(tx);
  const txHash = ethers.keccak256(rawTx);
  return { rawTx, txHash };
}

// WETH ABI helpers
const wethAbi = [
  "function deposit() payable",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)"
];
function makeWethIface() { return new ethers.Interface(wethAbi); }
function encodeDeposit(iface) { return iface.encodeFunctionData("deposit", []); }
function encodeTransfer(iface, to, amountWei) { return iface.encodeFunctionData("transfer", [to, amountWei]); }

/*==============================*
 *  SLOT-HEAD & SCHEDULE (Private)
 *==============================*/

// Extract "Current Slot" from beacon HTML.
// Matches: <hX>Current Slot</hX> <hY> 1 148 985 </hY>
const HEADING_RE   = String.raw`<h\d[^>]*>`;
const NUMBER_RE    = String.raw`(?<slot>[0-9][\d\s,]{5,})`; // e.g. "1 148 985" or "1,148,985"
const CURRENT_SLOT = new RegExp(
  `${HEADING_RE}\\s*Current\\s*Slot\\s*</h\\d>\\s*${HEADING_RE}\\s*${NUMBER_RE}\\s*</h\\d>`,
  "is"
);
const MIN_SLOT_VALUE = 1_000_000; // sanity floor for valid Hoodi slots

function toIntDigits(s) {
  const n = Number(String(s).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractSlotFromHtml(html) {
  // 1) direct heading→heading pattern
  const m = CURRENT_SLOT.exec(html);
  if (m?.groups?.slot) {
    const slot = toIntDigits(m.groups.slot);
    if (slot && slot >= MIN_SLOT_VALUE) return slot;
  }
  // 2) fallback: find label, scan a small window
  const label =
    /<h\d[^>]*>\s*Current\s*Slot\s*<\/h\d>/is.exec(html) ||
    /Current\s*Slot/i.exec(html);
  if (!label) return null;

  const start = label.index + label[0].length;
  const window = html.slice(start, start + 300);
  const m2 = new RegExp(NUMBER_RE).exec(window);
  if (m2?.groups?.slot) {
    const slot = toIntDigits(m.groups.slot);
    if (slot && slot >= MIN_SLOT_VALUE) return slot;
  }
  return null;
}

async function getHeadSlot(cfg) {
  const urls = [
    (cfg.beaconchainUrl || "https://hoodi.beaconcha.in/").replace(/\/+$/,"") + "/",
    (cfg.beaconchainLightUrl || "https://light-hoodi.beaconcha.in/").replace(/\/+$/,"") + "/",
    (cfg.doraUrl || "https://dora.hoodi.ethpandaops.io/").replace(/\/+$/,"") + "/"
  ];
  for (const u of urls) {
    try {
      const html = await getText(u + "?t=" + Math.floor(Date.now()/1000), cfg.httpTimeoutSecs, {
        "Cache-Control": "no-cache",
        "User-Agent": "slot-check/1.0"
      });
      const s = extractSlotFromHtml(html);
      if (s != null) return s;
    } catch {}
  }
  return null;
}

function complianceMatches(entryValue, desired) {
  const dl = String(desired ?? "").toLowerCase();
  if (entryValue == null) return false;
  if (typeof entryValue === "string") return entryValue.toLowerCase() === dl;
  if (Array.isArray(entryValue)) return entryValue.some(v => String(v).toLowerCase() === dl);
  return false;
}
function extractTimestamp(item) {
  const t = item?.entry?.message?.timestamp ?? item?.timestamp;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
async function fetchValidatorSchedule(url, timeoutSecs) {
  const data = await getJson(url + "?t=" + Math.floor(Date.now()/1000), timeoutSecs, { "Cache-Control": "no-cache" });
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}
function pickNextMatchingSlot(schedule, filter, headSlot) {
  const candidates = [];
  for (const item of schedule) {
    const s = Number(item?.slot);
    if (!Number.isFinite(s)) continue;
    if (!complianceMatches(item?.compliance_list, filter)) continue;
    if (!Number.isFinite(headSlot) || s >= headSlot) {
      candidates.push({ slot: s, ts: extractTimestamp(item) });
    }
  }
  candidates.sort((a,b)=> a.slot - b.slot);
  return candidates[0] || null;
}

/*==============================*
 *  PRIVATE MODE (ETH or WETH)
 *==============================*/

async function waitUntilSlotActive(targetSlot, cfg, stopMs) {
  while (stillRunning(stopMs)) {
    const head = await getHeadSlot(cfg);
    if (Number.isFinite(head)) {
      if (head >= targetSlot) return head;
      console.log(`[wait] head≈${head}, waiting for slot ${targetSlot}…`);
    } else {
      console.log(`[wait] head slot unavailable; retrying…`);
    }
    await sleep(500);
  }
  return null;
}

function computeTargetBlockFromSlots(headBlock, targetSlot, headSlot, slotOffset = 0) {
  const deltaSlots = Math.max(0, targetSlot - headSlot);
  return headBlock + 1 + deltaSlots + Number(slotOffset || 0);
}

/** Rapid-fire a bundle for this slot's target block.
 * Accepts 1 or 2 raw txs (ETH-only or WETH {deposit,transfer}).
 * Returns inclusion info for the LAST tx in the array.
 */
async function fireBundleForSlot({
  provider, cfg, rawTxs, txHashes, slot, headSlotAtStart, headBlockAtStart, stopMs
}) {
  const targetBlock = computeTargetBlockFromSlots(headBlockAtStart, slot, headSlotAtStart, cfg.slotOffset);
  console.log(`[slot ${slot}] aiming for block ${targetBlock} (headSlot≈${headSlotAtStart}, headBlock=${headBlockAtStart})`);

  const headers = cfg.authorizationHeader ? { Authorization: cfg.authorizationHeader } : {};
  const lastHash = txHashes[txHashes.length - 1];

  while (stillRunning(stopMs) && (await provider.getBlockNumber()) < targetBlock) {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendBundle",
      params: [{
        txs: rawTxs,
        blockNumber: ethers.toBeHex(targetBlock),
        replacementUuid: randomUUID(),
        compliance: cfg.complianceFilter || undefined
      }]
    };
    try {
      const r = await postJson(cfg.privateRelayUrl, payload, cfg.httpTimeoutSecs, headers);
      console.log(`[slot ${slot} | block ${targetBlock}] relay => ${await r.text()} | last tx ${lastHash}`);
    } catch (e) {
      console.log(`[slot ${slot} | block ${targetBlock}] relay error: ${e}`);
    }

    // Early check for last tx
    try {
      const rcpt = await provider.getTransactionReceipt(lastHash);
      if (rcpt && rcpt.blockNumber != null) {
        const inTarget = rcpt.blockNumber === targetBlock;
        console.log(
          inTarget
            ? `✅ Included in TARGETED SLOT (slot ${slot}, block ${targetBlock})`
            : `ℹ️ Included in block ${rcpt.blockNumber} (not targeted block ${targetBlock})`
        );
        return { includedBlock: rcpt.blockNumber, inTarget };
      }
    } catch {}
    await sleep(500);
  }

  // Final check
  try {
    const rcpt = await provider.getTransactionReceipt(lastHash);
    if (rcpt && rcpt.blockNumber != null) {
      const inTarget = rcpt.blockNumber === targetBlock;
      console.log(
        inTarget
          ? `✅ Included in TARGETED SLOT (slot ${slot}, block ${targetBlock})`
          : `❌ Missed targeted slot (slot ${slot}, block ${targetBlock}); landed in block ${rcpt.blockNumber}`
      );
      return { includedBlock: rcpt.blockNumber, inTarget };
    }
  } catch {}

  console.log(`❌ Not included in targeted slot (slot ${slot}, block ${targetBlock})`);
  return { includedBlock: null, inTarget: false };
}

async function runPrivateCompliance({
  cfg, provider, wallet, to, chainId, startNonce, stopMs
}) {
  console.log(`Mode: private (builder) — compliance-gated: '${cfg.complianceFilter}' only`);

  let currentNonce = startNonce;
  let windowsTried = 0;
  let sent = 0;
  let included = 0;
  let targetedInclusions = 0;

  const iface = cfg.asset === "WETH" ? makeWethIface() : null;
  const amountWei = ethers.parseEther(String(cfg.transferAmountEth));

  while (stillRunning(stopMs)) {
    const headSlot = await getHeadSlot(cfg);
    if (!Number.isFinite(headSlot)) {
      console.log("[compliance] head slot unknown; retrying…");
      await sleep(cfg.compliancePollIntervalSecs * MS);
      continue;
    }

    let schedule;
    try {
      schedule = await fetchValidatorSchedule(cfg.validatorListUrl, cfg.httpTimeoutSecs);
    } catch (e) {
      console.log(`[compliance] schedule fetch failed: ${e}; retrying…`);
      await sleep(cfg.compliancePollIntervalSecs * MS);
      continue;
    }
    const next = pickNextMatchingSlot(schedule, cfg.complianceFilter, headSlot);
    if (!next) {
      console.log(`[compliance] No upcoming '${cfg.complianceFilter}' slot yet; head≈${headSlot}. Retrying…`);
      await sleep(cfg.compliancePollIntervalSecs * MS);
      continue;
    }
    const targetSlot = next.slot + Number(cfg.slotOffset || 0);
    const tsNote = next.ts ? ` (~${next.ts})` : "";
    console.log(`[compliance] Next '${cfg.complianceFilter}' slot ${targetSlot}${tsNote}; head≈${headSlot}`);

    const gasPriceWei = await calcLegacyGasPriceWei(provider, cfg, windowsTried);

    // Build raw txs for this window (ETH: 1 tx; WETH: 2 txs)
    let rawTxs = [], txHashes = [];

    if (cfg.asset === "WETH") {
      // deposit() with value = amountWei
      const depData = encodeDeposit(iface);
      const dep = await signLegacyTx({
        wallet, to: cfg.wethAddress, valueWei: amountWei, data: depData,
        gasLimit: cfg.wrapGasLimit, gasPriceWei, chainId, nonce: currentNonce
      });
      // transfer(recipient, amount)
      const xferData = encodeTransfer(iface, to, amountWei);
      const xfer = await signLegacyTx({
        wallet, to: cfg.wethAddress, valueWei: 0n, data: xferData,
        gasLimit: cfg.erc20GasLimit, gasPriceWei, chainId, nonce: currentNonce + 1
      });

      rawTxs = [dep.rawTx, xfer.rawTx];
      txHashes = [dep.txHash, xfer.txHash];
    } else {
      // ETH transfer
      const { rawTx, txHash } = await signLegacyTx({
        wallet, to,
        valueWei: amountWei,
        data: "0x",
        gasLimit: cfg.ethGasLimit, gasPriceWei, chainId, nonce: currentNonce
      });
      rawTxs = [rawTx];
      txHashes = [txHash];
    }
    sent += 1;

    // Wait until the slot begins
    const headAtStart = await waitUntilSlotActive(targetSlot, cfg, stopMs);
    if (!Number.isFinite(headAtStart)) break; // timeout
    const headBlockAtStart = await provider.getBlockNumber();

    const { includedBlock, inTarget } = await fireBundleForSlot({
      provider, cfg, rawTxs, txHashes,
      slot: targetSlot, headSlotAtStart: headAtStart, headBlockAtStart,
      stopMs
    });

    if (includedBlock !== null) {
      included += 1;
      targetedInclusions += (inTarget ? 1 : 0);
      currentNonce += (cfg.asset === "WETH" ? 2 : 1); // advance past used nonces
    } // else: keep same nonces for next window
    windowsTried += 1;
  }

  return { sent, included, targetedInclusions };
}

/*==============================*
 *  PUBLIC MODE (ETH or WETH)
 *==============================*/

async function ensureWethIfNeeded({ cfg, provider, wallet, chainId, stopMs, fixedNonce }) {
  // Pre-wrap once if balance is insufficient
  const iface = makeWethIface();
  const weth = new ethers.Contract(cfg.wethAddress, wethAbi, provider);
  const sender = await wallet.getAddress();
  const need = ethers.parseEther(String(cfg.transferAmountEth));

  const bal = await weth.balanceOf(sender);
  if (bal >= need || !cfg.wrapIfNeeded) return { ok: true, usedNonceDelta: 0 };

  console.log(`WETH balance low (${bal} wei). Pre-wrapping ${need} wei…`);

  let attempt = 0, lastGasPrice = null;
  const minBump = (prev) => (prev * 1125n) / 1000n;

  while (stillRunning(stopMs)) {
    const headBlock = await provider.getBlockNumber();
    const targetBlock = headBlock + 1;

    let gasPriceWei = await calcLegacyGasPriceWei(provider, cfg, attempt);
    if (lastGasPrice !== null && gasPriceWei <= minBump(lastGasPrice)) {
      gasPriceWei = minBump(lastGasPrice) + 1n;
    }

    const depData = encodeDeposit(iface);
    const { rawTx, txHash } = await signLegacyTx({
      wallet, to: cfg.wethAddress,
      valueWei: need, data: depData,
      gasLimit: cfg.wrapGasLimit, gasPriceWei, chainId, nonce: fixedNonce
    });

    try {
      const body = { jsonrpc:"2.0", id:1, method:"eth_sendRawTransaction", params:[rawTx] };
      const res  = await postJson(cfg.readRpcUrl, body, cfg.httpTimeoutSecs);
      console.log(`[prewrap attempt ${attempt}] head ${headBlock} → next ${targetBlock} | gasPrice=${gasPriceWei} | ${await res.text()} | tx ${txHash}`);
    } catch (e) {
      console.log(`[prewrap attempt ${attempt}] send error => ${e}`);
    }

    while (stillRunning(stopMs) && (await provider.getBlockNumber()) < targetBlock) {
      await sleep(250);
    }

    const rcpt = await provider.getTransactionReceipt(txHash).catch(()=>null);
    if (rcpt && rcpt.blockNumber != null) {
      console.log(`✅ Pre-wrap included in block ${rcpt.blockNumber}`);
      return { ok: true, usedNonceDelta: 1 };
    }
    lastGasPrice = gasPriceWei;
    attempt += 1;
  }
  console.log("⏹️  Time limit reached during pre-wrap.");
  return { ok: false, usedNonceDelta: 0 };
}

async function runPublic({
  cfg, provider, wallet, to, chainId, startNonce, stopMs
}) {
  console.log("Mode: public (mempool) — one tx per new block (nonce replacement)");

  const sender = await wallet.getAddress();
  let fixedNonce = startNonce; // replacement requires same nonce until it lands
  let attempt = 0;
  let lastGasPrice = null;
  let sent = 0;
  let included = 0;

  const minBump = (prev) => (prev * 1125n) / 1000n;
  const iface = cfg.asset === "WETH" ? makeWethIface() : null;
  const amountWei = ethers.parseEther(String(cfg.transferAmountEth));

  // If WETH, ensure balance (pre-wrap once if needed)
  if (cfg.asset === "WETH" && cfg.wrapIfNeeded) {
    const res = await ensureWethIfNeeded({ cfg, provider, wallet, chainId, stopMs, fixedNonce });
    fixedNonce += res.usedNonceDelta;
    if (!res.ok) return { sent, included }; // timed out during pre-wrap
  }

  while (stillRunning(stopMs)) {
    // Resync pending nonce (handles prior inclusion)
    const pendingNonce = await provider.getTransactionCount(sender, "pending");
    if (pendingNonce > fixedNonce) {
      console.log(`ℹ️ Nonce advanced on-chain: ${fixedNonce} → ${pendingNonce} (prior tx likely included).`);
      fixedNonce = pendingNonce;
      lastGasPrice = null;
      attempt = 0;
    }

    const headBlock = await provider.getBlockNumber();
    const targetBlock = headBlock + 1;

    let gasPriceWei = await calcLegacyGasPriceWei(provider, cfg, attempt);
    if (lastGasPrice !== null && gasPriceWei <= minBump(lastGasPrice)) {
      gasPriceWei = minBump(lastGasPrice) + 1n;
    }

    let toAddr = to;
    let data = "0x";
    let valueWei = 0n;
    let gasLimit = cfg.ethGasLimit;

    if (cfg.asset === "WETH") {
      toAddr = cfg.wethAddress;
      data = encodeTransfer(iface, to, amountWei);
      valueWei = 0n;
      gasLimit = cfg.erc20GasLimit;
    } else {
      // ETH transfer
      valueWei = amountWei;
      gasLimit = cfg.ethGasLimit;
      data = "0x";
      toAddr = to;
    }

    const { rawTx, txHash } = await signLegacyTx({
      wallet, to: toAddr, valueWei, data, gasLimit, gasPriceWei, chainId, nonce: fixedNonce
    });
    sent += 1;

    try {
      const body = { jsonrpc:"2.0", id:1, method:"eth_sendRawTransaction", params:[rawTx] };
      const res  = await postJson(cfg.readRpcUrl, body, cfg.httpTimeoutSecs);
      const text = await res.text();
      console.log(`[public attempt ${attempt}] head ${headBlock} → next block ${targetBlock} | gasPrice=${gasPriceWei} | ${text} | tx ${txHash}`);

      // If RPC says nonce too low, advance immediately
      if (text.includes("nonce too low")) {
        const n = await provider.getTransactionCount(sender, "pending");
        if (n > fixedNonce) {
          console.log(`ℹ️ RPC: "nonce too low". Advancing nonce ${fixedNonce} → ${n}.`);
          fixedNonce = n;
          lastGasPrice = null;
          attempt = 0;
          continue;
        }
      }
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("nonce too low")) {
        const n = await provider.getTransactionCount(sender, "pending");
        if (n > fixedNonce) {
          console.log(`ℹ️ Error "nonce too low". Advancing nonce ${fixedNonce} → ${n}.`);
          fixedNonce = n;
          lastGasPrice = null;
          attempt = 0;
          continue;
        }
      }
      console.log(`[public attempt ${attempt}] send error => ${msg}`);
    }

    // Wait for target block
    while (stillRunning(stopMs) && (await provider.getBlockNumber()) < targetBlock) {
      await sleep(250);
    }

    // Inclusion check
    const rcpt = await provider.getTransactionReceipt(txHash).catch(()=>null);
    if (rcpt && rcpt.blockNumber != null) {
      included += 1;
      console.log(`✅ Included in block ${rcpt.blockNumber} (nonce ${fixedNonce})`);
      // Start a new series with next nonce
      fixedNonce += 1;
      lastGasPrice = null;
      attempt = 0;
      continue;
    }

    // Not included → replace next block with higher gas (same nonce)
    lastGasPrice = gasPriceWei;
    attempt += 1;
  }

  return { sent, included };
}

/*==============================*
 *  MAIN
 *==============================*/

async function main() {
  const { configPath, durationOverrideSecs } = parseCli();
  const cfg = loadConfig(configPath);

  const provider = makeProvider(cfg.readRpcUrl);
  const chainId  = await assertChain(provider, cfg.expectedChainId);

  const wallet = makeWallet(cfg.privateKey, provider);
  const sender = await wallet.getAddress();
  const startNonce = await provider.getTransactionCount(sender, "pending");
  const to = cfg.recipientAddress; // already normalized

  const stopMs = getStopTimeMs(cfg.runDurationSecs, durationOverrideSecs);
  const left = secsLeft(stopMs);
  console.log(left === Infinity ? "Run has no time limit." : `Run will stop after ~${left}s.`);

  console.log("Sender:    ", sender);
  console.log("Recipient: ", to);
  console.log("ChainID:   ", chainId);
  console.log("StartNonce:", startNonce);

  // Rough cost sanity (BigInt-safe)
  const gasPriceWei = await calcLegacyGasPriceWei(provider, cfg, 0);
  const amountWei = ethers.parseEther(String(cfg.transferAmountEth));
  let estWei;
  if (cfg.asset === "WETH") {
    const wrapGas = toBigInt(cfg.wrapGasLimit || 70000);
    const erc20Gas = toBigInt(cfg.erc20GasLimit || 150000);
    estWei = amountWei + wrapGas * gasPriceWei + erc20Gas * gasPriceWei; // deposit + transfer estimate
  } else {
    estWei = amountWei + toBigInt(cfg.ethGasLimit) * gasPriceWei;
  }
  const balWei  = await provider.getBalance(sender, "pending");
  console.log(`[precheck] balance=${balWei} | estNeed≈${estWei} | gasPrice=${gasPriceWei}`);
  if (balWei < estWei) console.log("⚠️  Balance may be insufficient for value + gas.");

  let stats;
  if (cfg.mode === "public") {
    stats = await runPublic({ cfg, provider, wallet, to, chainId, startNonce, stopMs });
    console.log(`SUMMARY (public ${cfg.asset}): sent=${stats.sent}, included=${stats.included}`);
  } else {
    stats = await runPrivateCompliance({ cfg, provider, wallet, to, chainId, startNonce, stopMs });
    console.log(`SUMMARY (private ${cfg.asset}): windows=${stats.sent}, included=${stats.included}, targetedInclusions=${stats.targetedInclusions}`);
  }

  const success = (stats.included || 0) > 0;
  console.log(success ? "RESULT: RAN UNTIL TIMEOUT — INCLUDED ✅" : "RESULT: RAN UNTIL TIMEOUT — NOT INCLUDED ❌");
  process.exit(success ? 0 : 2);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
