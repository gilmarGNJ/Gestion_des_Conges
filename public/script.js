import {
  TYPE_META,
  buildDayMap,
  businessDatesBetween,
  calculateYearSummary,
  clone,
  findPersonalDateConflicts,
  formatDays,
  formatFrenchDate,
  isWeekend,
  isValidAbsenceRequest,
  isWithinContract,
  migrateLegacyHolidayData,
  normalizeState,
  parseIsoDate,
  toIsoDate,
  typeLabel,
  validateImport
} from "./logic.js?v=20260715n";

const STORAGE_KEY = "gestionCongesStateV2";
const LEGACY_STORAGE_KEY = "holidayData";
const CLOUD_DIRTY_KEY = `${STORAGE_KEY}:cloudDirty`;
const SEED_URL = "./data/seed-data.json";

const elements = {
  notices: document.querySelector("#notices"),
  summaryCards: document.querySelector("#summary-cards"),
  summaryTable: document.querySelector("#summary-table-container"),
  legend: document.querySelector("#legend"),
  calendar: document.querySelector("#calendar"),
  yearSelect: document.querySelector("#year-select"),
  prevYear: document.querySelector("#prev-year"),
  nextYear: document.querySelector("#next-year"),
  requestsTable: document.querySelector("#requests-table-container"),
  requestYearFilter: document.querySelector("#request-year-filter"),
  requestTypeFilter: document.querySelector("#request-type-filter"),
  addRequest: document.querySelector("#add-request-button"),
  editRights: document.querySelector("#edit-rights-button"),
  exportData: document.querySelector("#export-data"),
  importData: document.querySelector("#import-data-input"),
  resetData: document.querySelector("#reset-data"),
  sourcesList: document.querySelector("#sources-list"),
  syncStatus: document.querySelector("#sync-status"),
  syncStatusText: document.querySelector("#sync-status-text"),
  syncButton: document.querySelector("#sync-button"),
  signOutButton: document.querySelector("#sign-out-button"),
  signOutDialog: document.querySelector("#sign-out-dialog"),
  signOutForm: document.querySelector("#sign-out-form"),
  confirmSignOutButton: document.querySelector("#confirm-sign-out-button"),
  syncConflictDialog: document.querySelector("#sync-conflict-dialog"),
  syncConflictForm: document.querySelector("#sync-conflict-form"),
  dayDialog: document.querySelector("#day-dialog"),
  dayForm: document.querySelector("#day-form"),
  dayDialogTitle: document.querySelector("#day-dialog-title"),
  dayDate: document.querySelector("#day-date"),
  requestDialog: document.querySelector("#request-dialog"),
  requestForm: document.querySelector("#request-form"),
  requestDate: document.querySelector("#request-date"),
  requestType: document.querySelector("#request-type"),
  requestFirstDay: document.querySelector("#request-first-day"),
  requestLastDay: document.querySelector("#request-last-day"),
  requestDays: document.querySelector("#request-days"),
  rightsDialog: document.querySelector("#rights-dialog"),
  rightsForm: document.querySelector("#rights-form"),
  rightsYear: document.querySelector("#rights-year"),
  rightsContractStart: document.querySelector("#rights-contract-start"),
  rightsContractEnd: document.querySelector("#rights-contract-end"),
  rightsCp: document.querySelector("#rights-cp"),
  rightsRtt: document.querySelector("#rights-rtt"),
  rightsSolidarity: document.querySelector("#rights-solidarity"),
  toastRegion: document.querySelector("#toast-region")
};

let seedState;
let appState;
let years = [];
let cloudSync = null;
let cloudConfigured = false;
let cloudUser = null;
let isApplyingRemoteState = false;
let isReconcilingConflict = false;
let isSigningOut = false;
let lastKnownRemoteFingerprint = null;
let cloudReconciliationPromise = null;
let conflictResolver = null;
let cloudSessionEpoch = 0;

async function initialize() {
  setSyncStatus("loading", "Chargement…");
  try {
    seedState = await fetchSeedState();
    years = Object.keys(seedState.yearSettings).map(Number).sort((a, b) => a - b);
    appState = loadLocalState(seedState);
    saveLocalState();
    populateStaticControls();
    attachEventListeners();
    renderAll();
    setSyncStatus("local", "Enregistré sur cet appareil");
    await initializeCloudSync();
  } catch (error) {
    console.error(error);
    setSyncStatus("error", "Erreur de chargement");
    showToast(`Impossible de charger le calendrier : ${error.message}`, true, 10000);
  }
}

async function fetchSeedState() {
  const response = await fetch(SEED_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`données initiales indisponibles (${response.status})`);
  const data = await response.json();
  if (data?.version !== 2) throw new Error("format des données initiales invalide");
  return data;
}

function loadLocalState(seed) {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const normalized = normalizeState(seed, JSON.parse(stored));
      if (findPersonalDateConflicts(normalized).length) {
        throw new Error("absences locales superposées");
      }
      return normalized;
    } catch (error) {
      localStorage.setItem(`${STORAGE_KEY}:invalid:${Date.now()}`, stored);
      showToast("La sauvegarde locale était illisible. Une copie a été conservée.", true, 8000);
    }
  }

  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy) {
    try {
      const parsedLegacy = JSON.parse(legacy);
      localStorage.setItem(`${LEGACY_STORAGE_KEY}:backup:${Date.now()}`, legacy);
      const migrated = migrateLegacyHolidayData(seed, parsedLegacy);
      showToast("Les données de l’ancienne version ont été migrées.");
      return migrated;
    } catch (error) {
      localStorage.setItem(`${LEGACY_STORAGE_KEY}:invalid:${Date.now()}`, legacy);
    }
  }

  return clone(seed);
}

