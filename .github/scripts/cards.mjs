/**
 * Generates the profile stat cards as SVGs, in the terminal-green theme.
 *
 * Why this exists: the public github-readme-stats instance goes down (it was
 * returning DEPLOYMENT_PAUSED when this profile went live), and every hosted
 * card service is a single point of failure on someone else's free tier.
 * These are rendered here and committed, so they cannot break.
 *
 * Auth: uses GH_STATS_TOKEN (a PAT with `repo` scope) when present so private
 * repos count toward the language mix; falls back to GITHUB_TOKEN, which only
 * sees public repos.
 */

import { writeFileSync, mkdirSync } from "node:fs";

const LOGIN = process.env.LOGIN;
const TOKEN = process.env.GH_STATS_TOKEN || process.env.GITHUB_TOKEN;
const OUT   = "dist";

const T = {
  bg:     "#0D1117",
  border: "#16241F",
  accent: "#00FF9C",
  text:   "#C9F7E3",
  dim:    "#4E7C6A",
  faint:  "#1B2E28",
  mag:    "#FF7BD5"
};
const FONT = "ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,Liberation Mono,monospace";

async function gql(query, variables) {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-cards"
    },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/* ---------------------------------------------------------------- data --- */

async function collect() {
  const data = await gql(`
    query($login:String!){
      user(login:$login){
        login
        followers{ totalCount }
        repositories(first:100, ownerAffiliations:OWNER, isFork:false,
                     orderBy:{field:UPDATED_AT, direction:DESC}){
          totalCount
          nodes{
            isPrivate
            stargazerCount
            languages(first:12, orderBy:{field:SIZE, direction:DESC}){
              edges{ size node{ name color } }
            }
          }
        }
        pullRequests{ totalCount }
        issues{ totalCount }
        contributionsCollection{
          totalCommitContributions
          totalPullRequestReviewContributions
          contributionCalendar{
            totalContributions
            weeks{ contributionDays{ date contributionCount } }
          }
        }
      }
    }`, { login: LOGIN });

  const u = data.user;
  const repos = u.repositories.nodes;

  // Language mix, normalised PER REPO rather than by raw byte totals. Summing
  // bytes lets a single repo full of build output drown everything else — the
  // first run of this scored LLVM at 76% off one MAUI project's artifacts.
  // Averaging each repo's own share answers the more useful question: what does
  // this person actually work in?
  const IGNORED = new Set(["LLVM", "Assembly", "Batchfile", "Makefile", "CMake", "Objective-C++"]);

  const langs = new Map();
  let counted = 0;
  for (const r of repos) {
    const edges = r.languages.edges.filter(e => !IGNORED.has(e.node.name));
    const repoTotal = edges.reduce((a, e) => a + e.size, 0);
    if (!repoTotal) continue;
    counted++;
    for (const e of edges) {
      const cur = langs.get(e.node.name) || { share: 0, color: e.node.color };
      cur.share += e.size / repoTotal;   // this repo contributes at most 1.0
      langs.set(e.node.name, cur);
    }
  }
  const denom = counted || 1;
  const top = [...langs.entries()]
    .sort((a, b) => b[1].share - a[1].share)
    .slice(0, 6)
    .map(([name, v]) => ({ name, pct: (v.share / denom) * 100, color: v.color || T.accent }));

  // rescale so the visible slice fills the bar
  const shown = top.reduce((a, l) => a + l.pct, 0) || 1;
  top.forEach(l => { l.pct = (l.pct / shown) * 100; });

  // streaks from the contribution calendar
  const days = u.contributionsCollection.contributionCalendar.weeks
    .flatMap(w => w.contributionDays)
    .filter(d => d.date <= new Date().toISOString().slice(0, 10));

  let cur = 0, best = 0, run = 0;
  for (const d of days) {
    if (d.contributionCount > 0) { run++; best = Math.max(best, run); }
    else run = 0;
  }
  // current streak: walk backwards, tolerating an empty today
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) cur++;
    else if (!(i === days.length - 1)) break;
  }

  return {
    login: u.login,
    followers: u.followers.totalCount,
    repos: u.repositories.totalCount,
    privateSeen: repos.some(r => r.isPrivate),
    stars: repos.reduce((a, r) => a + r.stargazerCount, 0),
    commits: u.contributionsCollection.totalCommitContributions,
    prs: u.pullRequests.totalCount,
    issues: u.issues.totalCount,
    reviews: u.contributionsCollection.totalPullRequestReviewContributions,
    contributions: u.contributionsCollection.contributionCalendar.totalContributions,
    streak: cur,
    best,
    top
  };
}

