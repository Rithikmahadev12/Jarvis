"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Home Automation + Network Scanner v4.0
// Discovers: Smart plugs · Phones · Laptops · Chromebooks · TVs
//            Tablets · Printers · Routers · Any networked device
// Messaging: Send popup/notification to any device on the network
// Local network only — zero cloud APIs required
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

// ── TCP PROBE ────────────────────────────────────────────────
function tcpProbe(host, port, timeout = 600) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeout);
    s.connect(port, host, () => { s.destroy(); resolve(true); });
    s.on("error",   () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
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

// ═══════════════════════════════════════════════════════════════
// ── ARP TABLE READER — fastest way to find devices ────────────
// Reads the OS ARP cache for recently seen devices
// ═══════════════════════════════════════════════════════════════
const { exec } = require("child_process");

function readArpTable() {
  return new Promise((resolve) => {
    exec("arp -a", { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const entries = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        // Windows: "hostname (ip) at mac"
        // Linux/Mac: "? (192.168.1.1) at xx:xx:xx:xx:xx:xx"
        const ipMatch  = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/);
        const macMatch = line.match(/([0-9a-fA-F]{2}[:\-][0-9a-fA-F]{2}[:\-][0-9a-fA-F]{2}[:\-][0-9a-fA-F]{2}[:\-][0-9a-fA-F]{2}[:\-][0-9a-fA-F]{2})/);
        const hostMatch = line.match(/^([^\s(]+)/);
        if (ipMatch) {
          entries.push({
            ip:       ipMatch[1],
            mac:      macMatch ? macMatch[1].toLowerCase() : null,
            hostname: hostMatch && hostMatch[1] !== "?" ? hostMatch[1] : null,
          });
        }
      }
      resolve(entries);
    });
  });
}

// ── PING SWEEP — sends ICMP to wake up ARP cache ─────────────
function pingSweep(subnet) {
  return new Promise((resolve) => {
    // Use OS ping to sweep — works on Windows, Linux, Mac
    const isWin = process.platform === "win32";
    const pings = [];
    for (let i = 1; i <= 254; i++) {
      const ip  = subnet + i;
      const cmd = isWin ? `ping -n 1 -w 200 ${ip}` : `ping -c 1 -W 1 ${ip}`;
      pings.push(new Promise(r => exec(cmd, { timeout: 3000 }, () => r())));
    }
    Promise.all(pings).then(() => resolve());
    // Don't wait for all — resolve after 8 seconds max
    setTimeout(resolve, 8000);
  });
}

