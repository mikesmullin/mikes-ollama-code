#!/usr/bin/env node

const readline = require('readline');
const fetch = require('node-fetch');
const process = require('process');

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
    this.setupReadline();
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
      this.conversationHistory = [];
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

  async sendMessage(message) {
    // Add user message to conversation history
    this.conversationHistory.push({
      role: 'user',
      content: message
    });

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
                process.stdout.write('\n');
                this.showPrompt();
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
        if (assistantResponse.trim()) {
          this.conversationHistory.push({
            role: 'assistant',
            content: assistantResponse.trim()
          });
        }
        process.stdout.write('\n');
        this.showPrompt();
      });

      reader.on('error', (err) => {
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
