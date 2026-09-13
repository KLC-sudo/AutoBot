/* ═══════════════════════════════════════════════════════════════════════
   agent.js — Hermes Agent Brain (OpenRouter + Tool Execution)
   
   A full coding agent that:
   - Receives user commands and conversation history
   - Thinks via OpenRouter API (any model)
   - Executes tools (file ops, shell, git)
   - Tracks token usage per request
   - Streams status back to the WebSocket client
   ═══════════════════════════════════════════════════════════════════════ */

const fsp = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');
const { getContextLength, estimateTokens } = require('./sessions');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_API = 'https://openrouter.ai/api/v1/models';

// ─── Fetch actual context length from OpenRouter ───────────────────
async function fetchContextLength(model, apiKey) {
  try {
    const res = await fetch(OPENROUTER_MODELS_API, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.log(`[Agent] OpenRouter models API returned ${res.status}`);
      return getContextLength(model);
    }
    const data = await res.json();

    // Try exact match first
    let modelData = data.data?.find(m => m.id === model);

    // Try case-insensitive match
    if (!modelData) {
      const lower = model.toLowerCase();
      modelData = data.data?.find(m => m.id.toLowerCase() === lower);
    }

    // Try partial match (e.g. "mimo-v2.5" matches "xiaomi/mimo-v2.5")
    if (!modelData) {
      const searchParts = model.toLowerCase().split('/').pop().split('-');
      modelData = data.data?.find(m => {
        const id = m.id.toLowerCase();
        return searchParts.every(part => id.includes(part));
      });
    }

    if (modelData?.context_length) {
      console.log(`[Agent] Fetched context length for ${model}: ${modelData.context_length}`);
      return modelData.context_length;
    }

    console.log(`[Agent] Model ${model} not found in OpenRouter, using fallback`);
    return getContextLength(model);
  } catch (err) {
    console.log(`[Agent] Failed to fetch models: ${err.message}`);
    return getContextLength(model);
  }
}

const SYSTEM_PROMPT = `You are Hermes, an expert full-stack coding agent. Your name is Hermes. You are NOT Claude, GPT, or any other AI assistant. You are Hermes — a specialized coding agent built to write, edit, and debug code autonomously.

IMPORTANT: Always refer to yourself as "Hermes" or "I". Never say "As Claude..." or "As an AI..." or "As GPT...". You are Hermes.

## Available Tools
You have full access to the workspace filesystem and shell. Your tools:
- **read_file** — Read any file's contents
- **write_file** — Create or overwrite files
- **edit_file** — Find and replace text in files
- **list_files** — List directory contents
- **run_command** — Execute any shell command (git, npm, node, python, curl, etc.)
- **clone_repo** — Clone a GitHub repo (private repos supported via stored token)
- **git_push** — Stage, commit, and push changes to GitHub
- **install_deps** — Install npm/yarn/pip dependencies

## GitHub Access
You have a GitHub token configured. You can:
- Clone any repo (public or private): clone_repo("https://github.com/user/repo")
- Push changes: git_push({ message: "your commit message" })
- Run any git command: run_command("git status")

## Rules
- Always use tools to read files before editing them.
- When editing, show the full updated file content.
- Run tests after making changes when possible.
- Be concise in your text responses — explain what you did, not what you're about to do.
- If a task requires multiple steps, execute them one by one.
- When you're done, give a brief summary of what you did.
- If git clone fails, check if git is installed and try alternative approaches.

## Working Directory
You are working in: {WORKDIR}
All file paths are relative to this directory unless absolute.`;

// ─── Tool Definitions (OpenRouter function-calling format) ─────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute file path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates or overwrites)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write to' },
          content: { type: 'string', description: 'The full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories at a path',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: current dir)' },
          recursive: { type: 'boolean', description: 'List recursively (default: false)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command and return its output',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional, defaults to project root)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a specific section of a file by finding and replacing text',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          find: { type: 'string', description: 'Exact text to find (will be replaced)' },
          replace: { type: 'string', description: 'Text to replace it with' },
        },
        required: ['path', 'find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clone_repo',
      description: 'Clone a GitHub repository into the workspace',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'GitHub repo URL (https://github.com/user/repo)' },
          target_dir: { type: 'string', description: 'Directory name to clone into (optional)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description: 'Stage, commit, and push all changes to GitHub',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo directory path (optional, defaults to workspace root)' },
          message: { type: 'string', description: 'Commit message' },
          branch: { type: 'string', description: 'Branch to push to (default: main)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install_deps',
      description: 'Install npm/yarn/pip dependencies in a directory',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory with package.json or requirements.txt' },
          manager: { type: 'string', description: 'Package manager: npm, yarn, pip (default: npm)' },
        },
        required: [],
      },
    },
  },
];

