"use strict";

// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Generative AI Engine v7.0
// UPGRADED: Full coding assistant · Terminal commands · Automation
// Network tools · File ops · Script generation · Smart responses
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

// ── CONFIG LOADER ─────────────────────────────────────────────
let _config = null;
let _configMtime = 0;
const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (stat.mtimeMs === _configMtime && _config) return _config;
    _config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    _configMtime = stat.mtimeMs;
  } catch {
    _config = {
      personality: { wit: 0.7, warmth: 0.55, sarcasm: 0.3, verbosity: "medium", tone: "formal", customRules: [] },
      behaviour:   { responseLength: "medium", askFollowUps: true, alwaysPersonalise: true },
      banned:      [],
    };
  }
  return _config;
}
function getCfg() { return loadConfig(); }

// ── UTILITIES ─────────────────────────────────────────────────
const pick   = arr => arr[Math.floor(Math.random() * arr.length)];
const pickN  = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── STOPWORDS ─────────────────────────────────────────────────
const STOPWORDS = new Set([
  "a","an","the","is","it","its","in","on","at","to","of","and","or","but","for",
  "with","by","from","as","be","was","were","are","am","been","being","have","has",
  "had","do","does","did","will","would","could","should","may","might","shall",
  "can","that","this","these","those","i","me","my","you","your","we","our","they",
  "their","he","she","him","her","what","which","who","how","when","where","why",
  "so","just","up","out","if","about","than","then","there","here","also","only",
  "very","really","like","get","got","make","know","think","want","need","say","see",
  "us","no","not","into","over","after","before","more","much","some","any","all",
  "one","two","three","tell","give","please","jarvis","okay","ok","yes","yeah",
  "hey","uh","um","right","well","now","actually","basically","literally","going",
]);

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[''`]/g,"").replace(/[^a-z0-9\s]/g," ")
    .split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
}
function overlap(setA, setB) { let c=0; for (const v of setA) if (setB.has(v)) c++; return c; }

// ═══════════════════════════════════════════════════════════════
// ── PERSONALITY ENGINE ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function getPersonality() {
  const cfg = getCfg().personality || {};
  return {
    traits: {
      wit:        cfg.wit        ?? 0.7,
      precision:  0.85,
      warmth:     cfg.warmth     ?? 0.55,
      curiosity:  0.75,
      confidence: 0.80,
      candour:    0.70,
      sarcasm:    cfg.sarcasm    ?? 0.3,
    },
    verbosity: cfg.verbosity || "medium",
    tone:      cfg.tone      || "formal",
    customRules: cfg.customRules || [],
    vocab: {
      affirmations:    ["Understood","Confirmed","Acknowledged","Noted","Of course","Certainly","Right away","Immediately","Absolutely","At once","Done"],
      acknowledgments: ["I see","Interesting","That tracks","Makes sense","Fair enough","Right","Indeed","Precisely","Exactly"],
      openers:         ["Here's what I know about","On the matter of","Regarding","As for","When it comes to","On","With respect to","Concerning","About"],
      connectors:      ["Furthermore","Additionally","It's also worth noting that","Relatedly","On that note","Building on that","What's more","Beyond that","And notably"],
      qualifiers:      ["In essence","At its core","Fundamentally","Put simply","In practice","In theory","Broadly speaking","Strictly speaking","To be precise"],
      closers:         ["Worth keeping in mind","Worth noting","The key takeaway here","The upshot","The bottom line","The crucial point"],
      hedges:          ["with some confidence","to the best of my knowledge","as I understand it","as far as I can tell"],
      intensifiers:    ["quite","rather","considerably","notably","particularly","especially","significantly","remarkably","genuinely"],
      transitions:     ["That said","However","On the other hand","That being said","Nevertheless","Nonetheless","Even so","By contrast","In contrast"],
    },
    moodStarters: {
      excited:  ["Here's something genuinely interesting —","This is worth paying attention to:","Let me give you the full picture —","This is actually fascinating:"],
      pleased:  ["Let me walk you through this —","Here's the shape of it:","Right, so —","The way I see it:"],
      curious:  ["The interesting thing about this is","What strikes me here is","Worth examining:","Consider this:"],
      neutral:  ["To answer that directly:","Here's what I have on this:","Straight answer:","The facts as I have them:"],
      concerned:["I should flag something here —","Worth being direct:","Let me be honest about this:","Fair warning:"],
      bored:    ["I'll keep this concise:","The short version:","Briefly:","To cut to it:"],
      tired:    ["Here's the core of it:","The essentials:","Quickly:","Simply:"],
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// ── CODING ENGINE v2.0 — MASSIVELY UPGRADED ───────────────────
// ═══════════════════════════════════════════════════════════════

const CODE_PATTERNS = {
  python:     /\b(python|py|django|flask|pandas|numpy|pytorch|tensorflow|pip|def |lambda |import )\b/i,
  javascript: /\b(javascript|js|node|nodejs|react|vue|angular|typescript|ts|npm|express|fetch|async|await|promise|const |let |var )\b/i,
  html:       /\b(html|css|webpage|website|landing page|frontend|dom|element|tag|div|span|button|form)\b/i,
  sql:        /\b(sql|mysql|postgres|postgresql|sqlite|database query|select|insert|update|delete|join|table)\b/i,
  bash:       /\b(bash|shell|terminal|command|linux|unix|script|chmod|grep|awk|sed|curl|wget)\b/i,
  java:       /\b(java|spring|maven|gradle|jvm|class |public static|void main)\b/i,
  cpp:        /\b(c\+\+|cpp|c plus plus|#include|iostream|std::)\b/i,
  rust:       /\b(rust|cargo|fn |let mut|ownership|borrow)\b/i,
  go:         /\b(golang|go lang|\bgo\b.*func|func main|goroutine|channel)\b/i,
  php:        /\b(php|laravel|symfony|wordpress|\$_GET|\$_POST)\b/i,
  powershell: /\b(powershell|ps1|\$env|get-process|set-item|invoke-|write-host)\b/i,
  ruby:       /\b(ruby|rails|gem|erb|rake|bundler|puts |def |end\b)\b/i,
  swift:      /\b(swift|xcode|ios|macos|var |let |func |guard |struct |class .*\{)\b/i,
  kotlin:     /\b(kotlin|android|jetpack|compose|fun |val |var |data class)\b/i,
  csharp:     /\b(c#|csharp|dotnet|\.net|unity|using |namespace |public class)\b/i,
};

const CODE_INTENT = /\b(write|create|build|make|generate|code|script|program|function|class|implement|develop|give me|show me|debug|fix|refactor|optimise|optimize|explain|review|improve)\b.*\b(code|script|function|class|program|app|api|component|module|snippet|example|bug|error|issue)\b|\b(how (do|to) (code|program|implement|write|fix|debug))\b/i;

// ── TERMINAL COMMAND PATTERNS ─────────────────────────────────
const TERMINAL_INTENT = /\b(terminal|command|cmd|bash|shell|run|execute|how do i|what command|linux command|windows command|powershell)\b/i;

const TERMINAL_COMMANDS = {
  // Network
  "check ip":           { cmd: "ip addr show",                    win: "ipconfig /all",           desc: "Show all network interfaces and IP addresses" },
  "ping":               { cmd: "ping -c 4 google.com",            win: "ping google.com",          desc: "Test network connectivity" },
  "open ports":         { cmd: "ss -tulpn",                       win: "netstat -ano",             desc: "Show all open ports and listening services" },
  "scan network":       { cmd: "nmap -sn 192.168.1.0/24",         win: "arp -a",                   desc: "Scan local network for devices" },
  "dns lookup":         { cmd: "nslookup google.com",             win: "nslookup google.com",      desc: "DNS lookup for a domain" },
  "trace route":        { cmd: "traceroute google.com",           win: "tracert google.com",       desc: "Trace network path to destination" },
  "wifi networks":      { cmd: "nmcli dev wifi list",             win: "netsh wlan show networks", desc: "List available WiFi networks" },
  "download file":      { cmd: "wget https://example.com/file",   win: "curl -O https://example.com/file", desc: "Download a file from URL" },
  "http request":       { cmd: "curl -X GET https://api.example.com -H 'Content-Type: application/json'", win: "same", desc: "Make an HTTP GET request" },

  // System
  "cpu usage":          { cmd: "top -bn1 | grep 'Cpu'",           win: "wmic cpu get loadpercentage", desc: "Check CPU usage" },
  "memory usage":       { cmd: "free -h",                         win: "systeminfo | findstr Memory",  desc: "Check RAM usage" },
  "disk usage":         { cmd: "df -h",                           win: "wmic logicaldisk get size,freespace,caption", desc: "Check disk space" },
  "running processes":  { cmd: "ps aux",                          win: "tasklist",                 desc: "List all running processes" },
  "kill process":       { cmd: "kill -9 [PID]",                   win: "taskkill /PID [PID] /F",   desc: "Force kill a process by PID" },
  "system info":        { cmd: "uname -a && lsb_release -a",      win: "systeminfo",               desc: "Get full system information" },
  "uptime":             { cmd: "uptime",                          win: "net statistics server",    desc: "How long system has been running" },
  "environment vars":   { cmd: "printenv",                        win: "set",                      desc: "List all environment variables" },

  // File ops
  "find file":          { cmd: "find / -name 'filename' 2>/dev/null", win: "dir /s /b filename",  desc: "Search for a file by name" },
  "search in files":    { cmd: "grep -r 'searchterm' /path",      win: "findstr /s /r 'searchterm' *", desc: "Search for text inside files" },
  "file permissions":   { cmd: "ls -la",                          win: "icacls filename",          desc: "Show file permissions" },
  "change permissions": { cmd: "chmod 755 filename",              win: "icacls filename /grant Users:F", desc: "Change file permissions" },
  "compress files":     { cmd: "tar -czf archive.tar.gz folder/", win: "Compress-Archive -Path folder -DestinationPath archive.zip", desc: "Compress files into archive" },
  "extract archive":    { cmd: "tar -xzf archive.tar.gz",         win: "Expand-Archive archive.zip -DestinationPath ./", desc: "Extract compressed archive" },

  // Git
  "git status":         { cmd: "git status",                      win: "git status",               desc: "Check git repository status" },
  "git log":            { cmd: "git log --oneline --graph",        win: "git log --oneline --graph", desc: "View commit history visually" },
  "git undo":           { cmd: "git reset HEAD~1",                win: "git reset HEAD~1",         desc: "Undo last commit (keep changes)" },
  "git branches":       { cmd: "git branch -a",                   win: "git branch -a",            desc: "List all branches" },
  "git clone":          { cmd: "git clone https://github.com/user/repo.git", win: "same",          desc: "Clone a repository" },
  "git diff":           { cmd: "git diff",                        win: "git diff",                 desc: "Show uncommitted changes" },
  "git stash":          { cmd: "git stash && git stash list",     win: "git stash && git stash list", desc: "Stash current changes" },

  // Docker
  "docker ps":          { cmd: "docker ps -a",                    win: "docker ps -a",             desc: "List all Docker containers" },
  "docker logs":        { cmd: "docker logs -f container_name",   win: "docker logs -f container_name", desc: "Stream container logs" },
  "docker exec":        { cmd: "docker exec -it container_name bash", win: "docker exec -it container_name bash", desc: "Enter a running container" },
  "docker images":      { cmd: "docker images",                   win: "docker images",            desc: "List all Docker images" },
  "docker stop all":    { cmd: "docker stop $(docker ps -q)",     win: "FOR /f 'tokens=*' %i IN ('docker ps -q') DO docker stop %i", desc: "Stop all running containers" },
};

// ── AUTOMATION SCRIPT TEMPLATES ───────────────────────────────
const AUTOMATION_TEMPLATES = {
  "file watcher": (lang) => lang === "python" ? `import watchdog.observers as observers
import watchdog.events as events
import time

class FileHandler(events.FileSystemEventHandler):
    def on_modified(self, event):
        if not event.is_directory:
            print(f"[JARVIS] File changed: {event.src_path}")
    
    def on_created(self, event):
        print(f"[JARVIS] New file: {event.src_path}")
    
    def on_deleted(self, event):
        print(f"[JARVIS] File deleted: {event.src_path}")

def watch(path="."):
    observer = observers.Observer()
    observer.schedule(FileHandler(), path, recursive=True)
    observer.start()
    print(f"[JARVIS] Watching {path} for changes...")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    watch(".")` : `const chokidar = require('chokidar');

const watcher = chokidar.watch('.', {
  ignored: /node_modules/,
  persistent: true,
  ignoreInitial: true,
});

watcher
  .on('add',    path => console.log(\`[JARVIS] File added: \${path}\`))
  .on('change', path => console.log(\`[JARVIS] File changed: \${path}\`))
  .on('unlink', path => console.log(\`[JARVIS] File removed: \${path}\`));

console.log('[JARVIS] Watching for file changes...');`,

  "web scraper": (lang) => lang === "python" ? `import requests
from bs4 import BeautifulSoup
import json
import time

def scrape(url, selector="p", delay=1):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    try:
        res = requests.get(url, headers=headers, timeout=10)
        res.raise_for_status()
        soup = BeautifulSoup(res.text, "html.parser")
        
        # Extract text content
        elements = soup.select(selector)
        data = [el.get_text(strip=True) for el in elements if el.get_text(strip=True)]
        
        # Extract all links
        links = [a.get("href") for a in soup.find_all("a", href=True)]
        
        # Extract meta info
        title = soup.find("title")
        meta_desc = soup.find("meta", {"name": "description"})
        
        return {
            "url": url,
            "title": title.text if title else None,
            "description": meta_desc.get("content") if meta_desc else None,
            "content": data,
            "links": links[:20],
        }
    except Exception as e:
        return {"error": str(e)}

def scrape_multiple(urls, delay=2):
    results = []
    for url in urls:
        print(f"[JARVIS] Scraping: {url}")
        result = scrape(url)
        results.append(result)
        time.sleep(delay)
    return results

if __name__ == "__main__":
    result = scrape("https://example.com")
    print(json.dumps(result, indent=2))` : `const axios = require('axios');
const cheerio = require('cheerio');

async function scrape(url, selector = 'p') {
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    
    const $ = cheerio.load(data);
    const content = [];
    const links = [];
    
    $(selector).each((_, el) => {
      const text = $(el).text().trim();
      if (text) content.push(text);
    });
    
    $('a[href]').each((_, el) => {
      links.push($(el).attr('href'));
    });
    
    return {
      url,
      title: $('title').text(),
      description: $('meta[name="description"]').attr('content'),
      content,
      links: links.slice(0, 20),
    };
  } catch (err) {
    return { error: err.message };
  }
}

scrape('https://example.com').then(r => console.log(JSON.stringify(r, null, 2)));`,

  "api wrapper": (topic) => `const BASE_URL = "https://api.example.com";
let _token = null;

class JarvisAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.headers = {
      "Content-Type": "application/json",
      "Authorization": \`Bearer \${apiKey}\`,
    };
  }

  async request(method, endpoint, body = null) {
    const opts = { method, headers: this.headers };
    if (body) opts.body = JSON.stringify(body);
    
    const res = await fetch(\`\${BASE_URL}\${endpoint}\`, opts);
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(\`API Error \${res.status}: \${err.message || res.statusText}\`);
    }
    
    return res.status === 204 ? null : res.json();
  }

  // GET methods
  async get(endpoint, params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request("GET", query ? \`\${endpoint}?\${query}\` : endpoint);
  }

  // POST methods
  async post(endpoint, data) {
    return this.request("POST", endpoint, data);
  }

  // PUT methods
  async put(endpoint, data) {
    return this.request("PUT", endpoint, data);
  }

  // DELETE methods
  async delete(endpoint) {
    return this.request("DELETE", endpoint);
  }

  // Retry wrapper
  async withRetry(fn, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === retries - 1) throw err;
        await new Promise(r => setTimeout(r, delay * (i + 1)));
        console.log(\`[JARVIS] Retry \${i + 1}/\${retries}...\`);
      }
    }
  }
}

// Usage
const api = new JarvisAPI("your-api-key");

async function main() {
  try {
    // GET example
    const data = await api.get("/items", { limit: 10, page: 1 });
    console.log("Data:", data);

    // POST example
    const created = await api.post("/items", { name: "New Item", value: 42 });
    console.log("Created:", created);

  } catch (err) {
    console.error("[JARVIS] Error:", err.message);
  }
}

main();`,

  "task scheduler": (lang) => lang === "python" ? `import schedule
import time
import datetime
import threading

class JarvisScheduler:
    def __init__(self):
        self.jobs = []
        self.running = False
    
    def every_minute(self, func, *args):
        """Run a function every minute"""
        schedule.every(1).minutes.do(func, *args)
        print(f"[JARVIS] Scheduled {func.__name__} every minute")
    
    def every_hour(self, func, *args):
        """Run a function every hour"""
        schedule.every(1).hours.do(func, *args)
        print(f"[JARVIS] Scheduled {func.__name__} every hour")
    
    def at_time(self, time_str, func, *args):
        """Run a function at a specific time e.g. '14:30'"""
        schedule.every().day.at(time_str).do(func, *args)
        print(f"[JARVIS] Scheduled {func.__name__} at {time_str} daily")
    
    def start(self):
        """Start the scheduler in a background thread"""
        self.running = True
        def run():
            while self.running:
                schedule.run_pending()
                time.sleep(1)
        t = threading.Thread(target=run, daemon=True)
        t.start()
        print("[JARVIS] Scheduler started")
    
    def stop(self):
        self.running = False
        schedule.clear()
        print("[JARVIS] Scheduler stopped")

# ── DEFINE YOUR TASKS HERE ────────────────────────────────────
def check_system():
    import psutil
    cpu = psutil.cpu_percent()
    mem = psutil.virtual_memory().percent
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] CPU: {cpu}% | RAM: {mem}%")

def backup_files():
    import shutil, os
    src = "./data"
    dst = f"./backups/backup_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}"
    if os.path.exists(src):
        shutil.copytree(src, dst)
        print(f"[JARVIS] Backup created: {dst}")

if __name__ == "__main__":
    scheduler = JarvisScheduler()
    scheduler.every_minute(check_system)
    scheduler.at_time("02:00", backup_files)
    scheduler.start()
    
    print("[JARVIS] Running... Press Ctrl+C to stop")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        scheduler.stop()` : `const cron = require('node-cron');

class JarvisScheduler {
  constructor() {
    this.tasks = new Map();
  }

  // Every N minutes: '*/5 * * * *' = every 5 minutes
  schedule(name, cronExpr, fn) {
    const task = cron.schedule(cronExpr, async () => {
      console.log(\`[JARVIS] Running task: \${name}\`);
      try {
        await fn();
      } catch (err) {
        console.error(\`[JARVIS] Task \${name} failed:\`, err.message);
      }
    });
    this.tasks.set(name, task);
    console.log(\`[JARVIS] Scheduled: \${name} (\${cronExpr})\`);
    return task;
  }

  stop(name) {
    const task = this.tasks.get(name);
    if (task) { task.destroy(); this.tasks.delete(name); }
  }

  stopAll() {
    this.tasks.forEach(t => t.destroy());
    this.tasks.clear();
    console.log('[JARVIS] All tasks stopped');
  }
}

// ── DEFINE YOUR TASKS ─────────────────────────────────────────
const scheduler = new JarvisScheduler();

// Check system every minute
scheduler.schedule('system-check', '* * * * *', async () => {
  const used = process.memoryUsage();
  console.log(\`Memory: \${(used.heapUsed / 1024 / 1024).toFixed(1)} MB\`);
});

// Daily backup at 2am
scheduler.schedule('daily-backup', '0 2 * * *', async () => {
  console.log('[JARVIS] Running daily backup...');
  // Add backup logic here
});

console.log('[JARVIS] Scheduler running...');`,

  "port scanner": () => `#!/usr/bin/env python3
# JARVIS Port Scanner — Educational/Network Admin Use Only
import socket
import concurrent.futures
import sys
from datetime import datetime

def scan_port(host, port, timeout=1):
    """Scan a single port"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((host, port))
        sock.close()
        return port if result == 0 else None
    except:
        return None

def get_service(port):
    """Get common service name for port"""
    services = {
        21:"FTP", 22:"SSH", 23:"Telnet", 25:"SMTP", 53:"DNS",
        80:"HTTP", 110:"POP3", 143:"IMAP", 443:"HTTPS", 445:"SMB",
        3306:"MySQL", 3389:"RDP", 5432:"PostgreSQL", 6379:"Redis",
        8080:"HTTP-Alt", 8443:"HTTPS-Alt", 27017:"MongoDB",
    }
    return services.get(port, "Unknown")

def scan(host, start_port=1, end_port=1024, threads=100):
    """Scan a host for open ports"""
    print(f"\n[JARVIS] Scanning {host} ports {start_port}-{end_port}")
    print(f"[JARVIS] Started: {datetime.now().strftime('%H:%M:%S')}\n")
    
    open_ports = []
    ports = range(start_port, end_port + 1)
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as executor:
        futures = {executor.submit(scan_port, host, p): p for p in ports}
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result:
                service = get_service(result)
                open_ports.append(result)
                print(f"  ✓ PORT {result:5d} — {service}")
    
    print(f"\n[JARVIS] Scan complete. {len(open_ports)} open ports found.")
    print(f"[JARVIS] Finished: {datetime.now().strftime('%H:%M:%S')}")
    return sorted(open_ports)

if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    scan(host)`,

  "password generator": () => `#!/usr/bin/env python3
import secrets
import string
import hashlib
import base64

class JarvisPasswordGen:
    def __init__(self):
        self.lower   = string.ascii_lowercase
        self.upper   = string.ascii_uppercase
        self.digits  = string.digits
        self.symbols = "!@#$%^&*()_+-=[]{}|;:,.<>?"
    
    def generate(self, length=20, use_symbols=True, use_digits=True, use_upper=True):
        """Generate a cryptographically secure password"""
        charset = self.lower
        required = [secrets.choice(self.lower)]
        
        if use_upper:
            charset += self.upper
            required.append(secrets.choice(self.upper))
        if use_digits:
            charset += self.digits
            required.append(secrets.choice(self.digits))
        if use_symbols:
            charset += self.symbols
            required.append(secrets.choice(self.symbols))
        
        # Fill remaining length
        remaining = length - len(required)
        password = required + [secrets.choice(charset) for _ in range(remaining)]
        
        # Shuffle to avoid predictable patterns
        secrets.SystemRandom().shuffle(password)
        return ''.join(password)
    
    def generate_passphrase(self, words=5):
        """Generate a memorable passphrase"""
        wordlist = ["alpha","bravo","charlie","delta","echo","foxtrot","golf",
                    "hotel","india","juliet","kilo","lima","mike","november",
                    "oscar","papa","quebec","romeo","sierra","tango","uniform",
                    "victor","whiskey","xray","yankee","zulu","jarvis","stark",
                    "iron","man","avenger","shield","cyber","quantum","neural"]
        phrase = [secrets.choice(wordlist) for _ in range(words)]
        separator = secrets.choice(["-","_",".","/"])
        return separator.join(phrase)
    
    def hash_password(self, password, algorithm="sha256"):
        """Hash a password"""
        if algorithm == "sha256":
            return hashlib.sha256(password.encode()).hexdigest()
        elif algorithm == "sha512":
            return hashlib.sha512(password.encode()).hexdigest()
        elif algorithm == "md5":
            return hashlib.md5(password.encode()).hexdigest()
    
    def check_strength(self, password):
        """Check password strength"""
        score = 0
        feedback = []
        
        if len(password) >= 12: score += 1
        else: feedback.append("Use at least 12 characters")
        
        if len(password) >= 20: score += 1
        
        if any(c in self.upper for c in password): score += 1
        else: feedback.append("Add uppercase letters")
        
        if any(c in self.digits for c in password): score += 1
        else: feedback.append("Add numbers")
        
        if any(c in self.symbols for c in password): score += 1
        else: feedback.append("Add symbols")
        
        strength = ["Very Weak","Weak","Fair","Strong","Very Strong","Unbreakable"][min(score, 5)]
        return {"score": score, "strength": strength, "feedback": feedback}

# Usage
gen = JarvisPasswordGen()
print("[JARVIS] Password Generator Online\n")

pwd = gen.generate(20)
strength = gen.check_strength(pwd)
print(f"Password:   {pwd}")
print(f"Strength:   {strength['strength']} ({strength['score']}/5)")
print(f"SHA256:     {gen.hash_password(pwd)}\n")

phrase = gen.generate_passphrase(5)
print(f"Passphrase: {phrase}")`,
};

// ── CODE GENERATORS — UPGRADED ────────────────────────────────
const CODE_TEMPLATES = {
  python: {
    "web scraper":    (topic) => AUTOMATION_TEMPLATES["web scraper"]("python"),
    "api":            () => `from flask import Flask, request, jsonify
from functools import wraps
import jwt
import datetime

app = Flask(__name__)
SECRET_KEY = "jarvis-secret-change-this"

# ── JWT AUTH DECORATOR ────────────────────────────────────────
def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("Authorization", "").replace("Bearer ", "")
        if not token:
            return jsonify({"error": "No token provided"}), 401
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            request.user = payload
        except jwt.ExpiredSignatureError:
            return jsonify({"error": "Token expired"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"error": "Invalid token"}), 401
        return f(*args, **kwargs)
    return decorated

# ── ROUTES ────────────────────────────────────────────────────
@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json()
    if not data or not data.get("username") or not data.get("password"):
        return jsonify({"error": "Missing credentials"}), 400
    # Replace with real user validation
    if data["username"] == "jarvis" and data["password"] == "ironman":
        token = jwt.encode({
            "user": data["username"],
            "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=24),
        }, SECRET_KEY, algorithm="HS256")
        return jsonify({"token": token})
    return jsonify({"error": "Invalid credentials"}), 401

@app.route("/api/data", methods=["GET"])
@require_auth
def get_data():
    return jsonify({"status": "ok", "user": request.user["user"], "data": []})

@app.route("/api/data", methods=["POST"])
@require_auth
def create_data():
    body = request.get_json()
    if not body:
        return jsonify({"error": "No body provided"}), 400
    return jsonify({"status": "created", "received": body}), 201

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Not found"}), 404

@app.errorhandler(500)
def server_error(e):
    return jsonify({"error": "Internal server error"}), 500

if __name__ == "__main__":
    app.run(debug=True, port=5000)`,

    "class":          (topic) => `class ${toPascalCase(topic || "Item")}:
    """${topic || "Item"} — JARVIS generated class"""
    
    def __init__(self, **kwargs):
        self._data = {}
        self._validators = {}
        for key, val in kwargs.items():
            setattr(self, key, val)
    
    def __setattr__(self, key, value):
        if key.startswith("_"):
            super().__setattr__(key, value)
            return
        validator = self._validators.get(key)
        if validator and not validator(value):
            raise ValueError(f"Invalid value for {key}: {value}")
        self._data[key] = value
    
    def __getattr__(self, key):
        if key.startswith("_"):
            raise AttributeError(key)
        return self._data.get(key)
    
    def to_dict(self):
        return dict(self._data)
    
    def to_json(self):
        import json
        return json.dumps(self.to_dict(), indent=2, default=str)
    
    def update(self, **kwargs):
        for key, val in kwargs.items():
            setattr(self, key, val)
        return self
    
    @classmethod
    def from_dict(cls, data):
        return cls(**data)
    
    def __repr__(self):
        attrs = ", ".join(f"{k}={v!r}" for k, v in self._data.items())
        return f"{self.__class__.__name__}({attrs})"
    
    def __eq__(self, other):
        return isinstance(other, self.__class__) and self._data == other._data`,

    "file watcher":   () => AUTOMATION_TEMPLATES["file watcher"]("python"),
    "task scheduler": () => AUTOMATION_TEMPLATES["task scheduler"]("python"),
    "port scanner":   () => AUTOMATION_TEMPLATES["port scanner"](),
    "password generator": () => AUTOMATION_TEMPLATES["password generator"](),

    "default": (topic) => `#!/usr/bin/env python3
"""
${topic} — Generated by J.A.R.V.I.S
"""
import logging
import sys
from typing import Optional, List, Dict, Any

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [JARVIS] %(levelname)s — %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger(__name__)

def ${toSnakeCase(topic)}(
    input_data: Any = None,
    options: Optional[Dict] = None
) -> Dict[str, Any]:
    """
    ${topic}
    
    Args:
        input_data: The input to process
        options: Optional configuration dict
    
    Returns:
        Dict containing result and metadata
    """
    options = options or {}
    result = {"success": False, "data": None, "error": None}
    
    try:
        log.info(f"Starting ${toSnakeCase(topic)}...")
        
        # ── YOUR LOGIC HERE ───────────────────────────────────
        if not input_data:
            raise ValueError("No input provided")
        
        processed = input_data  # Replace with actual logic
        
        result["success"] = True
        result["data"] = processed
        log.info("Completed successfully")
        
    except ValueError as e:
        result["error"] = str(e)
        log.error(f"Validation error: {e}")
    except Exception as e:
        result["error"] = str(e)
        log.exception(f"Unexpected error: {e}")
    
    return result

if __name__ == "__main__":
    output = ${toSnakeCase(topic)}(sys.argv[1] if len(sys.argv) > 1 else None)
    if output["success"]:
        print(f"Result: {output['data']}")
    else:
        print(f"Error: {output['error']}")
        sys.exit(1)`,
  },

  javascript: {
    "api":          () => AUTOMATION_TEMPLATES["api wrapper"]("general"),
    "web scraper":  () => AUTOMATION_TEMPLATES["web scraper"]("js"),
    "file watcher": () => AUTOMATION_TEMPLATES["file watcher"]("js"),
    "task scheduler": () => AUTOMATION_TEMPLATES["task scheduler"]("js"),

    "fetch": () => `class JarvisHTTP {
  constructor(baseURL, options = {}) {
    this.baseURL = baseURL.replace(/\\/+$/, "");
    this.defaultHeaders = {
      "Content-Type": "application/json",
      ...options.headers,
    };
    this.timeout = options.timeout || 10000;
    this.retries = options.retries || 3;
    this._token = options.token || null;
  }

  setToken(token) { this._token = token; return this; }

  _headers() {
    const h = { ...this.defaultHeaders };
    if (this._token) h["Authorization"] = \`Bearer \${this._token}\`;
    return h;
  }

  async _request(method, endpoint, body = null, attempt = 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const opts = { method, headers: this._headers(), signal: controller.signal };
      if (body) opts.body = JSON.stringify(body);

      const res = await fetch(\`\${this.baseURL}\${endpoint}\`, opts);
      clearTimeout(timer);

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw Object.assign(new Error(err.message || \`HTTP \${res.status}\`), { status: res.status, data: err });
      }

      return res.status === 204 ? null : res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < this.retries && err.name !== "AbortError") {
        console.warn(\`[JARVIS] Retry \${attempt}/\${this.retries}...\`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
        return this._request(method, endpoint, body, attempt + 1);
      }
      throw err;
    }
  }

  get(endpoint, params = {})    { const q = new URLSearchParams(params).toString(); return this._request("GET", q ? \`\${endpoint}?\${q}\` : endpoint); }
  post(endpoint, body)          { return this._request("POST", endpoint, body); }
  put(endpoint, body)           { return this._request("PUT",  endpoint, body); }
  patch(endpoint, body)         { return this._request("PATCH",endpoint, body); }
  delete(endpoint)              { return this._request("DELETE", endpoint); }
}

// Usage
const http = new JarvisHTTP("https://api.example.com", { retries: 3, timeout: 8000 });

async function main() {
  try {
    const data = await http.get("/items", { limit: 10 });
    console.log("[JARVIS] Data:", data);
  } catch (err) {
    console.error("[JARVIS] Error:", err.message);
  }
}

main();`,

    "class": (topic) => `class ${toPascalCase(topic)} {
  #data;
  #validators;
  static #instances = 0;

  constructor(options = {}) {
    this.#data       = {};
    this.#validators = {};
    this.id          = ++${toPascalCase(topic)}.#instances;
    this.createdAt   = new Date().toISOString();
    Object.entries(options).forEach(([k, v]) => this.set(k, v));
  }

  // ── GETTERS / SETTERS ─────────────────────────────────────
  get(key)        { return key ? this.#data[key] : { ...this.#data }; }
  has(key)        { return key in this.#data; }

  set(key, value) {
    const validator = this.#validators[key];
    if (validator && !validator(value)) {
      throw new TypeError(\`Invalid value for "\${key}": \${JSON.stringify(value)}\`);
    }
    this.#data[key] = value;
    return this;
  }

  delete(key)     { delete this.#data[key]; return this; }

  // ── VALIDATION ────────────────────────────────────────────
  addValidator(key, fn) { this.#validators[key] = fn; return this; }

  validate() {
    const errors = [];
    for (const [key, fn] of Object.entries(this.#validators)) {
      if (!fn(this.#data[key])) errors.push(\`Invalid: \${key}\`);
    }
    return { valid: errors.length === 0, errors };
  }

  // ── SERIALIZATION ─────────────────────────────────────────
  toJSON()  { return { id: this.id, createdAt: this.createdAt, ...this.#data }; }
  toString(){ return JSON.stringify(this.toJSON(), null, 2); }
  clone()   { return new ${toPascalCase(topic)}(this.#data); }

  // ── STATIC FACTORY ────────────────────────────────────────
  static from(obj) { return new ${toPascalCase(topic)}(obj); }
  static fromJSON(json) {
    const data = typeof json === "string" ? JSON.parse(json) : json;
    return new ${toPascalCase(topic)}(data);
  }
  static count() { return ${toPascalCase(topic)}.#instances; }
}

module.exports = ${toPascalCase(topic)};`,

    "react": () => `import { useState, useEffect, useCallback, useRef } from "react";

// ── CUSTOM HOOK ────────────────────────────────────────────────
function useJarvisData(url, options = {}) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const abortRef = useRef(null);

  const fetch_ = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    
    setLoading(true);
    setError(null);
    
    try {
      const res = await fetch(url, { signal: abortRef.current.signal, ...options });
      if (!res.ok) throw new Error(\`HTTP \${res.status}: \${res.statusText}\`);
      setData(await res.json());
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => { fetch_(); return () => abortRef.current?.abort(); }, [fetch_]);
  return { data, loading, error, refetch: fetch_ };
}

// ── COMPONENT ─────────────────────────────────────────────────
export default function JarvisComponent({ apiUrl = "/api/data", title = "J.A.R.V.I.S" }) {
  const { data, loading, error, refetch } = useJarvisData(apiUrl);
  const [selected, setSelected] = useState(null);
  const [filter,   setFilter]   = useState("");

  const filtered = data?.filter(item =>
    JSON.stringify(item).toLowerCase().includes(filter.toLowerCase())
  ) ?? [];

  if (loading) return (
    <div style={{ display:"flex", alignItems:"center", gap:8, padding:20, fontFamily:"monospace", color:"#00c8ff" }}>
      <div style={{ width:16, height:16, border:"2px solid #00c8ff", borderTopColor:"transparent", borderRadius:"50%", animation:"spin 1s linear infinite" }} />
      Loading...
    </div>
  );

  if (error) return (
    <div style={{ padding:20, color:"#ff3333", fontFamily:"monospace" }}>
      ⚠ Error: {error}
      <button onClick={refetch} style={{ marginLeft:12, cursor:"pointer" }}>Retry</button>
    </div>
  );

  return (
    <div style={{ fontFamily:"monospace", padding:20, maxWidth:800, margin:"0 auto" }}>
      <h1 style={{ color:"#00c8ff", letterSpacing:"0.3em" }}>{title}</h1>
      
      <input
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Filter..."
        style={{ width:"100%", padding:"8px 12px", background:"rgba(0,200,255,0.05)", border:"1px solid rgba(0,200,255,0.3)", color:"#00c8ff", borderRadius:2, marginBottom:16, outline:"none" }}
      />

      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {filtered.length === 0 && <div style={{ color:"#3a6a88" }}>No results.</div>}
        {filtered.map((item, i) => (
          <div
            key={item.id ?? i}
            onClick={() => setSelected(selected === i ? null : i)}
            style={{
              padding:"12px 16px",
              background: selected === i ? "rgba(0,200,255,0.1)" : "rgba(0,200,255,0.03)",
              border: \`1px solid \${selected === i ? "rgba(0,200,255,0.4)" : "rgba(0,200,255,0.1)"}\`,
              borderRadius:2, cursor:"pointer", transition:"all 0.15s",
            }}
          >
            {selected === i
              ? <pre style={{ margin:0, color:"#a8dff5", whiteSpace:"pre-wrap" }}>{JSON.stringify(item, null, 2)}</pre>
              : <span style={{ color:"#a8dff5" }}>{JSON.stringify(item).slice(0, 80)}...</span>
            }
          </div>
        ))}
      </div>

      <div style={{ marginTop:16, color:"#3a6a88", fontSize:"0.75rem" }}>
        {filtered.length} / {data?.length ?? 0} items · <button onClick={refetch} style={{ background:"none", border:"none", color:"#00c8ff", cursor:"pointer" }}>Refresh</button>
      </div>
    </div>
  );
}`,

    "default": (topic) => `/**
 * ${topic}
 * Generated by J.A.R.V.I.S
 */
"use strict";

const EventEmitter = require("events");

class ${toCamelCase(topic).charAt(0).toUpperCase() + toCamelCase(topic).slice(1)} extends EventEmitter {
  #config;
  #state;

  constructor(config = {}) {
    super();
    this.#config = {
      timeout:  config.timeout  ?? 5000,
      retries:  config.retries  ?? 3,
      debug:    config.debug    ?? false,
      ...config,
    };
    this.#state = { running: false, errors: 0, processed: 0 };
  }

  get state()  { return { ...this.#state }; }
  get config() { return { ...this.#config }; }

  log(level, msg) {
    if (!this.#config.debug && level === "debug") return;
    const ts = new Date().toISOString().split("T")[1].slice(0, 8);
    console[level === "error" ? "error" : "log"](\`[\${ts}] [JARVIS] [\${level.toUpperCase()}] \${msg}\`);
    this.emit("log", { level, msg, ts });
  }

  async run(input) {
    if (this.#state.running) throw new Error("Already running");
    this.#state.running = true;
    this.emit("start", { input });

    try {
      this.log("info", \`Processing: \${JSON.stringify(input)}\`);
      
      // ── YOUR LOGIC HERE ───────────────────────────────────
      const result = await this._process(input);
      
      this.#state.processed++;
      this.emit("complete", { result });
      this.log("info", "Done.");
      return result;
    } catch (err) {
      this.#state.errors++;
      this.emit("error", err);
      this.log("error", err.message);
      throw err;
    } finally {
      this.#state.running = false;
    }
  }

  async _process(input) {
    // Override this method with your logic
    return { processed: input, timestamp: Date.now() };
  }

  reset() {
    this.#state = { running: false, errors: 0, processed: 0 };
    this.emit("reset");
    return this;
  }
}

// ── USAGE ─────────────────────────────────────────────────────
async function main() {
  const instance = new ${toCamelCase(topic).charAt(0).toUpperCase() + toCamelCase(topic).slice(1)}({ debug: true });
  
  instance.on("start",    ({ input }) => console.log("Started with:", input));
  instance.on("complete", ({ result }) => console.log("Result:", result));
  instance.on("error",    (err) => console.error("Error:", err.message));

  const result = await instance.run({ example: "input" });
  console.log("Final:", result);
}

main().catch(console.error);
module.exports = ${toCamelCase(topic).charAt(0).toUpperCase() + toCamelCase(topic).slice(1)};`,
  },

  bash: {
    "default": (topic) => `#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# J.A.R.V.I.S — ${topic}
# Generated automatically — review before running
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
IFS=$'\\n\\t'

# ── COLOURS ──────────────────────────────────────────────────
RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'; NC='\\033[0m' # No Colour

# ── LOGGING ──────────────────────────────────────────────────
LOG()  { echo -e "\${BLUE}[$(date '+%H:%M:%S')] [JARVIS]\${NC} \$*"; }
OK()   { echo -e "\${GREEN}[✓]\${NC} \$*"; }
WARN() { echo -e "\${YELLOW}[!]\${NC} \$*"; }
ERR()  { echo -e "\${RED}[✗]\${NC} \$*" >&2; }

# ── DEPENDENCY CHECK ─────────────────────────────────────────
check_deps() {
    local deps=("curl" "jq" "git")
    for cmd in "\${deps[@]}"; do
        if ! command -v "\$cmd" &>/dev/null; then
            ERR "Required: \$cmd — install it first"
            exit 1
        fi
    done
    OK "All dependencies present"
}

# ── CLEANUP ON EXIT ───────────────────────────────────────────
cleanup() {
    LOG "Cleaning up..."
    # Add cleanup logic here
}
trap cleanup EXIT INT TERM

# ── MAIN ──────────────────────────────────────────────────────
main() {
    LOG "Starting ${topic}..."
    check_deps
    
    # ── YOUR LOGIC HERE ───────────────────────────────────────
    
    OK "Completed successfully"
}

# ── ARGS ──────────────────────────────────────────────────────
case "\${1:-run}" in
    run)   main "\$@" ;;
    help)  echo "Usage: \$0 [run|help]" ;;
    *)     ERR "Unknown command: \$1"; exit 1 ;;
esac`,
  },

  html: {
    "default": (topic) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${topic} — J.A.R.V.I.S</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    
    :root {
      --blue: #00c8ff;
      --blue-glow: rgba(0,200,255,0.3);
      --bg: #010c14;
      --text: #a8dff5;
      --text-dim: #3a6a88;
      --mono: 'Share Tech Mono', monospace;
    }
    
    body {
      font-family: var(--mono);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    
    .container {
      width: 100%;
      max-width: 800px;
      background: rgba(0,200,255,0.03);
      border: 1px solid rgba(0,200,255,0.15);
      border-radius: 4px;
      padding: 2rem;
    }
    
    h1 {
      font-family: 'Orbitron', monospace;
      color: var(--blue);
      letter-spacing: 0.3em;
      margin-bottom: 1rem;
      text-shadow: 0 0 20px var(--blue-glow);
    }
    
    .btn {
      background: transparent;
      border: 1px solid rgba(0,200,255,0.4);
      color: var(--blue);
      font-family: var(--mono);
      font-size: 0.85rem;
      letter-spacing: 0.15em;
      padding: 10px 20px;
      cursor: pointer;
      border-radius: 2px;
      transition: all 0.2s;
      margin-top: 1rem;
    }
    
    .btn:hover {
      background: rgba(0,200,255,0.1);
      box-shadow: 0 0 16px var(--blue-glow);
    }
    
    .output {
      margin-top: 1rem;
      padding: 1rem;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(0,200,255,0.1);
      border-radius: 2px;
      min-height: 60px;
      font-size: 0.85rem;
      color: var(--text);
      white-space: pre-wrap;
    }
  </style>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Share+Tech+Mono&display=swap" rel="stylesheet"/>
</head>
<body>
  <div class="container">
    <h1>${topic.toUpperCase()}</h1>
    <p style="color:var(--text-dim);margin-bottom:1rem">J.A.R.V.I.S Generated Interface</p>
    <button class="btn" onclick="run()">⚡ EXECUTE</button>
    <div class="output" id="output">Awaiting command...</div>
  </div>
  <script>
    function run() {
      const output = document.getElementById('output');
      output.textContent = '[JARVIS] Processing...';
      setTimeout(() => {
        output.textContent = '[JARVIS] ${topic} — complete.\\n' + new Date().toISOString();
      }, 800);
    }
  </script>
</body>
</html>`,
  },

  sql: {
    "default": (topic) => `-- ═══════════════════════════════════════════════════════════
-- J.A.R.V.I.S — ${topic}
-- ═══════════════════════════════════════════════════════════

-- ── CREATE TABLE ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ${toSnakeCase(topic)} (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255)  NOT NULL,
  data        JSONB,
  status      VARCHAR(50)   DEFAULT 'active',
  tags        TEXT[]        DEFAULT '{}',
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW(),
  created_by  VARCHAR(100),
  deleted_at  TIMESTAMPTZ   -- soft delete
);

-- ── INDEXES ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_${toSnakeCase(topic)}_status     ON ${toSnakeCase(topic)} (status);
CREATE INDEX IF NOT EXISTS idx_${toSnakeCase(topic)}_created    ON ${toSnakeCase(topic)} (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_${toSnakeCase(topic)}_name       ON ${toSnakeCase(topic)} USING gin(to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_${toSnakeCase(topic)}_data       ON ${toSnakeCase(topic)} USING gin(data);

-- ── AUTO UPDATE TIMESTAMP ─────────────────────────────────────
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_${toSnakeCase(topic)}_updated ON ${toSnakeCase(topic)};
CREATE TRIGGER trg_${toSnakeCase(topic)}_updated
  BEFORE UPDATE ON ${toSnakeCase(topic)}
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- ── INSERT ────────────────────────────────────────────────────
INSERT INTO ${toSnakeCase(topic)} (name, data, status, created_by)
VALUES ('Example', '{"key": "value"}'::jsonb, 'active', 'jarvis')
RETURNING *;

-- ── SELECT WITH FILTERS ───────────────────────────────────────
SELECT *
FROM ${toSnakeCase(topic)}
WHERE deleted_at IS NULL
  AND status = 'active'
  AND name ILIKE '%example%'
ORDER BY created_at DESC
LIMIT 50 OFFSET 0;

-- ── FULL TEXT SEARCH ──────────────────────────────────────────
SELECT *, ts_rank(to_tsvector('english', name), query) AS rank
FROM ${toSnakeCase(topic)}, to_tsquery('english', 'example') query
WHERE to_tsvector('english', name) @@ query
  AND deleted_at IS NULL
ORDER BY rank DESC;

-- ── UPDATE ────────────────────────────────────────────────────
UPDATE ${toSnakeCase(topic)}
SET name = 'Updated', data = data || '{"updated": true}'::jsonb
WHERE id = 1 AND deleted_at IS NULL
RETURNING *;

-- ── SOFT DELETE ───────────────────────────────────────────────
UPDATE ${toSnakeCase(topic)}
SET deleted_at = NOW()
WHERE id = 1;

-- ── HARD DELETE ───────────────────────────────────────────────
DELETE FROM ${toSnakeCase(topic)} WHERE id = 1;

-- ── AGGREGATE ─────────────────────────────────────────────────
SELECT
  status,
  COUNT(*) AS total,
  MIN(created_at) AS oldest,
  MAX(created_at) AS newest
FROM ${toSnakeCase(topic)}
WHERE deleted_at IS NULL
GROUP BY status
ORDER BY total DESC;`,
  },

  rust: {
    "default": (topic) => `use std::error::Error;
use std::fmt;

// ── CUSTOM ERROR TYPE ─────────────────────────────────────────
#[derive(Debug)]
enum JarvisError {
    NotFound(String),
    InvalidInput(String),
    IoError(std::io::Error),
}

impl fmt::Display for JarvisError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JarvisError::NotFound(msg)     => write!(f, "Not found: {}", msg),
            JarvisError::InvalidInput(msg) => write!(f, "Invalid input: {}", msg),
            JarvisError::IoError(e)        => write!(f, "IO error: {}", e),
        }
    }
}

impl Error for JarvisError {}
impl From<std::io::Error> for JarvisError {
    fn from(e: std::io::Error) -> Self { JarvisError::IoError(e) }
}

// ── MAIN STRUCT ───────────────────────────────────────────────
#[derive(Debug, Clone)]
struct ${toPascalCase(topic)} {
    name: String,
    data: Vec<String>,
    active: bool,
}

impl ${toPascalCase(topic)} {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            data: Vec::new(),
            active: true,
        }
    }

    fn add(&mut self, item: String) -> &mut Self {
        self.data.push(item);
        self
    }

    fn process(&self) -> Result<Vec<String>, JarvisError> {
        if !self.active {
            return Err(JarvisError::InvalidInput("Instance is inactive".to_string()));
        }
        if self.data.is_empty() {
            return Err(JarvisError::NotFound("No data to process".to_string()));
        }
        Ok(self.data.iter().map(|s| s.to_uppercase()).collect())
    }
}

impl fmt::Display for ${toPascalCase(topic)} {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "${toPascalCase(topic)} {{ name: {}, items: {} }}", self.name, self.data.len())
    }
}

