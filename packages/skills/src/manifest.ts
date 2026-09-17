// Skill package manifest (spec §13.4): skill.yaml + SKILL.md conventions.
// A Skill is an inspectable capability package: instructions plus typed
// entry points over Python/SQL/WASM assets. Validation is strict at install:
// unknown capabilities, undeclared filesystem scope, and network access
// beyond policy are rejected before anything executes.
import { parse as parseYaml } from 'yaml';

export type SkillTrustLevel =
  | 'builtin'
  | 'admin-approved'
  | 'user-installed'
  | 'locally-authored'
  | 'agent-generated'
  | 'untrusted';

export interface SkillEntrypoint {
  script: string;
  function?: string;
  inputSchema?: string;
  outputSchema?: string;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  requiredCapabilities: string[];
  python?: {
    runtime: 'pyodide';
    packages: string[];
    entrypoints: Record<string, SkillEntrypoint>;
  };
  network: 'none' | 'approved';
  filesystem: { read: string[]; write: string[] };
  sideEffects: string;
}

const KNOWN_CAPABILITIES = new Set([
  'workspace.read',
  'workspace.write',
  'python.execute',
  'sql.execute',
  'browser.read',
  'browser.act',
  'skill.invoke',
]);

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export class SkillValidationError extends Error {}

export function parseSkillYaml(text: string): SkillManifest {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new SkillValidationError(`skill.yaml is not valid YAML: ${String(e)}`);
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new SkillValidationError('skill.yaml must be a mapping');
  }
  const d = doc as Record<string, unknown>;
  const name = requireString(d, 'name');
  const version = requireString(d, 'version');
  const description = requireString(d, 'description');
  if (!NAME_RE.test(name)) throw new SkillValidationError(`invalid skill name: ${name}`);
  if (!VERSION_RE.test(version)) throw new SkillValidationError(`version must be semver: ${version}`);

  const capabilities = d.capabilities as Record<string, unknown> | undefined;
  const required = (capabilities?.required as unknown[]) ?? [];
  const requiredCapabilities = required.map((c, i) => {
    if (typeof c !== 'string') throw new SkillValidationError(`capabilities.required[${i}] must be a string`);
    if (!KNOWN_CAPABILITIES.has(c)) throw new SkillValidationError(`unknown capability: ${c}`);
    return c;
  });

  let python: SkillManifest['python'];
  const py = d.python as Record<string, unknown> | undefined;
  if (py !== undefined) {
    if (py.runtime !== 'pyodide') throw new SkillValidationError('python.runtime must be "pyodide"');
    const packages = py.packages as unknown;
    if (!Array.isArray(packages) || !packages.every((p) => typeof p === 'string')) {
      throw new SkillValidationError('python.packages must be a string list');
    }
    const eps = py.entrypoints as Record<string, Record<string, unknown>> | undefined;
    if (!eps || typeof eps !== 'object') throw new SkillValidationError('python.entrypoints must be a mapping');
    const entrypoints: Record<string, SkillEntrypoint> = {};
    for (const [key, ep] of Object.entries(eps)) {
      if (typeof ep.script !== 'string' || ep.script.includes('..')) {
        throw new SkillValidationError(`entrypoint ${key}: script must be a relative path without ..`);
      }
      entrypoints[key] = {
        script: ep.script,
        function: typeof ep.function === 'string' ? ep.function : undefined,
        inputSchema: typeof ep.input_schema === 'string' ? (ep.input_schema as string) : undefined,
        outputSchema: typeof ep.output_schema === 'string' ? (ep.output_schema as string) : undefined,
      };
    }
    python = { runtime: 'pyodide', packages: packages as string[], entrypoints };
  }

  const permissions = d.permissions as Record<string, unknown> | undefined;
  const network = (permissions?.network as string) ?? 'none';
  if (network !== 'none' && network !== 'approved') {
    throw new SkillValidationError('permissions.network must be "none" or "approved"');
  }
  const fs = (permissions?.filesystem as Record<string, string[]> | undefined) ?? { read: [], write: [] };
  for (const scope of ['read', 'write'] as const) {
    const list = fs[scope] ?? [];
    if (!Array.isArray(list) || !list.every((p) => typeof p === 'string' && !p.includes('..'))) {
      throw new SkillValidationError(`permissions.filesystem.${scope} must be a string list without ..`);
    }
  }
  const risk = d.risk as Record<string, unknown> | undefined;
  return {
    name,
    version,
    description,
    requiredCapabilities,
    python,
    network,
    filesystem: { read: fs.read ?? [], write: fs.write ?? [] },
    sideEffects: typeof risk?.side_effects === 'string' ? (risk.side_effects as string) : 'unknown',
  };
}

function requireString(d: Record<string, unknown>, key: string): string {
  const v = d[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new SkillValidationError(`skill.yaml: ${key} must be a non-empty string`);
  }
  return v;
}

/** Tool name for an entrypoint, namespaced so skills cannot masquerade (spec §13.6). */
export function entrypointToolId(skillName: string, entrypoint: string): string {
  return `skill.${skillName}.${entrypoint}`;
}
