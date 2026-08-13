const STATUSES = ["未投递", "已投递", "笔试中", "面试中", "已拿Offer", "暂不投递"];

const SOURCES = [
  {
    key: "school",
    label: "校招",
    recruitType: 1,
    url: "https://www.nowcoder.com/jobs/school/jobs",
  },
  {
    key: "intern",
    label: "实习",
    recruitType: 2,
    url: "https://www.nowcoder.com/jobs/intern/center",
  },
  {
    key: "fulltime",
    label: "社招",
    recruitType: 3,
    url: "https://www.nowcoder.com/jobs/fulltime/center",
  },
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const EDU_LEVEL_MAP = {
  0: "不限",
  3000: "大专",
  4000: "本科",
  5000: "本科",
  5001: "硕士",
  5002: "博士",
  6000: "硕士",
};

const memoryStore = new Map();
let status = {
  is_crawling: false,
  last_crawled_at: null,
  next_crawl_at: null,
  last_error: null,
  last_version: null,
};
let crawling = false;

function json(body, code = 200) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function plainText(value) {
  if (!value) return "";
  const text = String(value).replace(/<[^>]+>/g, " ");
  return text.split(/\s+/).join(" ").slice(0, 120);
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function isoNow() {
  return new Date().toISOString();
}

async function readSeed(env, key, request) {
  try {
    if (env?.ASSETS) {
      const res = await env.ASSETS.fetch(new URL(`https://assets.local/seed-data/${key}`));
      if (!res.ok) return undefined;
      return await res.json();
    }
    const url = new URL(`/seed-data/${key}`, request.url);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return undefined;
    return await res.json();
  } catch (error) {
    return undefined;
  }
}

async function readJson(env, key, fallback, request) {
  if (env?.JOBS) {
    const raw = await env.JOBS.get(key, "text");
    if (raw !== null) {
      try {
        return JSON.parse(raw);
      } catch (error) {
        // fall through to seed data
      }
    }
  } else if (memoryStore.has(key)) {
    return memoryStore.get(key);
  }
  const seed = await readSeed(env, key, request);
  return seed === undefined ? fallback : seed;
}

async function writeJson(env, key, value) {
  if (env?.JOBS) {
    await env.JOBS.put(key, JSON.stringify(value));
    return;
  }
  memoryStore.set(key, value);
}

function parseState(html) {
  const marker = "window.__INITIAL_STATE__=";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("未找到页面初始化数据");
  let payload = html.slice(start + marker.length);
  const end = payload.indexOf("</script>");
  if (end >= 0) payload = payload.slice(0, end);
  payload = payload.trim();
  if (payload.endsWith(";")) payload = payload.slice(0, -1).trim();
  return JSON.parse(payload);
}

async function fetchPage(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(20000) });
      const html = await res.text();
      if (!html.includes("window.__INITIAL_STATE__=")) {
        throw new Error("页面返回了验证页或缺少初始化数据");
      }
      return html;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw new Error(`抓取失败: ${lastError}`);
}

function extractJobs(state, sourceKey) {
  if (sourceKey === "school") {
    const app = state.app || {};
    for (const module of Object.values(app)) {
      if (module && Array.isArray(module.jobListData)) return module.jobListData;
    }
    return [];
  }
  const store = state.store || {};
  const key = sourceKey === "intern" ? "interCenter" : "fulltimeCenter";
  return (store[key] && store[key].jobList) || [];
}

function companyName(data) {
  const company = data.recommendInternCompany || {};
  let name = company.companyName || company.companyShortName;
  if (!name) {
    const identities = (data.user && data.user.identity) || [];
    if (identities.length) name = identities[0].companyName;
  }
  return clean(name) || "-";
}

function companyFields(data, name) {
  let company = data.recommendInternCompany || {};
  if (!Object.keys(company).length) {
    const identities = (data.user && data.user.identity) || [];
    if (identities.length) company = { companyId: identities[0].companyId };
  }
  const industries = (company.industryTagNameList || []).map(clean).filter(Boolean);
  return {
    company_id: String(company.companyId || company.tagId || `name:${name}`),
    company_logo: clean(company.picUrl),
    company_industry: industries.join(" / "),
    company_scale: clean(company.personScales),
    company_financing: clean(company.scaleTagName),
    company_address: clean(company.address),
  };
}

