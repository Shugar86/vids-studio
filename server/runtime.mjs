import {readFileSync} from 'node:fs';

export const PROFILE = Object.freeze(JSON.parse(readFileSync(new URL('../profile.json', import.meta.url), 'utf8')));
export const MCP_RUNTIME = Object.freeze({
  version: PROFILE.version, buildId: PROFILE.buildId,
  profileId: PROFILE.id, protocol: PROFILE.protocol,
});

export function compatibility(status) {
  const host = status?.runtime?.host;
  const extension = status?.runtime?.extension;
  const matches = (part, protocol) => part?.profileId === PROFILE.id &&
    part?.buildId === PROFILE.buildId && part?.version === PROFILE.version && part?.protocol === protocol;
  const ready = matches(host, PROFILE.protocol) && matches(extension, PROFILE.extensionProtocol);
  return {ready, expected: MCP_RUNTIME, host: host ?? null, extension: extension ?? null,
    nextStep: ready ? null : `Reload the ${PROFILE.displayName} extension card, explicitly attach the intended document, and refresh this MCP client.`};
}
