import type { DatabaseClient } from '@gcr/db';

// The caller holds the user-administration advisory lock, then the user row.
// P04's issuance and verification adapters must consume this same durable epoch.
export async function revokeUserClientCredentials(client: DatabaseClient, userId: string) {
  const result = await client.query<{ epoch: string }>(
    `insert into user_client_credential_epochs(user_id) values($1)
     on conflict(user_id) do update set epoch=user_client_credential_epochs.epoch+1,
       revoked_at=clock_timestamp() returning epoch`,
    [userId],
  );
  return result.rows[0]!.epoch;
}

// Local access is revoked in the same transaction as its durable remote work.
// A remote failure can never roll this transaction back or restore freshness.
export async function revokeUserIdentitySecurity(
  client: DatabaseClient,
  userId: string,
  options: { readonly disableAtIdentityProvider?: boolean } = {},
) {
  await client.query('select id from users where id=$1 for update', [userId]);
  await client.query('delete from user_sessions where user_id=$1', [userId]);
  await revokeUserClientCredentials(client, userId);
  const identities = await client.query<{
    id: string;
    security_epoch: string;
    idp_disabled_by_gcr: boolean;
  }>(
    `update user_identities set security_epoch=security_epoch+1,
      security_checked_at=null,security_fresh_until=null,security_login_after=clock_timestamp(),
      idp_disabled_by_gcr=idp_disabled_by_gcr or $2,
      updated_at=clock_timestamp() where user_id=$1 returning id,security_epoch,idp_disabled_by_gcr`,
    [userId, options.disableAtIdentityProvider === true],
  );
  for (const identity of identities.rows)
    await client.query(
      `insert into identity_security_logout_outbox(identity_id,security_epoch,desired_enabled) values($1,$2,$3)
     on conflict(identity_id) do update set security_epoch=excluded.security_epoch,
       desired_enabled=excluded.desired_enabled,
       available_at=clock_timestamp(),claim_id=null,claimed_until=null,attempt_count=0,last_error_code=null`,
      [identity.id, identity.security_epoch, identity.idp_disabled_by_gcr ? false : null],
    );
}
