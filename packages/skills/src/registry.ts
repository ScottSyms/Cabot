// Skill registry: validated installation with trust levels and versioning.
// Trust affects installation scope and tool annotations — never the sandbox:
// no skill bypasses the Capability Broker regardless of trust.
import type { CabotTool } from '@cabot/contracts';
import {
  entrypointToolId,
  parseSkillYaml,
  type SkillManifest,
  type SkillTrustLevel,
} from './manifest.js';

export interface InstalledSkill {
  manifest: SkillManifest;
  trust: SkillTrustLevel;
  skillMd: string;
  files: Record<string, string>;
  installedAt: string;
}

export class SkillRegistryError extends Error {}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export class SkillRegistry {
  private skills = new Map<string, InstalledSkill>();

  install(yamlText: string, skillMd: string, trust: SkillTrustLevel, files: Record<string, string>): InstalledSkill {
    const manifest = parseSkillYaml(yamlText);
    if (!skillMd || skillMd.trim().length === 0) {
      throw new SkillRegistryError('SKILL.md is required and must be non-empty');
    }
    // Every declared entrypoint script must ship with the package.
    for (const [key, ep] of Object.entries(manifest.python?.entrypoints ?? {})) {
      if (!(ep.script in files)) {
        throw new SkillRegistryError(`entrypoint ${key} declares missing script ${ep.script}`);
      }
    }
    const prior = this.skills.get(manifest.name);
    if (prior && compareSemver(manifest.version, prior.manifest.version) <= 0) {
      throw new SkillRegistryError(
        `skill ${manifest.name}@${manifest.version} does not supersede installed ${prior.manifest.version}`,
      );
    }
    const installed: InstalledSkill = {
      manifest,
      trust,
      skillMd,
      files: { ...files },
      installedAt: new Date().toISOString(),
    };
    this.skills.set(manifest.name, installed);
    return installed;
  }

  get(name: string): InstalledSkill {
    const s = this.skills.get(name);
    if (!s) throw new SkillRegistryError(`skill not installed: ${name}`);
    return s;
  }

  list(): InstalledSkill[] {
    return [...this.skills.values()];
  }

  uninstall(name: string): void {
    if (!this.skills.delete(name)) throw new SkillRegistryError(`skill not installed: ${name}`);
  }

  /** Typed entry points as tools, namespaced per skill (spec §13.6). */
  toolsFor(skillName: string): CabotTool[] {
    const skill = this.get(skillName);
    const untrusted = skill.trust === 'untrusted' || skill.trust === 'agent-generated';
    return Object.entries(skill.manifest.python?.entrypoints ?? {}).map(([ep]) => ({
      id: entrypointToolId(skillName, ep),
      source: 'skill' as const,
      name: `${skillName}.${ep}`,
      description: `${skill.manifest.description} [${ep}]`,
      inputSchema: { type: 'object' },
      capabilityClass: 'reversible' as const,
      provenance: `skill:${skillName}@${skill.manifest.version}`,
      annotations: untrusted ? { untrustedContentHint: true } : undefined,
    }));
  }

  toolsForAll(): CabotTool[] {
    return this.list().flatMap((s) => this.toolsFor(s.manifest.name));
  }
}