// ═══════════════════════════════════════════════════════════════
// ── MAC VENDOR LOOKUP — identify device type from MAC OUI ─────
// ═══════════════════════════════════════════════════════════════
const MAC_VENDORS = {
  // Apple
  "ac:bc:32": { brand:"Apple",   type:"phone",      icon:"📱" },
  "f0:18:98": { brand:"Apple",   type:"phone",      icon:"📱" },
  "a4:c3:f0": { brand:"Apple",   type:"phone",      icon:"📱" },
  "d8:96:95": { brand:"Apple",   type:"phone",      icon:"📱" },
  "3c:22:fb": { brand:"Apple",   type:"laptop",     icon:"💻" },
  "f4:d4:88": { brand:"Apple",   type:"laptop",     icon:"💻" },
  "a8:66:7f": { brand:"Apple",   type:"laptop",     icon:"💻" },
  "00:17:f2": { brand:"Apple",   type:"laptop",     icon:"💻" },
  // Samsung
  "8c:f5:a3": { brand:"Samsung", type:"phone",      icon:"📱" },
  "94:35:0a": { brand:"Samsung", type:"phone",      icon:"📱" },
  "b4:79:a7": { brand:"Samsung", type:"phone",      icon:"📱" },
  "cc:07:ab": { brand:"Samsung", type:"phone",      icon:"📱" },
  "50:01:bb": { brand:"Samsung", type:"tv",         icon:"📺" },
  "fc:a1:83": { brand:"Samsung", type:"tv",         icon:"📺" },
  // Google
  "f4:f5:d8": { brand:"Google",  type:"phone",      icon:"📱" },
  "3c:5a:b4": { brand:"Google",  type:"chromebook", icon:"💻" },
  "94:eb:2c": { brand:"Google",  type:"chromebook", icon:"💻" },
  "54:60:09": { brand:"Google",  type:"chromebook", icon:"💻" },
  "a4:77:33": { brand:"Google",  type:"chromecast", icon:"📺" },
  "6c:ad:f8": { brand:"Google",  type:"chromecast", icon:"📺" },
  // Amazon
  "fc:65:de": { brand:"Amazon",  type:"echo",       icon:"🔊" },
  "68:37:e9": { brand:"Amazon",  type:"echo",       icon:"🔊" },
  "74:c2:46": { brand:"Amazon",  type:"fire",       icon:"📺" },
  "f0:27:2d": { brand:"Amazon",  type:"fire",       icon:"📺" },
  // Raspberry Pi
  "b8:27:eb": { brand:"Raspberry Pi", type:"computer", icon:"🖥" },
  "dc:a6:32": { brand:"Raspberry Pi", type:"computer", icon:"🖥" },
  "e4:5f:01": { brand:"Raspberry Pi", type:"computer", icon:"🖥" },
  // TP-Link
  "50:c4:dd": { brand:"TP-Link", type:"router",     icon:"📡" },
  "14:cc:20": { brand:"TP-Link", type:"router",     icon:"📡" },
  "a0:f3:c1": { brand:"TP-Link", type:"plug",       icon:"🔌" },
  // Netgear
  "a0:04:60": { brand:"Netgear", type:"router",     icon:"📡" },
  "9c:d3:6d": { brand:"Netgear", type:"router",     icon:"📡" },
  // Asus
  "ac:22:0b": { brand:"Asus",    type:"router",     icon:"📡" },
  "04:d9:f5": { brand:"Asus",    type:"laptop",     icon:"💻" },
  // Dell
  "f8:db:88": { brand:"Dell",    type:"laptop",     icon:"💻" },
  "18:60:24": { brand:"Dell",    type:"laptop",     icon:"💻" },
  // HP
  "d8:9d:67": { brand:"HP",      type:"laptop",     icon:"💻" },
  "10:02:b5": { brand:"HP",      type:"printer",    icon:"🖨" },
  "b0:5a:da": { brand:"HP",      type:"printer",    icon:"🖨" },
  // Lenovo
  "4c:1d:96": { brand:"Lenovo",  type:"laptop",     icon:"💻" },
  "54:ee:75": { brand:"Lenovo",  type:"laptop",     icon:"💻" },
  // Sony
  "70:2b:34": { brand:"Sony",    type:"tv",         icon:"📺" },
  "ac:9b:0a": { brand:"Sony",    type:"phone",      icon:"📱" },
  // LG
  "a8:23:fe": { brand:"LG",      type:"tv",         icon:"📺" },
  "cc:2d:83": { brand:"LG",      type:"tv",         icon:"📺" },
  // OnePlus
  "8c:5f:cf": { brand:"OnePlus", type:"phone",      icon:"📱" },
  // Xiaomi
  "98:fa:e3": { brand:"Xiaomi",  type:"phone",      icon:"📱" },
  "64:09:80": { brand:"Xiaomi",  type:"phone",      icon:"📱" },
  // Nintendo
  "98:b6:e9": { brand:"Nintendo",type:"console",    icon:"🎮" },
  "00:22:aa": { brand:"Nintendo",type:"console",    icon:"🎮" },
  // Sony PlayStation
  "bc:60:a7": { brand:"PlayStation", type:"console",icon:"🎮" },
  "00:04:1f": { brand:"PlayStation", type:"console",icon:"🎮" },
  // Microsoft Xbox
  "60:45:cb": { brand:"Xbox",    type:"console",    icon:"🎮" },
  "7c:ed:8d": { brand:"Xbox",    type:"console",    icon:"🎮" },
};

