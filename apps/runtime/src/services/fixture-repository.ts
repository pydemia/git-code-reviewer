/** Fixture 데이터는 명시적으로 등록한 데모 repository에만 적용한다. */
export function isFixtureRepository(
  mode: string,
  repository: { credentialId: string | null; installationId: string },
) {
  return mode === 'fixture' && !repository.credentialId && repository.installationId === 'fixture';
}
