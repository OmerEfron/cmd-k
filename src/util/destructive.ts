interface Rule {
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  { pattern: /\brm\s+(?:-[a-z]*\s+)*(?:-[a-z]*[rf][a-z]*|--recursive|--force)\b/i, reason: "deletes files recursively or without asking (rm -r / rm -f)" },
  { pattern: /\bdd\b[^|;&]*\bof=/, reason: "writes raw data to a file or device (dd)" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "formats a disk (mkfs)" },
  { pattern: /\bgit\s+push\b[^|;&]*(?:--force(?![-\w])|\s-f\b)/, reason: "overwrites remote history (git push --force)" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "throws away local changes (git reset --hard)" },
  { pattern: /\bgit\s+clean\b[^|;&]*\s-[a-z]*f/, reason: "deletes untracked files (git clean -f)" },
  { pattern: /\bchmod\s+(?:-[a-z]+\s+)*[0-7]?777\b/, reason: "makes files writable for everyone (chmod 777)" },
  { pattern: /\b(?:chmod|chown)\s+(?:-[a-z]*r[a-z]*|--recursive)\b/i, reason: "changes permissions or owner recursively" },
  { pattern: />\s*\/dev\/(?:sd|nvme|disk|hd)/, reason: "writes directly to a disk device" },
  { pattern: /:\(\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;\s*:/, reason: "looks like a fork bomb" },
  { pattern: /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i, reason: "deletes database data (DROP / TRUNCATE)" },
  { pattern: /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, reason: "runs downloaded or piped code in a shell" },
  { pattern: /\bdocker\s+(?:system\s+prune|volume\s+(?:rm|prune)|rm\s+-f)/, reason: "removes Docker data" },
  { pattern: /\bRemove-Item\b[^|;&]*-Recurse/i, reason: "deletes files recursively (Remove-Item -Recurse)" },
  { pattern: /\b(?:Format-Volume|Clear-Disk)\b/i, reason: "formats or wipes a disk" },
  { pattern: /\b(?:del|rmdir|rd)\b[^|;&]*\s\/s\b/i, reason: "deletes files recursively (del /s)" },
  { pattern: /(?:^|[;&|]\s*|\bsudo\s+)(?:shutdown|reboot|halt|poweroff)\b/, reason: "shuts down or restarts the machine" },
];

/** Returns the reason why a command looks dangerous, or undefined if it looks normal. */
export function findDestructiveReason(command: string): string | undefined {
  for (const rule of RULES) {
    if (rule.pattern.test(command)) {
      return rule.reason;
    }
  }
  return undefined;
}
