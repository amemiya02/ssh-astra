# Terminal completion catalog

The build bundles the committed catalog at `src/features/terminal/completion-catalog.json`. Normal builds use that file offline. The catalog covers 54 common commands using the static fields of [Fig's MIT-licensed completion specs](https://github.com/withfig/autocomplete/tree/aef52acff84c45edde61ae610cc2c964802b9a38). The generator reads the TypeScript syntax tree and keeps names, subcommands, options and path templates. Fig's dynamic suggestions, executables, generators and imports are outside the static subset. The `cd` directory argument is mapped explicitly from its Fig folder-only generator.

To regenerate, download the pinned archive and pass its path to the build-time generator after the project's normal dependency setup.

```sh
curl -fL https://codeload.github.com/withfig/autocomplete/tar.gz/aef52acff84c45edde61ae610cc2c964802b9a38 -o fig-completions.tar.gz
pnpm generate:completions fig-completions.tar.gz
git diff -- src/features/terminal/completion-catalog.json public/completion-catalog-notices.txt
```

The generator verifies the archive's SHA-256 before reading source files. It writes the catalog and ships the upstream license in `public/completion-catalog-notices.txt`.

Remote path completion lists a single directory on request. Bare paths are relative to the prompt's reported working directory, absolute paths are listed directly, and `~/` starts from the SFTP account's home directory. The listing returns a bounded set of matches, checking up to 4,096 entries. Names that begin with a dot require a dot prefix. The list works at the end of simple shell commands with separately entered options and arguments, including quoted paths. Tab still goes to the shell for shell-specific completion.
