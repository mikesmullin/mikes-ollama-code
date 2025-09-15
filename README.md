## Running from windows

```
ollama stop qwen:8b
set OLLAMA_HOST="0.0.0.0"
ollama serve
```

---
## Setup Podman in WSL2

```sh
# from windows
podman machine start


# from wsl2 ubuntu
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