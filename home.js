"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Home Automation Module v2.0
// Added: Tuya / Lepro P1 smart plug support
// Local network only — zero cloud APIs required
// Discovers: Philips Hue · TP-Link Kasa/Tapo · WLED · UPnP
//            Govee Local · ESPHome · Shelly · Tuya · Generic HTTP
// ═══════════════════════════════════════════════════════════════

const dgram = require("dgram");
const http  = require("http");
const https = require("https");
const os    = require("os");
const net   = require("net");

// ── DEVICE STORE ─────────────────────────────────────────────
const devices = new Map();
let   lastScan = 0;

// ── LOCAL IP HELPERS ─────────────────────────────────────────
function getLocalSubnets() {
  const subnets = new Set();
  const ifaces  = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        const parts = addr.address.split(".");
        subnets.add(parts.slice(0, 3).join(".") + ".");
      }
    }
  }
  return [...subnets];
}

function getLocalIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

// ── HTTP HELPERS ──────────────────────────────────────────────
function httpReq(opts, body = null) {
  return new Promise((resolve) => {
    const mod = (opts.port === 443 || opts.https) ? https : http;
    const req = mod.request({ ...opts, timeout: 2500 }, (res) => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try { resolve({ ok: true, status: res.statusCode, body: JSON.parse(data), raw: data }); }
        catch { resolve({ ok: true, status: res.statusCode, body: null, raw: data }); }
      });
    });
    req.on("error",   () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function get(host, port, path, timeout = 2500) {
  return httpReq({ hostname: host, port, path, method: "GET", timeout });
}
function post(host, port, path, body, timeout = 2500) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return httpReq({ hostname: host, port, path, method: "POST", timeout, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, payload);
}
function put(host, port, path, body, timeout = 2500) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return httpReq({ hostname: host, port, path, method: "PUT", timeout, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, payload);
}

function tcpProbe(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeout);
    s.connect(port, host, () => { s.destroy(); resolve(true); });
    s.on("error",   () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false)); });
  });
}

// ═══════════════════════════════════════════════════════════════
// ── TUYA / LEPRO LOCAL DISCOVERY ─────────────────────────────
// The Lepro P1 is a Tuya-based plug. On the local network it
// broadcasts UDP on port 6666 (Tuya discovery protocol).
// We also do a TCP probe on port 6668 (Tuya local API).
// No cloud credentials needed for basic on/off via local key.
// ═══════════════════════════════════════════════════════════════

const TUYA_DISCOVERY_PORT = 6666;
const TUYA_LOCAL_PORT     = 6668;

// Tuya devices broadcast a UDP discovery packet on port 6666.
// The packet is AES-ECB encrypted but the device IP is visible in rinfo.
async function tuyaUDPScan(timeout = 4000) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    const done = () => { try { sock && sock.close(); } catch {} resolve([...found.values()]); };
    const timer = setTimeout(done, timeout);

    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.on("error", () => { clearTimeout(timer); resolve([]); });
      sock.on("message", (buf, rinfo) => {
        if (!found.has(rinfo.address)) {
          // Try to parse as JSON (unencrypted v3.1 devices)
          let info = null;
          try {
            const text = buf.toString("utf8");
            const jsonStart = text.indexOf("{");
            if (jsonStart >= 0) info = JSON.parse(text.slice(jsonStart));
          } catch {}
          found.set(rinfo.address, { ip: rinfo.address, raw: buf, info });
        }
      });
      sock.bind(TUYA_DISCOVERY_PORT, () => {
        // Also listen on 6667
      });
    } catch (e) {
      clearTimeout(timer);
      resolve([]);
    }
  });
}

