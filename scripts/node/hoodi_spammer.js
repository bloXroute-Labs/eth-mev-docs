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
import { randomUUID } from "crypto";
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

function loadConfig(path) {
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));

  const required = [
    "mode","readRpcUrl","privateKey","expectedChainId",
    "recipientAddress","transferAmountEth","ethGasLimit",
    "minPriorityFeeGwei","priorityFeeBufferGwei",
    "retryPriorityFeeBumpGwei","baseFeeMultiplier","retryAttempts","httpTimeoutSecs"
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

  if (cfg.mode === "private") {
    cfg.privateRelayUrl = cfg.privateRelayUrl || cfg.builderUrl;
    if (!cfg.privateRelayUrl) {
      console.error(`Config error: mode "private" requires "privateRelayUrl".`);
      exit(1);
    }
    if (!cfg.complianceFilter || !cfg.validatorListUrl) {
      console.error(`Private mode requires "complianceFilter" and "validatorListUrl" (only target those slots).`);
      exit(1);
    }
  }

  cfg.authorizationHeader ??= null;
  cfg.runDurationSecs =
    Number.isFinite(Number(cfg.runDurationSecs)) ? Number(cfg.runDurationSecs) : null;
  cfg.compliancePollIntervalSecs ??= 12;
  cfg.slotOffset ??= 0;

  cfg.beaconchainUrl ??= "https://hoodi.beaconcha.in/";
  cfg.beaconchainLightUrl ??= "https://light-hoodi.beaconcha.in/";
  cfg.doraUrl ??= "https://dora.hoodi.ethpandaops.io/";

  if (!cfg.privateKey.startsWith("0x")) cfg.privateKey = "0x" + cfg.privateKey;

  return cfg;
}

/*==============================*
 *  TIME HELPERS
 *==============================*/

const MS = 1000;

function getStopTimeMs(runDurationSecs, overrideSecs) {
  const secs = Number.isFinite(overrideSecs) && overrideSecs > 0
    ? overrideSecs
    : (Number.isFinite(runDurationSecs) && runDurationSecs > 0 ? runDurationSecs : null);
  return secs ? Date.now() + secs * MS : null;
}
const stillRunning = (stopMs) => stopMs === null || Date.now() <= stopMs;
const secsLeft = (stopMs) => stopMs === null ? Infinity : Math.max(0, Math.ceil((stopMs - Date.now())/1000));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/*==============================*
 *  HTTP HELPERS
 *==============================*/

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
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body)
    },
    timeoutSecs * MS
  );
}

/*==============================*
 *  WEB3 & TX
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

async function calcLegacyGasPriceWei(provider, cfg, attempt) {
  const latest = await provider.getBlock("latest");
  const baseFee = latest?.baseFeePerGas ? BigInt(latest.baseFeePerGas) : 0n;
  const tip    = ethers.parseUnits(String(cfg.minPriorityFeeGwei), "gwei");
  const buffer = ethers.parseUnits(String(cfg.priorityFeeBufferGwei), "gwei");
  const bump   = ethers.parseUnits(String((cfg.retryPriorityFeeBumpGwei || 0) * attempt), "gwei");
  const scaled = BigInt(Math.floor(Number(baseFee) * (cfg.baseFeeMultiplier || 0)));
  let gasPrice = scaled + tip + buffer + bump;
  if (gasPrice <= baseFee) gasPrice = baseFee + tip + buffer + bump;
  return gasPrice;
}

async function signLegacyEthTransfer({ wallet, to, valueEth, gasLimit, gasPriceWei, chainId, nonce }) {
  const tx = {
    to,
    value: ethers.parseEther(String(valueEth)),
    gasLimit: BigInt(gasLimit),
    gasPrice: BigInt(gasPriceWei),
    chainId: Number(chainId),
    nonce,
    type: 0
  };
  const rawTx = await wallet.signTransaction(tx);
  const txHash = ethers.keccak256(rawTx);
  return { rawTx, txHash };
}

/*==============================*
 *  SLOT-HEAD & SCHEDULE
 *==============================*/

