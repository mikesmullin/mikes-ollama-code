#!/usr/bin/env node

const readline = require('readline');
const fetch = require('node-fetch');
const process = require('process');
const { spawn } = require('child_process');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');

// Environment variables
const OLLAMA_HOST = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama2';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;

// Ensure the host URL has the correct format
const baseUrl = OLLAMA_HOST.endsWith('/v1') ? OLLAMA_HOST : `${OLLAMA_HOST}/v1`;

class OllamaChat {
  constructor() {
    this.currentInput = '';
    this.cursorPos = 0;
    this.conversationHistory = []; // Add conversation memory
    this.backgroundProcesses = new Map(); // Store background processes by ID
    this.nextProcessId = 1; // Auto-incrementing process ID
    this.loadSystemInstructions(); // Load system instructions on startup
    this.setupReadline();
  }

  loadSystemInstructions() {
    try {
      const systemPath = path.join(__dirname, 'docs', 'system.md');
      if (fs.existsSync(systemPath)) {
        const systemContent = fs.readFileSync(systemPath, 'utf8');
        // Add system instructions as the first message in conversation history
        // This will be sent to the LLM but not displayed to the user
        this.conversationHistory.push({
          role: 'system',
          content: systemContent
        });
        console.log('[System instructions loaded from docs/system.md]');
      } else {
        console.log('[No system instructions found at docs/system.md]');
      }
    } catch (error) {
      console.log(`[Error loading system instructions: ${error.message}]`);
    }
  }

  setupReadline() {
    // Enable keypress events
    readline.emitKeypressEvents(process.stdin);

    // Set raw mode for key detection
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    // Handle keypress events
    process.stdin.on('keypress', this.handleKeypress.bind(this));
  }

  handleKeypress(str, key) {
    if (!key) return;

    // Handle Ctrl+C to exit
    if (key.ctrl && key.name === 'c') {
      process.stdout.write('\n');
      process.exit(0);
    }

    // Handle Ctrl+L to clear conversation history
    if (key.ctrl && key.name === 'l') {
      // Preserve system instructions while clearing conversation
      const systemMessages = this.conversationHistory.filter(msg => msg.role === 'system');
      this.conversationHistory = systemMessages;
      process.stdout.write('\n[Conversation history cleared]\n');
      this.showPrompt();
      return;
    }

    // Handle Alt+Enter for multiline - try multiple approaches
    // On Windows, Alt key shows up as meta: true instead of alt: true
    if ((key.alt || key.meta) && (key.name === 'return' || key.name === 'enter')) {
      this.insertAtCursor('\n');
      this.redrawLine();
      return;
    }

    // Alternative check for Alt+Enter using character codes
    if (str === '\r' && (key.alt || key.meta)) {
      console.log('alt+enter detected via char code');
      this.insertAtCursor('\n');
      this.redrawLine();
      return;
    }

    // Handle regular Enter to send message
    if ((key.name === 'return' || key.name === 'enter') && !key.alt && !key.ctrl && !key.meta) {
      if (this.currentInput.trim()) {
        process.stdout.write('\n');
        this.sendMessage(this.currentInput);
        this.currentInput = '';
        this.cursorPos = 0;
      } else {
        process.stdout.write('\n');
        this.showPrompt();
      }
      return;
    }

    // Handle backspace
    if (key.name === 'backspace') {
      if (this.cursorPos > 0) {
        this.currentInput = this.currentInput.slice(0, this.cursorPos - 1) +
          this.currentInput.slice(this.cursorPos);
        this.cursorPos--;
        this.redrawLine();
      }
      return;
    }

    // Handle delete
    if (key.name === 'delete') {
      if (this.cursorPos < this.currentInput.length) {
        this.currentInput = this.currentInput.slice(0, this.cursorPos) +
          this.currentInput.slice(this.cursorPos + 1);
        this.redrawLine();
      }
      return;
    }

    // Handle left arrow
    if (key.name === 'left') {
      if (this.cursorPos > 0) {
        this.cursorPos--;
        process.stdout.write('\x1b[D'); // Move cursor left
      }
      return;
    }

    // Handle right arrow
    if (key.name === 'right') {
      if (this.cursorPos < this.currentInput.length) {
        this.cursorPos++;
        process.stdout.write('\x1b[C'); // Move cursor right
      }
      return;
    }

    // Handle home key
    if (key.name === 'home') {
      const moveLeft = this.cursorPos;
      this.cursorPos = 0;
      if (moveLeft > 0) {
        process.stdout.write(`\x1b[${moveLeft}D`); // Move cursor left by moveLeft positions
      }
      return;
    }

    // Handle end key
    if (key.name === 'end') {
      const moveRight = this.currentInput.length - this.cursorPos;
      this.cursorPos = this.currentInput.length;
      if (moveRight > 0) {
        process.stdout.write(`\x1b[${moveRight}C`); // Move cursor right by moveRight positions
      }
      return;
    }

    // Handle regular printable characters
    if (str && str.length === 1 && !key.ctrl && !key.alt && !key.meta) {
      this.insertAtCursor(str);
      this.redrawLine();
    }
  }