function getMacVendor(mac) {
  if (!mac) return null;
  const oui = mac.replace(/[:\-]/g, "").substring(0, 6).toLowerCase();
  const key3 = oui.substring(0,2)+":"+oui.substring(2,4)+":"+oui.substring(4,6);
  return MAC_VENDORS[key3] || null;
}

// ═══════════════════════════════════════════════════════════════
// ── PORT FINGERPRINTING — figure out what a device is ─────────
// ═══════════════════════════════════════════════════════════════
const DEVICE_PORT_PROFILES = [
  { ports:[80,443],         type:"computer",  hint:"web server"    },
  { ports:[8080,8443],      type:"computer",  hint:"web app"       },
  { ports:[22],             type:"computer",  hint:"SSH"           },
  { ports:[5353],           type:"phone",     hint:"mDNS/Bonjour"  },
  { ports:[62078],          type:"phone",     hint:"iOS sync"      },
  { ports:[7000,7100],      type:"phone",     hint:"AirPlay"       },
  { ports:[8009],           type:"chromecast",hint:"Chromecast"    },
  { ports:[9100],           type:"printer",   hint:"print server"  },
  { ports:[515,631],        type:"printer",   hint:"LPD/IPP"       },
  { ports:[1883,8883],      type:"iot",       hint:"MQTT"          },
  { ports:[6668,6669],      type:"plug",      hint:"Tuya"          },
  { ports:[80],             type:"smart",     hint:"HTTP device"   },
  { ports:[554],            type:"camera",    hint:"RTSP camera"   },
  { ports:[3389],           type:"computer",  hint:"RDP"           },
  { ports:[445,139],        type:"computer",  hint:"Windows share" },
];

async function fingerprintByPorts(ip) {
  const portChecks = [22,80,139,443,445,515,554,631,1883,3389,5353,6668,7000,7100,8009,8080,8443,9100,62078];
  const openPorts = [];
  const checks = await Promise.all(portChecks.map(p => tcpProbe(ip, p, 400).then(open => open ? p : null)));
  for (const p of checks) if (p) openPorts.push(p);

  for (const profile of DEVICE_PORT_PROFILES) {
    if (profile.ports.some(p => openPorts.includes(p))) {
      return { type: profile.type, hint: profile.hint, openPorts };
    }
  }
  return { type: "unknown", hint: "no known ports", openPorts };
}

// ── HOSTNAME LOOKUP ───────────────────────────────────────────
function reverseLookup(ip) {
  return new Promise((resolve) => {
    require("dns").reverse(ip, (err, hostnames) => {
      resolve(err ? null : (hostnames[0] || null));
    });
    setTimeout(() => resolve(null), 1500);
  });
}

// ── GUESS DEVICE FROM HOSTNAME ────────────────────────────────
function guessFromHostname(hostname) {
  if (!hostname) return null;
  const lower = hostname.toLowerCase();
  if (/iphone|ipad/.test(lower))              return { type:"phone",      brand:"Apple",   icon:"📱" };
  if (/macbook|imac|mac-mini/.test(lower))    return { type:"laptop",     brand:"Apple",   icon:"💻" };
  if (/android|pixel|galaxy/.test(lower))     return { type:"phone",      brand:"Android", icon:"📱" };
  if (/chromebook|chrome/.test(lower))        return { type:"chromebook", brand:"Google",  icon:"💻" };
  if (/printer|hp|epson|canon|brother/.test(lower)) return { type:"printer",brand:"",      icon:"🖨" };
  if (/xbox/.test(lower))                     return { type:"console",    brand:"Xbox",    icon:"🎮" };
  if (/playstation|ps4|ps5/.test(lower))      return { type:"console",    brand:"Sony",    icon:"🎮" };
  if (/switch/.test(lower))                   return { type:"console",    brand:"Nintendo",icon:"🎮" };
  if (/tv|television|bravia|vizio/.test(lower)) return { type:"tv",       brand:"",        icon:"📺" };
  if (/router|gateway|netgear|asus|tplink/.test(lower)) return { type:"router", brand:"",  icon:"📡" };
  if (/echo|alexa|dot/.test(lower))           return { type:"echo",       brand:"Amazon",  icon:"🔊" };
  if (/raspberry|pi/.test(lower))             return { type:"computer",   brand:"RPi",     icon:"🖥" };
  return null;
}

