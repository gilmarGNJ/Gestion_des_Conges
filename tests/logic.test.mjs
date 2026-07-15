import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDayMap,
  businessDatesBetween,
  calculateYearSummary,
  findPersonalDateConflicts,
  isValidAbsenceRequest,
  migrateLegacyHolidayData,
  normalizeState,
  parseIsoDate,
  validateImport
} from "../public/logic.js";

const publicSeed = JSON.parse(
  await readFile(new URL("../public/data/seed-data.json", import.meta.url), "utf8")
);

function makeSampleState() {
  const state = structuredClone(publicSeed);
  state.yearSettings["2026"] = {
    cpAcquired: 10,
    cpCarryOver: 2,
    rttAcquired: 10,
    solidarityDays: 1
  };
  state.customDays = {
    "2026-09-10": "conge-paye",
    "2026-09-11": "rtt"
  };
  state.absenceRequests = [
    {
      id: "sample-cp-request",
      requestedAt: "2026-08-20",
      status: "Absence prise en compte",
      firstDay: "2026-09-07",
      lastDay: "2026-09-08",
      days: 2,
      type: "conge-paye",
      deletionAllowed: true,
      deletionMessage: "Supprimer"
    },
    {
      id: "sample-rtt-half-request",
      requestedAt: "2026-08-21",
      status: "Absence prise en compte",
      firstDay: "2026-09-09",
      lastDay: "2026-09-09",
      days: 0.5,
      type: "rtt",
      deletionAllowed: true,
      deletionMessage: "Supprimer"
    }
  ];
  return state;
}

test("les données personnelles ne figurent pas dans le fichier public", () => {
  assert.deepEqual(publicSeed.customDays, {});
  assert.deepEqual(publicSeed.absenceRequests, []);
  assert.deepEqual(publicSeed.deletedCustomDays, []);
  assert.deepEqual(publicSeed.deletedRequestIds, []);
  for (const settings of Object.values(publicSeed.yearSettings)) {
    assert.deepEqual(settings, {
      cpAcquired: 0,
      cpCarryOver: 0,
      rttAcquired: 0,
      solidarityDays: 0
    });
  }
});

test("les dates ISO invalides sont refusées", () => {
  assert.ok(parseIsoDate("2026-07-14"));
  assert.equal(parseIsoDate("2026-02-30"), null);
  assert.equal(parseIsoDate("14/07/2026"), null);
});

test("les intervalles excluent les week-ends et jours officiels", () => {
  assert.deepEqual(
    businessDatesBetween("2026-07-10", "2026-07-15", {
      officialDays: publicSeed.officialDays,
      contractStart: publicSeed.contractStart,
      contractEnd: publicSeed.contractEnd
    }),
    ["2026-07-10", "2026-07-15"]
  );
});

test("les demandes valides sont projetées au calendrier", () => {
  const dayMap = buildDayMap(makeSampleState());
  assert.equal(dayMap["2026-09-07"].type, "conge-paye");
  assert.equal(dayMap["2026-09-09"].type, "rtt-half");
  assert.equal(dayMap["2026-09-11"].type, "rtt");
});

test("une demande incohérente ne projette jamais plus que Nbre jours", () => {
  const state = makeSampleState();
  state.absenceRequests = [{
    id: "sample-short-request",
    requestedAt: "2026-08-01",
    status: "Test",
    firstDay: "2026-09-14",
    lastDay: "2026-09-18",
    days: 1,
    type: "rtt",
    deletionAllowed: true
  }];
  state.customDays = {};
  const dayMap = buildDayMap(state);
  const projected = Object.keys(dayMap).filter(
    (date) => dayMap[date].requestId === "sample-short-request"
  );
  assert.deepEqual(projected, ["2026-09-14"]);
});

