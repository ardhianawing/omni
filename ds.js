#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
//  DeepSeek CLI — Interactive AI Coding Assistant
//  Like Claude Code, but powered by DeepSeek
// ═══════════════════════════════════════════════════════════

const https = require("https");
const readline = require("readline");
const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");
const os = require("os");

// ── Paths ──
const HOME = os.homedir();
const DS_DIR = path.join(HOME, ".deepseek");
const CONFIG_PATH = path.join(DS_DIR, "config.json");
const SESSIONS_DIR = path.join(DS_DIR, "sessions");
const HISTORY_PATH = path.join(DS_DIR, "history");
[DS_DIR, SESSIONS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── CLI Args ──
const args = process.argv.slice(2);
const BYPASS_MODE = args.includes("--bypass");
const READONLY_MODE = process.env.DEEPSEEK_READONLY === "1";
const argModel = getArg("-m") || getArg("--model");
const argResume = getArg("-r") || getArg("--resume");

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

// ── API Key ──
const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error("\x1b[31mError: DEEPSEEK_API_KEY not set.\x1b[0m");
  console.error("Run: export DEEPSEEK_API_KEY=your_api_key");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════
//  Config
// ═══════════════════════════════════════════════════════════
const DEFAULT_CONFIG = {
  model: "deepseek-chat",
  temperature: 0.7,
  autoContext: true,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH))
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {}
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
if (argModel) config.model = argModel;

