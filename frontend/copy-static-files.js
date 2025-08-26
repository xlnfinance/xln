#!/usr/bin/env node
import { copyFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// Copy necessary files to static folder before build
const files = [
  { src: '../dist/server.js', dest: 'static/server.js' },
  { src: '../jurisdictions.json', dest: 'static/jurisdictions.json' }
];

for (const file of files) {
  const srcPath = resolve(file.src);
  const destPath = resolve(file.dest);
  
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, destPath);
    console.log(`✅ Copied ${file.src} → ${file.dest}`);
  } else {
    console.log(`⚠️ Source file not found: ${file.src}`);
  }
}

console.log('📦 Static files copied for build');