  insertAtCursor(text) {
    this.currentInput = this.currentInput.slice(0, this.cursorPos) +
      text +
      this.currentInput.slice(this.cursorPos);
    this.cursorPos += text.length;
  }

  redrawLine() {
    // Clear current line and redraw
    process.stdout.write('\r\x1b[K'); // Clear line
    const prompt = this.currentInput.includes('\n') ? '... ' : '>>> ';

    // Display the input with proper newline handling
    const displayInput = this.currentInput.replace(/\n/g, '\n... ');
    process.stdout.write(prompt + displayInput);

    // Calculate cursor position after newlines
    const lines = this.currentInput.slice(0, this.cursorPos).split('\n');
    const currentLinePos = lines[lines.length - 1].length;
    const totalLines = this.currentInput.slice(0, this.cursorPos).split('\n').length;

    // Move cursor to correct position
    if (totalLines > 1) {
      // Move up to the correct line
      process.stdout.write(`\x1b[${totalLines - 1}A`);
    }

    // Move to correct column (accounting for prompt)
    const promptLen = totalLines === 1 ? 4 : 4; // '>>> ' or '... '
    process.stdout.write(`\r\x1b[${promptLen + currentLinePos}C`);
  }

  // XML parsing helper to extract function calls
  extractFunctionCalls(text) {
    const functionCallRegex = /<function_calls>([\s\S]*?)<\/function_calls>/g;
    const calls = [];
    let match;

    while ((match = functionCallRegex.exec(text)) !== null) {
      const xmlContent = match[1];
      try {
        const parser = new xml2js.Parser({ explicitArray: false });
        parser.parseString(`<root>${xmlContent}</root>`, (err, result) => {
          if (!err && result.root.invoke) {
            const invokes = Array.isArray(result.root.invoke) ? result.root.invoke : [result.root.invoke];
            for (const invoke of invokes) {
              if (invoke.$ && invoke.$.name && invoke.parameter) {
                const params = {};
                const parameters = Array.isArray(invoke.parameter) ? invoke.parameter : [invoke.parameter];
                for (const param of parameters) {
                  if (param.$ && param.$.name) {
                    params[param.$.name] = param._;
                  }
                }
                calls.push({
                  name: invoke.$.name,
                  parameters: params
                });
              }
            }
          }
        });
      } catch (e) {
        console.error('Error parsing XML:', e);
      }
    }

    return calls;
  }

  // Execute terminal command
  async runInTerminal(command, explanation, isBackground = false) {
    console.log(`\n[Executing: ${explanation}]`);
    console.log(`Command: ${command}\n`);

    return new Promise((resolve) => {
      // Determine shell based on OS
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/bash';
      const shellArgs = isWindows ? ['/c', command] : ['-l', '-c', command];

      const childProcess = spawn(shell, shellArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });

      let stdout = '';
      let stderr = '';

      // Collect output
      childProcess.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;
        if (!isBackground) {
          // process.stdout.write(output);
        }
      });

