const bourneShells = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "ksh93", "mksh", "yash", "posh"]);

function quoteBourne(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function gitBashPath(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/^([a-z]):(?=\/)/i, (_, drive: string) => `/${drive.toLowerCase()}`);
}

/** Builds one paste of literal shell arguments, with no terminal control bytes. */
export function quoteDroppedPaths(program: string, paths: readonly string[]): string | null {
  if (paths.length === 0 || paths.some((path) => !path || /\p{Cc}/u.test(path))) return null;
  const shell = program.toLowerCase();
  if (bourneShells.has(shell)) return paths.map(quoteBourne).join(" ");

  switch (shell) {
    case "fish":
      return paths.map((path) => `'${path.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`).join(" ");
    case "csh":
    case "tcsh":
      return paths.map((path) => quoteBourne(path.replaceAll("!", "\\!"))).join(" ");
    case "bash.exe":
      return paths.map((path) => quoteBourne(gitBashPath(path))).join(" ");
    case "powershell.exe":
    case "pwsh.exe":
    case "pwsh":
      return paths.map((path) => `'${path.replace(/['‘’‚‛]/gu, "$&$&")}'`).join(" ");
    case "cmd":
    case "cmd.exe":
      // CMD can expand percent variables and delayed exclamation-mark variables inside quotes.
      if (paths.some((path) => /["%!]/u.test(path))) return null;
      return paths.map((path) => `"${path}"`).join(" ");
    default:
      return null;
  }
}
