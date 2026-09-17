import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as exec from "@actions/exec";
import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";

const REPO = "wezel-build/wezel";

/** cargo-dist target triple for the current runner. */
function target(): string {
  const platform = os.platform();
  const arch = os.arch();

  const targetOs =
    platform === "linux"
      ? "unknown-linux-gnu"
      : platform === "darwin"
        ? "apple-darwin"
        : null;
  if (!targetOs) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const targetArch =
    arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!targetArch) {
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  return `${targetArch}-${targetOs}`;
}

/** Recursively locate a binary named `name` under `dir`. */
async function findBinary(dir: string, name: string): Promise<string | null> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findBinary(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

export async function installWezel(
  version: string,
  token: string
): Promise<void> {
  const tgt = target();

  const cached = tc.find("wezel", version);
  if (cached) {
    core.info(`Using cached wezel ${version}`);
    core.addPath(cached);
    return;
  }

  // Download whatever cargo-dist named the tarball for this target, rather than
  // hard-coding its archive naming scheme.
  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "wezel-dl-"));
  await exec.exec(
    "gh",
    [
      "release",
      "download",
      version,
      "--repo",
      REPO,
      "--pattern",
      `*${tgt}*.tar.xz`,
      "--dir",
      downloadDir,
    ],
    { env: { ...process.env, GH_TOKEN: token } }
  );

  const archive = (await fs.readdir(downloadDir)).find((f) =>
    f.endsWith(".tar.xz")
  );
  if (!archive) {
    throw new Error(`no archive matching ${tgt} in release ${version}`);
  }

  const extracted = await tc.extractTar(
    path.join(downloadDir, archive),
    undefined,
    ["xJ"]
  );
  const binary = await findBinary(extracted, "wezel");
  if (!binary) {
    throw new Error(`wezel binary not found in archive ${archive}`);
  }

  const cachedDir = await tc.cacheDir(path.dirname(binary), "wezel", version);
  core.addPath(cachedDir);
  core.info(`wezel ${version} installed to ${cachedDir}`);
}
