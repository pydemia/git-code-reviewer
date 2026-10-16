const testDirectory = /(^|\/)(__tests__|tests?|specs?)(\/|$)/;
const testFile =
  /(^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:py|go|rs)|[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?|py)|[^/]*(?:test|tests)\.(?:java|kt|kts|cs))$/;

/** Classifies conventional test source paths without matching names such as contest.ts. */
export function isTestCodePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  return testDirectory.test(normalized) || testFile.test(normalized);
}
