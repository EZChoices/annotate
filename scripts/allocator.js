#!/usr/bin/env node
"use strict";

(function (globalScope, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    const exports = factory();
    Object.keys(exports).forEach((key) => {
      globalScope[key] = exports[key];
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
  const DEFAULT_ALPHA = 2.0;
  const UNDER_TARGET_BOOST = 1.25;
  const DEFICIT_BOOST = 1.15;

  function normalizeCategory(value) {
    if (value == null) return "unknown";
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    const text = String(value).trim().toLowerCase();
    return text || "unknown";
  }

  function getFirst(source, keys) {
    if (!source || typeof source !== "object") return undefined;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key) && source[key] != null) {
        const value = source[key];
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed) return value;
        } else {
          return value;
        }
      }
    }
    return undefined;
  }

  function makeCellKey(cellLike) {
    if (typeof cellLike === "string") {
      const trimmed = cellLike.trim();
      if (!trimmed) return "unknown:unknown:unknown:unknown";
      const normalized = trimmed.toLowerCase();
      if (normalized.includes(":")) return normalized;
      return `${normalized}:unknown:unknown:unknown`;
    }

    const source = cellLike && typeof cellLike === "object" ? cellLike : {};
    const dialectFamily =
      getFirst(source, [
        "dialect_family",
        "dialectFamily",
        "dialect_family_code",
        "dialect_family_label",
        "dialect",
        "family",
      ]) || "unknown";
    const subregion =
      getFirst(source, [
        "subregion",
        "dialect_subregion",
        "dialectSubregion",
        "dialect_region",
        "region",
        "province",
      ]) || "unknown";
    const gender =
      getFirst(source, [
        "apparent_gender",
        "apparentGender",
        "gender",
        "gender_norm",
        "speaker_gender",
      ]) || "unknown";
    const age =
      getFirst(source, [
        "apparent_age_band",
        "apparentAgeBand",
        "age_band",
        "ageBand",
        "age",
        "age_group",
        "ageGroup",
      ]) || "unknown";

    return [dialectFamily, subregion, gender, age].map(normalizeCategory).join(":");
  }

  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
  }

  function computeWeights(snapshot, options = {}) {
    const alphaOption = options && Number.isFinite(options.alpha) ? Number(options.alpha) : DEFAULT_ALPHA;
    const alpha = alphaOption > 0 ? alphaOption : DEFAULT_ALPHA;
    const cells = Array.isArray(snapshot && snapshot.cells) ? snapshot.cells : [];
    const weightMap = new Map();
    let totalWeight = 0;

    cells.forEach((cell) => {
      if (!cell || typeof cell !== "object") return;
      const directKey =
        typeof cell.cell_key === "string" && cell.cell_key.trim()
          ? cell.cell_key.trim().toLowerCase()
          : null;
      const resolvedKey = directKey && directKey.includes(":") ? directKey : makeCellKey(cell);

      const target = Number(cell.target);
      if (!Number.isFinite(target) || target <= 0) return;
      const rawCount = Number(cell.count);
      const count = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : 0;
      const pct = clamp01(target > 0 ? count / target : 0);
      let score = Math.pow(1 - pct, alpha);
      if (!Number.isFinite(score) || score <= 0) return;

      if (pct < 0.5) {
        score *= UNDER_TARGET_BOOST;
      }

      const deficit = Number(cell.deficit);
      if (Number.isFinite(deficit) && deficit >= 20) {
        score *= DEFICIT_BOOST;
      }

      const current = weightMap.get(resolvedKey) || 0;
      weightMap.set(resolvedKey, current + score);
      totalWeight += score;
    });

    if (totalWeight <= 0) {
      // Ensure all tracked keys exist with zero weight for downstream consumers.
      weightMap.forEach((_, key) => weightMap.set(key, 0));
      return weightMap;
    }

    weightMap.forEach((value, key) => {
      weightMap.set(key, value / totalWeight);
    });

    return weightMap;
  }

  function pickCell(weights, rng = Math.random) {
    if (!weights) return null;
    const entries =
      weights instanceof Map
        ? Array.from(weights.entries())
        : typeof weights === "object"
        ? Object.entries(weights)
        : [];

    if (!entries.length) return null;

    const filtered = entries.filter(([, value]) => Number.isFinite(value) && value > 0);
    if (!filtered.length) {
      return entries[entries.length - 1][0];
    }

    const total = filtered.reduce((acc, [, value]) => acc + value, 0);
    if (!(total > 0)) {
      return filtered[filtered.length - 1][0];
    }

    const randomSource = typeof rng === "function" ? rng : Math.random;
    const roll = clamp01(randomSource()) * total;
    let cumulative = 0;
    for (const [key, value] of filtered) {
      cumulative += value;
      if (roll <= cumulative) {
        return key;
      }
    }
    return filtered[filtered.length - 1][0];
  }

  return {
    DEFAULT_ALPHA,
    computeWeights,
    pickCell,
  };
});
