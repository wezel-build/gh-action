const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseRunOutput,
  reportUrl,
  statusUrl,
  updateStatus,
} = require("../lib/exact-run.js");

test("parses the pretty JSON emitted by an exact saved run", () => {
  assert.deepEqual(
    parseRunOutput(`{
      "experiment": "benchmark",
      "status": "complete",
      "runId": 42,
      "runDir": ".wezel/runs/benchmark/a1b2c3"
    }`),
    {
      experiment: "benchmark",
      status: "complete",
      runId: 42,
      runDir: ".wezel/runs/benchmark/a1b2c3",
    }
  );
});

test("rejects missing and mismatched run metadata", () => {
  assert.throws(() => parseRunOutput("not json"), /no JSON output/);
  assert.throws(
    () => parseRunOutput('{"status":"complete","runId":42}'),
    /invalid JSON output/
  );
});

test("builds public runner API URLs without duplicate slashes", () => {
  assert.equal(statusUrl("https://api.example/", 42), "https://api.example/api/runs/42/status");
  assert.equal(reportUrl("https://api.example/"), "https://api.example/api/runs/report");
});

test("status updates use bearer auth and the Fafik-compatible body", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, init) => {
    request = { url, init };
    return new Response(null, { status: 204 });
  };
  try {
    await updateStatus("https://api.example", "runner-secret", 42, "failed", "boom");
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(request.url, "https://api.example/api/runs/42/status");
  assert.equal(request.init.method, "PATCH");
  assert.equal(request.init.headers.Authorization, "Bearer runner-secret");
  assert.equal(request.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.init.body), { status: "failed", error: "boom" });
});