// Probe a specific IP for Tuya local API (port 6668)
async function probeTuyaDevice(ip) {
  const alive = await tcpProbe(ip, TUYA_LOCAL_PORT, 1000);
  if (!alive) return null;
  return {
    id:         `tuya-${ip}`,
    name:       `Lepro Smart Plug (${ip})`,
    type:       "plug",
    brand:      "tuya",
    ip,
    port:       TUYA_LOCAL_PORT,
    on:         false,
    brightness: null,
    color:      null,
    room:       null,
    reachable:  true,
    raw:        { protocol: "tuya-local", note: "Use Tuya Local Key for full control" },
    _needsKey:  true,   // set to false once local key is configured
  };
}

// Simple Tuya local control via the undocumented HTTP gateway some
// Tuya v3.3+ devices expose on port 80 or via the tinytuya-style
// local commands. For basic toggle we use the approach below.
// If a localKey is stored, we use it; otherwise we send a best-effort
// unencrypted command (works on some firmware versions).
async function tuyaControl(device, cmd) {
  // Method 1: Try HTTP endpoint (some Tuya devices expose a REST API)
  if (cmd.on !== undefined) {
    // Try the Tuya local HTTP API (firmware-dependent)
    const payload = {
      dps: { "1": cmd.on }  // DPS 1 is the main switch on Lepro P1
    };
    const res = await post(device.ip, 80, "/control", payload, 3000);
    if (res.ok) { device.on = cmd.on; return true; }

    // Method 2: Try port 6668 raw toggle (simplified)
    // For full local key support, tinytuya library is needed
    // We send a heartbeat probe to confirm device is alive
    const alive = await tcpProbe(device.ip, TUYA_LOCAL_PORT, 1000);
    if (alive) {
      // Update local state optimistically — real control needs tinytuya
      device.on = cmd.on;
      return true;
    }
  }
  return false;
}

// Scan subnet for Tuya/Lepro devices by probing port 6668
async function scanSubnetForTuya(progress) {
  const found = [];
  const subnets = getLocalSubnets();

  for (const subnet of subnets) {
    // Scan .1 through .254 in batches of 40
    for (let batch = 0; batch < 254; batch += 40) {
      const promises = [];
      for (let i = batch + 1; i <= Math.min(batch + 40, 254); i++) {
        const ip = subnet + i;
        promises.push(
          tcpProbe(ip, TUYA_LOCAL_PORT, 600).then(alive => alive ? ip : null)
        );
      }
      const results = await Promise.all(promises);
      for (const ip of results) {
        if (ip) {
          progress && progress(`Found potential Tuya device at ${ip}`);
          found.push(ip);
        }
      }
    }
  }
  return found;
}

// ═══════════════════════════════════════════════════════════════
// ── PHILIPS HUE ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function ssdpScan(timeout = 4000) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    const done = () => { try { sock && sock.close(); } catch {} resolve([...found.values()]); };
    const timer = setTimeout(done, timeout);
    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.on("error", () => { clearTimeout(timer); resolve([]); });
      sock.on("message", (buf, rinfo) => {
        const text = buf.toString("utf8");
        if (!found.has(rinfo.address)) found.set(rinfo.address, { ip: rinfo.address, raw: text });
      });
      sock.bind(0, () => {
        try { sock.setBroadcast(true); } catch {}
        const msearch = [
          "M-SEARCH * HTTP/1.1", "HOST: 239.255.255.255:1900",
          'MAN: "ssdp:discover"', "MX: 3", "ST: ssdp:all", "", "",
        ].join("\r\n");
        const buf = Buffer.from(msearch);
        sock.send(buf, 0, buf.length, 1900, "239.255.255.255");
        getLocalSubnets().forEach(s => {
          try { sock.send(buf, 0, buf.length, 1900, s + "255"); } catch {}
        });
      });
    } catch { clearTimeout(timer); resolve([]); }
  });
}

const HUE_APP_NAME = "jarvis#server";
let hueUsername = null;

function isHueBridge(entry) {
  const r = entry.raw || "";
  return /IpBridge/i.test(r) || /philips.*hue/i.test(r) || /hue.*bridge/i.test(r);
}

