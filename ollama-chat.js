#!/usr/bin/env node

const readline = require('readline');
const fetch = require('node-fetch');
const process = require('process');
const { spawn } = require('child_process');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const glob = require('glob');

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

    // Paste detection variables
    this.pasteBuffer = '';
    this.lastKeypressTime = 0;
    this.pasteTimeout = null;
    this.isPasting = false;
    this.pasteThreshold = 10; // Milliseconds between keypress events to consider it pasting

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
        console.log('[File system operations: list_dir, file_search, grep_search, read_file, create_file, replace_string_in_file]');
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

    const currentTime = Date.now();
    const timeSinceLastKeypress = currentTime - this.lastKeypressTime;

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

    // Detect potential paste operation (rapid sequence of characters)
    if (str && str.length === 1 && timeSinceLastKeypress < this.pasteThreshold && !key.ctrl && !key.alt && !key.meta) {
      this.handlePossiblePaste(str);
      this.lastKeypressTime = currentTime;
      return;
    }

    // If we were pasting and now got a different type of input, finalize the paste
    if (this.isPasting) {
      this.finalizePaste();
    }

    // Handle Alt+Enter for multiline - try multiple approaches
    // On Windows, Alt key shows up as meta: true instead of alt: true
    if ((key.alt || key.meta) && (key.name === 'return' || key.name === 'enter')) {
      this.insertAtCursor('\n');
      this.redrawLine();
      this.lastKeypressTime = currentTime;
      return;
    }

    // Alternative check for Alt+Enter using character codes
    if (str === '\r' && (key.alt || key.meta)) {
      console.log('alt+enter detected via char code');
      this.insertAtCursor('\n');
      this.redrawLine();
      this.lastKeypressTime = currentTime;
      return;
    }

    // Handle regular Enter to send message (only if not pasting)
    if ((key.name === 'return' || key.name === 'enter') && !key.alt && !key.ctrl && !key.meta && !this.isPasting) {
      if (this.currentInput.trim()) {
        process.stdout.write('\n');
        this.sendMessage(this.currentInput);
        this.currentInput = '';
        this.cursorPos = 0;
      } else {
        process.stdout.write('\n');
        this.showPrompt();
      }
      this.lastKeypressTime = currentTime;
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
      this.lastKeypressTime = currentTime;
      return;
    }

    // Handle delete
    if (key.name === 'delete') {
      if (this.cursorPos < this.currentInput.length) {
        this.currentInput = this.currentInput.slice(0, this.cursorPos) +
          this.currentInput.slice(this.cursorPos + 1);
        this.redrawLine();
      }
      this.lastKeypressTime = currentTime;
      return;
    }

    // Handle left arrow
    if (key.name === 'left') {
      if (this.cursorPos > 0) {
        this.cursorPos--;
        process.stdout.write('\x1b[D'); // Move cursor left
      }
      this.lastKeypressTime = currentTime;
      return;
    }

    // Handle right arrow
    if (key.name === 'right') {
      if (this.cursorPos < this.currentInput.length) {
        this.cursorPos++;
        process.stdout.write('\x1b[C'); // Move cursor right
      }
      this.lastKeypressTime = currentTime;
      return;
    }

    // Handle home key
    if (key.name === 'home') {
      const moveLeft = this.cursorPos;
      this.cursorPos = 0;
      if (moveLeft > 0) {
        process.stdout.write(`\x1b[${moveLeft}D`); // Move cursor left by moveLeft positions
      }
      this.lastKeypressTime = currentTime;
      return;
    }

    // Handle end key
    if (key.name === 'end') {
      const moveRight = this.currentInput.length - this.cursorPos;
      this.cursorPos = this.currentInput.length;
      if (moveRight > 0) {
        process.stdout.write(`\x1b[${moveRight}C`); // Move cursor right by moveRight positions
      }
      this.lastKeypressTime = currentTime;
      return;
    }

    // Handle regular printable characters (but not during paste)
    if (str && str.length === 1 && !key.ctrl && !key.alt && !key.meta) {
      this.insertAtCursor(str);
      this.redrawLine();
    }

    this.lastKeypressTime = currentTime;
  }

  insertAtCursor(text) {
    this.currentInput = this.currentInput.slice(0, this.cursorPos) +
      text +
      this.currentInput.slice(this.cursorPos);
    this.cursorPos += text.length;
  }

  handlePossiblePaste(char) {
    // Start paste mode if not already pasting
    if (!this.isPasting) {
      this.isPasting = true;
      this.pasteBuffer = '';
    }

    // Add character to paste buffer
    this.pasteBuffer += char;

    // Clear any existing timeout
    if (this.pasteTimeout) {
      clearTimeout(this.pasteTimeout);
    }

    // Set a timeout to finalize the paste after a short delay
    this.pasteTimeout = setTimeout(() => {
      this.finalizePaste();
    }, 50); // 50ms delay to allow for complete paste
  }

  finalizePaste() {
    if (!this.isPasting || !this.pasteBuffer) {
      return;
    }

    // Insert all pasted content at once
    this.insertAtCursor(this.pasteBuffer);
    this.redrawLine();

    // Reset paste state
    this.isPasting = false;
    this.pasteBuffer = '';

    if (this.pasteTimeout) {
      clearTimeout(this.pasteTimeout);
      this.pasteTimeout = null;
    }
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

  // File System Operations

  // List directory contents
  listDir(dirPath) {
    try {
      if (!fs.existsSync(dirPath)) {
        return `Error: Directory "${dirPath}" does not exist.`;
      }

      const stats = fs.statSync(dirPath);
      if (!stats.isDirectory()) {
        return `Error: "${dirPath}" is not a directory.`;
      }

      const items = fs.readdirSync(dirPath);
      const result = items.map(item => {
        const itemPath = path.join(dirPath, item);
        const itemStats = fs.statSync(itemPath);
        return itemStats.isDirectory() ? `${item}/` : item;
      });

      return result.length > 0 ? result.join('\n') : '(empty directory)';
    } catch (error) {
      return `Error listing directory: ${error.message}`;
    }
  }

  // Search for files by glob pattern
  fileSearch(pattern, maxResults = 50) {
    try {
      // Use glob to find files matching the pattern
      const files = glob.sync(pattern, {
        cwd: process.cwd(),
        ignore: ['node_modules/**', '.git/**', '**/*.log'],
        nodir: false
      });

      if (files.length === 0) {
        return `No files found matching pattern: ${pattern}`;
      }

      const limitedFiles = maxResults ? files.slice(0, maxResults) : files;
      let result = limitedFiles.join('\n');

      if (files.length > limitedFiles.length) {
        result += `\n... and ${files.length - limitedFiles.length} more files (showing first ${maxResults})`;
      }

      return result;
    } catch (error) {
      return `Error searching files: ${error.message}`;
    }
  }

  // Search for text within files (grep)
  grepSearch(query, isRegexp = false, includePattern = '**/*', maxResults = 50) {
    try {
      const files = glob.sync(includePattern, {
        cwd: process.cwd(),
        ignore: ['node_modules/**', '.git/**', '**/*.log', '**/.*'],
        nodir: true
      });

      const results = [];
      const searchRegex = isRegexp ? new RegExp(query, 'i') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

      for (const file of files) {
        try {
          const content = fs.readFileSync(file, 'utf8');
          const lines = content.split('\n');

          lines.forEach((line, index) => {
            if (searchRegex.test(line)) {
              results.push(`${file}:${index + 1}:${line.trim()}`);
            }
          });

          if (results.length >= maxResults) break;
        } catch (err) {
          // Skip files that can't be read (binary files, permission issues, etc.)
          continue;
        }
      }

      if (results.length === 0) {
        return `No matches found for: ${query}`;
      }

      const limitedResults = results.slice(0, maxResults);
      let result = limitedResults.join('\n');

      if (results.length > limitedResults.length) {
        result += `\n... and ${results.length - limitedResults.length} more matches (showing first ${maxResults})`;
      }

      return result;
    } catch (error) {
      return `Error searching text: ${error.message}`;
    }
  }

  // Read file contents
  readFile(filePath, offset = null, limit = null) {
    try {
      if (!fs.existsSync(filePath)) {
        return `Error: File "${filePath}" does not exist.`;
      }

      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        return `Error: "${filePath}" is a directory, not a file.`;
      }

      const content = fs.readFileSync(filePath, 'utf8');

      if (offset !== null || limit !== null) {
        const lines = content.split('\n');
        const startLine = offset ? Math.max(0, offset - 1) : 0;
        const endLine = limit ? Math.min(lines.length, startLine + limit) : lines.length;
        const selectedLines = lines.slice(startLine, endLine);

        return selectedLines.join('\n');
      }

      return content;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return `Error: File "${filePath}" not found.`;
      } else if (error.code === 'EACCES') {
        return `Error: Permission denied reading "${filePath}".`;
      } else {
        return `Error reading file: ${error.message}`;
      }
    }
  }

  // Create new file
  createFile(filePath, content) {
    try {
      // Create directory if it doesn't exist
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Check if file already exists
      if (fs.existsSync(filePath)) {
        return `Error: File "${filePath}" already exists. Use replace_string_in_file to edit existing files.`;
      }

      fs.writeFileSync(filePath, content, 'utf8');
      return `File created successfully: ${filePath}`;
    } catch (error) {
      return `Error creating file: ${error.message}`;
    }
  }

  // Replace string in existing file
  replaceStringInFile(filePath, oldString, newString) {
    try {
      if (!fs.existsSync(filePath)) {
        return `Error: File "${filePath}" does not exist.`;
      }

      const content = fs.readFileSync(filePath, 'utf8');

      // Check if the old string exists in the file
      if (!content.includes(oldString)) {
        return `Error: The specified text was not found in the file. Make sure the oldString matches exactly, including whitespace and line breaks.`;
      }

      // Count occurrences to warn about multiple matches
      const occurrences = (content.match(new RegExp(oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      if (occurrences > 1) {
        return `Error: Found ${occurrences} occurrences of the text. Please provide more specific context to ensure unique replacement.`;
      }

      const newContent = content.replace(oldString, newString);
      fs.writeFileSync(filePath, newContent, 'utf8');

      return `File updated successfully: ${filePath}`;
    } catch (error) {
      return `Error replacing string in file: ${error.message}`;
    }
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
      } else if (call.name === 'list_dir') {
        const dirPath = call.parameters.path;
        const result = this.listDir(dirPath);
        results += `\n<function_results>\n${result}\n</function_results>\n`;
      } else if (call.name === 'file_search') {
        const query = call.parameters.query;
        const maxResults = call.parameters.maxResults ? parseInt(call.parameters.maxResults) : 50;
        const result = this.fileSearch(query, maxResults);
        results += `\n<function_results>\n${result}\n</function_results>\n`;
      } else if (call.name === 'grep_search') {
        const query = call.parameters.query;
        const isRegexp = call.parameters.isRegexp === 'true';
        const includePattern = call.parameters.includePattern || '**/*';
        const maxResults = call.parameters.maxResults ? parseInt(call.parameters.maxResults) : 50;
        const result = this.grepSearch(query, isRegexp, includePattern, maxResults);
        results += `\n<function_results>\n${result}\n</function_results>\n`;
      } else if (call.name === 'read_file') {
        const filePath = call.parameters.filePath;
        const offset = call.parameters.offset ? parseInt(call.parameters.offset) : null;
        const limit = call.parameters.limit ? parseInt(call.parameters.limit) : null;
        const result = this.readFile(filePath, offset, limit);
        results += `\n<function_results>\n${result}\n</function_results>\n`;
      } else if (call.name === 'create_file') {
        const filePath = call.parameters.filePath;
        const content = call.parameters.content || '';
        const result = this.createFile(filePath, content);
        results += `\n<function_results>\n${result}\n</function_results>\n`;
      } else if (call.name === 'replace_string_in_file') {
        const filePath = call.parameters.filePath;
        const oldString = call.parameters.oldString;
        const newString = call.parameters.newString;
        const result = this.replaceStringInFile(filePath, oldString, newString);
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

// Handle command line arguments
function showHelp() {
  console.log('Ollama Chat - Interactive command-line chat interface for Ollama');
  console.log('');
  console.log('Usage: node ollama-chat.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --help, -h     Show this help message');
  console.log('  --model, -m    Set the Ollama model to use (default: llama2)');
  console.log('  --host         Set the Ollama host URL (default: http://localhost:11434)');
  console.log('');
  console.log('Environment Variables:');
  console.log('  OLLAMA_MODEL      Model to use (default: llama2)');
  console.log('  OLLAMA_HOST       Host URL for Ollama server');
  console.log('  OLLAMA_BASE_URL   Alternative host URL setting');
  console.log('  OLLAMA_API_KEY    API key for authentication (if required)');
  console.log('');
  console.log('Interactive Commands:');
  console.log('  Enter             Send message to the AI');
  console.log('  Alt+Enter         Insert new line (for multi-line messages)');
  console.log('  Ctrl+L            Clear conversation history');
  console.log('  Ctrl+C            Exit the application');
  console.log('');
  console.log('Features:');
  console.log('  • Multi-line input support with proper paste handling');
  console.log('  • Conversation history and context preservation');
  console.log('  • File system operations (read, write, search files)');
  console.log('  • Terminal command execution');
  console.log('  • System instructions from docs/system.md');
  console.log('');
  console.log('Examples:');
  console.log('  node ollama-chat.js');
  console.log('  node ollama-chat.js --model codellama');
  console.log('  OLLAMA_MODEL=mistral node ollama-chat.js');
}

// Parse command line arguments
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--help' || arg === '-h') {
    showHelp();
    process.exit(0);
  } else if (arg === '--model' || arg === '-m') {
    if (i + 1 < args.length) {
      process.env.OLLAMA_MODEL = args[i + 1];
      i++; // Skip the next argument as it's the model name
    } else {
      console.error('Error: --model requires a model name');
      process.exit(1);
    }
  } else if (arg === '--host') {
    if (i + 1 < args.length) {
      process.env.OLLAMA_HOST = args[i + 1];
      i++; // Skip the next argument as it's the host URL
    } else {
      console.error('Error: --host requires a URL');
      process.exit(1);
    }
  } else {
    console.error(`Error: Unknown argument '${arg}'`);
    console.error('Use --help to see available options');
    process.exit(1);
  }
}

// Check if required packages are available
const requiredPackages = ['node-fetch', 'xml2js', 'glob'];
const missingPackages = [];

for (const pkg of requiredPackages) {
  try {
    require.resolve(pkg);
  } catch (e) {
    missingPackages.push(pkg);
  }
}

if (missingPackages.length > 0) {
  console.error('Error: Required packages are missing:');
  missingPackages.forEach(pkg => console.error(`  - ${pkg}`));
  console.error('\nPlease install them by running:');
  console.error(`npm install ${missingPackages.join(' ')}`);
  process.exit(1);
}

// Start the chat application
const chat = new OllamaChat();
chat.start();
