"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Home Automation Module v1.0
// Local network only — zero cloud APIs required
// Discovers: Philips Hue · TP-Link Kasa/Tapo · WLED · UPnP
//            Govee Local · ESPHome · Shelly · Generic HTTP
// ═══════════════════════════════════════════════════════════════

const dgram = require("dgram");
const http  = require("http");
const https = require("https");
const os    = require("os");

// ── DEVICE STORE ─────────────────────────────────────────────
// In-memory device registry — persists for the server session
const devices = new Map();   // id → device object
let   lastScan = 0;

// ── DEVICE SCHEMA ─────────────────────────────────────────────
// {
//   id:         string (unique, e.g. "hue-1" or "ip-192.168.1.x")
//   name:       string
//   type:       "light" | "plug" | "switch" | "sensor" | "hub" | "unknown"
//   brand:      "hue" | "kasa" | "tapo" | "wled" | "shelly" | "govee" | "generic"
//   ip:         string
//   port:       number
//   on:         boolean
//   brightness: 0–100 (null if not supported)
//   color:      { r,g,b } | null
//   room:       string | null
//   reachable:  boolean
//   raw:        object (brand-specific state)
//   controlFn:  async (cmd) => result   ← attached at runtime
// }

// ── LOCAL IP HELPERS ─────────────────────────────────────────
function getLocalSubnets() {
  const subnets = new Set();
  const ifaces  = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        // e.g. 192.168.1.100 → base = "192.168.1."
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
        try { resolve({ ok: true, status: res.status || res.statusCode, body: JSON.parse(data), raw: data }); }
        catch { resolve({ ok: true, status: res.status || res.statusCode, body: null, raw: data }); }
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
  return httpReq({
    hostname: host, port, path, method: "POST", timeout,
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  }, payload);
}

function put(host, port, path, body, timeout = 2500) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return httpReq({
    hostname: host, port, path, method: "PUT", timeout,
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  }, payload);
}

// ── SSDP DISCOVERY ────────────────────────────────────────────
function ssdpScan(timeout = 4000) {
  return new Promise((resolve) => {
    const found = new Map(); // ip → raw response
    let   sock;

    const done = () => {
      try { sock && sock.close(); } catch {}
      resolve([...found.values()]);
    };

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
          "M-SEARCH * HTTP/1.1",
          "HOST: 239.255.255.255:1900",
          'MAN: "ssdp:discover"',
          "MX: 3",
          "ST: ssdp:all",
          "",
          "",
        ].join("\r\n");
        const buf = Buffer.from(msearch);
        sock.send(buf, 0, buf.length, 1900, "239.255.255.255");
        // Also send directly to broadcast
        const subnets = getLocalSubnets();
        for (const s of subnets) {
          const broadcast = s + "255";
          try { sock.send(buf, 0, buf.length, 1900, broadcast); } catch {}
        }
      });
    } catch (e) {
      clearTimeout(timer);
      resolve([]);
    }
  });
}

// ── PHILIPS HUE ───────────────────────────────────────────────
// Hue bridges respond to SSDP with "IpBridge" in the USN
// Local API at http://<ip>/api/<username>/lights

const HUE_APP_NAME = "jarvis#server";
let   hueUsername  = null;   // created once, reused

function isHueBridge(ssdpEntry) {
  const r = ssdpEntry.raw || "";
  return /IpBridge/i.test(r) || /philips.*hue/i.test(r) || /hue.*bridge/i.test(r);
}

async function hueGetUsername(ip) {
  if (hueUsername) return hueUsername;
  // Try creating a username (user must press link button first)
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
      id:         `hue-${id}`,
      name:       light.name || `Hue Light ${id}`,
      type:       "light",
      brand:      "hue",
      ip,
      port:       80,
      on:         light.state?.on || false,
      brightness: light.state?.bri ? Math.round(light.state.bri / 254 * 100) : null,
      color:      light.state?.xy ? null : null,
      room:       null,
      reachable:  light.state?.reachable !== false,
      raw:        light,
      _hueId:     id,
      _hueUser:   username,
    });
  }
  return lights;
}

async function hueControl(device, cmd) {
  const { _hueId, _hueUser, ip } = device;
  const state = {};
  if (cmd.on    !== undefined) state.on  = cmd.on;
  if (cmd.bri   !== undefined) state.bri = Math.round(cmd.bri / 100 * 254);
  if (cmd.ct    !== undefined) state.ct  = cmd.ct;     // color temp 153–500
  if (cmd.xy    !== undefined) state.xy  = cmd.xy;
  const res = await put(ip, 80, `/api/${_hueUser}/lights/${_hueId}/state`, state);
  return res.ok;
}