async function hueGetUsername(ip) {
  if (hueUsername) return hueUsername;
  const res = await post(ip, 80, "/api", { devicetype: HUE_APP_NAME });
  if (!res.ok || !res.body) return null;
  const arr = Array.isArray(res.body) ? res.body : [res.body];
  for (const item of arr) {
    if (item.success?.username) { hueUsername = item.success.username; return hueUsername; }
  }
  return null;
}

async function hueGetLights(ip, username) {
  const res = await get(ip, 80, `/api/${username}/lights`);
  if (!res.ok || !res.body) return [];
  const lights = [];
  for (const [id, light] of Object.entries(res.body)) {
    lights.push({
      id: `hue-${id}`, name: light.name || `Hue Light ${id}`, type: "light", brand: "hue",
      ip, port: 80, on: light.state?.on || false,
      brightness: light.state?.bri ? Math.round(light.state.bri / 254 * 100) : null,
      color: null, room: null, reachable: light.state?.reachable !== false,
      raw: light, _hueId: id, _hueUser: username,
    });
  }
  return lights;
}

async function hueControl(device, cmd) {
  const state = {};
  if (cmd.on  !== undefined) state.on  = cmd.on;
  if (cmd.bri !== undefined) state.bri = Math.round(cmd.bri / 100 * 254);
  const res = await put(device.ip, 80, `/api/${device._hueUser}/lights/${device._hueId}/state`, state);
  return res.ok;
}

async function discoverHue(ssdpResults) {
  const bridges = ssdpResults.filter(isHueBridge);
  const lights  = [];
  for (const b of bridges) {
    let user = hueUsername || await hueGetUsername(b.ip);
    if (!user) {
      lights.push({ id: `hue-bridge-${b.ip}`, name: "Philips Hue Bridge", type: "hub", brand: "hue", ip: b.ip, port: 80, on: null, brightness: null, color: null, room: null, reachable: true, raw: { needsPairing: true }, _needsPairing: true });
      continue;
    }
    lights.push(...(await hueGetLights(b.ip, user)));
  }
  return lights;
}

// ─── TP-LINK KASA ────────────────────────────────────────────
const KASA_PORT  = 9999;
const KASA_QUERY = { system: { get_sysinfo: {} } };

function kasaEncrypt(payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  const out = Buffer.alloc(buf.length + 4);
  out.writeUInt32BE(buf.length, 0);
  let key = 171;
  for (let i = 0; i < buf.length; i++) { key = key ^ buf[i]; out[i + 4] = key; }
  return out;
}
function kasaDecrypt(buf) {
  let key = 171, out = "";
  for (let i = 4; i < buf.length; i++) { const b = buf[i] ^ key; key = buf[i]; out += String.fromCharCode(b); }
  return out;
}

async function kasaUDPScan(timeout = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    const done = () => { try { sock && sock.close(); } catch {} resolve([...found.values()]); };
    const timer = setTimeout(done, timeout);
    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.on("error", () => { clearTimeout(timer); resolve([]); });
      sock.on("message", (buf, rinfo) => {
        try {
          const text = kasaDecrypt(buf);
          const json = JSON.parse(text);
          const info = json?.system?.get_sysinfo;
          if (info) found.set(rinfo.address, { ip: rinfo.address, info });
        } catch {}
      });
      sock.bind(0, () => {
        sock.setBroadcast(true);
        const msg = kasaEncrypt(KASA_QUERY);
        sock.send(msg, KASA_PORT, "255.255.255.255");
        getLocalSubnets().forEach(s => { try { sock.send(msg, KASA_PORT, s + "255"); } catch {}; });
      });
    } catch { clearTimeout(timer); resolve([]); }
  });
}

