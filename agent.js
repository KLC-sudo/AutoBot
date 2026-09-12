/* ═══════════════════════════════════════════════════════════════════════
   agent.js — Hermes Agent Brain (OpenRouter + Tool Execution)
   
   A full coding agent that:
   - Receives user commands
   - Thinks via OpenRouter API (any model)
   - Executes tools (file ops, shell, git)
   - Streams status back to the WebSocket client
   ═══════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execSync, spawn } = require('child_process');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM_PROMPT = `You are Hermes, an expert full-stack coding agent. You write, edit, and debug code autonomously.

## Capabilities
You have access to tools that let you interact with the filesystem and execute commands.

## Rules
- Always use tools to read files before editing them.
- When editing, show the full updated file content.
- Run tests after making changes when possible.
- Be concise in your text responses — explain what you did, not what you're about to do.
- If a task requires multiple steps, execute them one by one.
- When you're done, give a brief summary of what you did.

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

        const output = execSync(args.command, {
          cwd: cmdCwd,
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          shell: true,
        });
        return { success: true, content: output.trim() || '(no output)' };
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

    default:
      return { success: false, error: `Unknown tool: ${name}` };
  }
}

// ─── Agent Loop ───────────────────────────────────────────────────
async function runAgent(userMessage, callbacks, workdir) {
  const { onStatus, onCode, onText, onError } = callbacks;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';

  if (!apiKey) {
    onError('OPENROUTER_API_KEY is not set. Add it to Railway environment variables.');
    return;
  }

  const systemMessage = SYSTEM_PROMPT.replace('{WORKDIR}', workdir);

  const messages = [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userMessage },
  ];

  const MAX_ITERATIONS = 15;
  let iteration = 0;

  onStatus(`Using model: ${model}`);

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    try {
      onStatus(`Thinking... (step ${iteration})`);

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
        return;
      }

      const data = await response.json();

      if (!data.choices || !data.choices[0]) {
        onError('No response from API');
        return;
      }

      const choice = data.choices[0];
      const assistantMessage = choice.message;

      // Add assistant message to conversation
      messages.push(assistantMessage);

      // If there are no tool calls, the agent is done
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        onText(assistantMessage.content || '(No response)');
        return;
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

        onStatus(`Executing: ${fnName}(${JSON.stringify(fnArgs).substring(0, 120)}...)`);

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
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    } catch (err) {
      onError(`Agent error: ${err.message}`);
      return;
    }
  }

  onStatus('Reached maximum iterations. Summarizing...');
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
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 1024,
      }),
    });

    const finalData = await finalResponse.json();
    const summary = finalData.choices?.[0]?.message?.content || 'Task completed (max iterations reached).';
    onText(summary);
  } catch {
    onText('Task completed (max iterations reached).');
  }
}

module.exports = { runAgent };