function populateStaticControls() {
  const currentYear = new Date().getFullYear();
  const preferredYear = years.includes(currentYear) ? currentYear : years.at(-1);

  for (const year of years) {
    const option = new Option(String(year), String(year));
    elements.yearSelect.add(option);
    elements.requestYearFilter.add(new Option(String(year), String(year)));
    elements.rightsYear.add(new Option(String(year), String(year)));
  }
  elements.yearSelect.value = String(preferredYear);
  elements.rightsYear.value = String(preferredYear);
  elements.requestFirstDay.min = appState.contractStart;
  elements.requestFirstDay.max = appState.contractEnd;
  elements.requestLastDay.min = appState.contractStart;
  elements.requestLastDay.max = appState.contractEnd;
  updateYearNavigationButtons();
}

function attachEventListeners() {
  elements.yearSelect.addEventListener("change", () => {
    updateYearNavigationButtons();
    renderCalendar();
    renderSummary();
  });

  elements.prevYear.addEventListener("click", () => shiftYear(-1));
  elements.nextYear.addEventListener("click", () => shiftYear(1));
  elements.calendar.addEventListener("click", handleCalendarClick);

  elements.requestYearFilter.addEventListener("change", renderRequests);
  elements.requestTypeFilter.addEventListener("change", renderRequests);
  elements.requestsTable.addEventListener("click", handleRequestTableClick);
  elements.addRequest.addEventListener("click", openRequestDialog);
  elements.editRights.addEventListener("click", openRightsDialog);

  elements.dayForm.addEventListener("submit", handleDayFormSubmit);
  elements.requestForm.addEventListener("submit", handleRequestFormSubmit);
  elements.rightsForm.addEventListener("submit", handleRightsFormSubmit);
  elements.rightsYear.addEventListener("change", loadRightsFormValues);
  elements.requestFirstDay.addEventListener("change", updateCalculatedRequestDays);
  elements.requestLastDay.addEventListener("change", updateCalculatedRequestDays);

  document.querySelectorAll(".close-dialog").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog")?.close());
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  elements.exportData.addEventListener("click", exportState);
  elements.importData.addEventListener("change", importState);
  elements.resetData.addEventListener("click", resetState);
  elements.syncButton.addEventListener("click", handleSyncButton);
  elements.signOutButton.addEventListener("click", handleSignOut);
  elements.signOutForm.addEventListener("submit", confirmSignOut);
  elements.syncConflictForm.addEventListener("submit", handleSyncConflictChoice);
  elements.syncConflictDialog.addEventListener("close", () => settleSyncConflict("cancel"));
  window.addEventListener("online", retryCloudSync);
}

function renderAll() {
  renderNotices();
  renderSummary();
  renderLegend();
  renderCalendar();
  renderRequests();
  renderSources();
}

function renderNotices() {
  const notices = [...(appState.notices || [])];
  if (!cloudConfigured) {
    notices.unshift({
      id: "cloud-not-configured",
      text: "La synchronisation multi-appareils est prête, mais le projet Firebase doit encore être relié. Les modifications restent sauvegardées uniquement sur cet appareil pour le moment."
    });
  } else if (!cloudUser) {
    notices.unshift({
      id: "cloud-sign-in",
      text: "Connectez-vous avec Google pour retrouver exactement les mêmes données sur vos autres appareils."
    });
  }
  elements.notices.innerHTML = notices
    .map((notice) => `<div class="notice" data-notice-id="${escapeHtml(notice.id || "notice")}">${escapeHtml(notice.text)}</div>`)
    .join("");
}

