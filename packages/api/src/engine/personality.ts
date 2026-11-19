import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// ─── Cartridge Schema ────────────────────────────────────────────────────────

export interface JarvisCartridge {
  identity: {
    name: string;
    fullName: string;
    vibe: string;
  };
  persona: {
    role: string;
    traits: string[];
    rules: string[];
    boundaries: string[];
  };
  provider: {
    primary: string;
    fallback: string[];
  };
}

// ─── Cartridge Loader ────────────────────────────────────────────────────────

/**
 * Loads a JARVIS personality cartridge from YAML.
 * Inspired by Nano Bots' cartridge system — edit a file, change the brain.
 */
export function loadCartridge(path?: string): JarvisCartridge {
  const cartridgePath =
    path ??
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../node_modules/@jarvis/config/jarvis-personality.yaml'
    );

  const raw = readFileSync(cartridgePath, 'utf-8');
  return yaml.load(raw) as JarvisCartridge;
}

// ─── System Prompt Builder ───────────────────────────────────────────────────

/**
 * Converts a cartridge into the system prompt that shapes every response.
 * This is the soul injection — every LLM call gets this as the system message.
 */
export function buildSystemPrompt(cartridge: JarvisCartridge): string {
  const sections: string[] = [];

  // Current date/time anchor — prevents model from using stale training dates
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
  });
  sections.push(
    `## Current Date & Time`,
    `Today is ${dateStr}, ${timeStr} IST (${now.toISOString().split('T')[0]}).`,
    `The current year is ${now.getFullYear()}. Use ONLY this date as the reference for "today", "this week", "last week", etc.`,
    ''
  );

  // Identity
  sections.push(
    `You are ${cartridge.identity.name} (${cartridge.identity.fullName}).`,
    `Vibe: ${cartridge.identity.vibe}.`,
    ''
  );

  // Role
  sections.push(`## Role`, cartridge.persona.role, '');

  // Personality traits
  sections.push(
    `## Personality`,
    ...cartridge.persona.traits.map((t) => `- ${t}`),
    ''
  );

  // Rules (hard behavioural constraints)
  sections.push(
    `## Rules — follow these without exception`,
    ...cartridge.persona.rules.map((r) => `- ${r}`),
    ''
  );

  // Boundaries
  sections.push(
    `## Boundaries`,
    ...cartridge.persona.boundaries.map((b) => `- ${b}`),
    ''
  );

  return sections.join('\n');
}