// ── HTTP FINGERPRINT — read server headers ────────────────────
async function httpFingerprint(ip) {
  const res = await get(ip, 80, "/", 1500);
  if (!res.ok) return null;
  const raw = (res.raw || "").toLowerCase();
  if (raw.includes("chromebook")) return { type:"chromebook", brand:"Google" };
  if (raw.includes("android"))    return { type:"phone",      brand:"Android" };
  if (raw.includes("roku"))       return { type:"tv",         brand:"Roku" };
  if (raw.includes("synology"))   return { type:"nas",        brand:"Synology" };
  if (raw.includes("qnap"))       return { type:"nas",        brand:"QNAP" };
  if (raw.includes("printer"))    return { type:"printer",    brand:"" };
  return null;
}

// ═══════════════════════════════════════════════════════════════
// ── MAIN DEVICE PROBE — everything we know about an IP ────────
// ═══════════════════════════════════════════════════════════════
async function probeDevice(ip, mac, hostname) {
  const [portInfo, dnsName, httpInfo] = await Promise.all([
    fingerprintByPorts(ip),
    hostname ? Promise.resolve(hostname) : reverseLookup(ip),
    httpFingerprint(ip),
  ]);

  const macInfo      = getMacVendor(mac);
  const hostnameInfo = guessFromHostname(dnsName);

  // Priority: MAC vendor > hostname > HTTP > port
  const info = macInfo || hostnameInfo || httpInfo || {};

  const type  = info.type  || portInfo.type  || "unknown";
  const brand = info.brand || "";
  const icon  = info.icon  || typeToIcon(type);

  const name = buildDeviceName(brand, type, dnsName, ip);

  return {
    id:         `device-${ip.replace(/\./g,"-")}`,
    ip,
    mac:        mac || null,
    hostname:   dnsName || null,
    name,
    type,
    brand,
    icon,
    openPorts:  portInfo.openPorts,
    hint:       portInfo.hint,
    reachable:  true,
    online:     true,
    lastSeen:   Date.now(),
    // Messaging capability — any device with port 80 or known messaging ports
    canMessage: portInfo.openPorts.length > 0,
    isSmartPlug: type === "plug",
    on:         null,
    brightness: null,
    color:      null,
    room:       null,
    _raw:       { macInfo, hostnameInfo, httpInfo, portInfo },
  };
}

function typeToIcon(type) {
  const map = {
    phone:"📱", laptop:"💻", chromebook:"💻", computer:"🖥",
    tablet:"📱", tv:"📺", printer:"🖨", router:"📡",
    console:"🎮", echo:"🔊", chromecast:"📺", camera:"📹",
    nas:"💾", iot:"⚡", plug:"🔌", smart:"💡", unknown:"⬡"
  };
  return map[type] || "⬡";
}

function buildDeviceName(brand, type, hostname, ip) {
  if (hostname && hostname !== ip && !hostname.startsWith("?")) {
    // Clean up hostname
    const clean = hostname.replace(/\.local$|\.home$|\.lan$/i,"");
    if (brand) return `${brand} — ${clean}`;
    return clean;
  }
  const typeLabels = {
    phone:"Phone", laptop:"Laptop", chromebook:"Chromebook",
    computer:"Computer", tablet:"Tablet", tv:"Smart TV",
    printer:"Printer", router:"Router", console:"Game Console",
    echo:"Smart Speaker", chromecast:"Chromecast", camera:"Camera",
    nas:"NAS Drive", plug:"Smart Plug", unknown:"Device"
  };
  const label = typeLabels[type] || "Device";
  if (brand) return `${brand} ${label} (${ip})`;
  return `${label} (${ip})`;
}