test("les soldes sont calculés à partir d’un état privé synthétique", () => {
  assert.deepEqual(calculateYearSummary(makeSampleState(), 2026), {
    year: 2026,
    cpAcquired: 10,
    cpCarryOver: 2,
    cpRights: 12,
    cpTaken: 3,
    cpRemaining: 9,
    rttAcquired: 10,
    rttImposed: 8,
    solidarityDays: 1,
    rttTaken: 1.5,
    rttRemaining: -0.5
  });
});

test("la migration de l’ancien cache ne remplace pas les jours officiels", () => {
  const migrated = migrateLegacyHolidayData(publicSeed, {
    "2026-01-02": "conge-paye",
    "2026-09-18": "rtt"
  });
  const dayMap = buildDayMap(migrated);
  assert.equal(dayMap["2026-01-02"].type, "rtt-impose");
  assert.equal(dayMap["2026-09-18"].type, "rtt");
});

test("les suppressions privées restent supprimées après normalisation", () => {
  const seed = makeSampleState();
  const stored = structuredClone(seed);
  stored.contractStart = "2026-07-01";
  stored.contractEnd = "2026-12-31";
  stored.deletedCustomDays = ["2026-09-10"];
  delete stored.customDays["2026-09-10"];
  stored.deletedRequestIds = ["sample-cp-request"];
  stored.absenceRequests = stored.absenceRequests.filter(
    (request) => request.id !== "sample-cp-request"
  );

  const normalized = normalizeState(seed, stored);
  const dayMap = buildDayMap(normalized);
  assert.equal(normalized.contractStart, "2026-07-01");
  assert.equal(normalized.contractEnd, "2026-12-31");
  assert.equal(dayMap["2026-09-10"], undefined);
  assert.equal(dayMap["2026-09-07"], undefined);
});

test("l’import reconnaît les deux formats supportés", () => {
  assert.deepEqual(validateImport(makeSampleState()), { valid: true, kind: "v2" });
  assert.deepEqual(validateImport({ "2026-09-18": "rtt" }), {
    valid: true,
    kind: "legacy"
  });
  assert.equal(validateImport({ nope: "rtt" }).valid, false);
});

test("l’import refuse les demandes mal formées et les listes invalides", () => {
  const state = makeSampleState();
  assert.equal(validateImport({ ...state, absenceRequests: [{}] }).valid, false);
  assert.equal(validateImport({ ...state, deletedCustomDays: {} }).valid, false);

  const normalized = normalizeState(publicSeed, {
    ...publicSeed,
    deletedCustomDays: {},
    deletedRequestIds: {},
    absenceRequests: [{}]
  });
  assert.deepEqual(normalized.absenceRequests, []);
  assert.deepEqual(normalized.deletedCustomDays, []);
});

test("les demandes qui se chevauchent sont détectées", () => {
  const state = makeSampleState();
  const overlapping = {
    id: "sample-overlap",
    requestedAt: "2026-08-22",
    status: "Absence prise en compte",
    firstDay: "2026-09-07",
    lastDay: "2026-09-07",
    days: 1,
    type: "rtt",
    deletionAllowed: true,
    deletionMessage: "Supprimer"
  };
  state.absenceRequests.push(overlapping);
  assert.ok(isValidAbsenceRequest(overlapping, state));
  assert.deepEqual(findPersonalDateConflicts(state), ["2026-09-07"]);
  assert.equal(validateImport(state).valid, false);
});

test("une demande hors contrat est refusée", () => {
  const state = makeSampleState();
  state.contractStart = "2026-01-01";
  state.contractEnd = "2026-12-31";
  const outsideContract = {
    id: "sample-outside-contract",
    requestedAt: "2026-12-20",
    status: "Absence prise en compte",
    firstDay: "2027-01-04",
    lastDay: "2027-01-04",
    days: 1,
    type: "conge-paye",
    deletionAllowed: true,
    deletionMessage: "Supprimer"
  };

  assert.equal(isValidAbsenceRequest(outsideContract, state), false);
  assert.equal(validateImport({
    ...state,
    absenceRequests: [...state.absenceRequests, outsideContract]
  }).valid, false);
});