function renderSummary() {
  const selectedYear = Number(elements.yearSelect.value);
  // Normalize the values used for display here as a safeguard against an
  // older cached calculation module. CP is deliberately not carried over
  // between years: each year's balance is its own acquired rights minus days
  // taken in that year. The same derived values feed cards, rows and totals.
  const summaries = years.map((year) => {
    const summary = calculateYearSummary(appState, year);
    const cpRemaining = Number(summary.cpAcquired || 0) - Number(summary.cpTaken || 0);
    const rttRemaining = Number(summary.rttAcquired || 0)
      - Number(summary.rttImposed || 0)
      - Number(summary.solidarityDays || 0)
      - Number(summary.rttTaken || 0);
    return {
      ...summary,
      cpRemaining,
      rttRemaining,
      totalRemaining: cpRemaining + rttRemaining
    };
  });
  elements.summaryCards.innerHTML = summaries
    .map((summary) => {
      const currentBadge = summary.year === selectedYear ? "<span>affichée</span>" : "";
      return `
        <article class="summary-card ${summary.year === selectedYear ? "is-current" : ""}">
          <div class="summary-card-year">${summary.year}${currentBadge}</div>
          <div class="balance-pair">
            <div>
              <strong class="balance-value ${summary.cpRemaining < 0 ? "is-negative" : ""}">${formatDays(summary.cpRemaining)}</strong>
              <span class="balance-label">CP restants</span>
            </div>
            <div>
              <strong class="balance-value ${summary.rttRemaining < 0 ? "is-negative" : ""}">${formatDays(summary.rttRemaining)}</strong>
              <span class="balance-label">RTT restants</span>
            </div>
          </div>
        </article>`;
    })
    .join("");

  const rows = summaries
    .map(
      (summary) => `
        <tr>
          <th scope="row">${summary.year}</th>
          <td class="number-cell">${formatDays(summary.cpAcquired)}</td>
          <td class="number-cell">${formatDays(summary.cpTaken)}</td>
          <td class="number-cell remaining-cell ${summary.cpRemaining < 0 ? "negative" : ""}">${formatDays(summary.cpRemaining)}</td>
          <td class="number-cell">${formatDays(summary.rttAcquired)}</td>
          <td class="number-cell">${formatDays(summary.rttImposed)}</td>
          <td class="number-cell">${formatDays(summary.solidarityDays)}</td>
          <td class="number-cell">${formatDays(summary.rttTaken)}</td>
          <td class="number-cell remaining-cell ${summary.rttRemaining < 0 ? "negative" : ""}">${formatDays(summary.rttRemaining)}</td>
          <td class="number-cell remaining-cell ${summary.totalRemaining < 0 ? "negative" : ""}">${formatDays(summary.totalRemaining)}</td>
        </tr>`
    )
    .join("");

  const totals = summaries.reduce(
    (total, summary) => ({
      cpAcquired: total.cpAcquired + summary.cpAcquired,
      cpTaken: total.cpTaken + summary.cpTaken,
      cpRemaining: total.cpRemaining + summary.cpRemaining,
      rttAcquired: total.rttAcquired + summary.rttAcquired,
      rttImposed: total.rttImposed + summary.rttImposed,
      solidarityDays: total.solidarityDays + summary.solidarityDays,
      rttTaken: total.rttTaken + summary.rttTaken,
      rttRemaining: total.rttRemaining + summary.rttRemaining,
      totalRemaining: total.totalRemaining + summary.totalRemaining
    }),
    {
      cpAcquired: 0,
      cpTaken: 0,
      cpRemaining: 0,
      rttAcquired: 0,
      rttImposed: 0,
      solidarityDays: 0,
      rttTaken: 0,
      rttRemaining: 0,
      totalRemaining: 0
    }
  );

  elements.summaryTable.innerHTML = `
    <table>
      <caption>Les soldes tiennent compte des jours ouvrés compris dans la durée du contrat. Le report CP 2025 reprend les 2 jours restants de 2024 et peut être ajusté.</caption>
      <thead>
        <tr>
          <th scope="col">Année</th>
          <th scope="col">CP acquis</th>
          <th scope="col">CP pris</th>
          <th scope="col">CP restants</th>
          <th scope="col">RTT acquis</th>
          <th scope="col">RTT imposés</th>
          <th scope="col">Solidarité</th>
          <th scope="col">RTT pris</th>
          <th scope="col">RTT restants</th>
          <th scope="col">Total restant</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <th scope="row">Total général</th>
          <td class="number-cell">${formatDays(totals.cpAcquired)}</td>
          <td class="number-cell">${formatDays(totals.cpTaken)}</td>
          <td class="number-cell remaining-cell ${totals.cpRemaining < 0 ? "negative" : ""}">${formatDays(totals.cpRemaining)}</td>
          <td class="number-cell">${formatDays(totals.rttAcquired)}</td>
          <td class="number-cell">${formatDays(totals.rttImposed)}</td>
          <td class="number-cell">${formatDays(totals.solidarityDays)}</td>
          <td class="number-cell">${formatDays(totals.rttTaken)}</td>
          <td class="number-cell remaining-cell ${totals.rttRemaining < 0 ? "negative" : ""}">${formatDays(totals.rttRemaining)}</td>
          <td class="number-cell remaining-cell ${totals.totalRemaining < 0 ? "negative" : ""}">${formatDays(totals.totalRemaining)}</td>
        </tr>
      </tfoot>
    </table>`;
  elements.summaryTable.querySelector("caption").textContent = "Les soldes sont calculés dans chaque année, sans report automatique de CP.";
}

function renderLegend() {
  const legendTypes = ["conge-paye", "rtt", "rtt-half", "rtt-impose", "holiday"];
  elements.legend.innerHTML = legendTypes
    .map(
      (type) => `
        <span class="legend-item">
          <span class="legend-swatch ${type}" aria-hidden="true"></span>
          ${escapeHtml(TYPE_META[type].shortLabel)}
        </span>`
    )
    .join("");
}

