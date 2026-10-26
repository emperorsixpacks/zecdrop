export function verifierOrigin(apiUrl: string | undefined): string | null;
export function contentSecurityPolicy(apiUrl: string | undefined): string;
export const CLIENT_ROUTES: readonly string[];
export interface HostedConfig {
  $schema: string;
  rewrites: { source: string; destination: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
}
export function buildHostedConfig(options: { apiUrl: string | undefined }): HostedConfig;
export function matchSource(source: string, pathname: string): boolean;
