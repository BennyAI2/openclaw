import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fetchPublishedRepositoryAdvisories } from "../../../scripts/lib/upstream-repository-advisories.mts";

const payload = { hono: ["4.13.3"], "fast-xml-builder": ["1.3.1"], "fast-xml-parser": ["5.11.0"] };
const accessible = [
  "GHSA-m732-5p4w-x69g",
  "GHSA-xh87-mx6m-69f3",
  "GHSA-45c6-75p6-83cc",
  "GHSA-8r6m-32jq-jx6q",
];
const requests: Array<{
  pathname: string;
  status: number;
  remaining: string | null;
  retryAfter: string | null;
}> = [];
const fetchImpl: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = new URL(String(input));
  if (url.origin === "https://api.github.com")
    requests.push({
      pathname: url.pathname,
      status: response.status,
      remaining: response.headers.get("x-ratelimit-remaining"),
      retryAfter: response.headers.get("retry-after"),
    });
  return response;
};
const report = await fetchPublishedRepositoryAdvisories({
  payload,
  registryBaseUrl: "https://registry.npmjs.org",
  fetchImpl,
});
const source = await readFile("scripts/lib/upstream-repository-advisories.mts");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const token = process.env.GH_TOKEN;
assert(token);
await writeFile(
  "scanner-diagnostic.json",
  JSON.stringify(
    {
      diagnosticOnly: true,
      runId: process.env.GITHUB_RUN_ID,
      workflowSha: process.env.GITHUB_SHA,
      node: process.version,
      sourceSha256,
      payload,
      requests,
      report,
    },
    null,
    2,
  ).replaceAll(token, "[redacted]") + "\n",
);
const denied = requests.filter(
  ({ pathname, status }) => pathname.startsWith("/advisories/") && status === 403,
);
assert(denied.length > 0, "Expected observed resource-scoped GitHub installation-token denial");
for (const { pathname } of denied) {
  const id = pathname.split("/").at(-1);
  assert(
    report.advisories.some((item) => item.id === id),
    "Denied advisory must retain its raw finding",
  );
  assert(
    report.coverage.issues.some(
      (item) => item.subject.endsWith(`#${id}`) && item.reason === "request-failed",
    ),
  );
}
for (const id of accessible) {
  assert(
    report.coverage.reconciliations.some(
      (item) => item.id === id && item.matchedVersions.length === 0,
    ),
    `Expected accessible reviewed range reconciliation for ${id}`,
  );
  assert(!report.advisories.some((item) => item.id === id));
}
const firstDenial = requests.findIndex(
  ({ pathname, status }) => pathname.startsWith("/advisories/") && status === 403,
);
assert(
  requests.some(
    ({ pathname, status }, index) =>
      index > firstDenial &&
      status === 200 &&
      accessible.some((id) => pathname === `/advisories/${id}`),
  ),
  "Expected an accessible reviewed response after a resource denial",
);
console.log(
  JSON.stringify({
    diagnosticOnly: true,
    sourceSha256,
    deniedRetained: denied.length,
    reviewedFalsePositivesCleared: accessible.length,
    findingsRetained: report.advisories.length,
  }),
);