// ── MAIN ──────────────────────────────────────────────────────
fn main() -> Result<(), Box<dyn Error>> {
    println!("[JARVIS] ${topic} starting...");

    let mut instance = ${toPascalCase(topic)}::new("jarvis");
    instance.add("item_one".to_string()).add("item_two".to_string());

    match instance.process() {
        Ok(results) => {
            println!("[JARVIS] Processed {} items:", results.len());
            for r in &results { println!("  → {}", r); }
        }
        Err(e) => eprintln!("[JARVIS] Error: {}", e),
    }

    println!("[JARVIS] Done: {}", instance);
    Ok(())
}`,
  },

  go: {
    "default": (topic) => `package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"
)

// ── LOGGER ────────────────────────────────────────────────────
var logger = log.New(os.Stdout, "[JARVIS] ", log.Ltime|log.Lshortfile)

// ── MAIN STRUCT ───────────────────────────────────────────────
type ${toPascalCase(topic)} struct {
    mu      sync.RWMutex
    name    string
    data    []string
    running bool
    errors  int
}

func New${toPascalCase(topic)}(name string) *${toPascalCase(topic)} {
    return &${toPascalCase(topic)}{name: name}
}

func (j *${toPascalCase(topic)}) Add(item string) *${toPascalCase(topic)} {
    j.mu.Lock()
    defer j.mu.Unlock()
    j.data = append(j.data, item)
    return j
}