function salaryText(data) {
  if (data.salaryShow) return clean(data.salaryShow);
  const salaryType = data.salaryType;
  const salaryMin = data.salaryMin;
  const salaryMax = data.salaryMax;
  if (salaryType === 1 && salaryMin && salaryMax) return `${salaryMin}-${salaryMax} 元/天`;
  if (salaryType === 2 && salaryMin && salaryMax) {
    const month = data.salaryMonth;
    return `${salaryMin}-${salaryMax}k${month ? `路${month}薪` : ""}`;
  }
  if (salaryType === 3 && salaryMin && salaryMax) return `${salaryMin}-${salaryMax} 元/小时`;
  return "-";
}

function requirement(data) {
  try {
    const ext = typeof data.ext === "string" ? JSON.parse(data.ext || "{}") : data.ext || {};
    return clean(ext.requirements).split(/\s+/).join(" ").slice(0, 120);
  } catch (error) {
    return "";
  }
}

function normalizeExternal(data, source) {
  const id = data.id ?? data.entityId;
  const extra = data.extraInfo || {};
  const city = clean(data.city) || clean(extra.jobCity_var);
  const tags = (data.skills || []).map(clean).filter(Boolean);
  const pcTags = data.pcTagInfo || {};
  for (const tagInfo of pcTags.jobInfoTagList || []) {
    const tag = tagInfo.tag && tagInfo.tag.title;
    if (tag) tags.push(clean(tag));
  }
  return {
    key: `${source.recruitType}:${id}`,
    id,
    source: source.key,
    source_label: source.label,
    recruit_type: source.recruitType,
    job_name: clean(data.jobTitle) || "-",
    company_name: clean(data.companyName) || "-",
    city: city || "-",
    salary: clean(data.salary) || "-",
    education: clean(data.education) || "不限",
    graduate_year: "",
    tags,
    requirement: plainText(data.description),
    updated_ms: Number(data.updateTime || 0),
    publish_ms: Number(data.createTime || 0),
    detail_url: clean(data.router) || `https://www.nowcoder.com/jobs/detail/${id}`,
    company_id: String(data.companyId || `name:${data.companyName}`),
    company_logo: clean(data.companyLogo),
    company_industry: clean(data.industry),
    company_scale: clean(data.scale),
    company_financing: clean(data.financing),
    company_address: "",
    change: "unchanged",
  };
}

function normalizeJob(raw, source) {
  const data = raw.data && typeof raw.data === "object" ? raw.data : raw;
  if (data.jobTitle && data.companyName) return normalizeExternal(data, source);

  const id = data.id ?? raw.id;
  const cities = data.jobCityList || (data.jobCity ? [data.jobCity] : []);
  const tags = clean(data.jobKeys)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const updatedMs = data.refreshTime || data.updateTime || 0;
  const eduLevel = data.eduLevel;
  const name = companyName(data);
  return {
    key: `${source.recruitType}:${id}`,
    id,
    source: source.key,
    source_label: source.label,
    recruit_type: source.recruitType,
    job_name: clean(data.jobName) || "-",
    company_name: name,
    city: cities.map(clean).join("/") || "-",
    salary: salaryText(data),
    education: EDU_LEVEL_MAP[eduLevel] || (eduLevel ? "其他" : "不限"),
    graduate_year: clean(data.graduationYear) || "-",
    tags,
    requirement: requirement(data),
    updated_ms: Number(updatedMs || 0),
    publish_ms: Number(data.createTime || 0),
    detail_url: `https://www.nowcoder.com/jobs/detail/${id}`,
    ...companyFields(data, name),
    change: "unchanged",
  };
}

function diffJobs(newJobs, oldJobs) {
  const oldMap = new Map(oldJobs.map((job) => [job.key, job]));
  const newMap = new Map(newJobs.map((job) => [job.key, job]));
  const addedKeys = [...newMap.keys()].filter((key) => !oldMap.has(key));
  const removedKeys = [...oldMap.keys()].filter((key) => !newMap.has(key));
  const updatedKeys = [...newMap.keys()].filter(
    (key) => oldMap.has(key) && newMap.get(key).updated_ms !== oldMap.get(key).updated_ms
  );
  for (const job of newJobs) {
    if (addedKeys.includes(job.key)) job.change = "new";
    else if (updatedKeys.includes(job.key)) job.change = "updated";
  }
  return {
    added: addedKeys.length,
    removedCount: removedKeys.length,
    updated: updatedKeys.length,
    removedJobs: removedKeys.sort().map((key) => oldMap.get(key)),
  };
}

