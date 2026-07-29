import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAuditResult } from "./audit-advisory.mjs";

function auditJson(vulnerabilities) {
  return JSON.stringify({ metadata: { vulnerabilities } });
}

test("O32: a clean high-severity audit is classified separately", () => {
  assert.deepEqual(
    classifyAuditResult({
      status: 0,
      stdout: auditJson({
        info: 0,
        low: 1,
        moderate: 2,
        high: 0,
        critical: 0,
        total: 3,
      }),
      stderr: "",
    }),
    {
      classification: "clean",
      exitCode: 0,
      npmExitCode: 0,
      vulnerabilities: {
        info: 0,
        low: 1,
        moderate: 2,
        high: 0,
        critical: 0,
        total: 3,
      },
      detail: "No high or critical vulnerabilities reported",
    },
  );
});

test("O32: high or critical findings are a visible advisory result", () => {
  const result = classifyAuditResult({
    status: 1,
    stdout: auditJson({
      info: 0,
      low: 0,
      moderate: 0,
      high: 2,
      critical: 1,
      total: 3,
    }),
    stderr: "",
  });

  assert.equal(result.classification, "high_severity_vulnerabilities");
  assert.equal(result.exitCode, 2);
  assert.equal(result.npmExitCode, 1);
  assert.match(result.detail, /2 high and 1 critical/);
});

test("O32: a registry outage is never labeled as a vulnerability", () => {
  const result = classifyAuditResult({
    status: 1,
    stdout: JSON.stringify({
      message: "request failed: getaddrinfo ENOTFOUND registry.npmjs.org",
      error: {
        code: "ENETUNREACH",
        summary: "registry unavailable",
        detail: "try again later",
      },
    }),
    stderr: "",
  });

  assert.equal(result.classification, "registry_error");
  assert.equal(result.exitCode, 1);
  assert.equal(result.vulnerabilities.high, 0);
  assert.match(result.detail, /ENETUNREACH/);
  assert.match(result.detail, /ENOTFOUND/);
});

test("O32: malformed, unexplained, and spawn failures remain distinct errors", () => {
  assert.equal(
    classifyAuditResult({
      status: 1,
      stdout: "<html>gateway error</html>",
      stderr: "bad gateway",
    }).classification,
    "malformed_response",
  );
  assert.equal(
    classifyAuditResult({
      status: 1,
      stdout: auditJson({
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      }),
      stderr: "unexpected npm failure",
    }).classification,
    "audit_error",
  );
  assert.equal(
    classifyAuditResult({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("npm could not spawn"),
    }).classification,
    "execution_error",
  );
});
