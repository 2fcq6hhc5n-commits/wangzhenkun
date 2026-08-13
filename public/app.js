const STATUS_FALLBACK = ["未投递", "已投递", "笔试中", "面试中", "已拿Offer", "暂不投递"];

const state = {
  jobs: [],
  companies: [],
  applications: [],
  versions: [],
  status: null,
  viewJobs: null,
  viewVersion: null,
  view: "jobs",
  source: "all",
  search: "",
  city: "all",
  page: 1,
  pageSize: 20,
  trackingStatus: "all",
  auto: true,
  timer: null,
};

const els = {
  subtitle: document.getElementById("subtitle"),
  statJobs: document.getElementById("statJobs"),
  statSchool: document.getElementById("statSchool"),
  statIntern: document.getElementById("statIntern"),
  statFulltime: document.getElementById("statFulltime"),
  statUpdated: document.getElementById("statUpdated"),
  statVersion: document.getElementById("statVersion"),
  sourceTabs: document.getElementById("sourceTabs"),
  searchInput: document.getElementById("searchInput"),
  citySelect: document.getElementById("citySelect"),
  latestBtn: document.getElementById("latestBtn"),
  tableTitle: document.getElementById("tableTitle"),
  tableCount: document.getElementById("tableCount"),
  jobRows: document.getElementById("jobRows"),
  pageInfo: document.getElementById("pageInfo"),
  prevPage: document.getElementById("prevPage"),
  nextPage: document.getElementById("nextPage"),
  versionList: document.getElementById("versionList"),
  refreshBtn: document.getElementById("refreshBtn"),
  autoToggle: document.getElementById("autoToggle"),
  viewTabs: document.getElementById("viewTabs"),
  jobsPanel: document.getElementById("jobsPanel"),
  companiesPanel: document.getElementById("companiesPanel"),
  trackingPanel: document.getElementById("trackingPanel"),
  companyCount: document.getElementById("companyCount"),
  companyRows: document.getElementById("companyRows"),
  trackingSummary: document.getElementById("trackingSummary"),
  trackingCount: document.getElementById("trackingCount"),
  trackingFilters: document.getElementById("trackingFilters"),
  trackingRows: document.getElementById("trackingRows"),
  companyModal: document.getElementById("companyModal"),
  companyModalBody: document.getElementById("companyModalBody"),
  toast: document.getElementById("toast"),
};

