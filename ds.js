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
  sessionTokens.input += usage.prompt_tokens || 0;
  sessionTokens.output += usage.completion_tokens || 0;
}

function tokenStats() {
  const p = PRICING[config.model] || PRICING["deepseek-chat"];
  const cost = (sessionTokens.input / 1e6) * p.input + (sessionTokens.output / 1e6) * p.output;
  return { ...sessionTokens, total: sessionTokens.input + sessionTokens.output, cost: `$${cost.toFixed(6)}` };
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

// ═══════════════════════════════════════════════════════════
//  Tool Execution
// ═══════════════════════════════════════════════════════════
function executeTool(name, a) {
  try {
    switch (name) {
      case "run_command":
        return { ok: true, out: execSync(a.command, { encoding: "utf8", timeout: 60000, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }) || "(no output)" };
      case "read_file":
        return { ok: true, out: fs.readFileSync(a.path, "utf8") };
      case "write_file": {
        const dir = path.dirname(a.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(a.path, a.content);
        return { ok: true, out: `File written: ${a.path}` };
      }
      case "edit_file": {
        const orig = fs.readFileSync(a.path, "utf8");
        if (!orig.includes(a.old_text)) return { ok: false, out: "old_text not found in file" };
        fs.writeFileSync(a.path, orig.replace(a.old_text, a.new_text));
        return { ok: true, out: `File edited: ${a.path}` };
      }
      case "delete_file":
        fs.rmSync(a.path, { recursive: true, force: true });
        return { ok: true, out: `Deleted: ${a.path}` };
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
//  Permission System
// ═══════════════════════════════════════════════════════════
function askPermission(name, a) {
  return new Promise((resolve) => {
    if (BYPASS_MODE || SAFE_TOOLS.includes(name)) return resolve(true);
    console.log(`\n  ${C.yellow(C.bold("Permission Required"))}`);
    console.log(`  ${toolLabel(name, a)}`);
    rl.question(`  ${C.yellow("Allow? (y/n):")} `, (ans) => {
      resolve(ans.trim().toLowerCase() === "y" || ans.trim().toLowerCase() === "yes");
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

    const safe = SAFE_TOOLS.includes(tc.name);
    if (!safe) {
      const allowed = await askPermission(tc.name, a);
      if (!allowed) {
        console.log(C.dim("  Denied."));
        messages.push({ role: "tool", tool_call_id: tc.id, content: "Permission denied by user." });
        continue;
      }
    }

    // Show action
    console.log(`\n  ${toolLabel(tc.name, a)}`);
    const result = executeTool(tc.name, a);
    const icon = result.ok ? C.green("✓") : C.red("✗");
    const preview = result.out.length > 300 ? result.out.substring(0, 300) + "..." : result.out;
    console.log(`  ${icon} ${C.dim(preview)}`);

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
    : `${C.green(C.bold(">"))} `;

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
//  Startup Banner
// ═══════════════════════════════════════════════════════════
const modeTag = BYPASS_MODE ? C.red(C.bold("BYPASS")) : C.green(C.bold("SAFE"));
const modelTag = C.cyan(config.model);

console.log(`
${C.bold(C.cyan("  DeepSeek CLI"))}  ${modeTag}  ${modelTag}
${C.dim("  /help for commands — exit to quit — \"\"\" for multi-line")}
`);

prompt();