// ═══════════════════════════════════════════════════════════════
// ── MESSAGING SYSTEM ─────────────────────────────────────────
// Sends a message/notification to a device on the network
// Methods tried in order:
//   1. JARVIS web notification (if device has JARVIS running)
//   2. Windows NetSend / MSG command
//   3. HTTP POST to known notification endpoints
//   4. JARVIS comms socket message
// ═══════════════════════════════════════════════════════════════

// Store for pending messages per IP
const pendingMessages = new Map();

async function sendMessageToDevice(deviceId, message, from) {
  const device = devices.get(deviceId);
  if (!device) return { ok: false, error: "Device not found" };

  const ip  = device.ip;
  const results = [];

  // Method 1: JARVIS notification endpoint (if they have JARVIS running)
  try {
    const res = await post(ip, 3000, "/api/notify", {
      message, from: from || "J.A.R.V.I.S", type: "jarvis"
    }, 2000);
    if (res.ok) {
      results.push({ method:"jarvis", ok:true });
      return { ok: true, method: "jarvis", device: serializeDevice(device) };
    }
  } catch {}

  // Method 2: Queue it for pickup (if device has a browser open on JARVIS)
  if (!pendingMessages.has(ip)) pendingMessages.set(ip, []);
  pendingMessages.get(ip).push({
    id:        `msg-${Date.now()}`,
    message,
    from:      from || "J.A.R.V.I.S",
    timestamp: Date.now(),
    read:      false,
  });

  // Method 3: Try Windows MSG command (works on Windows local network)
  const { exec } = require("child_process");
  if (process.platform === "win32") {
    await new Promise(r => {
      exec(`msg /server:${ip} * "${message.replace(/"/g,"'")}"`, { timeout: 3000 }, (err) => {
        if (!err) results.push({ method:"winmsg", ok:true });
        r();
      });
    });
    if (results.find(r => r.ok)) return { ok:true, method:"winmsg", device: serializeDevice(device) };
  }

  // Method 4: Try common HTTP notification endpoints
  const notifPaths = [
    { port:8080, path:"/notify"           },
    { port:80,   path:"/api/message"      },
    { port:80,   path:"/notify"           },
    { port:9000, path:"/message"          },
  ];
  for (const { port, path } of notifPaths) {
    try {
      const res = await post(ip, port, path, { message, from: from || "J.A.R.V.I.S" }, 1500);
      if (res.ok) {
        results.push({ method:`http:${port}${path}`, ok:true });
        return { ok:true, method:`http:${port}`, device: serializeDevice(device) };
      }
    } catch {}
  }

  // Always succeeds — message is queued and will show if they open JARVIS in browser
  return {
    ok:      true,
    method:  "queued",
    queued:  true,
    note:    "Message queued — will appear if device opens JARVIS in browser",
    device:  serializeDevice(device),
  };
}

// ── GET PENDING MESSAGES FOR AN IP ────────────────────────────
function getPendingMessages(ip) {
  const msgs = pendingMessages.get(ip) || [];
  // Mark as read
  if (msgs.length) {
    pendingMessages.set(ip, msgs.map(m => ({ ...m, read:true })));
  }
  return msgs;
}

