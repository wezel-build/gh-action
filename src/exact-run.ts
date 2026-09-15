import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

const REPORT_CONTENT_TYPE = "application/vnd.wezel.run-report+tar+zstd";

export interface RunCommandOutput {
  status: "complete";
  runId: number;
  runDir: string;
}

export interface ExactRunOptions {
  runId: number;
  experimentName: string;
  projectDir: string;
  apiUrl: string;
  token: string;
  env: Record<string, string>;
}

export function parseRunOutput(stdout: string): RunCommandOutput {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("no JSON output from `wezel experiment run`");
  }
  const value = JSON.parse(stdout.slice(start, end + 1)) as Partial<RunCommandOutput>;
  if (
    value.status !== "complete" ||
    !Number.isSafeInteger(value.runId) ||
    typeof value.runDir !== "string" ||
    value.runDir.length === 0
  ) {
    throw new Error("invalid JSON output from `wezel experiment run`");
  }
  return value as RunCommandOutput;
}

export function statusUrl(apiUrl: string, runId: number): string {
  return `${apiUrl.replace(/\/+$/, "")}/api/runs/${runId}/status`;
}

export function reportUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/api/runs/report`;
}

async function request(
  url: string,
  token: string,
  init: RequestInit
): Promise<void> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!response.ok) {
    const body = (await response.text()).trim();
    throw new Error(`${init.method} ${url} returned ${response.status}${body ? `: ${body}` : ""}`);
  }
}

export async function updateStatus(
  apiUrl: string,
  token: string,
  runId: number,
  status: "running" | "complete" | "failed",
  error: string | null
): Promise<void> {
  await request(statusUrl(apiUrl, runId), token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, error }),
  });
}

async function makeReportPackage(runDir: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const report = path.join(runDir, "report.json");
  const stat = await fs.stat(report).catch(() => null);
  if (!stat?.isFile()) throw new Error(`saved run is missing report.json: ${report}`);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wezel-report-"));
  const tarFile = path.join(tempDir, "report.tar");
  const packageFile = `${tarFile}.zst`;
  const entries = ["report.json"];
  if ((await fs.stat(path.join(runDir, "attachments")).catch(() => null))?.isDirectory()) {
    entries.push("attachments");
  }
  try {
    await exec.exec("tar", ["-C", runDir, "-cf", tarFile, "--", ...entries]);
    await exec.exec("zstd", ["-q", "-f", tarFile, "-o", packageFile]);
    return { file: packageFile, cleanup: () => fs.rm(tempDir, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function executeExactRun(options: ExactRunOptions): Promise<void> {
  const { runId, experimentName, projectDir, apiUrl, token, env } = options;
  await updateStatus(apiUrl, token, runId, "running", null);

  let stdout = "";
  const code = await core.group("Run assigned experiment", () =>
    exec.exec(
      "wezel",
      ["experiment", "run", experimentName, "--run-id", String(runId), "--save", "yes", "--output-format", "json", "--project-dir", projectDir],
      { env, ignoreReturnCode: true, listeners: { stdout: (data) => (stdout += data.toString()) } }
    )
  );
  if (code !== 0) throw new Error(`wezel experiment run exited with code ${code}`);

  const result = parseRunOutput(stdout);
  if (result.runId !== runId) throw new Error(`wezel returned run id ${result.runId}, expected ${runId}`);

  const reportPackage = await makeReportPackage(result.runDir);
  try {
    await request(reportUrl(apiUrl), token, {
      method: "POST",
      headers: { "Content-Type": REPORT_CONTENT_TYPE },
      body: new Uint8Array(await fs.readFile(reportPackage.file)),
    });
  } finally {
    await reportPackage.cleanup();
  }
  // Completion comes after upload: Fiflok can safely process the package first.
  await updateStatus(apiUrl, token, runId, "complete", null);
}