async function api(path, options = {}) {
  const retries = 3;
  const canRetry = !options.method || options.method === "GET";
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(path, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `请求失败 ${res.status}`);
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !canRetry) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtTime(ts) {
  if (!ts) return "-";
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtIso(iso) {
  if (!iso) return "--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return fmtTime(date.getTime());
}

function toast(message, type = "info") {
  els.toast.textContent = message;
  els.toast.className = `toast show${type === "error" ? " error" : ""}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    els.toast.className = "toast";
  }, 3200);
}

function refreshIcons() {
  if (window.lucide) {
    lucide.createIcons();
  }
}

function getStatuses() {
  return state.status?.statuses || STATUS_FALLBACK;
}

function getAppMap() {
  return Object.fromEntries(state.applications.map((item) => [item.company_id, item]));
}

function statusBadge(status) {
  const safe = escapeHtml(status || "未投递");
  return `<span class="status-badge status-${escapeHtml(status || "未投递")}">${safe}</span>`;
}

function companyAvatar(company, sizeClass = "") {
  const name = company.company_name || "-";
  const first = escapeHtml(String(name).trim().slice(0, 1) || "公");
  if (company.company_logo) {
    return `<span class="company-avatar ${sizeClass}"><img src="${escapeHtml(company.company_logo)}" alt="" loading="lazy"></span>`;
  }
  return `<span class="company-avatar ${sizeClass}">${first}</span>`;
}

async function loadAll() {
  try {
    const [statusData, jobsData, versionsData, companiesData, appsData] = await Promise.all([
      api("/api/status"),
      api("/api/jobs"),
      api("/api/versions"),
      api("/api/companies"),
      api("/api/applications"),
    ]);
    state.status = statusData.status;
    state.jobs = jobsData.jobs || [];
    state.versions = versionsData.versions || [];
    state.companies = companiesData.companies || [];
    state.applications = appsData.applications || [];
    state.viewJobs = null;
    state.viewVersion = null;
    render();
  } catch (error) {
    toast(error.message, "error");
    els.subtitle.textContent = "数据连接异常";
  }
}

function getBaseJobs() {
  return state.viewJobs !== null ? state.viewJobs : state.jobs;
}

function filteredJobs() {
  let jobs = getBaseJobs();
  if (state.source !== "all") {
    jobs = jobs.filter((job) => job.source === state.source);
  }
  if (state.city !== "all") {
    jobs = jobs.filter((job) => (job.city || "").includes(state.city));
  }
  if (state.search.trim()) {
    const keyword = state.search.trim().toLowerCase();
    jobs = jobs.filter((job) => {
      const haystack = [
        job.job_name,
        job.company_name,
        job.company_industry,
        job.tags?.join(" "),
        job.requirement,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }
  return jobs;
}

function filteredCompanies() {
  let companies = state.companies;
  if (state.search.trim()) {
    const keyword = state.search.trim().toLowerCase();
    companies = companies.filter((company) => {
      const haystack = [
        company.company_name,
        company.industry,
        company.scale,
        company.financing,
        company.address,
        (company.cities || []).join(" "),
        (company.source_labels || []).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }
  if (state.city !== "all") {
    companies = companies.filter((company) => (company.cities || []).includes(state.city));
  }
  return companies;
}

function filteredApplications() {
  let applications = state.applications;
  if (state.trackingStatus !== "all") {
    applications = applications.filter((item) => item.status === state.trackingStatus);
  }
  if (state.search.trim()) {
    const keyword = state.search.trim().toLowerCase();
    applications = applications.filter((item) => {
      return [item.company_name, item.note, item.status].join(" ").toLowerCase().includes(keyword);
    });
  }
  return applications;
}

function renderStats() {
  const status = state.status || {};
  const jobs = state.jobs || [];
  els.statJobs.textContent = jobs.length;
  els.statSchool.textContent = jobs.filter((job) => job.source === "school").length;
  els.statIntern.textContent = jobs.filter((job) => job.source === "intern").length;
  els.statFulltime.textContent = jobs.filter((job) => job.source === "fulltime").length;
  els.statUpdated.textContent = fmtIso(status.last_crawled_at);
  els.statVersion.textContent = status.last_version || "--";
  els.subtitle.textContent = status.is_crawling
    ? "正在抓取数据…"
    : `上次抓取 ${fmtIso(status.last_crawled_at)}`;
}

function renderCityOptions(jobs) {
  const cities = new Set();
  jobs.forEach((job) => {
    String(job.city || "")
      .split("/")
      .filter(Boolean)
      .forEach((city) => cities.add(city));
  });
  const sorted = Array.from(cities).sort((a, b) => a.localeCompare(b, "zh-CN"));
  const current = state.city;
  els.citySelect.innerHTML =
    '<option value="all">全部城市</option>' +
    sorted.map((city) => `<option value="${escapeHtml(city)}">${escapeHtml(city)}</option>`).join("");
  els.citySelect.value = sorted.includes(current) ? current : "all";
  if (!sorted.includes(current)) state.city = "all";
}

function changeLabel(change) {
  if (change === "new") return { text: "新增", cls: "new" };
  if (change === "updated") return { text: "更新", cls: "updated" };
  if (change === "removed") return { text: "下架", cls: "removed" };
  return { text: "在库", cls: "plain" };
}

function renderTable() {
  const jobs = filteredJobs();
  const totalPages = Math.max(1, Math.ceil(jobs.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * state.pageSize;
  const pageJobs = jobs.slice(start, start + state.pageSize);
  const appMap = getAppMap();
  const statusOptions = getStatuses()
    .map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`)
    .join("");

  els.tableTitle.textContent = state.viewVersion ? `版本快照 · ${state.viewVersion}` : "职位列表";
  els.tableCount.textContent = `${jobs.length} 条`;
  els.pageInfo.textContent = `第 ${state.page} / ${totalPages} 页 · 共 ${jobs.length} 条`;
  els.prevPage.disabled = state.page <= 1;
  els.nextPage.disabled = state.page >= totalPages;

  if (!pageJobs.length) {
    els.jobRows.innerHTML = '<tr class="empty-row"><td colspan="11">当前筛选条件下暂无职位</td></tr>';
    refreshIcons();
    return;
  }

  els.jobRows.innerHTML = pageJobs
    .map((job) => {
      const badge = changeLabel(job.change);
      const tags = (job.tags || [])
        .slice(0, 3)
        .map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`)
        .join("");
      const companyId = job.company_id || `name:${job.company_name}`;
      const application = appMap[companyId] || { status: "未投递", note: "" };
      const selectedOptions = statusOptions.replace(
        new RegExp(`<option value="${escapeHtml(application.status)}"`),
        `<option value="${escapeHtml(application.status)}" selected`
      );
      return `
        <tr class="${job.change === "removed" ? "removed-row" : ""}">
          <td><span class="badge ${badge.cls}">${badge.text}</span></td>
          <td class="job-cell">
            <strong title="${escapeHtml(job.job_name)}">${escapeHtml(job.job_name)}</strong>
            <p title="${escapeHtml(job.requirement)}">${escapeHtml(job.requirement || "暂无简介")}</p>
          </td>
          <td><span class="cell-text" title="${escapeHtml(job.company_name)}">${escapeHtml(job.company_name)}</span></td>
          <td><span class="cell-text">${escapeHtml(job.source_label)}</span></td>
          <td><span class="cell-text" title="${escapeHtml(job.city)}">${escapeHtml(job.city)}</span></td>
          <td><span class="cell-text" title="${escapeHtml(job.salary)}">${escapeHtml(job.salary)}</span></td>
          <td><span class="cell-text" title="${escapeHtml(job.graduate_year)}">${escapeHtml(job.graduate_year)}</span></td>
          <td>${tags || '<span class="cell-text">-</span>'}</td>
          <td><span class="cell-text">${fmtTime(job.updated_ms)}</span></td>
          <td>
            <select class="apply-select" data-company-id="${escapeHtml(companyId)}" data-company-name="${escapeHtml(job.company_name)}">
              ${selectedOptions}
            </select>
          </td>
          <td>
            <a class="detail-link" href="${escapeHtml(job.detail_url)}" target="_blank" rel="noopener">
              查看<i data-lucide="arrow-up-right"></i>
            </a>
          </td>
        </tr>`;
    })
    .join("");
  refreshIcons();
}

function renderCompanies() {
  const companies = filteredCompanies();
  const appMap = getAppMap();
  els.companyCount.textContent = `${companies.length} 家`;

  if (!companies.length) {
    els.companyRows.innerHTML = '<tr class="empty-row"><td colspan="9">暂无匹配的企业</td></tr>';
    refreshIcons();
    return;
  }

  els.companyRows.innerHTML = companies
    .map((company, index) => {
      const application = appMap[company.company_id] || company.application || { status: "未投递" };
      const subtitle = [company.industry, company.scale || company.financing].filter(Boolean).join(" · ");
      const cities = (company.cities || []).slice(0, 3).join(" / ") || "-";
      const types = (company.source_labels || []).join(" / ") || "-";
      return `
        <tr>
          <td>${statusBadge(application.status)}</td>
          <td>
            <button class="company-link" data-open-company-index="${index}" type="button">
              ${companyAvatar(company)}
              <span class="company-cell-text">
                <strong>${escapeHtml(company.company_name)}</strong>
                <small>${escapeHtml(subtitle || "信息待补充")}</small>
              </span>
            </button>
          </td>
          <td><span class="cell-text" title="${escapeHtml(company.industry)}">${escapeHtml(company.industry || "-")}</span></td>
          <td><span class="cell-text" title="${escapeHtml([company.scale, company.financing].filter(Boolean).join(" · "))}">${escapeHtml([company.scale, company.financing].filter(Boolean).join(" · ") || "-")}</span></td>
          <td><span class="cell-text" title="${escapeHtml(cities)}">${escapeHtml(cities)}</span></td>
          <td><span class="cell-text">${escapeHtml(types)}</span></td>
          <td><span class="cell-text">${company.job_count}</span></td>
          <td><span class="cell-text">${fmtTime(company.last_updated_ms)}</span></td>
          <td>
            <button class="btn ghost" data-open-company-index="${index}" type="button">查看</button>
          </td>
        </tr>`;
    })
    .join("");
  refreshIcons();
}

function renderTracking() {
  const applications = filteredApplications();
  const counts = { all: state.applications.length };
  state.applications.forEach((item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
  });
  els.trackingCount.textContent = `${applications.length} 条`;
  els.trackingSummary.innerHTML = getStatuses()
    .map(
      (status) =>
        `<span class="summary-chip">${escapeHtml(status)} <strong>${counts[status] || 0}</strong></span>`
    )
    .join("");
  els.trackingFilters.innerHTML =
    `<button class="filter-chip ${state.trackingStatus === "all" ? "active" : ""}" data-status="all" type="button">全部 ${state.applications.length}</button>` +
    getStatuses()
      .map(
        (status) =>
          `<button class="filter-chip ${state.trackingStatus === status ? "active" : ""}" data-status="${escapeHtml(status)}" type="button">${escapeHtml(status)} ${counts[status] || 0}</button>`
      )
      .join("");

  if (!applications.length) {
    els.trackingRows.innerHTML =
      '<tr class="empty-row"><td colspan="5">暂无投递记录</td></tr>';
    refreshIcons();
    return;
  }

  els.trackingRows.innerHTML = applications
    .map((item) => {
      const companyIndex = state.companies.findIndex((company) => company.company_id === item.company_id);
      const viewButton =
        companyIndex >= 0
          ? `<button class="btn ghost" data-open-company-index="${companyIndex}" type="button">查看</button>`
          : "";
      return `
        <tr>
          <td><span class="cell-text" title="${escapeHtml(item.company_name)}"><strong>${escapeHtml(item.company_name)}</strong></span></td>
          <td>${statusBadge(item.status)}</td>
          <td><span class="note-cell" title="${escapeHtml(item.note)}">${escapeHtml(item.note || "-")}</span></td>
          <td><span class="cell-text">${fmtIso(item.updated_at)}</span></td>
          <td>
            <div class="pager-buttons">
              ${viewButton}
              <button class="btn ghost" data-remove-application="${escapeHtml(item.company_id)}" type="button">删除</button>
            </div>
          </td>
        </tr>`;
    })
    .join("");
  refreshIcons();
}

function renderVersions() {
  if (!state.versions.length) {
    els.versionList.innerHTML = '<div class="empty-state">暂无版本记录</div>';
    return;
  }
  const current = state.status?.last_version;
  els.versionList.innerHTML = state.versions
    .slice()
    .reverse()
    .map((version) => {
      const delta =
        version.added || version.removed
          ? `<span class="delta">+${version.added} · -${version.removed}</span>`
          : '<span class="delta">无变化</span>';
      return `
        <button class="version-item ${version.version === current ? "current" : ""}" data-version="${escapeHtml(version.version)}" type="button">
          <span class="version-head">
            <strong>${escapeHtml(version.version)}</strong>
            <span>${version.job_count} 条</span>
          </span>
          <span class="version-meta">
            <span>${fmtIso(version.created_at)}</span>
            ${delta}
          </span>
        </button>`;
    })
    .join("");
}

async function openVersion(versionId) {
  try {
    const data = await api(`/api/versions/${versionId}`);
    const snapshot = data.snapshot;
    const jobs = [...(snapshot.jobs || [])];
    (snapshot.removed || []).forEach((job) => jobs.push({ ...job, change: "removed" }));
    state.viewJobs = jobs;
    state.viewVersion = versionId;
    state.page = 1;
    els.latestBtn.classList.remove("hidden");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

function returnLatest() {
  state.viewJobs = null;
  state.viewVersion = null;
  state.page = 1;
  els.latestBtn.classList.add("hidden");
  render();
}

function openCompany(index) {
  const company = filteredCompanies()[index];
  if (!company) {
    toast("未找到该公司", "error");
    return;
  }
  const appMap = getAppMap();
  const application = appMap[company.company_id] || company.application || { status: "未投递", note: "" };
  const statusOptions = getStatuses()
    .map(
      (status) =>
        `<option value="${escapeHtml(status)}" ${status === application.status ? "selected" : ""}>${escapeHtml(status)}</option>`
    )
    .join("");
  const jobs = (company.jobs || [])
    .map(
      (job) => `
        <li class="company-job-row">
          <div>
            <strong>${escapeHtml(job.job_name)}</strong>
            <small>${escapeHtml(job.source_label)} · ${escapeHtml(job.city)} · ${escapeHtml(job.salary)}</small>
          </div>
          <a class="detail-link" href="${escapeHtml(job.detail_url)}" target="_blank" rel="noopener">
            查看<i data-lucide="arrow-up-right"></i>
          </a>
        </li>`
    )
    .join("");

  els.companyModalBody.innerHTML = `
    <div class="modal-head">
      ${companyAvatar(company)}
      <div>
        <h2>${escapeHtml(company.company_name)}</h2>
        <p>${escapeHtml([company.industry, company.address].filter(Boolean).join(" · ") || "公司信息待补充")}</p>
      </div>
    </div>
    <div class="company-facts">
      <div class="fact"><span>行业</span><strong>${escapeHtml(company.industry || "-")}</strong></div>
      <div class="fact"><span>规模</span><strong>${escapeHtml(company.scale || "-")}</strong></div>
      <div class="fact"><span>融资</span><strong>${escapeHtml(company.financing || "-")}</strong></div>
      <div class="fact"><span>在招职位</span><strong>${company.job_count}</strong></div>
      <div class="fact"><span>城市</span><strong>${escapeHtml((company.cities || []).join(" / ") || "-")}</strong></div>
      <div class="fact"><span>招聘类型</span><strong>${escapeHtml((company.source_labels || []).join(" / ") || "-")}</strong></div>
      <div class="fact"><span>最近更新</span><strong>${fmtTime(company.last_updated_ms)}</strong></div>
      <div class="fact"><span>办公地点</span><strong title="${escapeHtml(company.address)}">${escapeHtml(company.address || "-")}</strong></div>
    </div>
    <div class="company-jobs">
      <h3>在招职位（${company.job_count}）</h3>
      <ul class="company-job-list">${jobs || '<li class="company-job-row">暂无职位</li>'}</ul>
    </div>
    <div class="tracking-form">
      <select id="modalStatus" aria-label="投递状态">${statusOptions}</select>
      <input id="modalNote" type="text" placeholder="备注" value="${escapeHtml(application.note || "")}">
      <button id="saveCompanyApplication" class="btn primary" type="button">保存投递状态</button>
      <button id="removeCompanyApplication" class="btn ghost" type="button">删除记录</button>
    </div>
  `;
  els.companyModal.classList.remove("hidden");
  refreshIcons();

  document.getElementById("saveCompanyApplication").addEventListener("click", async () => {
    const status = document.getElementById("modalStatus").value;
    const note = document.getElementById("modalNote").value;
    await saveApplication(company, status, note);
  });
  document.getElementById("removeCompanyApplication").addEventListener("click", async () => {
    await removeApplication(company.company_id);
    closeCompanyModal();
  });
}

function closeCompanyModal() {
  els.companyModal.classList.add("hidden");
}

async function saveApplication(company, status, note) {
  try {
    const data = await api("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id: company.company_id,
        company_name: company.company_name,
        status,
        note,
      }),
    });
    const index = state.applications.findIndex((item) => item.company_id === company.company_id);
    if (index >= 0) {
      state.applications[index] = data.application;
    } else {
      state.applications.push(data.application);
    }
    toast(`已保存 ${company.company_name}：${status}`);
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function removeApplication(companyId) {
  try {
    await api("/api/applications/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: companyId }),
    });
    state.applications = state.applications.filter((item) => item.company_id !== companyId);
    toast("已删除投递记录");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

function switchView(view) {
  state.view = view;
  state.page = 1;
  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === view);
  });
  els.sourceTabs.classList.toggle("hidden", view !== "jobs");
  els.citySelect.classList.toggle("hidden", view !== "jobs");
  els.latestBtn.classList.toggle("hidden", view !== "jobs" || !state.viewVersion);
  els.searchInput.placeholder =
    view === "companies" ? "公司 / 行业 / 城市" : view === "tracking" ? "公司 / 备注" : "岗位或公司";
  try {
    const url = new URL(window.location.href);
    if (view === "jobs") {
      url.searchParams.delete("view");
    } else {
      url.searchParams.set("view", view);
    }
    history.replaceState(null, "", url.toString());
  } catch (error) {
    // ignore URL update errors
  }
  render();
}

function render() {
  const baseJobs = getBaseJobs();
  renderStats();
  renderCityOptions(baseJobs);
  renderVersions();
  els.jobsPanel.classList.toggle("hidden", state.view !== "jobs");
  els.companiesPanel.classList.toggle("hidden", state.view !== "companies");
  els.trackingPanel.classList.toggle("hidden", state.view !== "tracking");
  if (state.view === "jobs") {
    renderTable();
  } else if (state.view === "companies") {
    renderCompanies();
  } else {
    renderTracking();
  }
}

async function refreshNow() {
  els.refreshBtn.disabled = true;
  els.refreshBtn.querySelector("span").textContent = "抓取中";
  try {
    await api("/api/refresh", { method: "POST" });
    await loadAll();
    toast("抓取完成，已生成新版本");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.querySelector("span").textContent = "立即刷新";
  }
}

function setAuto(enabled) {
  state.auto = enabled;
  els.autoToggle.classList.toggle("active", enabled);
  els.autoToggle.setAttribute("aria-pressed", String(enabled));
  clearInterval(state.timer);
  if (enabled) {
    state.timer = setInterval(loadAll, 60000);
  }
}

els.viewTabs.addEventListener("click", (event) => {
  const button = event.target.closest(".view-tab");
  if (button) switchView(button.dataset.view);
});

els.sourceTabs.addEventListener("click", (event) => {
  const button = event.target.closest(".tab");
  if (!button) return;
  state.source = button.dataset.source;
  state.page = 1;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
  renderTable();
});

els.searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = els.searchInput.value;
    state.page = 1;
    render();
  }, 250);
});

els.citySelect.addEventListener("change", () => {
  state.city = els.citySelect.value;
  state.page = 1;
  render();
});

els.prevPage.addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    renderTable();
  }
});

els.nextPage.addEventListener("click", () => {
  state.page += 1;
  renderTable();
});

els.latestBtn.addEventListener("click", returnLatest);
els.refreshBtn.addEventListener("click", refreshNow);
els.autoToggle.addEventListener("click", () => setAuto(!state.auto));

els.versionList.addEventListener("click", (event) => {
  const item = event.target.closest(".version-item");
  if (item) openVersion(item.dataset.version);
});

els.companyRows.addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-company-index]");
  if (button) openCompany(Number(button.dataset.openCompanyIndex));
});

els.trackingRows.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-open-company-index]");
  if (viewButton) {
    openCompany(Number(viewButton.dataset.openCompanyIndex));
    return;
  }
  const removeButton = event.target.closest("[data-remove-application]");
  if (removeButton) removeApplication(removeButton.dataset.removeApplication);
});

els.trackingFilters.addEventListener("click", (event) => {
  const button = event.target.closest(".filter-chip");
  if (!button) return;
  state.trackingStatus = button.dataset.status;
  renderTracking();
});

els.jobRows.addEventListener("change", async (event) => {
  const select = event.target.closest(".apply-select");
  if (!select) return;
  const companyId = select.dataset.companyId;
  const companyName = select.dataset.companyName;
  const application = getAppMap()[companyId] || {};
  await saveApplication(
    { company_id: companyId, company_name: companyName },
    select.value,
    application.note || ""
  );
});

document.querySelectorAll("[data-close-modal]").forEach((element) => {
  element.addEventListener("click", closeCompanyModal);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeCompanyModal();
});

let searchTimer = null;
setAuto(true);
const initialView = new URLSearchParams(window.location.search).get("view");
if (["jobs", "companies", "tracking"].includes(initialView)) {
  switchView(initialView);
}
loadAll();