/* --------------------------------------------------------------- render --- */

const shell = (w, h, title, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<style>
  .f{font-family:${FONT}}
  .t{fill:${T.accent};font-size:13px;font-weight:700}
  .k{fill:${T.dim};font-size:12px}
  .v{fill:${T.text};font-size:12px;font-weight:700}
  .s{fill:${T.dim};font-size:10px}
  .row{opacity:0;animation:in .45s ease forwards}
  @keyframes in{to{opacity:1}}
  @media (prefers-reduced-motion:reduce){.row{animation:none;opacity:1}}
</style>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="8" fill="${T.bg}" stroke="${T.border}"/>
<g class="f">
  <circle cx="18" cy="19" r="4" fill="${T.accent}"/>
  <text x="30" y="23" class="t">${esc(title)}</text>
  ${body}
</g>
</svg>`;

function statsCard(d) {
  const rows = [
    ["Total Stars",       d.stars],
    ["Total Commits",     d.commits],
    ["Total PRs",         d.prs],
    ["Total Issues",      d.issues],
    ["Code Reviews",      d.reviews],
    ["Repositories",      d.repos],
    ["Followers",         d.followers]
  ];
  const body = rows.map(([k, v], i) => `
    <g class="row" style="animation-delay:${i * 70}ms">
      <text x="30"  y="${52 + i * 21}" class="k">${esc(k)}</text>
      <text x="270" y="${52 + i * 21}" class="v" text-anchor="end">${v}</text>
    </g>`).join("");
  return shell(300, 210, `${d.login}@github`, body);
}

function langCard(d) {
  const W = 300, x0 = 30, barW = W - 60;
  let acc = 0;
  const seg = d.top.map(l => {
    const w = (l.pct / 100) * barW;
    const r = `<rect x="${(x0 + acc).toFixed(1)}" y="46" width="${Math.max(w, 1).toFixed(1)}" height="9" fill="${l.color}"/>`;
    acc += w;
    return r;
  }).join("");

  const list = d.top.map((l, i) => `
    <g class="row" style="animation-delay:${i * 70}ms">
      <circle cx="${x0 + 4}" cy="${79 + i * 20}" r="4" fill="${l.color}"/>
      <text x="${x0 + 16}" y="${83 + i * 20}" class="k">${esc(l.name)}</text>
      <text x="${W - 30}" y="${83 + i * 20}" class="v" text-anchor="end">${l.pct.toFixed(1)}%</text>
    </g>`).join("");

  const note = d.privateSeen ? "" :
    `<text x="${x0}" y="${79 + d.top.length * 20 + 10}" class="s">public repos only</text>`;

  return shell(W, 210, "language mix", `
    <rect x="${x0}" y="46" width="${barW}" height="9" rx="4.5" fill="${T.faint}"/>
    <g>${seg}</g>${list}${note}`);
}

function streakCard(d) {
  const cells = [
    ["contributions", d.contributions, "past year"],
    ["current streak", d.streak, d.streak === 1 ? "day" : "days"],
    ["longest streak", d.best, d.best === 1 ? "day" : "days"]
  ];
  const W = 470, col = W / 3;
  const body = cells.map(([k, v, sub], i) => `
    <g class="row" style="animation-delay:${i * 90}ms">
      <text x="${col * i + col / 2}" y="80"  text-anchor="middle"
            style="fill:${T.accent};font-size:30px;font-weight:700">${v}</text>
      <text x="${col * i + col / 2}" y="102" text-anchor="middle" class="k">${esc(k)}</text>
      <text x="${col * i + col / 2}" y="119" text-anchor="middle" class="s">${esc(sub)}</text>
      ${i ? `<line x1="${col * i}" y1="46" x2="${col * i}" y2="126" stroke="${T.border}"/>` : ""}
    </g>`).join("");
  return shell(W, 145, "contribution activity", body);
}

/* ----------------------------------------------------------------- main --- */

const d = await collect();
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/stats.svg`,  statsCard(d));
writeFileSync(`${OUT}/langs.svg`,  langCard(d));
writeFileSync(`${OUT}/streak.svg`, streakCard(d));

console.log("generated cards for", d.login);
console.log("  private repos visible:", d.privateSeen, d.privateSeen ? "" : "(add GH_STATS_TOKEN to include them)");
console.log("  languages:", d.top.map(l => `${l.name} ${l.pct.toFixed(1)}%`).join(", "));
console.log("  contributions:", d.contributions, "| streak:", d.streak, "| best:", d.best);
