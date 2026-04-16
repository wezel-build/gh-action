import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as exec from "@actions/exec";
import * as os from "os";
import * as path from "path";

function getPlatform(): { os: string; arch: string; ext: string } {
  const platform = os.platform();
  const arch = os.arch();

  let targetOs: string;
  let targetArch: string;
  let ext: string;

  switch (platform) {
    case "linux":
      targetOs = "unknown-linux-gnu";
      ext = "tar.xz";
      break;
    case "darwin":
      targetOs = "apple-darwin";
      ext = "tar.xz";
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  switch (arch) {
    case "x64":
      targetArch = "x86_64";
      break;
    case "arm64":
      targetArch = "aarch64";
      break;
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }

  return { os: `${targetArch}-${targetOs}`, arch: targetArch, ext };
}

async function getLatestVersion(): Promise<string> {
  let output = "";
  await exec.exec("gh", [
    "release", "view", "--repo", "wezel-build/wezel", "--json", "tagName", "-q", ".tagName",
  ], {
    listeners: { stdout: (data) => { output += data.toString(); } },
    silent: true,
  });
  return output.trim();
}

export async function installWezel(version: string): Promise<string> {
  const { os: target, ext } = getPlatform();

  if (version === "latest") {
    version = await getLatestVersion();
    core.info(`Latest wezel version: ${version}`);
  }

  // Check tool cache first.
  const cached = tc.find("wezel", version);
  if (cached) {
    core.info(`Using cached wezel ${version}`);
    core.addPath(cached);
    return cached;
  }

  // Download from GitHub releases.
  // cargo-dist names archives like: wezel-{version}-{target}.tar.xz
  const tag = version.startsWith("v") ? version : version;
  const archiveName = `wezel-${tag}-${target}.${ext}`;
  const url = `https://github.com/wezel-build/wezel/releases/download/${tag}/${archiveName}`;

  core.info(`Downloading wezel from ${url}`);
  const downloadPath = await tc.downloadTool(url);

  let extractedPath: string;
  if (ext === "tar.xz") {
    extractedPath = await tc.extractTar(downloadPath, undefined, ["xJ"]);
  } else {
    extractedPath = await tc.extractTar(downloadPath);
  }

  // cargo-dist extracts to a directory named like the archive (minus extension).
  const innerDir = path.join(extractedPath, archiveName.replace(`.${ext}`, ""));

  // Cache for future runs.
  const cachedDir = await tc.cacheDir(innerDir, "wezel", version);
  core.addPath(cachedDir);

  core.info(`wezel ${version} installed to ${cachedDir}`);
  return cachedDir;
}