// ── BROADCAST MESSAGE TO ALL DEVICES ─────────────────────────
async function broadcastMessage(message, from) {
  const results = [];
  for (const [id] of devices) {
    const r = await sendMessageToDevice(id, message, from);
    results.push({ id, ...r });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// ── SMART PLUG CONTROL (existing brands) ─────────────────────
// ═══════════════════════════════════════════════════════════════

// ── TP-LINK KASA ─────────────────────────────────────────────
const KASA_PORT = 9999;
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

// ── WLED ─────────────────────────────────────────────────────
async function wledControl(device, cmd) {
  const body = {};
  if (cmd.on  !== undefined) body.on  = cmd.on;
  if (cmd.bri !== undefined) body.bri = Math.round(cmd.bri / 100 * 255);
  const res = await post(device.ip, 80, "/json/state", body);
  return res.ok;
}

// ── SHELLY ────────────────────────────────────────────────────
async function shellyControl(device, cmd) {
  const res = await get(device.ip, 80, `/relay/0?turn=${cmd.on ? "on" : "off"}`);
  return res.ok;
}

// ── PHILIPS HUE ──────────────────────────────────────────────
async function hueControl(device, cmd) {
  const state = {};
  if (cmd.on  !== undefined) state.on  = cmd.on;
  if (cmd.bri !== undefined) state.bri = Math.round(cmd.bri / 100 * 254);
  const res = await put(device.ip, 80, `/api/${device._hueUser}/lights/${device._hueId}/state`, state);
  return res.ok;
}

// ═══════════════════════════════════════════════════════════════
// ── SSDP SCAN (Hue, WLED, Shelly) ────────────────────────────
// ═══════════════════════════════════════════════════════════════
function ssdpScan(timeout = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    const done = () => { try { sock && sock.close(); } catch {} resolve([...found.values()]); };
    const timer = setTimeout(done, timeout);
    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.on("error", () => { clearTimeout(timer); resolve([]); });
      sock.on("message", (buf, rinfo) => {
        if (!found.has(rinfo.address)) found.set(rinfo.address, { ip: rinfo.address, raw: buf.toString() });
      });
      sock.bind(0, () => {
        try { sock.setBroadcast(true); } catch {}
        const msearch = ["M-SEARCH * HTTP/1.1","HOST: 239.255.255.255:1900",'MAN: "ssdp:discover"',"MX: 3","ST: ssdp:all","",""].join("\r\n");
        const buf = Buffer.from(msearch);
        sock.send(buf, 0, buf.length, 1900, "239.255.255.255");
        getLocalSubnets().forEach(s => { try { sock.send(buf, 0, buf.length, 1900, s + "255"); } catch {} });
      });
    } catch { clearTimeout(timer); resolve([]); }
  });
}

// ── KASA UDP SCAN ─────────────────────────────────────────────
async function kasaUDPScan(timeout = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    const done = () => { try { sock && sock.close(); } catch {} resolve([...found.values()]); };
    const timer = setTimeout(done, timeout);
    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.on("error", () => { clearTimeout(timer); resolve([]); });
      sock.on("message", (buf, rinfo) => {
        try { const text = kasaDecrypt(buf); const json = JSON.parse(text); const info = json?.system?.get_sysinfo; if (info) found.set(rinfo.address, { ip: rinfo.address, info }); } catch {}
      });
      sock.bind(0, () => {
        sock.setBroadcast(true);
        const msg = kasaEncrypt({ system: { get_sysinfo: {} } });
        sock.send(msg, KASA_PORT, "255.255.255.255");
        getLocalSubnets().forEach(s => { try { sock.send(msg, KASA_PORT, s + "255"); } catch {} });
      });
    } catch { clearTimeout(timer); resolve([]); }
  });
}