      childProcess.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        if (!isBackground) {
          // process.stderr.write(output);
        }
      });

      if (isBackground) {
        // Store background process
        const processId = this.nextProcessId++;
        this.backgroundProcesses.set(processId, {
          process: childProcess,
          stdout: '',
          stderr: '',
          command: command,
          explanation: explanation,
          startTime: new Date(),
          isRunning: true
        });

        // Continue collecting output for background process
        childProcess.stdout.on('data', (data) => {
          const process = this.backgroundProcesses.get(processId);
          if (process) {
            process.stdout += data.toString();
          }
        });

        childProcess.stderr.on('data', (data) => {
          const process = this.backgroundProcesses.get(processId);
          if (process) {
            process.stderr += data.toString();
          }
        });

        childProcess.on('close', (code) => {
          const process = this.backgroundProcesses.get(processId);
          if (process) {
            process.isRunning = false;
            process.exitCode = code;
            process.endTime = new Date();
          }
        });

        resolve(`Terminal started with ID: ${processId}`);
      } else {
        // Wait for immediate process to complete
        childProcess.on('close', (code) => {
          const combinedOutput = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
          const result = combinedOutput || `Process completed with exit code: ${code}`;
          resolve(result);
        });

        childProcess.on('error', (error) => {
          resolve(`Error executing command: ${error.message}`);
        });
      }
    });
  }

  // Get output from background process
  getTerminalOutput(processId) {
    const process = this.backgroundProcesses.get(parseInt(processId));
    if (!process) {
      return `No process found with ID: ${processId}`;
    }

    const output = process.stdout + (process.stderr ? `\nSTDERR:\n${process.stderr}` : '');
    const status = process.isRunning ? 'Running' : `Completed (exit code: ${process.exitCode})`;

    return `Process ${processId} [${status}]:\nCommand: ${process.command}\n\nOutput:\n${output || '(no output yet)'}`;
  }

  // Process function calls from LLM response
  async processFunctionCalls(responseText) {
    const functionCalls = this.extractFunctionCalls(responseText);
    let results = '';

    for (const call of functionCalls) {
      if (call.name === 'run_in_terminal') {
        const command = call.parameters.command;
        const explanation = call.parameters.explanation || 'Running command';
        const isBackground = call.parameters.isBackground === 'true';

        const result = await this.runInTerminal(command, explanation, isBackground);
        results += `\n<function_results>\n${result}\n</function_results>\n`;
      } else if (call.name === 'get_terminal_output') {
        const processId = call.parameters.id;
        const result = this.getTerminalOutput(processId);
        results += `\n<function_results>\n${result}\n</function_results>\n`;
      }
    }

    return results;
  }

  async sendMessage(message) {
    // Add user message to conversation history (only if it's not empty)
    if (message.trim()) {
      this.conversationHistory.push({
        role: 'user',
        content: message
      });
    }

    try {
      const headers = {
        'Content-Type': 'application/json'
      };

      if (OLLAMA_API_KEY) {
        headers['Authorization'] = `Bearer ${OLLAMA_API_KEY}`;
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: this.conversationHistory, // Send entire conversation history
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Handle streaming response
      const reader = response.body;
      let buffer = '';
      let assistantResponse = ''; // Collect the assistant's response

      reader.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim() === '') continue;
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              // Add assistant response to conversation history
              if (assistantResponse.trim()) {
                this.conversationHistory.push({
                  role: 'assistant',
                  content: assistantResponse.trim()
                });
              }
              process.stdout.write('\n');
              this.showPrompt();
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                assistantResponse += content; // Collect the response
                process.stdout.write(content);
              }

              // Check if this is the last chunk
              if (parsed.choices?.[0]?.finish_reason) {
                // Add assistant response to conversation history
                if (assistantResponse.trim()) {
                  this.conversationHistory.push({
                    role: 'assistant',
                    content: assistantResponse.trim()
                  });
                }

                // Process any function calls in the response
                this.processFunctionCalls(assistantResponse).then((functionResults) => {
                  if (functionResults) {
                    // Send function results back to the LLM for processing
                    process.stdout.write(functionResults);

                    // Add function results to conversation and get LLM's response
                    this.conversationHistory.push({
                      role: 'user',
                      content: functionResults
                    });

                    // Recursively call sendMessage to get LLM's response to the function results
                    setTimeout(() => {
                      this.sendMessage('');
                    }, 100);
                    return;
                  }

                  process.stdout.write('\n');
                  this.showPrompt();
                });
                return;
              }
            } catch (e) {
              // Ignore JSON parse errors for partial chunks
            }
          }
        }
      });

      reader.on('end', () => {
        // Add assistant response to conversation history if we have one
        // (only if it wasn't already added in the finish_reason handler)
        if (assistantResponse.trim() &&
          (!this.conversationHistory.length ||
            this.conversationHistory[this.conversationHistory.length - 1].content !== assistantResponse.trim())) {
          this.conversationHistory.push({
            role: 'assistant',
            content: assistantResponse.trim()
          });
        }

        // Only show prompt if no function calls were processed
        // (function call processing handles its own prompt display)
        if (!this.extractFunctionCalls(assistantResponse).length) {
          process.stdout.write('\n');
          this.showPrompt();
        }
      }); reader.on('error', (err) => {
        console.error('\nError reading response:', err.message);
        this.showPrompt();
      });

    } catch (error) {
      console.error('Error:', error.message);
      this.showPrompt();
    }
  }

  showPrompt() {
    process.stdout.write('>>> ');
  }

  start() {
    console.log(`Ollama Chat - Model: ${OLLAMA_MODEL}`);
    console.log(`Host: ${baseUrl}`);
    console.log('Commands:');
    console.log('  Enter: Send message');
    console.log('  Alt+Enter: New line');
    console.log('  Ctrl+L: Clear conversation history');
    console.log('  Ctrl+C: Exit\n');

    this.showPrompt();
  }
}

// Check if node-fetch is available, if not provide installation instructions
try {
  require.resolve('node-fetch');
} catch (e) {
  console.error('Error: node-fetch package is required but not installed.');
  console.error('Please install it by running: npm install node-fetch');
  process.exit(1);
}

// Start the chat application
const chat = new OllamaChat();
chat.start();
