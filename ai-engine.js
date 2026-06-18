"use strict";

// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Generative AI Engine v7.0
// UPGRADED: Full coding assistant · Terminal commands · Automation
// Network tools · File ops · Script generation · Smart responses
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

// ── LAZY GROQ LOADER ───────────────────────────────────────────
// Used to check what Groq has TAUGHT this brain previously, before
// giving up with a fallback. Lazy + try/catch so a missing or
// broken groq-engine.js never takes down the local rule engine.
let _Groq = null;
function getGroq() {
  if (_Groq === null) {
    try { _Groq = require("./groq-engine"); } catch { _Groq = false; }
  }
  return _Groq || null;
}

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
// ══════════════════════════════════════════════════════════════���[...]
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

const CODE_INTENT = /\b(?:write|create|build|make|generate|code|script|program|function|class|implement|develop|give me|show me|debug|fix|refactor|optimise|optimize|explain|review|improve)\b.*\b(?:code|script|function|snippet|example|module|component|program)\b/i;

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
  .on('add', path => console.log('[JARVIS] File added: ' + path))
  .on('change', path => console.log('[JARVIS] File changed: ' + path))
  .on('unlink', path => console.log('[JARVIS] File removed: ' + path));

module.exports = watcher;` 
};

