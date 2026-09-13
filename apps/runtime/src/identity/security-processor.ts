import type { Database } from '@gcr/db';
import type { SamlProviderBinding } from '../auth/saml-state.js';
import { KeycloakAdminError } from './keycloak-admin.js';
import { KeycloakSecurityClient, KeycloakSecurityError } from './keycloak-security.js';
import { withIdentityRemoteLease } from './remote-lease.js';
import { completeIdentityRevocations } from './lifecycle.js';
import {
  applySecurityObservation,
  claimIdentitySecurityLogout,
  claimSecurityObservation,
  completeIdentitySecurityLogout,
  confirmIdentitySecurityProfile,
  failIdentitySecurityLogout,
  failSecurityObservation,
  IdentitySecurityStateError,
  listSecurityProfileTargets,
  rejectIdentitySecurityProfile,
  pruneIdentitySecurityState,
  inspectIdentitySecurityLogout,
} from './security-state.js';

export type IdentitySecurityAdministration = Pick<
  KeycloakSecurityClient,
  'endpoints' | 'capture' | 'getUser' | 'identity' | 'logoutAll' | 'setEnabled' | 'withRequestGuard'
>;
const leaseLost = (error: unknown) =>
  error instanceof IdentitySecurityStateError && error.code === 'IDENTITY_SECURITY_LEASE_LOST';

// A bounded background pass. Remote calls are outside SQL transactions, and all
// effects are fenced again on commit. HTTP/worker health loops do not await it.
export async function reconcileIdentitySecurity(
  database: Database,
  binding: SamlProviderBinding,
  adapter: IdentitySecurityAdministration,
) {
  if (
    adapter.endpoints.issuer !== binding.issuer ||
    adapter.endpoints.entityId !== binding.entityId
  )
    throw new IdentitySecurityStateError('IDENTITY_SECURITY_OBSERVATION_INVALID');
  const work = await withIdentityRemoteLease(database, binding.issuer, ({ assertHeld }) =>
    adapter.withRequestGuard(assertHeld, () => reconcileClaim(database, binding, adapter)),
  );
  return work.acquired ? work.result : { observed: false, loggedOut: false, profilesConfirmed: 0 };
}
async function reconcileClaim(
  database: Database,
  binding: SamlProviderBinding,
  adapter: IdentitySecurityAdministration,
) {
  let observed = false,
    loggedOut = false,
    profilesConfirmed = 0;
  const lease = await claimSecurityObservation(database, binding);
  if (lease) {
    try {
      const observation = await adapter.capture(lease.previous);
      await applySecurityObservation(database, binding, lease, observation);
      observed = true;
    } catch (error) {
      if (error instanceof IdentitySecurityStateError) {
        if (!leaseLost(error)) throw error;
      } else {
        try {
          await failSecurityObservation(
            database,
            binding,
            lease,
            error instanceof KeycloakSecurityError ? error.code : 'IDENTITY_ADMIN_UNAVAILABLE',
            error instanceof KeycloakSecurityError,
          );
        } catch (failure) {
          if (!leaseLost(failure)) throw failure;
        }
      }
    }
  }
  const logout = await claimIdentitySecurityLogout(database, binding);
  if (logout) {
    try {
      try {
        await inspectIdentitySecurityLogout(database, logout);
        if (logout.desiredEnabled === false) {
          if ((await adapter.getUser(logout.keycloakUserId)).enabled)
            await adapter.setEnabled(logout.keycloakUserId, false);
          await inspectIdentitySecurityLogout(database, logout);
        }
        await adapter.logoutAll(logout.keycloakUserId);
        if (
          logout.desiredEnabled === false &&
          (await adapter.getUser(logout.keycloakUserId)).enabled
        )
          throw new KeycloakAdminError('IDENTITY_RESULT_UNCONFIRMED');
      } catch (error) {
        // A deleted account has no IdP session to preserve. No access is granted
        // here; a missing profile still cannot pass the independent final check.
        if (!(error instanceof KeycloakAdminError && error.code === 'IDENTITY_ACCOUNT_NOT_FOUND'))
          throw error;
      }
      await completeIdentitySecurityLogout(database, logout);
      loggedOut = true;
    } catch (error) {
      if (error instanceof IdentitySecurityStateError) {
        if (!leaseLost(error)) throw error;
      } else {
        try {
          await failIdentitySecurityLogout(database, logout);
        } catch (failure) {
          if (!leaseLost(failure)) throw failure;
        }
      }
    }
  }
  for (const target of await listSecurityProfileTargets(database, binding)) {
    try {
      const profile = await adapter.getUser(target.keycloakUserId);
      const proof = adapter.identity(profile);
      if (
        await confirmIdentitySecurityProfile(database, binding, target, {
          ...proof,
          keycloakUserId: profile.id,
          enabled: profile.enabled,
        })
      )
        profilesConfirmed++;
    } catch (error) {
      // No profile error is treated as evidence of a fresh identity. The event
      // epoch/tombstones stay in force and the last verified bound expires.
      if (error instanceof IdentitySecurityStateError) throw error;
      if (
        error instanceof KeycloakAdminError &&
        [
          'IDENTITY_ACCOUNT_NOT_FOUND',
          'IDENTITY_PROFILE_INVALID',
          'IDENTITY_NAME_ID_UNINITIALIZED',
        ].includes(error.code)
      )
        await rejectIdentitySecurityProfile(database, binding, target);
    }
  }
  if (observed) await pruneIdentitySecurityState(database);
  await completeIdentityRevocations(database, binding);
  return { observed, loggedOut, profilesConfirmed };
}
