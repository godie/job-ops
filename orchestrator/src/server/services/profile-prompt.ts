/**
 * Profile sanitization for LLM prompts.
 *
 * Only the fields a model needs to reason about CV fit are kept; contact
 * details, ids, and any other profile noise never leave the process. This
 * lives in its own module so it can be reused without importing the whole
 * scorer.
 */

type ProfileRecord = Record<string, unknown>;

export function sanitizeProfileForPrompt(
  profile: Record<string, unknown>,
): Record<string, unknown> {
  return {
    basics: sanitizeBasics(profile.basics),
    skills: sanitizeItems(profile, "skills", [
      "name",
      "description",
      "level",
      "proficiency",
      "keywords",
    ]),
    experience: sanitizeItems(profile, "experience", [
      "company",
      "position",
      "location",
      "date",
      "period",
      "summary",
      "description",
    ]),
    projects: sanitizeItems(profile, "projects", [
      "name",
      "description",
      "date",
      "period",
      "summary",
      "keywords",
    ]),
    education: sanitizeItems(profile, "education", [
      "school",
      "institution",
      "degree",
      "area",
      "grade",
      "location",
      "date",
      "period",
      "summary",
      "description",
    ]),
    languages: sanitizeItems(profile, "languages", [
      "language",
      "fluency",
      "level",
    ]),
    awards: sanitizeItems(profile, "awards", [
      "title",
      "awarder",
      "date",
      "summary",
      "description",
    ]),
    certifications: sanitizeItems(profile, "certifications", [
      "title",
      "issuer",
      "date",
      "summary",
      "description",
    ]),
    publications: sanitizeItems(profile, "publications", [
      "title",
      "publisher",
      "date",
      "summary",
      "description",
    ]),
    volunteer: sanitizeItems(profile, "volunteer", [
      "organization",
      "position",
      "location",
      "date",
      "period",
      "summary",
      "description",
    ]),
    interests: sanitizeItems(profile, "interests", [
      "name",
      "summary",
      "description",
      "keywords",
    ]),
  };
}

function sanitizeBasics(value: unknown): ProfileRecord {
  if (!isRecord(value)) return {};
  return pickDefined(value, ["label", "headline", "summary", "location"]);
}

function sanitizeItems(
  profile: ProfileRecord,
  sectionKey: string,
  allowedKeys: string[],
): ProfileRecord[] {
  return collectSectionItems(profile, sectionKey)
    .filter(isVisibleCvItem)
    .map((item) => sanitizeCvItem(item, allowedKeys))
    .filter((item) => Object.keys(item).length > 0);
}

function collectSectionItems(
  profile: ProfileRecord,
  sectionKey: string,
): ProfileRecord[] {
  const sections = isRecord(profile.sections) ? profile.sections : {};
  const section = sections[sectionKey];

  if (isRecord(section)) {
    if (!isVisibleCvItem(section)) return [];
    if (Array.isArray(section.items)) {
      return section.items.filter(isRecord);
    }
  }

  const topLevelSection = profile[sectionKey];
  if (Array.isArray(topLevelSection)) return topLevelSection.filter(isRecord);
  if (isRecord(topLevelSection)) {
    if (!isVisibleCvItem(topLevelSection)) return [];
    if (Array.isArray(topLevelSection.items)) {
      return topLevelSection.items.filter(isRecord);
    }
  }

  return [];
}

function sanitizeCvItem(
  item: ProfileRecord,
  allowedKeys: string[],
): ProfileRecord {
  const sanitized = pickDefined(item, allowedKeys);
  if (Array.isArray(item.roles)) {
    const roles = item.roles
      .filter(isRecord)
      .filter(isVisibleCvItem)
      .map((role) =>
        pickDefined(role, ["position", "period", "summary", "description"]),
      )
      .filter((role) => Object.keys(role).length > 0);
    if (roles.length > 0) sanitized.roles = roles;
  }
  return sanitized;
}

function pickDefined(source: ProfileRecord, keys: string[]): ProfileRecord {
  const result: ProfileRecord = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") {
      result[key] = value;
    }
  }
  return result;
}

function isVisibleCvItem(item: ProfileRecord): boolean {
  if (item.hidden === true) return false;
  if (item.visible === false) return false;
  return true;
}

function isRecord(value: unknown): value is ProfileRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
