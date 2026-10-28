/**
 * Checks whether a file name suggests that the file contains secrets.
 * QuickK asks before it sends such files to the AI provider.
 */
export function isSensitiveFile(filePath: string): boolean {
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "") {
    return false;
  }

  // .env, .env.local, .env.production ... but not the example files.
  if (name === ".env" || name.startsWith(".env.")) {
    return !/\.(example|sample|template|dist)$/.test(name);
  }

  const exactNames = new Set([".npmrc", ".netrc", ".pgpass", "credentials", "credentials.json", "service-account.json"]);
  if (exactNames.has(name)) {
    return true;
  }

  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)) {
    return !name.endsWith(".pub");
  }

  if (/\.(pem|key|p12|pfx|keystore|jks|ppk)$/.test(name)) {
    return true;
  }

  if (/^secrets?\.(json|ya?ml|toml|env)$/.test(name)) {
    return true;
  }

  return false;
}
