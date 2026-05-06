#!/usr/bin/env node

const version = '0.0.0';

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(version);
} else {
  console.log('create-xln package reserved. Production initializer is not published yet.');
}