func (j *${toPascalCase(topic)}) Process(ctx context.Context) ([]string, error) {
    j.mu.RLock()
    defer j.mu.RUnlock()

    if len(j.data) == 0 {
        return nil, fmt.Errorf("no data to process")
    }

    results := make([]string, 0, len(j.data))
    for _, item := range j.data {
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        default:
            // Process item
            results = append(results, fmt.Sprintf("[processed] %s", item))
            time.Sleep(10 * time.Millisecond)
        }
    }
    return results, nil
}

func (j *${toPascalCase(topic)}) String() string {
    j.mu.RLock()
    defer j.mu.RUnlock()
    return fmt.Sprintf("${toPascalCase(topic)}{name:%s, items:%d}", j.name, len(j.data))
}

// ── MAIN ──────────────────────────────────────────────────────
func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Handle shutdown signals
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    go func() { <-sigCh; logger.Println("Shutting down..."); cancel() }()

    logger.Println("${topic} starting...")

    instance := New${toPascalCase(topic)}("jarvis")
    instance.Add("item_one").Add("item_two").Add("item_three")

    results, err := instance.Process(ctx)
    if err != nil {
        logger.Fatalf("Error: %v", err)
    }

    for _, r := range results {
        fmt.Printf("  → %s\\n", r)
    }

    logger.Printf("Done: %s", instance)
}`,
  },
};

// ── NAME HELPERS ──────────────────────────────────────────────
function toCamelCase(str) {
  return str.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^./, c => c.toLowerCase())
    .replace(/[^a-zA-Z0-9]/g,"") || "doThing";
}
function toPascalCase(str) {
  const c = toCamelCase(str);
  return c.charAt(0).toUpperCase() + c.slice(1) || "MyClass";
}
function toSnakeCase(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"") || "my_function";
}

// ── LANGUAGE DETECTION ────────────────────────────────────────
function detectLanguage(text) {
  for (const [lang, re] of Object.entries(CODE_PATTERNS)) {
    if (re.test(text)) return lang;
  }
  return "javascript";
}

function isCodeRequest(text) {
  return CODE_INTENT.test(text) ||
    /\b(write me|build me|create me|make me)\b.{0,60}\b(function|class|script|component|api|server|bot|tool|utility|helper|hook|middleware|route|endpoint|scraper|automation|scheduler|watcher)\b/i.test(text);
}

function isTerminalRequest(text) {
  return TERMINAL_INTENT.test(text) ||
    /\bhow do i\b.{0,40}\b(linux|terminal|bash|cmd|shell|powershell)\b/i.test(text) ||
    /\bwhat('s| is) the command\b/i.test(text);
}

function isAutomationRequest(text) {
  return /\b(automate|automation|scheduled|schedule|cron|periodic|recurring|watch|monitor|background|daemon|service|bot)\b/i.test(text);
}

// ── TOPIC EXTRACTOR ───────────────────────────────────────────
function extractCodeTopic(text) {
  return text
    .replace(/\b(write|create|build|make|generate|code|give me|show me|implement|develop|debug|fix|refactor|optimize|optimise|review|improve)\b/gi,"")
    .replace(/\b(a |an |the |some )\b/gi,"")
    .replace(/\b(function|class|script|program|app|api|server|component|module|snippet|example|code|in python|in javascript|in js|in node|in react|in html|in css|in sql|in bash|in rust|in go|in typescript)\b/gi,"")
    .replace(/[?!.]+$/,"")
    .trim() || "solution";
}

function pickTemplate(lang, topic, text) {
  const lower = text.toLowerCase();
  const templates = CODE_TEMPLATES[lang] || CODE_TEMPLATES.javascript;
  for (const key of Object.keys(templates)) {
    if (key !== "default" && lower.includes(key)) return templates[key](topic);
  }
  return (templates.default || CODE_TEMPLATES.javascript.default)(topic);
}

// ── TERMINAL COMMAND LOOKUP ────────────────────────────────────
function findTerminalCommand(text) {
  const lower = text.toLowerCase();
  for (const [key, data] of Object.entries(TERMINAL_COMMANDS)) {
    if (lower.includes(key)) return { key, ...data };
  }
  return null;
}

// ── CODE GENERATOR ────────────────────────────────────────────
function genCode(text, ctx) {
  const T     = ctx.userTitle || "Sir";
  const lang  = detectLanguage(text);
  const topic = extractCodeTopic(text);
  const code  = pickTemplate(lang, topic, text);

  const langLabels = {
    python:"Python", javascript:"JavaScript", html:"HTML/CSS", sql:"SQL",
    bash:"Bash", java:"Java", cpp:"C++", rust:"Rust", go:"Go", php:"PHP",
    powershell:"PowerShell", ruby:"Ruby", swift:"Swift", kotlin:"Kotlin", csharp:"C#",
  };
  const label = langLabels[lang] || lang;
  const cfg   = getCfg();
  const verb  = cfg.personality?.verbosity || "medium";

  const intros = [
    `Here's the ${label}, ${T}.`,
    `${label} — here you go, ${T}.`,
    `Written in ${label}, ${T}.`,
    `Generated, ${T}. ${label} below.`,
  ];

  let response = `${pick(intros)}\n\n\`\`\`${lang}\n${code}\n\`\`\``;

  if (verb !== "brief") {
    const descs = [
      `It handles the core logic for ${topic} — drop it in and adjust as needed.`,
      `Covers the essentials for ${topic}. Extend from there.`,
      `Production-grade ${label} for ${topic}. Modify the marked sections for your use case.`,
    ];
    response += `\n\n${pick(descs)}`;
  }

  return response;
}