async function discoverHue(ssdpResults) {
  const bridges = ssdpResults.filter(isHueBridge);
  const lights  = [];
  for (const b of bridges) {
    // Try to get existing username or create one
    let user = hueUsername;
    if (!user) {
      // Try fetching lights with a placeholder — will fail if no user
      // Try to detect existing username by checking /api endpoint
      user = await hueGetUsername(b.ip);
    }
    if (!user) {
      // No username yet — bridge is there but needs pairing
      lights.push({
        id: `hue-bridge-${b.ip}`,
        name: "Philips Hue Bridge",
        type: "hub",
        brand: "hue",
        ip: b.ip,
        port: 80,
        on: null,
        brightness: null,
        color: null,
        room: null,
        reachable: true,
        raw: { needsPairing: true },
        _needsPairing: true,
      });
      continue;
    }
    const ls = await hueGetLights(b.ip, user);
    lights.push(...ls);
  }
  return lights;
}

// ── TP-LINK KASA / TAPO ───────────────────────────────────────
// Kasa: UDP broadcast on port 9999 with XOR-encrypted payload
// Tapo: HTTPS on port 443 with AES (much harder)

const KASA_PORT  = 9999;
const KASA_QUERY = { system: { get_sysinfo: {} } };

function kasaEncrypt(payload) {
  const buf  = Buffer.from(JSON.stringify(payload));
  const out  = Buffer.alloc(buf.length + 4);
  out.writeUInt32BE(buf.length, 0);
  let key = 171;
  for (let i = 0; i < buf.length; i++) {
    key = key ^ buf[i];
    out[i + 4] = key;
  }
  return out;
}

function kasaDecrypt(buf) {
  let key = 171, out = "";
  for (let i = 4; i < buf.length; i++) {
    const b = buf[i] ^ key;
    key = buf[i];
    out += String.fromCharCode(b);
  }
  return out;
}

function kasaUDPScan(timeout = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    let   sock;
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
        const subnets = getLocalSubnets();
        for (const s of subnets) {
          try { sock.send(msg, KASA_PORT, s + "255"); } catch {}
        }
      });
    } catch { clearTimeout(timer); resolve([]); }
  });
}

function kasaDeviceFromInfo(ip, info) {
  return {
    id:         `kasa-${ip}`,
    name:       info.alias || info.dev_name || `Kasa ${ip}`,
    type:       info.mic_type?.includes("IOT.SMARTPLUGSWITCH") || info.type?.includes("PLUG") ? "plug" : "switch",
    brand:      "kasa",
    ip,
    port:       KASA_PORT,
    on:         info.relay_state === 1 || info.state === 1,
    brightness: null,
    color:      null,
    room:       null,
    reachable:  true,
    raw:        info,
    _model:     info.model,
  };
}