// ═══════════════════════════════════════════════════════════════
// ── MAIN SCAN ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
async function scanNetwork(options = {}) {
  const { onProgress = null } = options;
  const progress = (msg) => { if (onProgress) onProgress(msg); else console.log(`[HOME] ${msg}`); };
  const discovered = [];
  const seenIPs = new Set();

  progress("Starting full network scan…");

  // ── Step 1: Ping sweep to populate ARP cache ──
  const subnets = getLocalSubnets();
  progress(`Sweeping ${subnets.length} subnet(s)…`);
  await Promise.all(subnets.map(s => pingSweep(s)));

  // ── Step 2: Read ARP table ──
  progress("Reading ARP table…");
  const arpEntries = await readArpTable();
  progress(`ARP table: ${arpEntries.length} entries found`);

  // ── Step 3: SSDP multicast ──
  progress("SSDP multicast…");
  const ssdpResults = await ssdpScan(3000);
  progress(`SSDP: ${ssdpResults.length} device(s) responded`);

  // ── Step 4: Kasa UDP ──
  progress("TP-Link Kasa scan…");
  const kasaResults = await kasaUDPScan(2500);
  if (kasaResults.length) progress(`Kasa: ${kasaResults.length} plug(s) found`);

  // ── Collect all known IPs ──
  const allIPs = new Map();
  for (const entry of arpEntries) allIPs.set(entry.ip, entry);
  for (const s of ssdpResults)    if (!allIPs.has(s.ip)) allIPs.set(s.ip, { ip: s.ip, mac: null, hostname: null });
  for (const k of kasaResults)    if (!allIPs.has(k.ip)) allIPs.set(k.ip, { ip: k.ip, mac: null, hostname: null });

  // Skip local machine IPs
  const localIPs = new Set(getLocalIPs());
  for (const localIP of localIPs) allIPs.delete(localIP);

  progress(`Probing ${allIPs.size} device(s)…`);

  // ── Step 5: Probe each IP ──
  const probePromises = [];
  for (const [ip, entry] of allIPs) {
    probePromises.push(probeDevice(ip, entry.mac, entry.hostname));
  }
  const probed = await Promise.all(probePromises);

  for (const d of probed) {
    if (!d || seenIPs.has(d.ip)) continue;
    seenIPs.add(d.ip);

    // Check if it's a Kasa plug
    const kasaEntry = kasaResults.find(k => k.ip === d.ip);
    if (kasaEntry) {
      d.type  = "plug";
      d.brand = "TP-Link Kasa";
      d.icon  = "🔌";
      d.name  = kasaEntry.info.alias || d.name;
      d.on    = kasaEntry.info.relay_state === 1;
      d.controlFn = (cmd) => kasaControl(d, cmd);
    }

    // Check SSDP hits for WLED/Shelly/Hue
    const ssdpEntry = ssdpResults.find(s => s.ip === d.ip);
    if (ssdpEntry) {
      const raw = (ssdpEntry.raw || "").toLowerCase();
      if (raw.includes("wled")) {
        d.type  = "smart"; d.brand = "WLED"; d.icon = "💡";
        d.controlFn = (cmd) => wledControl(d, cmd);
      } else if (raw.includes("shelly")) {
        d.type  = "plug"; d.brand = "Shelly"; d.icon = "🔌";
        d.controlFn = (cmd) => shellyControl(d, cmd);
      }
    }

    // Messaging function for all devices
    d.messageFn = (msg, from) => sendMessageToDevice(d.id, msg, from);

    devices.set(d.id, d);
    discovered.push(d);
  }

  lastScan = Date.now();
  progress(`Scan complete — ${discovered.length} device(s) found`);
  return getDeviceList();
}

