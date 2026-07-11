const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const shaPattern = /^[0-9a-f]{40}$/u;

export function expectedGithubRepository() {
  const value =
    process.env.GITHUB_REPOSITORY ??
    process.env.CF_AUTH_EXPECTED_REPOSITORY ??
    "";
  return repositoryPattern.test(value) ? value : null;
}

export function requireExactPackageNames({
  actual,
  expected,
  evidencePath,
  failures,
}) {
  if (
    !Array.isArray(actual) ||
    actual.some((name) => typeof name !== "string")
  ) {
    failures.push(`${evidencePath}: packageNames must be an array of strings`);
    return;
  }
  const normalized = [...new Set(actual)].sort();
  const wanted = [...new Set(expected)].sort();
  if (
    normalized.length !== actual.length ||
    JSON.stringify(normalized) !== JSON.stringify(wanted)
  ) {
    failures.push(
      `${evidencePath}: packageNames must exactly match publishable workspace packages (${wanted.join(", ")})`,
    );
  }
}

export async function verifyGithubWorkflowRun({
  binding,
  bindingPath,
  evidencePath,
  expectedRepository,
  expectedWorkflowPath,
  failures,
}) {
  if (!isObject(binding)) {
    failures.push(`${evidencePath}: ${bindingPath} must be an object`);
    return;
  }
  const { workflowRunUrl, headSha } = binding;
  if (typeof workflowRunUrl !== "string") {
    failures.push(
      `${evidencePath}: ${bindingPath}.workflowRunUrl must be a string`,
    );
    return;
  }
  if (typeof headSha !== "string" || !shaPattern.test(headSha)) {
    failures.push(
      `${evidencePath}: ${bindingPath}.headSha must be a full lowercase commit SHA`,
    );
  }
  const parsed = parseRunUrl(workflowRunUrl);
  if (!parsed) {
    failures.push(
      `${evidencePath}: ${bindingPath}.workflowRunUrl must be an exact GitHub Actions run URL`,
    );
    return;
  }
  if (parsed.repository !== expectedRepository) {
    failures.push(
      `${evidencePath}: ${bindingPath}.workflowRunUrl must target ${expectedRepository}`,
    );
  }
  let run;
  try {
    run = await githubRun(workflowRunUrl, parsed);
  } catch (error) {
    failures.push(
      `${evidencePath}: ${bindingPath}.workflowRunUrl could not be verified: ${errorMessage(error)}`,
    );
    return;
  }
  if (!isObject(run)) {
    failures.push(
      `${evidencePath}: ${bindingPath}.workflowRunUrl returned a malformed GitHub workflow run response`,
    );
    return;
  }
  const actualRepository =
    run.repository?.full_name ?? run.repository ?? run.repositoryName;
  const actualSha = run.head_sha ?? run.headSha;
  const actualPath = String(run.path ?? run.workflowPath ?? "").split(
    "@",
    1,
  )[0];
  if (actualRepository !== expectedRepository) {
    failures.push(
      `${evidencePath}: ${bindingPath} verified run repository must be ${expectedRepository}`,
    );
  }
  if (actualSha !== headSha) {
    failures.push(
      `${evidencePath}: ${bindingPath}.headSha must match the verified workflow run`,
    );
  }
  if (actualPath !== expectedWorkflowPath) {
    failures.push(
      `${evidencePath}: ${bindingPath} must reference ${expectedWorkflowPath}`,
    );
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    failures.push(
      `${evidencePath}: ${bindingPath} workflow run must be completed successfully`,
    );
  }
}

