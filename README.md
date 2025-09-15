```
ollama stop qwen:8b
set OLLAMA_HOST="0.0.0.0"
ollama serve
```

---
## Prompts

create a file `./docs/cli.man` in the format of a man (linux manual) page, at the top include a quick reference table listing the scripts under `./actions/**/*.js` (using commands formatted for Ubuntu linux; if your command doesn't work, keep trying until it does), and instructions that for details they can run the command with `--help` to learn details of each command 


---
## Setup Podman in WSL2

```sh
sudo apt install podman-remote
alias podman=podman-remote
podman --version

cp /mnt/c/Users/mikes/.local/share/containers/podman/machine/machine ~/.ssh/podman-machine-key
chmod 600 ~/.ssh/podman-machine-key

podman system connection add windows-podman --identity ~/.ssh/podman-machine-key ssh://user@127.0.0.1:63320/run/user/1000/podman/podman.sock
podman system connection default windows-podman
podman system connection list
podman info
```