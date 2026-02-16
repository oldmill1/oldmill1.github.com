import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const ENV_PATH = path.join(ROOT, ".env");
const OUTPUT_PATH = path.join(ROOT, "activity", "contributions.json");

function parseEnv(content) {
  const env = {};
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadEnv() {
  try {
    const file = await readFile(ENV_PATH, "utf8");
    return parseEnv(file);
  } catch {
    return {};
  }
}

function isoNow() {
  return new Date().toISOString();
}

function isoYearAgo() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 365);
  return d.toISOString();
}

function dateFromIso(value) {
  return String(value || "").slice(0, 10);
}

function buildCommitDays(commitContributionsByRepository) {
  const totalsByDate = new Map();
  let hasTruncatedRepoData = false;

  for (const repoEntry of commitContributionsByRepository || []) {
    const contributions = repoEntry?.contributions;
    const nodes = contributions?.nodes || [];
    if (contributions?.pageInfo?.hasNextPage) {
      hasTruncatedRepoData = true;
    }

    for (const node of nodes) {
      const date = dateFromIso(node?.occurredAt);
      const count = Number(node?.commitCount || 0);
      if (!date || count <= 0) {
        continue;
      }
      totalsByDate.set(date, (totalsByDate.get(date) || 0) + count);
    }
  }

  const commitDays = Array.from(totalsByDate.entries())
    .map(([date, commitCount]) => ({ date, commitCount }))
    .sort((a, b) => {
      if (b.commitCount !== a.commitCount) {
        return b.commitCount - a.commitCount;
      }
      return a.date.localeCompare(b.date);
    });

  return { commitDays, hasTruncatedRepoData };
}

async function fetchContributions({ token, username }) {
  const query = `
    query Contributions($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
                color
                weekday
              }
            }
          }
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          commitContributionsByRepository(maxRepositories: 100) {
            contributions(first: 100) {
              nodes {
                commitCount
                occurredAt
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      }
      rateLimit {
        remaining
        resetAt
      }
    }
  `;

  const body = {
    query,
    variables: {
      login: username,
      from: isoYearAgo(),
      to: isoNow(),
    },
  };

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "oldmill1.github.com-activity-check",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(`GitHub API errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}

async function main() {
  const fileEnv = await loadEnv();
  const token = process.env.GITHUB_TOKEN || fileEnv.GITHUB_TOKEN;
  const username = process.env.GITHUB_USERNAME || fileEnv.GITHUB_USERNAME;

  if (!token || token.includes("replace_with_")) {
    throw new Error("Missing GITHUB_TOKEN in environment or .env");
  }
  if (!username || username.includes("replace_with_")) {
    throw new Error("Missing GITHUB_USERNAME in environment or .env");
  }

  const data = await fetchContributions({ token, username });
  const collection = data.user?.contributionsCollection;
  if (!collection) {
    throw new Error("No contributionsCollection returned for this user.");
  }

  const { commitDays, hasTruncatedRepoData } = buildCommitDays(
    collection.commitContributionsByRepository
  );

  const output = {
    fetchedAt: new Date().toISOString(),
    username,
    totals: {
      totalContributions: collection.contributionCalendar.totalContributions,
      commits: collection.totalCommitContributions,
      issues: collection.totalIssueContributions,
      pullRequests: collection.totalPullRequestContributions,
      reviews: collection.totalPullRequestReviewContributions,
    },
    calendar: collection.contributionCalendar,
    commitDays,
    commitDaysMayBeTruncated: hasTruncatedRepoData,
    rateLimit: data.rateLimit,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log(`Saved contribution data to ${OUTPUT_PATH}`);
  console.log(`User: ${username}`);
  console.log(`Total contributions: ${output.totals.totalContributions}`);
  if (output.commitDaysMayBeTruncated) {
    console.warn(
      "Commit day data may be truncated because one or more repositories returned more than 100 contribution-day nodes."
    );
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
