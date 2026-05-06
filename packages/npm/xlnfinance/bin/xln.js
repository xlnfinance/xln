#!/usr/bin/env node

const version = '0.0.0';

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(version);
} else {
  console.log('XLN Finance package reserved. Production CLI is not published yet.');
}