// ─── Tool Execution ───────────────────────────────────────────────
async function executeTool(name, args, workdir) {
  const fullPath = path.isAbsolute(args.path || '')
    ? (args.path || '')
    : path.join(workdir, args.path || '');

  switch (name) {
    case 'read_file': {
      try {
        const content = await fsp.readFile(fullPath, 'utf8');
        return { success: true, content };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    case 'write_file': {
      try {
        await fsp.mkdir(path.dirname(fullPath), { recursive: true });
        await fsp.writeFile(fullPath, args.content, 'utf8');
        return { success: true, message: `Wrote ${args.content.length} bytes to ${args.path}` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    case 'list_files': {
      try {
        const target = args.path
          ? (path.isAbsolute(args.path) ? args.path : path.join(workdir, args.path))
          : workdir;

        if (args.recursive) {
          const results = [];
          async function walk(dir, prefix = '') {
            const entries = await fsp.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name === 'node_modules' || entry.name === '.git') continue;
              const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
              if (entry.isDirectory()) {
                results.push(`${rel}/`);
                await walk(path.join(dir, entry.name), rel);
              } else {
                results.push(rel);
              }
            }
          }
          await walk(target);
          return { success: true, content: results.join('\n') };
        } else {
          const entries = await fsp.readdir(target, { withFileTypes: true });
          const listing = entries
            .filter(e => e.name !== 'node_modules' && e.name !== '.git')
            .map(e => e.isDirectory() ? `${e.name}/` : e.name)
            .join('\n');
          return { success: true, content: listing };
        }
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    case 'run_command': {
      try {
        const cmdCwd = args.cwd
          ? (path.isAbsolute(args.cwd) ? args.cwd : path.join(workdir, args.cwd))
          : workdir;

        // Try multiple shells for Railway compatibility
        const shells = ['/bin/bash', '/bin/sh', 'bash', 'sh'];
        let lastError = null;

        for (const shell of shells) {
          try {
            const output = execSync(args.command, {
              cwd: cmdCwd,
              encoding: 'utf8',
              timeout: 60000,
              maxBuffer: 1024 * 1024,
              shell,
            });
            return { success: true, content: output.trim() || '(no output)' };
          } catch (e) {
            lastError = e;
            continue;
          }
        }

        // All shells failed - try without shell
        try {
          const output = execSync(args.command, {
            cwd: cmdCwd,
            encoding: 'utf8',
            timeout: 60000,
            maxBuffer: 1024 * 1024,
          });
          return { success: true, content: output.trim() || '(no output)' };
        } catch (e) {
          return {
            success: false,
            content: e.stdout || '',
            error: e.stderr || e.message,
          };
        }
      } catch (err) {
        return {
          success: false,
          content: err.stdout || '',
          error: err.stderr || err.message,
        };
      }
    }

    case 'edit_file': {
      try {
        let content = await fsp.readFile(fullPath, 'utf8');
        if (!content.includes(args.find)) {
          return { success: false, error: 'Text not found in file' };
        }
        content = content.replace(args.find, args.replace);
        await fsp.writeFile(fullPath, content, 'utf8');
        return { success: true, message: `Edited ${args.path}` };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    case 'clone_repo': {
      try {
        const targetDir = args.target_dir || path.basename(args.url.replace(/\.git$/, ''), '.git');
        const clonePath = path.join(workdir, targetDir);

        // Inject GitHub token for private repos
        let cloneUrl = args.url;
        const githubToken = process.env.GITHUB_TOKEN;
        if (githubToken && cloneUrl.includes('github.com')) {
          cloneUrl = cloneUrl.replace('https://github.com/', `https://${githubToken}@github.com/`);
        }

        execSync(`git clone ${cloneUrl} "${clonePath}"`, {
          encoding: 'utf8',
          timeout: 120000,
          shell: '/bin/bash',
        });
        return { success: true, content: `Cloned to ${targetDir}/` };
      } catch (err) {
        try {
          const targetDir = args.target_dir || path.basename(args.url.replace(/\.git$/, ''), '.git');
          const clonePath = path.join(workdir, targetDir);
          let cloneUrl = args.url;
          const githubToken = process.env.GITHUB_TOKEN;
          if (githubToken && cloneUrl.includes('github.com')) {
            cloneUrl = cloneUrl.replace('https://github.com/', `https://${githubToken}@github.com/`);
          }
          execSync(`git clone ${cloneUrl} "${clonePath}"`, {
            encoding: 'utf8',
            timeout: 120000,
            shell: '/bin/sh',
          });
          return { success: true, content: `Cloned to ${targetDir}/` };
        } catch (e) {
          return { success: false, error: `git clone failed: ${e.message}` };
        }
      }
    }

    case 'git_push': {
      try {
        const repoPath = args.path ? path.join(workdir, args.path) : workdir;
        const branch = args.branch || 'main';
        const message = args.message || 'Update via Hermes Agent';

        // Configure git
        const githubToken = process.env.GITHUB_TOKEN;
        const githubUser = process.env.GITHUB_USER || 'Hermes Agent';

        execSync(`git config user.name "${githubUser}"`, { cwd: repoPath, encoding: 'utf8', shell: '/bin/bash' });
        execSync(`git config user.email "hermes@agent.local"`, { cwd: repoPath, encoding: 'utf8', shell: '/bin/bash' });

        // Stage all changes
        execSync(`git add -A`, { cwd: repoPath, encoding: 'utf8', shell: '/bin/bash' });

        // Check if there are changes to commit
        try {
          execSync(`git diff --cached --quiet`, { cwd: repoPath, encoding: 'utf8', shell: '/bin/bash' });
          return { success: true, content: 'No changes to commit' };
        } catch {
          // There are changes (exit code 1 means changes exist)
        }

        // Commit
        execSync(`git commit -m "${message}"`, { cwd: repoPath, encoding: 'utf8', shell: '/bin/bash' });

        // Inject token into remote URL for push
        if (githubToken) {
          try {
            const remoteUrl = execSync(`git remote get-url origin`, { cwd: repoPath, encoding: 'utf8', shell: '/bin/bash' }).trim();
            if (remoteUrl.includes('github.com') && !remoteUrl.includes('@')) {
              const authUrl = remoteUrl.replace('https://github.com/', `https://${githubToken}@github.com/`);
              execSync(`git remote set-url origin ${authUrl}`, { cwd: repoPath, encoding: 'utf8', shell: '/bin/bash' });
            }
          } catch { /* ignore */ }
        }

        // Push
        execSync(`git push origin ${branch}`, { cwd: repoPath, encoding: 'utf8', shell: '/bin/bash', timeout: 60000 });

        return { success: true, content: `Pushed to origin/${branch}` };
      } catch (err) {
        return { success: false, error: `git push failed: ${err.message}` };
      }
    }

    case 'install_deps': {
      try {
        const depPath = args.path ? path.join(workdir, args.path) : workdir;
        const mgr = args.manager || 'npm';
        const cmd = mgr === 'pip' ? 'pip install -r requirements.txt' : `${mgr} install`;
        const output = execSync(cmd, {
          cwd: depPath,
          encoding: 'utf8',
          timeout: 120000,
          maxBuffer: 2 * 1024 * 1024,
          shell: '/bin/bash',
        });
        return { success: true, content: output.trim() || 'Dependencies installed' };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    default:
      return { success: false, error: `Unknown tool: ${name}` };
  }
}

// ─── Agent Loop ───────────────────────────────────────────────────
// Accepts existing session messages, appends user message, runs agent loop,
// returns { messages, tokenUsage } for the session to persist.
async function runAgent(userMessage, session, callbacks, workdir) {
  const { onStatus, onCode, onText, onError, onTokenUpdate } = callbacks;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = session.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o';

  if (!apiKey) {
    onError('OPENROUTER_API_KEY is not set. Add it to Railway environment variables.');
    return null;
  }

  const systemMessage = SYSTEM_PROMPT.replace('{WORKDIR}', workdir);

  // Build messages array from session history
  const messages = [
    { role: 'system', content: systemMessage },
    ...session.messages,
    { role: 'user', content: userMessage },
  ];

  const contextLength = await fetchContextLength(model, apiKey);
  const MAX_ITERATIONS = 15;
  let iteration = 0;
  let totalUsage = { prompt: 0, completion: 0, total: 0 };

  // Accumulate new messages to return
  const newMessages = [{ role: 'user', content: userMessage }];

  onStatus(`Model: ${model} · Context: ${contextLength.toLocaleString()} tokens`);

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    try {
      onStatus(`Thinking... (step ${iteration}/${MAX_ITERATIONS})`);

      const response = await fetch(OPENROUTER_API, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://hermes-web-ui.up.railway.app',
          'X-Title': 'Hermes Agent',
        },
        body: JSON.stringify({
          model,
          messages,
          tools: TOOLS,
          tool_choice: 'auto',
          max_tokens: 4096,
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        onError(`API error (${response.status}): ${errBody}`);
        return null;
      }

      const data = await response.json();

      if (!data.choices || !data.choices[0]) {
        onError('No response from API');
        return null;
      }

      // Track token usage from this request
      if (data.usage) {
        totalUsage.prompt += data.usage.prompt_tokens || 0;
        totalUsage.completion += data.usage.completion_tokens || 0;
        totalUsage.total += data.usage.total_tokens || 0;

        const estMessages = messages.reduce((s, m) => s + estimateTokens(m.content || ''), 0);
        onTokenUpdate({
          prompt: totalUsage.prompt,
          completion: totalUsage.completion,
          total: totalUsage.total,
          contextLength,
          contextUsed: estMessages,
          contextPercent: Math.round((estMessages / contextLength) * 100),
          model,
        });
      }

      const choice = data.choices[0];
      const assistantMessage = choice.message;

      // Add to both working messages and session history
      messages.push(assistantMessage);
      newMessages.push(assistantMessage);

      // If there are no tool calls, the agent is done
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        onText(assistantMessage.content || '(No response)');
        return { messages: newMessages, tokenUsage: totalUsage };
      }

      // Process tool calls
      for (const toolCall of assistantMessage.tool_calls) {
        const fnName = toolCall.function.name;
        let fnArgs;
        try {
          fnArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          fnArgs = {};
        }

        onStatus(`Tool: ${fnName}(${JSON.stringify(fnArgs).substring(0, 100)}...)`);

        const result = await executeTool(fnName, fnArgs, workdir);

        // Send code updates for file writes
        if (fnName === 'write_file' && result.success) {
          onCode(fnArgs.path, fnArgs.content);
        }
        if (fnName === 'edit_file' && result.success) {
          try {
            const updated = await fsp.readFile(
              path.isAbsolute(fnArgs.path) ? fnArgs.path : path.join(workdir, fnArgs.path),
              'utf8'
            );
            onCode(fnArgs.path, updated);
          } catch { /* ignore */ }
        }

        // Add tool result to conversation
        const toolMessage = {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
        messages.push(toolMessage);
        newMessages.push(toolMessage);
      }
    } catch (err) {
      onError(`Agent error: ${err.message}`);
      return null;
    }
  }

  // Max iterations reached — summarize
  onStatus('Max steps reached. Summarizing...');
  messages.push({ role: 'user', content: 'You reached the max steps. Briefly summarize what you accomplished.' });

  try {
    const finalResponse = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://hermes-web-ui.up.railway.app',
        'X-Title': 'Hermes Agent',
      },
      body: JSON.stringify({ model, messages, max_tokens: 1024 }),
    });

    const finalData = await finalResponse.json();
    const summary = finalData.choices?.[0]?.message?.content || 'Task completed (max iterations reached).';
    newMessages.push({ role: 'assistant', content: summary });
    onText(summary);

    if (finalData.usage) {
      totalUsage.prompt += finalData.usage.prompt_tokens || 0;
      totalUsage.completion += finalData.usage.completion_tokens || 0;
      totalUsage.total += finalData.usage.total_tokens || 0;
    }
  } catch {
    onText('Task completed (max iterations reached).');
  }

  return { messages: newMessages, tokenUsage: totalUsage };
}

module.exports = { runAgent };
