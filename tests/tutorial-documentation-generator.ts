#!/usr/bin/env bun

/**
 * 🎯 TUTORIAL DOCUMENTATION GENERATOR
 *
 * Automatically generates beautiful tutorial documentation from E2E test scenarios.
 * This ensures tutorials stay in sync with actual working code.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

interface TutorialStep {
  number: number;
  title: string;
  description: string;
  explanation?: string;
  screenshotPath?: string;
  codeSnippet?: string;
}

interface Tutorial {
  title: string;
  description: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimatedTime: string;
  steps: TutorialStep[];
}

class TutorialDocGenerator {
  private tutorialSpecs: string[] = [];
  private outputDir = 'docs/tutorials';

  constructor() {
    // Find all tutorial test files
    this.findTutorialSpecs();
  }

  private findTutorialSpecs() {
    const e2eDir = 'e2e';
    const files = readdirSync(e2eDir);

    this.tutorialSpecs = files
      .filter(file => file.includes('tutorial') && file.endsWith('.spec.ts'))
      .map(file => join(e2eDir, file));

    console.log(`📁 Found ${this.tutorialSpecs.length} tutorial specs:`, this.tutorialSpecs);
  }

  async generateAllTutorials() {
    console.log('🔄 Generating tutorial documentation...');

    for (const specPath of this.tutorialSpecs) {
      await this.generateTutorialFromSpec(specPath);
    }

    // Generate index page
    await this.generateTutorialIndex();

    console.log('✅ Tutorial documentation generated successfully!');
  }

  private async generateTutorialFromSpec(specPath: string) {
    console.log(`📖 Processing: ${specPath}`);

    const content = readFileSync(specPath, 'utf-8');
    const tutorials = this.extractTutorialsFromSpec(content, specPath);

    for (const tutorial of tutorials) {
      await this.generateMarkdownFile(tutorial, specPath);
    }
  }

  private extractTutorialsFromSpec(content: string, specPath: string): Tutorial[] {
    const tutorials: Tutorial[] = [];

    // Extract test cases that are tutorials
    const testMatches = content.match(/test\(['"`]([^'"`]*tutorial[^'"`]*)['"``]\s*,\s*async.*?\{([\s\S]*?)\}\);/gi);

    if (!testMatches) return tutorials;

    for (const testMatch of testMatches) {
      const tutorial = this.parseTutorialTest(testMatch, specPath);
      if (tutorial) {
        tutorials.push(tutorial);
      }
    }

    return tutorials;
  }

  private parseTutorialTest(testContent: string, specPath: string): Tutorial | null {
    // Extract test title
    const titleMatch = testContent.match(/test\(['"`]([^'"`]*)['"``]/);
    if (!titleMatch) return null;

    const title = titleMatch[1].replace(/🎯|🚀|📖/g, '').trim();

    // Extract difficulty and time from title/comments
    let difficulty: 'beginner' | 'intermediate' | 'advanced' = 'beginner';
    let estimatedTime = '5 minutes';

    if (title.toLowerCase().includes('complete') || title.toLowerCase().includes('advanced')) {
      difficulty = 'advanced';
      estimatedTime = '15 minutes';
    } else if (title.toLowerCase().includes('quick') || title.toLowerCase().includes('60 seconds')) {
      difficulty = 'beginner';
      estimatedTime = '2 minutes';
    }

    // Extract tutorial steps
    const steps = this.extractTutorialSteps(testContent);

    // Extract description from comments
    const descriptionMatch = testContent.match(/\/\*\*[\s\S]*?\*\//);
    let description = 'Learn the XLN workflow step by step.';

    if (descriptionMatch) {
      description =
        descriptionMatch[0]
          .replace(/\/\*\*|\*\//g, '')
          .replace(/\*\s?/g, '')
          .trim()
          .split('\n')
          .slice(1) // Skip first line (usually title)
          .join(' ')
          .replace(/\s+/g, ' ')
          .substring(0, 200) + '...';
    }

    return {
      title,
      description,
      difficulty,
      estimatedTime,
      steps,
    };
  }

  private extractTutorialSteps(testContent: string): TutorialStep[] {
    const steps: TutorialStep[] = [];

    // Find all tutorial.runStep calls
    const stepMatches = testContent.match(/await\s+tutorial\.runStep\(\{([\s\S]*?)\}\s*,\s*(\d+)\);/g);

    if (!stepMatches) return steps;

    for (const stepMatch of stepMatches) {
      const step = this.parseIndividualStep(stepMatch);
      if (step) {
        steps.push(step);
      }
    }

    return steps;
  }

  private parseIndividualStep(stepContent: string): TutorialStep | null {
    // Extract step number
    const numberMatch = stepContent.match(/,\s*(\d+)\);$/);
    if (!numberMatch) return null;
    const number = parseInt(numberMatch[1]);

    // Extract title
    const titleMatch = stepContent.match(/title:\s*["'`]([^"'`]*)["'`]/);
    if (!titleMatch) return null;
    const title = titleMatch[1];

    // Extract description
    const descMatch = stepContent.match(/description:\s*["'`]([^"'`]*)["'`]/);
    const description = descMatch ? descMatch[1] : '';

    // Extract explanation
    const explMatch = stepContent.match(/explanation:\s*["'`]([^"'`]*)["'`]/);
    const explanation = explMatch ? explMatch[1] : undefined;

    // Generate screenshot path
    const screenshotPath = `tutorial-step-${number.toString().padStart(2, '0')}-${title.toLowerCase().replace(/\s+/g, '-')}.png`;

    return {
      number,
      title,
      description,
      explanation,
      screenshotPath,
    };
  }

  private async generateMarkdownFile(tutorial: Tutorial, specPath: string) {
    const fileName = tutorial.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.md';
    const filePath = join(this.outputDir, fileName);

    const markdown = this.generateTutorialMarkdown(tutorial, specPath);

    // Ensure output directory exists
    const outputDirPath = dirname(filePath);
    if (!existsSync(outputDirPath)) {
      await import('fs').then(fs => fs.mkdirSync(outputDirPath, { recursive: true }));
    }

    writeFileSync(filePath, markdown);
    console.log(`✅ Generated: ${filePath}`);
  }

  private generateTutorialMarkdown(tutorial: Tutorial, specPath: string): string {
    const difficultyEmoji = {
      beginner: '🟢',
      intermediate: '🟡',
      advanced: '🔴',
    };

    return `# ${tutorial.title}

${difficultyEmoji[tutorial.difficulty]} **Difficulty:** ${tutorial.difficulty.charAt(0).toUpperCase() + tutorial.difficulty.slice(1)}
⏱️ **Estimated Time:** ${tutorial.estimatedTime}
🧪 **Test Source:** \`${specPath}\`

## Overview

${tutorial.description}

This tutorial is automatically generated from our E2E test suite, ensuring all steps are validated and working correctly.

## Prerequisites

- XLN development environment running
- Frontend accessible at \`http://localhost:8080\`
- Basic understanding of blockchain concepts

## Step-by-Step Guide

${tutorial.steps.map(step => this.generateStepMarkdown(step)).join('\n\n')}

## Next Steps

After completing this tutorial, you can:

- 🔗 Create payment channels between entities
- ⚖️ Handle dispute resolution
- 🏛️ Explore on-chain governance features
- 📊 Monitor entity consensus in real-time

## Troubleshooting

If you encounter issues:

1. **Entity creation fails**: Ensure all validators have unique names
2. **Proposals don't execute**: Check that voting threshold is reached
3. **UI not responsive**: Refresh page and wait for environment to load

## Related Tutorials

- [Quick Start: Simple Entity Creation](./quick-start-simple-entity-creation.md)
- [Advanced: Multi-Signature Governance](./advanced-multi-signature-governance.md)
- [Channel Operations](./channel-operations.md)

---

*This tutorial is automatically generated from \`${specPath}\`. To update, modify the test file and run \`bun run generate:tutorials\`.*
`;
  }

  private generateStepMarkdown(step: TutorialStep): string {
    let markdown = `### Step ${step.number}: ${step.title}

${step.description}`;

    if (step.screenshotPath) {
      markdown += `

![Step ${step.number} Screenshot](../e2e/test-results/${step.screenshotPath})`;
    }

    if (step.explanation) {
      markdown += `

> 💡 **Why this matters:** ${step.explanation}`;
    }

    return markdown;
  }

  private async generateTutorialIndex() {
    const indexPath = join(this.outputDir, 'README.md');

    const indexContent = `# XLN Tutorials

Welcome to XLN interactive tutorials! These guides are automatically generated from our E2E test suite, ensuring every step is validated and works correctly.

## Available Tutorials

### 🟢 Beginner

- [Quick Start: Simple Entity Creation](./quick-start-simple-entity-creation.md) - Get started in under 2 minutes
- [Basic Entity Operations](./basic-entity-operations.md) - Learn fundamental entity interactions

### 🟡 Intermediate

- [Complete Entity & Channel Workflow](./complete-entity-channel-workflow.md) - Full end-to-end workflow
- [Multi-Signature Governance](./multi-signature-governance.md) - Democratic decision making

### 🔴 Advanced

- [Channel Dispute Resolution](./channel-dispute-resolution.md) - Handle complex scenarios
- [Cross-Chain Operations](./cross-chain-operations.md) - Multi-jurisdiction workflows

## How These Tutorials Work

🎯 **Dual Purpose**: Each tutorial serves as both documentation and automated testing
🔄 **Always Current**: Generated from working E2E tests, never outdated
📸 **Visual Guide**: Screenshots from actual test runs
⚡ **Interactive**: Run \`npm run tutorial\` to follow along automatically

## Running Tutorials Interactively

\`\`\`bash
# Run specific tutorial interactively
npm run tutorial:complete-workflow

# Run in guided mode (slower, with explanations)
npm run tutorial:complete-workflow -- --guided

# Generate fresh documentation
npm run generate:tutorials
\`\`\`

## Tutorial Architecture

Our tutorial system follows these principles:

1. **Test-Driven Documentation**: Every tutorial step is a working test
2. **Visual Validation**: Screenshots prove each step works
3. **Automatic Updates**: Documentation regenerates when tests change
4. **Multiple Modes**: Fast (CI), Guided (learning), Interactive (demo)

This ensures tutorials never go stale and always reflect the current working system.

---

*Generated automatically from E2E tests. Last updated: ${new Date().toISOString()}*
`;

    writeFileSync(indexPath, indexContent);
    console.log(`✅ Generated: ${indexPath}`);
  }
}

// CLI execution
if ((import.meta as any).main) {
  const generator = new TutorialDocGenerator();
  await generator.generateAllTutorials();
}

export { TutorialDocGenerator };