export async function verifyGithubSecurityState({
  issueSearchUrl,
  repository,
  advisories,
  evidencePath,
  failures,
}) {
  let issueResult;
  try {
    issueResult = await githubIssueSearch(issueSearchUrl, repository);
  } catch (error) {
    failures.push(
      `${evidencePath}: issueSearchUrl could not be verified: ${errorMessage(error)}`,
    );
  }
  const totalCount = issueResult?.total_count ?? issueResult?.totalCount;
  const incomplete =
    issueResult?.incomplete_results ?? issueResult?.incompleteResults;
  if (incomplete !== false) {
    failures.push(
      `${evidencePath}: GitHub issue search response must be complete`,
    );
  }
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    failures.push(
      `${evidencePath}: GitHub issue search response must include a non-negative total_count`,
    );
  } else if (totalCount !== 0) {
    failures.push(
      `${evidencePath}: GitHub reports ${totalCount} open high/critical auth issue(s)`,
    );
  }

  let liveAdvisories;
  try {
    liveAdvisories = await githubAdvisories(repository);
  } catch (error) {
    failures.push(
      `${evidencePath}: advisorySearchUrl could not be verified: ${errorMessage(error)}`,
    );
    return;
  }
  if (!Array.isArray(liveAdvisories)) {
    failures.push(
      `${evidencePath}: GitHub advisories response must be an array`,
    );
    return;
  }
  const local = new Map(
    (Array.isArray(advisories) ? advisories : [])
      .filter(isObject)
      .map((item) => [item.id, item]),
  );
  for (const [index, advisory] of liveAdvisories.entries()) {
    if (!isObject(advisory)) {
      failures.push(
        `${evidencePath}: GitHub advisories response item ${index} must be an object`,
      );
      continue;
    }
    const id = advisory.ghsa_id ?? advisory.id;
    const severity = String(advisory.severity ?? "").toLowerCase();
    const state = String(advisory.state ?? "").toLowerCase();
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      !["low", "moderate", "medium", "high", "critical"].includes(severity) ||
      !["draft", "published", "closed"].includes(state)
    ) {
      failures.push(
        `${evidencePath}: GitHub advisories response item ${index} is malformed`,
      );
      continue;
    }
    if (!["high", "critical"].includes(severity)) continue;
    if (!["published", "closed"].includes(state)) {
      failures.push(
        `${evidencePath}: GitHub advisory ${id} is ${severity} and not resolved`,
      );
      continue;
    }
    if (local.get(id)?.status !== "resolved") {
      failures.push(
        `${evidencePath}: resolved GitHub advisory ${id} must be recorded in advisories`,
      );
    }
  }
}

function parseRunUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = url.pathname.match(
    /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9]\d*)$/u,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !match ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return { repository: `${match[1]}/${match[2]}`, runId: match[3] };
}

async function githubRun(url, parsed) {
  const fixture = githubFixture();
  if (fixture) {
    const result = fixture.runs?.[url];
    if (!result) throw new Error("run is absent from the trusted test fixture");
    return result;
  }
  return fetchGithubJson(
    `https://api.github.com/repos/${parsed.repository}/actions/runs/${parsed.runId}`,
  );
}

async function githubIssueSearch(url, repository) {
  const fixture = githubFixture();
  if (fixture) {
    const result = fixture.issueSearch?.[url];
    if (!result)
      throw new Error("issue search is absent from the trusted test fixture");
    return result;
  }
  const parsed = new URL(url);
  const query = parsed.searchParams.get("q") ?? "";
  return fetchGithubJson(
    `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${repository} ${query}`)}`,
  );
}

async function githubAdvisories(repository) {
  const fixture = githubFixture();
  if (fixture) {
    if (!Object.hasOwn(fixture.advisories ?? {}, repository)) {
      throw new Error("advisories are absent from the trusted test fixture");
    }
    return fixture.advisories[repository];
  }
  return fetchGithubJson(
    `https://api.github.com/repos/${repository}/security-advisories?per_page=100`,
  );
}

let parsedFixture;
function githubFixture() {
  const text = process.env.CF_AUTH_GITHUB_API_FIXTURE_JSON;
  if (!text) return null;
  if (parsedFixture === undefined) parsedFixture = JSON.parse(text);
  return parsedFixture;
}

async function fetchGithubJson(url) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  return response.json();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