// ═══════════════════════════════════════════════════════════
//  Colors
// ═══════════════════════════════════════════════════════════
const C = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  italic: (s) => `\x1b[3m${s}\x1b[23m`,
  underline: (s) => `\x1b[4m${s}\x1b[24m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
  blue: (s) => `\x1b[34m${s}\x1b[39m`,
  magenta: (s) => `\x1b[35m${s}\x1b[39m`,
  cyan: (s) => `\x1b[36m${s}\x1b[39m`,
  gray: (s) => `\x1b[90m${s}\x1b[39m`,
};

// ═══════════════════════════════════════════════════════════
//  Spinner
// ═══════════════════════════════════════════════════════════
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinTimer = null,
  spinIdx = 0;

function startSpinner(text = "Thinking") {
  spinIdx = 0;
  spinTimer = setInterval(() => {
    process.stdout.write(`\r${C.cyan(SPIN[spinIdx])} ${C.dim(text)}   `);
    spinIdx = (spinIdx + 1) % SPIN.length;
  }, 80);
}

function stopSpinner() {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
    process.stdout.write("\r\x1b[K");
  }
}

// ═══════════════════════════════════════════════════════════
//  Markdown Renderer (for static content)
// ═══════════════════════════════════════════════════════════
function renderMarkdown(text) {
  const lines = text.split("\n");
  let result = [],
    inCode = false,
    codeLang = "",
    codeLines = [];

  for (const line of lines) {
    const codeMatch = line.match(/^```(\w*)/);
    if (codeMatch) {
      if (!inCode) {
        inCode = true;
        codeLang = codeMatch[1] || "";
        codeLines = [];
      } else {
        result.push(C.dim(`  ┌─ ${codeLang || "code"} ${"─".repeat(Math.max(0, 40 - (codeLang || "code").length))}`));
        for (const cl of codeLines)
          result.push(`  ${C.dim("│")} ${highlightSyntax(cl, codeLang)}`);
        result.push(C.dim(`  └${"─".repeat(44)}`));
        inCode = false;
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (line.match(/^### /)) { result.push(C.bold(C.cyan("   " + line.slice(4)))); continue; }
    if (line.match(/^## /)) { result.push(C.bold(C.cyan("  " + line.slice(3)))); continue; }
    if (line.match(/^# /)) { result.push(C.bold(C.cyan(line.slice(2)))); continue; }
    if (line.match(/^> /)) { result.push(C.dim("  │ ") + C.italic(line.slice(2))); continue; }
    if (line.match(/^(\s*)[*-] /)) {
      const content = line.replace(/^(\s*)[*-] /, "");
      const indent = line.match(/^(\s*)/)[1];
      result.push(`${indent}  • ${inlineFmt(content)}`);
      continue;
    }
    if (line.match(/^---+$/)) { result.push(C.dim("  " + "─".repeat(44))); continue; }
    result.push(inlineFmt(line));
  }
  return result.join("\n");
}

function inlineFmt(t) {
  t = t.replace(/\*\*(.+?)\*\*/g, (_, m) => C.bold(m));
  t = t.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, (_, m) => C.italic(m));
  t = t.replace(/`([^`]+)`/g, (_, m) => C.cyan(m));
  t = t.replace(/\[(.+?)\]\((.+?)\)/g, (_, txt, url) => `${C.underline(C.blue(txt))} ${C.dim(`(${url})`)}`);
  return t;
}

// ═══════════════════════════════════════════════════════════
//  Syntax Highlighting
// ═══════════════════════════════════════════════════════════
const KW = {
  js: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|try|catch|throw|typeof|instanceof|switch|case|break|default|of|in)\b/g,
  py: /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|lambda|yield|raise|pass|break|continue|and|or|not|in|is|True|False|None|self|print)\b/g,
  sh: /\b(if|then|else|fi|for|do|done|while|case|esac|function|return|echo|exit|export|source|cd|ls|grep|awk|sed|cat|mkdir|rm|cp|mv)\b/g,
  go: /\b(func|package|import|return|if|else|for|range|switch|case|break|default|var|const|type|struct|interface|map|chan|go|defer|select|nil|true|false)\b/g,
  rs: /\b(fn|let|mut|pub|use|mod|struct|enum|impl|trait|return|if|else|for|while|loop|match|self|super|crate|where|async|await|move|ref|type|const|static|true|false)\b/g,
};
KW.javascript = KW.js;
KW.python = KW.py;
KW.bash = KW.sh;
KW.rust = KW.rs;
KW.typescript = KW.js;
KW.ts = KW.js;

function highlightSyntax(line, lang) {
  let r = line;
  r = r.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, (m) => C.green(m));
  r = r.replace(/(\/\/.*$|#.*$)/g, (m) => C.gray(m));
  if (KW[lang]) r = r.replace(KW[lang], (m) => C.magenta(m));
  r = r.replace(/\b(\d+\.?\d*)\b/g, (m) => C.yellow(m));
  return r;
}

// ═══════════════════════════════════════════════════════════
//  Token & Cost Tracking
// ═══════════════════════════════════════════════════════════
let sessionTokens = { input: 0, output: 0, reasoning: 0 };
const PRICING = {
  "deepseek-chat": { input: 0.14, output: 0.28 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
};

function trackUsage(usage) {
  if (!usage) return;
  const inp = usage.prompt_tokens || 0;
  const out = usage.completion_tokens || 0;
  sessionTokens.input += inp;
  sessionTokens.output += out;
  if (turnStats) {
    turnStats.turnTokens.input += inp;
    turnStats.turnTokens.output += out;
  }
}

function tokenStats() {
  const p = PRICING[config.model] || PRICING["deepseek-chat"];
  const cost = (sessionTokens.input / 1e6) * p.input + (sessionTokens.output / 1e6) * p.output;
  return { ...sessionTokens, total: sessionTokens.input + sessionTokens.output, cost: `$${cost.toFixed(6)}` };
}

// ═══════════════════════════════════════════════════════════
//  Turn Stats & Session Log
// ═══════════════════════════════════════════════════════════
let turnCounter = 0;
let turnStats = null;
let sessionLog = [];

function resetTurnStats() {
  turnStats = {
    startTime: Date.now(),
    actions: [],
    toolsUsed: { read: 0, write: 0, edit: 0, delete: 0, command: 0, search: 0 },
    turnTokens: { input: 0, output: 0 },
  };
}

function logAction(name, args, result, duration) {
  const entry = {
    timestamp: new Date().toISOString(),
    tool: name,
    args: typeof args === "object" ? { ...args } : args,
    resultPreview: (result.out || "").substring(0, 120),
    ok: !!result.ok,
    duration,
  };
  if (turnStats) turnStats.actions.push(entry);
  sessionLog.push(entry);
  if (turnStats) {
    const toolMap = {
      read_file: "read", write_file: "write", edit_file: "edit",
      delete_file: "delete", run_command: "command",
      search_files: "search", search_content: "search",
    };
    const key = toolMap[name];
    if (key) turnStats.toolsUsed[key]++;
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ═══════════════════════════════════════════════════════════
//  Auto Project Context
// ═══════════════════════════════════════════════════════════
function detectProject() {
  const cwd = process.cwd();
  let ctx = [`Working directory: ${cwd}`];
  try {
    if (fs.existsSync(path.join(cwd, ".git"))) {
      const branch = execSync("git branch --show-current 2>/dev/null", { encoding: "utf8", cwd }).trim();
      ctx.push(`Git repo, branch: ${branch}`);
    }
  } catch {}
  const checks = [
    ["package.json", (f) => { const p = JSON.parse(fs.readFileSync(f, "utf8")); return `Node.js: ${p.name || "unknown"}@${p.version || "?"}`; }],
    ["requirements.txt", () => "Python project (requirements.txt)"],
    ["pyproject.toml", () => "Python project (pyproject.toml)"],
    ["Cargo.toml", () => "Rust project"],
    ["go.mod", () => "Go project"],
    ["pubspec.yaml", () => "Flutter/Dart project"],
  ];
  for (const [file, detect] of checks) {
    const fp = path.join(cwd, file);
    if (fs.existsSync(fp)) {
      try { ctx.push(detect(fp)); } catch {}
      break;
    }
  }
  return ctx.join("\n");
}

// ═══════════════════════════════════════════════════════════
//  Tools Definition
// ═══════════════════════════════════════════════════════════
const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a bash command and return output",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Bash command to execute" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read contents of a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit file by replacing exact text",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          old_text: { type: "string", description: "Text to find" },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file or directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path to delete" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for files matching a glob pattern",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern like '**/*.js'" },
          dir: { type: "string", description: "Directory to search in (default: cwd)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_content",
      description: "Search file contents with regex (like grep)",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex)" },
          dir: { type: "string", description: "Directory to search (default: cwd)" },
          glob: { type: "string", description: "File filter like '*.js'" },
        },
        required: ["pattern"],
      },
    },
  },
];

const SAFE_TOOLS = ["read_file", "search_files", "search_content"];
const DANGEROUS_TOOLS = ["delete_file", "run_command"];
const WRITE_TOOLS = ["write_file", "edit_file"];

// ═══════════════════════════════════════════════════════════
//  ENHANCED TOOL EXECUTION WITH SAFETY CHECKS
// ═══════════════════════════════════════════════════════════
function executeTool(name, a) {
  try {
    // Additional safety checks before execution
    if (a.path && !isSafePath(a.path)) {
      return { ok: false, out: "Safety check failed: Path blocked for security reasons" };
    }
    
    if (name === "run_command" && a.command && isDangerousCommand(a.command)) {
      return { ok: false, out: "Safety check failed: Command blocked for security reasons" };
    }
    
    switch (name) {
      case "run_command":
        // Additional command safety
        const dangerousCmds = ['rm ', 'mkfs', 'fdisk', 'dd', 'chmod', 'chown'];
        const cmdLower = a.command.toLowerCase();
        const isDangerous = dangerousCmds.some(cmd => cmdLower.includes(cmd));
        
        if (isDangerous && !BYPASS_MODE) {
          return { ok: false, out: "Potentially dangerous command. Use bypass mode with caution." };
        }
        
        const cmdStart = Date.now();
        const cmdOut = execSync(a.command, { encoding: "utf8", timeout: 60000, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }) || "(no output)";
        return { ok: true, out: cmdOut, meta: { duration: ((Date.now() - cmdStart) / 1000).toFixed(1) } };
      
      case "read_file": {
        const content = fs.readFileSync(a.path, "utf8");
        const stat = fs.statSync(a.path);
        return { ok: true, out: content, meta: { lines: content.split("\n").length, size: stat.size } };
      }
      
      case "write_file": {
        // Check if trying to write to system files
        const absPath = path.resolve(a.path);
        if (absPath.startsWith('/etc') || absPath.startsWith('/bin') || absPath.startsWith('/sbin')) {
          return { ok: false, out: "Cannot write to system directories for safety" };
        }
        
        const dir = path.dirname(a.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(a.path, a.content);
        return { ok: true, out: `File written: ${a.path}`, meta: { bytes: Buffer.byteLength(a.content) } };
      }
      
      case "edit_file": {
        const absPath = path.resolve(a.path);
        if (absPath.startsWith('/etc') || absPath.startsWith('/bin') || absPath.startsWith('/sbin')) {
          return { ok: false, out: "Cannot edit system files for safety" };
        }
        
        const orig = fs.readFileSync(a.path, "utf8");
        if (!orig.includes(a.old_text)) return { ok: false, out: "old_text not found in file" };
        const count = orig.split(a.old_text).length - 1;
        fs.writeFileSync(a.path, orig.replace(a.old_text, a.new_text));
        return { ok: true, out: `File edited: ${a.path}`, meta: { replacements: count } };
      }
      
      case "delete_file": {
        // Extra protection for home directory
        const absPathDel = path.resolve(a.path);
        if (absPathDel === HOME || absPathDel === path.dirname(HOME)) {
          return { ok: false, out: "Cannot delete home directory for safety" };
        }

        // Check if file exists before deleting
        if (!fs.existsSync(a.path)) {
          return { ok: false, out: "File not found" };
        }

        let delSize = 0;
        try { delSize = fs.statSync(a.path).size; } catch {}
        fs.rmSync(a.path, { recursive: true, force: true });
        return { ok: true, out: `Deleted: ${a.path}`, meta: { size: delSize } };
      }
      
      case "search_files": {
        const dir = a.dir || process.cwd();
        const out = execSync(`find ${dir} -name "${a.pattern}" -type f 2>/dev/null | head -30`, { encoding: "utf8" });
        return { ok: true, out: out || "No files found." };
      }
      
      case "search_content": {
        const dir = a.dir || process.cwd();
        const globArg = a.glob ? `--include="${a.glob}"` : "";
        const out = execSync(`grep -rn ${globArg} "${a.pattern}" ${dir} 2>/dev/null | head -30`, { encoding: "utf8" });
        return { ok: true, out: out || "No matches found." };
      }
      
      default:
        return { ok: false, out: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, out: err.message };
  }
}

function toolLabel(name, a) {
  switch (name) {
    case "run_command": return `${C.yellow("bash")} ${C.bold(a.command)}`;
    case "read_file": return `${C.blue("read")} ${a.path}`;
    case "write_file": return `${C.green("write")} ${a.path}`;
    case "edit_file": return `${C.magenta("edit")} ${a.path}`;
    case "delete_file": return `${C.red("delete")} ${a.path}`;
    case "search_files": return `${C.cyan("search")} ${a.pattern}`;
    case "search_content": return `${C.cyan("grep")} ${a.pattern}`;
    default: return name;
  }
}

// ═══════════════════════════════════════════════════════════
//  Box-Drawn Tool Panels & Turn Footer
// ═══════════════════════════════════════════════════════════
function drawToolBox(type, lines, showPermission) {
  const permTag = showPermission ? `── ⚡ ${C.yellow("Permission")} ──` : "";
  const header = `─ ${type} `;
  const pad = Math.max(0, 38 - header.length - (showPermission ? 16 : 0));
  console.log(`  ${C.dim("╭")}${C.dim(header + "─".repeat(pad))}${permTag}`);
  for (const l of lines) {
    console.log(`  ${C.dim("│")} ${l}`);
  }
  console.log(`  ${C.dim("╰" + "─".repeat(40))}`);
}

function toolIcon(name) {
  switch (name) {
    case "read_file": return "📄";
    case "write_file": return "📝";
    case "edit_file": return "✏️";
    case "delete_file": return "🗑️";
    case "run_command": return "$";
    case "search_files": return "🔍";
    case "search_content": return "🔍";
    default: return "⚙️";
  }
}

function toolTypeName(name) {
  switch (name) {
    case "read_file": return "read";
    case "write_file": return "write";
    case "edit_file": return "edit";
    case "delete_file": return "delete";
    case "run_command": return "bash";
    case "search_files": return "search";
    case "search_content": return "grep";
    default: return name;
  }
}

function spinnerTextForTool(name, args) {
  switch (name) {
    case "read_file": return `Reading ${path.basename(args.path || "")}...`;
    case "write_file": return `Writing ${path.basename(args.path || "")}...`;
    case "edit_file": return `Editing ${path.basename(args.path || "")}...`;
    case "delete_file": return `Deleting ${path.basename(args.path || "")}...`;
    case "run_command": return `Running ${(args.command || "").substring(0, 30)}...`;
    case "search_files": return `Searching ${args.pattern || ""}...`;
    case "search_content": return `Grepping ${args.pattern || ""}...`;
    default: return `Executing ${name}...`;
  }
}

function showTurnFooter() {
  if (!turnStats) return;
  const elapsed = ((Date.now() - turnStats.startTime) / 1000).toFixed(1);
  const inp = turnStats.turnTokens.input;
  const out = turnStats.turnTokens.output;
  const p = PRICING[config.model] || PRICING["deepseek-chat"];
  const cost = ((inp / 1e6) * p.input + (out / 1e6) * p.output).toFixed(6);

  let parts = [`${inp}↑ ${out}↓ tokens`, `$${cost}`, `${elapsed}s`];
  const u = turnStats.toolsUsed;
  if (u.read) parts.push(`${u.read} read`);
  if (u.write) parts.push(`${u.write} write`);
  if (u.edit) parts.push(`${u.edit} edit`);
  if (u.delete) parts.push(`${u.delete} delete`);
  if (u.command) parts.push(`${u.command} cmd`);
  if (u.search) parts.push(`${u.search} search`);

  const inner = parts.join(" · ");
  console.log(C.dim(`\n  ━━ 📊 ${inner} ━━`));
}

// ═══════════════════════════════════════════════════════════
//  ENHANCED PERMISSION SYSTEM WITH SAFETY CHECKS
// ═══════════════════════════════════════════════════════════

// Audit logging
function logAudit(action, tool, args, allowed) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    action,
    tool,
    args: typeof args === 'object' ? JSON.stringify(args) : args,
    allowed,
    cwd: process.cwd(),
    user: process.env.USER || 'unknown'
  };
  
  const logFile = path.join(DS_DIR, "audit.log");
  fs.appendFileSync(logFile, JSON.stringify(logEntry) + "\n");
}

// Check if path is safe (not system critical)
function isSafePath(filePath) {
  const unsafePaths = [
    '/', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/etc', '/root',
    '/system', '/data', '/dev', '/proc', '/sys',
    '/data/data/com.termux/files/usr', // Termux system
    '/data/data/com.termux/files/usr/bin',
    '/data/data/com.termux/files/usr/lib'
  ];
  
  const absPath = path.resolve(filePath);
  
  // Block system paths
  for (const unsafe of unsafePaths) {
    if (absPath.startsWith(unsafe)) {
      return false;
    }
  }
  
  // Block home directory deletion
  if (absPath === HOME || absPath.startsWith(HOME + '/.')) {
    // Allow .deepseek folder operations (for config/sessions)
    if (absPath.startsWith(path.join(HOME, '.deepseek'))) {
      return true;
    }
    return false;
  }
  
  // Allow storage access (internal storage)
  if (absPath.startsWith('/storage/') || absPath.startsWith(HOME + '/storage/')) {
    return true;
  }
  
  return true;
}

// Check if command is dangerous
function isDangerousCommand(cmd) {
  const dangerousPatterns = [
    'rm -rf', 'rm -fr', 'rm -r', 'rm -f',
    'dd if=', 'mkfs', 'fdisk',
    'chmod 777', 'chmod 000',
    '> /dev/', '>> /dev/',
    ':(){ :|:& };:', // fork bomb
    'sudo', 'su '
  ];
  
  const lowerCmd = cmd.toLowerCase();
  return dangerousPatterns.some(pattern => lowerCmd.includes(pattern));
}

// Enhanced permission asking
function askPermission(name, a) {
  return new Promise((resolve) => {
    // READONLY MODE: Block semua write/delete operations
    if (READONLY_MODE && (WRITE_TOOLS.includes(name) || DANGEROUS_TOOLS.includes(name))) {
      console.log(`\n  ${C.red(C.bold("READ-ONLY MODE BLOCKED"))}`);
      console.log(`  ${toolLabel(name, a)}`);
      console.log(`  ${C.red("Read-only mode aktif! Tidak bisa menulis/hapus.")}`);
      logAudit("blocked_readonly", name, a, false);
      return resolve(false);
    }
    
    // BYPASS MODE: Skip permission untuk tools safe
    if (BYPASS_MODE && SAFE_TOOLS.includes(name)) {
      logAudit("auto_allowed_bypass", name, a, true);
      return resolve(true);
    }
    
    // SAFE TOOLS: Auto allow
    if (SAFE_TOOLS.includes(name)) {
      logAudit("auto_allowed_safe", name, a, true);
      return resolve(true);
    }
    
    // Additional safety checks
    let safetyWarning = "";
    
    // Check for dangerous paths
    if (a.path && !isSafePath(a.path)) {
      safetyWarning = `${C.red("WARNING: Path mungkin berbahaya!")}\n  `;
    }
    
    // Check for dangerous commands
    if (name === "run_command" && a.command && isDangerousCommand(a.command)) {
      safetyWarning = `${C.red("WARNING: Command mungkin berbahaya!")}\n  `;
    }
    
    // Show permission dialog
    console.log(`\n  ${C.yellow(C.bold("PERMISSION REQUIRED"))}`);
    if (safetyWarning) console.log(`  ${safetyWarning}`);
    console.log(`  ${toolLabel(name, a)}`);
    
    rl.question(`  ${C.yellow("Allow this action? (y/n/details):")} `, (ans) => {
      ans = ans.trim().toLowerCase();
      
      if (ans === 'details' || ans === 'd') {
        console.log(`\n  ${C.cyan("Action Details:")}`);
        console.log(`  Tool: ${name}`);
        console.log(`  Arguments: ${JSON.stringify(a, null, 2)}`);
        console.log(`  Current dir: ${process.cwd()}`);
        rl.question(`  ${C.yellow("Allow? (y/n):")} `, (ans2) => {
          const allowed = ans2.trim().toLowerCase() === 'y';
          logAudit("user_decision", name, a, allowed);
          resolve(allowed);
        });
      } else {
        const allowed = ans === 'y' || ans === 'yes';
        logAudit("user_decision", name, a, allowed);
        resolve(allowed);
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════
//  Session Management
// ═══════════════════════════════════════════════════════════
function saveSession(name) {
  const fp = path.join(SESSIONS_DIR, `${name}.json`);
  fs.writeFileSync(fp, JSON.stringify({ model: config.model, messages, date: new Date().toISOString() }, null, 2));
  return fp;
}

function loadSession(name) {
  const fp = path.join(SESSIONS_DIR, `${name}.json`);
  if (!fs.existsSync(fp)) return null;
  const data = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (data.model) config.model = data.model;
  return data.messages;
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")).map((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
    return { name: f.replace(".json", ""), date: data.date, msgs: (data.messages || []).length };
  });
}

// ═══════════════════════════════════════════════════════════
//  Input History
// ═══════════════════════════════════════════════════════════
let inputHistory = [];
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH))
      inputHistory = fs.readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean);
  } catch {}
}
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_PATH, inputHistory.slice(-200).join("\n"));
  } catch {}
}
function addHistory(line) {
  if (line && inputHistory[inputHistory.length - 1] !== line) {
    inputHistory.push(line);
    saveHistory();
  }
}
loadHistory();

// ═══════════════════════════════════════════════════════════
//  Messages & System Prompt
// ═══════════════════════════════════════════════════════════
const projectCtx = config.autoContext ? detectProject() : `Working directory: ${process.cwd()}`;

const SYSTEM_PROMPT = `You are DeepSeek CLI, an interactive AI coding assistant running in the user's terminal.
You have access to tools to interact with the filesystem and run commands.
Always respond in English or Indonesian, matching the language the user uses.
When the user asks you to create, edit, delete files or run commands, USE the provided tools.
When just chatting or answering questions, respond normally without tools.

Environment:
${projectCtx}
Platform: ${process.platform} ${os.arch()}`;

let messages = [{ role: "system", content: SYSTEM_PROMPT }];

// Resume session if requested
if (argResume) {
  const loaded = loadSession(argResume);
  if (loaded) {
    messages = loaded;
    console.log(C.dim(`  Resumed session: ${argResume}`));
  } else {
    console.error(C.red(`  Session not found: ${argResume}`));
  }
}

// ═══════════════════════════════════════════════════════════
//  API Streaming
// ═══════════════════════════════════════════════════════════
function streamChat() {
  return new Promise((resolve, reject) => {
    const useTools = config.model !== "deepseek-reasoner";
    const body = {
      model: config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (useTools) body.tools = TOOLS;
    if (config.temperature !== undefined) body.temperature = config.temperature;

    const data = JSON.stringify(body);
    const options = {
      hostname: "api.deepseek.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    };

    let contentText = "";
    let reasoningText = "";
    let toolCalls = {};
    let buffer = "";
    let firstToken = true;
    let usage = null;

    startSpinner(config.model === "deepseek-reasoner" ? "Reasoning" : "Thinking");

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        stopSpinner();
        let err = "";
        res.on("data", (c) => (err += c));
        res.on("end", () => reject(new Error(`API ${res.statusCode}: ${err}`)));
        return;
      }

      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const t = line.trim();
          if (!t || !t.startsWith("data: ")) continue;
          const json = t.slice(6);
          if (json === "[DONE]") continue;

          try {
            const parsed = JSON.parse(json);

            // Track usage from final chunk
            if (parsed.usage) usage = parsed.usage;

            const choice = parsed.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta;

            // Reasoning content (deepseek-reasoner)
            if (delta?.reasoning_content) {
              if (firstToken) {
                stopSpinner();
                process.stdout.write(`\n${C.dim(C.cyan("  Thinking..."))}\n${C.dim("  ")}`);
                firstToken = false;
              }
              process.stdout.write(C.dim(delta.reasoning_content));
              reasoningText += delta.reasoning_content;
            }

            // Regular content
            if (delta?.content) {
              if (firstToken) {
                stopSpinner();
                process.stdout.write(`\n${C.cyan(C.bold("DeepSeek"))} `);
                firstToken = false;
              } else if (reasoningText && !contentText) {
                // Transition from thinking to content
                process.stdout.write(`\n\n${C.cyan(C.bold("DeepSeek"))} `);
              }
              process.stdout.write(delta.content);
              contentText += delta.content;
            }

            // Tool calls
            if (delta?.tool_calls) {
              if (firstToken) { stopSpinner(); firstToken = false; }
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCalls[idx]) toolCalls[idx] = { id: "", name: "", arguments: "" };
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].name = tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
              }
            }
          } catch {}
        }
      });

      res.on("end", () => {
        stopSpinner();
        if (contentText || reasoningText) process.stdout.write("\n");
        trackUsage(usage);
        resolve({ content: contentText, reasoning: reasoningText, toolCalls: Object.values(toolCalls) });
      });
    });

    req.on("error", (err) => { stopSpinner(); reject(err); });
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
//  Tool Call Processing
// ═══════════════════════════════════════════════════════════
async function processToolCalls(toolCallList) {
  const assistantMsg = {
    role: "assistant",
    content: null,
    tool_calls: toolCallList.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    })),
  };
  messages.push(assistantMsg);

  for (const tc of toolCallList) {
    let a;
    try { a = JSON.parse(tc.arguments); } catch { a = {}; }

    const type = toolTypeName(tc.name);
    const icon = toolIcon(tc.name);
    const safe = SAFE_TOOLS.includes(tc.name);
    const needsPerm = !safe;

    // Context-aware spinner (brief flash before execution)
    startSpinner(spinnerTextForTool(tc.name, a));

    if (needsPerm) {
      stopSpinner();
      // Build permission panel
      const permLines = [];
      if (tc.name === "run_command") {
        permLines.push(`${icon} ${C.bold(a.command || "")}`);
      } else {
        permLines.push(`${icon} ${C.bold(a.path || "")}`);
      }

      const permTag = `── ⚡ ${C.yellow("Permission")} ──`;
      const header = `─ ${type} `;
      const pad = Math.max(0, 22 - header.length);
      console.log(`\n  ${C.dim("╭")}${C.dim(header + "─".repeat(pad))}${permTag}`);
      for (const l of permLines) console.log(`  ${C.dim("│")} ${l}`);

      const allowed = await askPermission(tc.name, a);
      if (!allowed) {
        console.log(`  ${C.dim("│")} ${C.red("✗ Denied")}`);
        console.log(`  ${C.dim("╰" + "─".repeat(40))}`);
        logAction(tc.name, a, { ok: false, out: "Denied" }, 0);
        messages.push({ role: "tool", tool_call_id: tc.id, content: "Permission denied by user." });
        continue;
      }
    }

    // Execute tool
    stopSpinner();
    const toolStart = Date.now();
    const result = executeTool(tc.name, a);
    const dur = Date.now() - toolStart;
    logAction(tc.name, a, result, dur);

    // Build info lines for box
    const boxLines = [];
    const meta = result.meta || {};

    if (tc.name === "read_file") {
      boxLines.push(`${icon} ${C.bold(a.path)} ${C.dim(`(${meta.lines} lines, ${formatFileSize(meta.size)})`)}`);
    } else if (tc.name === "write_file") {
      boxLines.push(`${icon} ${C.bold(a.path)}`);
      if (result.ok) boxLines.push(`${C.green("✓")} Written ${C.dim(`(${formatFileSize(meta.bytes)})`)}`);
      else boxLines.push(`${C.red("✗")} ${result.out}`);
    } else if (tc.name === "edit_file") {
      boxLines.push(`${icon} ${C.bold(a.path)}`);
      if (result.ok) boxLines.push(`${C.green("✓")} ${meta.replacements} replacement(s)`);
      else boxLines.push(`${C.red("✗")} ${result.out}`);
    } else if (tc.name === "delete_file") {
      boxLines.push(`${icon} ${C.bold(a.path)}`);
      if (result.ok) boxLines.push(`${C.green("✓")} Deleted ${C.dim(`(${formatFileSize(meta.size)})`)}`);
      else boxLines.push(`${C.red("✗")} ${result.out}`);
    } else if (tc.name === "run_command") {
      boxLines.push(`${icon} ${C.bold(a.command)}`);
      if (result.ok) {
        const preview = result.out.length > 200 ? result.out.substring(0, 200) + "..." : result.out;
        boxLines.push(`${C.green("✓")} ${C.dim(preview.replace(/\n/g, "\n  " + C.dim("│") + " "))}`);
      } else {
        boxLines.push(`${C.red("✗")} ${C.dim(result.out.substring(0, 200))}`);
      }
      boxLines.push(`⏱ ${meta.duration || ((dur / 1000).toFixed(1))}s`);
    } else {
      // search tools
      boxLines.push(`${icon} ${C.bold(a.pattern || "")}`);
      const preview = result.out.length > 200 ? result.out.substring(0, 200) + "..." : result.out;
      const status = result.ok ? C.green("✓") : C.red("✗");
      boxLines.push(`${status} ${C.dim(preview.replace(/\n/g, "\n  " + C.dim("│") + " "))}`);
    }

    if (needsPerm) {
      // Already have open box from permission, add result lines and close
      for (const l of boxLines) console.log(`  ${C.dim("│")} ${l}`);
      console.log(`  ${C.dim("╰" + "─".repeat(40))}`);
    } else {
      // Draw full box for safe tools
      console.log();
      drawToolBox(type, boxLines, false);
    }

    messages.push({ role: "tool", tool_call_id: tc.id, content: result.out });
  }
}

// ═══════════════════════════════════════════════════════════
//  Chat Loop
// ═══════════════════════════════════════════════════════════
async function chat() {
  try {
    const response = await streamChat();
    if (response.toolCalls.length > 0) {
      await processToolCalls(response.toolCalls);
      await chat(); // Let model respond after tool results
    } else if (response.content) {
      messages.push({ role: "assistant", content: response.content });
      showTurnFooter();
    }
  } catch (err) {
    console.error(`\n${C.red("Error:")} ${err.message}\n`);
  }
}

// ═══════════════════════════════════════════════════════════
//  Slash Commands
// ═══════════════════════════════════════════════════════════
function handleCommand(input) {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg1 = parts[1];
  const arg2 = parts.slice(2).join(" ");

  switch (cmd) {
    case "/help":
      console.log(renderMarkdown(`
# DeepSeek CLI Commands

- **/help** — Show this help
- **/model [name]** — Switch model (deepseek-chat, deepseek-reasoner)
- **/clear** — Clear conversation
- **/save [name]** — Save session
- **/load [name]** — Load session
- **/sessions** — List saved sessions
- **/tokens** — Show token usage & cost
- **/log [n]** — Show session action log (default: 10)
- **/config [key] [value]** — View/set config
- **/compact** — Summarize conversation to save context
- **/context** — Show detected project context

> Tip: Use \`"""\` to start/end multi-line input
> Arrow up/down for input history
`));
      return true;

    case "/model":
      if (!arg1) {
        console.log(`  Current model: ${C.bold(config.model)}`);
        console.log(C.dim("  Available: deepseek-chat, deepseek-reasoner"));
      } else {
        config.model = arg1;
        saveConfig(config);
        console.log(`  Model switched to: ${C.bold(arg1)}`);
        if (arg1 === "deepseek-reasoner") console.log(C.dim("  Thinking mode enabled. Tools disabled for this model."));
      }
      return true;

    case "/clear":
      messages.length = 0;
      messages.push({ role: "system", content: SYSTEM_PROMPT });
      sessionTokens = { input: 0, output: 0, reasoning: 0 };
      turnCounter = 0;
      sessionLog = [];
      console.log(C.dim("  Conversation cleared."));
      return true;

    case "/save":
      if (!arg1) { console.log(C.red("  Usage: /save <name>")); return true; }
      saveSession(arg1);
      console.log(C.green(`  Session saved: ${arg1}`));
      return true;

    case "/load":
      if (!arg1) { console.log(C.red("  Usage: /load <name>")); return true; }
      const loaded = loadSession(arg1);
      if (loaded) { messages.length = 0; messages.push(...loaded); console.log(C.green(`  Session loaded: ${arg1} (${loaded.length} messages)`)); }
      else console.log(C.red(`  Session not found: ${arg1}`));
      return true;

    case "/sessions": {
      const sessions = listSessions();
      if (!sessions.length) { console.log(C.dim("  No saved sessions.")); return true; }
      console.log(C.bold("\n  Saved Sessions:"));
      for (const s of sessions) console.log(`  ${C.cyan(s.name)} ${C.dim(`— ${s.msgs} msgs — ${s.date}`)}`);
      console.log();
      return true;
    }

    case "/tokens": {
      const stats = tokenStats();
      console.log(`\n  ${C.bold("Token Usage:")}`);
      console.log(`  Input:  ${C.cyan(String(stats.input))}`);
      console.log(`  Output: ${C.cyan(String(stats.output))}`);
      console.log(`  Total:  ${C.bold(String(stats.total))}`);
      console.log(`  Cost:   ${C.yellow(stats.cost)}`);
      console.log();
      return true;
    }

    case "/log": {
      const n = parseInt(arg1) || 10;
      if (sessionLog.length === 0) {
        console.log(C.dim("  No actions logged yet."));
        return true;
      }
      const entries = sessionLog.slice(-n);
      console.log(C.bold(`\n  Session Log (last ${entries.length} of ${sessionLog.length}):`));
      for (const e of entries) {
        const time = e.timestamp.split("T")[1].split(".")[0];
        const status = e.ok ? C.green("✓") : C.red("✗");
        const dur = e.duration ? C.dim(`${e.duration}ms`) : "";
        const toolName = C.cyan(e.tool);
        let argStr = "";
        if (e.args) {
          if (e.args.path) argStr = e.args.path;
          else if (e.args.command) argStr = e.args.command.substring(0, 40);
          else if (e.args.pattern) argStr = e.args.pattern;
        }
        console.log(`  ${C.dim(time)} ${status} ${toolName} ${C.bold(argStr)} ${dur}`);
        if (e.resultPreview) console.log(`    ${C.dim(e.resultPreview.substring(0, 80))}`);
      }
      console.log();
      return true;
    }

    case "/config":
      if (!arg1) {
        console.log(C.bold("\n  Config:"));
        for (const [k, v] of Object.entries(config)) console.log(`  ${C.cyan(k)}: ${v}`);
        console.log(C.dim(`\n  File: ${CONFIG_PATH}`));
        console.log();
      } else if (arg2) {
        let val = arg2;
        if (val === "true") val = true;
        else if (val === "false") val = false;
        else if (!isNaN(Number(val))) val = Number(val);
        config[arg1] = val;
        saveConfig(config);
        console.log(C.green(`  ${arg1} = ${val}`));
      } else {
        console.log(`  ${arg1} = ${config[arg1] !== undefined ? config[arg1] : C.dim("(not set)")}`);
      }
      return true;

    case "/compact":
      console.log(C.dim("  Compacting conversation..."));
      const userMsgs = messages.filter((m) => m.role === "user").length;
      if (userMsgs < 3) { console.log(C.dim("  Conversation too short to compact.")); return true; }
      messages.push({
        role: "user",
        content: "Please summarize our conversation so far in a concise paragraph. This summary will replace the conversation history to save context window space. Include key decisions, files modified, and current task status.",
      });
      // This will be handled asynchronously
      return "compact";

    case "/context":
      console.log(C.bold("\n  Project Context:"));
      console.log(`  ${projectCtx.split("\n").join("\n  ")}`);
      console.log();
      return true;

    case "/safety":
      console.log(renderMarkdown(`
# Safety Information

## Current Mode: ${READONLY_MODE ? "READ-ONLY" : BYPASS_MODE ? "BYPASS" : "SAFE"}

## Safety Features:
✅ **Permission System** - Always asks before dangerous operations
✅ **Path Protection** - Blocks system-critical paths
✅ **Command Filtering** - Blocks dangerous commands
✅ **Audit Logging** - All actions are logged
✅ **Read-Only Mode** - Completely safe for browsing

## Protection Levels:
1. **Safe Mode (ds)** - Always asks permission
2. **Read-Only Mode (ds-ro)** - Can only read files
3. **Sandbox Mode (ds-sandbox)** - Isolated folder
4. **Bypass Mode (dsc)** - No permission prompts (use with caution!)

## Blocked Operations:
- Deleting system files
- Writing to /etc, /bin, /sbin
- Dangerous commands (rm -rf, dd, etc.)
- Modifying home directory structure

## Audit Log: ~/.deepseek/audit.log
All actions are logged with timestamp and user decision.

> Tip: Always use 'ds' for daily use. Use 'ds-ro' if you only need to read files.
`));
      return true;

    default:
      console.log(C.red(`  Unknown command: ${cmd}`));
      console.log(C.dim("  Type /help for available commands."));
      return true;
  }
}

// ═══════════════════════════════════════════════════════════
//  Readline & Input
// ═══════════════════════════════════════════════════════════
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  historySize: 200,
});

// Load history into readline
if (inputHistory.length > 0) rl.history = inputHistory.slice().reverse();

let multiLineMode = false;
let multiLineBuffer = [];

function prompt() {
  const promptStr = multiLineMode
    ? `${C.dim("...")} `
    : `${C.dim(`[${turnCounter + 1}]`)} ${C.green(C.bold(">"))} `;

  rl.question(promptStr, async (input) => {
    // Multi-line mode toggle
    if (input.trim() === '"""') {
      if (!multiLineMode) {
        multiLineMode = true;
        multiLineBuffer = [];
        return prompt();
      } else {
        multiLineMode = false;
        input = multiLineBuffer.join("\n");
        multiLineBuffer = [];
      }
    }

    if (multiLineMode) {
      multiLineBuffer.push(input);
      return prompt();
    }

    const trimmed = input.trim();
    if (!trimmed) return prompt();

    // Add to history
    addHistory(trimmed);

    // Exit
    if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
      console.log(`\n${C.dim("Bye!")}\n`);
      process.exit(0);
    }

    // Clear shortcut
    if (trimmed.toLowerCase() === "clear") {
      handleCommand("/clear");
      return prompt();
    }

    // Slash commands
    if (trimmed.startsWith("/")) {
      const result = handleCommand(trimmed);
      if (result === "compact") {
        await chat();
        // Replace history with summary
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === "assistant") {
          const summary = lastMsg.content;
          messages.length = 0;
          messages.push({ role: "system", content: SYSTEM_PROMPT });
          messages.push({ role: "assistant", content: `[Conversation Summary]\n${summary}` });
          console.log(C.green("\n  Conversation compacted.\n"));
        }
        return prompt();
      }
      if (result) return prompt();
    }

    // Regular message
    turnCounter++;
    resetTurnStats();
    messages.push({ role: "user", content: trimmed });
    await chat();
    console.log();
    prompt();
  });
}

rl.on("close", () => {
  saveHistory();
  console.log(`\n${C.dim("Bye!")}\n`);
  process.exit(0);
});

// ═══════════════════════════════════════════════════════════
//  Startup Banner with Safety Info
// ═══════════════════════════════════════════════════════════
let modeTag, safetyInfo;

if (READONLY_MODE) {
  modeTag = C.blue(C.bold("READ-ONLY"));
  safetyInfo = C.dim("  Only read operations allowed");
} else if (BYPASS_MODE) {
  modeTag = C.red(C.bold("BYPASS"));
  safetyInfo = C.red("  ⚠️  Permission prompts DISABLED - Use with caution!");
} else {
  modeTag = C.green(C.bold("SAFE"));
  safetyInfo = C.dim("  Permission prompts ENABLED");
}

const modelTag = C.cyan(config.model);

console.log(`
${C.bold(C.cyan("  DeepSeek CLI"))}  ${modeTag}  ${modelTag}
${safetyInfo}
${C.dim("  /help for commands — exit to quit — \"\"\" for multi-line")}
${C.dim("  Type /safety for safety information")}
`);

prompt();
