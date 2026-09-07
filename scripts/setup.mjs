import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { confirm, getPackageEntries, readSettings, writeSettings } from "./pi-settings.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const globalSettings = path.join(os.homedir(), ".pi", "agent", "settings.json");
const settingsDir = path.dirname(globalSettings);

function resolvesToRepoRoot(entry) {
  if (typeof entry !== "string") return false;
  const resolved = path.resolve(settingsDir, entry);
  return resolved === repoRoot;
}

async function enableRtk() {
  if (process.env.OH_MY_PI_SKIP_RTK === "1") {
    console.log("Skipped rtk init because OH_MY_PI_SKIP_RTK=1.");
    return false;
  }

  try {
    await execFileAsync("rtk", ["init", "-g", "--agent", "pi"], { timeout: 30_000 });
    console.log("rtk init -g --agent pi completed.");
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      console.log("rtk is not installed; skipped rtk init.");
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.log(`rtk init failed; continuing setup. ${message}`);
    return false;
  }
}

const larkSkills = ["lark-doc", "lark-drive", "lark-wiki", "lark-shared"];

async function enableLarkCli() {
  if (process.env.OH_MY_PI_SKIP_LARK === "1") {
    console.log("Skipped lark-cli setup because OH_MY_PI_SKIP_LARK=1.");
    return "skipped";
  }

  // Step 1: Install @larksuite/cli globally
  try {
    await execFileAsync("npm", ["install", "-g", "@larksuite/cli"], { timeout: 120_000 });
    console.log("npm install -g @larksuite/cli completed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`lark-cli install failed; continuing setup. ${message}`);
    return false;
  }

  // Step 2: Install selected skills globally
  try {
    await execFileAsync(
      "npx",
      ["skills", "add", "larksuite/cli", "-s", ...larkSkills, "-y", "-g"],
      { timeout: 120_000 },
    );
    console.log(`lark-cli skills installed: ${larkSkills.join(", ")}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`lark-cli skills install failed; continuing setup. ${message}`);
    return false;
  }

  return true;
}

async function main() {
  const settings = await readSettings(globalSettings);
  const packages = getPackageEntries(settings);

  if (packages.some(resolvesToRepoRoot)) {
    console.log(`Already registered in ${globalSettings}`);
    console.log(` path: ${repoRoot}`);
  } else {
    console.log("The following change will be made:\n");
    console.log(` file: ${globalSettings}`);
    console.log(` action: add \"${repoRoot}\" to packages\n`);

    const ok = await confirm("Proceed? [y/N] ");
    if (!ok) {
      console.log("Aborted. No changes were made.");
      return;
    }

    settings.packages = [...packages, repoRoot];
    await writeSettings(globalSettings, settings);
    console.log("Registered oh-my-pi in global pi settings.");
  }

  const rtkEnabled = await enableRtk();
  if (!rtkEnabled) {
    console.log("Install rtk when ready, then run /oh-my-pi rtk inside pi to initialize it manually.");
  }

  const larkResult = await enableLarkCli();
  if (larkResult === false) {
    console.log("Install lark-cli manually: npm install -g @larksuite/cli");
    console.log(`Then install skills: npx skills add larksuite/cli -s ${larkSkills.join(" ")} -y -g`);
  }

  console.log("Done. Restart pi or run /reload.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
