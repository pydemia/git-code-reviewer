import type { Database } from '@gcr/db';
import {
  linkExistingSamlIdentity,
  SamlStateError,
  type SamlProviderBinding,
} from '../auth/saml-state.js';
import { KeycloakAdminClient, KeycloakAdminError, type KeycloakUser } from './keycloak-admin.js';
import { withIdentityRemoteLease } from './remote-lease.js';
import {
  beginIdentityMailDispatch,
  claimIdentityOperation,
  completeIdentityMailDispatch,
  completeIdentityProvisioning,
  failIdentityOperation,
  IdentityOperationError,
  inspectIdentityOperationClaim,
} from './operations.js';

export type IdentityAdministration = Pick<
  KeycloakAdminClient,
  | 'endpoints'
  | 'ensureCreated'
  | 'getUser'
  | 'identity'
  | 'setEnabled'
  | 'sendActionsEmail'
  | 'logoutAll'
  | 'withRequestGuard'
>;

export async function processIdentityOperation(
  database: Database,
  binding: SamlProviderBinding,
  adapter: IdentityAdministration,
): Promise<boolean> {
  if (
    adapter.endpoints.issuer !== binding.issuer ||
    adapter.endpoints.entityId !== binding.entityId
  )
    throw new IdentityOperationError('IDENTITY_OPERATION_INVALID');
  const work = await withIdentityRemoteLease(database, binding.issuer, ({ assertHeld }) =>
    adapter.withRequestGuard(assertHeld, () => processClaim(database, binding, adapter)),
  );
  return work.acquired ? work.result : false;
}
async function processClaim(
  database: Database,
  binding: SamlProviderBinding,
  adapter: IdentityAdministration,
): Promise<boolean> {
  const claim = await claimIdentityOperation(database, binding);
  if (!claim) return false;
  try {
    const { operation } = await inspectIdentityOperationClaim(database, claim);
    if (operation.mail_dispatched_at) throw new KeycloakAdminError('IDENTITY_EMAIL_UNCONFIRMED');
    if (operation.kind === 'invite' || operation.kind === 'password-reset') {
      if (!operation.external_user_id || !operation.expected_name_id || !operation.requested_email)
        throw new IdentityOperationError('IDENTITY_OPERATION_INVALID');
      const user = await adapter.getUser(operation.external_user_id);
      if (adapter.identity(user).nameID !== operation.expected_name_id)
        throw new KeycloakAdminError('IDENTITY_ACCOUNT_CONFLICT');
      if (operation.kind === 'password-reset') await adapter.logoutAll(user.id);
      await beginIdentityMailDispatch(database, claim);
      await adapter.sendActionsEmail(user.id, operation.requested_email, operation.kind);
      await completeIdentityMailDispatch(database, claim);
      return true;
    }
    let external: KeycloakUser;
    if (operation.kind === 'create') {
      if (
        !operation.user_id ||
        !operation.requested_username ||
        !operation.requested_email ||
        !operation.requested_display_name
      )
        throw new IdentityOperationError('IDENTITY_OPERATION_INVALID');
      external = await adapter.ensureCreated({
        operationId: operation.id,
        userId: operation.user_id,
        username: operation.requested_username,
        email: operation.requested_email,
        displayName: operation.requested_display_name,
      });
    } else if (operation.kind === 'link') {
      if (!operation.external_user_id)
        throw new IdentityOperationError('IDENTITY_OPERATION_INVALID');
      external = await adapter.getUser(operation.external_user_id);
      if (
        external.username !== operation.requested_username ||
        external.email !== operation.requested_email ||
        adapter.identity(external).nameID !== operation.expected_name_id
      )
        throw new KeycloakAdminError('IDENTITY_ACCOUNT_CONFLICT');
    } else {
      throw new IdentityOperationError('IDENTITY_OPERATION_INVALID');
    }
    const identity = adapter.identity(external);
    await inspectIdentityOperationClaim(database, claim);
    const identityId = await linkExistingSamlIdentity(database, binding, {
      actorId: operation.requested_by!,
      userId: operation.user_id!,
      expectedSubject: operation.expected_subject,
      keycloakUserId: external.id,
      identity,
    });
    const { userEnabled } = await inspectIdentityOperationClaim(database, claim);
    // Explicitly linked existing IdP accounts keep their enabled state. Creating
    // a companion account may enable it only while the GCR request remains live.
    if (operation.kind === 'create')
      external = await adapter.setEnabled(external.id, operation.creates_app_user || userEnabled);
    const verified = adapter.identity(external);
    if (verified.nameID !== identity.nameID)
      throw new KeycloakAdminError('IDENTITY_ACCOUNT_CONFLICT');
    await completeIdentityProvisioning(database, claim, {
      identityId,
      keycloakUserId: external.id,
      enabled: external.enabled,
    });
  } catch (error) {
    if (error instanceof IdentityOperationError && error.code === 'IDENTITY_OPERATION_LEASE_LOST')
      return true;
    const code =
      error instanceof KeycloakAdminError ||
      error instanceof IdentityOperationError ||
      error instanceof SamlStateError
        ? error.code
        : 'IDENTITY_ADMIN_UNAVAILABLE';
    const retryable =
      error instanceof KeycloakAdminError
        ? error.retryable
        : error instanceof SamlStateError
          ? error.code === 'SAML_STORAGE_UNAVAILABLE'
          : error instanceof IdentityOperationError
            ? error.code === 'IDENTITY_OPERATION_STORAGE_UNAVAILABLE'
            : false;
    try {
      await failIdentityOperation(database, claim, code, retryable);
    } catch (failure) {
      if (!(
        failure instanceof IdentityOperationError &&
        failure.code === 'IDENTITY_OPERATION_LEASE_LOST'
      ))
        throw failure;
    }
  }
  return true;
}