export async function crawlNow(env, request) {
  if (crawling) return null;
  crawling = true;
  status = { ...status, is_crawling: true, last_error: null };
  try {
    const allJobs = [];
    const sourceStatus = {};
    for (const source of SOURCES) {
      try {
        const html = await fetchPage(source.url);
        const state = parseState(html);
        const rawJobs = extractJobs(state, source.key);
        const jobs = rawJobs.map((item) => normalizeJob(item, source));
        allJobs.push(...jobs);
        sourceStatus[source.key] = { ok: true, count: jobs.length, label: source.label };
      } catch (error) {
        sourceStatus[source.key] = {
          ok: false,
          count: 0,
          error: String(error),
          label: source.label,
        };
      }
    }
    if (!allJobs.length) throw new Error("所有数据源都未返回职位");
    allJobs.sort((a, b) => (b.updated_ms || 0) - (a.updated_ms || 0));

    const latest = (await readJson(env, "latest.json", {}, request)) || {};
    const oldJobs = Array.isArray(latest.jobs) ? latest.jobs : [];
    const versionsIndex = (await readJson(env, "versions/index.json", { versions: [] }, request)) || {
      versions: [],
    };
    const versionNo = (versionsIndex.versions || []).length + 1;
    const versionId = `v${String(versionNo).padStart(4, "0")}`;
    const createdAt = isoNow();
    const diff = diffJobs(allJobs, oldJobs);
    const version = {
      version: versionId,
      created_at: createdAt,
      job_count: allJobs.length,
      added: diff.added,
      removed: diff.removedCount,
      updated: diff.updated,
      sources: sourceStatus,
    };
    const snapshot = { ...version, jobs: allJobs, removed: diff.removedJobs };

    await writeJson(env, `versions/${versionId}.json`, snapshot);
    versionsIndex.versions = versionsIndex.versions || [];
    versionsIndex.versions.push(version);
    await writeJson(env, "versions/index.json", versionsIndex);
    await writeJson(env, "latest.json", {
      version: versionId,
      created_at: createdAt,
      jobs: allJobs,
      meta: { sources: sourceStatus },
    });

    status = {
      is_crawling: false,
      last_crawled_at: createdAt,
      next_crawl_at: null,
      last_error: null,
      last_version: versionId,
    };
    crawling = false;
    return version;
  } catch (error) {
    status = {
      ...status,
      is_crawling: false,
      last_error: String(error),
    };
    crawling = false;
    throw error;
  }
}

function buildCompanies(env, request) {
  return readJson(env, "latest.json", {}, request).then(async (latest) => {
    const jobs = Array.isArray(latest.jobs) ? latest.jobs : [];
    const applications = (await readJson(env, "applications.json", { applications: [] }, request))
      .applications || [];
    const appMap = new Map(applications.map((item) => [item.company_id, item]));
    const groups = new Map();

    for (const job of jobs) {
      const companyId = String(job.company_id || `name:${job.company_name || ""}`);
      let group = groups.get(companyId);
      if (!group) {
        group = {
          company_id: companyId,
          company_name: job.company_name || "-",
          company_logo: "",
          industries: [],
          scales: [],
          financings: [],
          addresses: [],
          cities: new Set(),
          sourceLabels: new Set(),
          updatedMs: 0,
          jobs: [],
        };
        groups.set(companyId, group);
      }
      group.company_logo = group.company_logo || job.company_logo || "";
      group.industries.push(job.company_industry || "");
      group.scales.push(job.company_scale || "");
      group.financings.push(job.company_financing || "");
      group.addresses.push(job.company_address || "");
      if (job.city && job.city !== "-") {
        for (const part of String(job.city).split("/")) {
          if (part) group.cities.add(part);
        }
      }
      if (job.source_label) group.sourceLabels.add(job.source_label);
      group.updatedMs = Math.max(group.updatedMs, Number(job.updated_ms || 0));
      group.jobs.push({
        id: job.id,
        key: job.key,
        job_name: job.job_name,
        city: job.city,
        salary: job.salary,
        source_label: job.source_label,
        detail_url: job.detail_url,
      });
    }

    const companies = [];
    for (const group of groups.values()) {
      const application = appMap.get(group.company_id) || {
        company_id: group.company_id,
        company_name: group.company_name,
        status: "未投递",
        note: "",
      };
      companies.push({
        company_id: group.company_id,
        company_name: group.company_name,
        company_logo: group.company_logo,
        industry: mostCommon(group.industries),
        scale: mostCommon(group.scales),
        financing: mostCommon(group.financings),
        address: mostCommon(group.addresses),
        cities: [...group.cities].sort(),
        source_labels: [...group.sourceLabels].filter(Boolean).sort(),
        job_count: group.jobs.length,
        last_updated_ms: group.updatedMs,
        jobs: group.jobs.sort((a, b) => Number(a.id || 0) - Number(b.id || 0)),
        application,
      });
    }
    companies.sort((a, b) => b.job_count - a.job_count || a.company_name.localeCompare(b.company_name));
    return companies;
  });
}