function renderCalendar() {
  const year = Number(elements.yearSelect.value);
  const dayMap = buildDayMap(appState);
  const monthFormatter = new Intl.DateTimeFormat("fr-FR", { month: "long" });
  const fullDateFormatter = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
  const weekDays = ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"];
  const lastMonth = year === Number(appState.contractEnd.slice(0, 4)) ? Number(appState.contractEnd.slice(5, 7)) : 12;
  const todayIso = toIsoDate(new Date());
  const months = [];

  for (let month = 0; month < lastMonth; month += 1) {
    const firstDate = new Date(year, month, 1, 12);
    const firstOffset = (firstDate.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0, 12).getDate();
    const cells = weekDays.map((day) => `<div class="weekday" aria-hidden="true">${day}</div>`);
    for (let index = 0; index < firstOffset; index += 1) cells.push("<span class=\"day-spacer\" aria-hidden=\"true\"></span>");

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, month, day, 12);
      const iso = toIsoDate(date);
      const details = dayMap[iso];
      const weekend = isWeekend(date);
      const outsideContract = !isWithinContract(iso, appState.contractStart, appState.contractEnd);
      const official = details?.source === "official";
      const requestBased = details?.source === "absence-request";
      const classes = ["day"];
      if (weekend) classes.push("weekend");
      if (outsideContract) classes.push("outside-contract");
      if (details?.type) classes.push(details.type);
      if (iso === todayIso) classes.push("is-today");

      const labels = [fullDateFormatter.format(date)];
      if (details?.label) labels.push(details.label);
      if (outsideContract) labels.push("hors période du contrat");
      if (requestBased) labels.push("géré dans les demandes d’absence");
      const locked = weekend || outsideContract || official || requestBased;
      cells.push(`
        <button
          class="${classes.join(" ")}"
          type="button"
          data-date="${iso}"
          data-source="${details?.source || "empty"}"
          aria-label="${escapeHtml(labels.join(" · "))}"
          title="${escapeHtml(labels.join(" · "))}"
          ${locked && !official ? "disabled" : ""}
          ${official ? 'aria-disabled="true"' : ""}
        >${day}</button>`);
    }

    months.push(`
      <section class="month" aria-label="${escapeHtml(monthFormatter.format(firstDate))} ${year}">
        <h3 class="month-name">${escapeHtml(monthFormatter.format(firstDate))}</h3>
        <div class="days-grid">${cells.join("")}</div>
      </section>`);
  }
  elements.calendar.innerHTML = months.join("");
}

function renderRequests() {
  const yearFilter = elements.requestYearFilter.value;
  const typeFilter = elements.requestTypeFilter.value;
  const deleted = new Set(appState.deletedRequestIds || []);
  const requests = (appState.absenceRequests || [])
    .filter((request) => !deleted.has(request.id))
    .filter((request) => yearFilter === "all" || request.firstDay.startsWith(`${yearFilter}-`))
    .filter((request) => typeFilter === "all" || request.type === typeFilter)
    .sort((a, b) => b.firstDay.localeCompare(a.firstDay) || b.requestedAt.localeCompare(a.requestedAt));

  if (!requests.length) {
    elements.requestsTable.innerHTML = "<p class=\"empty-state\">Aucune demande ne correspond à ces filtres.</p>";
    return;
  }

  const rows = requests
    .map((request) => {
      const action = request.deletionAllowed
        ? `<button class="button button-danger-quiet button-small" type="button" data-delete-request="${escapeHtml(request.id)}">Supprimer</button>`
        : `<span class="locked-message">${escapeHtml(request.deletionMessage || "Suppression indisponible")}</span>`;
      return `
        <tr>
          <td>${formatFrenchDate(request.requestedAt)}</td>
          <td><span class="status-badge">${escapeHtml(request.status)}</span></td>
          <td>${formatFrenchDate(request.firstDay)}</td>
          <td>${formatFrenchDate(request.lastDay)}</td>
          <td class="number-cell">${formatDays(request.days)}</td>
          <td>${escapeHtml(typeLabel(request.type))}</td>
          <td>${action}</td>
        </tr>`;
    })
    .join("");

  elements.requestsTable.innerHTML = `
    <table>
      <caption>${requests.length} demande${requests.length > 1 ? "s" : ""} affichée${requests.length > 1 ? "s" : ""}</caption>
      <thead>
        <tr>
          <th scope="col">Date de demande</th>
          <th scope="col">Statut</th>
          <th scope="col">Premier jour</th>
          <th scope="col">Dernier jour</th>
          <th scope="col">Nbre jours</th>
          <th scope="col">Type d’absence</th>
          <th scope="col">Supprimer</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderSources() {
  elements.sourcesList.innerHTML = (appState.sources || [])
    .map(
      (source) => `
        <li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)}</a></li>`
    )
    .join("");
}

function shiftYear(delta) {
  const currentIndex = years.indexOf(Number(elements.yearSelect.value));
  const nextIndex = Math.min(Math.max(currentIndex + delta, 0), years.length - 1);
  elements.yearSelect.value = String(years[nextIndex]);
  updateYearNavigationButtons();
  renderCalendar();
  renderSummary();
}

function updateYearNavigationButtons() {
  const index = years.indexOf(Number(elements.yearSelect.value));
  elements.prevYear.disabled = index <= 0;
  elements.nextYear.disabled = index >= years.length - 1;
}

function handleCalendarClick(event) {
  const button = event.target.closest("button[data-date]");
  if (!button || button.disabled) return;
  const iso = button.dataset.date;
  const details = buildDayMap(appState)[iso];
  if (details?.source === "absence-request") {
    showToast("Cette date vient d’une demande d’absence. Utilisez le tableau Historique pour la gérer.");
    document.querySelector("#requests-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (details?.source === "official") {
    showToast("Les jours fériés et RTT imposés sont verrouillés.");
    return;
  }

  elements.dayDate.value = iso;
  elements.dayDialogTitle.textContent = formatFrenchDate(iso);
  const selectedType = details?.type || "none";
  const radio = elements.dayForm.querySelector(`input[name="day-type"][value="${selectedType}"]`);
  if (radio) radio.checked = true;
  elements.dayDialog.showModal();
}

async function handleDayFormSubmit(event) {
  event.preventDefault();
  const date = elements.dayDate.value;
  const selected = new FormData(elements.dayForm).get("day-type");
  if (!date || !selected) return;

  appState.deletedCustomDays ||= [];
  const deleted = new Set(appState.deletedCustomDays);
  if (selected === "none") {
    delete appState.customDays[date];
    deleted.add(date);
  } else {
    appState.customDays[date] = selected;
    deleted.delete(date);
  }
  appState.deletedCustomDays = [...deleted];
  elements.dayDialog.close();
  renderSummary();
  renderCalendar();
  await persistState("Jour mis à jour");
}

function openRequestDialog() {
  const calendarToday = toIsoDate(new Date());
  const today = calendarToday < appState.contractStart
    ? appState.contractStart
    : calendarToday > appState.contractEnd
      ? appState.contractEnd
      : calendarToday;
  elements.requestForm.reset();
  elements.requestLastDay.setCustomValidity("");
  elements.requestDate.value = today;
  elements.requestFirstDay.value = today;
  elements.requestLastDay.value = today;
  elements.requestDays.value = isWithinContract(today, appState.contractStart, appState.contractEnd) && !isWeekend(today) ? "1" : "0.5";
  document.querySelector("#request-status-input").value = "Absence prise en compte";
  elements.requestDialog.showModal();
}

function updateCalculatedRequestDays() {
  const first = elements.requestFirstDay.value;
  const last = elements.requestLastDay.value;
  if (!first || !last) return;
  if (last < first) {
    elements.requestLastDay.setCustomValidity("Le dernier jour doit être postérieur au premier jour.");
    return;
  }
  elements.requestLastDay.setCustomValidity("");
  const dates = businessDatesBetween(first, last, {
    officialDays: appState.officialDays,
    contractStart: appState.contractStart,
    contractEnd: appState.contractEnd
  });
  elements.requestDays.value = dates.length || "";
}

async function handleRequestFormSubmit(event) {
  event.preventDefault();
  if (!elements.requestForm.reportValidity()) return;
  const data = new FormData(elements.requestForm);
  const days = Number(data.get("days"));
  const request = {
    id: globalThis.crypto?.randomUUID?.() || `request-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    requestedAt: String(data.get("requestedAt")),
    status: String(data.get("status")),
    firstDay: String(data.get("firstDay")),
    lastDay: String(data.get("lastDay")),
    days,
    type: String(data.get("type")),
    deletionAllowed: true,
    deletionMessage: "Supprimer"
  };

  const businessDays = businessDatesBetween(request.firstDay, request.lastDay, {
    officialDays: appState.officialDays,
    contractStart: appState.contractStart,
    contractEnd: appState.contractEnd
  });
  if (
    !isWithinContract(request.firstDay, appState.contractStart, appState.contractEnd)
    || !isWithinContract(request.lastDay, appState.contractStart, appState.contractEnd)
  ) {
    showToast("La demande doit rester entièrement dans la période du contrat.", true, 8000);
    return;
  }
  if (!businessDays.length) {
    showToast("Cette période ne contient aucun jour ouvré dans le contrat.", true);
    return;
  }
  const isHalfRtt = request.type === "rtt"
    && days === 0.5
    && businessDays.length === 1
    && request.firstDay === request.lastDay;
  const matchesFullBusinessDays = Number.isInteger(days) && days === businessDays.length;
  if (!isHalfRtt && !matchesFullBusinessDays) {
    showToast("Le nombre de jours doit correspondre exactement aux jours ouvrés de la période (ou 0,5 pour un RTT sur une seule date).", true, 8000);
    return;
  }

  const occupiedDays = buildDayMap(appState);
  const overlappingDays = businessDays.filter(
    (date) => occupiedDays[date] && occupiedDays[date].source !== "official"
  );
  if (overlappingDays.length) {
    showToast(`Une absence existe déjà le ${formatFrenchDate(overlappingDays[0])}.`, true, 8000);
    return;
  }

  appState.absenceRequests.push(request);
  elements.requestDialog.close();
  elements.yearSelect.value = request.firstDay.slice(0, 4);
  updateYearNavigationButtons();
  renderAll();
  await persistState("Demande ajoutée");
}

