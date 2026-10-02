// Replaces canvas-mcp src/canvas_mcp/core/credentials.py: instead of a context variable that any code can read,
// a provider object decides per request whether a Canvas credential exists for the caller.
import type { Config, CredentialProvider, Secrets } from '../types';
import { createOwnerSecretProvider } from './owner-secret-provider';
import type { ProviderOptions } from './owner-secret-provider';

/**
 * The credential provider for this deployment. Build one per request: it
 * holds the request's secrets and must not outlive it.
 */
export function createCredentialProvider(config: Config, secrets: Secrets, options: ProviderOptions = {}): CredentialProvider {
  return createOwnerSecretProvider(config, secrets, options);
}
