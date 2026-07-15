export const PERSONAL_DAY_TYPES = new Set(["conge-paye", "rtt", "rtt-half"]);
export const ALL_DAY_TYPES = new Set(["conge-paye", "rtt", "rtt-half", "rtt-impose", "holiday"]);
const REQUEST_TYPES = new Set(["conge-paye", "rtt"]);

export const TYPE_META = {
  "conge-paye": { label: "Congé payé", shortLabel: "CP" },
  rtt: { label: "Réduction du temps de travail", shortLabel: "RTT" },
  "rtt-half": { label: "RTT demi-journée", shortLabel: "½ RTT" },
  "rtt-impose": { label: "RTT imposé", shortLabel: "RTT imposé" },
  holiday: { label: "Jour férié", shortLabel: "Férié" }
};

export function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

export function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isWeekend(dateOrIso) {
  const date = typeof dateOrIso === "string" ? parseIsoDate(dateOrIso) : dateOrIso;
  if (!date) return false;
  return date.getDay() === 0 || date.getDay() === 6;
}

export function isWithinContract(isoDate, contractStart, contractEnd) {
  if (!parseIsoDate(isoDate)) return false;
  return (!contractStart || isoDate >= contractStart) && (!contractEnd || isoDate <= contractEnd);
}

export function businessDatesBetween(firstDay, lastDay, options = {}) {
  const start = parseIsoDate(firstDay);
  const end = parseIsoDate(lastDay);
  if (!start || !end || start > end) return [];

  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = toIsoDate(cursor);
    const officialType = options.officialDays?.[iso]?.type;
    const blockedByOfficialDay = officialType === "holiday" || officialType === "rtt-impose";
    if (
      !isWeekend(cursor) &&
      !blockedByOfficialDay &&
      isWithinContract(iso, options.contractStart, options.contractEnd)
    ) {
      dates.push(iso);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

export function expandAbsenceRequest(request, state) {
  if (!request || !PERSONAL_DAY_TYPES.has(request.type === "rtt" && request.days === 0.5 ? "rtt-half" : request.type)) {
    return {};
  }

  const dates = businessDatesBetween(request.firstDay, request.lastDay, {
    officialDays: state.officialDays,
    contractStart: state.contractStart,
    contractEnd: state.contractEnd
  });

  const type = request.type === "rtt" && Number(request.days) === 0.5 ? "rtt-half" : request.type;
  const requestedDays = Number(request.days);
  const datesToProject = requestedDays === 0.5
    ? dates.slice(0, 1)
    : dates.slice(0, Math.max(0, Math.floor(requestedDays)));
  return Object.fromEntries(
    datesToProject.map((date) => [
      date,
      {
        type,
        label: TYPE_META[type]?.label || type,
        source: "absence-request",
        requestId: request.id
      }
    ])
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isValidAbsenceRequest(request, state = {}) {
  if (
    !isPlainObject(request)
    || typeof request.id !== "string"
    || !request.id.trim()
    || !parseIsoDate(request.requestedAt)
    || !parseIsoDate(request.firstDay)
    || !parseIsoDate(request.lastDay)
    || request.lastDay < request.firstDay
    || !isWithinContract(request.firstDay, state.contractStart, state.contractEnd)
    || !isWithinContract(request.lastDay, state.contractStart, state.contractEnd)
    || typeof request.status !== "string"
    || !request.status.trim()
    || !REQUEST_TYPES.has(request.type)
    || typeof request.deletionAllowed !== "boolean"
  ) {
    return false;
  }

  const days = Number(request.days);
  if (!Number.isFinite(days) || days <= 0) return false;

  const businessDays = businessDatesBetween(request.firstDay, request.lastDay, {
    officialDays: state.officialDays,
    contractStart: state.contractStart,
    contractEnd: state.contractEnd
  });
  if (!businessDays.length) return false;

  if (days === 0.5) {
    return request.type === "rtt"
      && request.firstDay === request.lastDay
      && businessDays.length === 1;
  }
  return Number.isInteger(days) && days === businessDays.length;
}

export function findPersonalDateConflicts(state) {
  const occupied = new Map();
  const conflicts = new Set();
  const deletedCustomDays = new Set(
    Array.isArray(state?.deletedCustomDays) ? state.deletedCustomDays : []
  );

  for (const [date, type] of Object.entries(
    isPlainObject(state?.customDays) ? state.customDays : {}
  )) {
    if (
      !parseIsoDate(date)
      || !PERSONAL_DAY_TYPES.has(type)
      || deletedCustomDays.has(date)
    ) continue;
    occupied.set(date, `custom:${date}`);
  }

  const deletedRequestIds = new Set(
    Array.isArray(state?.deletedRequestIds) ? state.deletedRequestIds : []
  );
  for (const request of Array.isArray(state?.absenceRequests) ? state.absenceRequests : []) {
    if (!request?.id || deletedRequestIds.has(request.id)) continue;
    const owner = `request:${request.id}`;
    for (const date of Object.keys(expandAbsenceRequest(request, state))) {
      const previousOwner = occupied.get(date);
      if (previousOwner && previousOwner !== owner) conflicts.add(date);
      else occupied.set(date, owner);
    }
  }

  return [...conflicts].sort();
}

export function buildDayMap(state) {
  const dayMap = {};
  const deletedCustomDays = new Set(state.deletedCustomDays || []);

  for (const [date, details] of Object.entries(state.officialDays || {})) {
    if (!parseIsoDate(date) || !ALL_DAY_TYPES.has(details?.type)) continue;
    dayMap[date] = { ...details, source: "official" };
  }

  for (const [date, type] of Object.entries(state.customDays || {})) {
    if (!parseIsoDate(date) || !PERSONAL_DAY_TYPES.has(type) || dayMap[date] || deletedCustomDays.has(date)) continue;
    dayMap[date] = {
      type,
      label: TYPE_META[type]?.label || type,
      source: "custom"
    };
  }

  const deleted = new Set(state.deletedRequestIds || []);
  for (const request of state.absenceRequests || []) {
    if (!request?.id || deleted.has(request.id)) continue;
    const requestDays = expandAbsenceRequest(request, state);
    for (const [date, details] of Object.entries(requestDays)) {
      if (!dayMap[date] || dayMap[date].source !== "official") {
        dayMap[date] = details;
      }
    }
  }

  return dayMap;
}

export function calculateYearSummary(state, year) {
  const settings = state.yearSettings?.[String(year)] || {
    cpAcquired: 0,
    cpCarryOver: 0,
    rttAcquired: 0,
    solidarityDays: 0
  };
  const dayMap = buildDayMap(state);
  let cpTaken = 0;
  let rttTaken = 0;
  let rttImposed = 0;

  for (const [date, details] of Object.entries(dayMap)) {
    if (!date.startsWith(`${year}-`) || isWeekend(date)) continue;
    if (!isWithinContract(date, state.contractStart, state.contractEnd)) continue;
    if (details.type === "conge-paye") cpTaken += 1;
    if (details.type === "rtt") rttTaken += 1;
    if (details.type === "rtt-half") rttTaken += 0.5;
    if (details.type === "rtt-impose") rttImposed += 1;
  }

  const cpRights = Number(settings.cpAcquired || 0) + Number(settings.cpCarryOver || 0);
  const rttRights = Number(settings.rttAcquired || 0);
  const solidarityDays = Number(settings.solidarityDays || 0);
  return {
    year: Number(year),
    cpAcquired: Number(settings.cpAcquired || 0),
    cpCarryOver: Number(settings.cpCarryOver || 0),
    cpRights,
    cpTaken,
    cpRemaining: cpRights - cpTaken,
    rttAcquired: rttRights,
    rttImposed,
    solidarityDays,
    rttTaken,
    rttRemaining: rttRights - rttImposed - solidarityDays - rttTaken
  };
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function migrateLegacyHolidayData(seed, legacyHolidayData) {
  const migrated = clone(seed);
  migrated.customDays ||= {};
  if (!legacyHolidayData || typeof legacyHolidayData !== "object" || Array.isArray(legacyHolidayData)) {
    return migrated;
  }

  const existingDays = buildDayMap(migrated);
  for (const [date, type] of Object.entries(legacyHolidayData)) {
    if (!parseIsoDate(date) || !PERSONAL_DAY_TYPES.has(type) || existingDays[date]) continue;
    migrated.customDays[date] = type;
  }
  migrated.migratedFromLegacy = true;
  return migrated;
}

export function normalizeState(seed, storedState) {
  if (!storedState || storedState.version !== 2) return clone(seed);

  const normalized = clone(seed);
  if (
    parseIsoDate(storedState.contractStart)
    && parseIsoDate(storedState.contractEnd)
    && storedState.contractEnd >= storedState.contractStart
  ) {
    normalized.contractStart = storedState.contractStart;
    normalized.contractEnd = storedState.contractEnd;
  }
  const deletedCustomDays = new Set(
    Array.isArray(storedState.deletedCustomDays)
      ? storedState.deletedCustomDays.filter((date) => parseIsoDate(date))
      : []
  );
  normalized.customDays = {};
  for (const [date, type] of Object.entries(seed.customDays || {})) {
    if (!deletedCustomDays.has(date)) normalized.customDays[date] = type;
  }
  for (const [date, type] of Object.entries(
    isPlainObject(storedState.customDays) ? storedState.customDays : {}
  )) {
    if (parseIsoDate(date) && PERSONAL_DAY_TYPES.has(type)) {
      normalized.customDays[date] = type;
    }
  }
  for (const date of deletedCustomDays) delete normalized.customDays[date];
  normalized.deletedCustomDays = [...deletedCustomDays];
  normalized.yearSettings = {};
  for (const year of Object.keys(seed.yearSettings || {})) {
    const storedSettings = isPlainObject(storedState.yearSettings?.[year])
      ? storedState.yearSettings[year]
      : {};
    normalized.yearSettings[year] = {
      ...seed.yearSettings[year],
      ...Object.fromEntries(
        Object.entries(storedSettings).filter(
          ([key, value]) => ["cpAcquired", "cpCarryOver", "rttAcquired", "solidarityDays"].includes(key)
            && Number.isFinite(Number(value))
            && Number(value) >= 0
        ).map(([key, value]) => [key, Number(value)])
      )
    };
  }

  const deletedIds = new Set(
    Array.isArray(storedState.deletedRequestIds)
      ? storedState.deletedRequestIds.filter((id) => typeof id === "string" && id)
      : []
  );
  const storedRequests = Array.isArray(storedState.absenceRequests) ? storedState.absenceRequests : [];
  const requestById = new Map(
    storedRequests
      .filter((request) => isValidAbsenceRequest(request, normalized))
      .map((request) => [request.id, request])
  );
  for (const request of seed.absenceRequests || []) {
    if (!requestById.has(request.id) && !deletedIds.has(request.id)) requestById.set(request.id, request);
  }
  normalized.absenceRequests = [...requestById.values()];
  normalized.deletedRequestIds = [...deletedIds];
  normalized.updatedAt = typeof storedState.updatedAt === "string" ? storedState.updatedAt : null;
  return normalized;
}

export function validateImport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, message: "Le fichier doit contenir un objet JSON." };
  }
  if (value.version === 2) {
    if (!isPlainObject(value.customDays)) {
      return { valid: false, message: "La section customDays est absente ou invalide." };
    }
    if (!Object.entries(value.customDays).every(([date, type]) => parseIsoDate(date) && PERSONAL_DAY_TYPES.has(type))) {
      return { valid: false, message: "La section customDays contient une date ou un type invalide." };
    }
    if (!Array.isArray(value.absenceRequests)) {
      return { valid: false, message: "La section absenceRequests est absente ou invalide." };
    }
    if (
      !parseIsoDate(value.contractStart)
      || !parseIsoDate(value.contractEnd)
      || value.contractEnd < value.contractStart
      || !isPlainObject(value.officialDays)
    ) {
      return { valid: false, message: "Les dates du contrat ou les jours officiels sont invalides." };
    }
    if (!Object.entries(value.officialDays).every(
      ([date, details]) => parseIsoDate(date)
        && isPlainObject(details)
        && ["holiday", "rtt-impose"].includes(details.type)
    )) {
      return { valid: false, message: "La section officialDays contient une entrée invalide." };
    }
    if (!value.absenceRequests.every((request) => isValidAbsenceRequest(request, value))) {
      return { valid: false, message: "Une demande d’absence est incomplète ou incohérente." };
    }
    const requestIds = value.absenceRequests.map((request) => request.id);
    if (new Set(requestIds).size !== requestIds.length) {
      return { valid: false, message: "Deux demandes d’absence utilisent le même identifiant." };
    }
    if (
      (value.deletedCustomDays !== undefined && !Array.isArray(value.deletedCustomDays))
      || (value.deletedRequestIds !== undefined && !Array.isArray(value.deletedRequestIds))
    ) {
      return { valid: false, message: "Les listes de suppressions sont invalides." };
    }
    const officialConflicts = Object.keys(value.customDays).filter(
      (date) => ["holiday", "rtt-impose"].includes(value.officialDays[date]?.type)
    );
    const personalConflicts = findPersonalDateConflicts(value);
    if (officialConflicts.length || personalConflicts.length) {
      return { valid: false, message: "Le fichier contient des absences qui se chevauchent." };
    }
    return { valid: true, kind: "v2" };
  }

  const entries = Object.entries(value);
  const legacyValid = entries.every(([date, type]) => parseIsoDate(date) && ALL_DAY_TYPES.has(type));
  return legacyValid
    ? { valid: true, kind: "legacy" }
    : { valid: false, message: "Le format de sauvegarde n’est pas reconnu." };
}

export function formatFrenchDate(isoDate) {
  const date = parseIsoDate(isoDate);
  return date ? new Intl.DateTimeFormat("fr-FR").format(date) : "—";
}

export function formatDays(value) {
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: Number(value) % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 1
  }).format(Number(value) || 0);
}

export function typeLabel(type) {
  if (type === "conge-paye") return "Congés payés annuels";
  if (type === "rtt") return "Réduction Temps Travail";
  return TYPE_META[type]?.label || type;
}