async function handleRequestTableClick(event) {
  const button = event.target.closest("button[data-delete-request]");
  if (!button) return;
  const request = appState.absenceRequests.find((item) => item.id === button.dataset.deleteRequest);
  if (!request || !request.deletionAllowed) return;
  const confirmed = window.confirm(`Supprimer la demande du ${formatFrenchDate(request.firstDay)} au ${formatFrenchDate(request.lastDay)} ?`);
  if (!confirmed) return;

  appState.deletedRequestIds ||= [];
  appState.deletedRequestIds = [...new Set([...appState.deletedRequestIds, request.id])];
  appState.absenceRequests = appState.absenceRequests.filter((item) => item.id !== request.id);
  renderAll();
  await persistState("Demande supprimée");
}

function openRightsDialog() {
  elements.rightsYear.value = elements.yearSelect.value;
  loadRightsFormValues();
  elements.rightsDialog.showModal();
}

function loadRightsFormValues() {
  const settings = appState.yearSettings[elements.rightsYear.value];
  elements.rightsContractStart.value = appState.contractStart;
  elements.rightsContractEnd.value = appState.contractEnd;
  elements.rightsCp.value = settings.cpAcquired;
  elements.rightsRtt.value = settings.rttAcquired;
  elements.rightsSolidarity.value = settings.solidarityDays;
}

