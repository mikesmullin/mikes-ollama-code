use the `podman` (instead of `docker`) command to list containers running. if no `redis` container is running, start a new one.

---

create a file `./docs/cli.man` in the format of a man (linux manual) page, at the top include a quick reference table listing the scripts under `./actions/**/*.js` 
and instructions that for details they can run the command with `--help` to learn details of each command 

---

there is a minor color format issue:
- when it was thinking, the think text was the correct color as expected.
  - however, after the thinking ended and the `<function_calls>` started, half of the thinking text from `Okay, the user wants me to create a man page file called` down--plus the `<function_calls>` text--both turned green. why is that?
    - see the log in `logs\chat_2025-09-15_16-14-50-940Z.log`


- you can make the same improvement to the `FUNCTION CALL` and `FUNCTION RESULT`
