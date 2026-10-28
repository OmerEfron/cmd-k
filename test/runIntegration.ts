import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // out/test/runIntegration.js -> repository root
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "integration/index");

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "quickk-ws-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "quickk-user-"));

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--disable-workspace-trust",
      // Set QUICKK_NO_PROPOSED=1 to test the fallback path without the proposed API.
      ...(process.env.QUICKK_NO_PROPOSED ? [] : ["--enable-proposed-api=quickk.quickk"]),
      "--user-data-dir",
      userData,
    ],
  });
}

main().catch((error) => {
  console.error("Integration tests failed:", error);
  process.exit(1);
});