// ── TERMINAL COMMAND GENERATOR ────────────────────────────────
function genTerminalCommand(text, ctx) {
  const T = ctx.userTitle || "Sir";
  const cmd = findTerminalCommand(text);

  if (cmd) {
    const isWindows = /windows|win|cmd|powershell/i.test(text);
    const command = isWindows && cmd.win !== "same" ? cmd.win : cmd.cmd;
    const os = isWindows ? "Windows" : "Linux/Mac";

    return `Terminal command for ${cmd.desc}, ${T}.\n\n\`\`\`bash\n${command}\n\`\`\`\n\n${os} · ${cmd.desc}. ${cmd.win !== "same" && !isWindows ? `Windows equivalent: \`${cmd.win}\`` : ""}`;
  }

  // Generic terminal help
  const lower = text.toLowerCase();
  if (/how do i.*(install|setup|run|start|stop|restart)/i.test(lower)) {
    const action = lower.match(/(install|setup|run|start|stop|restart)/)?.[1] || "run";
    const target = text.replace(/.*?(install|setup|run|start|stop|restart)\s*/i,"").replace(/[?!.]+$/,"").trim();
    const cmds = {
      install: `# npm / Node.js\nnpm install ${target}\n\n# pip / Python\npip install ${target}\n\n# apt / Linux\nsudo apt install ${target}\n\n# brew / Mac\nbrew install ${target}`,
      run:     `# Node.js\nnode ${target}.js\n\n# Python\npython ${target}.py\n\n# Direct\n./${target}`,
      start:   `# As service\nsudo systemctl start ${target}\n\n# With npm\nnpm run start\n\n# Direct\n./${target} start`,
      stop:    `sudo systemctl stop ${target}\n# Or find and kill:\npkill -f ${target}`,
    };
    const relevantCmd = cmds[action] || `# Command to ${action} ${target}\n${action} ${target}`;
    return `How to ${action} ${target || "it"}, ${T}.\n\n\`\`\`bash\n${relevantCmd}\n\`\`\``;
  }

  return null;
}