function digitsToInt(s) {
  const d = String(s).replace(/[^\d]/g, "");
  return d ? Number(d) : NaN;
}
function extractSlotFromHtml(html) {
  // <hX>Current Slot</hX> <hY> 1 148 985 </hY>
  let m = html.match(/<h\d[^>]*>\s*Current\s*Slot\s*<\/h\d>\s*<h\d[^>]*>\s*([0-9][\d\s,]{5,})\s*<\/h\d>/is);
  if (!m) {
    const lab = html.match(/<h\d[^>]*>\s*Current\s*Slot\s*<\/h\d>/is) || html.match(/Current\s*Slot/i);
    if (!lab) return null;
    const idx = lab.index + lab[0].length;
    const window = html.slice(idx, idx + 300);
    m = window.match(/>\s*([0-9][\d\s,]{5,})\s*</);
    if (!m) return null;
  }
  const slot = digitsToInt(m[1]);
  return Number.isFinite(slot) && slot >= 1_000_000 ? slot : null;
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
 *  PRIVATE MODE: SLOT TARGETING
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

/** Map slots to a future block number using the current head block/slot snapshot. */
function computeTargetBlockFromSlots(headBlock, targetSlot, headSlot, slotOffset = 0) {
  const deltaSlots = Math.max(0, targetSlot - headSlot);
  return headBlock + 1 + deltaSlots + Number(slotOffset || 0);
}

async function fireForTargetSlotOnce({
  provider, cfg, rawTx, txHash, slot, headSlotAtStart, headBlockAtStart, stopMs
}) {
  // Fix the target block for THIS slot, using the slot/ head snapshot at activation
  const targetBlock = computeTargetBlockFromSlots(headBlockAtStart, slot, headSlotAtStart, cfg.slotOffset);

  console.log(`[slot ${slot}] aiming for block ${targetBlock} (headSlot≈${headSlotAtStart}, headBlock=${headBlockAtStart})`);

  const headers = cfg.authorizationHeader ? { Authorization: cfg.authorizationHeader } : {};
  let sends = 0;

  // Rapid-fire until target block is mined (or time runs out)
  while (stillRunning(stopMs) && (await provider.getBlockNumber()) < targetBlock) {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendBundle",
      params: [{
        txs: [rawTx],
        blockNumber: ethers.toBeHex(targetBlock),
        replacementUuid: randomUUID(),
        compliance: cfg.complianceFilter || undefined
      }]
    };
    try {
      const r = await postJson(cfg.privateRelayUrl, payload, cfg.httpTimeoutSecs, headers);
      console.log(`[slot ${slot} | block ${targetBlock}] relay => ${await r.text()} | tx ${txHash}`);
    } catch (e) {
      console.log(`[slot ${slot} | block ${targetBlock}] relay error: ${e}`);
    }

    // quick inclusion check to exit early if landed
    try {
      const rcpt = await provider.getTransactionReceipt(txHash);
      if (rcpt && rcpt.blockNumber != null) {
        if (rcpt.blockNumber === targetBlock) {
          console.log(`✅ Included in TARGETED SLOT (slot ${slot}, block ${targetBlock})`);
        } else {
          console.log(`ℹ️ Included in block ${rcpt.blockNumber} (not the targeted slot block ${targetBlock})`);
        }
        return rcpt.blockNumber === targetBlock;
      }
    } catch {}
    sends += 1;
    await sleep(500);
  }

  // After the target block is mined, final check
  try {
    const rcpt = await provider.getTransactionReceipt(txHash);
    if (rcpt && rcpt.blockNumber != null) {
      if (rcpt.blockNumber === targetBlock) {
        console.log(`✅ Included in TARGETED SLOT (slot ${slot}, block ${targetBlock})`);
      } else {
        console.log(`❌ Missed targeted slot (slot ${slot}, block ${targetBlock}); landed in block ${rcpt.blockNumber}`);
      }
      return rcpt.blockNumber === targetBlock;
    }
  } catch {}

  console.log(`❌ Not included in targeted slot (slot ${slot}, block ${targetBlock})`);
  return false;
}

