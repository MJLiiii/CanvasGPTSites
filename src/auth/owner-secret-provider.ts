// Replaces the per-request X-Canvas-Token handling in canvas-mcp src/canvas_mcp/server.py and core/credentials.py:
// here the token is the Site owner's secret, and it is released only to a request the gateway attributes to the owner.
import { constantTimeEqual, hmacSha256Hex, sha256Hex } from '../core/hash';
import type {
  AuthorizeResult,
  CanvasCredential,
  Config,
  CredentialProvider,
  CredentialResult,
  Identity,
  Logger,
  Secrets,
} from '../types';

/** One sentence for every refusal, whatever its cause, so a caller learns nothing about the configuration. */
export const NOT_AUTHORIZED_PUBLIC_MESSAGE = 'Not authorized. This is a private deployment.';
export const NOT_CONFIGURED_PUBLIC_MESSAGE = 'Canvas credentials are unavailable.';

const CALLER_KEY_LABEL = 'canvas-gpt-sites/caller-id/v1|';

export interface OwnerMatch {
  ok: boolean;
  /** The match rests on the email alone: an id hash is configured and the request carried no id. */
  idHeaderAbsent: boolean;
}

/**
 * Whether `identity` is the configured owner. The email must match exactly.
 * When OWNER_USER_ID_SHA256 is configured and the gateway sent a user id, the
 * id must match too; a request without the id header passes on the email,
 * because ChatGPT Work guarantees the email header but not the id.
 */
export function matchOwner(config: Config, identity: Identity | null): OwnerMatch {
  const denied: OwnerMatch = { ok: false, idHeaderAbsent: false };
  if (identity === null || identity.email === null || config.ownerEmail === null) {
    return denied;
  }
  if (!constantTimeEqual(identity.email, config.ownerEmail)) {
    return denied;
  }
  if (config.ownerUserIdSha256 === null) {
    return { ok: true, idHeaderAbsent: false };
  }
  if (identity.userId === null) {
    return { ok: true, idHeaderAbsent: true };
  }
  return constantTimeEqual(sha256Hex(identity.userId), config.ownerUserIdSha256)
    ? { ok: true, idHeaderAbsent: false }
    : denied;
}

/**
 * A stable handle for the Canvas caller that cannot be turned back into the
 * token. Upstream keys this hash with its confirmation secret; here the key
 * is derived from the token, so a deployment without that secret still has one.
 */
export function callerIdFor(token: string): string {
  return hmacSha256Hex(sha256Hex(`${CALLER_KEY_LABEL}${token}`), 'caller');
}

export interface ProviderOptions {
  log?: Logger;
}

/**
 * The v1 provider: one Canvas token, the owner's, held as a Site secret.
 * `resolve` is the only code that hands the token out, and it checks the
 * caller itself instead of trusting that a gate ran earlier.
 */
export function createOwnerSecretProvider(config: Config, secrets: Secrets, options: ProviderOptions = {}): CredentialProvider {
  const denied: AuthorizeResult = Object.freeze({ ok: false, status: 403, publicMessage: NOT_AUTHORIZED_PUBLIC_MESSAGE });
  // The gate, runTool and resolve each authorize the same request; one log line is enough.
  let idAbsenceLogged = false;

  const authorize = (identity: Identity | null): AuthorizeResult => {
    const match = matchOwner(config, identity);
    if (!match.ok) return denied;
    if (match.idHeaderAbsent && !idAbsenceLogged) {
      idAbsenceLogged = true;
      options.log?.security('owner_id_header_absent', {
        note: 'OWNER_USER_ID_SHA256 is configured but the request carried no user id; authorized on the email alone',
      });
    }
    return { ok: true };
  };

  return Object.freeze({
    mode: 'owner' as const,
    authorize,
    async resolve(identity: Identity | null): Promise<CredentialResult> {
      const allowed = authorize(identity);
      if (!allowed.ok) {
        return { ok: false, reason: 'forbidden', publicMessage: allowed.publicMessage };
      }
      // Any configuration violation withholds the token, including the ones that only block invocation.
      if (
        config.errors.length > 0 ||
        config.diagnosticsEnabled ||
        secrets.canvasToken === null ||
        config.canvasApiUrl === null ||
        config.canvasOrigin === null
      ) {
        return { ok: false, reason: 'not_configured', publicMessage: NOT_CONFIGURED_PUBLIC_MESSAGE };
      }
      const credential: CanvasCredential = {
        apiBaseUrl: config.canvasApiUrl,
        origin: config.canvasOrigin,
        token: secrets.canvasToken,
        callerId: callerIdFor(secrets.canvasToken),
        kind: 'owner-secret',
      };
      return { ok: true, credential };
    },
  });
}