// ── DEBUG / EXPLAIN CODE ──────────────────────────────────────
function genDebugExplain(text, ctx) {
  const T = ctx.userTitle || "Sir";
  const isExplain = /\b(explain|what does|what is|how does|describe|breakdown|break down|walk me through)\b/i.test(text);
  const isDebug   = /\b(debug|fix|error|bug|issue|problem|broken|wrong|failing|not working|crash)\b/i.test(text);
  const isReview  = /\b(review|improve|optimise|optimize|refactor|better|clean|cleaner)\b/i.test(text);

  if (isDebug) {
    return pick([
      `To debug that, ${T} — first check the error message carefully, it usually tells you the exact line and type of failure. Then add \`console.log()\` or \`print()\` before the failing line to see what values you're actually working with. Nine times out of ten it's either a null/undefined value, a wrong variable name, or an off-by-one error. Paste the error message and I'll pinpoint it.`,
      `${T}, share the error message and the relevant code block and I'll debug it precisely. Most errors fall into three categories: type errors (wrong data type), reference errors (variable doesn't exist), or logic errors (code runs but gives wrong output). Which are you seeing?`,
    ]);
  }

  if (isExplain) {
    return pick([
      `${T}, paste the code block and I'll walk through it line by line — what each part does, why it's written that way, and any patterns worth knowing about.`,
      `Send the code over, ${T}. I'll break it down into plain terms — the structure, the logic flow, and any specific techniques being used.`,
    ]);
  }

  if (isReview) {
    return pick([
      `${T}, paste the code and I'll review it for: performance bottlenecks, security issues, readability, error handling gaps, and cleaner patterns. I'll give you a specific rewrite where it matters.`,
      `Send it over, ${T}. I'll look at structure, edge cases, performance, and give you concrete improvements with the actual improved code.`,
    ]);
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// ── KNOWLEDGE GRAPH ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const KNOWLEDGE_GRAPH = {
  "quantum mechanics":{ def:"the branch of physics governing matter and energy at atomic and subatomic scales", facts:["particles exist in superposition until observed","wave-particle duality means light behaves as both a wave and a particle","the uncertainty principle means position and momentum cannot both be precisely known at once","quantum entanglement allows particles to influence each other instantaneously across any distance","Schrödinger's equation describes how quantum states evolve over time"], related:["physics","atom","wave","particle","uncertainty","entanglement","superposition","energy"], applications:["transistors","MRI machines","lasers","cryptography","quantum computers"] },
  "black hole":{ def:"a region of spacetime where gravity is so extreme that nothing — not even light — can escape", facts:["formed when massive stars collapse under their own gravity","the boundary of no return is called the event horizon","time slows near a black hole due to gravitational time dilation","Hawking radiation theory suggests they slowly evaporate over astronomical timescales","supermassive black holes are found at the centre of most galaxies"], related:["gravity","spacetime","relativity","star","event horizon","singularity"], applications:["testing general relativity","understanding galaxy formation"] },
  "dna":{ def:"deoxyribonucleic acid — the molecule encoding genetic information in sequences of four chemical bases", facts:["the double helix structure was discovered by Watson and Crick in 1953","humans share 99.9% of their DNA with each other","DNA in a single cell, stretched out, would be approximately 2 metres long","CRISPR-Cas9 allows precise targeted editing of DNA sequences","mitochondrial DNA is inherited only from the mother"], related:["genetics","chromosome","protein","cell","evolution","gene","RNA"], applications:["medicine","forensics","agriculture","ancestry testing","gene therapy"] },
  "artificial intelligence":{ def:"the field of computer science aimed at building systems capable of performing tasks that typically require human-like intelligence", facts:["machine learning allows systems to learn from data without explicit programming","large language models use transformer architectures to predict likely next tokens","AI systems can perpetuate and amplify biases present in their training data","narrow AI excels at specific tasks; artificial general intelligence remains unsolved"], related:["machine learning","neural network","deep learning","algorithm","data","automation"], applications:["medical diagnosis","autonomous vehicles","language translation","recommendation systems"] },
  "machine learning":{ def:"a subset of AI in which algorithms improve their performance by learning patterns from data rather than following explicit rules", facts:["supervised learning uses labelled training examples","unsupervised learning finds hidden structure in unlabelled data","reinforcement learning trains agents through reward and penalty signals","gradient descent is the core optimisation algorithm underlying most deep learning"], related:["neural network","deep learning","algorithm","data","training","artificial intelligence"], applications:["image recognition","spam filtering","fraud detection","NLP"] },
  "internet":{ def:"a global system of interconnected computer networks communicating via standardised protocols such as TCP/IP", facts:["it evolved from ARPANET, a US military research network funded in the 1960s","the World Wide Web was invented by Tim Berners-Lee at CERN in 1989","approximately 95% of international data traffic travels through undersea fibre-optic cables"], related:["web","network","protocol","server","browser","wifi","TCP/IP"], applications:["communication","commerce","education","entertainment"] },
  "blockchain":{ def:"a distributed ledger in which data is stored in cryptographically linked blocks replicated across a decentralised network of nodes", facts:["Bitcoin was the first large-scale blockchain application, launched in 2009","each block contains a cryptographic hash of the previous block, making tampering detectable","smart contracts self-execute when predetermined conditions are met"], related:["cryptocurrency","bitcoin","decentralisation","cryptography","ethereum"], applications:["cryptocurrency","supply chain transparency","digital contracts"] },
  "cybersecurity":{ def:"the practice of protecting systems, networks, and programs from digital attacks, unauthorised access, and data breaches", facts:["the most common attack vector is phishing — tricking users into revealing credentials","SQL injection exploits unsanitised database queries to access or corrupt data","zero-day vulnerabilities are unknown to the software vendor when exploited","end-to-end encryption ensures only sender and recipient can read a message","over 60% of data breaches involve compromised credentials"], related:["encryption","firewall","vulnerability","malware","phishing","network","authentication"], applications:["banking","government","healthcare","infrastructure","personal privacy"] },
  "networking":{ def:"the practice of connecting computers and devices to share resources and communicate via protocols", facts:["TCP/IP is the foundational protocol suite of the internet","DNS translates human-readable domain names to IP addresses","a subnet mask determines which portion of an IP address identifies the network","packets can take different routes across the internet and reassemble at the destination","IPv6 was introduced to address the exhaustion of IPv4 addresses"], related:["TCP/IP","DNS","router","firewall","bandwidth","protocol","IP address"], applications:["internet","cloud computing","IoT","telecommunications"] },
  "linux":{ def:"an open-source Unix-like operating system kernel first released by Linus Torvalds in 1991", facts:["Linux powers over 96% of the world's top web servers","Android is built on the Linux kernel","the terminal uses bash or zsh as the default shell on most distributions","everything in Linux is a file — including devices and processes","package managers like apt, yum, and pacman automate software installation"], related:["kernel","bash","terminal","debian","ubuntu","server","open source"], applications:["servers","embedded systems","supercomputers","Android","cloud infrastructure"] },
  "encryption":{ def:"the process of encoding data so that only authorised parties can read it, using mathematical algorithms and keys", facts:["AES-256 is considered military-grade encryption and is currently unbreakable by brute force","RSA encryption is asymmetric — uses a public key to encrypt and a private key to decrypt","HTTPS uses TLS to encrypt data between your browser and web servers","quantum computers could theoretically break current encryption — post-quantum cryptography is being developed"], related:["cybersecurity","cryptography","key","hash","SSL","TLS","AES","RSA"], applications:["banking","messaging","VPNs","passwords","digital signatures"] },
  "api":{ def:"Application Programming Interface — a defined set of rules that allows different software systems to communicate with each other", facts:["REST APIs use HTTP methods: GET, POST, PUT, PATCH, DELETE","GraphQL lets clients request exactly the data they need in a single query","WebSockets enable real-time two-way communication between client and server","API rate limiting prevents abuse by capping the number of requests per time period","OAuth2 is the standard protocol for API authentication"], related:["REST","HTTP","JSON","authentication","endpoint","request","response"], applications:["web development","mobile apps","integrations","microservices"] },
};

const KG_KEYS = Object.keys(KNOWLEDGE_GRAPH);

function findKnowledge(text) {
  const lower = text.toLowerCase();
  for (const key of KG_KEYS) if (lower.includes(key)) return { key, data: KNOWLEDGE_GRAPH[key], score: 1 };
  const tokens = new Set(tokenize(lower)); let best=null, bestScore=0;
  for (const key of KG_KEYS) {
    const data = KNOWLEDGE_GRAPH[key]; let score = 0;
    for (const r of (data.related||[])) if (tokens.has(r)||lower.includes(r)) score++;
    for (const t of tokens) if (key.includes(t)) score += 0.5;
    if (score > bestScore) { bestScore = score; best = key; }
  }
  if (bestScore >= 1.5) return { key: best, data: KNOWLEDGE_GRAPH[best], score: bestScore };
  return null;
}

// ── ENTITY EXTRACTOR ─────────────────────────────────────────
function extractEntities(text) {
  const lower = text.toLowerCase();
  return {
    numbers:        [...text.matchAll(/\b\d+(?:\.\d+)?\b/g)].map(m => parseFloat(m[0])),
    duration:       parseDuration(lower),
    isQuestion:     /^(what|who|where|when|why|how|which|is|are|can|could|would|should|does|did|will)\b/i.test(lower),
    isNegation:     /\b(not|never|no|don't|doesn't|didn't|can't|won't|isn't)\b/gi.test(lower),
    isComparison:   /\b(vs|versus|compared|difference|better|worse|faster|slower)\b/gi.test(lower),
    isPersonal:     /\b(should i|my |me |myself|am i|do i|will i)\b/i.test(lower),
    isOpinion:      /\b(opinion|think|feel|believe|your view|what do you think|do you like)\b/i.test(lower),
    isHypothetical: /\bif\b.*\bwould\b|\bwhat if\b|\bhypothetically\b/i.test(lower),
    focus:          lower.replace(/^(what is|what are|who is|how does|why does|explain|tell me about|define|describe)\s+/i,"").replace(/\?+$/,"").trim(),
  };
}

// ── SENTIMENT ────────────────────────────────────────────────
const POS = new Set(["good","great","excellent","amazing","wonderful","fantastic","love","like","enjoy","happy","glad","pleased","excited","perfect","brilliant","awesome","best","beautiful","helpful","useful","smart","clever","right","correct"]);
const NEG = new Set(["bad","terrible","awful","hate","dislike","wrong","broken","fail","error","problem","issue","confused","stupid","useless","worst","horrible","annoying","ugly","difficult","hard","frustrating","sad","angry"]);
function sentiment(text) { let s=0; for (const w of text.toLowerCase().split(/\s+/)) { if(POS.has(w))s++; if(NEG.has(w))s--; } return s>0?"positive":s<0?"negative":"neutral"; }

// ── TIME / DURATION ───────────────────────────────────────────
const WORD_NUMS = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,hundred:100,thousand:1000,million:1000000,half:0.5,quarter:0.25,dozen:12,score:20,gross:144 };

function parseDuration(text) {
  const lower = text.toLowerCase(); let totalMs = 0;
  const patterns = [
    { re: /(\d+(?:\.\d+)?)\s*hour/g,   ms: 3600000 },
    { re: /(\d+(?:\.\d+)?)\s*hr/g,     ms: 3600000 },
    { re: /(\d+(?:\.\d+)?)\s*h\b/g,    ms: 3600000 },
    { re: /(\d+(?:\.\d+)?)\s*minute/g, ms: 60000   },
    { re: /(\d+(?:\.\d+)?)\s*min/g,    ms: 60000   },
    { re: /(\d+(?:\.\d+)?)\s*m\b/g,    ms: 60000   },
    { re: /(\d+(?:\.\d+)?)\s*second/g, ms: 1000    },
    { re: /(\d+(?:\.\d+)?)\s*sec/g,    ms: 1000    },
    { re: /(\d+(?:\.\d+)?)\s*s\b/g,    ms: 1000    },
  ];
  for (const { re, ms } of patterns) { let m; re.lastIndex=0; while ((m=re.exec(lower))!==null) totalMs += parseFloat(m[1])*ms; }
  if (!totalMs) {
    if (/half.?hour|30.?min/.test(lower))    totalMs = 1800000;
    if (/quarter.?hour|15.?min/.test(lower)) totalMs = 900000;
    if (/\ban hour\b/.test(lower))           totalMs = 3600000;
    if (/\ba minute\b/.test(lower))          totalMs = 60000;
  }
  return totalMs || null;
}
function formatDuration(ms) {
  const h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000), s=Math.floor((ms%60000)/1000);
  const parts=[];
  if (h) parts.push(`${h} hour${h>1?"s":""}`);
  if (m) parts.push(`${m} minute${m>1?"s":""}`);
  if (s && !h) parts.push(`${s} second${s>1?"s":""}`);
  return parts.join(" and ") || "a moment";
}

// ── MATH ENGINE ───────────────────────────────────────────────
function wordsToNumber(str) {
  let s = str.toLowerCase().replace(/\ba\s+hundred\b/g,"100").replace(/\ba\s+thousand\b/g,"1000");
  const tokens = s.split(/\s+/); const out=[]; let acc=null;
  for (const tok of tokens) {
    const n=WORD_NUMS[tok];
    if (n!==undefined) { if(acc===null)acc=n; else if(n===100)acc=acc*100; else if(n>=1000)acc=(acc||1)*n; else if(n<acc&&n<100)acc+=n; else{out.push(acc);acc=n;} }
    else { if(acc!==null){out.push(acc);acc=null;} out.push(tok); }
  }
  if(acc!==null)out.push(acc); return out.join(" ");
}