async function runPrivateCompliance({
  cfg, provider, wallet, to, chainId, fixedNonce, stopMs
}) {
  console.log(`Mode: private (builder) — compliance-gated: '${cfg.complianceFilter}' only`);

  let windowsTried = 0;

  while (stillRunning(stopMs)) {
    // Head slot
    const headSlot = await getHeadSlot(cfg);
    if (!Number.isFinite(headSlot)) {
      console.log("[compliance] head slot unknown; retrying…");
      await sleep(cfg.compliancePollIntervalSecs * MS);
      continue;
    }

    // Schedule
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

    // Fresh tx for this window
    const gasPriceWei = await calcLegacyGasPriceWei(provider, cfg, windowsTried);
    const { rawTx, txHash } = await signLegacyEthTransfer({
      wallet, to, valueEth: cfg.transferAmountEth, gasLimit: cfg.ethGasLimit,
      gasPriceWei, chainId, nonce: fixedNonce
    });

    // Wait until slot is active; grab a near-simultaneous head block snapshot
    const headAtStart = await waitUntilSlotActive(targetSlot, cfg, stopMs);
    if (!Number.isFinite(headAtStart)) {
      console.log("⏹️  Time limit reached before target slot became active.");
      return false;
    }
    const headBlockAtStart = await provider.getBlockNumber();

    // Fire for this slot -> single target block
    const landedInTarget = await fireForTargetSlotOnce({
      provider, cfg, rawTx, txHash,
      slot: targetSlot, headSlotAtStart: headAtStart, headBlockAtStart,
      stopMs
    });
    if (landedInTarget) return true;

    windowsTried += 1;
    // Loop to next matching slot
  }

  console.log("⏹️  Time limit reached (no inclusion).");
  return false;
}

/*==============================*
 *  PUBLIC MODE
 *==============================*/

async function runPublic({
  cfg, provider, wallet, to, chainId, startNonce, stopMs
}) {
  console.log("Mode: public (mempool) — spamming until time limit");
  let attempt = 0;
  const maxAttempts = Number(cfg.retryAttempts || 0); // 0 => unlimited, but time will stop us
  let nonce = startNonce;

  while (stillRunning(stopMs) && (maxAttempts === 0 || attempt < maxAttempts)) {
    const gasPriceWei = await calcLegacyGasPriceWei(provider, cfg, attempt);
    const { rawTx, txHash } = await signLegacyEthTransfer({
      wallet, to, valueEth: cfg.transferAmountEth, gasLimit: cfg.ethGasLimit,
      gasPriceWei, chainId, nonce
    });

    try {
      const body = { jsonrpc:"2.0", id:1, method:"eth_sendRawTransaction", params:[rawTx] };
      const res  = await postJson(cfg.readRpcUrl, body, cfg.httpTimeoutSecs);
      console.log(`[public attempt ${attempt}] nonce ${nonce} => ${await res.text()} | tx ${txHash}`);
    } catch (e) {
      console.log(`[public attempt ${attempt}] error => ${e}`);
    }

    // Wait a block, check receipt
    const target = (await provider.getBlockNumber()) + 1;
    while (stillRunning(stopMs) && (await provider.getBlockNumber()) < target) {
      await sleep(500);
    }
    const rcpt = await provider.getTransactionReceipt(txHash).catch(()=>null);
    if (rcpt && rcpt.blockNumber != null) {
      console.log(`✅ Included in block ${rcpt.blockNumber}`);
      return true;
    }

    nonce += 1;
    attempt += 1;
  }

  console.log("⏹️  Public loop ended (time/attempts).");
  return false;
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
  const to = ethers.getAddress(cfg.recipientAddress);

  const stopMs = getStopTimeMs(cfg.runDurationSecs, durationOverrideSecs);
  const left = secsLeft(stopMs);
  console.log(left === Infinity ? "Run has no time limit." : `Run will stop after ~${left}s.`);

  console.log("Sender:    ", sender);
  console.log("Recipient: ", to);
  console.log("ChainID:   ", chainId);
  console.log("StartNonce:", startNonce);

  // cost sanity
  const gasPriceWei = await calcLegacyGasPriceWei(provider, cfg, 0);
  const needWei = ethers.parseEther(String(cfg.transferAmountEth)) + BigInt(cfg.ethGasLimit) * gasPriceWei;
  const balWei  = await provider.getBalance(sender, "pending");
  console.log(`[precheck] balance=${balWei} | need≈${needWei} | gasPrice=${gasPriceWei}`);
  if (balWei < needWei) console.log("⚠️  Balance may be insufficient for value + gas.");

  const included = (cfg.mode === "public")
    ? await runPublic({ cfg, provider, wallet, to, chainId, startNonce, stopMs })
    : await runPrivateCompliance({ cfg, provider, wallet, to, chainId, fixedNonce: startNonce, stopMs });

  console.log(included ? "RESULT: INCLUDED ✅" : "RESULT: NOT INCLUDED ❌");
  process.exit(included ? 0 : 2);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