async function kasaControl(device, cmd) {
  // TCP connection to port 9999
  return new Promise((resolve) => {
    const payload = { system: { set_relay_state: { state: cmd.on ? 1 : 0 } } };
    const data    = kasaEncrypt(payload);
    const sock    = new (require("net").Socket)();
    let   received = Buffer.alloc(0);
    sock.setTimeout(3000);
    sock.connect(KASA_PORT, device.ip, () => sock.write(data));
    sock.on("data", d => { received = Buffer.concat([received, d]); });
    sock.on("end",  () => { try { kasaDecrypt(received); resolve(true); } catch { resolve(false); } });
    sock.on("error",   () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

// ── WLED ──────────────────────────────────────────────────────
// WLED runs an HTTP API on port 80
// GET /json/state → current state
// POST /json/state → control

async function wledGetState(ip) {
  const res = await get(ip, 80, "/json/state");
  if (!res.ok || !res.body) return null;
  return res.body;
}

async function wledGetInfo(ip) {
  const res = await get(ip, 80, "/json/info");
  if (!res.ok || !res.body) return null;
  return res.body;
}

function wledDeviceFromState(ip, state, info) {
  return {
    id:         `wled-${ip}`,
    name:       info?.name || `WLED ${ip}`,
    type:       "light",
    brand:      "wled",
    ip,
    port:       80,
    on:         state.on || false,
    brightness: state.bri ? Math.round(state.bri / 255 * 100) : 0,
    color:      null,
    room:       null,
    reachable:  true,
    raw:        { state, info },
  };
}

async function wledControl(device, cmd) {
  const body = {};
  if (cmd.on        !== undefined) body.on  = cmd.on;
  if (cmd.bri       !== undefined) body.bri = Math.round(cmd.bri / 100 * 255);
  if (cmd.color     !== undefined) body.seg = [{ col: [[cmd.color.r, cmd.color.g, cmd.color.b]] }];
  const res = await post(device.ip, 80, "/json/state", body);
  return res.ok;
}

// ── SHELLY ────────────────────────────────────────────────────
// Shelly devices have a web server on port 80
// GET /shelly → device info
// GET /relay/0 → state
// GET /relay/0?turn=on|off → control

async function shellyProbe(ip) {
  const res = await get(ip, 80, "/shelly");
  if (!res.ok || !res.body) return null;
  if (!res.body.type) return null;
  return res.body;
}

async function shellyGetRelay(ip) {
  const res = await get(ip, 80, "/relay/0");
  if (!res.ok || !res.body) return null;
  return res.body;
}

function shellyDeviceFromInfo(ip, info, relay) {
  return {
    id:         `shelly-${ip}`,
    name:       info.name || info.hostname || `Shelly ${info.type || ip}`,
    type:       info.type?.includes("SHPLG") ? "plug" : "switch",
    brand:      "shelly",
    ip,
    port:       80,
    on:         relay?.ison || false,
    brightness: null,
    color:      null,
    room:       null,
    reachable:  true,
    raw:        { info, relay },
    _model:     info.type,
  };
}

async function shellyControl(device, cmd) {
  const action = cmd.on ? "on" : "off";
  const res = await get(device.ip, 80, `/relay/0?turn=${action}`);
  return res.ok;
}

// ── HTTP FINGERPRINT SCAN ─────────────────────────────────────
// Scan common smart home ports on local subnet
// Fingerprint by HTTP response

const SCAN_PORTS  = [80, 8080, 8008, 8123, 5000, 4000];
const SCAN_PATHS  = ["/", "/api", "/json", "/status", "/shelly", "/info"];

const FINGERPRINTS = [
  { brand: "wled",    pattern: /wled|WLED/i,           path: "/json/info" },
  { brand: "shelly",  pattern: /shelly|Shelly/i,       path: "/shelly"    },
  { brand: "esphome", pattern: /esphome|ESPHome/i,     path: "/"          },
  { brand: "hue",     pattern: /IpBridge|Philips|hue/i, path: "/"         },
  { brand: "govee",   pattern: /govee|Govee/i,         path: "/"          },
  { brand: "tasmota", pattern: /tasmota|Tasmota/i,     path: "/"          },
  { brand: "tuya",    pattern: /tuya|smartlife/i,       path: "/"          },
  { brand: "tp-link", pattern: /tplink|tp-link|kasa/i, path: "/"          },
];

async function httpFingerprint(ip, port) {
  const res = await get(ip, port, "/", 1500);
  if (!res.ok) return null;
  const body = res.raw || "";
  for (const fp of FINGERPRINTS) {
    if (fp.pattern.test(body)) {
      return { ip, port, brand: fp.brand, raw: body };
    }
  }
  // Check if it returns JSON — might be a smart device
  if (res.body && typeof res.body === "object") {
    return { ip, port, brand: "generic", raw: body, json: res.body };
  }
  return null;
}

async function scanSubnetHTTP(subnet, timeout = 5000) {
  const found = [];
  const promises = [];

  // Scan .1 through .254
  for (let i = 1; i <= 254; i++) {
    const ip = subnet + i;
    promises.push(
      Promise.race([
        (async () => {
          // Quick TCP probe first
          const alive = await tcpProbe(ip, 80, 800);
          if (!alive) return null;
          return httpFingerprint(ip, 80);
        })(),
        new Promise(r => setTimeout(() => r(null), timeout / 10))
      ])
    );
  }

  // Run in batches of 30
  for (let i = 0; i < promises.length; i += 30) {
    const batch = await Promise.all(promises.slice(i, i + 30));
    for (const r of batch) { if (r) found.push(r); }
  }
  return found;
}

function tcpProbe(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const s = new (require("net").Socket)();
    s.setTimeout(timeout);
    s.connect(port, host, () => { s.destroy(); resolve(true); });
    s.on("error",   () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

// ── MAIN DISCOVERY ────────────────────────────────────────────
async function scanNetwork(options = {}) {
  const {
    useSSDP    = true,
    useKasa    = true,
    useHTTP    = false,   // subnet HTTP scan is slow, off by default
    onProgress = null,
  } = options;

  const progress = (msg) => { if (onProgress) onProgress(msg); else console.log(`[HOME] ${msg}`); };
  progress("Starting network scan…");

  const discovered = [];

  // ── SSDP ──
  if (useSSDP) {
    progress("SSDP multicast scan…");
    const ssdpResults = await ssdpScan(4000);
    progress(`SSDP: ${ssdpResults.length} device(s) responded`);

    // Philips Hue via SSDP
    const hueDevices = await discoverHue(ssdpResults);
    discovered.push(...hueDevices);
    if (hueDevices.length) progress(`Hue: ${hueDevices.length} device(s) found`);

    // Check all SSDP responders for other brands
    for (const entry of ssdpResults) {
      if (isHueBridge(entry)) continue;  // already handled
      // Try WLED
      const [wState, wInfo] = await Promise.all([wledGetState(entry.ip), wledGetInfo(entry.ip)]);
      if (wState) {
        discovered.push(wledDeviceFromState(entry.ip, wState, wInfo));
        progress(`WLED found at ${entry.ip}`);
        continue;
      }
      // Try Shelly
      const shInfo = await shellyProbe(entry.ip);
      if (shInfo) {
        const relay = await shellyGetRelay(entry.ip);
        discovered.push(shellyDeviceFromInfo(entry.ip, shInfo, relay));
        progress(`Shelly found at ${entry.ip}`);
        continue;
      }
    }
  }

  // ── TP-Link Kasa UDP ──
  if (useKasa) {
    progress("TP-Link Kasa UDP scan…");
    const kasaResults = await kasaUDPScan(3000);
    for (const { ip, info } of kasaResults) {
      discovered.push(kasaDeviceFromInfo(ip, info));
    }
    if (kasaResults.length) progress(`Kasa: ${kasaResults.length} device(s) found`);
  }

  // ── Subnet HTTP scan (optional, slow) ──
  if (useHTTP) {
    const subnets = getLocalSubnets();
    for (const subnet of subnets) {
      progress(`HTTP scan on ${subnet}0/24 (this takes ~10s)…`);
      const httpResults = await scanSubnetHTTP(subnet, 4000);
      for (const r of httpResults) {
        if (r.brand === "wled") {
          const [wState, wInfo] = await Promise.all([wledGetState(r.ip), wledGetInfo(r.ip)]);
          if (wState) discovered.push(wledDeviceFromState(r.ip, wState, wInfo));
        } else if (r.brand === "shelly") {
          const shInfo = await shellyProbe(r.ip);
          if (shInfo) {
            const relay = await shellyGetRelay(r.ip);
            discovered.push(shellyDeviceFromInfo(r.ip, shInfo, relay));
          }
        } else if (!discovered.find(d => d.ip === r.ip)) {
          discovered.push({
            id: `generic-${r.ip}-${r.port}`,
            name: `Device ${r.ip}`,
            type: "unknown",
            brand: r.brand || "generic",
            ip: r.ip, port: r.port,
            on: null, brightness: null, color: null, room: null,
            reachable: true, raw: r,
          });
        }
      }
    }
  }

  // ── Deduplicate and store ──
  const seen = new Set();
  for (const d of discovered) {
    if (seen.has(d.ip)) continue;
    seen.add(d.ip);
    // Attach appropriate control function
    switch (d.brand) {
      case "hue":   if (!d._needsPairing) d.controlFn = (cmd) => hueControl(d, cmd);   break;
      case "kasa":  d.controlFn = (cmd) => kasaControl(d, cmd);   break;
      case "wled":  d.controlFn = (cmd) => wledControl(d, cmd);   break;
      case "shelly":d.controlFn = (cmd) => shellyControl(d, cmd); break;
      default:      d.controlFn = null; break;
    }
    devices.set(d.id, d);
  }

  lastScan = Date.now();
  progress(`Scan complete. ${devices.size} device(s) in registry.`);
  return getDeviceList();
}

// ── REFRESH DEVICE STATE ──────────────────────────────────────
async function refreshStates() {
  const promises = [];
  for (const [id, device] of devices) {
    if (device.brand === "hue" && device._hueUser) {
      promises.push(
        get(device.ip, 80, `/api/${device._hueUser}/lights/${device._hueId}/`).then(r => {
          if (r.ok && r.body?.state) {
            device.on = r.body.state.on;
            device.reachable = r.body.state.reachable !== false;
            if (r.body.state.bri) device.brightness = Math.round(r.body.state.bri / 254 * 100);
          }
        }).catch(() => {})
      );
    } else if (device.brand === "wled") {
      promises.push(
        wledGetState(device.ip).then(s => {
          if (s) { device.on = s.on; device.brightness = s.bri ? Math.round(s.bri / 255 * 100) : 0; }
        }).catch(() => {})
      );
    } else if (device.brand === "shelly") {
      promises.push(
        shellyGetRelay(device.ip).then(r => {
          if (r) { device.on = r.ison; }
        }).catch(() => {})
      );
    } else if (device.brand === "kasa") {
      promises.push(
        new Promise((resolve) => {
          const data = kasaEncrypt({ system: { get_sysinfo: {} } });
          const sock = new (require("net").Socket)();
          let buf = Buffer.alloc(0);
          sock.setTimeout(2000);
          sock.connect(KASA_PORT, device.ip, () => sock.write(data));
          sock.on("data", d => { buf = Buffer.concat([buf, d]); });
          sock.on("end", () => {
            try {
              const info = JSON.parse(kasaDecrypt(buf))?.system?.get_sysinfo;
              if (info) device.on = info.relay_state === 1 || info.state === 1;
            } catch {}
            resolve();
          });
          sock.on("error", resolve);
          sock.on("timeout", () => { sock.destroy(); resolve(); });
        })
      );
    }
  }
  await Promise.all(promises);
  return getDeviceList();
}

// ── CONTROL ───────────────────────────────────────────────────
async function controlDevice(id, cmd) {
  const device = devices.get(id);
  if (!device) return { ok: false, error: "Device not found" };
  if (!device.controlFn) return { ok: false, error: "Device control not supported" };

  try {
    const result = await device.controlFn(cmd);
    // Update local state
    if (cmd.on !== undefined)  device.on = cmd.on;
    if (cmd.bri !== undefined) device.brightness = cmd.bri;
    return { ok: result, device: serializeDevice(device) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── VOICE COMMAND PARSER ──────────────────────────────────────
function parseHomeCommand(text) {
  const lower = text.toLowerCase();
  const cmd   = {};

  // On / Off
  if (/\b(turn on|switch on|lights on|enable|activate|on)\b/i.test(lower))    cmd.on = true;
  if (/\b(turn off|switch off|lights off|disable|deactivate|off)\b/i.test(lower)) cmd.on = false;

  // Brightness
  const briMatch = lower.match(/\b(\d+)\s*(?:percent|%)/);
  if (briMatch) cmd.bri = parseInt(briMatch[1]);
  if (/\bdim\b|\blow\b/i.test(lower) && cmd.bri === undefined)  cmd.bri = 20;
  if (/\bbright\b|\bfull\b|\bmax\b/i.test(lower) && cmd.bri === undefined) cmd.bri = 100;
  if (/\bhalf\b/i.test(lower) && cmd.bri === undefined)         cmd.bri = 50;

  // Color
  const colors = {
    red:    { r:255, g:0,   b:0   },
    green:  { r:0,   g:200, b:0   },
    blue:   { r:0,   g:100, b:255 },
    white:  { r:255, g:255, b:255 },
    warm:   { r:255, g:200, b:100 },
    purple: { r:180, g:0,   b:255 },
    yellow: { r:255, g:230, b:0   },
    orange: { r:255, g:140, b:0   },
    pink:   { r:255, g:80,  b:180 },
  };
  for (const [name, rgb] of Object.entries(colors)) {
    if (lower.includes(name)) { cmd.color = rgb; break; }
  }

  // Target room / name
  const roomKeywords = ["living room", "bedroom", "kitchen", "bathroom", "office",
    "hallway", "garage", "dining", "lounge", "study", "all", "everything", "everywhere"];
  for (const room of roomKeywords) {
    if (lower.includes(room)) { cmd.target = room; break; }
  }

  return cmd;
}

async function executeVoiceCommand(text, userTitle) {
  const T   = userTitle || "Sir";
  const cmd = parseHomeCommand(text);

  // No devices found
  if (devices.size === 0) {
    return `No smart devices found on the network yet, ${T}. Try saying "Jarvis scan home" first, or open the home panel.`;
  }

  // Determine target devices
  let targets = [...devices.values()].filter(d => d.controlFn && d.reachable);

  if (cmd.target && cmd.target !== "all" && cmd.target !== "everything" && cmd.target !== "everywhere") {
    const roomFilter = targets.filter(d =>
      d.room?.toLowerCase().includes(cmd.target) ||
      d.name?.toLowerCase().includes(cmd.target)
    );
    if (roomFilter.length > 0) targets = roomFilter;
  }

  if (targets.length === 0) {
    return `No controllable devices found, ${T}. The devices I've detected may not support remote control yet.`;
  }

  // Apply command
  const results = await Promise.all(targets.map(d => controlDevice(d.id, cmd)));
  const succeeded = results.filter(r => r.ok).length;

  // Generate reply
  const deviceNames = targets.slice(0, 3).map(d => d.name).join(", ");
  const extra = targets.length > 3 ? ` and ${targets.length - 3} more` : "";

  if (cmd.on === true) {
    return `Lights on, ${T}. ${deviceNames}${extra} — ${succeeded}/${targets.length} responded.`;
  } else if (cmd.on === false) {
    return `Lights off, ${T}. ${deviceNames}${extra} — ${succeeded}/${targets.length} responded.`;
  } else if (cmd.bri !== undefined) {
    return `Brightness set to ${cmd.bri}%, ${T}. ${deviceNames}${extra}.`;
  } else if (cmd.color) {
    return `Color updated, ${T}. ${deviceNames}${extra}.`;
  }
  return `Command sent to ${targets.length} device(s), ${T}. ${succeeded} responded successfully.`;
}

// ── PAIR HUE ──────────────────────────────────────────────────
async function pairHueBridge() {
  for (const [id, device] of devices) {
    if (device.brand === "hue" && device._needsPairing) {
      const user = await hueGetUsername(device.ip);
      if (user) {
        device._needsPairing = false;
        device._hueUser = user;
        // Now fetch all lights
        const lights = await hueGetLights(device.ip, user);
        for (const l of lights) {
          l.controlFn = (cmd) => hueControl(l, cmd);
          devices.set(l.id, l);
        }
        devices.delete(id);
        return { success: true, lights: lights.length, username: user };
      }
      return { success: false, error: "Link button not pressed. Press the button on the Hue bridge then try again." };
    }
  }
  return { success: false, error: "No Hue bridge found to pair." };
}

// ── SERIALIZATION ─────────────────────────────────────────────
function serializeDevice(d) {
  const { controlFn, ...safe } = d;
  return safe;
}

function getDeviceList() {
  return [...devices.values()].map(serializeDevice);
}

function getDevice(id) {
  const d = devices.get(id);
  return d ? serializeDevice(d) : null;
}

function clearDevices() {
  devices.clear();
  lastScan = 0;
}

function assignRoom(deviceId, room) {
  const d = devices.get(deviceId);
  if (!d) return false;
  d.room = room;
  return true;
}

function renameDevice(deviceId, name) {
  const d = devices.get(deviceId);
  if (!d) return false;
  d.name = name;
  return true;
}

// ── INTENT DETECTION ─────────────────────────────────────────
function isHomeCommand(text) {
  const lower = text.toLowerCase();
  const lightWords  = /\b(light|lights|lamp|lamps|bulb|bulbs|led|strip|rgb)\b/;
  const plugWords   = /\b(plug|socket|outlet|switch|power)\b/;
  const actionWords = /\b(turn on|turn off|switch on|switch off|dim|brighten|set|adjust|change|lights on|lights off)\b/;
  const homeWords   = /\b(home|room|bedroom|living room|kitchen|bathroom|office|hallway|garage|smart home|automation)\b/;
  const scanWords   = /\b(scan|discover|find devices|detect devices|search for devices)\b/;
  return lightWords.test(lower) || plugWords.test(lower) || actionWords.test(lower) ||
    (homeWords.test(lower) && /\b(turn|switch|dim|set|adjust|on|off)\b/.test(lower)) ||
    scanWords.test(lower);
}

function isHomePanelRequest(text) {
  const lower = text.toLowerCase();
  return /^home\s*$/.test(lower.trim()) ||
    /\b(open home|home panel|home control|home page|smart home|home hub|show home|bring up home)\b/i.test(lower);
}

module.exports = {
  scanNetwork,
  refreshStates,
  controlDevice,
  executeVoiceCommand,
  parseHomeCommand,
  pairHueBridge,
  getDeviceList,
  getDevice,
  clearDevices,
  assignRoom,
  renameDevice,
  isHomeCommand,
  isHomePanelRequest,
  getLocalSubnets,
  getLocalIPs,
  lastScanTime: () => lastScan,
  deviceCount:  () => devices.size,
};
