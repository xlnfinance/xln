/**
 * Scenario Loader
 *
 * Load scenarios from files or URLs
 */

import { readFile } from 'fs/promises';
import { parseScenario } from './parser.js';
import type { ParsedScenario } from './types.js';

/**
 * Load scenario from file path
 */
export async function loadScenarioFromFile(filePath: string): Promise<ParsedScenario> {
  const content = await readFile(filePath, 'utf-8');
  return parseScenario(content);
}

/**
 * Load scenario from text content
 */
export function loadScenarioFromText(content: string): ParsedScenario {
  return parseScenario(content);
}

/**
 * Load scenario from base64-encoded URL parameter
 */
export function loadScenarioFromURL(base64Content: string): ParsedScenario {
  const decoded = Buffer.from(base64Content, 'base64').toString('utf-8');
  return parseScenario(decoded);
}

/**
 * Encode scenario to base64 for URL sharing
 */
export function encodeScenarioForURL(content: string): string {
  return Buffer.from(content, 'utf-8').toString('base64');
}

/**
 * Validate and report scenario parsing results
 */
export function validateScenario(parsed: ParsedScenario): boolean {
  if (parsed.errors.length > 0) {
    console.error('❌ Scenario has errors:');
    for (const error of parsed.errors) {
      console.error(
        `  Line ${error.lineNumber}: ${error.message}${error.context ? `\n    ${error.context}` : ''}`
      );
    }
    return false;
  }

  if (parsed.warnings.length > 0) {
    console.warn('⚠️  Scenario has warnings:');
    for (const warning of parsed.warnings) {
      console.warn(
        `  Line ${warning.lineNumber}: ${warning.message}${warning.suggestion ? `\n    💡 ${warning.suggestion}` : ''}`
      );
    }
  }

  console.log('✅ Scenario parsed successfully');
  console.log(`  Seed: "${parsed.scenario.seed}"`);
  console.log(`  Events: ${parsed.scenario.events.length}`);
  console.log(`  Repeat blocks: ${parsed.scenario.repeatBlocks.length}`);

  return true;
}