// ── CONTROL DEVICE ────────────────────────────────────────────
async function controlDevice(id, cmd) {
  const device = devices.get(id);
  if (!device) return { ok: false, error: "Device not found" };
  if (!device.controlFn) return { ok: false, error: "Device does not support control" };
  try {
    const result = await device.controlFn(cmd);
    if (cmd.on  !== undefined) device.on = cmd.on;
    if (cmd.bri !== undefined) device.brightness = cmd.bri;
    return { ok: result, device: serializeDevice(device) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── VOICE COMMAND PARSER ──────────────────────────────────────
function parseHomeCommand(text) {
  const lower = text.toLowerCase();
  const cmd = {};
  if (/\b(turn on|switch on|lights on|enable|on)\b/i.test(lower))  cmd.on = true;
  if (/\b(turn off|switch off|lights off|disable|off)\b/i.test(lower)) cmd.on = false;
  const briMatch = lower.match(/\b(\d+)\s*(?:percent|%)/);
  if (briMatch) cmd.bri = parseInt(briMatch[1]);
  if (/\bdim\b|\blow\b/i.test(lower) && cmd.bri === undefined)   cmd.bri = 20;
  if (/\bbright\b|\bfull\b|\bmax\b/i.test(lower) && cmd.bri === undefined) cmd.bri = 100;
  const rooms = ["living room","bedroom","kitchen","bathroom","office","hallway","garage","dining","all","everywhere"];
  for (const room of rooms) if (lower.includes(room)) { cmd.target = room; break; }
  return cmd;
}

async function executeVoiceCommand(text, userTitle) {
  const T = userTitle || "Sir";
  const cmd = parseHomeCommand(text);
  if (devices.size === 0) return `No devices found yet, ${T}. Try saying "Jarvis scan home" first.`;
  let targets = [...devices.values()].filter(d => d.controlFn && d.reachable);
  if (cmd.target && cmd.target !== "all" && cmd.target !== "everywhere") {
    const roomFilter = targets.filter(d => d.room?.toLowerCase().includes(cmd.target) || d.name?.toLowerCase().includes(cmd.target));
    if (roomFilter.length > 0) targets = roomFilter;
  }
  if (targets.length === 0) return `No controllable devices found, ${T}.`;
  const results = await Promise.all(targets.map(d => controlDevice(d.id, cmd)));
  const ok = results.filter(r => r.ok).length;
  if (cmd.on === true)  return `Turning on ${targets.length} device(s), ${T}. ${ok}/${targets.length} responded.`;
  if (cmd.on === false) return `Turning off ${targets.length} device(s), ${T}. ${ok}/${targets.length} responded.`;
  if (cmd.bri !== undefined) return `Brightness set to ${cmd.bri}%, ${T}.`;
  return `Command sent to ${targets.length} device(s), ${T}.`;
}

// ── UTILS ─────────────────────────────────────────────────────
function serializeDevice(d) {
  const { controlFn, messageFn, _raw, ...safe } = d;
  safe.canControl = !!d.controlFn;
  safe.canMessage = true;
  return safe;
}
function getDeviceList()    { return [...devices.values()].map(serializeDevice); }
function getDevice(id)      { const d = devices.get(id); return d ? serializeDevice(d) : null; }
function clearDevices()     { devices.clear(); lastScan = 0; }
function assignRoom(id, room)   { const d = devices.get(id); if (!d) return false; d.room = room; return true; }
function renameDevice(id, name) { const d = devices.get(id); if (!d) return false; d.name = name; return true; }
function isHomeCommand(text) {
  const lower = text.toLowerCase();
  // "turn on"/"turn off"/"power"/"switch" below are bare enough that phrases
  // like "turn on camera mode" or "switch on the camera" match them purely by
  // accident — that's the built-in webcam, not a smart-home device. Bail out
  // of home-command routing for ANY camera phrasing unless the user actually
  // names a real smart-home camera by location (e.g. "driveway camera"),
  // which is the one legitimate case control_home should still handle.
  if (/\bcamera\b/.test(lower)) {
    const namesLocation = /\b(driveway|garage|front door|back ?yard|porch|baby|nursery|living room|bedroom|office|kitchen|hallway|entrance)\s+camera\b/.test(lower);
    if (!namesLocation) return false;
  }
  return /\b(light|lights|lamp|bulb|plug|socket|outlet|switch|power|turn on|turn off|dim|brighten|smart home|scan|discover|find devices)\b/.test(lower);
}
function isHomePanelRequest(t)  { return /^home\s*$/.test(t.toLowerCase().trim()) || /\b(open home|home panel|home control|smart home|home hub|show home)\b/i.test(t); }

module.exports = {
  scanNetwork, controlDevice, executeVoiceCommand, parseHomeCommand,
  sendMessageToDevice, broadcastMessage, getPendingMessages,
  getDeviceList, getDevice, clearDevices, assignRoom, renameDevice,
  isHomeCommand, isHomePanelRequest, getLocalSubnets, getLocalIPs,
  lastScanTime: () => lastScan,
  deviceCount:  () => devices.size,
};