async function handleRightsFormSubmit(event) {
  event.preventDefault();
  if (!elements.rightsForm.reportValidity()) return;
  const contractStart = elements.rightsContractStart.value;
  const contractEnd = elements.rightsContractEnd.value;
  if (!parseIsoDate(contractStart) || !parseIsoDate(contractEnd) || contractEnd < contractStart) {
    showToast("Les dates du contrat sont invalides.", true, 7000);
    return;
  }
  const nextState = clone(appState);
  nextState.contractStart = contractStart;
  nextState.contractEnd = contractEnd;
  if (!nextState.absenceRequests.every((request) => isValidAbsenceRequest(request, nextState))) {
    showToast("La période choisie exclut une demande d’absence existante.", true, 7000);
    return;
  }
  const year = elements.rightsYear.value;
  appState.contractStart = contractStart;
  appState.contractEnd = contractEnd;
  appState.yearSettings[year] = {
    cpAcquired: Number(elements.rightsCp.value),
    rttAcquired: Number(elements.rightsRtt.value),
    solidarityDays: Number(elements.rightsSolidarity.value)
  };
  elements.requestFirstDay.min = contractStart;
  elements.requestFirstDay.max = contractEnd;
  elements.requestLastDay.min = contractStart;
  elements.requestLastDay.max = contractEnd;
  elements.rightsDialog.close();
  renderSummary();
  await persistState("Droits mis à jour");
}