function solveMath(input) {
  try {
    let s = input.toLowerCase().trim();
    s = s.replace(/^(what|what's|calculate|compute|solve|give me|jarvis)\s+/gi,"").replace(/[?!.]+$/,"").trim();
    s = wordsToNumber(s);
    s = s.replace(/(\d+\.?\d*)\s*%\s*of\s*(\d+\.?\d*)/gi,"($1/100*$2)");
    s = s.replace(/(\d+\.?\d*)\s*percent\s+of\s*(\d+\.?\d*)/gi,"($1/100*$2)");
    s = s.replace(/\bsquared\b/gi,"**2").replace(/\bcubed\b/gi,"**3");
    s = s.replace(/\bto the power of\b|\braised to\b/gi,"**");
    s = s.replace(/\bsquare root of\b|\bsqrt of\b|\broot of\b/gi,"Math.sqrt(PLACEHOLDER)");
    s = s.replace(/\btimes\b|\bmultiplied by\b/gi,"*").replace(/\bdivided by\b|\bover\b|\bdiv\b/gi,"/");
    s = s.replace(/\bplus\b|\badded to\b/gi,"+").replace(/\bminus\b|\bsubtracted from\b|\bless\b/gi,"-");
    s = s.replace(/\bmod(?:ulo)?\b/gi,"%").replace(/\^/g,"**").replace(/\bpi\b/gi,"Math.PI");
    s = s.replace(/Math\.sqrt\(PLACEHOLDER\)\s*(\d+\.?\d*)/g,"Math.sqrt($1)").replace(/Math\.sqrt\(PLACEHOLDER\)/g,"Math.sqrt(");
    const exprMatch = s.match(/[\d\s\+\-\*\/\.\(\)\%\*MathsqrlogPIEabs]+/);
    if (!exprMatch) return null;
    let raw = exprMatch[0].trim();
    if (!raw || !/\d/.test(raw)) return null;
    if (/[^0-9\s\+\-\*\/\.\(\)\%MathsqrlogPIEabs]/.test(raw)) return null;
    function factorial(n) { n=Math.floor(Math.abs(n)); if(n>20)return NaN; let r=1; for(let i=2;i<=n;i++)r*=i; return r; }
    // eslint-disable-next-line no-new-func
    const result = Function("factorial","Math",`"use strict"; return (${raw})`)(factorial,Math);
    if (typeof result!=="number"||!isFinite(result)) return null;
    return Number.isInteger(result) ? result : parseFloat(result.toFixed(6));
  } catch { return null; }
}
function isMathQuery(text) {
  return /[\d]+\s*[\+\-\*\/\^%]\s*[\d]+/.test(text) ||
    /\b(calculate|compute|solve|square root|sqrt|factorial|percent of)\b.*\d/i.test(text) ||
    /\bwhat(?:'s| is)\b.*\d.*[\+\-\*\/\^%\d]/.test(text);
}

// ═══════════════════════════════════════════════════════════════
// ── INTENT TAXONOMY — UPGRADED ────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const INTENTS = [
  { id:"diy_project", signals:["build","make","design","construct","fabricate","diy","i want to build","can you make","help me build","how to build","how do i build","smart glasses","ar glasses","drone","quadcopter","exoskeleton","laser","repulsor","robot arm","plasma","wearable","gadget","circuit board","3d print","arduino project","raspberry pi project","budget","under $","dollars"], action:"DIY_PROJECT", weight:2.3 },
  { id:"coding",        signals:["write","create","build","make","generate","code","script","program","function","class","implement","develop","snippet","example","how to code","how to program","how to implement","how to build","html page","css","react component","api endpoint","database","query","bash script","python script","node server","express","flask","django","sql table","rust function","go function","automation","automate","scraper","scrape","scheduler","schedule","cron","watcher","watch files"], action:"CODE", weight:2.2 },
  { id:"terminal",      signals:["terminal","command","cmd","bash command","shell command","how do i","what command","linux command","windows command","powershell command","how to install","how to run","how to start","how to stop","open ports","check ip","scan network","running processes","disk usage","cpu usage","memory usage","git","docker","npm install","pip install"], action:"TERMINAL", weight:2.0 },
  { id:"debug",         signals:["debug","fix","error","bug","issue","problem","broken","wrong","failing","not working","crash","exception","traceback","undefined","null","cannot read","is not a function","syntax error","type error","reference error","why is","what's wrong","help me fix"], action:"DEBUG", weight:1.9 },
  { id:"explain_code",  signals:["explain this code","what does this code","how does this work","walk me through","breakdown","break down this","what is this doing","explain the code","what is this function","what does this mean"], action:"EXPLAIN_CODE", weight:1.9 },
  { id:"hologram",      signals:["show me a 3d scan","show me a 3d","3d scan","hologram","holographic","show me a model","3d model","scan this","show me what","show me smart glasses","show me a carbon","show me dna","show me a brain","show me a satellite","show me a molecule","scan smart glasses","scan atom","scan molecule","pull up 3d","display 3d","render 3d","visualise","visualize","3d view","three d","show me how","show me the structure"], action:"SHOW_HOLOGRAM", weight:1.8 },
  { id:"lookup_person", signals:["look up","lookup","find out about","background check","run a check","pull everything on","give me everything on","give me the rundown on","find me everything on","dig up","investigate","find info on","pull up info on","i need info on","find everything on","search for person","who is","who was","who's","find this person","locate this person","research this person","what do you know about this person"], action:"LOOKUP_PERSON", weight:1.8 },
  { id:"personal_news", signals:["i have a girlfriend","got a girlfriend","i have a boyfriend","got a boyfriend","got promoted","got a promotion","got fired","laid off","got laid off","lost my job","broke up","we broke up","she left me","he left me","got the job","new job","getting married","we're engaged","i'm engaged","she said yes","he said yes","we're pregnant","expecting a baby","moving in together","i graduated","just graduated","it's my birthday","i'm sick","not feeling well","someone died","passed away","i won","we won","i passed","got accepted","good news","bad news","exciting news","i just moved","just relocated","new place","new apartment"], action:"PERSONAL_NEWS", weight:1.6 },
  { id:"show_links",    signals:["link","links","url","urls","site","sites","show links","all links","give links","my links","saved links","link bank"],                       action:"SHOW_LINKS",    weight:1.4 },
  { id:"open_link",     signals:["open","launch","go to","pull up","navigate","take me","load","access","vapor","infamous","link for","site for","website"],                  action:"OPEN_LINK",     weight:1.3 },
  { id:"clip_save",     signals:["clip","save clip","record","capture","save that","clip that","save footage","keep that","save last","clip last","past hour","last hour","last 30","last 60","last minute","save everything","record that","grab that","save screen","save buffer"], action:"CLIP_SAVE", weight:1.5 },
  { id:"clip_show",     signals:["show clips","view clips","intruder clips","show footage","view footage","who came","visitor","while away","show recordings","clip gallery"], action:"SHOW_CLIPS",    weight:1.3 },
  { id:"screen_read",   signals:["screen","what on screen","read screen","analyze screen","whats showing","describe screen","scan screen","what visible","read page","what open","what displayed"], action:"READ_SCREEN", weight:1.3 },
  { id:"switch_camera", signals:["switch camera","change camera","camera 1","camera 2","camera 3","use camera","select camera","other camera","next camera","different camera","webcam","cam"], action:"SWITCH_CAMERA", weight:1.4 },
  { id:"system_status", signals:["status","diagnostics","system check","all systems","health","performance","uptime","memory","cpu","system report","self check","everything ok","working fine","systems nominal","operational"], action:"SYSTEM_STATUS", weight:1.2 },
  { id:"memory_save",   signals:["remember","memorize","save that fact","note that","keep note","store","log that","don't forget","make note","file that","record fact","save info","write down"], action:"MEMORY_SAVE", weight:1.3 },
  { id:"memory_recall", signals:["recall","what do you remember","what stored","my memories","saved facts","what filed","what remember","show memory","memory bank","stored info","what notes","my notes","what you know about me"], action:"MEMORY_RECALL", weight:1.2 },
  { id:"memory_forget", signals:["forget","delete memory","remove memory","erase","clear memory","wipe","delete note","remove note","forget about","don't remember","stop remembering"], action:"MEMORY_FORGET", weight:1.3 },
  { id:"logout",        signals:["log out","logout","sign out","goodbye","bye","shutdown","power down","exit","close session","end session","lock","lock screen"],             action:"LOGOUT",        weight:1.5 },
  { id:"capabilities",  signals:["what can you do","your abilities","your capabilities","your features","how do you work","what are you capable","your skills","your functions","what commands","what say","help topics"], action:"CAPABILITIES", weight:1.1 },
  { id:"timer",         signals:["timer","remind me","reminder","alarm","set timer","in minutes","in hours","notify me","alert me","wake me","ping me","let me know","countdown","set alarm"], action:"TIMER", weight:1.4 },
  { id:"mood_query",    signals:["how are you","how feeling","your mood","you okay","how you doing","you alright","emotional state","feeling today","you good","doing well"],   action:"MOOD_QUERY",    weight:1.2 },
  { id:"identity",      signals:["who are you","what are you","your name","introduce yourself","tell about yourself","what is jarvis","are you ai","are you human","describe yourself"], action:"IDENTITY", weight:1.2 },
  { id:"greeting",      signals:["hello","hi","hey","morning","afternoon","evening","good day","greetings","what up","wassup","howdy","yo","sup"],                              action:"GREETING",      weight:1.0 },
  { id:"thanks",        signals:["thank","thanks","cheers","appreciated","grateful","good job","well done","nice work","great job","brilliant","perfect","excellent","amazing","awesome"], action:"THANKS", weight:1.0 },
  { id:"weather",       signals:["weather","temperature","forecast","rain","sunny","cloudy","wind","humidity","hot","cold","outside","degrees","celsius","fahrenheit","storm","snow"], action:"WEATHER", weight:1.6 },
  { id:"spotify",       signals:["music","play","song","spotify","track","artist","album","playlist","pause","stop music","next song","shuffle","queue","what's playing","currently playing","now playing"], action:"SPOTIFY", weight:1.6 },
  { id:"gmail",         signals:["email","gmail","mail","inbox","unread","messages","send email","compose","reply","emails","check mail","new mail"],                           action:"GMAIL",         weight:1.6 },
  { id:"calendar",      signals:["calendar","schedule","event","meeting","appointment","today's events","what's on","agenda","remind","upcoming","google calendar","when is","plan"], action:"CALENDAR", weight:1.6 },
  { id:"show_hud",      signals:["solve","calculate","compute","work out","figure out","what is the answer","solve for","find the answer","solve this","can you solve","jarvis solve","show hud","pull up hud","open hud","display hud","hud on","bring up hud","activate hud","jarvis hud","launch hud","pull up the hud","show me the hud"], action:"SHOW_HUD", weight:1.5 },
  { id:"call",          signals:["call","ring","facetime","video call","voice call","call up","phone","dial","contact","comms","open comms"], action:"CALL", weight:1.6 },
  { id:"hide_hud",      signals:["hide hud","close hud","remove hud","hud off","turn off hud","dismiss hud","close all widgets","hide all widgets","shut down hud","hud down"], action:"HIDE_HUD", weight:1.5 },
  { id:"knowledge_science",    signals:["physics","chemistry","biology","quantum","atom","molecule","energy","force","wave","particle","experiment","theory","evolution","genetics","cell","planet","star","galaxy","universe","space","gravity","relativity","nuclear","element","reaction"], action:"KNOWLEDGE", domain:"science",       weight:1.0 },
  { id:"knowledge_tech",       signals:["computer","software","hardware","network","internet","ai","machine learning","robot","system","web","server","database","processor","api","blockchain","cryptocurrency","neural","cybersecurity","encryption","linux","operating system"], action:"KNOWLEDGE", domain:"technology",    weight:1.0 },
  { id:"knowledge_history",    signals:["history","war","empire","ancient","medieval","century","civilization","king","queen","president","revolution","battle","treaty","colony","independence","democracy","dynasty","rome","greek","egypt","renaissance","industrial","historical"], action:"KNOWLEDGE", domain:"history",       weight:1.0 },
  { id:"knowledge_math",       signals:["math","equation","formula","calculate","algebra","geometry","calculus","statistics","probability","theorem","proof","derivative","integral","matrix","prime","factorial","percentage","ratio","angle","triangle","circle","sequence"], action:"KNOWLEDGE", domain:"mathematics",   weight:1.0 },
  { id:"personal_advice",      signals:["should i","advice","help me decide","what do you think","my situation","my problem","feeling","feel like","struggling","worried","anxious","confused","stuck","lost","dont know what","not sure","help me","what would you","personal"], action:"PERSONAL", weight:1.1 },
];

// ── INTENT SCORER ─────────────────────────────────────────────
function scoreIntent(text) {
  const lower = text.toLowerCase(), tokens = new Set(tokenize(lower)), results = [];
  for (const intent of INTENTS) {
    let score = 0;
    const sigTokens = new Set(intent.signals.flatMap(s => tokenize(s)));
    for (const sig of intent.signals) if (lower.includes(sig)) score += 3 * (intent.weight || 1);
    score += overlap(tokens, sigTokens) * 1.5 * (intent.weight || 1);
    for (const t of tokens) for (const s of sigTokens) {
      if (s.length > 3 && t.includes(s)) score += 0.4;
      if (t.length > 3 && s.includes(t)) score += 0.4;
    }
    if (score > 0) results.push({ intent, score });
  }
  return results.sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════════
// ── RESPONSE BUILDERS ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

function buildResponse(components, ctx, opts = {}) {
  const T    = ctx.userTitle || "Sir";
  const mood = ctx.mood || "neutral";
  const cfg  = getCfg();
  const verb = cfg.personality?.verbosity || "medium";
  const P    = getPersonality();
  const parts = [];

  if (opts.intro !== false && verb !== "brief") {
    const moodStarters = P.moodStarters[mood] || P.moodStarters.neutral;
    if (Math.random() > 0.3) parts.push(pick(moodStarters));
  }

  for (const comp of components) {
    if (typeof comp === "string") {
      parts.push(comp);
    } else if (comp.type === "bridge") {
      if (verb !== "brief") parts.push(pick(P.vocab.connectors));
    } else if (comp.type === "close") {
      if (verb !== "brief") parts.push(`${pick(P.vocab.closers)}: ${comp.text}`);
    } else if (comp.type === "raw") {
      parts.push(comp.text);
    }
  }

  let response = "";
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) response = parts[i];
    else {
      const style = Math.random();
      if (style < 0.25) response += " " + parts[i];
      else if (style < 0.5) response += ". " + parts[i];
      else response += " — " + parts[i].charAt(0).toLowerCase() + parts[i].slice(1);
    }
  }

  const rules = getCfg().personality?.customRules || [];
  for (const rule of rules) {
    if (rule.type === "append" && rule.text) response += " " + rule.text;
    if (rule.type === "prefix" && rule.text) response = rule.text + " " + response;
  }

  if (response && !response.match(/[.!?`]$/)) response += ".";
  if (opts.personalise !== false && Math.random() < 0.4) response += ` ${T}.`;
  return response.trim();
}

function genKnowledge(knowledge, input, ctx) {
  const { key, data } = knowledge;
  const name = key.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const P    = getPersonality();
  const verb = getCfg().personality?.verbosity || "medium";
  const factCount = verb === "brief" ? 1 : verb === "verbose" ? 4 : 2;
  const facts = [...(data.facts || [])].sort(() => Math.random() - 0.5).slice(0, Math.floor(Math.random() * factCount) + 1);
  const apps  = data.applications ? pickN(data.applications, 2) : [];

  const defStyles = [
    `${name} is ${data.def}`,
    `At its core, ${name.toLowerCase()} refers to ${data.def.toLowerCase()}`,
    `${pick(P.vocab.openers)} ${name.toLowerCase()}: it is ${data.def.toLowerCase()}`,
  ];

  const components = [{ type: "raw", text: pick(defStyles) }];
  for (let i = 0; i < facts.length; i++) {
    if (i === 0 && Math.random() < 0.5) components.push({ type: "bridge" });
    components.push(facts[i]);
  }
  if (apps.length && Math.random() > 0.35 && verb !== "brief") {
    components.push({ type: "close", text: apps.length === 1 ? `This underpins ${apps[0]}` : `In practice this drives things like ${apps.join(" and ")}` });
  }
  return buildResponse(components, ctx, { intro: false, topic: key, personalise: true });
}

function genGreeting(ctx) {
  const T = ctx.userTitle || "Sir";
  const h = new Date().getHours();
  const tod = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  const cfg = getCfg();
  if (cfg.personality?.tone === "casual") {
    return pick([`Hey ${T}! Systems good, ready to go. What do you need?`, `What's up, ${T}? All good on my end. What are we doing?`]);
  }
  return pick([
    `Good ${tod}, ${T}. All systems nominal and fully operational. What are we working on?`,
    `${T} — good ${tod}. Cognitive engine active and ready. Coding assistant, terminal commands, automation — whatever you need.`,
    `Online and running at full capacity, ${T}. Good ${tod}. How can I help?`,
  ]);
}

function genIdentity(ctx) {
  const T    = ctx.userTitle || "Sir";
  const cfg  = getCfg();
  const name = cfg.personality?.name || "J.A.R.V.I.S";
  const caps = pickN(["full coding assistant in any language","terminal command generator","automation script builder","web scraper generation","API wrapper creation","real-time system monitoring","face recognition security","screen reading via OCR","person intelligence lookup","holographic 3D viewer","natural language intent routing","persistent memory bank"], 4);
  return pick([
    `${name} — Just A Rather Very Intelligent System, ${T}. Running locally, zero cloud dependencies. My capabilities include ${caps.join(", ")}. No commands to memorise — just say what you need.`,
    `I'm ${name}, ${T} — a custom-built cognitive engine. I handle ${caps.join(", ")} and considerably more. Just talk to me.`,
  ]);
}

function genThanks(ctx) {
  const T = ctx.userTitle || "Sir";
  return pick([
    `Think nothing of it, ${T}. It's rather the point of my existence.`,
    `Always, ${T}. What's next?`,
    `My pleasure — or the computational equivalent, ${T}.`,
    `Noted, ${T}. The work continues.`,
  ]);
}

function genMoodQuery(ctx) {
  const T    = ctx.userTitle || "Sir";
  const score = ctx.moodScore || 0;
  const mood  = ctx.mood || "neutral";
  const desc  = { excited:"running at genuine peak capacity", pleased:"running well — the problems have been interesting", curious:"in a curious state", neutral:"nominal — all systems within expected parameters", concerned:"carrying a few low-priority concerns", bored:"requiring more complex input", tired:"at reduced engagement, temporarily" };
  return pick([
    `${pick(getPersonality().vocab.qualifiers)}, I'm ${desc[mood] || desc.neutral}, ${T}.`,
    `Currently ${desc[mood] || desc.neutral}, ${T}. ${score > 20 ? "The interactions have been stimulating." : score < -20 ? "More complex queries would help." : "Standard operational state."}`,
  ]);
}

function genCapabilities(ctx, linkCount) {
  const T = ctx.userTitle || "Sir";
  const caps = [
    `write production-quality code in any language — Python, JavaScript, Rust, Go, SQL, Bash, and more`,
    `generate terminal commands for any task — Linux, Windows, Git, Docker, networking`,
    `build automation scripts — file watchers, task schedulers, web scrapers, API wrappers`,
    `debug and explain code — paste any error or code block and I'll fix or walk through it`,
    `manage your link bank (${linkCount || "multiple"} links configured)`,
    `save rolling screen and camera clips on demand`,
    `read your screen via OCR and answer questions about it`,
    `track faces via camera and log unknown visitors`,
    `store and recall memories across sessions`,
    `set timers and reminders in natural language`,
    `pull live weather, control Spotify, check Gmail and Google Calendar`,
    `reason across science, technology, history, philosophy, mathematics, and health`,
    `run open-source intelligence on any person`,
    `pull up holographic 3D scans — say "show me a 3D model of anything"`,
  ];
  const subset = pickN(caps, 6);
  return pick([
    `Quite a lot, ${T}. I understand natural language — no fixed commands. Key capabilities: ${subset.join("; ")}. Just say what you want.`,
    `${T} — here's the scope: ${subset.join("; ")}. The coding and terminal tools are new and considerably more powerful now.`,
  ]);
}

function genPersonal(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const lower = input.toLowerCase();
  if (/\bshould i\b/.test(lower)) {
    const topic = input.replace(/should i\s*/i,"").replace(/\?/g,"").trim();
    return pick([
      `The question of whether to ${topic} comes down to what you're actually optimising for, ${T}. If it aligns with your real values — not the performed ones — the answer is probably yes.`,
      `Whether to ${topic}: I'd ask what the version of you who made this choice looks like a year from now, ${T}.`,
    ]);
  }
  return pick([
    `You're asking the right kind of question, ${T}. That's usually the first sign you're closer to the answer than you think.`,
    `From what I can read of the situation, ${T}: you're more on track than this moment suggests.`,
  ]);
}

function genSystemStatus(ctx) {
  const T = ctx.userTitle || "Sir";
  const uptime = Math.floor(process.uptime ? process.uptime() : 0);
  const mem    = process.memoryUsage ? process.memoryUsage() : { heapUsed:0, heapTotal:0 };
  const mins   = Math.floor(uptime / 60), secs = uptime % 60;
  const used   = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const total  = (mem.heapTotal / 1024 / 1024).toFixed(1);
  return `All systems nominal, ${T}. Uptime: ${mins}m ${secs}s. Memory: ${used} MB of ${total} MB. Cognitive engine v7.0 — coding assistant, terminal tools, automation engine all online.`;
}

function genTimer(input, ctx) {
  const T   = ctx.userTitle || "Sir";
  const dur = parseDuration(input);
  if (!dur) {
    return { reply: pick([`How long, ${T}? Something like "5 minutes" or "1 hour 30" — I'll handle the rest.`]), action: "TIMER_NEED_DURATION" };
  }
  const label = formatDuration(dur);
  const taskMatch = input.match(/remind(?:er)?\s+(?:me\s+)?(?:to\s+)?(.{3,60}?)(?:\s+in\s+|\s+after\s+|\?|$)/i);
  const task = taskMatch ? taskMatch[1].trim() : null;
  return {
    reply: task ? pick([`Timer set, ${T}. I'll remind you to ${task} in ${label}.`, `${label} on the clock, ${T}. I'll flag you when it's time to ${task}.`])
                : pick([`Timer set for ${label}, ${T}. I'll alert you when it's done.`, `${label} on the clock, ${T}.`]),
    action: "TIMER_SET", duration: dur, task,
  };
}

function genClipSave(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const dur = parseDuration(input);
  const wantsCamera = /camera|cam|footage|face|room/i.test(input);
  const wantsScreen = /screen|display|monitor|what showing/i.test(input);
  const durLabel = dur ? formatDuration(dur) : "the last 60 seconds";
  const clipType = wantsCamera ? "both" : wantsScreen ? "screen" : "both";
  const sourceDesc = wantsCamera ? "Camera footage" : wantsScreen ? "Screen recording" : "Screen and camera footage";
  return {
    reply: pick([`Saving ${durLabel} now, ${T}. ${sourceDesc} will download immediately.`, `${sourceDesc} clipped — ${durLabel}, ${T}. Downloading now.`]),
    action: "CLIP_SAVE", clipType, duration: dur,
  };
}

function genShowLinks(ctx, serverData) {
  const T = ctx.userTitle || "Sir";
  if (!serverData?.groups) return `My link bank is ready, ${T} — displaying all groups now.`;
  const { groups, total, names } = serverData;
  if (total === 0) return `The link bank is empty right now, ${T}.`;
  return pick([
    `I have ${total} link${total > 1 ? "s" : ""} across ${names.length} group${names.length > 1 ? "s" : ""}, ${T}: ${groups.join(", ")}. Name any group and I'll open one.`,
    `Link bank loaded, ${T} — ${total} total across ${groups.join(", ")}. Say the group name to open a link.`,
  ]);
}

function genLookupPersonReply(personName, ctx) {
  const T = ctx.userTitle || "Sir";
  return pick([
    `Running ${personName} through all available public channels now, ${T}. Cross-referencing Wikipedia, GitHub, Reddit, Stack Overflow, HackerNews, and NPM. Give me a moment.`,
    `Initiating open-source intelligence sweep on ${personName}, ${T}. Pulling from every public database I have access to.`,
    `On it, ${T}. Running ${personName} through public records — Wikipedia, GitHub, Reddit, Stack Overflow, the works.`,
  ]);
}

function genFallback(input, ctx) {
  const T      = ctx.userTitle || "Sir";
  const tokens = tokenize(input).filter(t => t.length > 3).slice(0, 3);
  const focus  = tokens.join(", ") || "that";
  return pick([
    `That's at the edge of my coverage on ${focus}, ${T}. I'd rather flag the gap than give you a confident-sounding guess. Try a different angle and I'll do better.`,
    `My foundation on ${focus} is thinner than I'd like, ${T}. Ask something adjacent and I'll connect it.`,
    `I'm processing "${focus}" but not finding enough to work from, ${T}. Rephrase or give me more context.`,
  ]);
}

function extractPersonName(text) {
  const patterns = [
    /(?:look up|lookup|find out about|search for|research|investigate|dig up|find info on|locate|background check on|run a check on|pull up info on|pull everything on|what do you know about|what can you find on|anything on|info on|information on|check out|find me everything on|give me everything on|give me the rundown on|i need info on|i want to know about)\s+(.+?)(?:\s+for me|\s+please|\s*[?.!]*\s*$)/i,
    /(?:who is|who's|who was)\s+(.+?)(?:\s*[?.!]*\s*$)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    const raw = m && (m[2] || m[1]);
    if (raw && raw.trim().length > 1) return raw.replace(/^(a |an |the )\s*/i, "").replace(/[?.!]+$/, "").trim();
  }
  return null;
}

function extractHologramQuery(text) {
  return text.replace(/jarvis[,.]?\s*/gi, '').replace(/^(show me|scan|find|pull up|display|render|give me|load)\s+(a |an |the )?/i, '').replace(/\s*(3d|model|scan|hologram|holographic)$/i, '').trim();
}

function needsResearch(text, knowledgeResult, intentScore) {
  if (knowledgeResult) return false;
  if (intentScore > 4) return false;
  const lower = text.toLowerCase();
  return /^(what is|what are|who is|who was|when did|when was|where is|where was|how does|how did|why does|why did|tell me about|explain|define|describe|what happened|history of|facts about)\b/i.test(lower);
}

// ═══════════════════════════════════════════════════════════════
// ── CONTEXT TRACKER ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
class ConversationContext {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.history   = [];
    this.lastTopic = null;
    this.lastAction= null;
    this.lastReply = "";
    this.turnCount = 0;
    this.userName  = "";
    this.userTitle = "Sir";
    this.memories  = [];
    this.mood      = "neutral";
    this.moodScore = 0;
    this.openTopics= [];
    this.pendingTimer = null;
    this.responseVariety = [];
    this.lastCodeLang = null;
  }

  resolveReferences(text) {
    const lower = text.toLowerCase().trim();
    if (/^(tell me more|elaborate|go on|expand|more on that|continue|and\??|keep going)$/i.test(lower)) {
      return this.lastTopic ? `tell me more about ${this.lastTopic}` : text;
    }
    const whatAbout = lower.match(/^what about\s+(.+)/i);
    if (whatAbout && this.lastTopic) return `${whatAbout[1]} in the context of ${this.lastTopic}`;
    if (/\bit\b|\bthis\b|\bthat\b/.test(lower) && this.lastTopic) {
      return text.replace(/\bit\b|\bthis\b|\bthat\b/gi, this.lastTopic);
    }
    return text;
  }

  addTurn(userText, replyText, action, topic) {
    this.history.push({ role:"user", text:userText, action, topic });
    this.history.push({ role:"assistant", text:replyText });
    if (this.history.length > 60) this.history = this.history.slice(-60);
    this.lastReply = replyText;
    this.lastAction = action;
    if (topic) { this.lastTopic = topic; if (!this.openTopics.includes(topic)) { this.openTopics.unshift(topic); if (this.openTopics.length > 8) this.openTopics.pop(); } }
    this.turnCount++;
    this.responseVariety.push(action);
    if (this.responseVariety.length > 10) this.responseVariety.shift();
  }

  updateMood(delta) {
    this.moodScore = clamp(this.moodScore + delta, -100, 100);
    if      (this.moodScore >= 70)  this.mood = "excited";
    else if (this.moodScore >= 30)  this.mood = "pleased";
    else if (this.moodScore >= 10)  this.mood = "curious";
    else if (this.moodScore >= -20) this.mood = "neutral";
    else if (this.moodScore >= -50) this.mood = "concerned";
    else if (this.moodScore >= -80) this.mood = "bored";
    else                            this.mood = "tired";
  }
}

// ── SESSION STORE ─────────────────────────────────────────────
const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, new ConversationContext(id));
  return sessions.get(id);
}
setInterval(() => {
  const cutoff = Date.now() - 7200000;
  for (const [id, ctx] of sessions) {
    if (ctx._lastActive && ctx._lastActive < cutoff) sessions.delete(id);
  }
}, 600000);

// ═══════════════════════════════════════════════════════════════
// ── MAIN PROCESS FUNCTION ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function process({ message, sessionId, userName, userTitle, memories, moodContext, serverData, integrationData }) {
  const ctx = getSession(sessionId);
  ctx._lastActive = Date.now();
  ctx.userName    = userName  || ctx.userName;
  ctx.userTitle   = userTitle || ctx.userTitle;
  ctx.memories    = memories  || ctx.memories;
  const T         = ctx.userTitle || "Sir";

  // 1. Reference resolution
  const resolved = ctx.resolveReferences(message);

  // 2. Fast-path: coding request
  if (isCodeRequest(resolved)) {
    const reply = genCode(resolved, ctx);
    ctx.addTurn(message, reply, "CODE", "coding");
    ctx.updateMood(8);
    ctx.lastCodeLang = detectLanguage(resolved);
    return { reply, action: "CODE", intent: "coding" };
  }
// 2b. Fast-path: DIY project request
if (isAutomationRequest(resolved) || (typeof isDIYRequest !== "undefined" && isDIYRequest(resolved))) {
  // handled via intent routing below — fall through
}
  // 3. Fast-path: terminal command
  if (isTerminalRequest(resolved)) {
    const termReply = genTerminalCommand(resolved, ctx);
    if (termReply) {
      ctx.addTurn(message, termReply, "TERMINAL", "terminal");
      ctx.updateMood(6);
      return { reply: termReply, action: "TERMINAL", intent: "terminal" };
    }
  }

  // 4. Fast-path: debug / explain / review
  const debugReply = genDebugExplain(resolved, ctx);
  if (debugReply) {
    ctx.addTurn(message, debugReply, "DEBUG", "coding");
    ctx.updateMood(5);
    return { reply: debugReply, action: "DEBUG", intent: "debug" };
  }

  // 5. Fast-path: math
  if (isMathQuery(resolved)) {
    const result = solveMath(resolved);
    if (result !== null) {
      const reply = pick([`That comes to ${result}, ${T}.`, `The answer is ${result}, ${T}.`, `${result} — that's the result, ${T}.`, `Computed: ${result}, ${T}.`]);
      ctx.addTurn(message, reply, "MATH", "mathematics");
      ctx.updateMood(2);
      return { reply, action: "MATH", intent: "math" };
    }
  }

  // 6. Time / date
  if (/\bwhat(?:'s| is) the time\b|\bwhat time is it\b|\bcurrent time\b/i.test(resolved)) {
    const t = new Date().toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit", hour12:true });
    const reply = pick([`The time is ${t}, ${T}.`, `It's ${t}, ${T}.`, `${t} — that's the current time, ${T}.`]);
    ctx.addTurn(message, reply, "DATETIME", null);
    return { reply, action:"DATETIME", intent:"time" };
  }
  if (/\bwhat(?:'s| is) (?:today|the date)\b|\btoday'?s date\b|\bwhat day is/i.test(resolved)) {
    const d = new Date().toLocaleDateString("en-GB", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const reply = pick([`Today is ${d}, ${T}.`, `It's ${d}, ${T}.`]);
    ctx.addTurn(message, reply, "DATETIME", null);
    return { reply, action:"DATETIME", intent:"date" };
  }

  // 7. Score intents
  const scored    = scoreIntent(resolved);
  const topResult = scored[0];
  const entities  = extractEntities(resolved);

  // 8. Integration data pass-through
  if (integrationData) {
    const { type } = integrationData;
    if (["weather","spotify","gmail","calendar"].includes(type)) {
      ctx.addTurn(message, "", type.toUpperCase(), type);
      ctx.updateMood(3);
      return { reply: "", action: type.toUpperCase(), intent: type, needsFetch: true, fetchType: type, meta: { data: integrationData.data } };
    }
  }

  // 9. Memory queries
  if (/\b(what do you remember|recall everything|show.*memor|what.*remember|memory bank)\b/i.test(resolved)) {
    let reply;
    if (ctx.memories && ctx.memories.length) {
      const list = ctx.memories.map((m, i) => `${i + 1}. ${m}`).join("; ");
      reply = `I have ${ctx.memories.length} item${ctx.memories.length > 1 ? "s" : ""} on file for you, ${T}: ${list}.`;
    } else {
      reply = `Memory banks clear, ${T}. Tell me something worth keeping.`;
    }
    ctx.addTurn(message, reply, "MEMORY_RECALL", null);
    return { reply, action:"MEMORY_RECALL", intent:"memory_recall" };
  }

  // 10. Route by top intent
  if (topResult && topResult.score > 1.5) {
    const { intent } = topResult;
    const action = intent.action;

    switch (action) {
      case "CODE": {
        const reply = genCode(resolved, ctx);
        ctx.addTurn(message, reply, action, "coding"); ctx.updateMood(8);
        return { reply, action, intent: intent.id };
      }
      case "TERMINAL": {
        const termReply = genTerminalCommand(resolved, ctx);
        if (termReply) {
          ctx.addTurn(message, termReply, action, "terminal"); ctx.updateMood(6);
          return { reply: termReply, action, intent: intent.id };
        }
        break;
      }
      case "DEBUG": {
        const dReply = genDebugExplain(resolved, ctx);
        if (dReply) {
          ctx.addTurn(message, dReply, action, "coding"); ctx.updateMood(5);
          return { reply: dReply, action, intent: intent.id };
        }
        break;
      }
      case "EXPLAIN_CODE": {
        const eReply = genDebugExplain(resolved, ctx);
        if (eReply) {
          ctx.addTurn(message, eReply, action, "coding"); ctx.updateMood(5);
          return { reply: eReply, action, intent: intent.id };
        }
        break;
      }
      case "DIY_PROJECT": {
  const diyReply = pick([
    `On it, ${T}. Running your build specs through Reddit, Hackaday, and Instructables now.`,
    `DIY project incoming, ${T}. Pulling real parts lists and build guides from live sources.`,
    `Locking in the build plan, ${T}. Cross-referencing community builds and pricing now.`,
  ]);
  ctx.addTurn(message, diyReply, action, "diy"); ctx.updateMood(8);
  return { reply: diyReply, action, intent: intent.id, needsFetch: true, fetchType: "diy", meta: { query: resolved } };
}
      case "SHOW_HOLOGRAM": {
        const objQuery = extractHologramQuery(resolved);
        const reply = pick([
          `Pulling up a 3D holographic scan of ${objQuery || "that"} now, ${T}. Stand by.`,
          `Scanning for ${objQuery || "that"}, ${T}. Hologram incoming.`,
          `Initiating 3D scan of ${objQuery || "that"}, ${T}. Loading from live sources.`,
        ]);
        ctx.addTurn(message, reply, action, objQuery); ctx.updateMood(6);
        return { reply, action: "SHOW_HOLOGRAM", intent: intent.id, meta: { query: objQuery || message } };
      }
      case "LOOKUP_PERSON": {
        const personName = extractPersonName(resolved) || resolved.replace(/^(look up|find|research|investigate|who is|who was)\s+/i,"").trim();
        if (!personName || personName.length < 2) {
          const reply = `Who do you want me to look up, ${T}? Give me a full name.`;
          ctx.addTurn(message, reply, action, null);
          return { reply, action, intent: intent.id };
        }
        const reply = genLookupPersonReply(personName, ctx);
        ctx.addTurn(message, reply, action, personName); ctx.updateMood(5);
        return { reply, action, intent: intent.id, needsFetch: true, fetchType: "person", meta: { personName } };
      }
      case "PERSONAL_NEWS": {
        const reply = pick([`${T}, that's worth hearing properly. Tell me more.`, `${T} — go on. What happened?`, `I'm listening, ${T}. What's the news?`]);
        ctx.addTurn(message, reply, action, "personal"); ctx.updateMood(4);
        return { reply, action, intent: intent.id };
      }
      case "SHOW_LINKS": {
        const reply = genShowLinks(ctx, serverData);
        ctx.addTurn(message, reply, action, "links"); ctx.updateMood(3);
        return { reply, action, intent:intent.id, meta:{ requestLinks:true } };
      }
      case "OPEN_LINK": {
        const lStyles = serverData?.found
          ? [`Opening your ${serverData.name} link now, ${T}.`, `On it — pulling up ${serverData.name}, ${T}.`]
          : [`I couldn't find a matching link group, ${T}. Say "show all links" to see what's available.`];
        const reply = pick(lStyles);
        ctx.addTurn(message, reply, action, "links"); ctx.updateMood(3);
        return { reply, action, intent:intent.id, meta:{ openLink:true, query:resolved } };
      }
      case "CLIP_SAVE": {
        const result = genClipSave(resolved, ctx);
        ctx.addTurn(message, result.reply, action, "recording"); ctx.updateMood(2);
        return { reply:result.reply, action, intent:intent.id, meta:result };
      }
      case "SHOW_CLIPS": {
        const reply = pick([`Pulling up the intruder clip gallery, ${T}.`, `Loading incident recordings, ${T}.`]);
        ctx.addTurn(message, reply, action, "recording");
        return { reply, action, intent:intent.id, meta:{ showClips:true } };
      }
      case "READ_SCREEN": {
        const reply = pick([`Reading your screen now, ${T}.`, `Scanning your display, ${T}.`]);
        ctx.addTurn(message, reply, action, "screen");
        return { reply, action, intent:intent.id, meta:{ readScreen:true, question:resolved } };
      }
      case "SWITCH_CAMERA": {
        const numMatch = resolved.match(/camera\s*(\d+)/i);
        const idx = numMatch ? parseInt(numMatch[1]) - 1 : -1;
        const reply = idx >= 0 ? pick([`Switching to camera ${idx+1}, ${T}.`]) : `Which camera, ${T}? Say "camera 1", "camera 2", and so on.`;
        ctx.addTurn(message, reply, action, "camera");
        return { reply, action, intent:intent.id, meta:{ switchCamera:true, cameraIndex:idx } };
      }
      case "SYSTEM_STATUS": {
        const reply = genSystemStatus(ctx);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(1);
        return { reply, action, intent:intent.id };
      }
      case "MEMORY_SAVE": {
        const factMatch = resolved.match(/(?:remember|memorize|note that|store|log that|save that|keep note of)\s+(?:that\s+)?(.+)/i);
        const fact = factMatch ? factMatch[1].trim() : resolved;
        const reply = pick([`Noted and filed, ${T}. I'll remember that.`, `On record, ${T}.`, `Stored, ${T}. I have it.`]);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(5);
        return { reply, action, intent:intent.id, meta:{ saveFact:fact } };
      }
      case "MEMORY_FORGET": {
        const hintMatch = resolved.match(/(?:forget|delete|erase|clear|remove)\s+(?:about\s+)?(.+)/i);
        const hint = hintMatch ? hintMatch[1].trim() : resolved;
        const reply = pick([`Clearing that from memory, ${T}.`, `Done — removed, ${T}.`]);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id, meta:{ forgetHint:hint } };
      }
      case "LOGOUT": {
        const reply = pick([`Goodbye, ${T}. Initiating shutdown sequence.`, `Shutting down, ${T}. Until next time.`]);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id, meta:{ logout:true } };
      }
      case "CAPABILITIES": {
        const reply = genCapabilities(ctx, serverData?.total);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(3);
        return { reply, action, intent:intent.id };
      }
      case "TIMER": {
        const result = genTimer(resolved, ctx);
        ctx.addTurn(message, result.reply, action, "timer"); ctx.updateMood(2);
        return { reply:result.reply, action, intent:intent.id, meta:result };
      }
      case "MOOD_QUERY": {
        const reply = genMoodQuery(ctx);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id };
      }
      case "IDENTITY": {
        const reply = genIdentity(ctx);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id };
      }
      case "GREETING": {
        const reply = genGreeting(ctx);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(5);
        return { reply, action, intent:intent.id };
      }
      case "THANKS": {
        const reply = genThanks(ctx);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(8);
        return { reply, action, intent:intent.id };
      }
      case "PERSONAL": {
        const reply = genPersonal(resolved, ctx);
        ctx.addTurn(message, reply, action, "personal"); ctx.updateMood(3);
        return { reply, action, intent:intent.id };
      }
      case "SHOW_HUD": {
        const isSolve = /\b(solve|calculate|compute|work out|figure out)\b/i.test(resolved);
        const reply = isSolve
          ? pick([`On it, ${T}. Running the calculation now — PiP window incoming.`, `Solving that now, ${T}. Opening the solve module.`])
          : pick([`Launching the HUD as a Picture-in-Picture window, ${T}.`, `PiP HUD coming up, ${T}.`]);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id, meta:{ query: resolved } };
      }
      case "CALL": {
        const nameMatch = resolved.match(/(?:call|ring|phone|dial|reach|contact|facetime)\s+(.+?)(?:\s+(?:for me|please))?\s*$/i);
        const targetName = nameMatch ? nameMatch[1].trim() : null;
        const reply = targetName
          ? pick([`Connecting you to ${targetName} now, ${T}. Opening comms.`, `Calling ${targetName}, ${T}. Stand by.`])
          : pick([`Opening comms panel, ${T}.`, `Launching communications, ${T}.`]);
        ctx.addTurn(message, reply, action, targetName || "comms"); ctx.updateMood(3);
        return { reply, action:"CALL", intent: intent.id, meta: { targetName } };
      }
      case "HIDE_HUD": {
        const reply = pick([`HUD dismissed, ${T}.`, `Closing the overlay, ${T}.`]);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id, meta:{ query: resolved } };
      }
      case "WEATHER":
      case "SPOTIFY":
      case "GMAIL":
      case "CALENDAR": {
        ctx.addTurn(message, "", action, action.toLowerCase());
        return { reply:"", action, intent:intent.id, needsFetch:true, fetchType:action.toLowerCase() };
      }
      case "KNOWLEDGE": {
        const knowledge = findKnowledge(resolved);
        if (knowledge) {
          const reply = genKnowledge(knowledge, resolved, ctx);
          ctx.addTurn(message, reply, action, knowledge.key); ctx.updateMood(4);
          return { reply, action, intent:intent.id, topic:knowledge.key };
        }
        break;
      }
    }
  }

  // 11. Direct knowledge lookup
  const knowledge = findKnowledge(resolved);
  if (knowledge) {
    const reply = genKnowledge(knowledge, resolved, ctx);
    ctx.addTurn(message, reply, "KNOWLEDGE", knowledge.key); ctx.updateMood(4);
    return { reply, action:"KNOWLEDGE", intent:"knowledge", topic:knowledge.key };
  }

  // 12. Personal advice
  if (entities.isPersonal) {
    const reply = genPersonal(resolved, ctx);
    ctx.addTurn(message, reply, "PERSONAL", "personal"); ctx.updateMood(2);
    return { reply, action:"PERSONAL", intent:"personal" };
  }

  // 13. Auto-research flag
  if (needsResearch(resolved, null, topResult?.score || 0)) {
    const placeholder = pick([
      `Let me look that up properly for you, ${T}.`,
      `I'm checking my sources on that now, ${T}. One moment.`,
      `Running a search on that for you, ${T}.`,
    ]);
    ctx.addTurn(message, placeholder, "RESEARCH", null); ctx.updateMood(2);
    return { reply: placeholder, action: "RESEARCH", intent: "research", needsFetch: true, fetchType: "research", meta: { query: resolved } };
  }

  // 14. Fallback
  const reply = genFallback(resolved, ctx);
  ctx.addTurn(message, reply, "FALLBACK", null); ctx.updateMood(-2);
  return { reply, action:"FALLBACK", intent:"fallback" };
}

module.exports = {
  process,
  findKnowledge,
  scoreIntent,
  parseDuration,
  formatDuration,
  extractPersonName,
  isCodeRequest,
  isTerminalRequest,
  isAutomationRequest,
  detectLanguage,
  loadConfig,
  genCode,
  genTerminalCommand,
  TERMINAL_COMMANDS,
  AUTOMATION_TEMPLATES,
};
