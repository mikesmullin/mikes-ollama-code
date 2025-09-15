#!/usr/bin/env bash
export OLLAMA_HOST=http://172.24.0.1:11434
export OLLAMA_MODEL="qwen3:8b"
#ollama run 

node ollama-chat.js $*