function exportState() {
  const payload = JSON.stringify(appState, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `gestion-conges-${toIsoDate(new Date())}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast("Copie de secours exportée");
}

async function importState(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const validation = validateImport(parsed);
    if (!validation.valid) throw new Error(validation.message);
    if (!window.confirm("Remplacer les données actuelles par ce fichier ? Une sauvegarde locale sera créée.")) return;
    createLocalBackup();
    const nextState = validation.kind === "legacy"
      ? migrateLegacyHolidayData(seedState, parsed)
      : normalizeState(seedState, parsed);
    if (!nextState.absenceRequests.every((request) => isValidAbsenceRequest(request, nextState))) {
      throw new Error("une demande d’absence reste incohérente après normalisation");
    }
    if (findPersonalDateConflicts(nextState).length) {
      throw new Error("des absences se chevauchent dans cette sauvegarde");
    }
    appState = nextState;
    renderAll();
    await persistState("Données importées");
  } catch (error) {
    showToast(`Import impossible : ${error.message}`, true, 8000);
  }
}

async function resetState() {
  if (!window.confirm("Rétablir toutes les données initiales ? Une sauvegarde locale sera créée avant le remplacement.")) return;
  createLocalBackup();
  appState = clone(seedState);
  renderAll();
  await persistState("Données initiales rétablies");
}

function createLocalBackup() {
  const current = localStorage.getItem(STORAGE_KEY);
  if (current) localStorage.setItem(`${STORAGE_KEY}:backup:${Date.now()}`, current);
}

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

function getUnsyncedLocalToken() {
  return localStorage.getItem(CLOUD_DIRTY_KEY);
}

function markLocalChangesUnsynced() {
  const token = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(CLOUD_DIRTY_KEY, token);
  return token;
}

function markLocalChangesSynced(token) {
  if (token && getUnsyncedLocalToken() === token) {
    localStorage.removeItem(CLOUD_DIRTY_KEY);
  }
}

function clearUnsyncedLocalMarker() {
  localStorage.removeItem(CLOUD_DIRTY_KEY);
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stateFingerprint(state) {
  return stableSerialize(state);
}

async function saveCurrentStateToCloud(expectedSessionEpoch = cloudSessionEpoch) {
  const syncToken = getUnsyncedLocalToken();
  const stateToSave = clone(appState);
  const result = await cloudSync.saveState(stateToSave);
  if (expectedSessionEpoch !== cloudSessionEpoch || isSigningOut) return result;
  lastKnownRemoteFingerprint = stateFingerprint(result?.state || stateToSave);
  markLocalChangesSynced(syncToken);
  return result;
}

function clearPrivateLocalState() {
  const privateKeys = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (
      key === STORAGE_KEY
      || key?.startsWith(`${STORAGE_KEY}:`)
      || key === LEGACY_STORAGE_KEY
      || key?.startsWith(`${LEGACY_STORAGE_KEY}:`)
    ) {
      privateKeys.push(key);
    }
  }
  privateKeys.forEach((key) => localStorage.removeItem(key));
  appState = clone(seedState);
  saveLocalState();
  lastKnownRemoteFingerprint = null;
}

async function persistState(successMessage) {
  appState.updatedAt = new Date().toISOString();
  saveLocalState();
  markLocalChangesUnsynced();
  if (cloudConfigured && cloudUser && cloudSync && !isApplyingRemoteState) {
    setSyncStatus("saving", "Vérification du cloud…");
    try {
      await loadCloudState();
    } catch (error) {
      setSyncStatus(navigator.onLine ? "error" : "offline", navigator.onLine ? "Erreur de synchronisation" : "Hors ligne · sauvegardé localement");
      showToast("La modification est conservée sur cet appareil et sera à resynchroniser.", true, 7000);
    }
  } else {
    setSyncStatus("local", "Enregistré sur cet appareil");
  }
  if (successMessage) showToast(successMessage);
}

async function initializeCloudSync() {
  try {
    const { createCloudSync } = await import("./cloud-sync.js?v=20260715c");
    cloudSync = await createCloudSync({
      onStateChange: handleCloudStateChange,
      onRemoteState: applyRemoteState,
      onError: (error) => {
        console.error(error);
        setSyncStatus("error", "Erreur de synchronisation");
      }
    });
    cloudConfigured = Boolean(cloudSync?.configured);
    cloudUser = cloudSync?.currentUser || null;
    if (!cloudConfigured) {
      setSyncStatus("local", "Enregistré sur cet appareil");
      elements.syncButton.textContent = "Configurer la synchro";
      renderNotices();
      return;
    }

    elements.syncButton.textContent = cloudUser ? "Synchroniser" : "Se connecter avec Google";
    elements.signOutButton.classList.toggle("is-hidden", !cloudUser);
    if (cloudUser) {
      try {
        await loadCloudState();
      } catch (error) {
        console.warn("Cloud state unavailable", error);
        setSyncStatus(
          navigator.onLine ? "error" : "offline",
          navigator.onLine ? "Cloud momentanément indisponible" : "Hors ligne · sauvegardé localement"
        );
      }
    } else setSyncStatus("local", "Connexion requise");
    renderNotices();
  } catch (error) {
    console.warn("Cloud sync unavailable", error);
    cloudSync = null;
    cloudConfigured = false;
    setSyncStatus("local", "Enregistré sur cet appareil");
    elements.syncButton.textContent = "Configurer la synchro";
    renderNotices();
  }
}

function handleCloudStateChange(change = {}) {
  const status = typeof change === "string" ? change : (change.code || change.status);
  const hasUser = typeof change === "object" && Object.prototype.hasOwnProperty.call(change, "user");
  if (hasUser && change.user?.uid !== cloudUser?.uid) {
    cloudSessionEpoch += 1;
    lastKnownRemoteFingerprint = null;
  }
  if (hasUser) cloudUser = change.user;
  if (status === "signed-out") {
    cloudUser = null;
    lastKnownRemoteFingerprint = null;
  }

  const statusMap = {
    ready: ["synced", "Synchronisé dans le cloud"],
    "signed-in": ["synced", "Connecté · chargement…"],
    "signed-out": ["local", "Connexion requise"],
    "signing-in": ["saving", "Connexion à Google…"],
    saving: ["saving", "Synchronisation…"],
    synced: ["synced", "Synchronisé dans le cloud"],
    offline: ["offline", "Hors ligne · sauvegardé localement"],
    error: ["error", "Erreur de synchronisation"],
    "auth-error": ["error", "Erreur d’authentification"],
    "save-error": ["error", "Erreur de synchronisation"],
    "subscription-error": ["error", "Connexion temps réel interrompue"]
  };
  if (statusMap[status]) setSyncStatus(...statusMap[status]);
  elements.syncButton.textContent = cloudUser ? "Synchroniser" : "Se connecter avec Google";
  elements.signOutButton.classList.toggle("is-hidden", !cloudUser);
  renderNotices();
}

async function handleSyncButton() {
  if (!cloudConfigured || !cloudSync) {
    showToast("La configuration Firebase manque encore. Consultez FIREBASE_SETUP.md dans le projet.", true, 8000);
    return;
  }
  try {
    if (!cloudUser) {
      const result = await cloudSync.signIn({ forceRedirect: true });
      cloudUser = result?.user || cloudSync.currentUser || cloudUser;
      if (cloudUser) await loadCloudState();
    } else {
      const result = await loadCloudState();
      if (result !== "cancelled") showToast("Synchronisation terminée");
    }
  } catch (error) {
    const detail = error?.cause?.message || error?.message || "erreur inconnue";
    showToast(`Connexion impossible : ${detail}`, true, 8000);
  }
}

function handleSignOut() {
  if (!cloudSync) return;
  elements.signOutDialog.showModal();
}

async function confirmSignOut(event) {
  event.preventDefault();
  if (!cloudSync || isSigningOut) return;
  cloudSessionEpoch += 1;
  lastKnownRemoteFingerprint = null;
  isSigningOut = true;
  elements.confirmSignOutButton.disabled = true;
  try {
    await cloudSync.signOut();
    cloudUser = null;
    clearPrivateLocalState();
    settleSyncConflict("cancel");
    elements.signOutDialog.close();
    elements.signOutButton.classList.add("is-hidden");
    elements.syncButton.textContent = "Se connecter avec Google";
    setSyncStatus("local", "Session fermée · données locales effacées");
    renderAll();
    showToast("Session fermée et copie privée effacée de cet appareil.");
  } catch (error) {
    console.warn("Sign-out failed", error);
    showToast("Déconnexion impossible. Aucune donnée locale n’a été effacée.", true, 8000);
  } finally {
    elements.confirmSignOutButton.disabled = false;
    isSigningOut = false;
  }
}

function handleSyncConflictChoice(event) {
  event.preventDefault();
  settleSyncConflict(event.submitter?.value || "cancel");
}

function settleSyncConflict(choice) {
  if (!conflictResolver) return;
  const resolve = conflictResolver;
  conflictResolver = null;
  if (elements.syncConflictDialog.open) elements.syncConflictDialog.close(choice);
  resolve(choice);
}

function promptSyncConflict() {
  return new Promise((resolve) => {
    conflictResolver = resolve;
    elements.syncConflictDialog.showModal();
  });
}

function validateRemoteState(remoteState) {
  if (!remoteState || remoteState.version !== 2) {
    setSyncStatus("error", "Données cloud invalides");
    showToast("Synchronisation ignorée : format cloud invalide.", true, 8000);
    return false;
  }
  const validation = validateImport(remoteState);
  if (!validation.valid) {
    setSyncStatus("error", "Données cloud invalides");
    showToast(`Synchronisation ignorée : ${validation.message}`, true, 8000);
    return false;
  }
  return true;
}

async function reconcileCloudState() {
  if (isSigningOut) return "cancelled";
  const sessionEpoch = cloudSessionEpoch;
  const sessionChanged = () => isSigningOut || sessionEpoch !== cloudSessionEpoch;
  isReconcilingConflict = true;
  try {
    let remote = await cloudSync.loadState({ serverOnly: true });
    if (sessionChanged()) return "cancelled";
    if (!remote.exists) {
      await saveCurrentStateToCloud(sessionEpoch);
      if (sessionChanged()) return "cancelled";
      setSyncStatus("synced", "Données locales envoyées dans le cloud");
      return "uploaded";
    }
    if (!validateRemoteState(remote.state)) return "invalid";

    let remoteFingerprint = stateFingerprint(remote.state);
    const syncToken = getUnsyncedLocalToken();
    if (!syncToken) {
      lastKnownRemoteFingerprint = remoteFingerprint;
      applyRemoteState(remote);
      return "downloaded";
    }

    const localFingerprint = stateFingerprint(appState);
    if (localFingerprint === remoteFingerprint) {
      lastKnownRemoteFingerprint = remoteFingerprint;
      markLocalChangesSynced(syncToken);
      setSyncStatus("synced", "Synchronisé dans le cloud");
      return "already-synced";
    }

    if (lastKnownRemoteFingerprint === remoteFingerprint) {
      await saveCurrentStateToCloud(sessionEpoch);
      if (sessionChanged()) return "cancelled";
      setSyncStatus("synced", "Synchronisé dans le cloud");
      return "uploaded";
    }

    while (true) {
      setSyncStatus("conflict", "Choix requis avant synchronisation");
      const choice = await promptSyncConflict();
      if (sessionChanged()) return "cancelled";
      if (choice === "cancel") {
        setSyncStatus("conflict", "Synchronisation en attente d’un choix");
        return "cancelled";
      }

      const latestRemote = await cloudSync.loadState({ serverOnly: true });
      if (sessionChanged()) return "cancelled";
      if (!latestRemote.exists) {
        await saveCurrentStateToCloud(sessionEpoch);
        if (sessionChanged()) return "cancelled";
        setSyncStatus("synced", "Données locales envoyées dans le cloud");
        return "uploaded";
      }
      if (!validateRemoteState(latestRemote.state)) return "invalid";

      const latestFingerprint = stateFingerprint(latestRemote.state);
      if (latestFingerprint !== remoteFingerprint) {
        remote = latestRemote;
        remoteFingerprint = latestFingerprint;
        showToast("La version cloud a changé. Veuillez confirmer à nouveau votre choix.", true, 7000);
        continue;
      }

      if (choice === "remote") {
        clearUnsyncedLocalMarker();
        lastKnownRemoteFingerprint = remoteFingerprint;
        applyRemoteState(remote);
        showToast("La version cloud a été conservée sur cet appareil.");
        return "downloaded";
      }

      await saveCurrentStateToCloud(sessionEpoch);
      if (sessionChanged()) return "cancelled";
      setSyncStatus("synced", "Version de cet appareil envoyée dans le cloud");
      showToast("La version de cet appareil a remplacé la version cloud.");
      return "uploaded";
    }
  } finally {
    isReconcilingConflict = false;
  }
}

function loadCloudState() {
  const requestedToken = getUnsyncedLocalToken();
  if (!cloudReconciliationPromise) {
    const operation = reconcileCloudState();
    let trackedOperation;
    trackedOperation = operation.finally(() => {
      if (cloudReconciliationPromise === trackedOperation) cloudReconciliationPromise = null;
    });
    cloudReconciliationPromise = trackedOperation;
  }

  const currentOperation = cloudReconciliationPromise;
  return currentOperation.then((result) => {
    if (result !== "cancelled" && requestedToken && getUnsyncedLocalToken()) {
      return loadCloudState();
    }
    return result;
  });
}

async function retryCloudSync() {
  if (!cloudSync && navigator.onLine) {
    await initializeCloudSync();
    return;
  }
  if (!cloudConfigured || !cloudUser || !cloudSync) return;
  try {
    await loadCloudState();
  } catch (error) {
    console.warn("Cloud retry failed", error);
    setSyncStatus("error", "Cloud momentanément indisponible");
  }
}

function applyRemoteState(snapshotOrState) {
  if (isSigningOut || !cloudUser) return;
  if (!snapshotOrState || snapshotOrState.exists === false) return;
  if (snapshotOrState.hasPendingWrites) return;
  const remoteState = snapshotOrState.state || snapshotOrState;
  if (!validateRemoteState(remoteState)) return;
  if (getUnsyncedLocalToken()) {
    if (cloudConfigured && cloudUser && !isReconcilingConflict && !isSigningOut) {
      setSyncStatus("saving", "Vérification du cloud…");
      loadCloudState().catch((error) => {
        console.warn("Cloud conflict check failed", error);
        setSyncStatus("error", "Conflit non synchronisé");
      });
    }
    return;
  }
  isApplyingRemoteState = true;
  try {
    appState = normalizeState(seedState, remoteState);
    lastKnownRemoteFingerprint = stateFingerprint(remoteState);
    saveLocalState();
    renderAll();
    setSyncStatus("synced", "Synchronisé dans le cloud");
  } finally {
    isApplyingRemoteState = false;
  }
}

function setSyncStatus(state, text) {
  elements.syncStatus.dataset.state = state;
  elements.syncStatusText.textContent = text;
}

function showToast(message, isError = false, duration = 3600) {
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " is-error" : ""}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), duration);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.addEventListener("beforeunload", () => {
  cloudSync?.dispose?.();
});

initialize();

