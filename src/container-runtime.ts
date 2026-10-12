/**
 * Container runtime constants.
 *
 * This file used to claim that "all runtime-specific logic lives here so
 * swapping runtimes means changing one file" while the actual runtime logic —
 * spawn argv, mounts, hardening, kill/stop, orphan reaping — lived in
 * `container-runner.ts` and the egress module. That logic now lives behind the
 * driver seam (`src/drivers/`), which is what makes the claim true.
 *
 * What is left is the binary name, still needed by the few paths that shell
 * Docker for something that is not a session: per-group image builds and the
 * egress lockdown network.
 */

import { execFileSync } from 'child_process';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

let rootlessCache: boolean | undefined;

/**
 * Whether the Docker daemon runs rootless. Under rootless Docker the host
 * user is container uid 0 and every other container uid lands in the
 * subordinate range, so the "run as the host uid" mapping that keeps bind
 * mounts writable on rootful Docker breaks them here. Probed once per host
 * process; a failed probe means rootful (unchanged trunk behavior).
 */
export function isRootlessDocker(): boolean {
  if (rootlessCache === undefined) {
    try {
      const out = execFileSync(CONTAINER_RUNTIME_BIN, ['info', '--format', '{{json .SecurityOptions}}'], {
        stdio: 'pipe',
        timeout: 10_000,
      }).toString();
      rootlessCache = /name=rootless/.test(out);
    } catch {
      rootlessCache = false;
    }
  }
  return rootlessCache;
}