async function listApplications(env, request) {
  const data = await readJson(env, "applications.json", { applications: [] }, request);
  return Array.isArray(data.applications) ? data.applications : [];
}

async function saveApplication(env, request, payload) {
  const companyId = clean(payload.company_id);
  const companyName = clean(payload.company_name);
  const applicationStatus = clean(payload.status || "未投递");
  const note = clean(payload.note);
  if (!companyId || !companyName) throw new Error("company_id 和 company_name 不能为空");
  if (!STATUSES.includes(applicationStatus)) {
    throw new Error(`不支持的投递状态: ${applicationStatus}`);
  }
  const updatedAt = isoNow();
  const applications = await listApplications(env, request);
  let item = applications.find((app) => app.company_id === companyId);
  if (item) {
    item.company_name = companyName;
    item.status = applicationStatus;
    item.note = note;
    item.updated_at = updatedAt;
  } else {
    item = {
      company_id: companyId,
      company_name: companyName,
      status: applicationStatus,
      note,
      created_at: updatedAt,
      updated_at: updatedAt,
    };
    applications.push(item);
  }
  await writeJson(env, "applications.json", { applications });
  return item;
}

async function removeApplication(env, request, payload) {
  const companyId = clean(payload.company_id);
  const applications = await listApplications(env, request);
  const remaining = applications.filter((app) => app.company_id !== companyId);
  await writeJson(env, "applications.json", { applications: remaining });
  return applications.length !== remaining.length;
}

async function getVersion(env, request, versionId) {
  return readJson(env, `versions/${versionId}.json`, null, request);
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) return null;

  try {
    if (request.method === "GET" && path === "/api/status") {
      return json({ ok: true, status, statuses: STATUSES });
    }
    if (request.method === "GET" && path === "/api/jobs") {
      const current = await readJson(env, "latest.json", {}, request);
      return json({ ok: true, ...current });
    }
    if (request.method === "GET" && path === "/api/companies") {
      const companies = await buildCompanies(env, request);
      return json({ ok: true, companies });
    }
    if (request.method === "GET" && path === "/api/applications") {
      return json({ ok: true, applications: await listApplications(env, request) });
    }
    if (request.method === "GET" && path === "/api/versions") {
      const data = await readJson(env, "versions/index.json", { versions: [] }, request);
      return json({ ok: true, versions: data.versions || [] });
    }
    const versionMatch = path.match(/^\/api\/versions\/([^/]+)$/);
    if (request.method === "GET" && versionMatch) {
      const snapshot = await getVersion(env, request, versionMatch[1]);
      if (!snapshot) return json({ ok: false, error: "version not found" }, 404);
      return json({ ok: true, snapshot });
    }
    if (request.method === "POST" && path === "/api/refresh") {
      if (status.is_crawling) return json({ ok: false, error: "正在抓取中" }, 409);
      const version = await crawlNow(env, request);
      return json({ ok: true, version });
    }
    if (request.method === "GET" && path === "/api/cron/refresh") {
      const secret = env?.CRON_SECRET;
      if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
        return json({ ok: false, error: "invalid cron secret" }, 403);
      }
      if (status.is_crawling) return json({ ok: false, error: "正在抓取中" }, 409);
      const version = await crawlNow(env, request);
      return json({ ok: true, version });
    }
    if (request.method === "POST" && path === "/api/applications") {
      const payload = await request.json().catch(() => ({}));
      try {
        const item = await saveApplication(env, request, payload);
        return json({ ok: true, application: item });
      } catch (error) {
        return json({ ok: false, error: String(error) }, 400);
      }
    }
    if (request.method === "POST" && path === "/api/applications/remove") {
      const payload = await request.json().catch(() => ({}));
      const removed = await removeApplication(env, request, payload);
      return json({ ok: true, removed });
    }
    return json({ ok: false, error: "not found" }, 404);
  } catch (error) {
    return json({ ok: false, error: String(error) }, 500);
  }
}