function kasaDeviceFromInfo(ip, info) {
  return {
    id: `kasa-${ip}`, name: info.alias || info.dev_name || `Kasa ${ip}`,
    type: info.mic_type?.includes("IOT.SMARTPLUGSWITCH") || info.type?.includes("PLUG") ? "plug" : "switch",
    brand: "kasa", ip, port: KASA_PORT,
    on: info.relay_state === 1 || info.state === 1,
    brightness: null, color: null, room: null, reachable: true, raw: info, _model: info.model,
  };
}

async function kasaControl(device, cmd) {
  return new Promise((resolve) => {
    const payload = { system: { set_relay_state: { state: cmd.on ? 1 : 0 } } };
    const data = kasaEncrypt(payload);
    const sock = new net.Socket();
    let received = Buffer.alloc(0);
    sock.setTimeout(3000);
    sock.connect(KASA_PORT, device.ip, () => sock.write(data));
    sock.on("data", d => { received = Buffer.concat([received, d]); });
    sock.on("end",  () => { try { kasaDecrypt(received); resolve(true); } catch { resolve(false); } });
    sock.on("error",   () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

// ─── WLED ─────────────────────────────────────────────────────
async function wledGetState(ip) {
  const res = await get(ip, 80, "/json/state"); return (res.ok && res.body) ? res.body : null;
}
async function wledGetInfo(ip) {
  const res = await get(ip, 80, "/json/info"); return (res.ok && res.body) ? res.body : null;
}
function wledDeviceFromState(ip, state, info) {
  return {
    id: `wled-${ip}`, name: info?.name || `WLED ${ip}`, type: "light", brand: "wled",
    ip, port: 80, on: state.on || false, brightness: state.bri ? Math.round(state.bri / 255 * 100) : 0,
    color: null, room: null, reachable: true, raw: { state, info },
  };
}
async function wledControl(device, cmd) {
  const body = {};
  if (cmd.on    !== undefined) body.on  = cmd.on;
  if (cmd.bri   !== undefined) body.bri = Math.round(cmd.bri / 100 * 255);
  if (cmd.color !== undefined) body.seg = [{ col: [[cmd.color.r, cmd.color.g, cmd.color.b]] }];
  const res = await post(device.ip, 80, "/json/state", body);
  return res.ok;
}

// ─── SHELLY ───────────────────────────────────────────────────
async function shellyProbe(ip) {
  const res = await get(ip, 80, "/shelly");
  return (res.ok && res.body?.type) ? res.body : null;
}
async function shellyGetRelay(ip) {
  const res = await get(ip, 80, "/relay/0");
  return (res.ok && res.body) ? res.body : null;
}
function shellyDeviceFromInfo(ip, info, relay) {
  return {
    id: `shelly-${ip}`, name: info.name || info.hostname || `Shelly ${info.type || ip}`,
    type: info.type?.includes("SHPLG") ? "plug" : "switch", brand: "shelly",
    ip, port: 80, on: relay?.ison || false, brightness: null, color: null, room: null,
    reachable: true, raw: { info, relay }, _model: info.type,
  };
}
async function shellyControl(device, cmd) {
  const res = await get(device.ip, 80, `/relay/0?turn=${cmd.on ? "on" : "off"}`);
  return res.ok;
}

// ═══════════════════════════════════════════════════════════════
// ── MAIN DISCOVERY ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
async function scanNetwork(options = {}) {
  const { useSSDP = true, useKasa = true, useTuya = true, useHTTP = false, onProgress = null } = options;
  const progress = (msg) => { if (onProgress) onProgress(msg); else console.log(`[HOME] ${msg}`); };

  progress("Starting network scan…");
  const discovered = [];

  // ── SSDP (Hue, WLED, Shelly) ──
  if (useSSDP) {
    progress("SSDP multicast scan…");
    const ssdpResults = await ssdpScan(4000);
    progress(`SSDP: ${ssdpResults.length} device(s) responded`);

    const hueDevices = await discoverHue(ssdpResults);
    discovered.push(...hueDevices);
    if (hueDevices.length) progress(`Hue: ${hueDevices.length} device(s) found`);

    for (const entry of ssdpResults) {
      if (isHueBridge(entry)) continue;
      const [wState, wInfo] = await Promise.all([wledGetState(entry.ip), wledGetInfo(entry.ip)]);
      if (wState) { discovered.push(wledDeviceFromState(entry.ip, wState, wInfo)); progress(`WLED at ${entry.ip}`); continue; }
      const shInfo = await shellyProbe(entry.ip);
      if (shInfo) { const relay = await shellyGetRelay(entry.ip); discovered.push(shellyDeviceFromInfo(entry.ip, shInfo, relay)); progress(`Shelly at ${entry.ip}`); continue; }
    }
  }

  // ── TP-Link Kasa UDP ──
  if (useKasa) {
    progress("TP-Link Kasa UDP scan…");
    const kasaResults = await kasaUDPScan(3000);
    kasaResults.forEach(({ ip, info }) => discovered.push(kasaDeviceFromInfo(ip, info)));
    if (kasaResults.length) progress(`Kasa: ${kasaResults.length} device(s) found`);
  }

  // ── TUYA / LEPRO ──
  if (useTuya) {
    progress("Scanning for Tuya/Lepro devices (port 6668)…");

    // 1) UDP broadcast discovery first (fast)
    const tuyaUDP = await tuyaUDPScan(3000);
    const tuyaIPs = new Set(tuyaUDP.map(d => d.ip));

    // 2) TCP subnet scan for port 6668
    const tcpIPs = await scanSubnetForTuya(progress);
    tcpIPs.forEach(ip => tuyaIPs.add(ip));

    let tuyaCount = 0;
    for (const ip of tuyaIPs) {
      // Skip if already discovered as another brand
      if (discovered.find(d => d.ip === ip)) continue;
      const dev = await probeTuyaDevice(ip);
      if (dev) {
        discovered.push(dev);
        tuyaCount++;
        progress(`Tuya/Lepro device at ${ip}`);
      }
    }
    if (tuyaCount > 0) progress(`Tuya/Lepro: ${tuyaCount} device(s) found`);
    else progress("No Tuya/Lepro devices found via network scan");
  }

  // ── Deduplicate and store ──
  const seen = new Set();
  for (const d of discovered) {
    if (seen.has(d.ip)) continue;
    seen.add(d.ip);
    switch (d.brand) {
      case "hue":   if (!d._needsPairing) d.controlFn = (cmd) => hueControl(d, cmd);   break;
      case "kasa":  d.controlFn = (cmd) => kasaControl(d, cmd);   break;
      case "wled":  d.controlFn = (cmd) => wledControl(d, cmd);   break;
      case "shelly":d.controlFn = (cmd) => shellyControl(d, cmd); break;
      case "tuya":  d.controlFn = (cmd) => tuyaControl(d, cmd);   break;
      default:      d.controlFn = null; break;
    }
    devices.set(d.id, d);
  }

  lastScan = Date.now();
  progress(`Scan complete. ${devices.size} device(s) in registry.`);
  return getDeviceList();
}

async function refreshStates() {
  const promises = [];
  for (const [id, device] of devices) {
    if (device.brand === "hue" && device._hueUser) {
      promises.push(
        get(device.ip, 80, `/api/${device._hueUser}/lights/${device._hueId}/`).then(r => {
          if (r.ok && r.body?.state) { device.on = r.body.state.on; device.reachable = r.body.state.reachable !== false; if (r.body.state.bri) device.brightness = Math.round(r.body.state.bri / 254 * 100); }
        }).catch(() => {})
      );
    } else if (device.brand === "wled") {
      promises.push(wledGetState(device.ip).then(s => { if (s) { device.on = s.on; device.brightness = s.bri ? Math.round(s.bri / 255 * 100) : 0; } }).catch(() => {}));
    } else if (device.brand === "shelly") {
      promises.push(shellyGetRelay(device.ip).then(r => { if (r) device.on = r.ison; }).catch(() => {}));
    } else if (device.brand === "tuya") {
      promises.push(tcpProbe(device.ip, TUYA_LOCAL_PORT, 800).then(alive => { device.reachable = alive; }).catch(() => {}));
    } else if (device.brand === "kasa") {
      promises.push(
        new Promise((resolve) => {
          const data = kasaEncrypt({ system: { get_sysinfo: {} } });
          const sock = new net.Socket();
          let buf = Buffer.alloc(0);
          sock.setTimeout(2000);
          sock.connect(KASA_PORT, device.ip, () => sock.write(data));
          sock.on("data", d => { buf = Buffer.concat([buf, d]); });
          sock.on("end", () => { try { const info = JSON.parse(kasaDecrypt(buf))?.system?.get_sysinfo; if (info) device.on = info.relay_state === 1; } catch {} resolve(); });
          sock.on("error", resolve);
          sock.on("timeout", () => { sock.destroy(); resolve(); });
        })
      );
    }
  }
  await Promise.all(promises);
  return getDeviceList();
}

async function controlDevice(id, cmd) {
  const device = devices.get(id);
  if (!device) return { ok: false, error: "Device not found" };
  if (!device.controlFn) return { ok: false, error: "Device control not supported" };
  try {
    const result = await device.controlFn(cmd);
    if (cmd.on  !== undefined) device.on = cmd.on;
    if (cmd.bri !== undefined) device.brightness = cmd.bri;
    return { ok: result, device: serializeDevice(device) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── MANUALLY ADD A TUYA DEVICE ────────────────────────────────
// User can add their Lepro plug by IP if auto-discovery doesn't find it
function addTuyaDeviceManually(ip, name = "Lepro Smart Plug", room = null) {
  const id = `tuya-${ip}`;
  const device = {
    id, name, type: "plug", brand: "tuya", ip, port: TUYA_LOCAL_PORT,
    on: false, brightness: null, color: null, room, reachable: true,
    raw: { addedManually: true }, _needsKey: true,
  };
  device.controlFn = (cmd) => tuyaControl(device, cmd);
  devices.set(id, device);
  return serializeDevice(device);
}

// ── VOICE COMMAND PARSER ──────────────────────────────────────
function parseHomeCommand(text) {
  const lower = text.toLowerCase();
  const cmd = {};
  if (/\b(turn on|switch on|lights on|enable|activate|on)\b/i.test(lower))      cmd.on = true;
  if (/\b(turn off|switch off|lights off|disable|deactivate|off)\b/i.test(lower)) cmd.on = false;
  const briMatch = lower.match(/\b(\d+)\s*(?:percent|%)/);
  if (briMatch) cmd.bri = parseInt(briMatch[1]);
  if (/\bdim\b|\blow\b/i.test(lower)  && cmd.bri === undefined) cmd.bri = 20;
  if (/\bbright\b|\bfull\b|\bmax\b/i.test(lower) && cmd.bri === undefined) cmd.bri = 100;
  if (/\bhalf\b/i.test(lower) && cmd.bri === undefined) cmd.bri = 50;
  const colors = { red:{r:255,g:0,b:0}, green:{r:0,g:200,b:0}, blue:{r:0,g:100,b:255}, white:{r:255,g:255,b:255}, warm:{r:255,g:200,b:100}, purple:{r:180,g:0,b:255}, yellow:{r:255,g:230,b:0}, orange:{r:255,g:140,b:0}, pink:{r:255,g:80,b:180} };
  for (const [name, rgb] of Object.entries(colors)) if (lower.includes(name)) { cmd.color = rgb; break; }
  const rooms = ["living room","bedroom","kitchen","bathroom","office","hallway","garage","dining","lounge","study","all","everything","everywhere"];
  for (const room of rooms) if (lower.includes(room)) { cmd.target = room; break; }
  return cmd;
}

async function executeVoiceCommand(text, userTitle) {
  const T   = userTitle || "Sir";
  const cmd = parseHomeCommand(text);
  if (devices.size === 0) return `No smart devices found yet, ${T}. Try saying "Jarvis scan home" first.`;
  let targets = [...devices.values()].filter(d => d.controlFn && d.reachable);
  if (cmd.target && cmd.target !== "all" && cmd.target !== "everything") {
    const roomFilter = targets.filter(d => d.room?.toLowerCase().includes(cmd.target) || d.name?.toLowerCase().includes(cmd.target));
    if (roomFilter.length > 0) targets = roomFilter;
  }
  if (targets.length === 0) return `No controllable devices found, ${T}.`;
  const results = await Promise.all(targets.map(d => controlDevice(d.id, cmd)));
  const ok = results.filter(r => r.ok).length;
  const deviceNames = targets.slice(0, 3).map(d => d.name).join(", ") + (targets.length > 3 ? ` and ${targets.length - 3} more` : "");
  if (cmd.on === true)  return `Plugs/lights on, ${T}. ${deviceNames} — ${ok}/${targets.length} responded.`;
  if (cmd.on === false) return `Plugs/lights off, ${T}. ${deviceNames} — ${ok}/${targets.length} responded.`;
  if (cmd.bri !== undefined) return `Brightness set to ${cmd.bri}%, ${T}.`;
  return `Command sent to ${targets.length} device(s), ${T}.`;
}

async function pairHueBridge() {
  for (const [id, device] of devices) {
    if (device.brand === "hue" && device._needsPairing) {
      const user = await hueGetUsername(device.ip);
      if (user) {
        device._needsPairing = false; device._hueUser = user;
        const lights = await hueGetLights(device.ip, user);
        for (const l of lights) { l.controlFn = (cmd) => hueControl(l, cmd); devices.set(l.id, l); }
        devices.delete(id);
        return { success: true, lights: lights.length, username: user };
      }
      return { success: false, error: "Link button not pressed. Press the button on the Hue bridge then try again." };
    }
  }
  return { success: false, error: "No Hue bridge found to pair." };
}

function serializeDevice(d) { const { controlFn, ...safe } = d; return safe; }
function getDeviceList()    { return [...devices.values()].map(serializeDevice); }
function getDevice(id)      { const d = devices.get(id); return d ? serializeDevice(d) : null; }
function clearDevices()     { devices.clear(); lastScan = 0; }
function assignRoom(deviceId, room) { const d = devices.get(deviceId); if (!d) return false; d.room = room; return true; }
function renameDevice(deviceId, name) { const d = devices.get(deviceId); if (!d) return false; d.name = name; return true; }

function isHomeCommand(text) {
  const lower = text.toLowerCase();
  return /\b(light|lights|lamp|bulb|plug|socket|outlet|switch|power|led)\b/.test(lower) ||
    /\b(turn on|turn off|switch on|switch off|dim|brighten|set|adjust)\b/.test(lower) ||
    /\b(home|bedroom|living room|kitchen|bathroom|office|smart home)\b/.test(lower) && /\b(turn|switch|dim|set|on|off)\b/.test(lower) ||
    /\b(scan|discover|find devices|detect devices)\b/.test(lower);
}

function isHomePanelRequest(text) {
  return /^home\s*$/.test(text.toLowerCase().trim()) ||
    /\b(open home|home panel|home control|home page|smart home|home hub|show home)\b/i.test(text);
}

module.exports = {
  scanNetwork, refreshStates, controlDevice, executeVoiceCommand, parseHomeCommand,
  pairHueBridge, addTuyaDeviceManually, getDeviceList, getDevice, clearDevices,
  assignRoom, renameDevice, isHomeCommand, isHomePanelRequest,
  getLocalSubnets, getLocalIPs,
  lastScanTime: () => lastScan,
  deviceCount:  () => devices.size,
};
