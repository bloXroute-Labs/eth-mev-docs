/**
 * hoodi_spammer.js — private (builder) all-slots or compliance-slot submitter + public mempool pusher
 *
 * Private mode:
 *   - Fetches validator schedule
 *   - If cfg.complianceFilter is set → target only those slots
 *   - Else → target ALL upcoming slots from validatorListUrl (capped by cfg.maxSlotsPerCycle)
 *   - Waits until the pre-slot window and submits ONE bundle for that slot's target block
 *
 * Public mode:
 *   - Sends one raw tx per block (classic replacement flow)
 *
 * Run:
 *   node hoodi_spammer.js -c ./config.private.json
 *   node hoodi_spammer.js -c ./config.private.json --duration 900
 */

import fs from "fs";
import process, { argv, exit } from "process";
import { randomUUID } from "node:crypto";
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

  cfg.asset = (cfg.asset || "ETH").toUpperCase();
  if (!["ETH","WETH"].includes(cfg.asset)) {
    console.error(`Config "asset" must be "ETH" or "WETH".`);
    exit(1);
  }

  cfg.recipientAddress = normalizeAddress(cfg.recipientAddress, "recipientAddress");
  if (cfg.asset === "WETH") {
    if (!cfg.wethAddress) {
      console.error(`Config error: asset "WETH" requires "wethAddress".`);
      exit(1);
    }
    cfg.wethAddress = normalizeAddress(cfg.wethAddress, "wethAddress");
    cfg.erc20GasLimit ??= 150000;
    cfg.wrapGasLimit  ??= 70000;
    cfg.wrapIfNeeded  ??= true;
  }

  if (cfg.mode === "private") {
    cfg.privateRelayUrl = cfg.privateRelayUrl || cfg.builderUrl;
    if (!cfg.privateRelayUrl) {
      console.error(`Config error: mode "private" requires "privateRelayUrl".`);
      exit(1);
    }
    if (!cfg.validatorListUrl) {
      console.error(`Private mode requires "validatorListUrl".`);
      exit(1);
    }
    // cfg.complianceFilter is OPTIONAL:
    //   - present → compliance-gated mode
    //   - absent/empty → ALL-SLOTS mode
  }

  cfg.authorizationHeader ??= null;
  cfg.runDurationSecs =
    Number.isFinite(Number(cfg.runDurationSecs)) ? Number(cfg.runDurationSecs) : null;
  cfg.compliancePollIntervalSecs ??= 12; // schedule refresh cadence (seconds)
  cfg.slotOffset ??= 0;
  cfg.retryAttempts ??= 0; // public only; 0 = unlimited
  cfg.maxTxFeeEth ??= null;

  // Optional performance/timing overrides (defaults if not provided)
  cfg.preSlotLeadMs ??= 1100;          // when to fire before slot boundary
  cfg.maxSlotsPerCycle ??= 8;          // cap for ALL-SLOTS planning
  cfg.idleRetryMs ??= 1200;            // idle sleep between polls (ms)
  cfg.relayPostTimeoutMs ??= 400;      // relay POST timeout (ms)
  cfg.postBlockReceiptWaitMs ??= 7000; // wait after block appears (ms)

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
const nowSec = () => Math.floor(Date.now() / 1000);

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
async function postJsonQuickMs(url, body, timeoutMs, headers = {}) {
  try {
    return await fetchWithTimeout(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
      timeoutMs
    );
  } catch {
    return null; // treat relay timeout as a miss; we won't re-send for this block
  }
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

  if (cfg.maxTxFeeEth != null) {
    const capWei = ethers.parseEther(String(cfg.maxTxFeeEth));
    const maxGasPrice = capWei / toBigInt(cfg.ethGasLimit);
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

const HEADING_RE   = String.raw`<h\d[^>]*>`;
const NUMBER_RE    = String.raw`(?<slot>[0-9][\d\s,]{5,})`;
const CURRENT_SLOT = new RegExp(
  `${HEADING_RE}\\s*Current\\s*Slot\\s*</h\\d>\\s*${HEADING_RE}\\s*${NUMBER_RE}\\s*</h\\d>`,
  "is"
);
const MIN_SLOT_VALUE = 1_000_000;

function toIntDigits(s) {
  const n = Number(String(s).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractSlotFromHtml(html) {
  const m = CURRENT_SLOT.exec(html);
  if (m?.groups?.slot) {
    const slot = toIntDigits(m.groups.slot);
    if (slot && slot >= MIN_SLOT_VALUE) return slot;
  }
  const label =
    /<h\d[^>]*>\s*Current\s*Slot\s*<\/h\d>/is.exec(html) ||
    /Current\s*Slot/i.exec(html);
  if (!label) return null;

  const start = label.index + label[0].length;
  const window = html.slice(start, start + 300);
  const m2 = new RegExp(NUMBER_RE).exec(window);
  if (m2?.groups?.slot) {
    const slot = toIntDigits(m2.groups.slot);
    if (slot && slot >= MIN_SLOT_VALUE) return slot;
  }
  return null;
}

async function getLiveHeadSlot(cfg) {
  const urls = [
    (cfg.beaconchainUrl || "https://hoodi.beaconcha.in/").replace(/\/+$/,"") + "/",
    (cfg.beaconchainLightUrl || "https://light-hoodi.beaconcha.in/").replace(/\/+$/,"") + "/",
    (cfg.doraUrl || "https://dora.hoodi.ethpandaops.io/").replace(/\/+$/,"") + "/"
  ];
  for (const u of urls) {
    try {
      const html = await getText(u + "?t=" + nowSec(), cfg.httpTimeoutSecs, {
        "Cache-Control": "no-cache",
        "User-Agent": "slot-check/1.0"
      });
      const s = extractSlotFromHtml(html);
      if (s != null) return s;
    } catch { /* ignore */ }
  }
  return null;
}

// Slot timing
const SLOT_SECONDS   = 12;
const SCHED_PAST_MAX = 3600;
const SCHED_FUT_MAX  = 3600;
const MAX_SLOT_JUMP  = 512;

function extractTimestamp(item) {
  const t = item?.entry?.message?.timestamp ?? item?.timestamp;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

async function fetchValidatorSchedule(url, timeoutSecs) {
  const data = await getJson(url + "?t=" + nowSec(), timeoutSecs, { "Cache-Control": "no-cache" });
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

function complianceMatches(entryValue, desired) {
  const dl = String(desired ?? "").toLowerCase();
  if (entryValue == null) return false;
  if (typeof entryValue === "string") return entryValue.toLowerCase() === dl;
  if (Array.isArray(entryValue)) return entryValue.some(v => String(v).toLowerCase() === dl);
  return false;
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

function pickUpcomingSlots(schedule, headSlot, cap) {
  const seen = new Set();
  const out = [];
  for (const item of schedule) {
    const s = Number(item?.slot);
    if (!Number.isFinite(s)) continue;
    if (Number.isFinite(headSlot) && s < headSlot) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ slot: s, ts: extractTimestamp(item) });
  }
  out.sort((a,b)=> a.slot - b.slot);
  return cap > 0 ? out.slice(0, cap) : out;
}

function backsolveHeadFromSchedule(schedule, nowTs) {
  const refs = [];
  for (const it of schedule) {
    const s = Number(it?.slot);
    const ts = extractTimestamp(it);
    if (Number.isFinite(s) && Number.isFinite(ts)) refs.push([s, ts]);
  }
  if (!refs.length) return null;

  const fut = refs.filter(([s, ts]) => ts - nowTs >= 0 && ts - nowTs <= SCHED_FUT_MAX);
  if (fut.length) {
    const [s0, ts0] = fut.sort((a,b)=> a[1]-b[1])[0];
    const est = s0 - Math.ceil((ts0 - nowTs) / SLOT_SECONDS);
    return est >= MIN_SLOT_VALUE ? [est, nowTs] : null;
  }
  const past = refs.filter(([s, ts]) => nowTs - ts >= 0 && nowTs - ts <= SCHED_PAST_MAX);
  if (past.length) {
    const [s0, ts0] = past.sort((a,b)=> b[1]-a[1])[0];
    const est = s0 + Math.floor((nowTs - ts0) / SLOT_SECONDS);
    return est >= MIN_SLOT_VALUE ? [est, nowTs] : null;
  }
  return null;
}

/**
 * Slot Clock with AGE: tracks last flip time so we can compute ms to boundary.
 */
function makeSlotClock(cfg, scheduleSeed /* [seedSlot, seedTime] or null */) {
  let lastSlot = null;
  let lastFlipMs = null;
  let seedSlot = scheduleSeed ? scheduleSeed[0] : null;
  let seedTime = scheduleSeed ? scheduleSeed[1] : null;

  return async function currentHead() {
    const live = await getLiveHeadSlot(cfg);
    const nowMs = Date.now();

    if (Number.isFinite(live) && live >= MIN_SLOT_VALUE) {
      if (lastSlot === null || live > lastSlot) {
        lastSlot = live;
        lastFlipMs = nowMs;
      } else if (live < lastSlot || live - lastSlot > MAX_SLOT_JUMP) {
        // ignore bad jumps
      }
      seedSlot = live;
      seedTime = nowSec();
      return { head: lastSlot, ageMs: lastFlipMs ? (nowMs - lastFlipMs) : 0 };
    }

    // fallback: seeded wall clock
    if (seedSlot !== null && seedTime !== null) {
      const est = seedSlot + Math.max(0, Math.floor((nowSec() - seedTime) / SLOT_SECONDS));
      if (lastSlot === null || est > lastSlot) {
        lastSlot = est;
        lastFlipMs = nowMs;
      }
      return { head: lastSlot, ageMs: lastFlipMs ? (nowMs - lastFlipMs) : 0 };
    }

    return { head: lastSlot, ageMs: lastFlipMs ? (nowMs - lastFlipMs) : null };
  };
}

/*==============================*
 *  FAST WAIT (accurate single-shot entry)
 *==============================*/

async function waitUntilSlotWindow(targetSlot, slotClock, stopMs, preLeadMs) {
  while (stillRunning(stopMs)) {
    const { head, ageMs } = await slotClock();
    if (Number.isFinite(head)) {
      if (head >= targetSlot) {
        return { headAtStart: head, enterEarly: false };
      }
      if (head === targetSlot - 1 && Number.isFinite(ageMs)) {
        const msToBoundary = Math.max(0, SLOT_SECONDS * 1000 - ageMs);
        if (msToBoundary <= preLeadMs) {
          return { headAtStart: head, enterEarly: true };
        }
      }
      await sleep(20);
    } else {
      await sleep(80);
    }
  }
  return { headAtStart: null, enterEarly: false };
}

function computeTargetBlockFromSlots(headBlock, targetSlot, headSlot, slotOffset = 0) {
  const deltaSlots = Math.max(0, targetSlot - headSlot);
  return headBlock + 1 + deltaSlots + Number(slotOffset || 0);
}

/*==============================*
 *  SINGLE-SHOT BUNDLE SENDER (one bundle per block)
 *==============================*/

async function sendOneBundleForSlot({
  provider, cfg, rawTxs, txHashes, slot, headSlotAtStart, headBlockAtStart, stopMs
}) {
  const targetBlock = computeTargetBlockFromSlots(headBlockAtStart, slot, headSlotAtStart, cfg.slotOffset);
  const headers   = cfg.authorizationHeader ? { Authorization: cfg.authorizationHeader } : {};
  const lastHash  = txHashes[txHashes.length - 1];

  console.log(`[slot ${slot}] aiming for block ${targetBlock} (headSlot≈${headSlotAtStart}, headBlock=${headBlockAtStart})`);

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

  // Submit exactly ONCE for this target block
  const res = await postJsonQuickMs(cfg.privateRelayUrl, payload, cfg.relayPostTimeoutMs, headers);
  if (res) {
    const txt = await res.text().catch(()=> "");
    console.log(`[slot ${slot} | block ${targetBlock}] relay => ${txt} | last tx ${lastHash}`);
  } else {
    console.log(`[slot ${slot} | block ${targetBlock}] relay: no response (timeout) | last tx ${lastHash}`);
  }

  // Wait for the target block to appear, then a small tail to observe receipt
  const until = Date.now() + cfg.postBlockReceiptWaitMs;
  while (stillRunning(stopMs) && Date.now() < until) {
    let bn = 0;
    try { bn = await provider.getBlockNumber(); } catch {}
    if (bn >= targetBlock) {
      // Check receipt of "last tx" to infer bundle inclusion
      try {
        const rcpt = await provider.getTransactionReceipt(lastHash);
        if (rcpt && rcpt.blockNumber != null) {
          const inTarget = rcpt.blockNumber === targetBlock;
          console.log(inTarget
            ? `✅ Included in TARGETED SLOT (slot ${slot}, block ${targetBlock})`
            : `ℹ️ Included in block ${rcpt.blockNumber} (not targeted block ${targetBlock})`);
          return { includedBlock: rcpt.blockNumber, inTarget };
        }
      } catch {}
    }
    await sleep(120);
  }

  console.log(`❌ Not included in targeted slot (slot ${slot}, block ${targetBlock})`);
  return { includedBlock: null, inTarget: false };
}

/*==============================*
 *  PRIVATE MODE (ETH or WETH)
 *==============================*/

async function runPrivateCompliance({
  cfg, provider, wallet, to, chainId, startNonce, stopMs
}) {
  const allSlotsMode = !cfg.complianceFilter || String(cfg.complianceFilter).trim() === "";
  console.log(
    allSlotsMode
      ? `Mode: private (builder) — ONE bundle per block for ALL slots from validatorListUrl`
      : `Mode: private (builder) — ONE bundle per block for '${cfg.complianceFilter}' slots`
  );

  let currentNonce = startNonce;
  let windowsTried = 0;
  let sent = 0;
  let included = 0;
  let targetedInclusions = 0;

  // suppress repeated "No upcoming …" logs — one line per head value
  let lastNoSlotHead = null;

  const iface = cfg.asset === "WETH" ? makeWethIface() : null;
  const amountWei = ethers.parseEther(String(cfg.transferAmountEth));

  // Seed slot clock from schedule (fallback if beacons fail)
  let schedule = [];
  try { schedule = await fetchValidatorSchedule(cfg.validatorListUrl, cfg.httpTimeoutSecs); } catch {}
  const seed = schedule.length ? backsolveHeadFromSchedule(schedule, nowSec()) : null;
  const slotClock = makeSlotClock(cfg, seed);

  while (stillRunning(stopMs)) {
    // refresh schedule every loop (also seeds if needed)
    try { schedule = await fetchValidatorSchedule(cfg.validatorListUrl, cfg.httpTimeoutSecs); } catch (e) {
      console.log(`[private] schedule fetch failed: ${e}; retrying…`);
      await sleep(cfg.idleRetryMs);
      continue;
    }

    const { head } = await slotClock();
    if (!Number.isFinite(head)) {
      console.log("[private] head slot unknown (all sources). Retrying…");
      await sleep(cfg.idleRetryMs);
      continue;
    }

    // Build target list for this cycle
    let targets = [];
    if (allSlotsMode) {
      targets = pickUpcomingSlots(schedule, head, cfg.maxSlotsPerCycle)
        .map(x => ({ ...x, slot: x.slot + Number(cfg.slotOffset || 0) }));
      if (!targets.length) {
        console.log(`[private] No upcoming slots found; head≈${head}. Retrying…`);
        await sleep(cfg.idleRetryMs);
        continue;
      }
      const range = `${targets[0].slot}…${targets[targets.length - 1].slot}`;
      console.log(`[private] Upcoming slots (capped ${cfg.maxSlotsPerCycle}): ${range} (head≈${head})`);
    } else {
      const next = pickNextMatchingSlot(schedule, cfg.complianceFilter, head);
      if (!next) {
        if (lastNoSlotHead !== head) {
          console.log(`[private] No upcoming '${cfg.complianceFilter}' slot yet; head≈${head}. Retrying…`);
          lastNoSlotHead = head;
        }
        await sleep(cfg.idleRetryMs);
        continue;
      }
      const targetSlot = next.slot + Number(cfg.slotOffset || 0);
      const tsNote = next.ts ? ` (~${next.ts})` : "";
      console.log(`[private] Next '${cfg.complianceFilter}' slot ${targetSlot}${tsNote}; head≈${head}`);
      targets = [ { slot: targetSlot, ts: next.ts } ];
      lastNoSlotHead = null; // reset once we have a match
    }

    // Iterate targets — ONE bundle per target block
    for (const t of targets) {
      const targetSlot = t.slot;

      const gasPriceWei = await calcLegacyGasPriceWei(provider, cfg, windowsTried);

      // Build raw txs for this window (ETH: 1 tx; WETH: 2 txs)
      let rawTxs = [], txHashes = [];
      if (cfg.asset === "WETH") {
        const depData = encodeDeposit(makeWethIface());
        const dep = await signLegacyTx({
          wallet, to: cfg.wethAddress, valueWei: amountWei, data: depData,
          gasLimit: cfg.wrapGasLimit, gasPriceWei, chainId, nonce: currentNonce
        });
        const xferData = encodeTransfer(makeWethIface(), to, amountWei);
        const xfer = await signLegacyTx({
          wallet, to: cfg.wethAddress, valueWei: 0n, data: xferData,
          gasLimit: cfg.erc20GasLimit, gasPriceWei, chainId, nonce: currentNonce + 1
        });
        rawTxs = [dep.rawTx, xfer.rawTx];
        txHashes = [dep.txHash, xfer.txHash];
      } else {
        const { rawTx, txHash } = await signLegacyTx({
          wallet, to,
          valueWei: amountWei, data: "0x",
          gasLimit: cfg.ethGasLimit, gasPriceWei, chainId, nonce: currentNonce
        });
        rawTxs = [rawTx];
        txHashes = [txHash];
      }
      sent += 1;

      // Enter the pre-slot window then submit ONCE
      const { headAtStart } =
        await waitUntilSlotWindow(targetSlot, slotClock, stopMs, cfg.preSlotLeadMs);
      if (!Number.isFinite(headAtStart)) { break; } // timed out
      const headBlockAtStart = await provider.getBlockNumber();

      const { includedBlock, inTarget } = await sendOneBundleForSlot({
        provider, cfg, rawTxs, txHashes,
        slot: targetSlot, headSlotAtStart: headAtStart, headBlockAtStart,
        stopMs
      });

      if (includedBlock !== null) {
        included += 1;
        targetedInclusions += (inTarget ? 1 : 0);
        currentNonce += (cfg.asset === "WETH" ? 2 : 1); // advance past used nonces
      }
      windowsTried += 1;
      if (!stillRunning(stopMs)) break;
    }
  }

  return { sent, included, targetedInclusions };
}

/*==============================*
 *  PUBLIC MODE (ETH or WETH)
 *==============================*/

async function ensureWethIfNeeded({ cfg, provider, wallet, chainId, stopMs, fixedNonce }) {
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
  let fixedNonce = startNonce;
  let attempt = 0;
  let lastGasPrice = null;
  let sent = 0;
  let included = 0;

  const minBump = (prev) => (prev * 1125n) / 1000n;
  const iface = cfg.asset === "WETH" ? makeWethIface() : null;
  const amountWei = ethers.parseEther(String(cfg.transferAmountEth));

  if (cfg.asset === "WETH" && cfg.wrapIfNeeded) {
    const res = await ensureWethIfNeeded({ cfg, provider, wallet, chainId, stopMs, fixedNonce });
    fixedNonce += res.usedNonceDelta;
    if (!res.ok) return { sent, included };
  }

  while (stillRunning(stopMs)) {
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

    while (stillRunning(stopMs) && (await provider.getBlockNumber()) < targetBlock) {
      await sleep(250);
    }

    const rcpt = await provider.getTransactionReceipt(txHash).catch(()=>null);
    if (rcpt && rcpt.blockNumber != null) {
      included += 1;
      console.log(`✅ Included in block ${rcpt.blockNumber} (nonce ${fixedNonce})`);
      fixedNonce += 1;
      lastGasPrice = null;
      attempt = 0;
      continue;
    }

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
  const to = cfg.recipientAddress;

  const stopMs = getStopTimeMs(cfg.runDurationSecs, durationOverrideSecs);
  const left = secsLeft(stopMs);
  console.log(left === Infinity ? "Run has no time limit." : `Run will stop after ~${left}s.`);

  console.log("Sender:    ", sender);
  console.log("Recipient: ", to);
  console.log("ChainID:   ", chainId);
  console.log("StartNonce:", startNonce);

  const gasPriceWei = await calcLegacyGasPriceWei(provider, cfg, 0);
  const amountWei = ethers.parseEther(String(cfg.transferAmountEth));
  let estWei;
  if (cfg.asset === "WETH") {
    const wrapGas = toBigInt(cfg.wrapGasLimit || 70000);
    const erc20Gas = toBigInt(cfg.erc20GasLimit || 150000);
    estWei = amountWei + wrapGas * gasPriceWei + erc20Gas * gasPriceWei;
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
